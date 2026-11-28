// Descriptive metrics of one company: tables, chart series and news statistics.
// Formulas and limitations: docs/math/metrics.md. Pure ESM (edge safe).
// Nothing is estimated from a sample below its stated minimum: the value is null.
import { alignedReturns, withCloseTimes } from '../quant.js';
import { chiSquareSf, normalCdf, normalQuantile, studentTTwoSided } from './special.js';
import { excessKurtosis, mean, median, quantile, round, skewness, stdev, sum } from './stats.js';

const DAY = 86_400_000;
export const YEAR = 252; // sessions per year used for annualisation
export const SERIES_LENGTH = 260;
export const MONTHS_SHOWN = 24;
export const PERIOD_IDS = ['1d', '1w', '1m', '3m', '6m', 'ytd', '1y'];
const BASE_SLACK = 10; // calendar days the base close may precede its target
const START_GRACE = 7; // calendar days the first close may follow the target
const TINY = 1e-12;
const FILING_SOURCE = 'SEC EDGAR';
// Quotes in a minor currency unit, converted for money amounts.
const MINOR_UNITS = { ILA: [0.01, 'ILS'], GBp: [0.01, 'GBP'], GBX: [0.01, 'GBP'], ZAc: [0.01, 'ZAR'] };

const isNum = Number.isFinite;
const positive = (v) => isNum(v) && v > 0;
const scaled = (v, factor = 100) => (isNum(v) ? v * factor : null);
const pctChange = (now, base) => (positive(now) && positive(base) ? (now / base - 1) * 100 : null);
const ratioOf = (a, b) => (isNum(a) && isNum(b) && Math.abs(b) > TINY ? a / b : null);
const meanOf = (xs, min = 1) => (xs.length >= min ? mean(xs) : null);
const sdOf = (xs, min = 2) => (xs.length >= min ? stdev(xs) : null);
const annualPct = (dailySd) => scaled(dailySd, 100 * Math.sqrt(YEAR));
const lastOf = (xs) => (xs.length ? xs[xs.length - 1] : null);

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** UTC day number `months` calendar months before `day`, clamped to month end. */
export function monthsBefore(day, months) {
  const date = new Date(day * DAY);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() - months;
  const length = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(date.getUTCDate(), length)) / DAY;
}

/** Index of the last element of ascending `days` that is <= target, or -1. */
function lastOnOrBefore(days, target) {
  let low = 0;
  let high = days.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (days[mid] <= target) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

/**
 * Base bar of a calendar look-back: the last close on or before `target`; when
 * the history starts just after it (a "1y" download), the first close.
 */
export function baseIndex(days, target) {
  const i = lastOnOrBefore(days, target);
  if (i >= 0) return target - days[i] <= BASE_SLACK ? i : null;
  return days.length && days[0] - target <= START_GRACE ? 0 : null;
}

function periodTarget(id, lastDay) {
  if (id === '1w') return lastDay - 7;
  if (id === 'ytd') return Date.UTC(new Date(lastDay * DAY).getUTCFullYear(), 0, 0) / DAY;
  return monthsBefore(lastDay, { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[id]);
}

/** Stock and benchmark returns over calendar look-backs ending at the last bar. */
export function periodReturns(days, closes, benchDays = [], benchCloses = []) {
  const last = days.length - 1;
  const benchAt = (day) => {
    const i = lastOnOrBefore(benchDays, day);
    return i >= 0 && day - benchDays[i] <= START_GRACE ? benchCloses[i] : null;
  };
  return PERIOD_IDS.map((id) => {
    let base = null;
    if (last > 0) {
      if (id === '1d') base = last - 1;
      // YTD needs a real close of the previous year, so no start grace.
      else if (id === 'ytd' && days[0] > periodTarget(id, days[last])) base = null;
      else base = baseIndex(days, periodTarget(id, days[last]));
    }
    if (base === null || base >= last) return { id, returnPct: null, benchmarkPct: null, excessPct: null };
    const own = pctChange(closes[last], closes[base]);
    const bench = pctChange(benchAt(days[last]), benchAt(days[base]));
    return {
      id,
      returnPct: round(own),
      benchmarkPct: round(bench),
      excessPct: own !== null && bench !== null ? round(own - bench) : null,
    };
  });
}

/** 12-1 style momentum: close `skip` months ago over close `months` months ago. */
export function momentum(days, closes, months = 12, skip = 1) {
  if (days.length < 2) return null;
  const lastDay = days[days.length - 1];
  const start = baseIndex(days, monthsBefore(lastDay, months));
  const end = baseIndex(days, monthsBefore(lastDay, skip));
  return start !== null && end !== null && end > start ? pctChange(closes[end], closes[start]) : null;
}

// ---------------------------------------------------------------------------
// Indicators (arrays aligned with the input, null while warming up)
// ---------------------------------------------------------------------------

export function smaSeries(xs, n) {
  const out = new Array(xs.length).fill(null);
  let total = 0;
  for (let i = 0; i < xs.length; i += 1) {
    total += xs[i];
    if (i >= n) total -= xs[i - n];
    if (i >= n - 1) out[i] = total / n;
  }
  return out;
}

/** EMA with k = 2/(n+1), seeded by the simple mean of the first n values. */
export function emaSeries(xs, n) {
  const out = new Array(xs.length).fill(null);
  if (xs.length < n) return out;
  const k = 2 / (n + 1);
  let value = mean(xs.slice(0, n));
  out[n - 1] = value;
  for (let i = n; i < xs.length; i += 1) {
    value += k * (xs[i] - value);
    out[i] = value;
  }
  return out;
}

/** Wilder RSI. Null while both average gain and loss are zero. */
export function rsiSeries(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    const up = Math.max(change, 0);
    const down = Math.max(-change, 0);
    if (i <= n) {
      gain += up / n;
      loss += down / n;
    } else {
      gain = (gain * (n - 1) + up) / n;
      loss = (loss * (n - 1) + down) / n;
    }
    if (i >= n && gain + loss > 0) out[i] = (100 * gain) / (gain + loss);
  }
  return out;
}

export function macdSeries(closes, fast = 12, slow = 26, smooth = 9) {
  const quick = emaSeries(closes, fast);
  const long = emaSeries(closes, slow);
  const line = closes.map((_, i) => (long[i] === null ? null : quick[i] - long[i]));
  const ready = line.slice(slow - 1);
  const signalPart = emaSeries(ready, smooth);
  const signal = line.map((_, i) => (i < slow - 1 ? null : signalPart[i - slow + 1]));
  return { line, signal, hist: line.map((v, i) => (signal[i] === null ? null : v - signal[i])) };
}

/** Drawdown against the running maximum. Percentages are zero or negative. */
export function drawdownStats(closes) {
  if (!closes.length) return null;
  const series = [];
  let peak = closes[0];
  let run = 0;
  let longest = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    run = c < peak ? run + 1 : 0;
    longest = Math.max(longest, run);
    series.push((c / peak - 1) * 100);
  }
  return {
    series,
    max: Math.min(0, ...series),
    current: series[series.length - 1],
    maxDuration: longest,
    currentDuration: run,
    average: mean(series),
    ulcer: Math.sqrt(sum(series.map((d) => d * d)) / series.length),
  };
}

// ---------------------------------------------------------------------------
// Regression and time-series statistics
// ---------------------------------------------------------------------------

/** Ordinary least squares y = a + b x with slope and intercept t statistics. */
export function ols(x, y) {
  const n = x.length;
  if (n < 3 || y.length !== n) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
    syy += (y[i] - my) ** 2;
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i += 1) sse += (y[i] - intercept - slope * x[i]) ** 2;
  const exact = sse <= 1e-20 * Math.max(syy, TINY);
  const residualSd = Math.sqrt(sse / (n - 2));
  const interceptSe = residualSd * Math.sqrt(1 / n + (mx * mx) / sxx);
  return {
    n,
    slope,
    intercept,
    residualSd,
    r2: syy > 0 ? Math.max(0, 1 - sse / syy) : null,
    correlation: syy > 0 ? sxy / Math.sqrt(sxx * syy) : null,
    slopeT: exact ? null : slope / (residualSd / Math.sqrt(sxx)),
    interceptT: exact ? null : intercept / interceptSe,
  };
}

export function autocorrelation(xs, lag) {
  if (xs.length <= lag + 1) return null;
  const m = mean(xs);
  let top = 0;
  let bottom = 0;
  for (let i = 0; i < xs.length; i += 1) {
    bottom += (xs[i] - m) ** 2;
    if (i >= lag) top += (xs[i] - m) * (xs[i - lag] - m);
  }
  return bottom > TINY * TINY ? top / bottom : null;
}

export function ljungBox(xs, lags = 10) {
  const n = xs.length;
  if (n <= lags + 1) return null;
  let q = 0;
  for (let k = 1; k <= lags; k += 1) {
    const r = autocorrelation(xs, k);
    if (r === null) return null;
    q += (r * r) / (n - k);
  }
  q *= n * (n + 2);
  return { q, p: chiSquareSf(q, lags) };
}

export function jarqueBera(xs) {
  const s = skewness(xs);
  const k = excessKurtosis(xs);
  if (s === null || k === null) return null;
  const statistic = (xs.length / 6) * (s * s + (k * k) / 4);
  return { statistic, p: chiSquareSf(statistic, 2) };
}

