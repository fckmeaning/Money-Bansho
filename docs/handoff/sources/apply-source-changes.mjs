// One-off (2026-11-27): applies the goal-3 source changes to shared/*.json, mirrors and hand-kept tables.
// Run from the repo root, then `npm run generate` for the derived catalogs and `npm run sources:generate`.
import fs from 'node:fs';

const R = (p) => fs.readFileSync(p, 'utf8');
const W = (p, s) => fs.writeFileSync(p, s);
const J = (p) => JSON.parse(R(p));
const sel = J('docs/handoff/sources/selected-live.json').filter((x) => x.status === 'OK');

// ---- 1. removals (dead in added-live.json: HTTP 403 with the production fetch headers) ----
const REMOVE = ['Guardian Business', 'Guardian Economics', 'Guardian Politics', 'Guardian Executive Pay and Bonuses',
  'China Digital Times (ZH)', 'Hong Kong Free Press', 'TechNode'];

// ---- 2. additions: metadata (country, tier, provenance type, ownership, audience, language, risk note) ----
const G = (cc, who, kind = 'central bank') => ({ type: 'gov', tier: 1, cc, own: 'state', aud: 'international', lang: 'en', risk: { risk: 'low', stateAffiliated: who, note: `Official ${kind} publication` } });
const CORP = (cc) => ({ type: 'other', tier: 2, cc, own: 'private', aud: 'international', lang: 'en' });
const M = (cc, tier, o = {}) => ({ type: 'mainstream', tier, cc, own: 'private', aud: 'international', lang: 'en', ...o });
const META = {
  'UK Competition and Markets Authority': G('GB', 'United Kingdom', 'government'),
  'UK Sanctions OFSI': G('GB', 'United Kingdom', 'government'),
  'FTC Press': G('US', 'United States', 'government'),
  'CFTC Press': G('US', 'United States', 'government'),
  'SFC Hong Kong': G('HK', 'Hong Kong', 'regulator'),
  'HKMA Press': G('HK', 'Hong Kong'),
  'EBA News': { ...G('EU', 'European Union', 'regulator'), own: 'intergovernmental' },
  'ECB Banking Supervision': { ...G('EU', 'European Union'), own: 'intergovernmental' },
  'ECB Blog': { ...G('EU', 'European Union'), own: 'intergovernmental' },
  'European Parliament Press': { ...G('EU', 'European Union', 'parliament'), own: 'intergovernmental' },
  'SNB Press': G('CH', 'Switzerland'),
  'Riksbank Press': G('SE', 'Sweden'),
  'Norges Bank Press': G('NO', 'Norway'),
  'Bundesbank News': G('DE', 'Germany'),
  'Bank of England Speeches': G('GB', 'United Kingdom'),
  'Central Bank of Ireland': G('IE', 'Ireland'),
  'HKEX News Releases': { type: 'market', tier: 2, cc: 'HK', own: 'private', aud: 'international', lang: 'en' },
  'GlobeNewswire Directors': { type: 'wire', tier: 2, cc: 'US', own: 'private', aud: 'international', lang: 'en' },
  'GlobeNewswire Mergers': { type: 'wire', tier: 2, cc: 'US', own: 'private', aud: 'international', lang: 'en' },
  'Samsung Newsroom': CORP('KR'), 'SK hynix Newsroom': CORP('KR'), 'SAP News': CORP('DE'), 'BioNTech IR': CORP('DE'),
  'Baidu IR': CORP('CN'), 'JD.com IR': CORP('CN'), 'NIO IR': CORP('CN'), 'XPeng IR': CORP('CN'), 'NetEase IR': CORP('CN'),
  'Li Auto IR': CORP('CN'), 'PDD IR': CORP('CN'), 'Trip.com IR': CORP('CN'),
  'Toyota Newsroom': CORP('JP'), 'Mobileye IR': CORP('IL'), 'Tower Semiconductor IR': CORP('IL'), 'Arm Newsroom': CORP('GB'),
  'UDN Money': M('TW', 3, { aud: 'domestic', lang: 'zh' }),
  'ChinaTalk': { type: 'other', tier: 3, cc: 'US', own: 'private', aud: 'international', lang: 'en' },
  'Sinocism': { type: 'other', tier: 3, cc: 'US', own: 'private', aud: 'international', lang: 'en' },
  'NYT Chinese': M('US', 2, { lang: 'zh' }),
  'China Banking News': { type: 'other', tier: 3, cc: 'INTL', own: 'unreviewed', aud: 'international', lang: 'en', note: 'Publisher location and ownership not confirmed.' },
  'CarNewsChina': { type: 'other', tier: 3, cc: 'INTL', own: 'unreviewed', aud: 'international', lang: 'en', note: 'Publisher location and ownership not confirmed.' },
  'Asia Financial': { type: 'other', tier: 3, cc: 'INTL', own: 'unreviewed', aud: 'international', lang: 'en', note: 'Publisher location and ownership not confirmed.' },
  'TMTPost': M('CN', 3, { aud: 'domestic', lang: 'zh' }),
  'Sixth Tone RSS': { ...M('CN', 3, { own: 'state', aud: 'domestic' }), risk: { risk: 'medium', note: 'State-owned newsroom; government context, not independent corroboration.', stateAffiliated: 'China' } },
  'Euronews Business': M('FR', 2),
  'CEPR VoxEU': { type: 'other', tier: 2, cc: 'GB', own: 'nonprofit', aud: 'international', lang: 'en' },
  'El Pais Economia': M('ES', 2, { aud: 'domestic', lang: 'es' }),
  'The Local Germany': M('DE', 3),
  'Globes Israel News EN': M('IL', 2),
  'Techtime Israel': M('IL', 3),
  'Israel Hayom Hebrew': M('IL', 3, { aud: 'domestic', lang: 'he' }),
  'Israel Hayom English': M('IL', 3),
  'The Diplomat North Korea': M('US', 3),
  'NK Chosun': M('KR', 3, { aud: 'domestic', lang: 'ko' }),
};
const ADD = sel.filter((x) => x.name !== 'Global Times');
for (const x of ADD) if (!META[x.name]) {
  if (x.cats[0] !== 'corporate-leadership') throw new Error('no meta ' + x.name);
  META[x.name] = CORP('US');
}
// Dedupe against what is already in the catalog.
const catalog = J('shared/news-catalog.json');
const urlsOf = (f) => (typeof f.url === 'string' ? [f.url] : Object.values(f.url));
const haveUrl = new Set(catalog.feeds.flatMap(urlsOf));
const haveName = new Set(catalog.feeds.map((f) => f.name));
const todo = ADD.filter((x) => !haveUrl.has(x.url) && !haveName.has(x.name));

