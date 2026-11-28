// Bayesian online change-point detection (Adams & MacKay, 2007) for daily log returns.
// Gaussian segments with unknown mean and variance, Normal-Inverse-Gamma prior, Student-t
// predictive. Pure ESM (edge safe), deterministic.
//
// Run length r_t = number of observations in the current segment after seeing x_t; r_t = 0
// means "a new segment starts with the next observation" and has posterior mass exactly equal
// to the hazard, whatever the data. The signal is therefore P(r_t <= recent).
import { logGamma } from './special.js';
import { median, stdev } from './stats.js';

const MIN_OBS = 60;
const PRIOR_MEAN = 0;
const PRIOR_KAPPA = 0.1; // weak prior on the segment mean: sd = sigma / sqrt(kappa0)
const PRIOR_ALPHA = 2; // prior E[variance] = beta0 / (alpha0 - 1) = scale^2
const PRIOR_WINDOW = 50;
const MIN_PRIOR_WINDOW = 20;
const MAD_TO_SIGMA = 1.4826;
const TRUNCATION = 1e-8; // relative to the hazard
const MIN_SEGMENT = 10; // observations before a MAP segment counts as a break
const SAME_BREAK = 5; // start estimates this close describe the same break
const BREAK_SUPPORT = 0.5; // posterior mass required around a segment start

const isSeries = (xs) => (Array.isArray(xs) || ArrayBuffer.isView(xs)) && Array.prototype.every.call(xs, Number.isFinite);

/** Robust scale of the calibration window: MAD, falling back to the standard deviation. */
function priorScale(window) {
  const centre = median(window);
  const mad = MAD_TO_SIGMA * median(window.map((v) => Math.abs(v - centre)));
  return mad > 0 ? mad : stdev(window);
}

/**
 * Break bookkeeping, applied only when the most probable (MAP) segment holds at least
 * MIN_SEGMENT observations AND the posterior mass of segments starting within SAME_BREAK of
 * its start is at least BREAK_SUPPORT (a bare MAP mode can flip on a few percent of mass).
 * Then every recorded break later than start + SAME_BREAK is retracted (the current
 * explanation has no change there), a break within SAME_BREAK of `start` is moved to
 * `start`, and otherwise `start` is appended. start = 0 means "no change since the beginning".
 */
function recordBreak(breaks, start) {
  while (breaks.length && breaks[breaks.length - 1] > start + SAME_BREAK) breaks.pop();
  if (start < MIN_SEGMENT) return;
  const last = breaks.length ? breaks[breaks.length - 1] : null;
  if (last !== null && Math.abs(start - last) <= SAME_BREAK) breaks[breaks.length - 1] = start;
  else breaks.push(start);
}

/**
 * Detect changes in mean / variance.
 *
 * The prior scale is the robust scale of the first min(50, n - recent - 1) returns, so the
 * window that decides recentProbability never calibrates its own prior, and changeSeries[t]
 * is free of look-ahead from t = 49 on (earlier values use a prior that saw the whole window).
 * The segment already running at the first observation is not counted as a recent change.
 *
 * @param {number[]} returns daily log returns, oldest first, all finite (at least 60)
 * @param {{hazard?: number, recent?: number}} [options] hazard in (0, 1); recent >= 0 integer
 * @returns {null | {recentProbability: number, runLengthDays: number, changeSeries: number[],
 *   breaks: number[], n: number}}
 *   changeSeries[t] = P(a segment boundary gives run length <= recent | returns up to t).
 *   runLengthDays is the most probable run length at the end (n if no change). breaks are
 *   0-based indices of the first return of each detected new segment (see recordBreak); the
 *   list may be revised by later data, unlike changeSeries.
 */
