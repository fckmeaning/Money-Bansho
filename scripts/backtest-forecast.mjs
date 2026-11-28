// Out-of-sample check of the forecast corridor (api/_dossier/math/volmodel.js and forecast.js) on real
// prices, against the previous model and simple baselines. Yahoo daily bars with open/high/low, ten
// years, no key; they are cached outside the repository. Everything fitted uses origins before 2025;
// everything reported uses origins from 2025-01-01. A report, not a gate; method: docs/math/forecast.md.
// Run: node scripts/backtest-forecast.mjs [--cache DIR] [--news DIR] [--fit] [--write]
//   --news DIR  headline cache of scripts/backtest-news-tone.mjs (adds the headline events)
//   --fit       refit the constants on pre-2025 data and print them (about 3 minutes)
//   --write     save the held-out summary to api/_dossier/math/forecast-evidence.js
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEvent, dedupeEvents } from '../api/_dossier/analyze.js';
import companies from '../api/_dossier/companies.js';
import { isShoppingNoise } from '../api/_dossier/events.js';
import { eventScale, kernelWeight } from '../api/_dossier/math/forecast.js';
import { nelderMead } from '../api/_dossier/math/optimize.js';
import { logGamma, normalCdf, studentTCdf } from '../api/_dossier/math/special.js';
import { mean, quantile, seededRandom, stdev } from '../api/_dossier/math/stats.js';
import { ewmaVolatility, fitGarch } from '../api/_dossier/math/volatility.js';
import { distribution, MODELS, pinball, prepareSeries, stateAt, tQuantile } from '../api/_dossier/math/volmodel.js';
import { mentionIndex } from '../api/_dossier/news.js';
import { parseChart } from '../api/_dossier/yahoo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const CACHE = option('--cache', join(tmpdir(), 'bansho-forecast'));
const NEWS = option('--news', null);
const FIT = argv.includes('--fit');
const WRITE = argv.includes('--write');
mkdirSync(CACHE, { recursive: true });

const DAY = 86_400_000;
const NOW = Date.now();
const HORIZONS = [1, 5, 20];
const TRAIN_FROM = Date.UTC(2017, 0, 1);
const HOLDOUT = Date.UTC(2025, 0, 1);
const PURGE = 35 * DAY; // no training target may reach into the held-out period
const LEVELS = Array.from({ length: 20 }, (_, i) => (i + 0.5) / 20);
const out = (line = '') => process.stdout.write(`${line}\n`);
const pct = (x, d = 1) => (Number.isFinite(x) ? (100 * x).toFixed(d) : 'нет данных');

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function bars(symbol) {
  const file = join(CACHE, `${symbol.replace(/[^A-Za-z0-9.-]/g, '_')}.json`);
  if (!existsSync(file)) {
    try {
      const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json();
      if (!body?.chart?.result?.[0]?.timestamp) throw new Error(`HTTP ${response.status}`);
      writeFileSync(file, JSON.stringify(body));
      await new Promise((resolve) => setTimeout(resolve, 400));
    } catch (error) {
      out(`${symbol}: нет данных (${error.message})`);
      return null;
    }
  }
  return parseChart(JSON.parse(readFileSync(file, 'utf8'))).history;
}

const stocks = new Map();
for (const company of companies) {
  const history = await bars(company.symbol);
  const benchmark = await bars(company.benchmark);
  if (history) stocks.set(company.symbol, { company, history, series: prepareSeries(history, benchmark ?? [], NOW) });
}
out(`Прогноз: проверка вне выборки. Бумаг ${stocks.size} из ${companies.length}, обучение 2017-2024, отложенная часть с 2025-01-01.`);

/** Outcome and previous-model sigma at origin t, horizon h. */
function origin(series, t, h) {
  const { rows } = series;
  if (t + h >= rows.length) return null;
  const recent = [];
  for (let j = t - 59; j <= t; j += 1) recent.push(rows[j].s);
  const sigma60 = stdev(recent);
  return sigma60 > 0 ? { y: Math.log(rows[t + h].c / rows[t].c), sigma60, unit: sigma60 * Math.sqrt(h), time: rows[t].closeAt } : null;
}

// ---------------------------------------------------------------------------
// Optional refit of the constants (training part only)
// ---------------------------------------------------------------------------

