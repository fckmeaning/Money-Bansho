// Multi-source news gathering for one company: 100+ curated RSS/Atom feeds from the repo's
// catalog (api/_dossier/feeds.js, built by scripts/build-dossier-feeds.mjs), plus keyless
// structured sources (GDELT DOC 2.0, Yahoo Finance). Region-aware: each request polls a
// relevant subset of the whole catalog. Failures are counted and reported, never hidden.
//
// Reliability (all in process memory): every feed keeps its last good answer (stale-while-
// revalidate, so repeated polls are instant), is retried once on a timeout, is tried with a plain
// User-Agent when a browser one gets 403, and is quarantined after repeated failures. Only a few
// not-yet-contacted hosts are opened at a time (paceByHost), so that on a slow DNS resolver a
// request's timeout is not spent waiting in the lookup queue.
import { CREDIBILITY_HIGH_RISK_CAP, CREDIBILITY_TIER_SCORES } from '../../shared/news-credibility.js';
import { FEEDS } from './feeds.js';
import { mentionIndex, searchNews } from './news.js';
import { cached, errorMessage, fetchText } from './util.js';

const DAY = 86_400_000;

export const FEED_LIMIT = 150; // feeds polled per request (out of the whole catalog)
export const FEED_TIMEOUT_MS = 9000; // per attempt (DNS and TLS included); a timeout is retried once
export const FEED_BUDGET_MS = 18_000; // hard budget of the stage: analysis and translation follow, the edge limit is 25 s
export const FEED_SOFT_MS = 9000; // after this the tail is not awaited once ENOUGH feeds have answered
export const FEED_ENOUGH = 100;
const FEED_CONCURRENCY = 32;
const COLD_HOSTS = 8; // hosts being contacted for the first time at once (each needs a DNS lookup)
const COLD_HOLD_MS = 2500; // a slower first contact stops counting against COLD_HOSTS
const HOST_PARALLEL = 6; // simultaneous requests to one host
const FEED_HEAD_BYTES = 420_000; // the newest items come first, the rest of a large feed is not read
const GOOGLE_NEWS_CAP = 24; // news.google.com answers 429 when asked for everything at once
const MAX_ITEMS_PER_FEED = 80;
const GDELT_HEDGE_MS = 6000; // GDELT slower than this: Google News is asked alongside
const FEED_FRESH_MS = 5 * 60_000; // younger than this: served from memory without a request
const FEED_STALE_MS = 6 * 3600_000; // up to this: served at once and refreshed in the background
const STORE_CAP = 1400;
const PERMANENT_QUARANTINE_MS = 6 * 3600_000;
const TRANSIENT_QUARANTINE_MS = 20 * 60_000;

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
// Per-feed health and the last good answer of every feed (in process memory)
// ---------------------------------------------------------------------------

const store = new Map(); // url -> {items, at}
const inflight = new Map(); // url -> Promise<items>
const health = new Map(); // url -> {name, group, fails, error, status, ms, ua, until, okAt}

const healthOf = (feed) => {
  let h = health.get(feed.u);
  if (!h) {
    h = { name: feed.n, group: feed.g, fails: 0, error: null, status: null, ms: feed.m ?? null, ua: feed.a ? 'curl' : 'browser', until: 0, okAt: 0 };
    health.set(feed.u, h);
  }
  return h;
};

const isPermanent = (error) => error?.status === 404 || error?.status === 410 || /Not a feed/.test(error?.message ?? '');
const isTransient = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError'
  || [502, 503, 504].includes(error?.status)
  || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|terminated|network/i.test(`${error?.message ?? ''} ${error?.cause?.code ?? ''}`);

function noteFailure(feed, error) {
  const h = healthOf(feed);
  h.fails += 1;
  h.error = errorMessage(error);
  h.status = error?.status ?? null;
  if (error?.status === 429) return; // the host's mood, not a dead feed
  if (isPermanent(error) && h.fails >= 2) h.until = Date.now() + PERMANENT_QUARANTINE_MS;
  else if (h.fails >= 3) h.until = Date.now() + TRANSIENT_QUARANTINE_MS;
}

function noteSuccess(feed, ms, ua) {
  const h = healthOf(feed);
  Object.assign(h, { fails: 0, error: null, status: null, ms, ua, until: 0, okAt: Date.now() });
}

function remember(feed, items) {
  store.delete(feed.u);
  store.set(feed.u, { items: items.map((i) => ({ title: i.title, url: i.url, time: i.time, text: i.text.slice(0, 320) })), at: Date.now() });
  if (store.size > STORE_CAP) store.delete(store.keys().next().value);
}

