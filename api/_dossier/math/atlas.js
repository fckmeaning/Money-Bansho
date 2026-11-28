// Market atlas: risk and liquidity of every listed company, daily and weekly
// correlations, correlation networks, regional indices and return histograms.
// Pure ESM (edge safe). A value that cannot be computed from enough real
// observations is null. Formulas: src/dossier/atlas/formulas.ts.
import { alignedReturns, withCloseTimes } from '../quant.js';
import { COLUMNS, correlationMatrix, liveBars, screenerFrom, weeklyReturns, MIN_WEEKS } from './market.js';
import { drawdownStats, ols, YEAR } from './metrics.js';
import { distanceOf, graphMetrics, hierarchicalOrder, minimumSpanningTree } from './network.js';
import { valueAtRisk } from './risk.js';
import { excessKurtosis, mean, median, round, skewness, stdev, sum } from './stats.js';

export const MIN_DAYS = 60;
export const VOLUME_DAYS = 20;
export const AMIHUD_DAYS = 60;
export const THRESHOLDS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
/** Histogram bins of daily simple returns, per cent. The outer bins also take the tails. */
export const BIN_EDGES = Array.from({ length: 41 }, (_, i) => -10 + i * 0.5);
/** Currencies quoted in hundredths. */
const MINOR = { ILA: ['ILS', 0.01], GBp: ['GBP', 0.01], GBX: ['GBP', 0.01], ZAc: ['ZAR', 0.01] };
const START_SLACK = 15; // calendar days a member may start after the earliest one in an index

const column = (id, en, ru, unit) => ({ id, label: { en, ru }, unit });

export const EXTRA_COLUMNS = [
  column('var95', 'VaR 95% (1 day)', 'VaR 95% (1 день)', 'pct'),
  column('es95', 'ES 95% (1 day)', 'ES 95% (1 день)', 'pct'),
  column('var99', 'VaR 99% (1 day)', 'VaR 99% (1 день)', 'pct'),
  column('es99', 'ES 99% (1 day)', 'ES 99% (1 день)', 'pct'),
  column('var99t', 'VaR 99% Student t', 'VaR 99% по Стьюденту', 'pct'),
  column('downsideVol', 'Downside volatility', 'Волатильность вниз', 'pct'),
  column('currentDrawdown', 'Current drawdown', 'Текущая просадка', 'pct'),
  column('calmar', 'Calmar', 'Кальмар', 'ratio'),
  column('alpha', 'Alpha, yearly', 'Альфа за год', 'pct'),
  column('r2', 'R² to benchmark', 'R² к бенчмарку', 'ratio'),
  column('idioVol', 'Own volatility', 'Собственная волатильность', 'pct'),
  column('skew', 'Skewness', 'Асимметрия', 'ratio'),
  column('kurtosis', 'Excess kurtosis', 'Эксцесс', 'ratio'),
  column('hitRate', 'Up days', 'Доля дней роста', 'pct'),
  column('bestDay', 'Best day', 'Лучший день', 'pct'),
  column('worstDay', 'Worst day', 'Худший день', 'pct'),
  column('distanceLow52w', 'From 52w low', 'От минимума 52н', 'pct'),
  column('volumeLast', 'Volume, last session', 'Объём, последняя сессия', 'num'),
  column('volume20', 'Average volume 20', 'Средний объём 20', 'num'),
  column('relVolume', 'Relative volume', 'Относительный объём', 'ratio'),
  column('turnoverUsd', 'Daily turnover, USD', 'Дневной оборот, USD', 'money'),
  column('amihud', 'Amihud, % per $1bn', 'Амихуд, % на $1 млрд', 'ratio'),
  column('avgCorr', 'Average correlation', 'Средняя корреляция', 'ratio'),
];

export const ALL_COLUMNS = [...COLUMNS, ...EXTRA_COLUMNS];

/** Currency code of the rate and the factor from the quoted unit to it. */
export function currencyUnit(currency) {
  return MINOR[currency] ?? [currency ?? null, 1];
}