function fitModel(kind) {
  const softplus = (x) => Math.log1p(Math.exp(x));
  const weights = [];
  const shapes = [];
  for (const h of HORIZONS) {
    const rows = [];
    for (const { series } of stocks.values()) {
      for (let t = 252; t < series.rows.length; t += 1) {
        const time = series.rows[t].closeAt;
        if (time < TRAIN_FROM || time >= HOLDOUT - PURGE) continue;
        const o = origin(series, t, h);
        const state = o && stateAt(series, t, kind);
        if (state) rows.push([state.features(h), (o.y * o.y) / h, o.y / Math.sqrt(h)]);
      }
    }
    const variance = (w, x) => Math.max(x.reduce((a, v, i) => a + w[i] * v, 0), 1e-9);
    // Student t(5) quasi-likelihood of the h-session return: robust to jumps.
    const loss = (free) => {
      const w = free.map(softplus);
      let total = 0;
      for (const [x, v] of rows) {
        const m = variance(w, x);
        total += 0.5 * Math.log(m) + 3 * Math.log1p(v / (m * 3));
      }
      return total / rows.length;
    };
    let best = nelderMead(loss, MODELS[kind].features.map(() => -1), { step: 1, maxIterations: 3000, tolerance: 1e-11 });
    for (let k = 0; k < 4; k += 1) best = nelderMead(loss, best.x, { step: 0.7, maxIterations: 3000, tolerance: 1e-12 });
    const w = best.x.map(softplus);
    weights.push(w.map((x) => Number(x.toFixed(4))));
    const z = rows.filter((_, i) => i % 3 === 0).map(([x, , r]) => r / Math.sqrt(variance(w, x)));
    shapes.push(fitStudent(z));
  }
  out(`--fit ${kind}: weights ${JSON.stringify(weights)} t ${JSON.stringify(shapes)}`);
}

function fitStudent(z) {
  const nll = ([a, b]) => {
    const s = Math.exp(a);
    const nu = 2.1 + Math.exp(b);
    const c = logGamma((nu + 1) / 2) - logGamma(nu / 2) - 0.5 * Math.log(nu * Math.PI) - Math.log(s);
    return -z.reduce((total, x) => total + c - ((nu + 1) / 2) * Math.log1p((x / s) ** 2 / nu), 0) / z.length;
  };
  const found = nelderMead(nll, [0, Math.log(4)], { maxIterations: 400 });
  return [Number(Math.exp(found.x[0]).toFixed(3)), Number((2.1 + Math.exp(found.x[1])).toFixed(2))];
}

if (FIT) for (const kind of ['range', 'close']) fitModel(kind);

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

const normalQuantiles = new Map();
function normalAt(p) {
  let x = normalQuantiles.get(p);
  if (x === undefined) {
    let low = -10;
    let high = 10;
    for (let i = 0; i < 60; i += 1) {
      const mid = (low + high) / 2;
      if (normalCdf(mid) < p) low = mid;
      else high = mid;
    }
    x = (low + high) / 2;
    normalQuantiles.set(p, x);
  }
  return x;
}
const normal = (sd) => ({ cdf: (x) => normalCdf(x / sd), quantile: (p) => sd * normalAt(p) });
const student = (sd, scale, nu) => ({ cdf: (x) => studentTCdf(x / (sd * scale), nu), quantile: (p) => sd * scale * tQuantile(p, nu) });

/** Scores of a predictive distribution, normalised by the previous model's sigma so stocks can be pooled. */
function score(d, o) {
  let crps = 0;
  for (const p of LEVELS) crps += pinball(o.y, d.quantile(p), p);
  const [q025, q10, q25, q75, q90, q975] = [0.025, 0.1, 0.25, 0.75, 0.9, 0.975].map((p) => d.quantile(p));
  const tail = (pinball(o.y, q025, 0.025) + pinball(o.y, q975, 0.975) + pinball(o.y, q10, 0.1) + pinball(o.y, q90, 0.9)) / 4;
  const threshold = 0.5 * o.unit;
  const down = d.cdf(-threshold);
  const up = 1 - d.cdf(threshold);
  return {
    time: o.time,
    crps: (2 * crps) / LEVELS.length / o.unit,
    tail: tail / o.unit,
    brier: ((down - (o.y < -threshold)) ** 2 + (up - (o.y > threshold)) ** 2) / 2,
    c50: Number(o.y >= q25 && o.y <= q75),
    c80: Number(o.y >= q10 && o.y <= q90),
    c95: Number(o.y >= q025 && o.y <= q975),
    width: (q90 - q10) / o.unit,
  };
}

