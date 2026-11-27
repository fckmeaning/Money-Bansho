// World wire: the most important events of the last 72 hours and what they
// touch. Headlines come from curated public RSS feeds (world, Europe, China,
// Israel, Korea, finance) and from GDELT DOC 2.0; near-duplicates are merged
// into events, events are ranked by a transparent score, and each event is
// tied to regions, market instruments (observed move, not causation) and
// listed companies. Keyless sources only; a failing source is reported, never
// replaced by invented data.
import companies from './companies.js';
import { mentionIndex } from './news.js';
import { cached, errorMessage, fetchText, pool } from './util.js';
import { parseChart } from './yahoo.js';

const HOUR = 3600_000;
export const WINDOW_HOURS = 72;
export const CLUSTER_THRESHOLD = 0.26;
const FEED_TTL_MS = 120_000;
const WORLD_TTL_MS = 90_000;
const GDELT_TTL_MS = 15 * 60_000;
const GDELT_GAP_MS = 5200;
const BIN_HOURS = 3;

/** Expert weights of the significance score. They are not fitted on history. */
export const WEIGHTS = { src: 0.34, tier: 0.12, rec: 0.18, tone: 0.1, type: 0.14, mkt: 0.12 };
export const REC_SIGMA_HOURS = 24;
const TIER_WEIGHT = { 1: 1, 2: 0.8, 3: 0.55, 4: 0.35 };

// ---- sources ------------------------------------------------------------------