/** Risk values from completed daily bars of the stock and its benchmark. */
export function riskValues(bars, benchmarkBars, nowMs) {
  const rows = alignedReturns(bars, benchmarkBars, nowMs);
  const closes = rows.map((r) => r.c).slice(-(YEAR + 1));
  const logs = rows.slice(1).map((r) => r.s).slice(-YEAR);
  const simple = logs.map(Math.expm1);
  const enough = logs.length >= MIN_DAYS;
  const v95 = enough ? valueAtRisk(logs, { level: 0.95 }) : null;
  const v99 = enough ? valueAtRisk(logs, { level: 0.99 }) : null;
  const percent = (x) => (Number.isFinite(x) ? x * 100 : null);
  const pairs = rows.slice(-YEAR).filter((r) => Number.isFinite(r.s) && Number.isFinite(r.m));
  const fit = pairs.length >= MIN_DAYS
    ? ols(pairs.map((r) => Math.expm1(r.m)), pairs.map((r) => Math.expm1(r.s))) : null;
  const drawdown = enough ? drawdownStats(closes) : null;
  const growth = enough ? (closes[closes.length - 1] / closes[0]) ** (YEAR / (closes.length - 1)) - 1 : null;
  const low = enough ? Math.min(...closes) : null;
  return {
    var95: percent(v95?.historical),
    es95: percent(v95?.expectedShortfall),
    var99: percent(v99?.historical),
    es99: percent(v99?.expectedShortfall),
    var99t: percent(v99?.parametricT),
    downsideVol: enough
      ? Math.sqrt(sum(simple.map((r) => Math.min(r, 0) ** 2)) / simple.length) * Math.sqrt(YEAR) * 100 : null,
    currentDrawdown: drawdown?.current ?? null,
    calmar: drawdown && drawdown.max < -1e-9 ? (growth * 100) / Math.abs(drawdown.max) : null,
    alpha: fit ? fit.intercept * YEAR * 100 : null,
    r2: fit?.r2 ?? null,
    idioVol: fit ? fit.residualSd * Math.sqrt(YEAR) * 100 : null,
    skew: enough ? skewness(logs) : null,
    kurtosis: enough ? excessKurtosis(logs) : null,
    hitRate: enough ? (simple.filter((r) => r > 0).length / simple.length) * 100 : null,
    bestDay: enough ? Math.max(...simple) * 100 : null,
    worstDay: enough ? Math.min(...simple) * 100 : null,
    distanceLow52w: low ? (closes[closes.length - 1] / low - 1) * 100 : null,
  };
}

/**
 * Volume and liquidity from completed bars with a real traded volume. `rate` is the
 * number of currency units per US dollar, `factor` converts the quoted price unit.
 */
export function volumeValues(bars, nowMs, rate, factor = 1) {
  const done = withCloseTimes(bars ?? []).filter((b) => b.closeAt <= nowMs);
  const traded = done.filter((b) => b.v > 0);
  const empty = { volumeLast: null, volume20: null, relVolume: null, turnoverUsd: null, amihud: null };
  if (!traded.length) return empty;
  const last = traded[traded.length - 1];
  const recent = traded.slice(-VOLUME_DAYS);
  const before = traded.slice(-(VOLUME_DAYS + 1), -1);
  const full = recent.length >= VOLUME_DAYS;
  const dollars = (b) => (rate > 0 ? (b.c * factor * b.v) / rate : null);
  const impacts = [];
  for (let i = Math.max(1, done.length - AMIHUD_DAYS); i < done.length; i += 1) {
    const traded$ = done[i].v > 0 ? dollars(done[i]) : null;
    if (traded$ > 0) impacts.push((Math.abs(done[i].c / done[i - 1].c - 1) * 100) / (traded$ / 1e9));
  }
  return {
    volumeLast: last.v,
    volume20: full ? mean(recent.map((b) => b.v)) : null,
    relVolume: before.length >= VOLUME_DAYS ? last.v / mean(before.map((b) => b.v)) : null,
    turnoverUsd: full && rate > 0 ? mean(recent.map(dollars)) : null,
    amihud: impacts.length >= VOLUME_DAYS ? mean(impacts) : null,
  };
}

/** Map exchange-local day -> log return over the last year of completed sessions. */
export function dailyReturns(bars, nowMs) {
  const rows = alignedReturns(bars, [], nowMs).slice(-YEAR);
  return new Map(rows.filter((r) => Number.isFinite(r.s)).map((r) => [r.day, r.s]));
}

/** Common observations of every pair of return maps. */
export function overlapMatrix(series) {
  const out = series.map(() => new Array(series.length).fill(0));
  for (let i = 0; i < series.length; i += 1) {
    for (let j = i; j < series.length; j += 1) {
      let n = 0;
      for (const key of series[i].keys()) if (series[j].has(key)) n += 1;
      out[i][j] = n;
      out[j][i] = n;
    }
  }
  return out;
}

export function histogram(simplePct) {
  const counts = new Array(BIN_EDGES.length - 1).fill(0);
  const width = BIN_EDGES[1] - BIN_EDGES[0];
  for (const value of simplePct) {
    const at = Math.floor((value - BIN_EDGES[0]) / width);
    counts[Math.max(0, Math.min(counts.length - 1, at))] += 1;
  }
  return counts;
}