const summarise = (list) => Object.fromEntries(
  ['crps', 'tail', 'brier', 'c50', 'c80', 'c95', 'width', 'clim'].map((k) => [k, mean(list.map((x) => x[k]).filter(Number.isFinite))]),
);

/** 95 % interval of the CRPS skill against `reference`, bootstrapping calendar months. */
function interval(list, reference, key = 'crps') {
  const months = new Map();
  list.forEach((x, i) => {
    const d = new Date(x.time);
    const id = d.getUTCFullYear() * 12 + d.getUTCMonth();
    const cell = months.get(id) ?? [0, 0];
    cell[0] += x[key];
    cell[1] += reference[i][key];
    months.set(id, cell);
  });
  const blocks = [...months.values()];
  const random = seededRandom(5);
  const draws = [];
  for (let b = 0; b < 2000; b += 1) {
    let a = 0;
    let r = 0;
    for (let j = 0; j < blocks.length; j += 1) {
      const cell = blocks[Math.floor(random() * blocks.length)];
      a += cell[0];
      r += cell[1];
    }
    draws.push(1 - a / r);
  }
  return [quantile(draws, 0.025), quantile(draws, 0.975)];
}

// ---------------------------------------------------------------------------
// 1. All held-out sessions
// ---------------------------------------------------------------------------

/** Sigma of the simple baselines at origin t (per h sessions), shape-free. */
const garchCache = new Map();
function baselineSigmas(symbol, series, t, h) {
  const returns = [];
  for (let j = Math.max(1, t - 499); j <= t; j += 1) returns.push(series.rows[j].s);
  let cached = garchCache.get(symbol);
  // Refit every 21 sessions, and whenever the walk starts again: a later fit would see the future.
  if (!cached || t < cached.at || t - cached.at >= 21) {
    cached = { at: t, fit: fitGarch(returns) };
    garchCache.set(symbol, cached);
  }
  let garch = null;
  const { fit } = cached;
  if (fit) {
    const centre = mean(returns);
    const long = fit.longRunSigma ** 2;
    let v = long;
    for (const x of returns) v = fit.omega + fit.alpha * (x - centre) ** 2 + fit.beta * v;
    let total = 0;
    for (let k = 0; k < h; k += 1) total += long + fit.persistence ** k * (v - long);
    garch = Math.sqrt(total);
  }
  const ewma = ewmaVolatility(returns)?.sigma;
  return {
    unconditional: Math.sqrt(mean(returns.map((x) => x * x)) * h),
    ewma: ewma ? ewma * Math.sqrt(h) : null,
    garch,
  };
}

/** Smoothed frequency of moves beyond today's threshold in the trailing window: the climatology baseline. */
function climatology(series, t, o, h) {
  const threshold = 0.5 * o.unit;
  let down = 0;
  let up = 0;
  let n = 0;
  for (let j = Math.max(1, t - 499) + h; j <= t; j += 1) {
    const x = Math.log(series.rows[j].c / series.rows[j - h].c);
    n += 1;
    if (x < -threshold) down += 1;
    else if (x > threshold) up += 1;
  }
  return ((((down + 0.5) / (n + 1.5)) - (o.y < -threshold)) ** 2 + (((up + 0.5) / (n + 1.5)) - (o.y > threshold)) ** 2) / 2;
}

const EXTREME = 1.7;
const evidence = { period: null, companies: stocks.size, range: {}, close: {}, events: {}, extremeRatio: EXTREME, extreme: {} };
const NAMES = ['previous', 'unconditional', 'ewma', 'garch', 'garchT', 'range', 'close'];
// GARCH with its own Student shape, fitted on the training part like the new model's.
const garchShape = {};
for (const h of HORIZONS) {
  const z = [];
  for (const [symbol, { series }] of stocks) {
    for (let t = 252; t < series.rows.length; t += 7) {
      const time = series.rows[t].closeAt;
      if (time < TRAIN_FROM || time >= HOLDOUT - PURGE) continue;
      const o = origin(series, t, h);
      const g = o && baselineSigmas(`${symbol}|train`, series, t, h).garch;
      if (g) z.push(o.y / g);
    }
  }
  garchShape[h] = fitStudent(z);
}

