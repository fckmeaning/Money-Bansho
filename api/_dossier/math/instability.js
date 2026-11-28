// Country instability and risk index: pure mathematics, no I/O (edge safe, deterministic).
// Every function returns null when the data cannot support a number; nothing is defaulted.
// Formulas and limitations: docs/math/instability.md
import { quantile, seededRandom } from './stats.js';
import { ewmaVolatility, fitGarch } from './volatility.js';

/** Expert base weights, not fitted on history. They sum to 1. */
export const COMPONENTS = [
  { id: 'eqVol', group: 'equity', weight: 0.18, label: 'Условная волатильность акций' },
  { id: 'eqDrawdown', group: 'equity', weight: 0.15, label: 'Просадка индекса' },
  { id: 'eqShock', group: 'equity', weight: 0.12, label: 'Аномальное падение за 5 дней' },
  { id: 'fxVol', group: 'fx', weight: 0.12, label: 'Условная волатильность валюты' },
  { id: 'fxDep', group: 'fx', weight: 0.13, label: 'Аномальное ослабление за 21 день' },
  { id: 'newsVolume', group: 'news', weight: 0.12, label: 'Всплеск объёма новостей' },
  { id: 'newsTone', group: 'news', weight: 0.18, label: 'Доля негативных заголовков' },
];

export const PARAMS = {
  referenceWindow: 252, // observations of the own-history reference (ending the day before)
  referenceMin: 120,
  drawdownWindow: 126,
  shockDays: 5,
  fxDays: 21,
  softLimit: 3, // z' = c asinh(z / c): smooth, strictly increasing, no ties at a cap
  power: 2, // order of the power mean of component scores
  beta: 0.25, // logit shift per unit of the one-sided Mahalanobis stress
  minCorrelationShrinkage: 0.1,
  toneStrength: 20,
  minCoverage: 0.25, // below this share of weight no index is published
  block: 20,
  draws: 200,
  weightShape: 25, // gamma shape of the multiplicative weight perturbation (CV = 0.2)
  level: 0.9,
  clamp: 1e-12, // logit arguments stay inside [clamp, 1 - clamp]
  weightRange: 0.2, // relative change of every base weight in the exact sensitivity range
};

const NORMAL_90 = 1.6448536269514722;
const MAD_TO_SIGMA = 1.4826;
const MEAN_AD_TO_SIGMA = 1.2533;

function sortedMedian(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Median and 1.4826 MAD (mean absolute deviation when the MAD is zero, flagged as
 * `meanDeviation`); null for a flat sample.
 */
export function robustLocationScale(values) {
  const n = values.length;
  if (n < 2) return null;
  const buffer = Float64Array.from(values).sort();
  const centre = sortedMedian(buffer);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    buffer[i] = Math.abs(buffer[i] - centre);
    total += buffer[i];
  }
  let scale = MAD_TO_SIGMA * sortedMedian(buffer.sort());
  const meanDeviation = !(scale > 1e-12);
  if (meanDeviation) scale = MEAN_AD_TO_SIGMA * (total / n);
  return scale > 1e-12 ? { centre, scale, meanDeviation } : null;
}

export function robustZ(x, reference) {
  if (!Number.isFinite(x)) return null;
  const fit = robustLocationScale(reference);
  return fit ? (x - fit.centre) / fit.scale : null;
}

/** Smooth tail compression used in place of clipping. */
export const soften = (z) => PARAMS.softLimit * Math.asinh(z / PARAMS.softLimit);

/** Student t distribution function with 4 degrees of freedom (closed form). */
export function studentT4(t) {
  const q = 1 + (t * t) / 4;
  return 0.5 + 0.375 * (t / Math.sqrt(q)) * (1 - (t * t) / (12 * q));
}

/** Component score in (0, 100); z = 0 (typical) maps to 50. */
export const scoreFromZ = (z) => (Number.isFinite(z) ? 100 * studentT4(soften(z)) : null);

export const logit = (p) => Math.log(p / (1 - p));
export const logistic = (x) => 1 / (1 + Math.exp(-x));

/**
 * Removes isolated bad ticks: a move larger than 8 robust sigmas that the next bar takes
 * back almost entirely. The last bar is never removed (there is nothing to confirm it).
 */
