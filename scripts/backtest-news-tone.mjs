// Out-of-sample check of headline tone and of the reputation half-lives on real history.
// Headlines: Google News RSS (no key), one query per company and month with after:/before:.
// Prices: the Yahoo bars already saved by scripts/backtest-fetch.mjs (docs/handoff/backtest-data/).
// Classification, de-duplication and evidence weights are the dossier's own functions.
// Headlines are cached outside the repository. A report, not a gate; method and caveats:
// docs/math/backtest-news.md.
// Run: node scripts/backtest-news-tone.mjs [--cache DIR] [--out results.json] [--fetch-only | --offline]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEvent, dedupeEvents } from '../api/_dossier/analyze.js';
import companies from '../api/_dossier/companies.js';
import { isShoppingNoise } from '../api/_dossier/events.js';
import { mentionIndex, parseRss } from '../api/_dossier/news.js';
import { alignedReturns, evidenceWeight, HALF_LIFE_DAYS, PRIOR_WEIGHT } from '../api/_dossier/quant.js';
import { ranks, seededRandom } from '../api/_dossier/math/stats.js';

const DAY = 86_400_000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRICES = join(ROOT, 'docs', 'handoff', 'backtest-data');
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const CACHE = option('--cache', join(tmpdir(), 'bansho-gnews'));
const OUT = option('--out', join(CACHE, 'results.json'));
mkdirSync(CACHE, { recursive: true });

// US listings with an unambiguous English name; one benchmark (S&P 500).
const SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'JPM', 'BAC', 'GS',
  'BA', 'INTC', 'AMD', 'NFLX', 'DIS', 'WMT', 'KO', 'PFE', 'XOM'];
const FIRST_MONTH = Date.UTC(2024, 3, 1);
const END = Date.UTC(2026, 10, 1); // headlines before this date
const PANEL_START = Date.UTC(2024, 6, 1); // after a 90 day warm-up
const MAX_AGE = 90;
const HORIZONS = [1, 5, 20];
const REPS = 500;
const log = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Headlines
// ---------------------------------------------------------------------------

const months = [];
for (let t = FIRST_MONTH; t < END;) {
  const d = new Date(t);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  months.push([new Date(t).toISOString().slice(0, 10), new Date(next).toISOString().slice(0, 10)]);
  t = next;
}

