// Cross-company screener: one table row per listed company, a weekly-return
// correlation matrix and regional medians. Formulas: docs/math/metrics.md.
import companies from '../companies.js';
import { alignedReturns, withCloseTimes } from '../quant.js';
import { loadSparkSeries, tradingDay } from '../yahoo.js';
import { EVIDENCE } from './forecast-evidence.js';
import { drawdownStats, momentum, ols, periodReturns, rsiSeries, YEAR } from './metrics.js';
import { companyOutlook } from './outlook-board.js';
import { mean, median, round, stdev, sum } from './stats.js';

const DAY = 86_400_000;
export const STALE_AFTER = 10 * DAY;
export const SPARK_POINTS = 60;
export const MIN_RETURNS = 60;
export const MIN_WEEKS = 26;

const column = (id, en, ru, unit) => ({ id, label: { en, ru }, unit });

export const COLUMNS = [
  column('price', 'Price', 'Цена', 'price'),
  column('change1d', '1 day', '1 день', 'pct'),
  column('return1w', '1 week', '1 неделя', 'pct'),
  column('return1m', '1 month', '1 месяц', 'pct'),
  column('return3m', '3 months', '3 месяца', 'pct'),
  column('return6m', '6 months', '6 месяцев', 'pct'),
  column('returnYtd', 'Year to date', 'С начала года', 'pct'),
  column('return1y', '1 year', '1 год', 'pct'),
  column('excess1y', 'Vs benchmark, 1y', 'К бенчмарку за год', 'pct'),
  column('momentum12m1', 'Momentum 12–1', 'Импульс 12–1', 'pct'),
  column('vol20', 'Volatility 20', 'Волатильность 20', 'pct'),
  column('vol1y', 'Volatility 1y', 'Волатильность за год', 'pct'),
  column('maxDrawdown', 'Max drawdown', 'Макс. просадка', 'pct'),
  column('sharpe', 'Sharpe', 'Шарп', 'ratio'),
  column('sortino', 'Sortino', 'Сортино', 'ratio'),
  column('rsi14', 'RSI 14', 'RSI 14', 'num'),
  column('smaDistance50', 'Vs SMA 50', 'К SMA 50', 'pct'),
  column('smaDistance200', 'Vs SMA 200', 'К SMA 200', 'pct'),
  column('distanceHigh52w', 'From 52w high', 'От максимума 52н', 'pct'),
  column('beta', 'Beta', 'Бета', 'ratio'),
  column('correlation', 'Correlation', 'Корреляция', 'ratio'),
];

/** Daily closes with the latest quote as the newest bar. */
export function liveBars({ meta, history }) {
  const dayOf = (t) => tradingDay(t, meta?.gmtoffset);
  const bars = (history || []).map((b) => ({ t: b.t, c: b.c, day: b.day ?? dayOf(b.t) }));
  const price = meta?.regularMarketPrice;
  const time = meta?.regularMarketTime * 1000;
  if (!(price > 0) || !Number.isFinite(time) || !bars.length) return bars;
  const day = dayOf(time);
  const last = bars[bars.length - 1];
  if (day === last.day) last.c = price;
  else if (day > last.day) bars.push({ t: time, c: price, day });
  return bars;
}

/** At most `points` closes, evenly picked with both ends, rebased to 100. */
export function sparkline(closes, points = SPARK_POINTS) {
  if (!closes.length) return [];
  const size = Math.min(points, closes.length);
  return Array.from({ length: size }, (_, i) => {
    const at = size === 1 ? 0 : Math.round((i * (closes.length - 1)) / (size - 1));
    return round((100 * closes[at]) / closes[0], 2);
  });
}