for (const h of HORIZONS) {
  const scores = Object.fromEntries(NAMES.map((n) => [n, []]));
  const byRegion = new Map();
  const extreme = { previous: [], range: [] };
  let first = Infinity;
  let last = 0;
  for (const [symbol, { company, series }] of stocks) {
    for (let t = 252; t < series.rows.length; t += 1) {
      if (series.rows[t].closeAt < HOLDOUT) continue;
      const o = origin(series, t, h);
      if (!o) continue;
      const full = stateAt(series, t);
      const compact = stateAt(series, t, 'close');
      const base = baselineSigmas(symbol, series, t, h);
      if (!full || !compact || !base.garch || !base.ewma) continue;
      first = Math.min(first, o.time);
      last = Math.max(last, o.time);
      const row = {
        previous: score(normal(o.unit), o),
        unconditional: score(normal(base.unconditional), o),
        ewma: score(normal(base.ewma), o),
        garch: score(normal(base.garch), o),
        garchT: score(student(base.garch, ...garchShape[h]), o),
        range: score(distribution(full.forecast(h)), o),
        close: score(distribution(compact.forecast(h)), o),
      };
      row.previous.clim = climatology(series, t, o, h);
      for (const name of NAMES) scores[name].push(row[name]);
      // States where the model expects far more movement than usual.
      if (distribution(full.forecast(h)).stdev / Math.sqrt(h) > EXTREME * full.usual) {
        extreme.previous.push(row.previous);
        extreme.range.push(row.range);
      }
      const region = byRegion.get(company.region) ?? { previous: [], range: [] };
      region.previous.push(row.previous);
      region.range.push(row.range);
      byRegion.set(company.region, region);
    }
  }
  evidence.period = [new Date(first).toISOString().slice(0, 10), new Date(Math.max(last, evidence.period ? Date.parse(evidence.period[1]) : 0)).toISOString().slice(0, 10)];
  const old = summarise(scores.previous);
  out('');
  out(`1. h = ${h}: ${scores.range.length} точек. CRPS и pinball хвостов: доля убранной ошибки против прежней модели, %. Brier: климатология ${old.clim.toFixed(5)}.`);
  out('   модель          CRPS    [95 %]          хвосты  Brier     покрытие 50 / 80 / 95    ширина');
  for (const name of NAMES) {
    const s = summarise(scores[name]);
    const ci = name === 'previous' ? null : interval(scores[name], scores.previous);
    out(`   ${name.padEnd(14)} ${pct(1 - s.crps / old.crps, 2).padStart(6)}  ${ci ? `[${pct(ci[0], 2)}; ${pct(ci[1], 2)}]`.padEnd(15) : ''.padEnd(15)} ${pct(1 - s.tail / old.tail, 2).padStart(6)}  ${s.brier.toFixed(5)}   ${pct(s.c50)} / ${pct(s.c80)} / ${pct(s.c95)}    ${s.width.toFixed(2)}`);
  }
  for (const reference of ['garchT', 'ewma']) {
    const ci = interval(scores.range, scores[reference]);
    out(`   range против ${reference}: CRPS ${pct(1 - summarise(scores.range).crps / summarise(scores[reference]).crps, 2)} % [${pct(ci[0], 2)}; ${pct(ci[1], 2)}]`);
  }
  out(`   по регионам (CRPS %, покрытие 80 % прежнее -> новое): ${[...byRegion].map(([region, v]) => {
    const a = summarise(v.range);
    const b = summarise(v.previous);
    return `${region} ${pct(1 - a.crps / b.crps, 2)} (${pct(b.c80)} -> ${pct(a.c80)})`;
  }).join(', ')}`);
  if (extreme.range.length) {
    const cell = { n: extreme.range.length, cover80: Number(summarise(extreme.range).c80.toFixed(4)), previousCover80: Number(summarise(extreme.previous).c80.toFixed(4)) };
    evidence.extreme[h] = cell;
    out(`   ожидаемая волатильность выше обычной в ${EXTREME} раза и более: n=${cell.n}, покрытие 80 % прежнее ${pct(cell.previousCover80)} -> новое ${pct(cell.cover80)}`);
  }
  for (const kind of ['range', 'close']) {
    const s = summarise(scores[kind]);
    const ci = interval(scores[kind], scores.previous);
    const r = (x, d = 4) => Number(x.toFixed(d));
    evidence[kind][h] = {
      n: scores[kind].length,
      cover80: r(s.c80), previousCover80: r(old.c80), cover95: r(s.c95), previousCover95: r(old.c95),
      skill: r(1 - s.crps / old.crps), skillLow: r(ci[0]), skillHigh: r(ci[1]), tailSkill: r(1 - s.tail / old.tail),
      brier: r(s.brier, 5), previousBrier: r(old.brier, 5), climatologyBrier: r(old.clim, 5),
      widthChange: r(s.width / old.width - 1),
    };
  }
}