export function detectChangepoints(returns, { hazard = 1 / 60, recent = 5 } = {}) {
  if (!isSeries(returns) || returns.length < MIN_OBS) return null;
  if (!(hazard > 0 && hazard < 1) || !Number.isInteger(recent) || recent < 0) return null;
  const x = Array.from(returns);
  const n = x.length;
  const windowSize = Math.min(PRIOR_WINDOW, n - recent - 1);
  if (windowSize < MIN_PRIOR_WINDOW) return null;
  const scale = priorScale(x.slice(0, windowSize));
  if (!(scale > 1e-9)) return null;
  const priorBeta = (PRIOR_ALPHA - 1) * scale * scale;

  // Student-t normalising constants depend only on the number of observations k in a segment.
  const constant = new Float64Array(n + 1);
  for (let k = 0; k <= n; k += 1) {
    const nu = 2 * PRIOR_ALPHA + k;
    constant[k] = logGamma((nu + 1) / 2) - logGamma(nu / 2) - 0.5 * Math.log(nu * Math.PI);
  }

  // One slot per surviving run-length hypothesis.
  const length = new Int32Array(n + 1);
  const initial = new Uint8Array(n + 1);
  const mu = new Float64Array(n + 1);
  const beta = new Float64Array(n + 1);
  const weight = new Float64Array(n + 1);
  const logPredictive = new Float64Array(n + 1);
  let count = 1;
  initial[0] = 1;
  mu[0] = PRIOR_MEAN;
  beta[0] = priorBeta;
  weight[0] = 1;

  const threshold = TRUNCATION * hazard;
  const changeSeries = new Array(n);
  const breaks = [];
  let mapLength = 0;

  for (let t = 0; t < n; t += 1) {
    const value = x[t];
    let top = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const k = length[i];
      const kappa = PRIOR_KAPPA + k;
      const alpha = PRIOR_ALPHA + k / 2;
      const nu = 2 * alpha;
      const scale2 = (beta[i] * (kappa + 1)) / (alpha * kappa);
      const d = value - mu[i];
      const lp = constant[k] - 0.5 * Math.log(scale2) - ((nu + 1) / 2) * Math.log1p((d * d) / (nu * scale2));
      logPredictive[i] = lp;
      if (lp > top) top = lp;
    }
    let evidence = 0;
    for (let i = 0; i < count; i += 1) {
      weight[i] *= Math.exp(logPredictive[i] - top);
      evidence += weight[i];
    }
    if (!(evidence > 0)) return null;

    // Growth: surviving segments absorb the observation. Negligible ones are dropped.
    let kept = 0;
    let total = hazard;
    for (let i = 0; i < count; i += 1) {
      const grown = (weight[i] / evidence) * (1 - hazard);
      if (grown < threshold) continue;
      const kappa = PRIOR_KAPPA + length[i];
      const d = value - mu[i];
      beta[kept] = beta[i] + (kappa * d * d) / (2 * (kappa + 1));
      mu[kept] = mu[i] + d / (kappa + 1);
      length[kept] = length[i] + 1;
      initial[kept] = initial[i];
      weight[kept] = grown;
      total += grown;
      kept += 1;
    }
    // Change point: a fresh segment with the prior; its mass is the hazard.
    length[kept] = 0;
    initial[kept] = 0;
    mu[kept] = PRIOR_MEAN;
    beta[kept] = priorBeta;
    weight[kept] = hazard;
    count = kept + 1;

    let recentMass = 0;
    let best = 0;
    for (let i = 0; i < count; i += 1) {
      weight[i] /= total;
      if (!initial[i] && length[i] <= recent) recentMass += weight[i];
      if (weight[i] > weight[best]) best = i;
    }
    changeSeries[t] = Math.min(1, recentMass);
    mapLength = length[best];
    if (mapLength >= MIN_SEGMENT) {
      let support = initial[best] ? weight[best] : 0;
      if (!initial[best]) {
        for (let i = 0; i < count; i += 1) {
          if (!initial[i] && Math.abs(length[i] - mapLength) <= SAME_BREAK) support += weight[i];
        }
      }
      if (support >= BREAK_SUPPORT) recordBreak(breaks, initial[best] ? 0 : t - mapLength + 1);
    }
  }

  return { recentProbability: changeSeries[n - 1], runLengthDays: mapLength, changeSeries, breaks, n };
}
