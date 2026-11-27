// Google News RSS search, several language editions.
import { cached, fetchText } from './util.js';

export const EDITIONS = {
  en: { params: 'hl=en-US&gl=US&ceid=US:en', region: 'us' },
  zh: { params: 'hl=zh-CN&gl=CN&ceid=CN:zh-Hans', region: 'china' },
  'zh-TW': { params: 'hl=zh-TW&gl=TW&ceid=TW:zh-Hant', region: 'other', lang: 'zh' },
  he: { params: 'hl=he&gl=IL&ceid=IL:he', region: 'israel' },
  de: { params: 'hl=de&gl=DE&ceid=DE:de', region: 'europe' },
  fr: { params: 'hl=fr&gl=FR&ceid=FR:fr', region: 'europe' },
  ko: { params: 'hl=ko&gl=KR&ceid=KR:ko', region: 'korea' },
};

const HOME_EDITION = { CN: 'zh', HK: 'zh', TW: 'zh-TW', IL: 'he', DE: 'de', AT: 'de', CH: 'de', FR: 'fr', KR: 'ko' };

export const LEADERSHIP_TERMS = {
  en: '(CEO OR "chief executive" OR chairman OR CFO) (appoint OR appoints OR appointed OR resign OR resigns OR "steps down" OR successor OR ousted)',
  zh: '(CEO OR 首席执行官 OR 董事长 OR 总裁) (任命 OR 辞职 OR 辞任 OR 卸任 OR 接任 OR 离职)',
  'zh-TW': '(CEO OR 執行長 OR 董事長 OR 總裁) (任命 OR 辭職 OR 辭任 OR 卸任 OR 接任)',
  he: '(מנכ"ל OR יו"ר) (מינוי OR מונה OR התפטר OR התפטרות OR פורש OR יחליף)',
  de: '(CEO OR Vorstandschef OR Konzernchef OR Aufsichtsratschef) (Nachfolger OR Rücktritt OR ernannt OR Wechsel OR zurücktreten)',
  fr: '(PDG OR "directeur général" OR CEO) (nomination OR nommé OR démission OR successeur OR départ)',
  ko: '(CEO OR 대표이사 OR 회장 OR 사장) (선임 OR 사임 OR 취임 OR 교체 OR 내정)',
};

export function editionsFor(company) {
  const home = HOME_EDITION[company.country];
  return [...new Set(['en', ...(home ? [home] : []), ...(company.editions ?? [])])];
}

const SCRIPTS = {
  zh: /\p{Script=Han}/u,
  he: /\p{Script=Hebrew}/u,
  ko: /\p{Script=Hangul}/u,
};

/** The quoted company term used in a given edition. */
export function searchTerm(company, edition) {
  const lang = EDITIONS[edition].lang ?? edition;
  if (company.queries?.[lang]) return company.queries[lang];
  const native = SCRIPTS[lang] && company.aliases.find((alias) => SCRIPTS[lang].test(alias));
  return `"${(native || company.name).replace(/"/g, lang === 'he' ? '״' : '')}"`;
}

const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decode(value = '') {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
      if (!code.startsWith('#')) return NAMED[code.toLowerCase()];
      const point = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseRss(xml, edition, nowMs = Date.now()) {
  if (!xml.includes('<rss')) throw new Error('Not an RSS feed');
  const items = [];
  const { region, lang = edition } = EDITIONS[edition];
  for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (name) => decode(body.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1]);
    const source = tag('source');
    let title = tag('title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const url = tag('link');
    const time = Date.parse(tag('pubDate'));
    if (!title || !url.startsWith('https://') || !Number.isFinite(time) || time > nowMs + 3600_000) continue;
    items.push({ title, url, source: source || 'Google News', time, lang, region });
  }
  return items;
}

export const newsCacheKey = (query, edition) => `news:${edition}:${query}`;

export function searchNews(query, edition, ttlMs = 90_000, timeoutMs = 8000) {
  return cached(newsCacheKey(query, edition), ttlMs, async () => parseRss(
    await fetchText(
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${EDITIONS[edition].params}`,
      { timeoutMs },
    ),
    edition,
  ), 15 * 60_000);
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalize = (value) => value.replace(/[״“”]/g, '"').replace(/[׳’‘]/g, "'");
const patterns = new Map();

function aliasPattern(alias) {
  let pattern = patterns.get(alias);
  if (pattern) return pattern;
  const text = escapeRegex(normalize(alias));
  if (/\p{Script=Hebrew}/u.test(alias)) {
    // Hebrew attaches one- or two-letter prepositions to names.
    pattern = new RegExp(`(?<!\\p{Script=Hebrew})[ובלשמכ]{0,2}${text}(?!\\p{Script=Hebrew})`, 'u');
  } else if (/[\p{Script=Han}\p{Script=Hangul}]/u.test(alias)) {
    pattern = new RegExp(text, 'u');
  } else {
    // All-capital names (NICE, SAP, ICL) must match case to avoid common words.
    const flags = alias === alias.toUpperCase() ? 'u' : 'iu';
    pattern = new RegExp(`(?<![\\p{Script=Latin}\\d])${text}(?![\\p{Script=Latin}\\d])`, flags);
  }
  patterns.set(alias, pattern);
  return pattern;
}

/** The listed company a headline names first, or null. */
export function primaryCompany(title, companies) {
  let match = null;
  let best = Number.POSITIVE_INFINITY;
  for (const company of companies) {
    const index = mentionIndex(title, company);
    if (index >= 0 && index < best) {
      match = company;
      best = index;
    }
  }
  return match;
}

/** Index of the first mention of the company in the title, or -1. */
export function mentionIndex(title, company) {
  let text = normalize(title);
  for (const phrase of company.exclude ?? []) text = text.replaceAll(phrase, ' '.repeat(phrase.length));
  let best = -1;
  for (const alias of company.aliases) {
    const index = text.search(aliasPattern(alias));
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}
