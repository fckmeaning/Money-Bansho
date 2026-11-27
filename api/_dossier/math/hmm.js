// Two-state Gaussian hidden Markov model of daily log returns (calm / turbulent).
// Baum-Welch (EM) with scaled forward-backward recursions. Pure ESM (edge safe), deterministic.
import { mean, median, quantile } from './stats.js';

const MIN_OBS = 100;
const MIN_SIGMA_RATIO = 1.25;
const MIN_DURATION_DAYS = 3; // a state that does not persist is fat tails, not a regime
const VARIANCE_FLOOR_SHARE = 0.0025; // state sigma >= 5 % of the sample sigma
const TRANSITION_FLOOR = 1e-6;
const MIN_OCCUPANCY = 8;
const MIN_OCCUPANCY_SHARE = 0.02;
const EXTRA_PARAMETERS = 4; // second mean, second variance, two transition probabilities
const INITIAL = 0.5; // fixed (not estimated) probability of each state before the first return
const START_QUANTILES = [0.5, 0.75, 0.9];
const HALF_WINDOW = 10;
const SCREEN_ITERATIONS = 20;
const MAX_ITERATIONS = 400;
const TOLERANCE = 1e-6;

const isSeries = (xs) => (Array.isArray(xs) || ArrayBuffer.isView(xs)) && Array.prototype.every.call(xs, Number.isFinite);
const clampStay = (p) => Math.min(1 - TRANSITION_FLOOR, Math.max(TRANSITION_FLOOR, p));

/** Deterministic start: days whose local squared deviation is above a quantile are "turbulent". */
function initialModel(x, level, totalVariance, floor) {
  const n = x.length;
  const centre = median(x);
  const local = x.map((_, t) => {
    const from = Math.max(0, t - HALF_WINDOW);
    const to = Math.min(n, t + HALF_WINDOW + 1);
    let total = 0;
    for (let i = from; i < to; i += 1) total += (x[i] - centre) ** 2;
    return total / (to - from);
  });
  const threshold = quantile(local, level);
  const groups = [[], []];
  for (let t = 0; t < n; t += 1) groups[local[t] > threshold ? 1 : 0].push(x[t]);
  const means = groups.map((g) => (g.length ? mean(g) : centre));
  const variances = groups.map((g, i) => {
    if (g.length < 2) return totalVariance * (i ? 2 : 0.5);
    return Math.max(floor, g.reduce((s, v) => s + (v - means[i]) ** 2, 0) / g.length);
  });
  return { means, variances, stay: [0.95, 0.9] };
}

/**
 * Scaled forward pass. Fills the filtered probabilities alpha, the emission likelihoods
 * (divided by their daily maximum to avoid underflow) and the scale factors.
 */
function forward(x, model, work) {
  const { means, variances, stay } = model;
  const { alpha0, alpha1, b0, b1, scale } = work;
  const c0 = -0.5 * Math.log(2 * Math.PI * variances[0]);
  const c1 = -0.5 * Math.log(2 * Math.PI * variances[1]);
  const h0 = 0.5 / variances[0];
  const h1 = 0.5 / variances[1];
  const leave0 = 1 - stay[0];
  const leave1 = 1 - stay[1];
  let logLik = 0;
  let previous0 = 0;
  let previous1 = 0;
  for (let t = 0; t < x.length; t += 1) {
    const l0 = c0 - h0 * (x[t] - means[0]) ** 2;
    const l1 = c1 - h1 * (x[t] - means[1]) ** 2;
    const top = l0 > l1 ? l0 : l1;
    const e0 = Math.exp(l0 - top);
    const e1 = Math.exp(l1 - top);
    const prior0 = t === 0 ? INITIAL : previous0 * stay[0] + previous1 * leave1;
    const prior1 = t === 0 ? 1 - INITIAL : previous0 * leave0 + previous1 * stay[1];
    const c = prior0 * e0 + prior1 * e1;
    previous0 = (prior0 * e0) / c;
    previous1 = (prior1 * e1) / c;
    alpha0[t] = previous0;
    alpha1[t] = previous1;
    b0[t] = e0;
    b1[t] = e1;
    scale[t] = c;
    logLik += Math.log(c) + top;
  }
  return logLik;
}

/** One EM step: backward pass plus re-estimation. Requires forward() on the same model. */
function reestimate(x, model, work, floor) {
  const { alpha0, alpha1, b0, b1, scale } = work;
  const { stay } = model;
  const n = x.length;
  let back0 = 1;
  let back1 = 1;
  const weight = [0, 0];
  const first = [0, 0];
  const second = [0, 0];
  const counts = [0, 0, 0, 0]; // expected transitions 00, 01, 10, 11
  for (let t = n - 1; t >= 0; t -= 1) {
    if (t < n - 1) {
      const next0 = (b0[t + 1] * back0) / scale[t + 1];
      const next1 = (b1[t + 1] * back1) / scale[t + 1];
      const to00 = stay[0] * next0;
      const to01 = (1 - stay[0]) * next1;
      const to10 = (1 - stay[1]) * next0;
      const to11 = stay[1] * next1;
      counts[0] += alpha0[t] * to00;
      counts[1] += alpha0[t] * to01;
      counts[2] += alpha1[t] * to10;
      counts[3] += alpha1[t] * to11;
      back0 = to00 + to01;
      back1 = to10 + to11;
    }
    const g0 = alpha0[t] * back0;
    const g1 = alpha1[t] * back1;
    const v = x[t];
    weight[0] += g0;
    weight[1] += g1;
    first[0] += g0 * v;
    first[1] += g1 * v;
    second[0] += g0 * v * v;
    second[1] += g1 * v * v;
  }
  const means = [0, 1].map((i) => (weight[i] > 0 ? first[i] / weight[i] : model.means[i]));
  const variances = [0, 1].map((i) => (weight[i] > 0
    ? Math.max(floor, second[i] / weight[i] - means[i] ** 2)
    : floor));
  const out0 = counts[0] + counts[1];
  const out1 = counts[2] + counts[3];
  return {
    model: {
      means,
      variances,
      stay: [
        clampStay(out0 > 0 ? counts[0] / out0 : stay[0]),
        clampStay(out1 > 0 ? counts[3] / out1 : stay[1]),
      ],
    },
    occupancy: weight,
  };
}

