// Time-varying market beta: linear Gaussian state space + Kalman filter. Pure ESM (edge safe).
//
//   r_t    = alpha + beta_t * m_t + e_t,   e_t ~ N(0, r)
//   beta_t = beta_{t-1} + w_t,             w_t ~ N(0, q)
//
// q and r are fitted by maximum likelihood of the one-step prediction errors. alpha is
// concentrated out of that likelihood exactly (GLS on the innovations), see runFilter.
import { mean, variance } from './stats.js';
import { nelderMead } from './optimize.js';

const MIN_OBS = 60;
const MIN_BURN = 5;
const MAX_BURN = 20;
// Optimiser coordinates: x0 = ln(q * var(m) / s2), x1 = ln(r / s2), s2 = OLS residual variance.
const X0_BOUNDS = [-20, 3];
const X1_BOUNDS = [-10, 3];
const X0_GRID = [-18, -13, -10, -8, -6, -4, -2, 0];
const BOUND_MARGIN = 0.01;

const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));
const isSeries = (xs) => (Array.isArray(xs) || ArrayBuffer.isView(xs)) && Array.prototype.every.call(xs, Number.isFinite);

/**
 * The filter is linear in the observations, so for any alpha
 *   beta(alpha) = betaY - alpha * betaOne,  v(alpha) = vY - alpha * vOne,
 * where (betaY, vY) filters the returns from the prior mean and (betaOne, vOne) filters a
 * constant series of ones from zero. Both share the gains and variances. The likelihood is
 * quadratic in alpha, so its maximiser is available in closed form.
 */
function runFilter(y, m, prior, q, r, burn, path) {
  let betaY = prior.mean;
  let betaOne = 0;
  let p = prior.variance;
  let sYY = 0;
  let sY1 = 0;
  let s11 = 0;
  let sumLogF = 0;
  for (let t = 0; t < y.length; t += 1) {
    const predicted = p + q;
    const x = m[t];
    const f = x * x * predicted + r;
    const vY = y[t] - x * betaY;
    const vOne = 1 - x * betaOne;
    const gain = (predicted * x) / f;
    betaY += gain * vY;
    betaOne += gain * vOne;
    p = (predicted * r) / f; // equals (1 - gain * x) * predicted, without cancellation
    if (t >= burn) {
      sYY += (vY * vY) / f;
      sY1 += (vY * vOne) / f;
      s11 += (vOne * vOne) / f;
      sumLogF += Math.log(f);
    }
    if (path) {
      path.betaY[t] = betaY;
      path.betaOne[t] = betaOne;
      path.p[t] = p;
    }
  }
  if (!(s11 > 0)) return null;
  const alpha = sY1 / s11;
  const logLik = -0.5 * ((y.length - burn) * Math.log(2 * Math.PI) + sumLogF + sYY - alpha * sY1);
  return Number.isFinite(logLik) ? { alpha, logLik } : null;
}

/**
 * Kalman-filtered market model.
 *
 * Inputs are daily log returns, oldest first. The two series MUST already be aligned by date
 * (same length, element t is the same day) and every value MUST be finite; otherwise null.
 *
 * @param {number[]} stockReturns
 * @param {number[]} benchReturns
 * @returns {null | {beta: number[], betaStd: number[], latestBeta: number, latestStd: number,
 *   alpha: number, q: number, r: number, logLik: number, n: number}}
 *   beta[t] and betaStd[t] are the filtered mean and standard deviation of beta_t given data
 *   up to t (alpha, q, r and the weak prior come from the whole sample). logLik omits the
 *   burn-in of min(20, max(5, floor(n / 10))) observations.
 */
export function kalmanMarketModel(stockReturns, benchReturns) {
  if (!isSeries(stockReturns) || !isSeries(benchReturns)) return null;
  const n = stockReturns.length;
  if (n < MIN_OBS || benchReturns.length !== n) return null;
  const y = Array.from(stockReturns);
  const m = Array.from(benchReturns);

  // OLS: starting point for the prior and the scale of the optimiser coordinates.
  const meanY = mean(y);
  const meanM = mean(m);
  const varY = variance(y);
  const varM = variance(m);
  const secondM = varM + meanM * meanM;
  if (!(varY > 0) || !(varM > 1e-12 * secondM)) return null;
  let cross = 0;
  for (let t = 0; t < n; t += 1) cross += (m[t] - meanM) * (y[t] - meanY);
  const olsBeta = cross / (varM * (n - 1));
  const olsAlpha = meanY - olsBeta * meanM;
  let sse = 0;
  for (let t = 0; t < n; t += 1) sse += (y[t] - olsAlpha - olsBeta * m[t]) ** 2;
  if (!(sse > 1e-10 * varY * (n - 1))) return null; // exact linear relation: nothing to filter
  const s2 = sse / (n - 2);

  // Prior worth about one observation around the OLS slope.
  const prior = { mean: olsBeta, variance: s2 / varM };
  const burn = Math.min(MAX_BURN, Math.max(MIN_BURN, Math.floor(n / 10)));
  const qOf = (x0) => (Math.exp(x0) * s2) / varM;
  const rOf = (x1) => Math.exp(x1) * s2;
  const objective = (x) => {
    const x0 = clamp(x[0], X0_BOUNDS);
    const x1 = clamp(x[1], X1_BOUNDS);
    const result = runFilter(y, m, prior, qOf(x0), rOf(x1), burn);
    if (!result) return Infinity;
    return -result.logLik + 10 * ((x[0] - x0) ** 2 + (x[1] - x1) ** 2);
  };

  // A coarse grid guards against the flat region at q -> 0 and secondary maxima.
  let start = null;
  let startValue = Infinity;
  for (const x0 of X0_GRID) {
    const value = objective([x0, 0]);
    if (value < startValue) {
      start = [x0, 0];
      startValue = value;
    }
  }
  if (!start) return null;
  const options = { tolerance: 1e-9, maxIterations: 250 };
  const first = nelderMead(objective, start, { ...options, step: 1 });
  const second = nelderMead(objective, first.x, { ...options, step: 0.4 }); // restart a collapsed simplex
  const best = second.value <= first.value ? second : first;
  if (!Number.isFinite(best.value)) return null;
  const x0 = clamp(best.x[0], X0_BOUNDS);
  const x1 = clamp(best.x[1], X1_BOUNDS);
  // r collapsing to zero, or q exploding, means beta_t is merely interpolating the returns.
  if (x1 <= X1_BOUNDS[0] + BOUND_MARGIN || x0 >= X0_BOUNDS[1] - BOUND_MARGIN) return null;

  const q = qOf(x0);
  const r = rOf(x1);
  const path = { betaY: new Array(n), betaOne: new Array(n), p: new Array(n) };
  const result = runFilter(y, m, prior, q, r, burn, path);
  if (!result) return null;
  const beta = path.betaY.map((value, t) => value - result.alpha * path.betaOne[t]);
  const betaStd = path.p.map(Math.sqrt);
  if (!beta.every(Number.isFinite) || !betaStd.every(Number.isFinite)) return null;
  return {
    beta,
    betaStd,
    latestBeta: beta[n - 1],
    latestStd: betaStd[n - 1],
    alpha: result.alpha,
    q,
    r,
    logLik: result.logLik,
    n,
  };
}
