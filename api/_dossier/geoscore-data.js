// Loader of the geopolitical score: static map layers from shared/, headlines of the world
// feeds, the country instability index and the world events. Math: ./math/geoscore.js
import {
  CONFLICT_ZONES, INTEL_HOTSPOTS, MILITARY_BASES_EXPANDED, NUCLEAR_FACILITIES, STRATEGIC_WATERWAYS,
} from './geoscore-layers.generated.js';
import {
  COMPONENTS, PARAMS, conflictProximity, corpusStats, corroboration, dispersion, instabilityComponent,
  marketComponent, populationPrior, prepareNews, scoreEntity, severity, strategicExposure,
  surpriseComponent, volumeSurprise,
} from './math/geoscore.js';
import { cached, errorMessage, fetchText, pool } from './util.js';
import { FEEDS, buildWorld, headlineTone, parseFeed } from './world.js';

const TTL_MS = 5 * 60_000;
const FEED_BUDGET_MS = 15_000;
const SOURCE_BUDGET_MS = 21_000;

// code | Russian-free English matcher over headlines and static place descriptions.
const COUNTRY_TERMS = {
  US: 'U\\.S\\.|USA?|United States|Americans?|Washington|White House|Pentagon', CA: 'Canada|Canadians?|Ottawa',
  MX: 'Mexico|Mexicans?', BR: 'Brazil|Brazilians?', AR: 'Argentina|Argentin(?:e|ian)s?', VE: 'Venezuela\\w*|Caracas',
  HT: 'Haiti\\w*', CU: 'Cuba|Cubans?', BZ: 'Belize', PR: 'Puerto Ric\\w+',
  GB: 'Britain|British|UK|United Kingdoms?|London', DE: 'Germany|Germans?|Berlin', FR: 'France|French|Paris',
  IT: 'Italy|Italians?|Rome', ES: 'Spain|Spanish|Madrid', NL: 'Netherlands|Dutch', CH: 'Switzerland|Swiss',
  SE: 'Sweden|Swedish', NO: 'Norway|Norwegians?', PL: 'Poland|Polish|Warsaw', BE: 'Belgium|Belgian',
  BG: 'Bulgaria\\w*', PT: 'Portugal|Portuguese', CY: 'Cyprus|Cypriot', XK: 'Kosovo', GI: 'Gibraltar',
  DK: 'Denmark|Danish|Greenland', UA: 'Ukraine|Ukrainians?|Kyiv', RU: 'Russia|Russians?|Moscow|Kremlin|Putin',
  BY: 'Belarus\\w*', MD: 'Moldova\\w*', GE: 'Georgian? (?:government|parliament)|Tbilisi|^Georgia$', AM: 'Armenia\\w*',
  TR: 'Turkey|Turkish|T[uü]rkiye|Ankara', IL: 'Israel|Israelis?|Jerusalem|Netanyahu|IDF', IR: 'Iran|Iranians?|Tehran',
  IQ: 'Iraq|Iraqis?|Baghdad', SY: 'Syria|Syrians?|Damascus', LB: 'Lebanon|Lebanese|Beirut', SA: 'Saudi|Riyadh',
  AE: 'UAE|United Arab Emirates|Emirati|Dubai|Abu Dhabi', QA: 'Qatar|Qatari|Quatar|Doha', KW: 'Kuwaiti?',
  BH: 'Bahraini?', OM: 'Oman|Omani', YE: 'Yemen|Yemeni|Houthis?', PS: 'Gaza|Palestinians?|West Bank',
  EG: 'Egypt|Egyptians?|Cairo', LY: 'Libya\\w*', SD: 'Sudan|Sudanese|Khartoum|Darfur', ER: 'Eritrea\\w*',
  DJ: 'Djibouti', SO: 'Somalia|Somalis?|Somaliland', ET: 'Ethiopia\\w*', KE: 'Kenya\\w*', TD: 'Chad|Chadian',
  NE: 'Niger|Nigerien', ML: 'Mali|Malian', BF: 'Burkina', SN: 'Senegal\\w*', CI: 'Ivory Coast|Ivorian',
  GA: 'Gabon\\w*', CM: 'Cameroon\\w*', MG: 'Madagascar', MU: 'Mauriti(?:us|an)', SC: 'Seychelles', ZA: 'South Africa\\w*',
  AF: 'Afghanistan|Afghans?|Kabul|Taliban', PK: 'Pakistan|Pakistanis?|Islamabad', IN: 'India|Indians?|New Delhi',
  BD: 'Bangladesh\\w*', NP: 'Nepal\\w*', BT: 'Bhutan\\w*', MV: 'Maldives', MM: 'Myanmar|Burma|Burmese',
  KZ: 'Kazakh\\w*', KG: 'Kyrgyz\\w*', TJ: 'Tajik\\w*', CN: 'China|Chinese|Beijing', TW: 'Taiwan|Taiwanese|Taipei',
  JP: 'Japan|Japanese|Tokyo', KR: 'South Korea\\w*|Seoul', KP: 'North Korea\\w*|Pyongyang|DPRK',
  PH: 'Philippines|Filipino|Manila', KH: 'Cambodia\\w*', SG: 'Singapore\\w*', BN: 'Brunei', ID: 'Indonesia\\w*',
  MY: 'Malaysia\\w*', AU: 'Australia\\w*', PA: 'Panama\\w*',
};
const COUNTRY_RE = Object.entries(COUNTRY_TERMS).map(([code, terms]) => [code, new RegExp(`\\b(?:${terms})\\b`)]);
const RE_BY_CODE = new Map(COUNTRY_RE);
export const countriesIn = (text) => COUNTRY_RE.filter(([, re]) => re.test(text)).map(([code]) => code);