// ---------------------------------------------------------------------------
// 2. Sessions right after an event: previous analogue mixture, plain model, model with the multiplier
// ---------------------------------------------------------------------------

/** The estimator the dossier used before: normal 60-session base mixed with kernel analogues, priors 30 / 5. */
function previousEvent(target, candidates, rows, sigma60, h) {
  const weighted = [];
  for (const c of candidates) {
    const end = c.day0 + h - 1;
    if (end >= target.day0) continue;
    const w = kernelWeight(target, c);
    if (w >= 1e-3) weighted.push({ day0: c.day0, w, value: Math.log(rows[end].c / rows[c.day0 - 1].c) });
  }
  weighted.sort((a, b) => b.w - a.w);
  const picked = [];
  for (const c of weighted) {
    if (picked.length >= 80) break;
    if (picked.every((p) => c.day0 + h - 1 < p.day0 || c.day0 > p.day0 + h - 1)) picked.push(c);
  }
  const base = sigma60 * Math.sqrt(h);
  const total = picked.reduce((a, x) => a + x.w, 0);
  const nEff = total > 0 ? total ** 2 / picked.reduce((a, x) => a + x.w * x.w, 0) : 0;
  const enough = picked.length >= 5 && nEff >= 3;
  const lambda = enough ? nEff / (nEff + 5) : 0;
  const lambdaMean = enough ? nEff / (nEff + 30) : 0;
  const centre = enough ? picked.reduce((a, x) => a + x.w * x.value, 0) / total : 0;
  const shift = enough ? centre * (1 - lambdaMean / lambda) : 0;
  const spread = enough ? Math.sqrt(picked.reduce((a, x) => a + x.w * (x.value - centre) ** 2, 0) / total) : 0;
  const bandwidth = enough ? Math.max(1.06 * spread * nEff ** -0.2, 0.15 * base) : base;
  const cdf = (x) => (lambda > 0 ? lambda * picked.reduce((a, c) => a + c.w * normalCdf((x - (c.value - shift)) / bandwidth), 0) / total : 0)
    + (1 - lambda) * normalCdf(x / base);
  const limit = Math.max(base, spread) * 8;
  return {
    cdf,
    quantile: (p) => {
      let low = -limit;
      let high = limit;
      for (let i = 0; i < 28; i += 1) {
        const mid = (low + high) / 2;
        if (cdf(mid) < p) low = mid;
        else high = mid;
      }
      return (low + high) / 2;
    },
  };
}

function volRegime(rows, index) {
  if (index < 140) return null;
  const past = rows.slice(index - 120, index).map((r) => r.s);
  const long = stdev(past);
  const short = stdev(past.slice(-20));
  return long > 0 && short > 0 ? Math.log(short / long) : null;
}