async function download(company, [from, to], file) {
  const query = `"${company.name === 'JPMorgan Chase' ? 'JPMorgan' : company.name === 'Meta Platforms' ? 'Meta' : company.name}" after:${from} before:${to}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = parseRss(await response.text(), 'en')
        .filter((i) => i.time >= Date.parse(from) - DAY && i.time < Date.parse(to) + DAY)
        .map(({ title, source, time }) => ({ title, source, time }));
      writeFileSync(file, JSON.stringify(items));
      return true;
    } catch (error) {
      log(`  ${company.symbol} ${from}: ${error.message}`);
      await sleep(8000 * (attempt + 1));
    }
  }
  return false;
}

async function fetchAll() {
  const jobs = [];
  for (const symbol of SYMBOLS) {
    const company = companies.find((c) => c.symbol === symbol);
    for (const month of months) {
      const file = join(CACHE, `${symbol}-${month[0].slice(0, 7)}.json`);
      if (!existsSync(file)) jobs.push([company, month, file]);
    }
  }
  log(`headline queries to download: ${jobs.length}`);
  let failed = 0;
  let done = 0;
  const worker = async () => {
    while (jobs.length && failed < 15) {
      if (!(await download(...jobs.shift()))) failed += 1;
      done += 1;
      if (done % 100 === 0) log(`  ${done} done`);
      await sleep(600);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (failed) log(`failed queries: ${failed}`);
}

function loadCompany(symbol) {
  const company = companies.find((c) => c.symbol === symbol);
  const raw = [];
  let queries = 0;
  for (const [from] of months) {
    const file = join(CACHE, `${symbol}-${from.slice(0, 7)}.json`);
    if (!existsSync(file)) continue;
    queries += 1;
    raw.push(...JSON.parse(readFileSync(file, 'utf8')));
  }
  const events = raw
    .filter((i) => i.time < END && mentionIndex(i.title, company) >= 0)
    .map((i) => {
      const found = classifyEvent({ title: i.title, lang: 'en', company });
      return { ...i, type: found.type, sentiment: found.sentiment };
    })
    .filter((e) => !isShoppingNoise(e));
  const unique = dedupeEvents(events).sort((a, b) => a.time - b.time);
  for (const e of unique) e.base = evidenceWeight(e, 0);
  return { symbol, queries, raw: raw.length, events: unique };
}

// ---------------------------------------------------------------------------
// Prices and panel
// ---------------------------------------------------------------------------

/** Saved bars where the repository has them, otherwise the same Yahoo chart request, cached. */
async function bars(symbol) {
  const saved = join(PRICES, `px-${symbol}.json.gz`);
  if (existsSync(saved)) {
    const body = JSON.parse(gunzipSync(readFileSync(saved)));
    return body.t.map((t, i) => ({ t: t * 1000, c: body.c[i], v: body.v[i] }));
  }
  const file = join(CACHE, `px-${symbol}.json`);
  if (!existsSync(file)) {
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5y&interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${symbol}: Yahoo HTTP ${response.status}`);
    const chart = (await response.json()).chart.result[0];
    const { close, volume } = chart.indicators.quote[0];
    writeFileSync(file, JSON.stringify(chart.timestamp
      .map((t, i) => ({ t: t * 1000, c: close[i], v: volume[i] }))
      .filter((b) => b.c > 0)));
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Half-life in days for an event of a given type under a variant. */
const VARIANTS = [
  ['code', (type) => HALF_LIFE_DAYS[type]],
  ...[0.1, 0.25, 0.5, 2].map((k) => [`code x${k}`, (type) => HALF_LIFE_DAYS[type] * k]),
  ...[1, 3, 7, 14, 30].map((h) => [`all ${h}d`, () => h]),
  ['no decay', () => Number.POSITIVE_INFINITY],
];
const TYPE_GRID = [1, 3, 7, 10, 14, 21, 30, 45, 90];

/** The reputation signal (score - 50) / 50 from headlines published strictly before `cutoff`. */
function tone(events, cutoff, halfLife) {
  let sum = 0;
  let total = PRIOR_WEIGHT;
  let n = 0;
  for (const e of events) {
    if (e.time >= cutoff) break;
    const age = (cutoff - e.time) / DAY;
    if (age > MAX_AGE) continue;
    const w = e.base * 0.5 ** (age / halfLife(e.type));
    sum += w * e.sentiment;
    total += w;
    n += 1;
  }
  return n ? sum / total : null;
}

// Headlines that retell the price move itself; dropped in a sensitivity check of the tone effect.
const PRICE_TALK = /\b(stocks?|shares?|price|market cap|nasdaq|dow|s&p|rall(?:y|ies|ied)|surg\w*|soar\w*|plung\w*|jump\w*|tumbl\w*|slid\w*|sink\w*|sank|fell|falls?|rose|ris(?:es?|ing)|gain\w*|drop\w*)\b/i;