const WATERWAY_TERMS = {
  taiwan_strait: ['taiwan strait'], malacca_strait: ['malacca'], hormuz_strait: ['hormuz'], bosphorus: ['bosphorus', 'bosporus'],
  suez: ['suez'], panama: ['panama canal'], gibraltar: ['gibraltar'], bab_el_mandeb: ['bab el-mandeb', 'bab al-mandab', 'red sea'],
  cape_of_good_hope: ['cape of good hope'], dover_strait: ['english channel', 'dover strait'], korea_strait: ['korea strait'],
  kerch_strait: ['kerch'], lombok_strait: ['lombok'],
};
const GENERIC = new Set(('ai,oil,energy,navy,border,rocket,airstrike,missile,drone,ship,shipping,tanker,blockade,strait,coup,junta,'
  + 'resistance,famine,militia,congress,senate,supreme court,cross-border,gangs,piracy,pdf,saf,mit,shan,kim,xi,nug').split(','));
const EXTRA_TERMS = { korean_dmz: ['dmz', 'demilitarized zone', 'north korea', 'pyongyang'] };
const SITE_WORDS = /\b(?:nuclear|power|plant|station|facility|enrichment|research|center|centre|complex|reactor|air ?base|naval|base|airfield|camp|port|ab|afb|nas|raf|site|test|laboratory|lab|national|military|support|joint|fort|mtn)\b/gi;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function termsRe(terms) {
  const list = [...new Set((terms ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 2 && !GENERIC.has(t)))];
  return list.length ? new RegExp(`(?<![\\p{L}\\d])(?:${list.map(escape).join('|')})(?![\\p{L}\\d])`, 'iu') : null;
}