/** Counts, mean, deviation and the share of moves beyond three deviations. */
export function distribution(simplePct) {
  if (simplePct.length < MIN_DAYS) return { n: simplePct.length, counts: null, mean: null, sd: null, beyond3: null };
  const m = mean(simplePct);
  const sd = stdev(simplePct);
  return {
    n: simplePct.length,
    counts: histogram(simplePct),
    mean: round(m, 4),
    sd: round(sd, 4),
    beyond3: sd > 0 ? round((simplePct.filter((v) => Math.abs(v - m) > 3 * sd).length / simplePct.length) * 100, 3) : null,
  };
}

/** Network of positive correlations: spanning tree and measures for every threshold. */
export function correlationNetwork(matrix) {
  const n = matrix.length;
  const all = [];
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      const rho = matrix[a][b];
      if (Number.isFinite(rho)) all.push({ a, b, rho, w: Math.max(0, rho), d: distanceOf(rho) });
    }
  }
  const tree = minimumSpanningTree(n, all);
  return {
    mst: {
      edges: tree.map(({ a, b }) => [a, b]),
      length: tree.length ? round(mean(tree.map((e) => e.d)), 4) : null,
      metrics: graphMetrics(n, tree),
    },
    levels: THRESHOLDS.map((threshold) => ({
      threshold,
      metrics: graphMetrics(n, all.filter((e) => e.rho >= threshold)),
    })),
  };
}

/**
 * Equal-weighted buy-and-hold index of each region in local currencies, base 100, on the
 * union of the members' trading days; a closed market keeps its last close.
 */
export function regionIndices(members) {
  const usable = members.filter((m) => m.days.length >= MIN_DAYS);
  if (!usable.length) return { days: [], series: {}, excluded: members.map((m) => m.symbol) };
  const earliest = Math.min(...usable.map((m) => m.days[0]));
  const inside = usable.filter((m) => m.days[0] - earliest <= START_SLACK);
  const start = Math.max(...inside.map((m) => m.days[0]));
  const days = [...new Set(inside.flatMap((m) => m.days))].filter((d) => d >= start).sort((a, b) => a - b);
  const paths = inside.map((m) => {
    let at = 0;
    while (at + 1 < m.days.length && m.days[at + 1] <= start) at += 1;
    const base = m.closes[at];
    return {
      region: m.region,
      values: days.map((day) => {
        while (at + 1 < m.days.length && m.days[at + 1] <= day) at += 1;
        return m.closes[at] / base;
      }),
    };
  });
  const series = {};
  for (const region of new Set(paths.map((p) => p.region))) {
    const own = paths.filter((p) => p.region === region);
    series[region] = days.map((_, i) => round((100 * sum(own.map((p) => p.values[i]))) / own.length, 3));
  }
  const kept = new Set(inside.map((m) => m.symbol));
  return { days, series, excluded: members.filter((m) => !kept.has(m.symbol)).map((m) => m.symbol) };
}

/** Mean pairwise correlation between (and inside) regions. */
export function regionCorrelation(regions, rowRegions, matrix) {
  return regions.map((a) => regions.map((b) => {
    const values = [];
    for (let i = 0; i < rowRegions.length; i += 1) {
      if (rowRegions[i] !== a) continue;
      for (let j = 0; j < rowRegions.length; j += 1) {
        if (i !== j && rowRegions[j] === b && Number.isFinite(matrix[i][j])) values.push(matrix[i][j]);
      }
    }
    return values.length ? round(mean(values), 3) : null;
  }));
}

function indexStats(values) {
  if (!values || values.length < MIN_DAYS) return { indexReturn: null, indexVol: null, indexDrawdown: null };
  const logs = values.slice(1).map((v, i) => Math.log(v / values[i]));
  return {
    indexReturn: round(values[values.length - 1] - 100, 3),
    indexVol: round(stdev(logs) * Math.sqrt(YEAR) * 100, 3),
    indexDrawdown: round(drawdownStats(values).max, 3),
  };
}

/**
 * Pure part of the atlas. `series`: Map symbol -> {meta, history} of one year of closes,
 * `volumes`: the same shape with traded volume, `rates`: currency -> units per US dollar.
 */