const GN = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// tier: 1 wire or official body, 2 major outlet, 3 specialist or regional source.
export const FEEDS = [
  { id: 'bbc-world', name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', region: 'world', tier: 2 },
  { id: 'bbc-mideast', name: 'BBC Middle East', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml', region: 'israel', tier: 2 },
  { id: 'aljazeera', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', region: 'world', tier: 2 },
  { id: 'npr-world', name: 'NPR World', url: 'https://feeds.npr.org/1004/rss.xml', region: 'world', tier: 2 },
  { id: 'nyt-world', name: 'New York Times World', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', region: 'world', tier: 2 },
  { id: 'un-news', name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', region: 'world', tier: 1 },
  { id: 'bbc-business', name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', region: 'finance', tier: 2 },
  { id: 'cnbc', name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', region: 'finance', tier: 2 },
  { id: 'fed', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', region: 'finance', tier: 1 },
  { id: 'ft-markets', name: 'FT Markets', url: 'https://www.ft.com/markets?format=rss', region: 'finance', tier: 2 },
  { id: 'bbc-europe', name: 'BBC Europe', url: 'https://feeds.bbci.co.uk/news/world/europe/rss.xml', region: 'europe', tier: 2 },
  { id: 'ft-europe', name: 'FT Europe', url: 'https://www.ft.com/world/europe?format=rss', region: 'europe', tier: 2 },
  { id: 'dw-business', name: 'DW Business', url: 'https://rss.dw.com/rdf/rss-en-bus', region: 'europe', tier: 2 },
  { id: 'france24-europe', name: 'France 24 Europe', url: 'https://www.france24.com/en/europe/rss', region: 'europe', tier: 2 },
  { id: 'france24-biz', name: 'France 24 Business', url: 'https://www.france24.com/en/business-tech/rss', region: 'europe', tier: 2 },
  { id: 'ansa-en', name: 'ANSA English', url: 'https://www.ansa.it/english/news/english_nr_rss.xml', region: 'europe', tier: 1 },
  { id: 'euronews', name: 'Euronews', url: 'https://www.euronews.com/rss?format=mrss', region: 'europe', tier: 2 },
  { id: 'scmp-china', name: 'SCMP China', url: 'https://www.scmp.com/rss/4/feed', region: 'china', tier: 2 },
  { id: 'scmp-business', name: 'SCMP Business', url: 'https://www.scmp.com/rss/92/feed', region: 'china', tier: 2 },
  { id: 'cgtn-world', name: 'CGTN World', url: 'https://www.cgtn.com/subscribe/rss/section/world.xml', region: 'china', tier: 3 },
  { id: 'cgtn-business', name: 'CGTN Business', url: 'https://www.cgtn.com/subscribe/rss/section/business.xml', region: 'china', tier: 3 },
  { id: 'cna-en', name: 'Focus Taiwan (CNA)', url: 'https://feeds.feedburner.com/rsscna/engnews', region: 'china', tier: 2 },
  { id: 'rthk-world', name: 'RTHK World', url: 'https://rthk9.rthk.hk/rthk/news/rss/e_expressnews_einternational.xml', region: 'china', tier: 2 },
  { id: 'xinhua', name: 'Xinhua English', url: GN('site:english.news.cn when:2d'), region: 'china', tier: 1 },
  { id: 'chinanews-fin', name: 'China News Service Finance', url: 'https://www.chinanews.com.cn/rss/finance.xml', region: 'china', tier: 3, lang: 'zh' },
  { id: 'jpost-israel', name: 'Jerusalem Post', url: 'https://www.jpost.com/rss/rssfeedsisraelnews.aspx', region: 'israel', tier: 2 },
  { id: 'haaretz-en', name: 'Haaretz English', url: 'https://www.haaretz.com/srv/haaretz-latest-headlines', region: 'israel', tier: 2 },
  { id: 'ynetnews', name: 'Ynetnews', url: 'https://www.ynetnews.com/Integration/StoryRss3089.xml', region: 'israel', tier: 2 },
  { id: 'globes-en', name: 'Globes English', url: 'https://en.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=1725', region: 'israel', tier: 3 },
  { id: 'jns', name: 'JNS', url: 'https://www.jns.org/feed/', region: 'israel', tier: 3 },
  { id: 'toi', name: 'Times of Israel', url: GN('site:timesofisrael.com when:2d'), region: 'israel', tier: 2 },
  { id: 'yonhap-nk', name: 'Yonhap North Korea', url: 'https://en.yna.co.kr/RSS/nk.xml', region: 'korea', tier: 1 },
  { id: 'yonhap-en', name: 'Yonhap English', url: 'https://en.yna.co.kr/RSS/news.xml', region: 'korea', tier: 1 },
  { id: 'nk-sanctions', name: 'Google News: North Korea', url: GN('"North Korea" (sanctions OR missile OR hackers OR Kim) when:2d'), region: 'korea', tier: 3 },
  { id: 'gn-sanctions', name: 'Google News: sanctions', url: GN('(sanctions OR tariffs OR embargo OR "export controls") when:1d'), region: 'world', tier: 3 },
  { id: 'gn-central-banks', name: 'Google News: central banks', url: GN('("central bank" OR "interest rate" OR inflation) when:1d'), region: 'finance', tier: 3 },
  { id: 'gn-energy', name: 'Google News: energy', url: GN('(oil OR OPEC OR "natural gas" OR LNG) when:1d'), region: 'finance', tier: 3 },
  { id: 'gn-elections', name: 'Google News: elections', url: GN('(election OR referendum OR "prime minister") when:1d'), region: 'world', tier: 3 },
  { id: 'gn-conflict', name: 'Google News: conflicts', url: GN('(war OR ceasefire OR missile OR airstrike) when:1d'), region: 'world', tier: 3 },
];

const WIRE_RE = /\b(?:reuters|associated press|ap news|afp|bloomberg|xinhua|tass|kyodo|yonhap|ansa|dpa|efe|anadolu)\b/i;
const OFFICIAL_RE = /\b(?:federal reserve|un news|united nations|imf|world bank|ecb|white house|state department|treasury|who|iaea)\b/i;
const MAJOR_RE = /\b(?:cbs news|abc news|nbc news|pbs|axios|usa today|sky news|the national|arab news|kyiv independent|the telegraph|marketwatch|barron's|bbc|guardian|new york times|nytimes|wall street journal|wsj|financial times|ft\.com|cnn|al jazeera|aljazeera|npr|washington post|economist|dw|deutsche welle|france 24|le monde|scmp|south china morning post|cnbc|haaretz|times of israel|jerusalem post|ynet|politico|nikkei|straits times|channel news asia|cna|rthk|euronews|handelsblatt|der spiegel|nzz)\b/i;

/** Tier of a publisher name or domain; a feed default applies when unknown. */
export function sourceTier(name, fallback = 3) {
  const text = String(name || '');
  if (WIRE_RE.test(text) || OFFICIAL_RE.test(text)) return 1;
  if (MAJOR_RE.test(text)) return 2;
  return fallback;
}

export const MARKETS = [
  { symbol: '^GSPC', name: 'S&P 500', kind: 'index', regions: ['us'] },
  { symbol: '^STOXX50E', name: 'Euro Stoxx 50', kind: 'index', regions: ['europe'] },
  { symbol: '^HSI', name: 'Hang Seng', kind: 'index', regions: ['china'] },
  { symbol: '^N225', name: 'Nikkei 225', kind: 'index', regions: ['asia'] },
  { symbol: '^TA125.TA', name: 'TA-125', kind: 'index', regions: ['israel'] },
  { symbol: 'EURUSD=X', name: 'EUR/USD', kind: 'fx', regions: ['europe'] },
  { symbol: 'CNY=X', name: 'USD/CNY', kind: 'fx', regions: ['china'] },
  { symbol: 'ILS=X', name: 'USD/ILS', kind: 'fx', regions: ['israel'] },
  { symbol: 'CL=F', name: 'Нефть WTI', kind: 'commodity', regions: ['israel', 'russia'] },
  { symbol: 'GC=F', name: 'Золото', kind: 'commodity', regions: [] },
  { symbol: '^VIX', name: 'VIX', kind: 'index', regions: [] },
  { symbol: '^TNX', name: 'UST 10Y, %', kind: 'yield', regions: ['us'] },
];
const MARKET_BY_SYMBOL = new Map(MARKETS.map((m) => [m.symbol, m]));

// ---- event types, regions, tone -----------------------------------------------------

const type = (id, label, prior, latin, other) => ({
  id,
  label,
  prior,
  re: new RegExp(`\\b(?:${latin})\\b|${other}`, 'giu'),
});

// Order breaks ties. Latin keywords are English headlines; the rest covers zh/he/ko.
export const EVENT_TYPES = [
  type('conflict', 'Конфликты и безопасность', 0.9,
    'war|wars|attacks?|airstrikes?|strikes? (?:on|in|near|against|kill\\w*)|killed|killing|death toll|casualt\\w+|wounded|missiles?|drones?|troops|soldiers?|army|invasion|ceasefire|truce|hostages?|bombing|blasts?|explosions?|shelling|offensive|militants?|terror\\w*|nuclear|warhead|military|clashes|rockets?|houthis?|hezbollah|hamas|nato',
    '战争|空袭|袭击|导弹|停火|冲突|מלחמה|תקיפה|טיל|הפסקת אש|전쟁|공습|미사일|휴전|도발'),
  type('sanctions', 'Санкции и торговля', 0.8,
    'sanctions?|sanctioned|embargo|tariffs?|export controls?|trade war|trade deal|trade talks|blacklist\\w*|retaliat\\w+',
    '制裁|关税|禁运|סנקציות|מכסים|제재|관세'),
  type('central_bank', 'Центробанки и ставки', 0.85,
    'central banks?|interest rates?|rate (?:cut|hike|decision)s?|fomc|federal reserve|fed|ecb|boj|pboc|bank of (?:japan|england|israel|korea|canada)|monetary policy|inflation|cpi|powell|lagarde|treasury yields?',
    '央行|加息|降息|利率|通胀|ריבית|בנק ישראל|אינפלציה|기준금리|인플레이션|중앙은행'),
  type('energy', 'Энергетика', 0.75,
    'oil|crude|opec\\+?|brent|natural gas|lng|pipelines?|refiner\\w*|energy prices?|gasoline|power grid',
    '石油|原油|天然气|נפט|גז|유가|원유|석유'),
  type('disaster', 'Катастрофы и здоровье', 0.6,
    'earthquakes?|floods?|flooding|hurricane|typhoon|wildfires?|pandemic|outbreak|epidemic|famine|tsunami|volcano|cyclone',
    '地震|洪水|台风|רעידת אדמה|שיטפון|지진|태풍'),
  type('elections', 'Выборы и власть', 0.6,
    'elections?|voters?|ballot|referendum|parliament|coalition|prime minister|polls?|campaign|summit',
    '选举|大选|בחירות|선거|대선'),
  type('economy', 'Экономика и рынки', 0.7,
    'gdp|recession|economy|economic|unemployment|jobs report|growth|imf|world bank|stocks?|markets?|shares|debt|bonds?|bankruptcy|default|deficit|earnings|layoffs?|exports?|imports?',
    '经济|股市|股票|כלכלה|מניות|בורסה|경제|증시|주가'),
];
const OTHER_TYPE = { id: 'other', label: 'Прочее', prior: 0.25 };

/** Pick the type with most keyword hits across the titles; ties go to the earlier type. */
export function classifyTexts(texts) {
  let best = OTHER_TYPE;
  let bestCount = 0;
  for (const candidate of EVENT_TYPES) {
    let count = 0;
    for (const text of texts) count += (text.match(candidate.re) ?? []).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return { id: best.id, label: best.label, prior: best.prior, hits: bestCount };
}

const REGIONS = [
  ['us', 'США', /\b(?:U\.S\.|US|USA|United States|American|America|Washington|Trump|Wall Street|White House|Congress|Pentagon|Federal Reserve|Fed|Powell)\b/g],
  ['europe', 'Европа', /\b(?:Europe|European|EU|Eurozone|Brussels|ECB|Lagarde|Germany|German|Berlin|France|French|Paris|Macron|Italy|Italian|Rome|Spain|Spanish|Britain|British|UK|London|Starmer|Netherlands|Dutch|Poland|Polish|Switzerland|Swiss|Sweden|Denmark|Norway|Finland|Greece|Austria|Belgium|Ireland|Portugal|Hungary|Romania|Merz)\b/g],
  ['china', 'Китай и Гонконг', /\b(?:China|Chinese|Beijing|Xi Jinping|Hong Kong|Taiwan|Taipei|PBoC|yuan|Shanghai|Shenzhen)\b|中国|北京|香港|台湾|人民银行|央行/g],
  ['israel', 'Израиль и Ближний Восток', /\b(?:Israel|Israeli|Gaza|Tel Aviv|Jerusalem|Hamas|Hezbollah|IDF|Netanyahu|West Bank|Lebanon|Iran|Iranian|Tehran|Houthis?|Yemen|Red Sea|Syria|Iraq|Saudi|Qatar|UAE|Gulf|Middle East)\b|ישראל|עזה|איראן/g],
  ['korea', 'КНДР и Корея', /\b(?:North Korea|South Korea|Korea|Korean|Pyongyang|Seoul|Kim Jong\w*|KCNA|DPRK)\b|북한|한국|서울|평양/g],
  ['russia', 'Россия и Украина', /\b(?:Russia|Russian|Moscow|Putin|Kremlin|Ukraine|Ukrainian|Kyiv|Kiev|Zelensky|Belarus)\b/g],
  ['asia', 'Азия и Океания', /\b(?:Japan|Japanese|Tokyo|India|Indian|Delhi|Modi|ASEAN|Indonesia|Vietnam|Thailand|Philippines|Malaysia|Singapore|Australia|Pakistan|Asia|Asian)\b/g],
  ['other', 'Прочие регионы', /\b(?:Africa|African|Nigeria|Kenya|Ethiopia|Sudan|Congo|Brazil|Brazilian|Mexico|Mexican|Argentina|Venezuela|Colombia|Chile|Peru|Latin America|Canada|Canadian)\b/g],
];
export const REGION_LABELS = Object.fromEntries([...REGIONS.map(([id, label]) => [id, label]), ['world', 'Мир в целом']]);
const FEED_REGION = new Set(['china', 'israel', 'korea', 'europe']);

/** Regions named in the titles, most mentioned first; the feed's own region fills in when none is named. */
export function detectRegions(texts, feedRegions = []) {
  const counts = [];
  for (const [id, , re] of REGIONS) {
    let count = 0;
    for (const text of texts) count += (text.match(re) ?? []).length;
    if (count > 0) counts.push([id, count]);
  }
  counts.sort((a, b) => b[1] - a[1]);
  const found = counts.slice(0, 3).map(([id]) => id);
  if (found.length === 0) {
    const tally = new Map();
    for (const id of feedRegions) if (FEED_REGION.has(id)) tally.set(id, (tally.get(id) ?? 0) + 1);
    const top = [...tally].sort((a, b) => b[1] - a[1])[0];
    if (top) return [top[0]];
  }
  return found.length ? found : ['world'];
}

const NEGATIVE = /\b(?:war|attack\w*|kill\w*|dead|death\w*|crisis|crash\w*|plunge\w*|slump\w*|fall\w*|drop\w*|fear\w*|threat\w*|sanction\w*|recession|collapse\w*|bomb\w*|strike\w*|conflict|tension\w*|warn\w*|risk\w*|loss\w*|default|bankrupt\w*|hostage\w*|missile\w*|terror\w*|protest\w*|disaster|flood\w*|earthquake|fraud|ban|bans|banned|halt\w*|tumble\w*|slide\w*|worst|panic|shock\w*|clash\w*)\b/gi;
const POSITIVE = /\b(?:rise|rises|rising|rall(?:y|ies)\w*|gain\w*|growth|grow\w*|surge\w*|record|deal|agreement|ceasefire|truce|peace|recover\w*|boost\w*|jump\w*|soar\w*|beat\w*|approve\w*|ease\w*|relief|rebound\w*|improve\w*|cooperation|talks|support\w*)\b/gi;

/** Headline tone in (-1, 1) from a small word list: an estimate, not a language model. */
export function headlineTone(title) {
  const neg = (title.match(NEGATIVE) ?? []).length;
  const pos = (title.match(POSITIVE) ?? []).length;
  return (pos - neg) / (pos + neg + 1);
}

// ---- feed parsing -----------------------------------------------------------------

const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decode(value = '') {
  return value
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
      if (!code.startsWith('#')) return NAMED[code.toLowerCase()];
      const point = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** RSS 2.0, RDF/RSS 1.0 and Atom entries. Items without a title, https link or date are skipped. */
export function parseFeed(xml, nowMs = Date.now()) {
  if (!/<(?:rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new Error('Not a feed');
  const items = [];
  for (const [, body] of xml.matchAll(/<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi)) {
    const tag = (name) => body.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))?.[1];
    const source = decode(tag('source') ?? '');
    let title = decode(tag('title') ?? '');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    let url = decode(tag('link') ?? '');
    if (!url) url = body.match(/<link[^>]*?href="([^"]+)"/i)?.[1] ?? '';
    if (!/^https?:[/][/]/.test(url)) url = decode(tag('guid') ?? '');
    const time = Date.parse(decode(tag('pubDate') ?? tag('dc:date') ?? tag('published') ?? tag('updated') ?? ''));
    if (!title || !/^https?:[/][/]/.test(url) || !Number.isFinite(time) || time > nowMs + HOUR) continue;
    items.push({ title, url, source, time });
  }
  return items;
}

const canonicalUrl = (url) => {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return url;
  }
};

async function loadFeed(feed, nowMs, timeoutMs) {
  const { value } = await cached(`worldfeed:${feed.id}`, FEED_TTL_MS, async () =>
    parseFeed(await fetchText(feed.url, { timeoutMs, headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } }), Date.now()),
  );
  return value
    .filter((item) => nowMs - item.time <= WINDOW_HOURS * HOUR)
    .slice(0, 60)
    .map((item) => ({
      title: item.title,
      url: item.url,
      source: item.source || feed.name,
      tier: item.source ? sourceTier(item.source, feed.tier) : feed.tier,
      time: item.time,
      lang: feed.lang ?? 'en',
      region: feed.region,
      feed: feed.id,
    }));
}

async function loadFeeds(nowMs, errors) {
  const items = [];
  const status = [];
  const deadline = Date.now() + 15_000;
  await pool(FEEDS, 14, async (feed) => {
    const left = deadline - Date.now();
    if (left < 800) {
      status.push({ id: feed.id, name: feed.name, items: null });
      errors.push({ source: `feed:${feed.name}`, message: 'Пропущено: бюджет времени исчерпан' });
      return;
    }
    try {
      const got = await loadFeed(feed, nowMs, Math.min(7000, left));
      items.push(...got);
      status.push({ id: feed.id, name: feed.name, items: got.length });
    } catch (error) {
      status.push({ id: feed.id, name: feed.name, items: null });
      errors.push({ source: `feed:${feed.name}`, message: errorMessage(error) });
    }
  });
  return { items, status };
}

// ---- GDELT DOC 2.0 -----------------------------------------------------------------

const GDELT_QUERY =
  '(sanctions OR tariffs OR embargo OR "central bank" OR "interest rates" OR inflation OR recession OR "oil prices" OR OPEC OR election OR ceasefire OR war OR economy) sourcelang:english';
let gdeltPauseUntil = 0;
let gdeltLastCall = 0;

/** GDELT timestamps look like 20261127T101500Z. */
export function parseGdeltTime(value) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(value));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Number.NaN;
}

export function parseGdeltArticles(body, nowMs = Date.now()) {
  const rows = Array.isArray(body?.articles) ? body.articles : [];
  return rows.flatMap((row) => {
    const time = parseGdeltTime(row?.seendate);
    const title = decode(String(row?.title ?? ''));
    const url = String(row?.url ?? '');
    if (!title || !url.startsWith('https://') || !Number.isFinite(time) || time > nowMs + HOUR) return [];
    const domain = String(row.domain ?? '').replace(/^www\./, '');
    return [{ title, url, source: domain || 'GDELT', tier: sourceTier(domain, 3), time, lang: 'en', region: 'world', feed: 'gdelt' }];
  });
}

export function parseGdeltTimeline(body) {
  const data = body?.timeline?.[0]?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    const t = parseGdeltTime(row?.date);
    const value = Number(row?.value);
    return Number.isFinite(t) && Number.isFinite(value) ? [{ t, value }] : [];
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gdeltCall(mode, extra, parse, timeoutMs) {
  const { value, staleError } = await cached(`gdelt:${mode}`, GDELT_TTL_MS, async () => {
    // The service asks for at most one request per five seconds.
    const wait = gdeltLastCall + GDELT_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    gdeltLastCall = Date.now();
    const params = `query=${encodeURIComponent(GDELT_QUERY)}&mode=${mode}&format=json&${extra}`;
    const text = await fetchText(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, { timeoutMs, maxBytes: 4_000_000 });
    try {
      return parse(JSON.parse(text));
    } catch {
      throw new Error(`GDELT вернул не JSON: ${text.slice(0, 60).replace(/\s+/g, ' ')}`);
    }
  }, 2 * 60 * 60_000);
  return { value, staleError };
}

async function loadGdelt(nowMs, errors) {
  const out = { asked: 3, ok: 0, articles: [], tone: [], volume: [] };
  if (Date.now() < gdeltPauseUntil) {
    errors.push({ source: 'gdelt', message: 'Пауза после ошибки (ограничение частоты запросов), повтор позже' });
    return out;
  }
  const deadline = Date.now() + 15_000;
  const steps = [
    ['artlist', 'maxrecords=75&sort=hybridrel&timespan=24h', (b) => parseGdeltArticles(b, nowMs), 'articles'],
    ['timelinetone', `timespan=${WINDOW_HOURS}h`, parseGdeltTimeline, 'tone'],
    ['timelinevolraw', `timespan=${WINDOW_HOURS}h`, parseGdeltTimeline, 'volume'],
  ];
  for (const [mode, extra, parse, key] of steps) {
    if (deadline - Date.now() < 3000) {
      errors.push({ source: `gdelt:${mode}`, message: 'Пропущено: бюджет времени исчерпан' });
      continue;
    }
    try {
      const { value, staleError } = await gdeltCall(mode, extra, parse, Math.min(8000, deadline - Date.now()));
      out[key] = value;
      out.ok += 1;
      if (staleError) errors.push({ source: `gdelt:${mode}`, message: staleError });
    } catch (error) {
      errors.push({ source: `gdelt:${mode}`, message: errorMessage(error) });
      // A refused or slow service will refuse the next calls too.
      gdeltPauseUntil = Date.now() + 120_000;
      break;
    }
  }
  return out;
}

// ---- markets ----------------------------------------------------------------------

const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

function loadMarketChart(symbol) {
  return cached(`worldchart:${symbol}`, 120_000, async () => {
    let lastError;
    for (const host of YAHOO_HOSTS) {
      try {
        const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
        return parseChart(JSON.parse(await fetchText(url, { timeoutMs: 8000, headers: { Accept: 'application/json' } })));
      } catch (error) {
        lastError = error;
        if (error.status === 404 || error.status === 400) break;
      }
    }
    throw lastError;
  }, 30 * 60_000);
}

async function loadMarkets(errors) {
  const charts = new Map();
  await pool(MARKETS, 6, async (market) => {
    try {
      const { value, staleError } = await loadMarketChart(market.symbol);
      charts.set(market.symbol, value);
      if (staleError) errors.push({ source: `yahoo:${market.symbol}`, message: staleError });
    } catch (error) {
      errors.push({ source: `yahoo:${market.symbol}`, message: errorMessage(error) });
    }
  });
  return charts;
}

export function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
}

/** Daily changes: log returns, or plain differences for yields. */
export function dailyChanges(closes, absolute = false) {
  const out = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (!(closes[i] > 0) || !(closes[i - 1] > 0)) continue;
    out.push(absolute ? closes[i] - closes[i - 1] : Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

/**
 * Move from closes[from] to the last close, as a z-score against the volatility
 * of the 60 daily changes that ended at closes[from] (the window before the move).
 */
export function moveSince(closes, from, absolute = false) {
  const last = closes.length - 1;
  const sessions = last - from;
  if (from < 0 || sessions < 1) return null;
  const sample = dailyChanges(closes.slice(0, from + 1), absolute).slice(-60);
  if (sample.length < 30) return null;
  const sigma = stdev(sample);
  if (!(sigma > 0)) return null;
  const move = absolute ? closes[last] - closes[from] : Math.log(closes[last] / closes[from]);
  return {
    sessions,
    z: move / (sigma * Math.sqrt(sessions)),
    change: absolute ? closes[last] - closes[from] : closes[last] / closes[from] - 1,
  };
}

/** Index of the last close strictly before the UTC day of the event. */
export function referenceIndex(times, eventMs) {
  const dayStart = Math.floor(eventMs / 86400_000) * 86400_000;
  let found = -1;
  for (let i = 0; i < times.length; i += 1) if (times[i] < dayStart) found = i;
  return found;
}

function marketRows(charts, nowMs) {
  return MARKETS.flatMap((market) => {
    const chart = charts.get(market.symbol);
    const bars = chart?.history ?? [];
    if (bars.length < 8) return [];
    const closes = bars.map((b) => b.c);
    const n = closes.length;
    const absolute = market.kind === 'yield';
    const day = moveSince(closes, n - 2, absolute);
    const week = n > 6 ? moveSince(closes, n - 6, absolute) : null;
    const asOf = Number.isFinite(chart.meta?.regularMarketTime) ? chart.meta.regularMarketTime * 1000 : bars[n - 1].t;
    const round = (v, d) => (v === null || v === undefined ? null : Number(v.toFixed(d)));
    return [{
      symbol: market.symbol,
      name: market.name,
      kind: market.kind,
      price: round(closes[n - 1], absolute ? 3 : 4),
      change1d: round(day ? day.change * 100 : null, absolute ? 1 : 2),
      change5d: round(week ? week.change * 100 : null, absolute ? 1 : 2),
      z1d: round(day?.z ?? null, 2),
      unit: absolute ? 'bp' : 'pct',
      asOf,
      stale: nowMs - asOf > 4 * 86400_000,
    }];
  });
}

// ---- clustering --------------------------------------------------------------------

const STOP = new Set(
  'the an and or of to in on for at by with from as is are was were be been its this that these those after over amid into says say said new will has have had not than more most about out off ahead why how what who where when their his her they she you our'.split(' '),
);

const STEMS = { israeli: 'israel', chinese: 'china', russian: 'russia', ukrainian: 'ukraine', iranian: 'iran', german: 'germany', french: 'france', british: 'britain', japanese: 'japan', american: 'america', palestinian: 'palestine', indian: 'india' };
const stem = (word) => STEMS[word] ?? (word.length > 4 && /^\p{Script=Latin}+$/u.test(word) ? word.replace(/(?:ing|ed|es|s|e)$/, '') : word);

/** Content-word stems plus adjacent pairs of them. Han text uses character pairs. */
export function shingles(title) {
  const text = String(title).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  const tokens = [];
  for (const word of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word].filter((c) => /\p{Script=Han}/u.test(c));
      for (let i = 0; i < chars.length - 1; i += 1) tokens.push(chars[i] + chars[i + 1]);
      continue;
    }
    if (STOP.has(word) || (/^\p{Script=Latin}+$/u.test(word) && word.length < 3)) continue;
    tokens.push(stem(word));
  }
  const set = new Set(tokens);
  for (let i = 0; i < tokens.length - 1; i += 1) set.add(`${tokens[i]} ${tokens[i + 1]}`);
  return set;
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Greedy single-link clustering of headlines: an item joins the cluster of its
 * most similar earlier member when Jaccard >= threshold and at least three
 * shingles are shared. Newest items are placed first.
 */
export function clusterItems(items, threshold = CLUSTER_THRESHOLD) {
  const entries = items
    .map((item) => ({ item, set: shingles(item.title) }))
    .filter((entry) => entry.set.size > 0)
    .sort((a, b) => b.item.time - a.item.time);
  const clusters = [];
  const index = new Map();
  for (const entry of entries) {
    const shared = new Map();
    for (const sh of entry.set) for (const member of index.get(sh) ?? []) shared.set(member, (shared.get(member) ?? 0) + 1);
    let best = null;
    let bestScore = 0;
    for (const [member, count] of shared) {
      if (count < 3) continue;
      const score = jaccard(entry.set, member.set);
      if (score >= threshold && score > bestScore) {
        best = member;
        bestScore = score;
      }
    }
    entry.cluster = best ? best.cluster : clusters.push([]) - 1;
    clusters[entry.cluster].push(entry.item);
    for (const sh of entry.set) {
      if (!index.has(sh)) index.set(sh, []);
      index.get(sh).push(entry);
    }
  }
  return clusters;
}

// ---- significance ------------------------------------------------------------------

/**
 * Significance 0..100 and its parts (each 0..1):
 *   src  = 1 - exp(-n/3), n independent sources (diminishing returns; copies of one headline count 1/4)
 *   tier = mean credibility weight of the three best sources
 *   rec  = exp(-(age/24h)^2 / 2), Gaussian kernel on the newest report
 *   tone = min(1, |headline tone| / 0.5)
 *   type = prior of the event type
 *   mkt  = tanh(max |z| / 2.5) of observed market moves; 0 when none is available
 */
/** Outlets that carry the very same headline are syndicated copies: the first counts 1, each further one 1/4 (at most three). */
export function effectiveSources(members) {
  const groups = new Map();
  for (const m of members) {
    const key = [...shingles(m.title)].sort().join('|');
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(m.source.toLowerCase());
  }
  let total = 0;
  for (const outlets of groups.values()) total += 1 + 0.25 * Math.min(3, outlets.size - 1);
  return total;
}

export function significance({ sources, effective = sources.length, ageHours, tone, prior, zAbs }) {
  const best = sources.map((tier) => TIER_WEIGHT[tier] ?? TIER_WEIGHT[4]).sort((a, b) => b - a).slice(0, 3);
  const parts = {
    src: 1 - Math.exp(-effective / 3),
    tier: best.length ? best.reduce((a, b) => a + b, 0) / best.length : 0,
    rec: Math.exp(-0.5 * (Math.max(0, ageHours) / REC_SIGMA_HOURS) ** 2),
    tone: Math.min(1, Math.abs(tone) / 0.5),
    type: prior,
    mkt: zAbs === null || zAbs === undefined ? 0 : Math.tanh(zAbs / 2.5),
  };
  const score = 100 * Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + weight * parts[key], 0);
  return { score, parts };
}

// ---- impacts ------------------------------------------------------------------------

const TYPE_ASSETS = {
  conflict: ['CL=F', 'GC=F', '^VIX'],
  sanctions: ['^GSPC', 'CNY=X', 'GC=F'],
  central_bank: ['^TNX', '^GSPC', 'EURUSD=X'],
  energy: ['CL=F', '^STOXX50E', 'EURUSD=X'],
  economy: ['^GSPC', '^VIX', '^TNX'],
  disaster: ['^VIX'],
  elections: [],
  other: [],
};

const COUNTRY_MATCH = [
  ['IL', /\b(?:Israel|Israeli|Tel Aviv|Jerusalem|Netanyahu)\b|ישראל/],
  ['CN', /\b(?:China|Chinese|Beijing|Hong Kong|Shanghai|Shenzhen)\b|中国|香港/],
  ['TW', /\b(?:Taiwan|Taipei)\b|台湾/],
  ['KR', /\b(?:South Korea|Korean|Seoul)\b|한국/],
  ['JP', /\b(?:Japan|Japanese|Tokyo)\b/],
  ['DE', /\b(?:Germany|German|Berlin)\b/],
  ['FR', /\b(?:France|French|Paris)\b/],
  ['GB', /\b(?:Britain|British|UK|London)\b/],
  ['NL', /\b(?:Netherlands|Dutch)\b/],
  ['CH', /\b(?:Switzerland|Swiss)\b/],
  ['DK', /\b(?:Denmark|Danish)\b/],
];

const SECTORS = [
  [/\b(?:chips?|semiconductors?|chipmakers?)\b/i, 'сектор: полупроводники', ['NVDA', 'AMD', 'INTC', 'ASML.AS', '2330.TW', '005930.KS', '000660.KS', '0981.HK']],
  [/\b(?:oil|crude|opec\+?|brent|refiner\w*)\b/i, 'сектор: нефть и газ', ['XOM', 'TTE.PA']],
  [/\b(?:banks?|lenders?|banking)\b/i, 'сектор: банки', ['JPM', 'BAC', 'GS', 'DBK.DE', 'LUMI.TA', 'POLI.TA']],
  [/\b(?:airlines?|aircraft|aviation|jets?)\b/i, 'сектор: авиапром', ['BA', 'AIR.PA']],
  [/\b(?:carmakers?|automakers?|electric vehicles?|EVs?)\b/i, 'сектор: автопром', ['TSLA', '1211.HK', 'VOW3.DE', 'BMW.DE', 'MBG.DE', '7203.T']],
];

function relatedCompanies(titles, text, typeId) {
  const out = new Map();
  const add = (company, basis) => {
    if (!out.has(company.symbol)) out.set(company.symbol, { symbol: company.symbol, name: company.name, country: company.country, basis });
  };
  for (const company of companies) if (titles.some((title) => mentionIndex(title, company) >= 0)) add(company, 'упомянута в заголовках');
  if (typeId === 'conflict' && /\b(?:Israel|Israeli|IDF|Gaza|Hezbollah|Hamas|Lebanon|Iran|Houthis?)\b/.test(text)) {
    const elbit = companies.find((c) => c.symbol === 'ESLT.TA');
    if (elbit) add(elbit, 'сектор: оборона');
  }
  for (const [country, re] of COUNTRY_MATCH) {
    if (!re.test(text)) continue;
    for (const company of companies.filter((c) => c.country === country).slice(0, 4)) add(company, `страна: ${country}`);
  }
  for (const [re, basis, symbols] of SECTORS) {
    if (!re.test(text)) continue;
    for (const symbol of symbols) {
      const company = companies.find((c) => c.symbol === symbol);
      if (company) add(company, basis);
    }
  }
  if (typeId === 'energy' && !out.size) for (const symbol of ['XOM', 'TTE.PA']) add(companies.find((c) => c.symbol === symbol), 'сектор: нефть и газ');
  return [...out.values()].slice(0, 8);
}

function assetsFor(typeId, regions) {
  const symbols = [];
  for (const region of regions.slice(0, 2)) {
    for (const market of MARKETS) if (market.regions.includes(region)) symbols.push(market.symbol);
  }
  symbols.push(...(TYPE_ASSETS[typeId] ?? []));
  return [...new Set(symbols)].slice(0, 5);
}

function observe(symbol, charts, eventMs) {
  const market = MARKET_BY_SYMBOL.get(symbol);
  const bars = charts.get(symbol)?.history;
  if (!market || !bars || bars.length < 40) return { symbol, name: market?.name ?? symbol, observed: null, reason: 'нет данных' };
  const from = referenceIndex(bars.map((b) => b.t), eventMs);
  const closes = bars.map((b) => b.c);
  const absolute = market.kind === 'yield';
  const move = moveSince(closes, from, absolute);
  if (!move) return { symbol, name: market.name, observed: null, reason: from < 0 || from >= closes.length - 1 ? 'нет торговых сессий после события' : 'недостаточно истории' };
  return {
    symbol,
    name: market.name,
    kind: market.kind,
    observed: {
      from: bars[from].t,
      sessions: move.sessions,
      change: Number((move.change * 100).toFixed(absolute ? 1 : 2)),
      unit: absolute ? 'bp' : 'pct',
      z: Number(move.z.toFixed(2)),
    },
  };
}

// ---- assembly ----------------------------------------------------------------------

function hashId(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `w${h.toString(36)}`;
}

function binSeries(points, start, count, binMs, reduce) {
  const bins = Array.from({ length: count }, () => []);
  for (const point of points) {
    const i = Math.floor((point.t - start) / binMs);
    if (i >= 0 && i < count) bins[i].push(point.value);
  }
  return bins.map((values) => (values.length ? reduce(values) : null));
}

function buildTimelines(items, gdelt, nowMs) {
  const binMs = BIN_HOURS * HOUR;
  const count = (WINDOW_HOURS / BIN_HOURS) | 0;
  const start = Math.floor(nowMs / binMs) * binMs - (count - 1) * binMs;
  const grid = (values) => values.map((value, i) => ({ t: start + i * binMs, value }));
  const volume = binSeries(items.map((i) => ({ t: i.time, value: 1 })), start, count, binMs, (v) => v.length);
  const tone = binSeries(items.map((i) => ({ t: i.time, value: headlineTone(i.title) })), start, count, binMs, (v) =>
    v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length : null,
  );
  const feeds = { source: 'feeds', volume: grid(volume.map((v) => v ?? 0)), tone: grid(tone) };
  let gd = null;
  if (gdelt.tone.length > 1 || gdelt.volume.length > 1) {
    gd = {
      source: 'gdelt',
      volume: gdelt.volume.length ? grid(binSeries(gdelt.volume, start, count, binMs, (v) => v.reduce((a, b) => a + b, 0)).map((v) => v ?? 0)) : null,
      tone: gdelt.tone.length ? grid(binSeries(gdelt.tone, start, count, binMs, (v) => v.reduce((a, b) => a + b, 0) / v.length)) : null,
    };
  }
  return { binHours: BIN_HOURS, feeds, gdelt: gd };
}

const round = (value, digits = 1) => Number(value.toFixed(digits));

/** Pure assembly step: items + market charts in, the payload out. */
export function assembleWorld({ items, charts, gdelt, feedStatus, nowMs, errors }) {
  const seen = new Set();
  const unique = items.filter((item) => {
    if (nowMs - item.time > WINDOW_HOURS * HOUR) return false;
    const key = canonicalUrl(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const clusters = clusterItems(unique).map((members) => {
    const titles = members.map((m) => m.title);
    const text = titles.join(' \n ');
    const sourceTiers = new Map();
    for (const m of members) {
      const key = m.source.toLowerCase();
      sourceTiers.set(key, Math.min(sourceTiers.get(key) ?? 9, m.tier));
    }
    const cls = classifyTexts(titles);
    const regions = detectRegions(titles, members.map((m) => m.region));
    const tone = titles.reduce((sum, title) => sum + headlineTone(title), 0) / titles.length;
    const firstMs = Math.min(...members.map((m) => m.time));
    const lastMs = Math.max(...members.map((m) => m.time));
    const assets = assetsFor(cls.id, regions).map((symbol) => observe(symbol, charts, firstMs));
    const zAbs = assets.reduce((max, a) => (a.observed ? Math.max(max ?? 0, Math.abs(a.observed.z)) : max), null);
    const { score, parts } = significance({
      sources: [...sourceTiers.values()],
      effective: Math.min(effectiveSources(members), sourceTiers.size),
      ageHours: (nowMs - lastMs) / HOUR,
      tone,
      prior: cls.prior,
      zAbs,
    });
    // Representative headline: the most credible source, then the newest; English first.
    const lead = [...members].sort((a, b) => (a.lang === 'en' ? 0 : 1) - (b.lang === 'en' ? 0 : 1) || a.tier - b.tier || b.time - a.time)[0];
    const sources = [...new Map([...members].sort((a, b) => a.tier - b.tier || b.time - a.time).map((m) => [m.source.toLowerCase(), m])).values()];
    return {
      id: hashId(`${lead.title}|${firstMs}`),
      title: lead.title,
      url: lead.url,
      lang: lead.lang,
      type: cls.id,
      typeLabel: cls.label,
      regions,
      primaryRegion: regions[0],
      tone: round(tone, 2),
      score: round(score, 1),
      parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v, 3)])),
      contrib: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(100 * WEIGHTS[k] * v, 1)])),
      articles: members.length,
      sourceCount: sourceTiers.size,
      independent: round(Math.min(effectiveSources(members), sourceTiers.size), 2),
      firstAt: firstMs,
      lastAt: lastMs,
      sources: sources.slice(0, 6).map((m) => ({ name: m.source, tier: m.tier, url: m.url, time: m.time, title: m.title })),
      assets,
      companies: relatedCompanies(titles, text, cls.id),
    };
  });

  clusters.sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
  const top = clusters.slice(0, 10);
  const ranked = clusters.slice(0, 40);

  const regionStats = new Map();
  for (const event of ranked) {
    const row = regionStats.get(event.primaryRegion) ?? { id: event.primaryRegion, events: 0, articles: 0, toneSum: 0, significance: 0 };
    row.events += 1;
    row.articles += event.articles;
    row.toneSum += event.tone * event.articles;
    row.significance += event.score;
    regionStats.set(event.primaryRegion, row);
  }
  const regions = [...regionStats.values()]
    .map((r) => ({
      id: r.id,
      label: REGION_LABELS[r.id] ?? r.id,
      events: r.events,
      articles: r.articles,
      tone: round(r.toneSum / r.articles, 2),
      significance: round(r.significance, 1),
    }))
    .sort((a, b) => b.significance - a.significance);

  const markets = marketRows(charts, nowMs);
  const feedsAsked = feedStatus.length;
  const feedsOk = feedStatus.filter((f) => f.items !== null).length;
  return {
    updatedAt: nowMs,
    windowHours: WINDOW_HOURS,
    weights: WEIGHTS,
    recSigmaHours: REC_SIGMA_HOURS,
    events: top,
    more: clusters.slice(10, 26).map((e) => ({
      id: e.id, title: e.title, url: e.url, score: e.score, sourceCount: e.sourceCount, type: e.type, typeLabel: e.typeLabel,
      primaryRegion: e.primaryRegion, lastAt: e.lastAt,
    })),
    regions,
    markets,
    timeline: buildTimelines(unique, gdelt, nowMs),
    coverage: {
      feeds: { asked: feedsAsked, ok: feedsOk, items: unique.filter((i) => i.feed !== 'gdelt').length },
      gdelt: { asked: gdelt.asked, ok: gdelt.ok, articles: gdelt.articles.length },
      markets: { asked: MARKETS.length, ok: markets.length },
      clusters: clusters.length,
      failed: feedStatus.filter((f) => f.items === null).map((f) => f.name),
    },
    errors,
  };
}

const EMPTY_GDELT = { asked: 3, ok: 0, articles: [], tone: [], volume: [] };

/** GDELT is slow and often throttled: never let it hold the whole page back. */
function cappedGdelt(nowMs, errors) {
  let finished = false;
  const work = loadGdelt(nowMs, errors).finally(() => { finished = true; });
  const timer = sleep(16_000).then(() => {
    if (finished) return EMPTY_GDELT;
    errors.push({ source: 'gdelt', message: 'Не уложился в бюджет времени' });
    return EMPTY_GDELT;
  });
  return Promise.race([work, timer]);
}

export async function buildWorld(nowMs = Date.now()) {
  const { value } = await cached('world:v1', WORLD_TTL_MS, async () => {
    const errors = [];
    const [feeds, gdelt, charts] = await Promise.all([
      loadFeeds(nowMs, errors),
      cappedGdelt(nowMs, errors),
      loadMarkets(errors),
    ]);
    return assembleWorld({ items: [...feeds.items, ...gdelt.articles], charts, gdelt, feedStatus: feeds.status, nowMs, errors });
  }, 15 * 60_000);
  return value;
}