/** Runs EM from `state` for at most `limit` further iterations (mutates and returns state). */
function iterate(x, state, work, floor, limit) {
  for (let k = 0; k < limit && !state.converged; k += 1) {
    const { model } = reestimate(x, state.model, work, floor);
    const logLik = forward(x, model, work);
    state.converged = logLik - state.logLik < TOLERANCE;
    state.model = model;
    state.logLik = logLik;
    state.iterations += 1;
  }
  return state;
}

const collapsed = (state, floor) => !Number.isFinite(state.logLik) || state.model.variances.some((v) => v <= floor * 1.000001);

/**
 * Fit a calm / turbulent regime model.
 *
 * @param {number[]} returns daily log returns, oldest first, all finite (at least 100)
 * @returns {null | {states: {mean: number, sigma: number}[], transition: number[][],
 *   probabilityTurbulent: number, series: number[], expectedDurationDays: number[],
 *   logLik: number, iterations: number, n: number}}
 *   State 0 is calm, state 1 has the larger sigma. series[t] is the FILTERED probability
 *   P(state 1 | returns up to t) under parameters fitted on the whole sample. Returns null
 *   when the fit collapses, one state is nearly empty, sigma1 / sigma0 < 1.25, two states
 *   do not beat a single Gaussian by the BIC, or either state has an expected duration below
 *   3 days. An expected duration longer than n means that state was never left in the sample
 *   (the exit probability is floored at 1e-6) and should be read as "not identified".
 */
export function fitRegimes(returns) {
  if (!isSeries(returns) || returns.length < MIN_OBS) return null;
  const x = Array.from(returns);
  const n = x.length;
  const centre = mean(x);
  const totalVariance = x.reduce((s, v) => s + (v - centre) ** 2, 0) / n;
  if (!(totalVariance > 1e-16)) return null;
  const floor = totalVariance * VARIANCE_FLOOR_SHARE;
  const buffer = () => new Float64Array(n);
  const work = { alpha0: buffer(), alpha1: buffer(), b0: buffer(), b1: buffer(), scale: buffer() };

  // Short runs from several starts, then only the most promising ones are run to convergence.
  const candidates = START_QUANTILES.map((level) => {
    const model = initialModel(x, level, totalVariance, floor);
    const state = { model, logLik: forward(x, model, work), iterations: 0, converged: false };
    return iterate(x, state, work, floor, SCREEN_ITERATIONS);
  }).sort((a, b) => b.logLik - a.logLik);

  let best = null;
  for (const candidate of candidates) {
    if (collapsed(candidate, floor)) continue;
    forward(x, candidate.model, work); // the work buffers must belong to this candidate
    iterate(x, candidate, work, floor, MAX_ITERATIONS - candidate.iterations);
    if (!collapsed(candidate, floor)) {
      best = candidate;
      break;
    }
  }
  if (!best) return null;

  const logLik = forward(x, best.model, work);
  const { occupancy } = reestimate(x, best.model, work, floor);
  if (Math.min(...occupancy) < Math.max(MIN_OCCUPANCY, MIN_OCCUPANCY_SHARE * n)) return null;

  const calm = best.model.variances[0] <= best.model.variances[1] ? 0 : 1;
  const wild = 1 - calm;
  const states = [calm, wild].map((i) => ({ mean: best.model.means[i], sigma: Math.sqrt(best.model.variances[i]) }));
  if (states[1].sigma / states[0].sigma < MIN_SIGMA_RATIO) return null;

  const singleLogLik = -0.5 * n * (Math.log(2 * Math.PI * totalVariance) + 1);
  if (!(logLik - singleLogLik > 0.5 * EXTRA_PARAMETERS * Math.log(n))) return null;

  const stay = [best.model.stay[calm], best.model.stay[wild]];
  if (Math.min(...stay) < 1 - 1 / MIN_DURATION_DAYS) return null;
  const series = Array.from(wild === 1 ? work.alpha1 : work.alpha0);
  return {
    states,
    transition: [[stay[0], 1 - stay[0]], [1 - stay[1], stay[1]]],
    probabilityTurbulent: series[n - 1],
    series,
    expectedDurationDays: stay.map((p) => 1 / (1 - p)),
    logLik,
    iterations: best.iterations,
    n,
  };
}