// ---- catalog ----
catalog.feeds = catalog.feeds.filter((f) => !REMOVE.includes(f.name));
const fr = catalog.feeds.find((f) => f.name === 'Franceinfo Economie');
fr.url = 'https://www.franceinfo.fr/economie.rss';
const CATS = ['china-media', 'europe-business', 'israel', 'north-korea', 'corporate-leadership'];
for (const f of catalog.feeds) { // keep per-category orders contiguous after the removals
  f.placements = f.placements.map((p) => ({ ...p }));
}
const next = {};
const counters = {};
const order = (edition, cat) => {
  const k = `${edition}/${cat}`;
  if (!(k in counters)) {
    counters[k] = 0;
    // renumber existing feeds of this bucket by their current relative order
    const feeds = catalog.feeds.filter((f) => f.placements.some((p) => p.edition === edition && p.category === cat))
      .map((f) => ({ f, p: f.placements.find((p) => p.edition === edition && p.category === cat) }))
      .sort((a, b) => (a.p.serverOrder ?? 0) - (b.p.serverOrder ?? 0));
    feeds.forEach(({ p }, i) => { p.serverOrder = i; p.browserOrder = i; });
    counters[k] = feeds.length;
  }
  return counters[k]++;
};
for (const c of CATS) { order('full', c); order('finance', c); }
for (const x of todo) {
  const m = META[x.name];
  const cat = x.cats[0];
  const entry = { name: x.name, url: x.url };
  if (m.lang !== 'en') { entry.lang = m.lang; entry.fetchInAllLanguages = true; }
  entry.placements = ['full', 'finance'].map((edition) => {
    const o = order(edition, cat);
    return { edition, category: cat, serverOrder: o, browserOrder: o };
  });
  catalog.feeds.push(entry);
}
const out = JSON.stringify(catalog, null, 2) + '\n';
// Keep the file's original line endings.
const orig = R('shared/news-catalog.json');
const eol = orig.includes('\r\n') ? '\r\n' : '\n';
const body = out.replace(/\n/g, eol);
W('shared/news-catalog.json', orig.endsWith(eol) ? body : body.slice(0, -eol.length));
W('scripts/shared/news-catalog.json', R('shared/news-catalog.json'));