/** Hurst exponent by first-order detrended fluctuation analysis. */
export function hurstDfa(xs, minSample = 200) {
  const n = xs.length;
  if (n < minSample) return null;
  const m = mean(xs);
  const profile = [];
  let total = 0;
  for (const x of xs) {
    total += x - m;
    profile.push(total);
  }
  const smallest = 10;
  const largest = Math.floor(n / 4);
  const sizes = new Set();
  for (let i = 0; i < 12; i += 1) sizes.add(Math.round(smallest * (largest / smallest) ** (i / 11)));
  const logSize = [];
  const logF = [];
  for (const size of sizes) {
    const time = Array.from({ length: size }, (_, i) => i);
    let squares = 0;
    let count = 0;
    const boxes = Math.floor(n / size);
    // Boxes from the start and from the end, so the remainder is used too.
    for (const offset of [0, n - boxes * size]) {
      for (let b = 0; b < boxes; b += 1) {
        const part = profile.slice(offset + b * size, offset + (b + 1) * size);
        const fit = ols(time, part);
        squares += fit.residualSd ** 2 * (size - 2);
        count += size;
      }
    }
    if (squares > TINY * TINY) {
      logSize.push(Math.log(size));
      logF.push(0.5 * Math.log(squares / count));
    }
  }
  const fit = logF.length >= 4 ? ols(logSize, logF) : null;
  return fit ? fit.slope : null;
}

/** Lo-MacKinlay variance ratio with the heteroskedasticity-robust z statistic. */
export function varianceRatio(xs, q = 5, minSample = 120) {
  const t = xs.length;
  if (t < minSample || q < 2 || t <= q) return null;
  const m = mean(xs);
  const dev = xs.map((x) => x - m);
  const squares = sum(dev.map((d) => d * d));
  if (!(squares > TINY * TINY)) return null;
  const single = squares / (t - 1);
  let window = 0;
  let multi = 0;
  for (let i = 0; i < t; i += 1) {
    window += dev[i];
    if (i >= q) window -= dev[i - q];
    if (i >= q - 1) multi += window * window;
  }
  const ratio = multi / (q * (t - q + 1) * (1 - q / t)) / single;
  let theta = 0;
  for (let j = 1; j < q; j += 1) {
    let cross = 0;
    for (let i = j; i < t; i += 1) cross += dev[i] ** 2 * dev[i - j] ** 2;
    theta += ((2 * (q - j)) / q) ** 2 * ((t * cross) / squares ** 2);
  }
  const z = theta > 0 ? (ratio - 1) / Math.sqrt(theta / t) : null;
  return { ratio, z, p: z === null ? null : 2 * (1 - normalCdf(Math.abs(z))) };
}

// ---------------------------------------------------------------------------
// Range-based volatility
// ---------------------------------------------------------------------------

/** A bar whose open, high, low and close are present and mutually consistent. */
export function validBar(bar) {
  if (!bar || !positive(bar.o) || !positive(bar.h) || !positive(bar.l) || !positive(bar.c)) return false;
  const slack = 1e-4 * bar.c;
  if (bar.h + slack < Math.max(bar.o, bar.c, bar.l) || bar.l - slack > Math.min(bar.o, bar.c, bar.h)) return false;
  // A flat bar without trading is a placeholder, not an observed range of zero.
  return !(bar.h === bar.l && !(bar.v > 0));
}

/**
 * Daily variances over the last `window` bars, annualised to percent. Each
 * estimator needs 20 usable bars covering at least 80% of the window.
 */
export function rangeVolatility(bars, window = 60) {
  const start = Math.max(0, bars.length - window);
  const usable = [];
  const overnight = [];
  for (let i = start; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!validBar(bar)) continue;
    usable.push(bar);
    if (i > 0 && positive(bars[i - 1].c)) overnight.push({ bar, o: Math.log(bar.o / bars[i - 1].c) });
  }
  const enough = (list, size) => list.length >= 20 && list.length >= 0.8 * size;
  const out = { parkinson: null, garmanKlass: null, rogersSatchell: null, yangZhang: null, overnightShare: null, bars: usable.length };
  if (!enough(usable, bars.length - start)) return out;
  const annual = (v) => (v >= 0 ? 100 * Math.sqrt(YEAR * v) : null);
  const hl = (b) => Math.log(b.h / b.l);
  const co = (b) => Math.log(b.c / b.o);
  const rs = (b) => Math.log(b.h / b.c) * Math.log(b.h / b.o) + Math.log(b.l / b.c) * Math.log(b.l / b.o);
  out.parkinson = annual(mean(usable.map((b) => hl(b) ** 2)) / (4 * Math.LN2));
  out.garmanKlass = annual(mean(usable.map((b) => 0.5 * hl(b) ** 2 - (2 * Math.LN2 - 1) * co(b) ** 2)));
  out.rogersSatchell = annual(mean(usable.map(rs)));
  if (enough(overnight, bars.length - start)) {
    const n = overnight.length;
    const night = stdev(overnight.map((x) => x.o)) ** 2;
    const session = stdev(overnight.map((x) => co(x.bar))) ** 2;
    const k = 0.34 / (1.34 + (n + 1) / (n - 1));
    out.yangZhang = annual(night + k * session + (1 - k) * mean(overnight.map((x) => rs(x.bar))));
    out.overnightShare = night + session > 0 ? (100 * night) / (night + session) : null;
  }
  return out;
}

/** Wilder average true range over consecutive valid bars at the end of the series. */
export function averageTrueRange(bars, n = 14) {
  let start = bars.length;
  while (start > 0 && validBar(bars[start - 1])) start -= 1;
  // The first usable true range needs a previous close.
  const first = Math.max(start, 1);
  if (bars.length - first < n) return null;
  let atr = 0;
  for (let i = first; i < bars.length; i += 1) {
    const { h, l } = bars[i];
    const prev = bars[i - 1].c;
    const range = Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev));
    const k = i - first;
    atr = k < n ? atr + range / n : (atr * (n - 1) + range) / n;
  }
  return atr;
}

function stochastic(bars, n = 14) {
  const at = (end) => {
    const part = bars.slice(end - n, end);
    if (part.length < n || !part.every(validBar)) return null;
    const high = Math.max(...part.map((b) => b.h));
    const low = Math.min(...part.map((b) => b.l));
    return high > low ? (100 * (part[n - 1].c - low)) / (high - low) : null;
  };
  const ks = [0, 1, 2].map((back) => at(bars.length - back));
  return { k: ks[0], d: ks.every((v) => v !== null) ? mean(ks) : null };
}

// ---------------------------------------------------------------------------
// Metric items
// ---------------------------------------------------------------------------

const DIGITS = { pct: 4, ratio: 4, num: 6, price: 4, days: 0, money: 0 };

function item(id, en, ru, value, unit, hintEn, hintRu, formula) {
  return { id, label: { en, ru }, value: round(value, DIGITS[unit]), unit, hint: { en: hintEn, ru: hintRu }, formula };
}

const group = (id, en, ru, items) => ({ id, title: { en, ru }, items });

function returnGroup(ctx) {
  const { rows, closes, periods } = ctx;
  const of = (id) => periods.find((p) => p.id === id).returnPct;
  const n = rows.length - 1;
  const total = pctChange(lastOf(closes), closes[0]);
  const years = (rows[n].t - rows[0].t) / (365.25 * DAY);
  const cagr = years >= 0.5 ? ((closes[n] / closes[0]) ** (1 / years) - 1) * 100 : null;
  const year = ctx.simple1y;
  const calendar = (id, en, ru, key) => item(id, en, ru, of(key), 'pct',
    'Price change against the last close on or before the calendar date. Dividends are not included.',
    'Изменение цены к последнему закрытию на календарную дату или раньше. Без дивидендов.',
    'R = C_t / C_base − 1');
  return group('returns', 'Returns', 'Доходность', [
    calendar('return1d', '1 day', '1 день', '1d'),
    calendar('return1w', '1 week', '1 неделя', '1w'),
    calendar('return1m', '1 month', '1 месяц', '1m'),
    calendar('return3m', '3 months', '3 месяца', '3m'),
    calendar('return6m', '6 months', '6 месяцев', '6m'),
    calendar('returnYtd', 'Year to date', 'С начала года', 'ytd'),
    calendar('return1y', '1 year', '1 год', '1y'),
    item('returnTotal', 'Whole sample', 'За всю выборку', total, 'pct',
      'First to last close of the downloaded history. Min 2 sessions.',
      'От первого до последнего закрытия загруженной истории. Минимум 2 сессии.', 'R = C_t / C_0 − 1'),
    item('cagr', 'Annualised growth (CAGR)', 'Среднегодовой темп (CAGR)', cagr, 'pct',
      'Geometric growth per year over the whole sample. Min half a year.',
      'Геометрический рост за год по всей выборке. Минимум полгода.', 'CAGR = (C_t / C_0)^(1/years) − 1'),
    item('meanReturnAnnual', 'Mean return, annualised', 'Средняя доходность, годовая',
      year.length >= 60 ? mean(year) * YEAR * 100 : null, 'pct',
      'Arithmetic mean daily return × 252, last 252 sessions. Min 60.',
      'Среднее дневной доходности × 252, последние 252 сессии. Минимум 60.', 'μ = 252 · mean(R)'),
    item('medianReturn', 'Median daily return', 'Медианная дневная доходность',
      year.length >= 60 ? median(year) * 100 : null, 'pct',
      'Last 252 sessions. Min 60.', 'Последние 252 сессии. Минимум 60.', 'median(R)'),
  ]);
}