/** The distinctive part of a site name; null when what remains is too short or a country name. */
export function siteTerm(name) {
  const core = String(name ?? '').replace(/\(.*?\)/g, ' ').replace(SITE_WORDS, ' ').replace(/[^\p{L}' -]/gu, ' ').replace(/\s+/g, ' ').trim();
  return core.length >= 5 && !countriesIn(core).length ? core : null;
}

const point = (layer, raw, extra) => ({ key: `${layer}:${raw.id}`, id: raw.id, layer, name: raw.name, lat: raw.lat, lon: raw.lon, ...extra });

export const POINTS = [
  ...INTEL_HOTSPOTS.map((h) => point('hotspot', h, {
    countries: countriesIn(`${h.name} ${h.location ?? ''}`), placeRe: termsRe(h.keywords),
  })),
  ...CONFLICT_ZONES.map((z) => point('conflict', { ...z, lat: z.center[1], lon: z.center[0] }, {
    countries: countriesIn(`${z.name} ${z.location ?? ''}`), placeRe: termsRe(z.keywords?.length ? z.keywords : EXTRA_TERMS[z.id]),
  })),
  ...STRATEGIC_WATERWAYS.map((w) => point('waterway', w, { countries: [], placeRe: termsRe(WATERWAY_TERMS[w.id]) })),
  ...NUCLEAR_FACILITIES.map((n) => point('nuclear', n, {
    countries: n.operator ? [n.operator] : [], placeRe: termsRe([siteTerm(n.name) ?? '']),
  })),
  ...MILITARY_BASES_EXPANDED.map((b) => point('base', b, {
    countries: countriesIn(b.country === 'America' ? 'USA' : b.country ?? ''), placeRe: termsRe([siteTerm(b.name) ?? '']),
  })),
];

const NUCLEAR_ACTIVE = NUCLEAR_FACILITIES.filter((n) => n.status !== 'decommissioned');

/** Headlines about the place and, separately, only about its countries. */
function split(news, placeRe, countries) {
  const res = countries.map((code) => RE_BY_CODE.get(code)).filter(Boolean);
  const place = [];
  const country = [];
  for (const item of news) {
    if (placeRe?.test(item.title)) place.push(item);
    else if (res.some((re) => re.test(item.title))) country.push(item);
  }
  return { place, country };
}

const eventTitles = (e) => [e.title, ...(e.sources ?? []).map((s) => s.title)].filter(Boolean);

function newsOf(ctx, target) {
  const { place, country } = split(ctx.news, target.placeRe, target.countries);
  const own = volumeSurprise(place, ctx.corpus);
  const surprise = own ?? volumeSurprise([...place, ...country], ctx.corpus);
  return { place, country, surprise, basis: own ? ' (по месту)' : ' (по стране)' };
}

function geography(target) {
  return {
    conflict: conflictProximity(target, CONFLICT_ZONES),
    exposure: strategicExposure(target, STRATEGIC_WATERWAYS, NUCLEAR_ACTIVE),
  };
}

function pointValues(ctx, target, found) {
  const related = ctx.events.filter((e) => eventTitles(e).some((title) => target.placeRe?.test(title)
    || target.countries.some((code) => RE_BY_CODE.get(code)?.test(title))));
  return {
    surprise: surpriseComponent(found.surprise, ctx.phi, found.basis),
    sources: corroboration(found.place, found.country),
    severity: severity(found.place, found.country, ctx.corpus),
    instability: instabilityComponent(target.countries, ctx.index),
    ...geography(target),
    market: marketComponent(related, ctx.nowMs),
  };
}

/** An event is located through the countries and map hotspots its headlines name. */
function eventValues(ctx, event) {
  const titles = eventTitles(event);
  const text = titles.join(' \n ');
  const countries = countriesIn(event.title);
  const places = POINTS.filter((p) => (p.layer === 'hotspot' || p.layer === 'waterway') && p.placeRe?.test(event.title));
  const own = (event.sources?.length ? event.sources : [{ name: '', title: event.title }])
    .map((s, i) => ({ source: s.name || `outlet${i}`, title: s.title || event.title, time: s.time ?? event.lastAt }));
  const age = (ctx.nowMs - event.lastAt) / 3_600_000;
  // The cluster knows how many outlets reported it, even when only a few are listed.
  const outlets = Array.from({ length: Math.max(1, Math.round(event.independent ?? event.sourceCount ?? own.length)) },
    (_, i) => ({ source: `o${i}`, d: 2 ** (-Math.max(0, age) / PARAMS.halfLifeHours) }));
  const prepared = prepareNews(own.map((o, i) => ({ ...o, feed: `event${i}` })), headlineTone, ctx.nowMs);
  const found = newsOf(ctx, { placeRe: places[0]?.placeRe ?? null, countries });
  const geo = places.length ? places.map(geography) : [];
  const strongest = (id) => geo.map((g) => g[id]).sort((a, b) => b.value - a.value)[0];
  // Without a named hotspot the country's own hotspot stands in for the location.
  const anchor = geo.length ? null : POINTS.find((p) => p.layer === 'hotspot' && p.countries.length === 1 && countries.includes(p.countries[0]));
  const fallback = anchor ? geography(anchor) : null;
  const unplaced = { reason: 'место события по заголовку не определено' };
  const sources = corroboration(outlets);
  if (sources.note) sources.note = `независимых изданий: ${outlets.length}`;
  return {
    countries,
    mentions: found.place.length + found.country.length,
    values: {
      surprise: countries.length || places.length ? surpriseComponent(found.surprise, ctx.phi, found.basis) : { reason: 'место события по заголовку не определено' },
      sources,
      severity: severity(prepared, [], ctx.corpus),
      instability: instabilityComponent(countries, ctx.index),
      conflict: strongest('conflict') ?? fallback?.conflict ?? unplaced,
      exposure: strongest('exposure') ?? fallback?.exposure ?? unplaced,
      market: event.assets ? marketComponent([event], ctx.nowMs) : { reason: 'реакция рынка для события не измерена' },
    },
    text,
  };
}

const within = (promise, ms, label, errors) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('не уложился в бюджет времени')), ms); }),
  ]).catch((error) => {
    errors.push({ source: label, message: errorMessage(error) });
    return null;
  }).finally(() => clearTimeout(timer));
};