// ---- name-keyed JSON tables ----
const dropAdd = (path, addFn) => {
  const o = J(path);
  for (const n of REMOVE) delete o[n];
  for (const x of todo) o[x.name] = addFn(META[x.name], x);
  const orig2 = R(path);
  const eol2 = orig2.includes('\r\n') ? '\r\n' : '\n';
  let s = JSON.stringify(o, null, 2).replace(/\n/g, eol2);
  if (orig2.endsWith(eol2)) s += eol2;
  W(path, s);
};
dropAdd('shared/source-tiers.json', (m) => m.tier);
dropAdd('shared/outlet-profile.json', (m) => {
  const p = { country: m.cc, audience: m.aud, language: m.lang, ownershipClass: m.own };
  if (m.note) p.note = m.note;
  return p;
});
W('scripts/shared/source-tiers.json', R('shared/source-tiers.json'));
W('scripts/shared/outlet-profile.json', R('shared/outlet-profile.json'));

// ---- TS literal tables: append before the closing of the named block ----
const editTs = (path, startMarker, lineFor) => {
  let s = R(path);
  for (const n of REMOVE) {
    const re = new RegExp(`^[ \\t]*(?:"${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"|'${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'):.*\\r?\\n`, 'm');
    s = s.replace(re, '');
  }
  const start = s.indexOf(startMarker);
  if (start < 0) throw new Error('marker ' + startMarker);
  const close = s.indexOf('\n};', start);
  const eol3 = s.includes('\r\n') ? '\r\n' : '\n';
  const lines = todo.map((x) => lineFor(META[x.name], x)).filter(Boolean).join(eol3);
  s = s.slice(0, close) + (s[close - 1] === '\r' ? '' : '') + (lines ? eol3 + lines : '') + s.slice(close);
  W(path, s);
};
editTs('shared/source-provenance.ts', 'export const SOURCE_TYPES', (m, x) => `  ${JSON.stringify(x.name)}: '${m.type}',`);
editTs('shared/source-provenance.ts', 'export const SOURCE_PROPAGANDA_RISK', (m, x) => (m.risk ? `  ${JSON.stringify(x.name)}: ${JSON.stringify(m.risk)},` : ''));
// source-provenance-declarations.ts is generated: run scripts/generate-source-provenance-declarations.mjs afterwards.

// ---- RSS proxy allowlist (4 mirrors; the .cjs files re-export the JSON) ----
{
  const hosts = J('shared/rss-allowed-domains.json');
  const stillUsed = new Set(catalog.feeds.flatMap(urlsOf).map((u) => new URL(u).hostname));
  const set = new Set(hosts);
  set.delete('www.francetvinfo.fr');
  for (const n of ['chinadigitaltimes.net', 'hongkongfp.com', 'technode.com']) if (!stillUsed.has(n)) set.delete(n);
  set.add('www.franceinfo.fr');
  for (const x of todo) { set.add(new URL(x.url).hostname); set.add(new URL(x.final).hostname); }
  const arr = [...set].sort();
  const json = JSON.stringify(arr, null, 2) + '\n';
  W('shared/rss-allowed-domains.json', json);
  W('scripts/shared/rss-allowed-domains.json', json);
  const js = R('api/_rss-allowed-domains.js');
  const head = js.slice(0, js.indexOf('export default ['));
  W('api/_rss-allowed-domains.js', head + 'export default ' + JSON.stringify(arr, null, 2) + ';\n');
}
console.log('removed', REMOVE.length, 'added', todo.length, 'skipped', ADD.length - todo.length);
