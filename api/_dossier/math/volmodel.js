// Conditional distribution of the h-session log return: a heterogeneous autoregressive (HAR) variance
// forecast with daily ranges, quarterly repetition and market volatility, Student-t tails, zero centre.
// Coefficients are constants fitted on 2017-2024 prices of the listed companies and checked on
// 2025-2026 (scripts/backtest-forecast.mjs). Formulas and tables: docs/math/forecast.md.
// Pure ESM, no dependencies (edge safe), no look-ahead: everything at session t uses bars up to t.
import { alignedReturns } from '../quant.js';
import { normalCdf, studentTCdf } from './special.js';
import { stdev } from './stats.js';

const DAY = 86_400_000;
export const ANCHORS = [1, 5, 20];
const MIN_SIMPLE = 60;
const OHLC_SHARE = 0.9;

/**
 * `window`: returns used for the long-run level; `min`: returns needed. `weights[anchor][i]` multiplies
 * feature i (a daily variance). `t[anchor]` = [scale, degrees of freedom] of the standardised return.
 */
export const MODELS = {
  // Needs open/high/low: the company page.
  range: {
    window: 500,
    min: 250,
    features: ['long', 'rangeDay', 'rangeWeek', 'rangeMonth', 'rangeQuarter', 'season', 'marketWeek', 'marketMonth'],
    weights: [
      [0.0878, 0.1909, 0.255, 0.1089, 0.2019, 0.1336, 0.0995, 0.0181],
      [0.1736, 0.0986, 0.1726, 0.0625, 0.1975, 0.2783, 0.1195, 0.0523],
      [0.29, 0.0258, 0.0281, 0.0077, 0.1685, 0.4819, 0.108, 0.067],
    ],
    t: [[0.777, 5.01], [0.795, 6.11], [0.791, 5.84]],
  },
  // Closing prices only, one year: the market overview (spark series).
  close: {
    window: 250,
    min: 200,
    features: ['long', 'day', 'week', 'month', 'quarter', 'marketWeek'],
    weights: [
      [0.243, 0.0298, 0.1208, 0.1607, 0.2825, 0.2084],
      [0.3994, 0.0344, 0.0336, 0.1235, 0.2821, 0.2339],
      [0.6466, 0.0067, 0, 0.0943, 0.2136, 0.1706],
    ],
    t: [[0.769, 4.74], [0.789, 5.79], [0.788, 5.64]],
  },
};

/** Linear in ln h between the fitted horizons, flat outside them. */
export function byHorizon(values, h) {
  const last = ANCHORS.length - 1;
  if (h <= ANCHORS[0]) return values[0];
  if (h >= ANCHORS[last]) return values[last];
  const i = ANCHORS.findIndex((a) => a >= h);
  const k = Math.log(h / ANCHORS[i - 1]) / Math.log(ANCHORS[i] / ANCHORS[i - 1]);
  const mix = (a, b) => a + k * (b - a);
  return Array.isArray(values[i]) ? values[i].map((b, j) => mix(values[i - 1][j], b)) : mix(values[i - 1], values[i]);
}

/** Calendar day (days since 1970) of the h-th weekday after `day`. */
export function addSessions(day, h) {
  let d = day;
  for (let k = 0; k < h;) {
    d += 1;
    const weekday = (d + 4) % 7;
    if (weekday !== 0 && weekday !== 6) k += 1;
  }
  return d;
}

/** Overnight gap squared plus the Garman-Klass intraday estimate; null without a usable open/high/low. */
export function rangeVariance(bar, previousClose) {
  const { o, h, l, c } = bar ?? {};
  if (!(o > 0 && h > 0 && l > 0 && previousClose > 0) || h < l) return null;
  const gap = Math.log(o / previousClose);
  const range = Math.log(h / l);
  const body = Math.log(c / o);
  return gap * gap + Math.max(0.5 * range * range - (2 * Math.LN2 - 1) * body * body, 0);
}

/** Mean of a[from..to] (inclusive, from >= 1); every entry is finite. */
function average(a, from, to) {
  let total = 0;
  for (let i = Math.max(1, from); i <= to; i += 1) total += a[i];
  return total / (to - Math.max(1, from) + 1);
}