async function loadNews(errors) {
  const items = [];
  let ok = 0;
  const deadline = Date.now() + FEED_BUDGET_MS;
  const feeds = FEEDS.filter((f) => !f.url.includes('news.google.com') && f.lang !== 'zh');
  await pool(feeds, 14, async (feed) => {
    try {
      const left = deadline - Date.now();
      if (left < 800) throw new Error('Пропущено: бюджет времени исчерпан');
      // Same cache key and value shape as the world view, so one fetch serves both.
      const { value } = await cached(`worldfeed:${feed.id}`, 120_000, async () => parseFeed(
        await fetchText(feed.url, { timeoutMs: Math.min(7000, left), headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } }),
        Date.now(),
      ));
      ok += 1;
      for (const item of value) items.push({ title: item.title, source: item.source || feed.name, time: item.time, feed: feed.id });
    } catch (error) {
      errors.push({ source: `feed:${feed.name}`, message: errorMessage(error) });
    }
  });
  return { items, asked: feeds.length, ok };
}

async function loadInstability() {
  // Imported lazily: if the index module fails, only its component is missing.
  const { buildInstability } = await import('./instability-data.js');
  return buildInstability();
}

/** Pure assembly: collected inputs in, scored points and events out. */
export function assembleGeoscore({ items, instability, world, nowMs }) {
  const news = prepareNews(items, headlineTone, nowMs);
  const corpus = corpusStats(news);
  const index = new Map((instability?.countries ?? []).filter((c) => c?.code).map((c) => [c.code, c]));
  const events = world?.events ?? [];
  const ctx = { news, corpus, index, nowMs, events, phi: 1 };
  const found = POINTS.map((p) => newsOf(ctx, p));
  ctx.phi = dispersion(found.map((f) => f.surprise?.z));
  const values = POINTS.map((p, i) => pointValues(ctx, p, found[i]));
  const prior = populationPrior(values);
  const order = (a, b) => (b.score ?? -1) - (a.score ?? -1);
  const points = POINTS.map((p, i) => ({
    key: p.key, layer: p.layer, name: p.name, lat: p.lat, lon: p.lon, countries: p.countries,
    mentions: { place: found[i].place.length, country: found[i].country.length },
    ...scoreEntity(values[i], prior),
  })).sort(order);
  points.forEach((p, i) => { p.rank = p.score === null ? null : i + 1; });
  const scored = [...events, ...(world?.more ?? [])].map((event) => {
    const { countries, values: v } = eventValues(ctx, event);
    return {
      id: event.id, title: event.title, url: event.url, type: event.typeLabel, lastAt: event.lastAt, countries,
      ...scoreEntity(v, prior),
    };
  }).sort(order);
  return {
    ctx,
    prior,
    body: {
      updatedAt: nowMs,
      points,
      events: scored,
      components: COMPONENTS,
      method: {
        params: PARAMS,
        prior: prior && { mean: Math.round(prior.mean * 1e6) / 1e4, betweenSd: Math.round(Math.sqrt(prior.between) * 1e6) / 1e4, n: prior.n },
        surpriseDispersion: Math.round(ctx.phi * 1e4) / 1e4,
        headlines: corpus.total,
        doc: 'docs/math/geoscore.md',
      },
    },
  };
}