export function despike(bars) {
  if (bars.length < 30) return { bars, removed: 0 };
  const returns = bars.slice(1).map((bar, i) => Math.log(bar.c / bars[i].c));
  const fit = robustLocationScale(returns);
  if (!fit) return { bars, removed: 0 };
  const bad = new Set();
  for (let i = 1; i < bars.length - 1; i += 1) {
    const into = returns[i - 1];
    const out = returns[i];
    if (Math.abs(into) > Math.max(8 * fit.scale, 0.03) && Math.abs(into + out) < 0.3 * Math.abs(into)) bad.add(i);
  }
  return { bars: bars.filter((_, i) => !bad.has(i)), removed: bad.size };
}

/** True when a currency is effectively pegged or not quoted: its moves carry no market information. */
export function isPegged(bars) {
  const tail = bars.slice(-253);
  if (tail.length < 60) return false;
  const returns = tail.slice(1).map((bar, i) => Math.log(bar.c / tail[i].c));
  const zeros = returns.filter((r) => Math.abs(r) < 1e-7).length / returns.length;
  const annual = Math.sqrt((returns.reduce((t, r) => t + r * r, 0) / returns.length) * 252);
  return zeros > 0.4 || annual < 0.01;
}

/**
 * Conditional daily sigma known at each close: GARCH(1,1)-t when the fit is usable,
 * otherwise RiskMetrics EWMA. sigma[t] is the forecast for the return after return t - 1.
 */
export function conditionalVolatility(returns) {
  const garch = fitGarch(returns);
  if (garch && garch.converged && garch.alpha > 0.01 && garch.persistence > 0.5) {
    return {
      sigmas: [...garch.sigmaSeries, garch.sigmaNext],
      model: { type: 'GARCH(1,1)-t', alpha: garch.alpha, beta: garch.beta, nu: garch.nu },
    };
  }
  const ewma = ewmaVolatility(returns);
  return ewma ? { sigmas: [...ewma.series, ewma.sigma], model: { type: 'EWMA', lambda: 0.94 } } : null;
}

/**
 * Features of a daily close series, aligned with `bars`; larger always means riskier.
 * kind 'equity': log conditional sigma, drawdown from the 126-day high, 5-day loss in units
 * of the sigma known before it. kind 'fx': log conditional sigma, 21-day depreciation in the
 * same units. `sign` is +1 when the quote rises as the local currency weakens, -1 for DXY.
 * `display` holds the same observations in human units.
 */
export function marketFeatures(bars, kind, sign = 1) {
  const n = bars.length;
  const empty = () => new Array(n).fill(null);
  const logs = bars.map((bar) => Math.log(bar.c));
  const returns = logs.slice(1).map((value, i) => value - logs[i]);
  const fit = conditionalVolatility(returns);
  const vol = empty();
  if (fit) {
    for (let i = 20; i < n; i += 1) if (fit.sigmas[i] > 0) vol[i] = Math.log(fit.sigmas[i]);
  }
  const abnormal = (days, direction) => {
    const values = empty();
    const percent = empty();
    for (let i = days; i < n; i += 1) {
      const move = direction * (logs[i] - logs[i - days]);
      percent[i] = 100 * move;
      if (vol[i - days] !== null) values[i] = move / (Math.exp(vol[i - days]) * Math.sqrt(days));
    }
    return { values, percent };
  };
  const annual = vol.map((x) => (x === null ? null : Math.exp(x) * Math.sqrt(252) * 100));
  if (kind === 'fx') {
    const dep = abnormal(PARAMS.fxDays, sign);
    return {
      features: { fxVol: vol, fxDep: dep.values },
      display: { fxVol: annual, fxDep: dep.percent },
      model: fit?.model ?? null,
    };
  }
  const drawdown = empty();
  for (let i = PARAMS.drawdownWindow - 1; i < n; i += 1) {
    let high = 0;
    for (let k = i - PARAMS.drawdownWindow + 1; k <= i; k += 1) high = Math.max(high, bars[k].c);
    drawdown[i] = 1 - bars[i].c / high;
  }
  const shock = abnormal(PARAMS.shockDays, -1);
  return {
    features: { eqVol: vol, eqDrawdown: drawdown, eqShock: shock.values },
    display: { eqVol: annual, eqDrawdown: drawdown.map((x) => (x === null ? null : 100 * x)), eqShock: shock.percent },
    model: fit?.model ?? null,
  };
}