/** Completed sessions of the stock (with ranges where present) and of the benchmark. */
export function prepareSeries(history, benchmarkHistory, nowMs = Date.now()) {
  const rows = alignedReturns(history, [], nowMs);
  const raw = new Map((history || []).filter((b) => b && Number.isFinite(b.t))
    .map((b) => [Number.isInteger(b.day) ? b.day : Math.floor(b.t / DAY), b]));
  const squared = rows.map((r) => (Number.isFinite(r.s) ? r.s * r.s : 0));
  let withRange = 0;
  const ranged = rows.map((r, i) => {
    const bar = raw.get(r.day);
    const value = i ? rangeVariance(bar && { o: bar.o, h: bar.h, l: bar.l, c: r.c }, rows[i - 1].c) : null;
    if (value !== null) withRange += 1;
    return value ?? squared[i];
  });
  const market = alignedReturns(benchmarkHistory, [], nowMs);
  return {
    rows,
    squared,
    ranged,
    hasRange: rows.length > 1 && withRange / (rows.length - 1) >= OHLC_SHARE,
    marketTimes: market.map((r) => r.closeAt),
    marketSquared: market.map((r) => (Number.isFinite(r.s) ? r.s * r.s : 0)),
  };
}

/** Benchmark variance of the last week/month relative to its own long run; 1 (neutral) without data. */
function marketRatios(series, closeAt, model) {
  const { marketTimes, marketSquared } = series;
  let low = 0;
  let high = marketTimes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (marketTimes[mid] <= closeAt) low = mid + 1;
    else high = mid;
  }
  const k = low - 1;
  // A benchmark that stopped before the stock did says nothing about today.
  if (k < model.min || closeAt - marketTimes[k] > 10 * DAY) return { week: 1, month: 1, used: false };
  const long = average(marketSquared, k - model.window + 1, k);
  if (!(long > 0)) return { week: 1, month: 1, used: false };
  return { week: average(marketSquared, k - 4, k) / long, month: average(marketSquared, k - 21, k) / long, used: true };
}

/** Median over the four previous quarters of the daily variance around the same weeks as the window ahead. */
function seasonVariance(series, t, from, h, fallback) {
  const { rows, squared } = series;
  const start = rows[t].day + 1;
  const end = addSessions(rows[t].day, h);
  const seen = [];
  for (let q = 1; q <= 4; q += 1) {
    const a = start - 91 * q - 3;
    const b = end - 91 * q + 3;
    if (a < rows[from].day) continue;
    let total = 0;
    let count = 0;
    for (let j = t; j >= from && rows[j].day >= a; j -= 1) {
      if (rows[j].day <= b) {
        total += squared[j];
        count += 1;
      }
    }
    if (count) seen.push(total / count);
  }
  if (seen.length < 3) return { value: fallback, quarters: seen.length };
  const sorted = seen.sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return { value: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, quarters: sorted.length };
}

/** Which model the data allows at session t: 'range', 'close', 'simple' or null. */
export function modelKind(series, t) {
  if (t >= MODELS.range.min && series.hasRange) return 'range';
  if (t >= MODELS.close.min) return 'close';
  return t >= MIN_SIMPLE ? 'simple' : null;
}

/**
 * Everything known at the close of session t. `features(h)` lists the daily variances of the chosen
 * model for horizon h; `forecast(h)` combines them. Returns null without enough history.
 */
export function stateAt(series, t, kind = modelKind(series, t)) {
  if (!kind) return null;
  const { rows, squared, ranged } = series;
  const recent = [];
  for (let j = Math.max(1, t - 59); j <= t; j += 1) recent.push(rows[j].s);
  const sigma60 = stdev(recent);
  if (!(sigma60 > 0)) return null;
  if (kind === 'simple') {
    return { kind, sigma60, usual: sigma60, marketUsed: false, features: null, forecast: (h) => ({ h, sd: sigma60 * Math.sqrt(h), scale: 1, nu: null, parts: null }) };
  }
  const model = MODELS[kind];
  const from = Math.max(1, t - model.window + 1);
  const long = average(squared, from, t);
  if (!(long > 0)) return null;
  const market = marketRatios(series, rows[t].closeAt, model);
  const span = (a, n) => average(a, Math.max(from, t - n + 1), t);
  let features;
  if (kind === 'range') {
    const level = average(ranged, from, t);
    // Ranges measure the same variance on another scale: bring them to the level of squared returns.
    const k = level > 0 ? long / level : 1;
    const fixedPart = [long, ranged[t] * k, span(ranged, 5) * k, span(ranged, 22) * k, span(ranged, 66) * k];
    features = (h) => [...fixedPart, seasonVariance(series, t, from, h, long).value, market.week * long, market.month * long];
  } else {
    const fixedPart = [long, squared[t], span(squared, 5), span(squared, 22), span(squared, 66), market.week * long];
    features = () => fixedPart;
  }
  return {
    kind,
    sigma60,
    usual: Math.sqrt(long),
    marketUsed: market.used,
    features,
    seasonQuarters: kind === 'range' ? (h) => seasonVariance(series, t, from, h, long).quarters : null,
    forecast(h) {
      const weights = byHorizon(model.weights, h);
      const parts = features(h).map((x, i) => weights[i] * x);
      const daily = Math.max(parts.reduce((a, b) => a + b, 0), 1e-9);
      const [scale, nu] = byHorizon(model.t, h);
      return { h, sd: Math.sqrt(daily * h), scale, nu, parts: parts.map((p) => p / daily) };
    },
  };
}