/** All column values of one company. */
export function screenerValues(bars, benchmarkBars, nowMs) {
  const live = withCloseTimes(bars);
  const days = live.map((b) => b.day);
  const closes = live.map((b) => b.c);
  const bench = withCloseTimes(benchmarkBars);
  const periods = periodReturns(days, closes, bench.map((b) => b.day), bench.map((b) => b.c));
  const period = (id) => periods.find((p) => p.id === id);
  const price = closes.length ? closes[closes.length - 1] : null;
  const lastDay = days[days.length - 1];

  // Statistics use completed sessions only: a running bar is not a daily return.
  const rows = alignedReturns(bars, benchmarkBars, nowMs);
  const done = rows.map((r) => r.c);
  const logs = rows.slice(1).map((r) => r.s);
  const year = logs.slice(-YEAR).map(Math.expm1);
  const enough = year.length >= MIN_RETURNS;
  const average = enough ? mean(year) : null;
  const sd = enough ? stdev(year) : null;
  const downside = enough ? Math.sqrt(sum(year.map((r) => Math.min(r, 0) ** 2)) / year.length) : null;
  const vol = (n, min) => (logs.length >= min ? stdev(logs.slice(-n)) * Math.sqrt(YEAR) * 100 : null);
  const smaDistance = (n) => (done.length >= n ? (done[done.length - 1] / mean(done.slice(-n)) - 1) * 100 : null);
  const pairs = rows.slice(-YEAR).filter((r) => Number.isFinite(r.s) && Number.isFinite(r.m));
  const fit = pairs.length >= MIN_RETURNS
    ? ols(pairs.map((r) => Math.expm1(r.m)), pairs.map((r) => Math.expm1(r.s))) : null;
  const covered = days.length > 0 && days[0] <= lastDay - 358;
  const high = covered ? Math.max(...closes.filter((_, i) => days[i] > lastDay - 365)) : null;
  const rsi = rsiSeries(done, 14);

  const values = {
    price,
    change1d: period('1d').returnPct,
    return1w: period('1w').returnPct,
    return1m: period('1m').returnPct,
    return3m: period('3m').returnPct,
    return6m: period('6m').returnPct,
    returnYtd: period('ytd').returnPct,
    return1y: period('1y').returnPct,
    excess1y: period('1y').excessPct,
    momentum12m1: momentum(days, closes, 12, 1),
    vol20: vol(20, 20),
    vol1y: vol(YEAR, MIN_RETURNS),
    maxDrawdown: enough ? drawdownStats(done.slice(-(YEAR + 1))).max : null,
    sharpe: sd > 1e-12 ? (average / sd) * Math.sqrt(YEAR) : null,
    sortino: downside > 1e-12 ? (average / downside) * Math.sqrt(YEAR) : null,
    rsi14: rsi.length ? rsi[rsi.length - 1] : null,
    smaDistance50: smaDistance(50),
    smaDistance200: smaDistance(200),
    distanceHigh52w: high ? (price / high - 1) * 100 : null,
    beta: fit?.slope ?? null,
    correlation: fit?.correlation ?? null,
  };
  return Object.fromEntries(COLUMNS.map(({ id }) => [id, round(values[id], 4)]));
}

// ---------------------------------------------------------------------------
// Weekly correlation
// ---------------------------------------------------------------------------

/** Sunday-started week number: day 0 (1 January 1970) was a Thursday. */
export const weekKey = (day) => Math.floor((day + 4) / 7);

/**
 * Map week -> log return between the last closes of two consecutive weeks. The
 * running week is left out (except on Saturday, when every market is shut).
 */
export function weeklyReturns(bars, nowMs) {
  const today = Math.floor(nowMs / DAY);
  const open = new Date(nowMs).getUTCDay() === 6 ? null : weekKey(today);
  const ends = new Map();
  for (const bar of withCloseTimes(bars)) {
    const week = weekKey(bar.day);
    if (bar.closeAt <= nowMs && week !== open) ends.set(week, bar.c);
  }
  const out = new Map();
  for (const [week, close] of ends) {
    // A week without any session breaks the chain: a two-week return is not aligned.
    if (ends.has(week - 1)) out.set(week, Math.log(close / ends.get(week - 1)));
  }
  return out;
}