/** Feeds that failed repeatedly (diagnostics); the quarantined ones are skipped when polling. */
export function deadFeeds(limit = 40) {
  const now = Date.now();
  return [...health.entries()]
    .filter(([, h]) => h.fails >= 2)
    .map(([url, h]) => ({ name: h.name, group: h.group, url, fails: h.fails, error: h.error, quarantined: h.until > now, retryInMin: h.until > now ? Math.ceil((h.until - now) / 60_000) : 0 }))
    .sort((a, b) => b.fails - a.fails || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Test hook: forget everything learnt about feeds. */
export function resetFeedState() {
  store.clear();
  inflight.clear();
  health.clear();
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

const latencyOf = (feed) => health.get(feed.u)?.ms ?? feed.m ?? null;

/**
 * Picks the feeds to poll for this company: highest group affinity first, then better source
 * tier, then home language; known-slow feeds sink. Dead (quarantined) feeds are skipped and
 * replaced by the next candidates. Caps: Google News searches, feeds per host. The result is
 * ordered fastest first, spread over hosts.
 */
export function selectFeeds(company, { limit = FEED_LIMIT } = {}) {
  const affinity = AFFINITY[company.region] ?? AFFINITY.other;
  const langs = new Set(['en', ...(HOME_LANGS[company.country] ?? [])]);
  const now = Date.now();
  const scored = FEEDS.map((feed, index) => {
    const lang = feed.l ? feed.l.slice(0, 2) : 'en';
    const ms = latencyOf(feed);
    const score = (affinity[feed.g] ?? 0) + 0.3 * ((4 - feed.t) / 3) + (langs.has(lang) ? 0.25 : -0.1) - (ms > 5000 ? 0.2 : 0);
    return { feed, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  const perHost = new Map();
  let googleNews = 0;
  for (const { feed } of scored) {
    if (selected.length >= limit) break;
    if ((health.get(feed.u)?.until ?? 0) > now) continue;
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
  return orderFastFirst(selected);
}

/** Answers already in memory and quick feeds first; slow ones last. */
function orderFastFirst(feeds) {
  const bucket = (feed) => {
    if (store.has(feed.u)) return 0;
    const ms = latencyOf(feed);
    if (feed.gn) return 1; // one host: a single lookup serves all of them
    return ms === null ? 1 : ms < 1500 ? 0 : ms < 4000 ? 1 : 2;
  };
  const groups = [[], [], []];
  for (const feed of feeds) groups[bucket(feed)].push(feed);
  return groups.flatMap(spreadByHost);
}

/**
 * Round-robin over hosts, so that no publisher gets a burst of simultaneous requests. Hosts with
 * more feeds go first: one first contact then yields more answers.
 */
function spreadByHost(feeds) {
  const queues = new Map();
  for (const feed of feeds) {
    const host = hostOf(feed.u);
    if (!queues.has(host)) queues.set(host, []);
    queues.get(host).push(feed);
  }
  const out = [];
  const lists = [...queues.values()].sort((a, b) => b.length - a.length);
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
const USER_AGENT = {
  browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  curl: 'curl/8.5.0', // some publishers answer 403 to a browser User-Agent and 200 to a plain one
};

/** Reads at most FEED_HEAD_BYTES of a feed: newest items come first, so a long archive costs nothing. */
export async function fetchHead(url, timeoutMs, ua = 'browser') {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT[ua], Accept: ACCEPT, 'Accept-Language': 'en-US,en;q=0.9' },
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

/** One live request with the plain-UA fallback and one retry on a timeout or network error. */
async function fetchFeedLive(feed) {
  const h = healthOf(feed);
  let ua = h.ua;
  const began = Date.now();
  const once = async () => {
    try {
      return await fetchHead(feed.u, FEED_TIMEOUT_MS, ua);
    } catch (error) {
      if ([401, 403, 406].includes(error?.status) && ua === 'browser') {
        ua = 'curl';
        return fetchHead(feed.u, FEED_TIMEOUT_MS, ua);
      }
      throw error;
    }
  };
  try {
    let xml;
    try {
      xml = await once();
    } catch (error) {
      if (!isTransient(error)) throw error;
      xml = await once();
    }
    const items = parseFeed(xml);
    remember(feed, items);
    noteSuccess(feed, Date.now() - began, ua);
    return items;
  } catch (error) {
    noteFailure(feed, error);
    throw error;
  }
}

/**
 * Stale-while-revalidate: an answer younger than FEED_FRESH_MS is returned from memory, an older
 * one (up to FEED_STALE_MS) at once while a refresh runs in the background, otherwise the request
 * is awaited. Resolves to {items, from: 'live' | 'cache' | 'stale', ageMs}.
 */
function loadFeed(feed) {
  const entry = store.get(feed.u);
  const age = entry ? Date.now() - entry.at : Number.POSITIVE_INFINITY;
  if (age < FEED_FRESH_MS) return Promise.resolve({ items: entry.items, from: 'cache', ageMs: age });
  let pending = inflight.get(feed.u);
  if (!pending) {
    pending = fetchFeedLive(feed).finally(() => inflight.delete(feed.u));
    pending.catch(() => {}); // a background refresh nobody waits for must not crash anything
    inflight.set(feed.u, pending);
  }
  if (age < FEED_STALE_MS) return Promise.resolve({ items: entry.items, from: 'stale', ageMs: age });
  return pending.then((items) => ({ items, from: 'live', ageMs: 0 }));
}

/**
 * Runs `task` (resolves to true when the feed answered) for every feed, in order, with bounded
 * concurrency. A fetch cannot tell how long it waited for DNS, and its timeout runs meanwhile:
 * asking a hundred new hosts at once makes almost all of them time out. So only COLD_HOSTS hosts
 * that have not answered yet are contacted at a time; the other feeds of such a host wait for its
 * first answer. Feeds held in memory need no request and start at once. After `isStopped()` the
 * rest is handed to `task` without limits (it only records them as not polled).
 */
function paceByHost(feeds, task, isStopped) {
  const pending = [...feeds];
  const answered = new Set(); // hosts that have answered
  const opening = new Set(); // hosts whose first contact is in flight
  const busy = new Map(); // host -> requests in flight
  let lanes = 0;
  let requests = 0;
  let running = 0;
  return new Promise((resolve) => {
    const start = (feed, host, free) => {
      const cold = !free && !answered.has(host);
      let holding = cold;
      let timer;
      const releaseLane = () => {
        if (!holding) return;
        holding = false;
        lanes -= 1;
      };
      running += 1;
      if (!free) {
        requests += 1;
        busy.set(host, (busy.get(host) ?? 0) + 1);
      }
      if (cold) {
        opening.add(host);
        lanes += 1;
        timer = setTimeout(() => {
          releaseLane();
          pump();
        }, COLD_HOLD_MS);
      }
      task(feed).then((ok) => {
        running -= 1;
        if (!free) {
          requests -= 1;
          busy.set(host, busy.get(host) - 1);
        }
        if (cold) {
          clearTimeout(timer);
          releaseLane();
          opening.delete(host);
        }
        if (ok) answered.add(host);
        pump();
      });
    };
    const pump = () => {
      for (let i = 0; i < pending.length;) {
        const feed = pending[i];
        const host = hostOf(feed.u);
        const free = isStopped() || Date.now() - (store.get(feed.u)?.at ?? 0) < FEED_STALE_MS;
        const blocked = !free && (requests >= FEED_CONCURRENCY || (busy.get(host) ?? 0) >= HOST_PARALLEL
          || (!answered.has(host) && (opening.has(host) || lanes >= COLD_HOSTS)));
        if (blocked) {
          i += 1;
        } else {
          pending.splice(i, 1);
          start(feed, host, free);
        }
      }
      if (!pending.length && !running) resolve();
    };
    pump();
  });
}

// ---------------------------------------------------------------------------
// Relevance: the company must be named, with word boundaries
// ---------------------------------------------------------------------------

// Short Hebrew names are ordinary words ("טבע" is also "nature"): they count only with a business word.
const WEAK_ALIAS = /^[֐-׿"'׳״]{1,4}$/u;
const BUSINESS_HEBREW = /מניי?ת|מניות|בורסה|דוחות|רבעון|רווח|הפסד|מנכ"?ל|יו"ר|תרופ|פארמ|הנפקה|דיבידנד|ת"א|תל אביב|גנרי/u;

/** Company names plus tickers, so that "NVDA" or "0700.HK" in a headline counts. */
export function matchTerms(company) {
  const base = String(company.symbol || '').split('.')[0];
  const extra = [];
  if (company.symbol && /^[A-Z]{3,5}$/.test(company.symbol)) extra.push(company.symbol);
  else if (company.symbol && /^\d{4}\.HK$/.test(company.symbol)) extra.push(company.symbol, `${Number(base)}.HK`, `HKEX: ${Number(base)}`);
  else if (company.symbol?.endsWith('.TA') && /^[A-Z]{3,5}$/.test(base)) extra.push(company.symbol, `TASE: ${base}`);
  const all = [...new Set([...(company.aliases ?? []), ...extra])];
  return {
    strong: { aliases: all.filter((a) => !WEAK_ALIAS.test(a)), exclude: company.exclude },
    weak: { aliases: all.filter((a) => WEAK_ALIAS.test(a)), exclude: company.exclude },
  };
}

/** How many times (up to `cap`) the strong names occur in a text. */
function countMentions(text, terms, cap = 3) {
  let count = 0;
  let rest = text;
  while (count < cap) {
    const index = mentionIndex(rest, terms.strong);
    if (index < 0) break;
    count += 1;
    rest = rest.slice(index + 1);
  }
  return count;
}

/**
 * Where the company is named. In the headline: {inTitle: true, pos 0..1}. Only in the summary: it
 * must be named at least twice, otherwise it is a passing mention and the item is dropped.
 * Related-ticker tags of an aggregator are not evidence and are never used.
 */
export function mention(item, terms) {
  let index = mentionIndex(item.title, terms.strong);
  if (index < 0 && terms.weak.aliases.length && BUSINESS_HEBREW.test(item.title)) index = mentionIndex(item.title, terms.weak);
  if (index >= 0) return { inTitle: true, pos: item.title.length ? index / item.title.length : 0 };
  if (item.text) {
    const count = countMentions(item.text, terms);
    if (count >= 2) return { inTitle: false, pos: 1, count };
  }
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
  if (!text.startsWith('{')) {
    const error = new Error('GDELT: лимит запросов (ответ не JSON)');
    error.status = 429;
    throw error;
  }
  return JSON.parse(text);
}

const gdeltQuery = (company) => `"${String(company.searchName || company.name).replace(/"/g, '')}" sourcelang:english`;

/** GDELT is often slow to connect, so it gets a long attempt; the Google News fallback is hedged. */
function gdeltArticles(company, nowMs) {
  return cached(`gdelt:art:${company.symbol}`, 15 * 60_000, async () => {
    const run = () => gdeltJson(gdeltQuery(company), 'artlist', '&maxrecords=100&sort=datedesc&timespan=14d', 14_000);
    let data;
    try {
      data = await run();
    } catch (error) {
      if (error?.status !== 429) throw error;
      await sleep(5200);
      data = await run();
    }
    return (data.articles ?? []).flatMap((a) => {
      const time = gdeltDate(a.seendate);
      if (!a.title || !String(a.url).startsWith('http') || !Number.isFinite(time) || time > nowMs + 3600_000) return [];
      return [{ title: a.title, url: a.url, time, text: '', source: a.domain || 'GDELT', lang: GDELT_LANG[a.language] ?? 'en' }];
    });
  }, 60 * 60_000);
}

const timelines = new Map(); // symbol -> {tone, volume, at, state, error}

async function gdeltSeries(company, mode) {
  const data = await gdeltJson(gdeltQuery(company), mode, '&timespan=30d', 20_000);
  const series = data.timeline?.[0]?.data ?? [];
  return series.flatMap((p) => (Number.isFinite(gdeltDate(p.date)) && Number.isFinite(p.value) ? [{ t: gdeltDate(p.date), v: p.value }] : []));
}

/**
 * Tone and volume timelines of GDELT. GDELT allows one request per 5 seconds, so they load one
 * after another in the background and show up in the next poll; this call never waits for them.
 */
function gdeltTimelines(company, after) {
  const old = timelines.get(company.symbol);
  if (old && Date.now() - old.at < 15 * 60_000) return old;
  const entry = { tone: old?.tone ?? null, volume: old?.volume ?? null, at: Date.now(), state: 'loading', error: null };
  timelines.set(company.symbol, entry);
  (async () => {
    try {
      await after; // the article request goes first, then the 5 s pause
      await sleep(5200);
      entry.tone = await gdeltSeries(company, 'timelinetone');
      await sleep(5200);
      entry.volume = await gdeltSeries(company, 'timelinevolraw');
      entry.state = 'ok';
    } catch (error) {
      entry.state = 'failed';
      entry.error = errorMessage(error);
    }
  })();
  return entry;
}

/** Google News search used when GDELT does not answer. */
function gnewsFallback(company) {
  const term = `"${String(company.searchName || company.name).replace(/"/g, '')}"`;
  return searchNews(`${term} (stock OR shares OR earnings OR CEO OR results) when:14d`, 'en', 90_000, 8000);
}

function yahooNews(company) {
  return cached(`yahoo:news:${company.symbol}`, 5 * 60_000, async () => {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(company.symbol)}&quotesCount=0&newsCount=30&listsCount=0`;
    const data = JSON.parse(await fetchText(url, { timeoutMs: 10_000, headers: { Accept: 'application/json' } }));
    return (data.news ?? []).flatMap((n) => {
      const time = Number(n.providerPublishTime) * 1000;
      if (!n.title || !String(n.link).startsWith('http') || !Number.isFinite(time)) return [];
      return [{ title: n.title, url: n.link, time, text: '', source: n.publisher || 'Yahoo Finance', lang: 'en' }];
    });
  }, 30 * 60_000);
}

function yahooRss(company) {
  return cached(`yahoo:rss:${company.symbol}`, 5 * 60_000, async () => {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(company.symbol)}&region=US&lang=en-US`;
    return parseFeed(await fetchText(url, { timeoutMs: 10_000 })).map((i) => ({ ...i, source: 'Yahoo Finance', lang: 'en' }));
  }, 30 * 60_000);
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/**
 * Polls the catalog subset and the structured sources for one company.
 * Returns {items, stats}: items that name the company, and what was asked and answered.
 * Progressive: whatever has answered when the budget ends is returned; the rest keeps loading
 * into the per-feed memory and is there for the next request.
 */
export async function gatherSources(company, { nowMs = Date.now(), limit = FEED_LIMIT, budgetMs = FEED_BUDGET_MS, softMs = FEED_SOFT_MS, enough = FEED_ENOUGH, background = true } = {}) {
  const startedAt = Date.now();
  const terms = matchTerms(company);
  const selected = selectFeeds(company, { limit });
  const items = [];
  const feedLines = [];
  const structured = [];
  const quarantined = FEEDS.filter((f) => (health.get(f.u)?.until ?? 0) > startedAt).length;

  let stopped = false;
  let releaseFeeds;
  let releaseDeadline;
  const feedDeadline = new Promise((resolve) => { releaseFeeds = resolve; });
  const hardDeadline = new Promise((resolve) => { releaseDeadline = resolve; });
  const stopFeeds = () => {
    stopped = true;
    releaseFeeds(null);
  };
  const watcher = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= budgetMs) {
      stopFeeds();
      releaseDeadline(null);
      return;
    }
    const settled = feedLines.filter((l) => l.settled).length;
    const answered = feedLines.filter((l) => l.ok).length;
    // Enough has answered and only a slow tail is left: do not wait for it.
    if (elapsed >= softMs && answered >= enough && selected.length - settled <= selected.length * 0.15) stopFeeds();
  }, 150);

  const feedTask = async (feed) => {
    const began = Date.now();
    const line = { name: feed.n, group: feed.g, tier: feed.t, gn: Boolean(feed.gn), ok: false, from: null, stale: false, items: 0, matched: 0, ms: 0, error: null, settled: false };
    feedLines.push(line);
    try {
      if (stopped) throw new Error('Не опрошен: время вышло');
      const loading = loadFeed(feed);
      loading.catch(() => {});
      const result = await Promise.race([loading, feedDeadline]);
      if (!result) throw new Error('Не успел за общий бюджет времени');
      line.ok = true;
      line.from = result.from;
      line.stale = result.from === 'stale';
      line.items = result.items.length;
      for (const item of result.items) {
        const found = mention(item, terms);
        if (!found) continue;
        line.matched += 1;
        items.push({ title: item.title, url: item.url, time: item.time, source: feed.n, lang: (feed.l || 'en').slice(0, 2), region: feed.g, tier: feed.t, via: 'rss', mention: found });
      }
    } catch (error) {
      line.error = errorMessage(error);
    }
    line.ms = Date.now() - began;
    line.settled = true;
    return line.ok;
  };

  const accept = (line, list, via) => {
    for (const item of list ?? []) {
      const found = mention(item, terms);
      if (!found) continue;
      line.matched += 1;
      items.push({ title: item.title, url: item.url, time: item.time, source: item.source, lang: item.lang, region: company.region, tier: sourceTier(item.source), via, mention: found });
    }
  };

  const structuredTask = async (id, label, run, via, deadline = hardDeadline) => {
    const began = Date.now();
    const line = { id, label, ok: false, items: 0, matched: 0, ms: 0, error: null };
    structured.push(line);
    try {
      const running = run();
      running.catch(() => {});
      const result = await Promise.race([running, deadline]);
      if (!result) throw new Error('Не успел за общий бюджет времени');
      line.ok = true;
      line.items = Array.isArray(result.value) ? result.value.length : 0;
      accept(line, result.value, via);
      return true;
    } catch (error) {
      line.error = errorMessage(error);
      return false;
    } finally {
      line.ms = Date.now() - began;
    }
  };

  // GDELT first; Google News is asked when it fails, or alongside it once it is slow. When the
  // replacement has answered, a still pending GDELT is not awaited: it finishes into its cache.
  let articlesSettled;
  const afterArticles = new Promise((resolve) => { articlesSettled = resolve; });
  const gdeltJob = async () => {
    let release;
    const replaced = new Promise((resolve) => { release = resolve; });
    const request = () => {
      const running = gdeltArticles(company, nowMs);
      running.then(articlesSettled, articlesSettled);
      return running;
    };
    const gdelt = structuredTask('gdelt:articles', 'GDELT DOC 2.0: статьи', request, 'gdelt', Promise.race([
      hardDeadline,
      replaced.then(() => { throw new Error('Отвечает медленно: взят Google News, ответ GDELT будет при следующем опросе'); }),
    ]));
    let hedge;
    const slow = new Promise((resolve) => { hedge = setTimeout(resolve, Math.min(GDELT_HEDGE_MS, budgetMs / 2), false); });
    const ok = await Promise.race([gdelt, slow]);
    clearTimeout(hedge);
    const fallback = !ok && Date.now() - startedAt < budgetMs
      ? structuredTask('gnews:fallback', 'Google News (замена GDELT)', () => gnewsFallback(company), 'gnews')
      : null;
    fallback?.then((answered) => { if (answered) release(); });
    await Promise.all([gdelt, fallback]);
  };

  // The structured sources are asked first, so that their lookups are not queued behind the feeds.
  const structuredJobs = [
    gdeltJob(),
    structuredTask('yahoo:news', 'Yahoo Finance: новости', () => yahooNews(company), 'yahoo'),
    structuredTask('yahoo:rss', 'Yahoo Finance: лента тикера', () => yahooRss(company), 'yahoo'),
  ];
  const timeline = background ? gdeltTimelines(company, afterArticles) : { tone: null, volume: null, state: 'off', error: null };

  await Promise.all([paceByHost(selected, feedTask, () => stopped), ...structuredJobs]);
  clearInterval(watcher);
  structured.push({ id: 'gdelt:timeline', label: 'GDELT DOC 2.0: тон и объём (в фоне)', ok: timeline.state === 'ok', items: timeline.tone?.length ?? 0, matched: 0, ms: 0, error: timeline.state === 'failed' ? timeline.error : timeline.state === 'loading' ? 'Загружается в фоне, будет при следующем опросе' : null });

  const byGroup = {};
  for (const line of feedLines) {
    const g = (byGroup[line.group] ??= { group: line.group, label: GROUP_LABELS[line.group] ?? line.group, polled: 0, answered: 0, matched: 0 });
    g.polled += 1;
    if (line.ok) g.answered += 1;
    g.matched += line.matched;
  }
  const reasons = {};
  for (const line of feedLines) if (!line.ok) reasons[line.error ?? '?'] = (reasons[line.error ?? '?'] ?? 0) + 1;
  const answered = feedLines.filter((l) => l.ok).length;
  return {
    items,
    stats: {
      available: FEEDS.length,
      availableDirect: FEEDS.filter((f) => !f.gn).length,
      quarantined,
      polled: selected.length,
      answered,
      answeredLive: feedLines.filter((l) => l.from === 'live').length,
      servedFromMemory: feedLines.filter((l) => l.from === 'cache' || l.from === 'stale').length,
      failed: selected.length - answered,
      timedOut: feedLines.filter((l) => !l.ok && /Timed out|бюджет|время вышло/.test(l.error ?? '')).length,
      matched: feedLines.reduce((total, l) => total + l.matched, 0),
      budgetMs,
      durationMs: Date.now() - startedAt,
      byGroup: Object.values(byGroup).sort((a, b) => b.matched - a.matched || b.answered - a.answered),
      failures: Object.entries(reasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8),
      dead: deadFeeds(),
      structured,
      gdelt: { tone: timeline.tone, volume: timeline.volume, state: timeline.state },
      feeds: feedLines.map(({ settled, ...rest }) => rest),
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