/** Finite values among the `referenceWindow` observations before index i; null when too few. */
export function referenceAt(values, i) {
  const reference = [];
  for (let k = Math.max(0, i - PARAMS.referenceWindow); k < i; k += 1) {
    if (values[k] !== null) reference.push(values[k]);
  }
  return reference.length >= PARAMS.referenceMin ? reference : null;
}

/** z-score of every observation against its own past only (no look-ahead). */
export function zSeries(values) {
  return values.map((x, i) => {
    if (x === null) return null;
    const reference = referenceAt(values, i);
    return reference ? robustZ(x, reference) : null;
  });
}

// ---- correlation ------------------------------------------------------------------

/**
 * Pearson correlation of pooled pairs, demeaned within each group (country), and the
 * number of pairs. Groups are arrays of [x, y].
 */
export function pooledCorrelation(groups) {
  let xx = 0;
  let yy = 0;
  let xy = 0;
  let n = 0;
  for (const pairs of groups) {
    if (pairs.length < 2) continue;
    let mx = 0;
    let my = 0;
    for (const [x, y] of pairs) { mx += x; my += y; }
    mx /= pairs.length;
    my /= pairs.length;
    for (const [x, y] of pairs) {
      xx += (x - mx) ** 2;
      yy += (y - my) ** 2;
      xy += (x - mx) * (y - my);
    }
    n += pairs.length;
  }
  return xx > 0 && yy > 0 ? { r: xy / Math.sqrt(xx * yy), n } : null;
}

/**
 * Shrinkage of correlations towards the identity with the Schafer-Strimmer intensity
 * lambda = sum var(r) / sum r^2, var(r) = (1 - r^2)^2 / (n_eff - 1).
 */
export function shrinkageIntensity(estimates) {
  let noise = 0;
  let signal = 0;
  for (const { r, nEff } of estimates) {
    noise += (1 - r * r) ** 2 / Math.max(nEff - 1, 1);
    signal += r * r;
  }
  const lambda = signal > 0 ? noise / signal : 1;
  return Math.min(1, Math.max(PARAMS.minCorrelationShrinkage, lambda));
}