function riskGroup(ctx) {
  const { logs, simple1y, closes } = ctx;
  const volOver = (n, min = n) => (logs.length >= min ? annualPct(stdev(logs.slice(-n))) : null);
  const year = simple1y;
  const enough = year.length >= 60;
  const m = enough ? mean(year) : null;
  const semi = enough ? (sum(year.map((r) => Math.min(r - m, 0) ** 2)) / year.length) : null;
  const variance = enough ? stdev(year) ** 2 : null;
  const side = (sign) => (enough ? annualPct(Math.sqrt(sum(year.map((r) => Math.max(sign * r, 0) ** 2)) / year.length)) : null);
  const dd = ctx.dd1y;
  const full = ctx.logs.length >= YEAR ? drawdownStats(closes) : null;
  let streak = 0;
  let worstStreak = 0;
  for (const r of year) {
    streak = r < 0 ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
  }
  return group('risk', 'Risk', 'Риск', [
    item('vol20', 'Volatility, 20 sessions', 'Волатильность, 20 сессий', volOver(20), 'pct',
      'Annualised standard deviation of log returns. Min 20.', 'Годовое стандартное отклонение лог-доходностей. Минимум 20.', 'σ = sd(r) · √252'),
    item('vol60', 'Volatility, 60 sessions', 'Волатильность, 60 сессий', volOver(60), 'pct',
      'Annualised standard deviation of log returns. Min 60.', 'Годовое стандартное отклонение лог-доходностей. Минимум 60.', 'σ = sd(r) · √252'),
    item('vol1y', 'Volatility, 1 year', 'Волатильность, 1 год', volOver(YEAR, 60), 'pct',
      'Last 252 sessions. Min 60.', 'Последние 252 сессии. Минимум 60.', 'σ = sd(r) · √252'),
    item('volFull', 'Volatility, whole sample', 'Волатильность, вся выборка', logs.length >= YEAR ? annualPct(stdev(logs)) : null, 'pct',
      'All downloaded sessions. Min 252.', 'Все загруженные сессии. Минимум 252.', 'σ = sd(r) · √252'),
    item('downsideDeviation', 'Downside deviation', 'Отклонение вниз', side(-1), 'pct',
      'Root mean square of losses, target 0, annualised. Last 252, min 60.', 'СКО убытков относительно нуля, годовое. 252 сессии, минимум 60.', 'σ_d = √(mean(min(R,0)²)) · √252'),
    item('upsideDeviation', 'Upside deviation', 'Отклонение вверх', side(1), 'pct',
      'Root mean square of gains, target 0, annualised. Last 252, min 60.', 'СКО прибылей относительно нуля, годовое. 252 сессии, минимум 60.', 'σ_u = √(mean(max(R,0)²)) · √252'),
    item('semivariance', 'Semivariance', 'Полудисперсия', semi === null ? null : semi * YEAR, 'num',
      'Squared shortfalls below the mean, annualised, in squared decimals. Min 60.', 'Квадраты отклонений ниже среднего, годовые, в долях². Минимум 60.', 'SV = 252 · mean(min(R − R̄, 0)²)'),
    item('downsideShare', 'Downside share of variance', 'Доля риска вниз в дисперсии', ratioOf(semi, variance), 'ratio',
      'About 0.5 for a symmetric distribution. Min 60.', 'Около 0.5 при симметричном распределении. Минимум 60.', 'SV / Var(R)'),
    item('maxDrawdown1y', 'Max drawdown, 1 year', 'Макс. просадка, 1 год', dd?.max, 'pct',
      'Largest fall from a running closing peak, last 252 sessions. Min 20.', 'Наибольшее падение от текущего максимума закрытий, 252 сессии. Минимум 20.', 'min_t (C_t / max_{s≤t} C_s − 1)'),
    item('maxDrawdownFull', 'Max drawdown, whole sample', 'Макс. просадка, вся выборка', full?.max, 'pct',
      'All downloaded sessions. Min 252.', 'Все загруженные сессии. Минимум 252.', 'min_t DD_t'),
    item('currentDrawdown', 'Current drawdown', 'Текущая просадка', dd?.current, 'pct',
      'Distance below the highest close of the last 252 sessions. Min 20.', 'Расстояние ниже максимума закрытий за 252 сессии. Минимум 20.', 'DD_t'),
    item('averageDrawdown', 'Average drawdown', 'Средняя просадка', dd?.average, 'pct',
      'Mean of the daily drawdown series, 1 year. Min 20.', 'Среднее ряда просадок за год. Минимум 20.', 'mean(DD_t)'),
    item('maxDrawdownDuration', 'Longest drawdown', 'Самая долгая просадка', dd?.maxDuration, 'days',
      'Trading sessions in a row below a previous peak, 1 year. Min 20.', 'Торговых сессий подряд ниже прежнего максимума, за год. Минимум 20.', 'max run of DD_t < 0'),
    item('currentDrawdownDuration', 'Current drawdown length', 'Длина текущей просадки', dd?.currentDuration, 'days',
      'Trading sessions since the last peak of the 1-year window. Min 20.', 'Торговых сессий с последнего максимума в годовом окне. Минимум 20.', 'run length of DD_t < 0'),
    item('ulcerIndex', 'Ulcer index', 'Индекс язвы (Ulcer)', dd?.ulcer, 'pct',
      'Root mean square drawdown in percent, 1 year. Min 20.', 'Среднеквадратичная просадка в процентах, за год. Минимум 20.', 'UI = √(mean(DD_t²))'),
    item('maxLossStreak', 'Longest losing streak', 'Макс. серия падений', year.length >= 20 ? worstStreak : null, 'days',
      'Consecutive falling sessions, last 252. Min 20.', 'Падающих сессий подряд, из последних 252. Минимум 20.', 'max run of R < 0'),
  ]);
}

function adjustedGroup(ctx) {
  const { simple1y: r, pairs, dd1y } = ctx;
  const enough = r.length >= 60;
  const m = enough ? mean(r) : null;
  const sd = enough ? stdev(r) : null;
  const sharpe = sd > TINY ? (m / sd) * Math.sqrt(YEAR) : null;
  const downside = enough ? Math.sqrt(sum(r.map((x) => Math.min(x, 0) ** 2)) / r.length) : null;
  const sortino = downside > TINY ? (m / downside) * Math.sqrt(YEAR) : null;
  const gains = enough ? sum(r.map((x) => Math.max(x, 0))) : null;
  const losses = enough ? sum(r.map((x) => Math.max(-x, 0))) : null;
  const closes = ctx.closes.slice(-(YEAR + 1));
  const growth = r.length >= 126 ? ((lastOf(closes) / closes[0]) ** (YEAR / (closes.length - 1)) - 1) * 100 : null;
  const calmar = growth !== null && dd1y && dd1y.max < 0 ? growth / -dd1y.max : null;
  const martin = growth !== null && dd1y?.ulcer > TINY ? growth / dd1y.ulcer : null;
  // Lo (2002) standard error of the Sharpe ratio under independent returns.
  const sharpeSe = sharpe === null ? null : Math.sqrt((1 + (sharpe * sharpe) / (2 * YEAR)) / r.length) * Math.sqrt(YEAR);

  const paired = pairs.length >= 60;
  const own = paired ? pairs.map((p) => p.r) : [];
  const bench = paired ? pairs.map((p) => p.b) : [];
  const active = paired ? own.map((x, i) => x - bench[i]) : [];
  const te = paired ? stdev(active) : null;
  const ir = te > TINY ? (mean(active) / te) * Math.sqrt(YEAR) : null;
  const fit = paired ? ols(bench, own) : null;
  const treynor = fit && fit.slope >= 0.1 ? (mean(own) * YEAR * 100) / fit.slope : null;
  const ownSd = paired ? stdev(own) : null;
  const m2 = ownSd > TINY ? (mean(own) / ownSd) * stdev(bench) * YEAR * 100 : null;
  const note = ' Risk-free rate is taken as 0.';
  const noteRu = ' Безрисковая ставка принята за 0.';
  return group('riskAdjusted', 'Risk-adjusted performance', 'Доходность с учётом риска', [
    item('sharpe', 'Sharpe ratio', 'Коэффициент Шарпа', sharpe, 'ratio',
      `Mean return per unit of volatility, annualised, last 252 sessions, min 60.${note}`, `Средняя доходность на единицу волатильности, годовая, 252 сессии, минимум 60.${noteRu}`, 'SR = mean(R)/sd(R) · √252'),
    item('sharpeSe', 'Sharpe standard error', 'Стандартная ошибка Шарпа', sharpeSe, 'ratio',
      'Lo (2002), independent returns. Roughly ±2 of this is the 95% range.', 'По Lo (2002), независимые доходности. ±2 ошибки — примерный 95% интервал.', 'SE = √((1 + SR²/504)/n) · √252'),
    item('sortino', 'Sortino ratio', 'Коэффициент Сортино', sortino, 'ratio',
      `Mean return per unit of downside deviation, min 60.${note}`, `Средняя доходность на единицу отклонения вниз, минимум 60.${noteRu}`, 'So = mean(R)/σ_d · √252'),
    item('calmar', 'Calmar ratio', 'Коэффициент Кальмара', calmar, 'ratio',
      'Annualised growth over max drawdown on a 1-year window (not the classic 3 years). Min 126.', 'Годовой рост к макс. просадке в годовом окне (не классические 3 года). Минимум 126.', 'Calmar = CAGR_1y / |MDD_1y|'),
    item('martinRatio', 'Martin ratio (UPI)', 'Коэффициент Мартина (UPI)', martin, 'ratio',
      `Annualised growth per unit of Ulcer index. Min 126.${note}`, `Годовой рост на единицу индекса Ulcer. Минимум 126.${noteRu}`, 'UPI = CAGR_1y / UI'),
    item('omega', 'Omega ratio (0)', 'Омега (порог 0)', losses > TINY ? gains / losses : null, 'ratio',
      'Sum of gains over sum of losses, threshold 0. Min 60.', 'Сумма прибылей к сумме убытков, порог 0. Минимум 60.', 'Ω = Σmax(R,0) / Σmax(−R,0)'),
    item('gainToPain', 'Gain-to-pain ratio', 'Прибыль к боли', losses > TINY ? (gains - losses) / losses : null, 'ratio',
      'Net sum of returns over sum of losses. Min 60.', 'Чистая сумма доходностей к сумме убытков. Минимум 60.', 'GPR = ΣR / Σmax(−R,0)'),
    item('informationRatio', 'Information ratio', 'Информационный коэффициент', ir, 'ratio',
      'Mean excess over the home benchmark per unit of tracking error. Min 60 pairs.', 'Средний избыток над бенчмарком на единицу ошибки слежения. Минимум 60 пар.', 'IR = mean(R−M)/sd(R−M) · √252'),
    item('treynor', 'Treynor ratio', 'Коэффициент Трейнора', treynor, 'pct',
      `Annualised mean return per unit of beta; null when beta < 0.1. Min 60.${note}`, `Годовая средняя доходность на единицу беты; null при бете < 0.1. Минимум 60.${noteRu}`, 'T = 252·mean(R) / β'),
    item('m2', 'M² (Modigliani)', 'M² (Модильяни)', m2, 'pct',
      `Return rescaled to benchmark volatility. Min 60.${note}`, `Доходность, приведённая к волатильности бенчмарка. Минимум 60.${noteRu}`, 'M² = SR · σ_M'),
    item('m2Excess', 'M² over benchmark', 'M² сверх бенчмарка', m2 === null ? null : m2 - mean(bench) * YEAR * 100, 'pct',
      'M² minus the annualised mean benchmark return. Min 60.', 'M² минус средняя годовая доходность бенчмарка. Минимум 60.', 'M² − 252·mean(M)'),
  ]);
}

