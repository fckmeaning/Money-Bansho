// Multi-source news gathering for one company: 100+ curated RSS/Atom feeds from the repo's
// catalog (api/_dossier/feeds.js, built by scripts/build-dossier-feeds.mjs), plus keyless
// structured sources (GDELT DOC 2.0, Yahoo Finance). Region-aware: each request polls a
// relevant subset of the whole catalog. Failures are counted and reported, never hidden.
import { CREDIBILITY_HIGH_RISK_CAP, CREDIBILITY_TIER_SCORES } from '../../shared/news-credibility.js';
import { FEEDS } from './feeds.js';
import { mentionIndex } from './news.js';
import { cached, errorMessage, fetchText, pool } from './util.js';

const DAY = 86_400_000;

export const FEED_LIMIT = 150; // feeds polled per request (out of the whole catalog)
export const FEED_TIMEOUT_MS = 6000;
export const FEED_BUDGET_MS = 11_000; // global wall-clock budget of the whole stage
const FEED_CONCURRENCY = 32;
const FEED_HEAD_BYTES = 420_000; // the newest items come first, the rest of a large feed is not read
const GOOGLE_NEWS_CAP = 24; // news.google.com answers 429 when asked for everything at once
const MAX_ITEMS_PER_FEED = 80;
const FEED_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Source credibility (tiers come from shared/source-tiers.json via the feed list)
// ---------------------------------------------------------------------------