async function snapshot() {
  const load = async () => {
    const nowMs = Date.now();
    const errors = [];
    const [news, instability, world] = await Promise.all([
      loadNews(errors),
      within(loadInstability(), SOURCE_BUDGET_MS, 'instability', errors),
      within(buildWorld(nowMs), SOURCE_BUDGET_MS, 'world', errors),
    ]);
    if (!news.items.length && !instability) throw new Error('No geoscore evidence');
    const result = assembleGeoscore({ items: news.items, instability, world, nowMs: Date.now() });
    result.body.sources = { feeds: news.asked, feedsOk: news.ok, instability: Boolean(instability), world: Boolean(world) };
    result.body.errors = errors;
    result.complete = Boolean(instability && world);
    return result;
  };
  const first = await cached('geoscore:v1', TTL_MS, load, 30 * 60_000);
  // A snapshot missing a source is rebuilt after one minute instead of five.
  if (!first.value.complete && Date.now() - first.value.body.updatedAt > 60_000) {
    return (await cached('geoscore:v1', 0, load, 30 * 60_000)).value;
  }
  return first.value;
}

/** A marker outside the static lists (economic centre, outage, ...), scored from its coordinates. */
function adhoc(snap, { lat, lon, name, country }) {
  const countries = countriesIn(`${name} ${country}`);
  const target = { lat, lon, countries, placeRe: termsRe([siteTerm(name) ?? '']) };
  const found = newsOf(snap.ctx, target);
  return {
    key: 'adhoc', layer: 'adhoc', name, lat, lon, countries, rank: null,
    mentions: { place: found.place.length, country: found.country.length },
    ...scoreEntity(pointValues(snap.ctx, target, found), snap.prior),
  };
}

export async function buildGeoscore({ point: key = null, lat = null, lon = null, name = '', country = '', limit = 40 } = {}) {
  const snap = await snapshot();
  const { points, events, ...rest } = snap.body;
  if (key !== null || lat !== null) {
    let hit = points.find((p) => p.key === key) ?? null;
    if (!hit && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      hit = adhoc(snap, { lat, lon, name: name.slice(0, 120), country: country.slice(0, 60) });
    }
    return { ...rest, point: hit };
  }
  const scored = points.filter((p) => p.score !== null);
  return {
    ...rest,
    counts: { points: points.length, scored: scored.length },
    points: scored.slice(0, Math.max(1, Math.min(1000, limit || 40))),
    // Compact [score, low, high] of every scored point, for map hover tooltips.
    index: Object.fromEntries(scored.map((p) => [p.key, [p.score, p.low, p.high]])),
    events,
  };
}