function marketGroup(ctx) {
  const { pairs } = ctx;
  const fitOn = (list, min) => (list.length >= min ? ols(list.map((p) => p.b), list.map((p) => p.r)) : null);
  const fit = fitOn(pairs, 60);
  const recent = fitOn(pairs.slice(-60), 60);
  const up = pairs.filter((p) => p.b > 0);
  const down = pairs.filter((p) => p.b < 0);
  const capture = (list) => (fit && list.length >= 20 ? scaled(ratioOf(mean(list.map((p) => p.r)), mean(list.map((p) => p.b)))) : null);
  const upCapture = capture(up);
  const downCapture = capture(down);
  const upFit = fit ? fitOn(up, 20) : null;
  const downFit = fit ? fitOn(down, 20) : null;
  const hint = (en, ru) => [`${en} Last 252 sessions, same-day pairs with the home benchmark, min 60.`, `${ru} 252 сессии, пары того же дня с домашним бенчмарком, минимум 60.`];
  const side = (en, ru) => [`${en} Min 60 pairs and 20 such days.`, `${ru} Минимум 60 пар и 20 таких дней.`];
  return group('market', 'Market relation', 'Связь с рынком', [
    item('beta', 'Beta', 'Бета', fit?.slope, 'ratio', ...hint('Least-squares sensitivity to the benchmark.', 'Чувствительность к бенчмарку (МНК).'), 'β = cov(R,M)/var(M)'),
    item('betaAdjusted', 'Adjusted beta (Blume)', 'Скорректированная бета (Блюм)', fit ? 0.67 * fit.slope + 0.33 : null, 'ratio', ...hint('Beta shrunk towards 1.', 'Бета, подтянутая к 1.'), '0.67·β + 0.33'),
    item('beta60', 'Beta, 60 sessions', 'Бета, 60 сессий', recent?.slope, 'ratio', 'Last 60 same-day pairs.', 'Последние 60 пар того же дня.', 'β over 60 pairs'),
    item('alpha', 'Alpha, annualised', 'Альфа, годовая', fit ? fit.intercept * YEAR * 100 : null, 'pct', ...hint('Intercept of the market model × 252, risk-free 0.', 'Свободный член рыночной модели × 252, безрисковая 0.'), 'α = 252·(mean(R) − β·mean(M))'),
    item('alphaT', 'Alpha t-statistic', 't-статистика альфы', fit?.interceptT, 'ratio', ...hint('|t| below about 2: alpha is not distinguishable from zero.', '|t| меньше примерно 2: альфа неотличима от нуля.'), 't = α̂ / se(α̂)'),
    item('r2', 'R²', 'R²', fit?.r2, 'ratio', ...hint('Share of variance explained by the benchmark.', 'Доля дисперсии, объяснённая бенчмарком.'), 'R² = 1 − SSE/SST'),
    item('correlation', 'Correlation', 'Корреляция', fit?.correlation, 'ratio', ...hint('Pearson correlation of daily returns.', 'Корреляция Пирсона дневных доходностей.'), 'ρ = cov(R,M)/(σ_R σ_M)'),
    item('trackingError', 'Tracking error', 'Ошибка слежения', fit ? annualPct(stdev(pairs.map((p) => p.r - p.b))) : null, 'pct', ...hint('Volatility of the return difference.', 'Волатильность разности доходностей.'), 'TE = sd(R−M)·√252'),
    item('idiosyncraticVol', 'Idiosyncratic volatility', 'Собственная волатильность', fit ? annualPct(fit.residualSd) : null, 'pct', ...hint('Volatility of market-model residuals.', 'Волатильность остатков рыночной модели.'), 'sd(ε)·√252, ε = R − a − βM'),
    item('upCapture', 'Upside capture', 'Захват роста', upCapture, 'pct', ...side('Mean return on benchmark up days relative to the benchmark.', 'Средняя доходность в дни роста бенчмарка относительно него.'), 'mean(R | M>0) / mean(M | M>0)'),
    item('downCapture', 'Downside capture', 'Захват падения', downCapture, 'pct', ...side('Same on benchmark down days; below 100% is milder falls.', 'То же в дни падения; меньше 100% — падает мягче.'), 'mean(R | M<0) / mean(M | M<0)'),
    item('captureRatio', 'Capture ratio', 'Отношение захватов', downCapture > 0 ? ratioOf(upCapture, downCapture) : null, 'ratio', ...side('Upside over downside capture; null if downside capture is not positive.', 'Захват роста к захвату падения; null, если захват падения не положителен.'), 'up / down'),
    item('upBeta', 'Up-market beta', 'Бета на росте', upFit?.slope, 'ratio', ...side('Regression on benchmark up days only.', 'Регрессия только по дням роста бенчмарка.'), 'β | M>0'),
    item('downBeta', 'Down-market beta', 'Бета на падении', downFit?.slope, 'ratio', ...side('Regression on benchmark down days only.', 'Регрессия только по дням падения бенчмарка.'), 'β | M<0'),
    item('battingAverage', 'Days beating benchmark', 'Дни лучше бенчмарка', fit ? (100 * pairs.filter((p) => p.r > p.b).length) / pairs.length : null, 'pct', ...hint('Share of sessions above the benchmark.', 'Доля сессий выше бенчмарка.'), 'share(R > M)'),
  ]);
}