/** Pairwise-complete Pearson correlation; null below `min` common weeks. */
export function correlationMatrix(series, min = MIN_WEEKS) {
  const matrix = series.map(() => new Array(series.length).fill(null));
  for (let i = 0; i < series.length; i += 1) {
    for (let j = i; j < series.length; j += 1) {
      const x = [];
      const y = [];
      for (const [week, value] of series[i]) {
        if (series[j].has(week)) {
          x.push(value);
          y.push(series[j].get(week));
        }
      }
      if (x.length < min) continue;
      const rho = ols(x, y)?.correlation;
      const value = Number.isFinite(rho) ? round(Math.max(-1, Math.min(1, rho)), 3) : null;
      matrix[i][j] = value;
      matrix[j][i] = value;
    }
  }
  return matrix;
}

function regionMedians(rows) {
  const regions = [...new Set(rows.map((r) => r.region))];
  return regions.map((region) => {
    const members = rows.filter((r) => r.region === region);
    const medians = Object.fromEntries(COLUMNS.map(({ id, unit }) => {
      // Prices in different currencies and share sizes have no meaningful median.
      const values = unit === 'price' ? [] : members.map((r) => r.values[id]).filter(Number.isFinite);
      return [id, values.length ? round(median(values), 4) : null];
    }));
    return { region, count: members.length, medians };
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Pure part of the screener. `series` is a Map symbol -> { meta, history }. */
export function screenerFrom(list, series, nowMs) {
  const errors = [];
  const barsOf = new Map([...series].map(([symbol, entry]) => [symbol, liveBars(entry)]));
  const missing = [];
  const stale = [];
  const rows = [];
  const weekly = [];
  for (const company of list) {
    const bars = barsOf.get(company.symbol);
    if (!bars?.length) {
      missing.push(company.symbol);
      continue;
    }
    // Old prices must not appear as current ones.
    if (nowMs - bars[bars.length - 1].t > STALE_AFTER) {
      stale.push(company.symbol);
      continue;
    }
    rows.push({
      symbol: company.symbol,
      name: company.name,
      region: company.region,
      currency: series.get(company.symbol).meta?.currency ?? null,
      values: screenerValues(bars, barsOf.get(company.benchmark) ?? [], nowMs),
      spark: sparkline(bars.map((b) => b.c)),
      // Completed sessions only: the live bar is not part of the forecast.
      outlook: companyOutlook(series.get(company.symbol).history, series.get(company.benchmark)?.history, nowMs),
    });
    weekly.push(weeklyReturns(bars, nowMs));
  }
  const benchmarks = [...new Set(list.map((c) => c.benchmark))].filter((s) => !barsOf.get(s)?.length);
  const report = (message, symbols) => {
    if (symbols.length) errors.push({ source: 'yahoo:screener', message: `${message}: ${symbols.join(', ')}`.slice(0, 300) });
  };
  report('No price history', missing);
  report('No recent prices', stale);
  report('No benchmark history (beta, correlation and excess are empty)', benchmarks);
  return {
    columns: COLUMNS,
    rows,
    correlation: { symbols: rows.map((r) => r.symbol), matrix: correlationMatrix(weekly) },
    regions: regionMedians(rows),
    // How the close-only corridor of `rows[].outlook` did out of sample.
    forecastEvidence: EVIDENCE ?? null,
    errors,
  };
}

export async function buildScreener(nowMs = Date.now(), list = companies) {
  const symbols = [...new Set([...list.map((c) => c.symbol), ...list.map((c) => c.benchmark)])];
  const { series, errors } = await loadSparkSeries(symbols);
  const screener = screenerFrom(list, series, nowMs);
  return { updatedAt: Date.now(), ...screener, errors: [...errors, ...screener.errors] };
}