export function atlasFrom(list, series, volumes, rates, nowMs) {
  const base = screenerFrom(list, series, nowMs);
  const companies = new Map(list.map((c) => [c.symbol, c]));
  const barsOf = (symbol) => {
    const entry = series.get(symbol);
    return entry ? liveBars(entry) : [];
  };
  const noVolume = [];
  const noRate = new Set();
  const daily = [];
  const weekly = [];
  const members = [];
  const pooled = new Map([['all', []]]);

  const rows = base.rows.map((row) => {
    const company = companies.get(row.symbol);
    const bars = barsOf(row.symbol);
    const volumeEntry = volumes.get(row.symbol);
    const [code, factor] = currencyUnit(row.currency);
    const rate = code === 'USD' ? 1 : (rates.get(code) ?? null);
    if (!volumeEntry) noVolume.push(row.symbol);
    else if (!rate) noRate.add(code ?? '?');

    const returns = dailyReturns(bars, nowMs);
    daily.push(returns);
    weekly.push(weeklyReturns(bars, nowMs));
    const done = withCloseTimes(bars).filter((b) => b.closeAt <= nowMs).slice(-(YEAR + 1));
    members.push({ symbol: row.symbol, region: row.region, days: done.map((b) => b.day), closes: done.map((b) => b.c) });
    const simple = [...returns.values()].map((r) => Math.expm1(r) * 100);
    pooled.get('all').push(...simple);
    if (!pooled.has(row.region)) pooled.set(row.region, []);
    pooled.get(row.region).push(...simple);

    return {
      ...row,
      country: company.country,
      values: {
        ...row.values,
        ...riskValues(bars, barsOf(company.benchmark), nowMs),
        ...volumeValues(volumeEntry?.history, nowMs, rate, factor),
      },
      distribution: distribution(simple),
    };
  });

  const matrices = { daily: correlationMatrix(daily, MIN_DAYS), weekly: correlationMatrix(weekly, MIN_WEEKS) };
  rows.forEach((row, i) => {
    const own = matrices.daily[i].filter((v, j) => j !== i && Number.isFinite(v));
    row.values.avgCorr = own.length ? mean(own) : null;
    row.values = Object.fromEntries(ALL_COLUMNS.map(({ id, unit }) => [
      id, round(row.values[id], unit === 'money' || unit === 'num' ? 2 : 4),
    ]));
  });

  const rowRegions = rows.map((r) => r.region);
  const regionIds = [...new Set(rowRegions)];
  const indices = regionIndices(members);
  const between = {
    daily: regionCorrelation(regionIds, rowRegions, matrices.daily),
    weekly: regionCorrelation(regionIds, rowRegions, matrices.weekly),
  };
  const regions = regionIds.map((region, k) => {
    const own = rows.filter((r) => r.region === region);
    const medians = Object.fromEntries(ALL_COLUMNS.map(({ id, unit }) => {
      const values = unit === 'price' ? [] : own.map((r) => r.values[id]).filter(Number.isFinite);
      return [id, values.length ? round(median(values), 4) : null];
    }));
    const turnover = own.map((r) => r.values.turnoverUsd).filter(Number.isFinite);
    const others = [];
    for (const i of rowRegions.keys()) {
      if (rowRegions[i] !== region) continue;
      for (const j of rowRegions.keys()) {
        if (rowRegions[j] !== region && Number.isFinite(matrices.daily[i][j])) others.push(matrices.daily[i][j]);
      }
    }
    return {
      region,
      count: own.length,
      medians,
      ...indexStats(indices.series[region]),
      turnoverUsd: turnover.length ? round(sum(turnover), 0) : null,
      turnoverCount: turnover.length,
      intraCorr: between.daily[k][k],
      interCorr: others.length ? round(mean(others), 3) : null,
    };
  });

  const errors = [...base.errors];
  if (noVolume.length) {
    errors.push({ source: 'yahoo:volume', message: `No volume history: ${noVolume.join(', ')}`.slice(0, 300) });
  }
  if (noRate.size) errors.push({ source: 'yahoo:fx', message: `No exchange rate: ${[...noRate].join(', ')}` });

  return {
    columns: ALL_COLUMNS,
    rows,
    symbols: rows.map((r) => r.symbol),
    correlation: {
      daily: matrices.daily,
      weekly: matrices.weekly,
      overlap: overlapMatrix(daily),
      overlapWeekly: overlapMatrix(weekly),
    },
    clusters: { daily: hierarchicalOrder(matrices.daily), weekly: hierarchicalOrder(matrices.weekly) },
    network: { daily: correlationNetwork(matrices.daily), weekly: correlationNetwork(matrices.weekly) },
    regions,
    regionIndex: indices,
    regionCorrelation: { regions: regionIds, ...between },
    distribution: {
      edges: BIN_EDGES,
      groups: Object.fromEntries([...pooled].map(([id, values]) => [id, distribution(values)])),
    },
    errors,
  };
}