function distributionGroup(ctx) {
  const x = ctx.logs;
  const n = x.length;
  const moments = n >= 60;
  const jb = n >= 100 ? jarqueBera(x) : null;
  const lb = n >= 100 ? ljungBox(x, 10) : null;
  const centre = n ? mean(x) : 0;
  const lbSq = n >= 100 ? ljungBox(x.map((v) => (v - centre) ** 2), 10) : null;
  const vr = varianceRatio(x, 5, 120);
  const simple = x.map(Math.expm1);
  const ups = simple.filter((v) => v > 0);
  const downs = simple.filter((v) => v < 0);
  const q05 = moments ? quantile(simple, 0.05) : null;
  const q95 = moments ? quantile(simple, 0.95) : null;
  const hint = (en, ru, min) => [`${en} All downloaded sessions, min ${min}.`, `${ru} Все загруженные сессии, минимум ${min}.`];
  return group('distribution', 'Distribution and dependence', 'Распределение и зависимости', [
    item('skewness', 'Skewness', 'Асимметрия', moments ? skewness(x) : null, 'ratio', ...hint('Negative: the left tail is longer.', 'Отрицательная: левый хвост длиннее.', 60), 'm3 / m2^1.5'),
    item('excessKurtosis', 'Excess kurtosis', 'Эксцесс', moments ? excessKurtosis(x) : null, 'ratio', ...hint('Zero for a normal distribution; positive means fat tails.', 'Ноль у нормального; больше нуля — толстые хвосты.', 60), 'm4 / m2² − 3'),
    item('jarqueBera', 'Jarque–Bera statistic', 'Статистика Харке–Бера', jb?.statistic, 'num', ...hint('Joint test of skewness and kurtosis.', 'Совместная проверка асимметрии и эксцесса.', 100), 'JB = n/6·(S² + K²/4)'),
    item('jarqueBeraP', 'Jarque–Bera p-value', 'p-value Харке–Бера', jb?.p, 'num', ...hint('Small p rejects normality (asymptotic).', 'Малое p отвергает нормальность (асимптотика).', 100), 'P(χ²₂ > JB)'),
    item('hitRate', 'Up days', 'Доля растущих дней', n >= 20 ? (100 * ups.length) / n : null, 'pct', ...hint('Share of sessions with a gain.', 'Доля сессий с ростом.', 20), 'share(R > 0)'),
    item('bestDay', 'Best day', 'Лучший день', n >= 20 ? Math.max(...simple) * 100 : null, 'pct', ...hint('Largest daily gain.', 'Наибольший дневной рост.', 20), 'max(R)'),
    item('worstDay', 'Worst day', 'Худший день', n >= 20 ? Math.min(...simple) * 100 : null, 'pct', ...hint('Largest daily loss.', 'Наибольшее дневное падение.', 20), 'min(R)'),
    item('gainLossRatio', 'Average gain / average loss', 'Средний рост / среднее падение', n >= 20 && ups.length && downs.length ? ratioOf(mean(ups), -mean(downs)) : null, 'ratio', ...hint('Size of a typical up day against a down day.', 'Размер типичного дня роста против дня падения.', 20), 'mean(R>0) / |mean(R<0)|'),
    item('tailRatio', 'Tail ratio', 'Отношение хвостов', q05 !== null && Math.abs(q05) > TINY ? q95 / Math.abs(q05) : null, 'ratio', ...hint('95th percentile over the size of the 5th.', '95-й перцентиль к модулю 5-го.', 60), 'Q95 / |Q05|'),
    item('autocorr1', 'Autocorrelation, lag 1', 'Автокорреляция, лаг 1', moments ? autocorrelation(x, 1) : null, 'ratio', ...hint('Link between consecutive days.', 'Связь соседних дней.', 60), 'ρ₁'),
    item('autocorr5', 'Autocorrelation, lag 5', 'Автокорреляция, лаг 5', moments ? autocorrelation(x, 5) : null, 'ratio', ...hint('Link at a one-week distance.', 'Связь на расстоянии недели.', 60), 'ρ₅'),
    item('ljungBox', 'Ljung–Box Q(10)', 'Льюнг–Бокс Q(10)', lb?.q, 'num', ...hint('Autocorrelation in returns up to lag 10.', 'Автокорреляция доходностей до лага 10.', 100), 'Q = n(n+2)·Σρ_k²/(n−k)'),
    item('ljungBoxP', 'Ljung–Box p-value', 'p-value Льюнга–Бокса', lb?.p, 'num', ...hint('Small p: returns are autocorrelated.', 'Малое p: доходности автокоррелированы.', 100), 'P(χ²₁₀ > Q)'),
    item('ljungBoxSquaredP', 'Ljung–Box p, squared returns', 'p Льюнга–Бокса, квадраты', lbSq?.p, 'num', ...hint('Small p: volatility clusters.', 'Малое p: волатильность кластеризуется.', 100), 'Q on (r − r̄)²'),
    item('hurst', 'Hurst exponent (DFA)', 'Показатель Хёрста (DFA)', hurstDfa(x, 200), 'ratio', ...hint('0.5 means no long memory; short samples are noisy and biased slightly upward.', '0.5 — нет долгой памяти; на коротких выборках шумно и слегка завышено.', 200), 'log F(s) = H·log s + c'),
    item('varianceRatio5', 'Variance ratio (5)', 'Отношение дисперсий (5)', vr?.ratio, 'ratio', ...hint('1 for a random walk; above 1 trending, below 1 reverting.', '1 у случайного блуждания; выше 1 — тренд, ниже — возврат.', 120), 'VR(q) = Var(r_q)/(q·Var(r))'),
    item('varianceRatioZ', 'Variance ratio z', 'z отношения дисперсий', vr?.z, 'ratio', ...hint('Heteroskedasticity-robust Lo–MacKinlay statistic.', 'Устойчивая к гетероскедастичности статистика Ло–МакКинли.', 120), 'z* = (VR − 1)/√(θ/n)'),
    item('varianceRatioP', 'Variance ratio p-value', 'p-value отношения дисперсий', vr?.p, 'num', ...hint('Two-sided p of the random-walk test.', 'Двустороннее p проверки случайного блуждания.', 120), '2·(1 − Φ(|z*|))'),
  ]);
}

function rangeGroup(ctx) {
  const { bars, closes } = ctx;
  const est = rangeVolatility(bars, 60);
  const atr = averageTrueRange(bars, 14);
  const recent = bars.slice(-20).filter(validBar);
  const hint = (en, ru) => [`${en} Last 60 sessions, min 20 consistent OHLC bars covering 80%.`, `${ru} 60 сессий, минимум 20 согласованных баров OHLC и 80% покрытие.`];
  return group('range', 'Range-based volatility', 'Волатильность по диапазону', [
    item('parkinson', 'Parkinson', 'Паркинсон', est.parkinson, 'pct', ...hint('High–low estimator; ignores overnight gaps.', 'Оценка по максимуму и минимуму; без ночных гэпов.'), 'σ² = mean(ln(H/L)²)/(4 ln 2)'),
    item('garmanKlass', 'Garman–Klass', 'Гарман–Класс', est.garmanKlass, 'pct', ...hint('OHLC estimator without overnight gaps.', 'Оценка по OHLC без ночных гэпов.'), 'σ² = mean(½ln(H/L)² − (2ln2−1)ln(C/O)²)'),
    item('rogersSatchell', 'Rogers–Satchell', 'Роджерс–Сэтчелл', est.rogersSatchell, 'pct', ...hint('Allows drift within the day.', 'Допускает дрейф внутри дня.'), 'σ² = mean(ln(H/C)ln(H/O) + ln(L/C)ln(L/O))'),
    item('yangZhang', 'Yang–Zhang', 'Ян–Чжан', est.yangZhang, 'pct', ...hint('Combines overnight, open-to-close and Rogers–Satchell variance.', 'Сочетает ночную, дневную дисперсии и Роджерса–Сэтчелла.'), 'σ² = σ_o² + k·σ_c² + (1−k)·σ_RS²'),
    item('closeToClose60', 'Close-to-close (same window)', 'По закрытиям (то же окно)', ctx.logs.length >= 60 ? annualPct(stdev(ctx.logs.slice(-60))) : null, 'pct', 'Reference for the range estimators. Min 60.', 'Эталон для сравнения. Минимум 60.', 'sd(r)·√252'),
    item('overnightShare', 'Overnight share of variance', 'Ночная доля дисперсии', est.overnightShare, 'pct', ...hint('Close-to-open variance in the sum of both parts.', 'Дисперсия закрытие–открытие в сумме двух частей.'), 'σ_o² / (σ_o² + σ_c²)'),
    item('atr14', 'ATR (14)', 'ATR (14)', atr, 'price', 'Wilder average true range in quote units. Min 14 consecutive bars.', 'Средний истинный диапазон по Уайлдеру в единицах котировки. Минимум 14 баров подряд.', 'ATR = (13·ATR + TR)/14'),
    item('atrPct', 'ATR, % of price', 'ATR, % от цены', atr === null ? null : (100 * atr) / lastOf(closes), 'pct', 'Min 14 consecutive bars.', 'Минимум 14 баров подряд.', 'ATR / C'),
    item('dailyRange20', 'Average daily range', 'Средний дневной диапазон', recent.length >= 15 ? 100 * mean(recent.map((b) => (b.h - b.l) / b.c)) : null, 'pct', 'Last 20 sessions, min 15 valid bars.', '20 сессий, минимум 15 корректных баров.', 'mean((H − L)/C)'),
  ]);
}