function panelFor(data, history, bench) {
  const rows = alignedReturns(history, bench, Date.UTC(2026, 10, 28));
  const excess = rows.map((r) => (Number.isFinite(r.s) && Number.isFinite(r.m) ? r.s - r.m : null));
  const total = (from, to) => {
    if (from < 0 || to >= rows.length) return null;
    let s = 0;
    for (let i = from; i <= to; i += 1) {
      if (excess[i] === null) return null;
      s += excess[i];
    }
    return s;
  };
  const types = Object.keys(HALF_LIFE_DAYS);
  const byType = Object.fromEntries(types.map((t) => [t, data.events.filter((e) => e.type === t)]));
  const out = [];
  rows.forEach((row, i) => {
    // The signal may use headlines dated before the session day only: feed times are often date-only.
    const cutoff = row.day * DAY;
    if (cutoff < PANEL_START || cutoff >= END) return;
    const previousCutoff = (rows[i - 1]?.day ?? row.day - 1) * DAY;
    const fresh = data.events.filter((e) => e.time >= previousCutoff && e.time < cutoff);
    const toned = (list) => (list.length ? list.reduce((s, e) => s + e.sentiment, 0) / list.length : null);
    out.push({
      day: row.day,
      past: total(i - 4, i),
      same: total(i - 1, i),
      y: Object.fromEntries(HORIZONS.map((h) => [h, total(i + 1, i + h)])),
      x: Object.fromEntries(VARIANTS.map(([name, hl]) => [name, tone(data.events, cutoff, hl)])),
      byType: Object.fromEntries(types.map((t) => [t, Object.fromEntries(
        TYPE_GRID.map((h) => [h, tone(byType[t], cutoff, () => h)]),
      )])),
      dayTone: toned(fresh),
      quietTone: toned(fresh.filter((e) => !PRICE_TALK.test(e.title))),
      typeTone: Object.fromEntries(types.map((t) => [t, toned(fresh.filter((e) => e.type === t))])),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function pearson(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; }
  ma /= n;
  mb /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i += 1) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : null;
}

/** Mean over companies of the within-company rank correlation; ranks are fixed before resampling. */
function prepare(panels, getX, getY, keep) {
  return panels.map((rows) => {
    const used = rows.filter((r) => keep(r) && Number.isFinite(getX(r)) && Number.isFinite(getY(r)));
    if (used.length < 40) return null;
    return { days: used.map((r) => r.day), x: ranks(used.map(getX)), y: ranks(used.map(getY)) };
  }).filter(Boolean);
}

function meanRho(prepared, weights) {
  const values = [];
  for (const p of prepared) {
    let { x, y } = p;
    if (weights) {
      x = [];
      y = [];
      p.days.forEach((d, i) => {
        for (let k = weights.get(Math.floor(d / 30)) ?? 0; k > 0; k -= 1) { x.push(p.x[i]); y.push(p.y[i]); }
      });
    }
    const r = x.length >= 20 ? pearson(x, y) : null;
    if (r !== null) values.push(r);
  }
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

/** 30 day calendar blocks, resampled jointly for all companies. */
function blockWeights(panels, keep, seed) {
  const blocks = [...new Set(panels.flat().filter(keep).map((r) => Math.floor(r.day / 30)))].sort((a, b) => a - b);
  const random = seededRandom(seed);
  return Array.from({ length: REPS }, () => {
    const w = new Map();
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[Math.floor(random() * blocks.length)];
      w.set(b, (w.get(b) ?? 0) + 1);
    }
    return w;
  });
}

function interval(samples) {
  const s = samples.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length < REPS / 2) return { lo: null, hi: null, p: null };
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const below = s.filter((v) => v <= 0).length;
  // Two-sided percentile bootstrap p-value, floored by the number of repetitions.
  return { lo: at(0.025), hi: at(0.975), p: Math.min(1, (2 * (Math.min(below, s.length - below) + 1)) / (s.length + 1)) };
}

/** Benjamini-Hochberg q-values, written into each item as `q`. */
function adjust(items) {
  const sorted = items.filter((i) => Number.isFinite(i.p)).sort((a, b) => a.p - b.p);
  let q = 1;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    q = Math.min(q, (sorted[i].p * sorted.length) / (i + 1));
    sorted[i].q = q;
  }
}

const r4 = (v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : null);
const tidy = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r4(v) : v]));