const TIER_BY_NAME = new Map(FEEDS.map((f) => [f.n.toLowerCase(), f.t]));
const WIRE = /\b(reuters|associated press|ap news|bloomberg|financial times|wall street journal|wsj|dow jones|afp|sec edgar|nikkei)\b|路透/i;
const MAJOR = /\b(bbc|cnbc|the economist|handelsblatt|les echos|caixin|globes|calcalist|yonhap|new york times|washington post|the guardian|forbes|barron'?s|marketwatch|fortune|le monde|nhk|south china morning post|scmp|times of israel|haaretz|jerusalem post|ynet|der spiegel|zeit|faz|süddeutsche|il sole 24|expansión|yicai|caijing|chosun|korea herald|joongang|hankyoreh|techcrunch|the verge|wired|ars technica|semafor|axios|politico|techinsider|business insider|nasdaq|seeking alpha|investopedia)\b|财新|第一财经|연합뉴스/i;
const STATE_MEDIA = /\b(xinhua|cgtn|china daily|global times|people'?s daily|tass|rt\.com|sputnik|kcna|press tv|tehran times|ria novosti|china news service|cctv)\b|新华|新華|人民日报|환구/i;

/** Tier 1 (wire / official) .. 4 (unknown); state-controlled media are flagged separately. */
export function sourceTier(name) {
  const text = String(name || '');
  const known = TIER_BY_NAME.get(text.toLowerCase());
  if (known) return known;
  if (WIRE.test(text)) return 1;
  if (MAJOR.test(text)) return 2;
  return 3;
}

export const isStateMedia = (name) => STATE_MEDIA.test(String(name || ''));

/** 0..1 credibility of a source: tier score from shared/news-credibility.js, capped for state media. */
export function sourceCredibility(name, tier = sourceTier(name)) {
  const base = (CREDIBILITY_TIER_SCORES[tier] ?? CREDIBILITY_TIER_SCORES[4]) / 100;
  return isStateMedia(name) ? Math.min(base, CREDIBILITY_HIGH_RISK_CAP / 100) : base;
}

// ---------------------------------------------------------------------------
// Feed selection
// ---------------------------------------------------------------------------

// How relevant a feed group is for a company of the given region (0..1).
const AFFINITY = {
  us: { fin: 1, corp: 0.9, us: 1, tech: 0.55, world: 0.4, europe: 0.15, asia: 0.15, china: 0.1, israel: 0.1, mideast: 0.05, korea: 0.05, latam: 0.05, africa: 0.02 },
  china: { fin: 0.9, corp: 0.85, china: 1, asia: 0.75, us: 0.45, world: 0.4, tech: 0.45, europe: 0.2, korea: 0.15, mideast: 0.05, israel: 0.05, latam: 0.03, africa: 0.03 },
  europe: { fin: 0.9, corp: 0.85, europe: 1, us: 0.35, world: 0.45, tech: 0.35, mideast: 0.15, asia: 0.15, china: 0.1, israel: 0.1, korea: 0.05, latam: 0.05, africa: 0.05 },
  israel: { fin: 0.9, corp: 0.85, israel: 1, mideast: 0.75, us: 0.4, world: 0.45, tech: 0.45, europe: 0.25, asia: 0.1, china: 0.05, korea: 0.05, latam: 0.03, africa: 0.03 },
  korea: { fin: 0.9, corp: 0.85, korea: 1, asia: 0.75, china: 0.3, us: 0.4, world: 0.45, tech: 0.45, europe: 0.15, mideast: 0.05, israel: 0.05, latam: 0.03, africa: 0.03 },
  other: { fin: 0.9, corp: 0.85, asia: 0.8, us: 0.45, world: 0.45, tech: 0.4, europe: 0.35, china: 0.3, mideast: 0.15, korea: 0.15, israel: 0.1, latam: 0.2, africa: 0.15 },
};
const HOME_LANGS = { CN: ['zh'], HK: ['zh'], TW: ['zh'], IL: ['he'], DE: ['de'], AT: ['de'], CH: ['de', 'fr'], FR: ['fr'], KR: ['ko'], KP: ['ko'] };

/** Groups a company's region can draw on, for the "coverage by region" chart. */
export const GROUP_LABELS = {
  fin: 'Финансы и рынки', corp: 'Корпоративные', us: 'США', europe: 'Европа', china: 'Китай', israel: 'Израиль',
  mideast: 'Ближний Восток', korea: 'КНДР и Корея', asia: 'Азия', world: 'Мир и политика', tech: 'Технологии',
  latam: 'Латинская Америка', africa: 'Африка',
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/**
 * Picks the feeds to poll for this company: highest group affinity first, then better
 * source tier, then home language. Caps: Google News searches, feeds per host.
 */
export function selectFeeds(company, { limit = FEED_LIMIT } = {}) {
  const affinity = AFFINITY[company.region] ?? AFFINITY.other;
  const langs = new Set(['en', ...(HOME_LANGS[company.country] ?? [])]);
  const scored = FEEDS.map((feed, index) => {
    const lang = feed.l ? feed.l.slice(0, 2) : 'en';
    const score = (affinity[feed.g] ?? 0) + 0.3 * ((4 - feed.t) / 3) + (langs.has(lang) ? 0.25 : -0.1);
    return { feed, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  const perHost = new Map();
  let googleNews = 0;
  for (const { feed } of scored) {
    if (selected.length >= limit) break;
    if (feed.gn) {
      if (googleNews >= GOOGLE_NEWS_CAP) continue;
      googleNews += 1;
    } else {
      const host = hostOf(feed.u);
      const used = perHost.get(host) ?? 0;
      if (used >= 10) continue;
      perHost.set(host, used + 1);
    }
    selected.push(feed);
  }
  return spreadByHost(selected);
}

/** Round-robin over hosts, so that no publisher gets a burst of simultaneous requests. */
function spreadByHost(feeds) {
  const queues = new Map();
  for (const feed of feeds) {
    const host = hostOf(feed.u);
    if (!queues.has(host)) queues.set(host, []);
    queues.get(host).push(feed);
  }
  const out = [];
  const lists = [...queues.values()];
  for (let round = 0; out.length < feeds.length; round += 1) {
    for (const list of lists) if (round < list.length) out.push(list[round]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// RSS / Atom / RDF parsing
// ---------------------------------------------------------------------------

const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeXml(value = '') {
  return value
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
      if (!code.startsWith('#')) return NAMED[code.toLowerCase()];
      const point = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    });
}

const stripTags = (html) => decodeXml(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function field(body, names) {
  for (const name of names) {
    const match = body.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    if (match) return match[1];
  }
  return '';
}

function linkOf(body) {
  const text = decodeXml(field(body, ['link'])).trim();
  if (/^https?:\/\//.test(text)) return text;
  for (const m of body.matchAll(/<link\b([^>]*)\/?>/gi)) {
    const attrs = m[1];
    const rel = attrs.match(/\brel=["']([^"']+)["']/i)?.[1];
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (href && (!rel || rel === 'alternate')) return decodeXml(href);
  }
  const guid = decodeXml(field(body, ['guid'])).trim();
  return /^https?:\/\//.test(guid) ? guid : '';
}

/** Items of an RSS 2.0, Atom or RDF document: {title, url, time, text}. */
export function parseFeed(xml, nowMs = Date.now()) {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml.slice(0, 4000))) throw new Error('Not a feed');
  const items = [];
  for (const [, , body] of xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
    const title = stripTags(field(body, ['title']));
    const url = linkOf(body);
    const time = Date.parse(decodeXml(field(body, ['pubDate', 'published', 'updated', 'dc:date', 'date'])).trim());
    if (!title || !url || !Number.isFinite(time) || time > nowMs + 3600_000) continue;
    const text = stripTags(field(body, ['description', 'summary', 'content:encoded', 'content'])).slice(0, 600);
    items.push({ title, url, time, text });
    if (items.length >= MAX_ITEMS_PER_FEED) break;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/** Reads at most FEED_HEAD_BYTES of a feed: newest items come first, so a long archive costs nothing. */
async function fetchHead(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: ACCEPT, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < FEED_HEAD_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function loadFeed(feed, timeoutMs) {
  return cached(`feed:${feed.u}`, FEED_TTL_MS, async () => parseFeed(await fetchHead(feed.u, timeoutMs)), 30 * 60_000);
}

/** Company search names plus tickers, so that "NVDA" or "0700.HK" in a headline counts. */
export function matchTerms(company) {
  const base = String(company.symbol || '').split('.')[0];
  const extra = [];
  if (company.symbol && /^[A-Z]{3,5}$/.test(company.symbol)) extra.push(company.symbol);
  else if (company.symbol && /^\d{4}\.HK$/.test(company.symbol)) extra.push(company.symbol, `${Number(base)}.HK`, `HKEX: ${Number(base)}`);
  else if (company.symbol?.endsWith('.TA') && /^[A-Z]{3,5}$/.test(base)) extra.push(company.symbol, `TASE: ${base}`);
  return { aliases: [...new Set([...(company.aliases ?? []), ...extra])], exclude: company.exclude };
}

/** Where the company is named: in the headline (position 0..1) or only in the summary. */
export function mention(item, terms) {
  const title = mentionIndex(item.title, terms);
  if (title >= 0) return { inTitle: true, pos: item.title.length ? title / item.title.length : 0 };
  if (item.text && mentionIndex(item.text, terms) >= 0) return { inTitle: false, pos: 1 };
  return null;
}

// ---------------------------------------------------------------------------
// Structured keyless sources
// ---------------------------------------------------------------------------

const GDELT_LANG = { English: 'en', Chinese: 'zh', Hebrew: 'he', Korean: 'ko', German: 'de', French: 'fr' };

function gdeltDate(value) {
  const m = String(value || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Number.NaN;
}

async function gdeltJson(query, mode, extra, timeoutMs) {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=${mode}&format=json${extra}`;
  const text = (await fetchText(url, { timeoutMs, maxBytes: 3_000_000 })).replace(/^﻿/, '').trim();
  if (!text.startsWith('{')) throw new Error('GDELT: not JSON (rate limit)');
  return JSON.parse(text);
}

const gdeltQuery = (company) => `"${String(company.searchName || company.name).replace(/"/g, '')}" sourcelang:english`;

function gdeltArticles(company, nowMs, timeoutMs) {
  return cached(`gdelt:art:${company.symbol}`, 10 * 60_000, async () => {
    const data = await gdeltJson(gdeltQuery(company), 'artlist', '&maxrecords=100&sort=datedesc&timespan=14d', timeoutMs);
    return (data.articles ?? []).flatMap((a) => {
      const time = gdeltDate(a.seendate);
      if (!a.title || !String(a.url).startsWith('http') || !Number.isFinite(time) || time > nowMs + 3600_000) return [];
      return [{ title: a.title, url: a.url, time, text: '', source: a.domain || 'GDELT', lang: GDELT_LANG[a.language] ?? 'en' }];
    });
  }, 30 * 60_000);
}

function gdeltTimeline(company, mode, timeoutMs) {
  return cached(`gdelt:${mode}:${company.symbol}`, 15 * 60_000, async () => {
    const data = await gdeltJson(gdeltQuery(company), mode, '&timespan=30d', timeoutMs);
    const series = data.timeline?.[0]?.data ?? [];
    return series.flatMap((p) => (Number.isFinite(gdeltDate(p.date)) && Number.isFinite(p.value) ? [{ t: gdeltDate(p.date), v: p.value }] : []));
  }, 60 * 60_000);
}

function yahooNews(company, timeoutMs) {
  return cached(`yahoo:news:${company.symbol}`, 5 * 60_000, async () => {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(company.symbol)}&quotesCount=0&newsCount=30&listsCount=0`;
    const data = JSON.parse(await fetchText(url, { timeoutMs, headers: { Accept: 'application/json' } }));
    return (data.news ?? []).flatMap((n) => {
      const time = Number(n.providerPublishTime) * 1000;
      if (!n.title || !String(n.link).startsWith('http') || !Number.isFinite(time)) return [];
      const related = Array.isArray(n.relatedTickers) && n.relatedTickers.includes(company.symbol);
      return [{ title: n.title, url: n.link, time, text: '', source: n.publisher || 'Yahoo Finance', lang: 'en', related }];
    });
  }, 30 * 60_000);
}

function yahooRss(company, timeoutMs) {
  return cached(`yahoo:rss:${company.symbol}`, 5 * 60_000, async () => {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(company.symbol)}&region=US&lang=en-US`;
    return parseFeed(await fetchText(url, { timeoutMs })).map((i) => ({ ...i, source: 'Yahoo Finance', lang: 'en', related: true }));
  }, 30 * 60_000);
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/**
 * Polls the catalog subset and the structured sources for one company.
 * Returns {items, stats}: items that name the company, and what was asked and answered.
 */
export async function gatherSources(company, { nowMs = Date.now(), limit = FEED_LIMIT, budgetMs = FEED_BUDGET_MS } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  const terms = matchTerms(company);
  const selected = selectFeeds(company, { limit });
  const items = [];
  const feedLines = [];
  const structured = [];
  const gdelt = { tone: null, volume: null };

  const feedTask = async (feed) => {
    const began = Date.now();
    const remaining = deadline - began;
    const line = { name: feed.n, group: feed.g, tier: feed.t, gn: Boolean(feed.gn), ok: false, stale: false, items: 0, matched: 0, ms: 0, error: null };
    feedLines.push(line);
    if (remaining < 400) {
      line.error = 'Не успел за общий бюджет времени';
      return;
    }
    let timer;
    try {
      // A feed that is too slow for this request keeps loading and lands in the cache for the next one.
      const loading = loadFeed(feed, FEED_TIMEOUT_MS);
      loading.catch(() => {});
      const waited = await Promise.race([loading, new Promise((resolve) => { timer = setTimeout(resolve, remaining); })]);
      if (!waited) throw new Error('Не успел за общий бюджет времени');
      const { value, staleError } = waited;
      line.ok = true;
      line.stale = Boolean(staleError);
      line.items = value.length;
      for (const item of value) {
        const found = mention(item, terms);
        if (!found) continue;
        line.matched += 1;
        items.push({ title: item.title, url: item.url, time: item.time, source: feed.n, lang: (feed.l || 'en').slice(0, 2), region: feed.g, tier: feed.t, via: 'rss', mention: found });
      }
    } catch (error) {
      line.error = errorMessage(error);
    } finally {
      clearTimeout(timer);
    }
    line.ms = Date.now() - began;
  };

  const structuredTask = async (id, label, run) => {
    const began = Date.now();
    const line = { id, label, ok: false, items: 0, matched: 0, ms: 0, error: null };
    structured.push(line);
    try {
      const { value } = await run(8000);
      line.ok = true;
      line.items = Array.isArray(value) ? value.length : 0;
      return value;
    } catch (error) {
      line.error = errorMessage(error);
      return null;
    } finally {
      line.ms = Date.now() - began;
    }
  };

  const accept = (line, list, via, tier) => {
    for (const item of list ?? []) {
      const found = item.related ? { inTitle: mentionIndex(item.title, terms) >= 0, pos: 0 } : mention(item, terms);
      if (!found) continue;
      line.matched += 1;
      items.push({ title: item.title, url: item.url, time: item.time, source: item.source, lang: item.lang, region: company.region, tier: tier(item.source), via, mention: found });
    }
  };

  const structuredJobs = [
    structuredTask('gdelt:articles', 'GDELT DOC 2.0: статьи', (t) => gdeltArticles(company, nowMs, t)).then((list) => accept(structured.find((s) => s.id === 'gdelt:articles'), list, 'gdelt', sourceTier)),
    sleep(450).then(() => structuredTask('gdelt:tone', 'GDELT DOC 2.0: тон', (t) => gdeltTimeline(company, 'timelinetone', t))).then((list) => { gdelt.tone = list; }),
    sleep(900).then(() => structuredTask('gdelt:volume', 'GDELT DOC 2.0: объём', (t) => gdeltTimeline(company, 'timelinevolraw', t))).then((list) => { gdelt.volume = list; }),
    structuredTask('yahoo:news', 'Yahoo Finance: новости', (t) => yahooNews(company, t)).then((list) => accept(structured.find((s) => s.id === 'yahoo:news'), list, 'yahoo', sourceTier)),
    structuredTask('yahoo:rss', 'Yahoo Finance: лента тикера', (t) => yahooRss(company, t)).then((list) => accept(structured.find((s) => s.id === 'yahoo:rss'), list, 'yahoo', sourceTier)),
  ];

  await Promise.all([pool(selected, FEED_CONCURRENCY, feedTask), ...structuredJobs]);

  const byGroup = {};
  for (const line of feedLines) {
    const g = (byGroup[line.group] ??= { group: line.group, label: GROUP_LABELS[line.group] ?? line.group, polled: 0, answered: 0, matched: 0 });
    g.polled += 1;
    if (line.ok) g.answered += 1;
    g.matched += line.matched;
  }
  const answered = feedLines.filter((l) => l.ok).length;
  return {
    items,
    stats: {
      available: FEEDS.length,
      availableDirect: FEEDS.filter((f) => !f.gn).length,
      polled: selected.length,
      answered,
      failed: selected.length - answered,
      timedOut: feedLines.filter((l) => !l.ok && /Timed out|бюджет/.test(l.error ?? '')).length,
      matched: feedLines.reduce((total, l) => total + l.matched, 0),
      budgetMs,
      durationMs: Date.now() - startedAt,
      byGroup: Object.values(byGroup).sort((a, b) => b.matched - a.matched || b.answered - a.answered),
      structured,
      gdelt,
      feeds: feedLines.map((l) => ({ ...l })),
    },
  };
}

// ---------------------------------------------------------------------------
// Clustering of repeated stories (word shingles + Jaccard similarity)
// ---------------------------------------------------------------------------

const STOP = new Set('a an the of to in on for and or as at by with from is are was be its his her after amid says said new der die das und le la les de des du et un una el los las del por para con that this will has have'.split(' '));
const CLUSTER_WINDOW = 5 * DAY;
export const CLUSTER_JACCARD = 0.45;

function normalizeTitle(title, source) {
  let text = String(title || '').toLowerCase();
  const src = String(source || '').toLowerCase().trim();
  if (src && text.endsWith(src)) text = text.slice(0, -src.length);
  text = text.replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/u, '');
  return text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Unigrams (len >= 3) and word bigrams; CJK text goes by character bigrams. */
export function shingles(title, source = '') {
  const text = normalizeTitle(title, source);
  const out = new Set();
  const words = [];
  for (const word of text.split(' ')) {
    if (!word) continue;
    if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word)) {
      for (let i = 0; i < word.length - 1; i += 1) out.add(word.slice(i, i + 2));
    } else if (!STOP.has(word) && word.length >= 3) {
      out.add(word);
      words.push(word);
    }
  }
  for (let i = 0; i < words.length - 1; i += 1) out.add(`${words[i]}_${words[i + 1]}`);
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const numbersOf = (title) => (String(title).match(/\d+(?:[.,]\d+)?/g) || []).sort().join(',');
const outletKey = (name) => String(name || '').toLowerCase().replace(/^www\./, '').replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Groups items about the same story. Returns one representative per cluster (the earliest
 * report) with `outlets` (distinct publishers) and `cluster` {size, sources, bestTier, ...}.
 * Items with the same URL are one item. Different figures or opposite tone are not merged.
 */
export function clusterItems(items) {
  const byUrl = new Map();
  for (const item of items) if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  const list = [...byUrl.values()].sort((a, b) => a.time - b.time).map((item) => ({
    item, set: shingles(item.title, item.source), numbers: numbersOf(item.title),
  }));
  const parent = list.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (list[j].item.time - list[i].item.time > CLUSTER_WINDOW) break;
      if (find(i) === find(j) || list[i].numbers !== list[j].numbers) continue;
      if (jaccard(list[i].set, list[j].set) >= CLUSTER_JACCARD) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  list.forEach((entry, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry.item);
  });
  return [...groups.values()].map((members) => {
    const rep = members[0];
    const names = new Map();
    for (const m of members) {
      const key = outletKey(m.source) || outletKey(m.url);
      if (key && !names.has(key)) names.set(key, m.source);
    }
    const tiers = members.map((m) => m.tier ?? sourceTier(m.source));
    return {
      ...rep,
      outlets: names.size,
      cluster: {
        size: members.length,
        outlets: names.size,
        sources: [...names.values()].slice(0, 8),
        bestTier: Math.min(...tiers),
        credibility: [...names.values()].map((n) => Math.round(sourceCredibility(n) * 100) / 100).slice(0, 8),
        firstTime: rep.time,
        lastTime: members[members.length - 1].time,
      },
    };
  });
}