function trendGroup(ctx) {
  const { bars, closes, days, indicators: ind } = ctx;
  const price = lastOf(closes);
  const distance = (v) => pctChange(price, v);
  const sma20 = lastOf(ind.sma20);
  const sma50 = lastOf(ind.sma50);
  const sma200 = lastOf(ind.sma200);
  const macd = lastOf(ind.macd.line);
  const sd20 = closes.length >= 20 ? populationSd(closes.slice(-20)) : null;
  const trend = closes.length >= 60 ? ols(Array.from({ length: 60 }, (_, i) => i), closes.slice(-60).map(Math.log)) : null;
  const stoch = stochastic(bars, 14);
  return group('trend', 'Trend and momentum', 'Тренд и импульс', [
    item('smaDistance20', 'Distance to SMA 20', 'Отклонение от SMA 20', distance(sma20), 'pct', 'Price over its 20-session mean. Min 20.', 'Цена к средней за 20 сессий. Минимум 20.', 'C / SMA20 − 1'),
    item('smaDistance50', 'Distance to SMA 50', 'Отклонение от SMA 50', distance(sma50), 'pct', 'Price over its 50-session mean. Min 50.', 'Цена к средней за 50 сессий. Минимум 50.', 'C / SMA50 − 1'),
    item('smaDistance200', 'Distance to SMA 200', 'Отклонение от SMA 200', distance(sma200), 'pct', 'Price over its 200-session mean. Min 200.', 'Цена к средней за 200 сессий. Минимум 200.', 'C / SMA200 − 1'),
    item('smaSpread', 'SMA 50 against SMA 200', 'SMA 50 к SMA 200', pctChange(sma50, sma200), 'pct', 'Positive after a “golden cross”. Min 200.', 'Больше нуля после «золотого креста». Минимум 200.', 'SMA50 / SMA200 − 1'),
    item('momentum12m1', 'Momentum 12–1', 'Импульс 12–1', momentum(days, closes, 12, 1), 'pct', 'Return from 12 months ago to 1 month ago. Needs about a year.', 'Доходность от 12 до 1 месяца назад. Нужен примерно год.', 'C_{−1m} / C_{−12m} − 1'),
    item('momentum6m1', 'Momentum 6–1', 'Импульс 6–1', momentum(days, closes, 6, 1), 'pct', 'Return from 6 months ago to 1 month ago.', 'Доходность от 6 до 1 месяца назад.', 'C_{−1m} / C_{−6m} − 1'),
    item('rsi14', 'RSI (14)', 'RSI (14)', lastOf(ind.rsi), 'num', 'Wilder relative strength, 0–100. Min 15 closes.', 'Индекс относительной силы Уайлдера, 0–100. Минимум 15 закрытий.', 'RSI = 100·G/(G+L)'),
    item('macd', 'MACD (12, 26)', 'MACD (12, 26)', macd, 'price', 'Difference of exponential means, quote units. Min 26.', 'Разность экспоненциальных средних, в единицах цены. Минимум 26.', 'EMA12 − EMA26'),
    item('macdSignal', 'MACD signal (9)', 'Сигнальная линия MACD (9)', lastOf(ind.macd.signal), 'price', 'EMA of MACD. Min 34.', 'EMA от MACD. Минимум 34.', 'EMA9(MACD)'),
    item('macdHist', 'MACD histogram', 'Гистограмма MACD', lastOf(ind.macd.hist), 'price', 'MACD minus signal. Min 34.', 'MACD минус сигнальная. Минимум 34.', 'MACD − signal'),
    item('macdPct', 'MACD, % of price', 'MACD, % от цены', macd === null ? null : (100 * macd) / price, 'pct', 'Comparable across price levels. Min 26.', 'Сопоставимо при разных ценах. Минимум 26.', 'MACD / C'),
    item('stochasticK', 'Stochastic %K (14)', 'Стохастик %K (14)', stoch.k, 'num', 'Close inside the 14-session high–low range, 0–100. Needs OHLC.', 'Положение закрытия в диапазоне 14 сессий, 0–100. Нужны OHLC.', '100·(C − LL)/(HH − LL)'),
    item('stochasticD', 'Stochastic %D (3)', 'Стохастик %D (3)', stoch.d, 'num', 'Mean of the last three %K. Min 16 bars.', 'Среднее трёх последних %K. Минимум 16 баров.', 'SMA3(%K)'),
    item('williamsR', 'Williams %R (14)', 'Williams %R (14)', stoch.k === null ? null : stoch.k - 100, 'num', 'From −100 (at the low) to 0 (at the high). Needs OHLC.', 'От −100 (у минимума) до 0 (у максимума). Нужны OHLC.', '−100·(HH − C)/(HH − LL)'),
    item('bollingerB', 'Bollinger %B', 'Боллинджер %B', sd20 > TINY ? (price - (sma20 - 2 * sd20)) / (4 * sd20) : null, 'ratio', '0 at the lower band, 1 at the upper. Min 20.', '0 — нижняя полоса, 1 — верхняя. Минимум 20.', '(C − lower)/(upper − lower)'),
    item('bollingerWidth', 'Bollinger band width', 'Ширина полос Боллинджера', sd20 === null ? null : (400 * sd20) / sma20, 'pct', 'Band width relative to the middle line. Min 20.', 'Ширина полос к средней линии. Минимум 20.', '4·σ20 / SMA20'),
    item('trendSlope', 'Trend slope, annualised', 'Наклон тренда, годовой', trend ? Math.expm1(trend.slope * YEAR) * 100 : null, 'pct', 'Fit of log price on time over 60 sessions. Min 60.', 'Регрессия логарифма цены на время, 60 сессий. Минимум 60.', 'ln C = a + b·t; e^{252b} − 1'),
    item('trendT', 'Trend t-statistic', 't-статистика тренда', trend?.slopeT, 'ratio', 'Overstated: price residuals are autocorrelated. Descriptive only.', 'Завышена: остатки цен автокоррелированы. Только описательно.', 't = b / se(b)'),
    item('trendR2', 'Trend R²', 'R² тренда', trend?.r2, 'ratio', 'How straight the last 60 sessions were.', 'Насколько прямым был ход за 60 сессий.', 'R²'),
  ]);
}

function populationSd(xs) {
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / xs.length);
}

function liquidityGroup(ctx) {
  const { rows, currency } = ctx;
  const [factor, unit] = MINOR_UNITS[currency] ?? [1, currency || null];
  const money = unit ?? 'quote currency';
  const moneyRu = unit ?? 'валюте котировки';
  const traded = (list) => list.filter((r) => positive(r.v));
  const average = (n, min) => {
    const part = traded(rows.slice(-n));
    return part.length >= min ? mean(part.map((r) => r.v)) : null;
  };
  const avg20 = average(20, 15);
  const avg60 = average(60, 45);
  const avg120 = average(120, 90);
  const last = lastOf(rows);
  const before20 = traded(rows.slice(-21, -1));
  const before60 = traded(rows.slice(-61, -1)).map((r) => Math.log(r.v));
  const logSd = before60.length >= 20 ? stdev(before60) : null;
  const volumeZ = positive(last.v) && logSd > TINY ? (Math.log(last.v) - mean(before60)) / logSd : null;
  const dollars = (list) => traded(list).map((r) => r.v * r.c * factor);
  const d20 = dollars(rows.slice(-20));
  const d60 = dollars(rows.slice(-60));
  const impact = rows.slice(-60).filter((r) => positive(r.v) && isNum(r.s))
    .map((r) => (Math.abs(Math.expm1(r.s)) * 100) / ((r.v * r.c * factor) / 1e9));
  const recent = rows.slice(-60);
  const volumePoints = recent.map((r, i) => [i, r.v]).filter(([, v]) => positive(v));
  const volumeFit = volumePoints.length >= 40
    ? ols(volumePoints.map(([i]) => i), volumePoints.map(([, v]) => Math.log(v))) : null;
  // On-balance volume restarts at zero: only its slope is meaningful.
  const window = rows.slice(-61);
  let obv = 0;
  const path = [];
  const used = [];
  let upVolume = 0;
  let downVolume = 0;
  for (let i = 1; i < window.length; i += 1) {
    const { v, c } = window[i];
    if (!isNum(v) || v < 0) continue;
    const direction = Math.sign(c - window[i - 1].c);
    obv += direction * v;
    path.push([i, obv]);
    used.push(v);
    if (direction > 0) upVolume += v;
    if (direction < 0) downVolume += v;
  }
  const volumeMean = used.length >= 40 ? mean(used) : null;
  const obvFit = volumeMean > 0 ? ols(path.map((p) => p[0]), path.map((p) => p[1])) : null;
  const reported = recent.filter((r) => isNum(r.v));
  const zeroShare = reported.length >= 20 && traded(rows).length ? (100 * reported.filter((r) => r.v === 0).length) / reported.length : null;
  const tp = rows.slice(-20).filter((r) => positive(r.v) && validBar(r));
  const vwap = tp.length >= 15 ? sum(tp.map((r) => ((r.h + r.l + r.c) / 3) * r.v)) / sum(tp.map((r) => r.v)) : null;
  return group('liquidity', 'Liquidity and volume', 'Ликвидность и объём', [
    item('lastVolume', 'Latest volume', 'Последний объём', positive(last.v) ? last.v : null, 'num', 'Shares in the last completed session.', 'Акций за последнюю завершённую сессию.', 'V_t'),
    item('avgVolume20', 'Average volume, 20', 'Средний объём, 20', avg20, 'num', 'Shares per session, min 15 of 20.', 'Акций за сессию, минимум 15 из 20.', 'mean(V)'),
    item('avgVolume60', 'Average volume, 60', 'Средний объём, 60', avg60, 'num', 'Shares per session, min 45 of 60.', 'Акций за сессию, минимум 45 из 60.', 'mean(V)'),
    item('volumeRatio', 'Volume against median', 'Объём к медиане', positive(last.v) && before20.length >= 10 ? last.v / median(before20.map((r) => r.v)) : null, 'ratio', 'Last session over the median of the 20 before, min 10.', 'Последняя сессия к медиане 20 предыдущих, минимум 10.', 'V_t / median(V)'),
    item('volumeZ', 'Volume z-score', 'z-оценка объёма', volumeZ, 'ratio', 'Log volume against the 60 sessions before, min 20.', 'Лог-объём против 60 предыдущих сессий, минимум 20.', 'z = (ln V_t − μ)/σ'),
    item('dollarVolume20', 'Average traded value, 20', 'Средний оборот в деньгах, 20', d20.length >= 15 ? mean(d20) : null, 'money', `Close × volume in ${money}, min 15 of 20.`, `Закрытие × объём в ${moneyRu}, минимум 15 из 20.`, 'mean(C·V)'),
    item('medianDollarVolume60', 'Median traded value, 60', 'Медианный оборот, 60', d60.length >= 45 ? median(d60) : null, 'money', `Close × volume in ${money}, min 45 of 60.`, `Закрытие × объём в ${moneyRu}, минимум 45 из 60.`, 'median(C·V)'),
    item('amihud', 'Amihud illiquidity', 'Неликвидность Амихуда', impact.length >= 20 ? mean(impact) : null, 'num', `Percent price move per 1 billion ${money} traded, 60 sessions, min 20. Not comparable across currencies.`, `Движение цены в % на 1 млрд ${moneyRu} оборота, 60 сессий, минимум 20. Между валютами не сравнивать.`, 'mean(|R|% / (C·V/10⁹))'),
    item('volumeTrend', 'Volume trend, 20 vs 120', 'Тренд объёма, 20 к 120', ratioOf(avg20, avg120), 'ratio', 'Recent activity against half a year. Not share turnover: share count is unknown. Min 120.', 'Недавняя активность против полугода. Это не оборачиваемость: число акций неизвестно. Минимум 120.', 'mean20(V)/mean120(V)'),
    item('volumeSlope', 'Volume growth per month', 'Рост объёма за месяц', volumeFit ? Math.expm1(volumeFit.slope * 21) * 100 : null, 'pct', 'Fit of log volume over 60 sessions, min 40.', 'Тренд лог-объёма за 60 сессий, минимум 40.', 'ln V = a + b·t; e^{21b} − 1'),
    item('obvSlope', 'On-balance volume slope', 'Наклон OBV', obvFit ? obvFit.slope / volumeMean : null, 'ratio', 'OBV change per session in average volumes, 60 sessions, min 40. Between −1 and 1 for steady flow.', 'Изменение OBV за сессию в средних объёмах, 60 сессий, минимум 40. Около −1…1.', 'slope(Σ sign(ΔC)·V) / mean(V)'),
    item('upDownVolume', 'Up / down volume', 'Объём на росте / падении', volumeMean > 0 && downVolume > 0 ? upVolume / downVolume : null, 'ratio', 'Volume on rising over falling sessions, 60, min 40.', 'Объём растущих дней к падающим, 60 сессий, минимум 40.', 'ΣV⁺ / ΣV⁻'),
    item('zeroVolumeShare', 'Sessions without volume', 'Сессии без объёма', zeroShare, 'pct', 'Share of zero-volume bars in the last 60, min 20.', 'Доля баров с нулевым объёмом за 60 сессий, минимум 20.', 'share(V = 0)'),
    item('vwapDistance20', 'Distance to VWAP 20', 'Отклонение от VWAP 20', pctChange(last.c, vwap), 'pct', 'Close against the volume-weighted typical price of 20 sessions, min 15.', 'Закрытие к средневзвешенной по объёму типичной цене за 20 сессий, минимум 15.', 'C / (Σ TP·V / ΣV) − 1'),
  ]);
}