function rhoTest(panels, getX, getY, keep, weights) {
  const prepared = prepare(panels, getX, getY, keep);
  if (prepared.length < 5) return { rho: null, companies: prepared.length };
  return {
    rho: meanRho(prepared),
    ...interval(weights.map((w) => meanRho(prepared, w))),
    companies: prepared.length,
    n: prepared.reduce((s, p) => s + p.x.length, 0),
  };
}

/** rho(a) - rho(b) on the same company-days and the same bootstrap samples. */
function rhoDiff(panels, getA, getB, getY, keep, weights) {
  const both = (r) => keep(r) && Number.isFinite(getA(r)) && Number.isFinite(getB(r));
  const a = prepare(panels, getA, getY, both);
  const b = prepare(panels, getB, getY, both);
  if (a.length < 5) return null;
  return { diff: meanRho(a) - meanRho(b), ...interval(weights.map((w) => meanRho(a, w) - meanRho(b, w))) };
}

/** Mean excess return after positive-tone days minus after negative-tone days, in basis points. */
function toneSpread(panels, getTone, getY, keep, weights) {
  const rows = panels.flat().filter((r) => keep(r) && Number.isFinite(getY(r)) && getTone(r) !== null && getTone(r) !== 0);
  const spread = (w) => {
    const sum = [0, 0];
    const count = [0, 0];
    for (const r of rows) {
      const k = w ? w.get(Math.floor(r.day / 30)) ?? 0 : 1;
      const side = getTone(r) > 0 ? 0 : 1;
      sum[side] += k * getY(r);
      count[side] += k;
    }
    return count[0] && count[1] ? 1e4 * (sum[0] / count[0] - sum[1] / count[1]) : null;
  };
  const positive = rows.filter((r) => getTone(r) > 0).length;
  const negative = rows.length - positive;
  if (positive < 30 || negative < 30) return { positive, negative, bp: null };
  return { positive, negative, bp: spread(), ...interval(weights.map(spread)) };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (!argv.includes('--offline')) await fetchAll();
if (argv.includes('--fetch-only')) process.exit(0);

const bench = await bars('_GSPC');
const data = SYMBOLS.map(loadCompany);
const panels = [];
for (const d of data) panels.push(panelFor(d, await bars(d.symbol), bench));
const events = data.flatMap((d) => d.events);
const days = [...new Set(panels.flat().map((r) => r.day))].sort((a, b) => a - b);
const splitAt = Math.floor(days.length * 0.6);
const split = days[splitAt];
const all = () => true;
const test = (r) => r.day >= split;
// Training targets must end before the test period starts.
const trainFor = (h) => (r) => r.day < days[splitAt - h];

const result = {
  data: {
    companies: SYMBOLS.length,
    queries: data.reduce((s, d) => s + d.queries, 0),
    rawHeadlines: data.reduce((s, d) => s + d.raw, 0),
    uniqueEvents: events.length,
    eventsPerCompany: Object.fromEntries(data.map((d) => [d.symbol, d.events.length])),
    byType: Object.fromEntries(Object.keys(HALF_LIFE_DAYS).map((t) => {
      const list = events.filter((e) => e.type === t);
      return [t, { n: list.length, positive: list.filter((e) => e.sentiment > 0).length, negative: list.filter((e) => e.sentiment < 0).length }];
    })),
    companyDays: panels.flat().length,
    from: new Date(days[0] * DAY).toISOString().slice(0, 10),
    to: new Date(days.at(-1) * DAY).toISOString().slice(0, 10),
    testFrom: new Date(split * DAY).toISOString().slice(0, 10),
  },
};

const wAll = blockWeights(panels, all, 1);
const wTest = blockWeights(panels, test, 2);

// 1. Tone effect: same sessions (descriptive) against later sessions (predictive).
result.toneSpread = [];
for (const [period, keep, w] of [['all', all, wAll], ['test', test, wTest]]) {
  for (const [target, get] of [['same 2 sessions', (r) => r.same], ...HORIZONS.map((h) => [`next ${h}`, (r) => r.y[h]])]) {
    result.toneSpread.push({ period, target, ...toneSpread(panels, (r) => r.dayTone, get, keep, w) });
    result.toneSpread.push({ period, target: `${target}, no price talk`, ...toneSpread(panels, (r) => r.quietTone, get, keep, w) });
  }
}
result.toneSpreadByType = Object.keys(HALF_LIFE_DAYS).flatMap((type) => [1, 5].map((h) => (
  { type, h, ...toneSpread(panels, (r) => r.typeTone[type], (r) => r.y[h], all, wAll) })));
adjust(result.toneSpreadByType);

// 2. Reputation signal under each half-life variant.
result.variants = [];
for (const [name] of VARIANTS) {
  const get = (r) => r.x[name];
  result.variants.push({ name, target: 'past 5', period: 'all', ...rhoTest(panels, get, (r) => r.past, all, wAll) });
  for (const h of HORIZONS) {
    const y = (r) => r.y[h];
    result.variants.push({ name, target: `next ${h}`, period: 'train', ...rhoTest(panels, get, y, trainFor(h), wAll) });
    result.variants.push({ name, target: `next ${h}`, period: 'test', ...rhoTest(panels, get, y, test, wTest) });
  }
}
adjust(result.variants.filter((v) => v.period === 'test'));

// 3. Walk-forward: choose on train, judge on test against the constants in the code.
result.walkForward = HORIZONS.map((h) => {
  const best = result.variants
    .filter((v) => v.period === 'train' && v.target === `next ${h}`)
    .sort((a, b) => b.rho - a.rho)[0];
  const y = (r) => r.y[h];
  return {
    h,
    chosen: best.name,
    trainRho: best.rho,
    testRho: result.variants.find((v) => v.name === best.name && v.period === 'test' && v.target === `next ${h}`).rho,
    codeTestRho: result.variants.find((v) => v.name === 'code' && v.period === 'test' && v.target === `next ${h}`).rho,
    versusCode: best.name === 'code' ? null : rhoDiff(panels, (r) => r.x[best.name], (r) => r.x.code, y, test, wTest),
  };
});

// 4. The same walk-forward for the half-life of each type on its own.
result.typeWalkForward = [];
for (const type of Object.keys(HALF_LIFE_DAYS)) {
  for (const h of [5, 20]) {
    const y = (r) => r.y[h];
    const scored = TYPE_GRID
      .map((H) => ({ H, rho: meanRho(prepare(panels, (r) => r.byType[type][H], y, trainFor(h))) }))
      .filter((s) => s.rho !== null)
      .sort((a, b) => b.rho - a.rho);
    if (!scored.length) continue;
    const chosen = scored[0].H;
    const code = HALF_LIFE_DAYS[type];
    const own = rhoTest(panels, (r) => r.byType[type][chosen], y, test, wTest);
    result.typeWalkForward.push({
      type, h, code, chosen, trainRho: scored[0].rho, testRho: own.rho, testLo: own.lo, testHi: own.hi, p: own.p, companies: own.companies,
      codeTestRho: meanRho(prepare(panels, (r) => r.byType[type][code], y, test)),
      versusCode: chosen === code ? null : rhoDiff(panels, (r) => r.byType[type][chosen], (r) => r.byType[type][code], y, test, wTest),
    });
  }
}
// The family is the comparisons with the half-life in the code.
adjust(result.typeWalkForward.map((row) => row.versusCode).filter(Boolean));

const clean = JSON.parse(JSON.stringify(result, (_key, value) => (typeof value === 'number' ? r4(value) : value)));
writeFileSync(OUT, JSON.stringify(clean, null, 1));
log(JSON.stringify(clean.data));
for (const section of ['toneSpread', 'toneSpreadByType', 'variants', 'walkForward', 'typeWalkForward']) {
  log(`\n== ${section}`);
  for (const row of clean[section]) log(JSON.stringify(tidy(row)));
}
log(`\nsaved ${OUT}`);