function eventCheck(label, key, lists, split, thin, wanted = () => true) {
  const cases = [];
  for (const [symbol, events] of lists) {
    const stock = stocks.get(symbol);
    if (!stock) continue;
    const { rows } = stock.series;
    const features = events.map((event) => {
      let low = 0;
      let high = rows.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (rows[mid].closeAt <= event.time) low = mid + 1;
        else high = mid;
      }
      return { event, day0: low, type: event.type, tone: Number(event.sentiment) || 0, sig: null, vol: volRegime(rows, low), time: event.time };
    }).filter((f) => f.day0 > 0 && f.day0 < rows.length);
    const seen = new Set();
    for (const target of features) {
      if (target.type === 'other' || !wanted(target.event) || target.day0 - 1 < 252 || rows[target.day0 - 1].closeAt < split) continue;
      const id = `${target.type}|${Math.floor(target.day0 / thin)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const candidates = features.filter((c) => c.type !== 'other' && c.day0 < target.day0 && c.day0 > target.day0 - 500);
      cases.push({ series: stock.series, target, candidates });
    }
  }
  out('');
  out(`2. ${label}: отложенные случаи ${cases.length} (с ${new Date(split).toISOString().slice(0, 10)})`);
  evidence.events[key] = {};
  for (const h of HORIZONS) {
    const scores = { previous: [], plain: [], adjusted: [] };
    const types = new Map();
    for (const { series, target, candidates } of cases) {
      const t = target.day0 - 1;
      const o = origin(series, t, h);
      const state = o && stateAt(series, t);
      if (!state) continue;
      const { scale } = eventScale(target.event);
      const forecast = state.forecast(h);
      const row = {
        previous: score(previousEvent(target, candidates, series.rows, o.sigma60, h), o),
        plain: score(distribution(forecast), o),
        adjusted: score(distribution(forecast, scale[HORIZONS.indexOf(h)]), o),
      };
      for (const name of Object.keys(scores)) scores[name].push(row[name]);
      const cell = types.get(target.type) ?? { previous: [], plain: [], adjusted: [] };
      for (const name of Object.keys(scores)) cell[name].push(row[name]);
      types.set(target.type, cell);
    }
    if (scores.previous.length < 30) {
      out(`   h = ${h}: нет данных`);
      continue;
    }
    const old = summarise(scores.previous);
    for (const name of Object.keys(scores)) {
      const s = summarise(scores[name]);
      const ci = name === 'previous' ? null : interval(scores[name], scores.previous);
      out(`   h = ${String(h).padEnd(2)} ${name.padEnd(9)} n=${scores[name].length} CRPS ${pct(1 - s.crps / old.crps, 2)} % ${ci ? `[${pct(ci[0], 2)}; ${pct(ci[1], 2)}]` : ''} Brier ${s.brier.toFixed(4)} покрытие 80/95: ${pct(s.c80)} / ${pct(s.c95)} ширина ${s.width.toFixed(2)}`);
    }
    out(`         покрытие 80 % по типам (прежнее / без множителя / с множителем): ${[...types].filter(([, v]) => v.previous.length >= 40).map(([type, v]) => `${type} ${v.previous.length}: ${pct(summarise(v.previous).c80)}/${pct(summarise(v.plain).c80)}/${pct(summarise(v.adjusted).c80)}`).join(', ')}`);
    const s = summarise(scores.adjusted);
    const ci = interval(scores.adjusted, scores.previous);
    const r = (x) => Number(x.toFixed(4));
    evidence.events[key][h] = { n: scores.adjusted.length, cover80: r(s.c80), previousCover80: r(old.c80), skill: r(1 - s.crps / old.crps), skillLow: r(ci[0]), skillHigh: r(ci[1]) };
  }
}

const filings = JSON.parse(readFileSync(join(ROOT, 'docs', 'handoff', 'backtest-data', 'sec-8k.json'), 'utf8')).filings;
const filingType = (items) => {
  const set = new Set(items.split(',').map((x) => x.trim()));
  if (set.has('5.02')) return 'leadership';
  if (set.has('2.02')) return 'earnings';
  return ['1.01', '2.01', '1.02', '2.05'].some((x) => set.has(x)) ? 'deal' : 'other';
};
eventCheck('Отчётности SEC 8-K (пункт 2.02)', 'filing', Object.entries(filings).map(([symbol, list]) => [symbol, list
  .map(([time, items]) => ({ time: Date.parse(time), type: filingType(items), sentiment: 0, source: 'SEC EDGAR' }))
  .sort((a, b) => a.time - b.time)]), HOLDOUT, 1, (e) => e.type === 'earnings');

if (NEWS && existsSync(NEWS)) {
  const bySymbol = new Map();
  for (const file of readdirSync(NEWS).filter((f) => /^[A-Z]+-\d{4}-\d\d\.json$/.test(f))) {
    const symbol = file.split('-')[0];
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
    bySymbol.get(symbol).push(...JSON.parse(readFileSync(join(NEWS, file), 'utf8')));
  }
  const lists = [...bySymbol].map(([symbol, raw]) => {
    const company = companies.find((c) => c.symbol === symbol);
    const events = raw.filter((i) => mentionIndex(i.title, company) >= 0)
      .map((i) => {
        const found = classifyEvent({ title: i.title, lang: 'en', company });
        return { ...i, type: found.type, sentiment: found.sentiment };
      })
      .filter((e) => !isShoppingNoise(e));
    return [symbol, dedupeEvents(events).sort((a, b) => a.time - b.time)];
  });
  // At most one case per company, type and four sessions.
  eventCheck('Заголовки Google News (19 компаний США)', 'headline', lists, Date.UTC(2025, 6, 1), 4);
} else {
  out('');
  out('2. Заголовки: нет данных (передай --news с кэшем scripts/backtest-news-tone.mjs)');
}

// ---------------------------------------------------------------------------
// 3. Do links between companies hold on the following quarter?
// ---------------------------------------------------------------------------

{
  const closes = new Map([...stocks].map(([s, v]) => [s, new Map(v.series.rows.map((r) => [r.day, r.c]))]));
  const pairs = (a, b, from, to) => {
    const { rows } = stocks.get(a).series;
    const other = closes.get(b);
    const xs = [];
    const ys = [];
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].day < from || rows[i].day >= to) continue;
      const p = other.get(rows[i - 1].day);
      const q = other.get(rows[i].day);
      if (p && q) {
        xs.push(rows[i].s);
        ys.push(Math.log(q / p));
      }
    }
    return [xs, ys];
  };
  const fit = (xs, ys) => {
    const mx = mean(xs);
    const my = mean(ys);
    let a = 0;
    let b = 0;
    let c = 0;
    for (let i = 0; i < xs.length; i += 1) {
      a += (xs[i] - mx) * (ys[i] - my);
      b += (xs[i] - mx) ** 2;
      c += (ys[i] - my) ** 2;
    }
    return { beta: a / b, corr: a / Math.sqrt(b * c) };
  };
  let error = 0;
  let total = 0;
  const before = [];
  const after = [];
  const covered = new Set();
  for (let start = HOLDOUT / DAY; start < NOW / DAY - 30; start += 91) {
    for (const symbol of stocks.keys()) {
      const found = [];
      for (const peer of stocks.keys()) {
        if (peer === symbol) continue;
        const [x, y] = pairs(symbol, peer, start - 365, start);
        if (x.length < 60) continue;
        const f = fit(x, y);
        if (f.corr >= 0.3) found.push({ peer, ...f });
      }
      for (const link of found.sort((a, b) => b.corr - a.corr).slice(0, 5)) {
        const [x, y] = pairs(symbol, link.peer, start, start + 91);
        if (x.length < 30) continue;
        before.push(link.corr);
        after.push(fit(x, y).corr);
        covered.add(symbol);
        for (let i = 0; i < x.length; i += 1) {
          error += (y[i] - link.beta * x[i]) ** 2;
          total += y[i] ** 2;
        }
      }
    }
  }
  evidence.links = {
    pairQuarters: after.length, companies: covered.size, corrBefore: Number(mean(before).toFixed(3)), corrAfter: Number(mean(after).toFixed(3)),
    held: Number((after.filter((x) => x >= 0.2).length / after.length).toFixed(3)), r2: Number((1 - error / total).toFixed(3)),
  };
  out('');
  out(`3. Связанные компании (порог корреляции 0.3 за год, проверка на следующем квартале): ${JSON.stringify(evidence.links)}`);
}

if (WRITE) {
  writeFileSync(join(ROOT, 'api', '_dossier', 'math', 'forecast-evidence.js'),
    `// Out-of-sample results shown next to the forecast. Written by scripts/backtest-forecast.mjs --write.\n// Prices: Yahoo daily bars; constants fitted before 2025, everything below measured after.\nexport const EVIDENCE = ${JSON.stringify(evidence, null, 2)};\n`);
  out('Записано: api/_dossier/math/forecast-evidence.js');
}