function levelGroup(ctx) {
  const { days, closes } = ctx;
  const lastDay = lastOf(days);
  const price = lastOf(closes);
  // A "52-week" level needs a history that really spans the year.
  const covered = days[0] <= lastDay - 365 + START_GRACE;
  const first = covered ? days.findIndex((d) => d > lastDay - 365) : -1;
  const part = covered ? closes.slice(first) : [];
  const high = covered ? Math.max(...part) : null;
  const low = covered ? Math.min(...part) : null;
  const since = (v) => (covered ? part.length - 1 - part.lastIndexOf(v) : null);
  const hint = ['Closing prices of the last 365 days; needs a full year of history.', 'Цены закрытия за последние 365 дней; нужен полный год истории.'];
  return group('levels', 'Price levels', 'Ценовые уровни', [
    item('lastClose', 'Last close', 'Последнее закрытие', price, 'price', 'Last completed session, quote units.', 'Последняя завершённая сессия, единицы котировки.', 'C_t'),
    item('high52w', '52-week high', 'Максимум 52 недель', high, 'price', ...hint, 'max(C)'),
    item('low52w', '52-week low', 'Минимум 52 недель', low, 'price', ...hint, 'min(C)'),
    item('distanceHigh52w', 'From 52-week high', 'От максимума 52 недель', pctChange(price, high), 'pct', ...hint, 'C / max − 1'),
    item('distanceLow52w', 'Above 52-week low', 'Над минимумом 52 недель', pctChange(price, low), 'pct', ...hint, 'C / min − 1'),
    item('rangePosition52w', 'Position in 52-week range', 'Позиция в диапазоне', covered && high > low ? (100 * (price - low)) / (high - low) : null, 'pct', ...hint, '(C − min)/(max − min)'),
    item('closePercentile52w', 'Percentile of the close', 'Перцентиль закрытия', covered ? (100 * part.filter((c) => c <= price).length) / part.length : null, 'pct', 'Share of the year’s closes at or below the current one.', 'Доля закрытий за год не выше текущего.', 'share(C_s ≤ C_t)'),
    item('sessionsSinceHigh', 'Sessions since high', 'Сессий с максимума', since(high), 'days', ...hint, 't − argmax C'),
    item('sessionsSinceLow', 'Sessions since low', 'Сессий с минимума', since(low), 'days', ...hint, 't − argmin C'),
  ]);
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

function tally(list, key) {
  const map = new Map();
  for (const event of list) {
    const name = String(event[key] || 'unknown');
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(event);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
}

/** Headline tone in -1..1; filings carry none. */
const tones = (list) => list.filter((e) => e.source !== FILING_SOURCE && isNum(e.sentiment)).map((e) => e.sentiment);

export function newsStatistics(events, nowMs) {
  const month = (events || []).filter((e) => e && isNum(e.time) && e.time <= nowMs && nowMs - e.time < 30 * DAY);
  const row = (list) => ({ count: list.length, meanTone: round(meanOf(tones(list))) });
  const today = Math.floor(nowMs / DAY);
  const byDay = new Map();
  for (const e of month) {
    const day = Math.floor(e.time / DAY);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const available = Array.isArray(events);
  return {
    byType: tally(month, 'type').map(([type, list]) => ({ type, ...row(list) })),
    bySource: tally(month, 'source').slice(0, 15).map(([source, list]) => ({ source, ...row(list) })),
    byLang: tally(month, 'lang').map(([lang, list]) => ({ lang, count: list.length })),
    daily: available ? Array.from({ length: 30 }, (_, i) => {
      const day = today - 29 + i;
      return { time: day * DAY, ...row(byDay.get(day) ?? []) };
    }) : [],
  };
}

function newsGroup(ctx) {
  const { events, nowMs } = ctx;
  const available = Array.isArray(events);
  const past = (events || []).filter((e) => e && isNum(e.time) && e.time <= nowMs);
  const within = (days) => past.filter((e) => nowMs - e.time < days * DAY);
  const month = within(30);
  const week = within(7);
  const earlier = month.filter((e) => nowMs - e.time >= 7 * DAY);
  const tone = tones(month);
  const weekTone = tones(week);
  const earlierTone = tones(earlier);
  const share = (test) => (tone.length >= 5 ? (100 * tone.filter(test).length) / tone.length : null);
  const sources = tally(month, 'source').map(([, list]) => list.length / month.length);
  const enough = month.length >= 5;
  const entropy = enough ? -sum(sources.map((p) => p * Math.log2(p))) : null;
  const count = (v) => (available ? v : null);
  const typed = (type) => month.filter((e) => e.type === type).length;
  const hint = (en, ru) => [`${en} Last 30 days of the supplied headlines.`, `${ru} Последние 30 дней переданных заголовков.`];
  return group('news', 'News flow', 'Новостной поток', [
    item('newsCount24h', 'Stories, 24 hours', 'Сюжетов за 24 часа', count(within(1).length), 'num', 'Stories found by the news search; a lower bound.', 'Сюжеты из поиска новостей; нижняя оценка.', 'count'),
    item('newsCount7d', 'Stories, 7 days', 'Сюжетов за 7 дней', count(week.length), 'num', 'Stories found by the news search; a lower bound.', 'Сюжеты из поиска новостей; нижняя оценка.', 'count'),
    item('newsCount30d', 'Stories, 30 days', 'Сюжетов за 30 дней', count(month.length), 'num', 'Stories found by the news search; a lower bound.', 'Сюжеты из поиска новостей; нижняя оценка.', 'count'),
    item('newsAcceleration', 'News acceleration', 'Ускорение потока', earlier.length >= 5 ? week.length / 7 / (earlier.length / 23) : null, 'ratio', 'Daily rate of the last 7 days over the 23 before, min 5 earlier stories. Search results favour recent items.', 'Темп за 7 дней к темпу 23 предыдущих, минимум 5 ранних сюжетов. Поиск отдаёт предпочтение свежему.', '(n7/7) / (n_prev/23)'),
    item('toneMean30d', 'Mean tone, 30 days', 'Средний тон, 30 дней', meanOf(tone, 3), 'ratio', ...hint('From −1 to 1, filings excluded, min 3.', 'От −1 до 1, без отчётов SEC, минимум 3.'), 'mean(s)'),
    item('toneMean7d', 'Mean tone, 7 days', 'Средний тон, 7 дней', meanOf(weekTone, 3), 'ratio', 'From −1 to 1, min 3 stories.', 'От −1 до 1, минимум 3 сюжета.', 'mean(s)'),
    item('toneChange', 'Tone change', 'Изменение тона', weekTone.length >= 3 && earlierTone.length >= 3 ? mean(weekTone) - mean(earlierTone) : null, 'ratio', 'Last 7 days minus the 23 before, min 3 each.', '7 дней минус 23 предыдущих, минимум по 3.', 'mean(s7) − mean(s_prev)'),
    item('toneDispersion', 'Tone dispersion', 'Разброс тона', sdOf(tone, 5), 'ratio', ...hint('Standard deviation of tone, min 5.', 'Стандартное отклонение тона, минимум 5.'), 'sd(s)'),
    item('positiveShare', 'Positive stories', 'Позитивные сюжеты', share((s) => s > 0), 'pct', ...hint('Share with tone above 0, min 5.', 'Доля с тоном выше 0, минимум 5.'), 'share(s > 0)'),
    item('negativeShare', 'Negative stories', 'Негативные сюжеты', share((s) => s < 0), 'pct', ...hint('Share with tone below 0, min 5.', 'Доля с тоном ниже 0, минимум 5.'), 'share(s < 0)'),
    item('sourceCount', 'Distinct sources', 'Разных источников', count(sources.length), 'num', ...hint('Outlets named as the main source.', 'Издания, указанные основным источником.'), 'count'),
    item('sourceEntropy', 'Source entropy, bits', 'Энтропия источников, бит', entropy, 'num', ...hint('Higher means coverage is spread wider, min 5.', 'Чем выше, тем шире покрытие, минимум 5.'), 'H = −Σ p·log₂p'),
    item('sourceEvenness', 'Source evenness', 'Равномерность источников', enough && sources.length > 1 ? entropy / Math.log2(sources.length) : null, 'ratio', ...hint('Entropy over its maximum, 0–1; needs 2 sources and 5 stories.', 'Энтропия к максимуму, 0–1; нужно 2 источника и 5 сюжетов.'), 'H / log₂K'),
    item('sourceConcentration', 'Source concentration (HHI)', 'Концентрация источников (HHI)', enough ? sum(sources.map((p) => p * p)) : null, 'ratio', ...hint('1 means a single outlet, min 5.', '1 — одно издание, минимум 5.'), 'HHI = Σp²'),
    item('languageCount', 'Languages', 'Языков', count(tally(month, 'lang').length), 'num', ...hint('Distinct headline languages.', 'Разных языков заголовков.'), 'count'),
    item('leadershipNews', 'Leadership stories', 'Сюжеты о руководстве', count(typed('leadership')), 'num', ...hint('Classified as management changes.', 'Классифицированы как кадровые.'), 'count'),
    item('scandalNews', 'Scandal stories', 'Сюжеты о скандалах', count(typed('scandal')), 'num', ...hint('Classified as scandals.', 'Классифицированы как скандалы.'), 'count'),
    item('regulationNews', 'Regulation stories', 'Сюжеты о регулировании', count(typed('regulation')), 'num', ...hint('Classified as regulation.', 'Классифицированы как регулирование.'), 'count'),
    item('filingShare', 'Official filings share', 'Доля официальных отчётов', enough ? (100 * month.filter((e) => e.source === FILING_SOURCE).length) / month.length : null, 'pct', ...hint('SEC EDGAR items, min 5.', 'Записи SEC EDGAR, минимум 5.'), 'filings / n'),
  ]);
}

// ---------------------------------------------------------------------------
// Chart data
// ---------------------------------------------------------------------------

function buildSeries(ctx) {
  const { rows, closes, indicators: ind } = ctx;
  const n = rows.length;
  const logs = rows.map((r) => r.s);
  const sd20 = closes.map((_, i) => (i >= 19 ? populationSd(closes.slice(i - 19, i + 1)) : null));
  const rollVol = logs.map((_, i) => (i >= 20 ? annualPct(stdev(logs.slice(i - 19, i + 1))) : null));
  const beta = new Array(n).fill(null);
  const corr = new Array(n).fill(null);
  const sharpe = new Array(n).fill(null);
  const start = Math.max(0, n - SERIES_LENGTH);
  for (let i = Math.max(start, 59); i < n; i += 1) {
    const window = rows.slice(i - 59, i + 1);
    const pairs = window.filter((r) => isNum(r.s) && isNum(r.m));
    if (pairs.length >= 50) {
      const fit = ols(pairs.map((r) => Math.expm1(r.m)), pairs.map((r) => Math.expm1(r.s)));
      beta[i] = fit?.slope ?? null;
      corr[i] = fit?.correlation ?? null;
    }
    if (i >= 60) {
      const r = window.map((row) => Math.expm1(row.s));
      const sd = stdev(r);
      sharpe[i] = sd > TINY ? (mean(r) / sd) * Math.sqrt(YEAR) : null;
    }
  }
  const relative = rows.map((r) => (positive(r.bench) ? r.c / r.bench : null));
  const anchor = relative.slice(start).find((v) => v !== null);
  const tail = (xs, digits = 4) => xs.slice(start).map((v) => round(v, digits));
  return {
    time: rows.slice(start).map((r) => r.t),
    close: tail(closes),
    sma20: tail(ind.sma20),
    sma50: tail(ind.sma50),
    sma200: tail(ind.sma200),
    bollUpper: tail(ind.sma20.map((v, i) => (v === null ? null : v + 2 * sd20[i]))),
    bollLower: tail(ind.sma20.map((v, i) => (v === null ? null : v - 2 * sd20[i]))),
    rsi14: tail(ind.rsi),
    macd: tail(ind.macd.line),
    macdSignal: tail(ind.macd.signal),
    macdHist: tail(ind.macd.hist),
    drawdownPct: tail(drawdownStats(closes).series),
    rollVolPct: tail(rollVol),
    rollBeta60: tail(beta),
    rollCorr60: tail(corr),
    rollSharpe60: tail(sharpe),
    relativeStrength: tail(relative.map((v) => (v === null || !anchor ? null : (100 * v) / anchor))),
    volume: rows.slice(start).map((r) => r.v),
  };
}

/** Counts of daily log returns in 31 bins over mean ± 4 sd; end bins hold the tails. */
export function returnHistogram(xs, bins = 31) {
  const empty = { edgesPct: [], counts: [], normalExpected: [] };
  if (xs.length < 30) return empty;
  const m = mean(xs);
  const sd = stdev(xs);
  if (!(sd > TINY)) return empty;
  const width = (8 * sd) / bins;
  const low = m - 4 * sd;
  const counts = new Array(bins).fill(0);
  for (const x of xs) counts[Math.min(bins - 1, Math.max(0, Math.floor((x - low) / width)))] += 1;
  const edges = Array.from({ length: bins + 1 }, (_, i) => low + i * width);
  const expected = counts.map((_, i) => {
    const from = i === 0 ? 0 : normalCdf((edges[i] - m) / sd);
    const to = i === bins - 1 ? 1 : normalCdf((edges[i + 1] - m) / sd);
    return round(xs.length * (to - from), 4);
  });
  return { edgesPct: edges.map((e) => round(e * 100, 4)), counts, normalExpected: expected };
}

/** Standardised sample quantiles against Blom plotting positions of the normal. */
export function normalQQ(xs) {
  const n = xs.length;
  const sd = n >= 30 ? stdev(xs) : null;
  if (!(sd > TINY)) return { theoretical: [], sample: [] };
  const m = mean(xs);
  return {
    theoretical: xs.map((_, i) => round(normalQuantile((i + 0.625) / (n + 0.25)), 4)),
    sample: [...xs].sort((a, b) => a - b).map((x) => round((x - m) / sd, 4)),
  };
}

/** Calendar-month returns, month-end close to month-end close; the last one is month to date. */
function monthlyReturns(rows) {
  const ends = [];
  for (const row of rows) {
    const date = new Date(row.day * DAY);
    const key = date.getUTCFullYear() * 12 + date.getUTCMonth();
    if (lastOf(ends)?.key === key) ends[ends.length - 1] = { key, row, bench: row.benchAsOf };
    else ends.push({ key, row, bench: row.benchAsOf });
  }
  const out = [];
  for (let i = 1; i < ends.length; i += 1) {
    const { key, row, bench } = ends[i];
    const prev = ends[i - 1];
    if (key - prev.key !== 1) continue;
    out.push({
      year: Math.floor(key / 12),
      month: (key % 12) + 1,
      returnPct: round(pctChange(row.c, prev.row.c)),
      benchmarkPct: round(pctChange(bench, prev.bench)),
    });
  }
  return out.slice(-MONTHS_SHOWN);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Completed sessions with OHLCV, log returns and benchmark closes. */
function completedRows(history, benchmarkHistory, nowMs) {
  const source = (history || [])
    .filter((b) => b && isNum(b.t) && positive(b.c))
    .sort((a, b) => a.t - b.t);
  const timed = withCloseTimes(source);
  const full = source.filter((_, i) => timed[i].closeAt <= nowMs);
  const returns = alignedReturns(source, benchmarkHistory, nowMs);
  const bench = withCloseTimes(benchmarkHistory).filter((b) => b.closeAt <= nowMs);
  const benchDays = bench.map((b) => b.day);
  const exact = new Map(bench.map((b) => [b.day, b.c]));
  const rows = returns.map((r, i) => {
    const at = lastOnOrBefore(benchDays, r.day);
    return {
      t: full[i].t,
      day: r.day,
      closeAt: r.closeAt,
      o: full[i].o ?? null,
      h: full[i].h ?? null,
      l: full[i].l ?? null,
      c: r.c,
      v: r.v,
      s: r.s,
      m: r.m,
      bench: exact.get(r.day) ?? null,
      benchAsOf: at >= 0 && r.day - benchDays[at] <= START_GRACE ? bench[at].c : null,
    };
  });
  return { rows, benchDays, benchCloses: bench.map((b) => b.c) };
}

/**
 * @param {{history: object[], benchmarkHistory?: object[], events?: object[], currency?: string}} input
 * @returns {object|null} null with fewer than two completed sessions
 */
export function computeMetrics({ history, benchmarkHistory, events, currency } = {}, nowMs = Date.now()) {
  const { rows, benchDays, benchCloses } = completedRows(history, benchmarkHistory, nowMs);
  if (rows.length < 2) return null;
  const closes = rows.map((r) => r.c);
  const days = rows.map((r) => r.day);
  const logs = rows.slice(1).map((r) => r.s);
  const simple1y = logs.slice(-YEAR).map(Math.expm1);
  const pairs = rows.slice(-YEAR)
    .filter((r) => isNum(r.s) && isNum(r.m))
    .map((r) => ({ r: Math.expm1(r.s), b: Math.expm1(r.m) }));
  const periods = periodReturns(days, closes, benchDays, benchCloses);
  const ctx = {
    rows,
    bars: rows,
    closes,
    days,
    logs,
    simple1y,
    pairs,
    periods,
    events,
    currency,
    nowMs,
    dd1y: closes.length > 20 ? drawdownStats(closes.slice(-(YEAR + 1))) : null,
    indicators: {
      sma20: smaSeries(closes, 20),
      sma50: smaSeries(closes, 50),
      sma200: smaSeries(closes, 200),
      rsi: rsiSeries(closes, 14),
      macd: macdSeries(closes),
    },
  };
  return {
    asOf: rows[rows.length - 1].closeAt,
    sessions: rows.length,
    groups: [
      returnGroup(ctx),
      riskGroup(ctx),
      adjustedGroup(ctx),
      marketGroup(ctx),
      distributionGroup(ctx),
      rangeGroup(ctx),
      trendGroup(ctx),
      liquidityGroup(ctx),
      levelGroup(ctx),
      newsGroup(ctx),
    ],
    series: buildSeries(ctx),
    histogram: returnHistogram(logs),
    qq: normalQQ(logs),
    monthly: monthlyReturns(rows),
    periods,
    newsStats: newsStatistics(events, nowMs),
  };
}