const quantiles = new Map();

/** Quantile of the standard Student t (bisection, cached: only a few levels are ever asked). */
export function tQuantile(p, nu) {
  const key = `${p}|${nu}`;
  let value = quantiles.get(key);
  if (value === undefined) {
    let low = -200;
    let high = 200;
    for (let i = 0; i < 60; i += 1) {
      const mid = (low + high) / 2;
      if (studentTCdf(mid, nu) < p) low = mid;
      else high = mid;
    }
    value = p === 0.5 ? 0 : (low + high) / 2;
    if (quantiles.size > 4000) quantiles.clear();
    quantiles.set(key, value);
  }
  return value;
}

const NORMAL = new Map([[0.025, -1.959964], [0.1, -1.281552], [0.25, -0.67449], [0.5, 0], [0.75, 0.67449], [0.9, 1.281552], [0.975, 1.959964]]);

/** Distribution of the h-session log return, centred on zero; `widen` is an event multiplier of the scale. */
export function distribution({ sd, scale, nu }, widen = 1) {
  const unit = sd * scale * widen;
  if (nu === null) {
    return { cdf: (x) => normalCdf(x / unit), quantile: (p) => unit * (NORMAL.get(p) ?? Number.NaN), stdev: unit };
  }
  return {
    cdf: (x) => studentTCdf(x / unit, nu),
    quantile: (p) => unit * tQuantile(p, nu),
    stdev: unit * Math.sqrt(nu / (nu - 2)),
  };
}

/** Pinball (quantile) loss of the quantile `q` at level p for the outcome y. */
export const pinball = (y, q, p) => (y >= q ? p * (y - q) : (1 - p) * (q - y));

const CHECK_LEVELS = Array.from({ length: 10 }, (_, i) => (i + 0.5) / 10);

/**
 * Walk-forward record on this company alone: at each of the last `sessions` origins the corridor is
 * rebuilt from the bars known then and compared with what followed, next to the previous model
 * (normal, 60-session deviation). `skill` is the share of quantile loss removed.
 */
export function trackRecord(series, h, sessions = 250) {
  const { rows } = series;
  const last = rows.length - 1 - h;
  const first = Math.max(MODELS.close.min, last - sessions + 1);
  let n = 0;
  let inside80 = 0;
  let inside95 = 0;
  let previous80 = 0;
  let previous95 = 0;
  let loss = 0;
  let previousLoss = 0;
  for (let t = first; t <= last; t += 1) {
    const state = stateAt(series, t);
    if (!state || state.kind === 'simple') continue;
    const actual = Math.log(rows[t + h].c / rows[t].c);
    const now = state.forecast(h);
    const next = distribution(now);
    const old = distribution({ sd: state.sigma60 * Math.sqrt(h), scale: 1, nu: null });
    n += 1;
    if (Math.abs(actual) <= next.quantile(0.9)) inside80 += 1;
    if (Math.abs(actual) <= next.quantile(0.975)) inside95 += 1;
    if (Math.abs(actual) <= old.quantile(0.9)) previous80 += 1;
    if (Math.abs(actual) <= old.quantile(0.975)) previous95 += 1;
    for (const p of CHECK_LEVELS) loss += pinball(actual, next.quantile(p), p);
    const unit = state.sigma60 * Math.sqrt(h);
    for (const p of CHECK_LEVELS) previousLoss += pinball(actual, unit * NORMAL_TEN[p], p);
  }
  if (n < 30) return null;
  return {
    h,
    n,
    // Windows of h sessions overlap: this many of them are independent.
    independent: Math.floor(n / h),
    from: rows[first].closeAt,
    to: rows[last].closeAt,
    cover80: inside80 / n,
    cover95: inside95 / n,
    previousCover80: previous80 / n,
    previousCover95: previous95 / n,
    skill: previousLoss > 0 ? 1 - loss / previousLoss : 0,
  };
}

const NORMAL_TEN = {
  0.05: -1.644854, 0.15: -1.036433, 0.25: -0.67449, 0.35: -0.38532, 0.45: -0.125661,
  0.55: 0.125661, 0.65: 0.38532, 0.75: 0.67449, 0.85: 1.036433, 0.95: 1.644854,
};