/** Gauss-Jordan inverse of a symmetric positive definite matrix; null if a pivot is not positive. */
export function invert(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c += 1) {
    const pivot = a[c][c];
    if (!(pivot > 1e-10)) return null;
    for (let j = 0; j < 2 * n; j += 1) a[c][j] /= pivot;
    for (let i = 0; i < n; i += 1) {
      if (i === c) continue;
      const factor = a[i][c];
      if (factor) for (let j = 0; j < 2 * n; j += 1) a[i][j] -= factor * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * One-sided Mahalanobis problem (Kudo): min over v <= 0 of (z - v)' P (z - v), written as
 * min y' P y subject to y >= z with y = z - v. Solved by coordinate descent. `point` is the
 * minimiser; for a positive definite P it is certified by y >= z, P y >= 0 and
 * (P y)_i (y_i - z_i) = 0 (Karush-Kuhn-Tucker conditions of a convex problem).
 */
export function oneSidedSolution(z, precision) {
  const n = z.length;
  const y = Float64Array.from(z, (value) => Math.max(value, 0));
  let sweeps = 0;
  while (sweeps < 5000) {
    sweeps += 1;
    let change = 0;
    for (let i = 0; i < n; i += 1) {
      let cross = 0;
      for (let j = 0; j < n; j += 1) if (j !== i) cross += precision[i][j] * y[j];
      const next = Math.max(z[i], -cross / precision[i][i]);
      change = Math.max(change, Math.abs(next - y[i]));
      y[i] = next;
    }
    if (change < 1e-12) break;
  }
  const point = [...y];
  const gradient = point.map((_, i) => precision[i].reduce((t, p, j) => t + p * point[j], 0));
  const total = point.reduce((t, value, i) => t + value * gradient[i], 0);
  return { point, gradient, distance: Math.sqrt(Math.max(total, 0)), sweeps };
}

/** Zero when nothing is above normal, non-decreasing in every z. */
export const oneSidedDistance = (z, precision) => oneSidedSolution(z, precision).distance;

// ---- aggregation ------------------------------------------------------------------

const identity = (n) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

// Everything that depends only on which components are present. A correlation matrix
// that is not positive definite cannot define a distance: the identity is used instead.
function structure(zs, components, correlation) {
  const present = components.filter((c) => Number.isFinite(zs[c.id]));
  const index = present.map((c) => COMPONENTS.findIndex((d) => d.id === c.id));
  const R = correlation ? index.map((i) => index.map((j) => correlation[i][j])) : identity(present.length);
  const inverse = invert(R);
  return { present, R, precision: inverse ?? identity(present.length), identityFallback: !inverse };
}

const redundancy = (R) => R.map((row) => row.reduce((t, r) => t + Math.max(r, 0), 0));

// Redundancy-adjusted weights: a component loses weight to the extent that others repeat it.
function adjustedWeights(base, R) {
  const sums = redundancy(R);
  const raw = base.map((w, i) => w / sums[i]);
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / total);
}

const clampShare = (p) => Math.min(1 - PARAMS.clamp, Math.max(PARAMS.clamp, p));

function powerMeanOf(scores, weights) {
  let sum = 0;
  for (let i = 0; i < scores.length; i += 1) sum += weights[i] * scores[i] ** PARAMS.power;
  return sum ** (1 / PARAMS.power);
}

// Q / 100 = logistic( logit(M / 100) + shift ), kept strictly inside (0, 1).
const lift = (powerMean, shift) => 100 * clampShare(logistic(logit(clampShare(powerMean / 100)) + shift));

// Aggregate of softened z.
function combine(z, scores, weights, precision) {
  const powerMean = powerMeanOf(scores, weights);
  const stress = oneSidedDistance(z, precision) / Math.sqrt(z.length);
  return { q: lift(powerMean, PARAMS.beta * stress), powerMean, stress };
}

const coverageOf = (present, components) => {
  const total = components.reduce((t, c) => t + c.weight, 0);
  const available = present.reduce((t, c) => t + c.weight, 0);
  return total > 0 ? Math.min(1, available / total) : 0;
};
const publishable = (present, coverage) => present.length > 0 && coverage >= PARAMS.minCoverage - 1e-9;

/**
 * Aggregate of the available components before country-level shrinkage, with exact Shapley
 * contributions: index - 50 = sum of contributions (an absent subset member is set to z = 0).
 * `zs` maps component id to its robust z; `correlation` is the 7x7 matrix in COMPONENTS order.
 */
export function composite(zs, { components = COMPONENTS, correlation = null, shapley = true } = {}) {
  const { present, R, precision } = structure(zs, components, correlation);
  const coverage = coverageOf(present, components);
  const empty = { index: null, coverage, weights: {}, contributions: {}, powerMean: null, stress: null };
  if (!publishable(present, coverage)) return empty;
  const k = present.length;
  const z = present.map((c) => soften(zs[c.id]));
  const scores = present.map((c) => scoreFromZ(zs[c.id]));
  const weights = adjustedWeights(present.map((c) => c.weight), R);
  const full = combine(z, scores, weights, precision);
  const contributions = {};
  if (shapley) {
    const values = Array.from({ length: 1 << k }, (_, mask) => combine(
      z.map((value, i) => (mask & (1 << i) ? value : 0)),
      scores.map((value, i) => (mask & (1 << i) ? value : 50)),
      weights,
      precision,
    ).q);
    const factorial = [1];
    for (let i = 1; i <= k; i += 1) factorial[i] = factorial[i - 1] * i;
    present.forEach((c, i) => {
      let phi = 0;
      for (let mask = 0; mask < 1 << k; mask += 1) {
        if (mask & (1 << i)) continue;
        let size = 0;
        for (let m = mask; m; m >>= 1) size += m & 1;
        phi += ((factorial[size] * factorial[k - size - 1]) / factorial[k]) * (values[mask | (1 << i)] - values[mask]);
      }
      contributions[c.id] = phi;
    });
  }
  return {
    index: full.q,
    coverage,
    weights: Object.fromEntries(present.map((c, i) => [c.id, weights[i]])),
    contributions,
    powerMean: full.powerMean,
    stress: full.stress,
  };
}

// ---- proof trace -------------------------------------------------------------------

/**
 * How the aggregate depends on the base weights, the components being fixed. D does not
 * depend on the weights, so:
 *   derivative[i] = dQ/dw_i = q (1 - q) / (m (1 - m)) * a_i (s_i^p - M^p) / (p w_i M^(p-1))
 *     (a: adjusted weights, q = Q/100, m = M/100); sum_i w_i derivative[i] = 0
 *   anyWeights: M lies between the lowest and the highest score for any positive weights
 *   range: exact extrema of Q when every base weight moves by at most `delta` (relative);
 *     M^p is linear-fractional in the weights, so the extrema are at the 2^k vertices.
 */
export function weightSensitivity({ base, R, scores, shift }, delta = PARAMS.weightRange) {
  const k = scores.length;
  const p = PARAMS.power;
  const weights = adjustedWeights(base, R);
  const powerMean = powerMeanOf(scores, weights);
  const q = lift(powerMean, shift) / 100;
  const m = clampShare(powerMean / 100);
  const slope = (q * (1 - q)) / (m * (1 - m));
  const derivative = scores.map((s, i) => (slope * weights[i] * (s ** p - powerMean ** p)) / (p * base[i] * powerMean ** (p - 1)));
  let low = Infinity;
  let high = -Infinity;
  for (let mask = 0; mask < 1 << k; mask += 1) {
    const moved = base.map((w, i) => w * (mask & (1 << i) ? 1 + delta : 1 - delta));
    const value = lift(powerMeanOf(scores, adjustedWeights(moved, R)), shift);
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return {
    derivative,
    anyWeights: [lift(Math.min(...scores), shift), lift(Math.max(...scores), shift)],
    delta,
    range: [low, high],
  };
}

/**
 * Every intermediate value of `composite` for display and verification, at full precision.
 * Arrays follow `ids`. When the coverage is too low only the inputs are returned.
 */
export function explainAggregate(zs, { components = COMPONENTS, correlation = null } = {}) {
  const { present, R, precision, identityFallback } = structure(zs, components, correlation);
  const coverage = coverageOf(present, components);
  const z = present.map((c) => zs[c.id]);
  const soft = z.map(soften);
  const scores = z.map(scoreFromZ);
  const base = present.map((c) => c.weight);
  const trace = {
    ids: present.map((c) => c.id),
    absent: components.filter((c) => !present.includes(c)).map((c) => c.id),
    z,
    soft,
    scores,
    base,
    coverage,
    published: publishable(present, coverage),
  };
  if (!trace.published) return trace;
  const rowSums = redundancy(R);
  const weights = adjustedWeights(base, R);
  const solution = oneSidedSolution(soft, precision);
  const powerMean = powerMeanOf(scores, weights);
  const stress = solution.distance / Math.sqrt(present.length);
  const shift = PARAMS.beta * stress;
  return {
    ...trace,
    rowSums,
    weights,
    R,
    precision,
    identityFallback,
    point: solution.point,
    gradient: solution.gradient,
    sweeps: solution.sweeps,
    distance: solution.distance,
    powerMean,
    stress,
    shift,
    q: lift(powerMean, shift),
    sensitivity: {
      ...weightSensitivity({ base, R, scores, shift }),
      // The aggregate without one component (null: the rest cover too little weight).
      leaveOneOut: present.map((c) => composite(
        Object.fromEntries(present.filter((d) => d !== c).map((d) => [d.id, zs[d.id]])),
        { components, correlation, shapley: false },
      ).index),
    },
  };
}

// ---- empirical Bayes --------------------------------------------------------------

/** Cross-country prior on the logit scale by the method of moments; null with under 5 countries. */
export function crossCountryPrior(estimates) {
  const n = estimates.length;
  if (n < 5) return null;
  const mean = estimates.reduce((t, e) => t + e.theta, 0) / n;
  const total = estimates.reduce((t, e) => t + (e.theta - mean) ** 2, 0) / (n - 1);
  const noise = estimates.reduce((t, e) => t + e.sigma ** 2, 0) / n;
  return { mean, tau2: Math.max(total - noise, 0.1 * total, 1e-6), countries: n };
}

/**
 * Normal-normal posterior of one country. Missing weight adds variance tau^2 (1 - C) / C, so
 * poorly covered countries move towards the prior and get a wider interval. With a prior
 * B = 1 / (1/C + sigma^2/tau^2) <= C. `variance`, `mean` and `half` are on the logit scale.
 */
export function posterior({ theta, sigma, coverage }, prior) {
  const covered = Math.min(1, coverage);
  const v = sigma ** 2 + (prior ? (prior.tau2 * (1 - covered)) / covered : 0);
  const reliability = prior ? prior.tau2 / (prior.tau2 + v) : 1;
  const mean = prior ? prior.mean + reliability * (theta - prior.mean) : theta;
  const half = NORMAL_90 * Math.sqrt(reliability * v);
  return {
    index: 100 * logistic(mean),
    low: 100 * logistic(mean - half),
    high: 100 * logistic(mean + half),
    reliability,
    variance: v,
    mean,
    half,
  };
}

// ---- news -------------------------------------------------------------------------

/**
 * Stratified permutation (Mantel) test that a country's headlines are unusually recent. One
 * stratum per feed: N headlines with recency scores summing to `sum` (squares to `squares`),
 * m of them about the country with score sum x. Feed mix and archive depth cancel.
 */
export function recencySurprise(strata) {
  let observed = 0;
  let expected = 0;
  let variance = 0;
  for (const { N, sum, squares, m, x } of strata) {
    if (N < 2 || m <= 0 || m >= N) continue;
    const mean = sum / N;
    const spread = Math.max(squares / N - mean * mean, 0);
    observed += x;
    expected += m * mean;
    variance += (m * spread * (N - m)) / (N - 1);
  }
  return variance > 1e-12 ? { z: (observed - expected) / Math.sqrt(variance), observed, expected, variance } : null;
}

/** Empirical-null deflation: headlines cluster into stories, so raw z-scores are over-dispersed. */
export function dispersion(zs) {
  const finite = zs.filter(Number.isFinite).map(Math.abs);
  if (finite.length < 5) return 1;
  return Math.max(1, MAD_TO_SIGMA * quantile(finite, 0.5));
}

/** Beta-binomial shrinkage of a share (n may be an effective sample size) towards the pooled one. */
export const shrunkShare = (k, n, pooled, strength = PARAMS.toneStrength) => (k + strength * pooled) / (n + strength);

// ---- uncertainty ------------------------------------------------------------------

// Marsaglia-Tsang gamma sampler (shape >= 1).
function gamma(shape, random) {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(random);
    const v = (1 + c * x) ** 3;
    if (v > 0 && Math.log(Math.max(random(), 1e-12)) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

function normal(random) {
  return Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
}

/** Circular moving-block resample, keeping the serial dependence of the reference. */
export function blockResample(values, random, block = PARAMS.block) {
  const n = values.length;
  const out = new Float64Array(n);
  for (let filled = 0; filled < n;) {
    const start = Math.floor(random() * n);
    for (let k = 0; k < block && filled < n; k += 1, filled += 1) out[filled] = values[(start + k) % n];
  }
  return out;
}

/**
 * Bootstrap standard error of logit(Q / 100). `inputs` maps a component id to one of
 *   { x, reference }                       market: block-resample the reference
 *   { z }                                  news volume: z plus standard normal sampling noise
 *   { share, n, pooled, centre, scale }    news tone: binomial resample of n headlines
 * Base weights are perturbed as well. Missing components are not simulated.
 */
export function bootstrapSigma(inputs, { draws = PARAMS.draws, seed = 1, correlation = null } = {}) {
  const random = seededRandom(seed);
  const present = COMPONENTS.filter((c) => inputs[c.id]);
  if (!present.length) return null;
  const { R, precision } = structure(Object.fromEntries(present.map((c) => [c.id, 0])), present, correlation);
  const samples = [];
  for (let b = 0; b < draws; b += 1) {
    const zs = present.map((c) => {
      const input = inputs[c.id];
      if (input.reference) return robustZ(input.x, blockResample(input.reference, random));
      if (input.n) {
        const trials = Math.max(1, Math.round(input.n));
        const p = shrunkShare(input.share * input.n, input.n, input.pooled);
        let k = 0;
        for (let i = 0; i < trials; i += 1) if (random() < p) k += 1;
        return (shrunkShare((k / trials) * input.n, input.n, input.pooled) - input.centre) / input.scale;
      }
      return input.z + normal(random);
    });
    const base = present.map((c) => c.weight * (gamma(PARAMS.weightShape, random) / PARAMS.weightShape));
    if (zs.some((z) => z === null)) continue;
    const { q } = combine(zs.map(soften), zs.map(scoreFromZ), adjustedWeights(base, R), precision);
    samples.push(logit(Math.min(1 - 1e-9, Math.max(1e-9, q / 100))));
  }
  if (samples.length < draws / 2) return null;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return Math.sqrt(samples.reduce((t, x) => t + (x - mean) ** 2, 0) / (samples.length - 1));
}
