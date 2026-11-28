// Conditional volatility of daily log returns: RiskMetrics EWMA and GARCH(1,1)-t.
// Pure ESM, no dependencies (edge safe), deterministic. All sigmas are daily.
// Formulas and limitations: docs/math/volatility-risk.md
import { nelderMead } from './optimize.js';
import { logGamma } from './special.js';
import { mean } from './stats.js';

const EWMA_MIN = 20;
const GARCH_MIN = 100;
const NU_MIN = 2.05;
const NU_MAX = 200;
const PERSISTENCE_MAX = 0.9999;
const ALPHA_ZERO = 1e-4;
const VARIANCE_FLOOR = 1e-16;
const MAX_HORIZON = 10000;
const LOG_BLOCK = 8;
// [alpha, beta, nu]: the likelihood can be multimodal in small samples, so every start is
// explored briefly and the best one is then refined.
const STARTS = [
  [0.05, 0.92, 8],
  [0.1, 0.85, 5],
  [0.02, 0.975, 15],
  [0.15, 0.6, 6],
  [0.25, 0.3, 10],
  [0.04, 0.94, 60],
  [0.06, 0.01, 60],
];

const finiteValues = (xs) => (Array.isArray(xs) || ArrayBuffer.isView(xs) ? Array.from(xs).filter((x) => Number.isFinite(x)) : []);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(p / (1 - p));

/**
 * RiskMetrics exponentially weighted volatility (zero mean).
 * series[t] is the sigma of observation t conditional on earlier ones; the recursion is
 * seeded with the mean square of the first 20 observations.
 * @returns {{sigma: number, series: number[]} | null}
 */
export function ewmaVolatility(returns, lambda = 0.94) {
  const r = finiteValues(returns);
  if (r.length < EWMA_MIN || !(lambda > 0 && lambda < 1)) return null;
  const meanSquare = (xs) => xs.reduce((total, x) => total + x * x, 0) / xs.length;
  const overall = meanSquare(r);
  if (!(overall > VARIANCE_FLOOR) || !Number.isFinite(overall)) return null;
  const head = meanSquare(r.slice(0, EWMA_MIN));
  let h = head > VARIANCE_FLOOR ? head : overall;
  const series = new Array(r.length);
  for (let t = 0; t < r.length; t += 1) {
    series[t] = Math.sqrt(h);
    h = lambda * h + (1 - lambda) * r[t] * r[t];
  }
  const sigma = Math.sqrt(h);
  return sigma > 0 ? { sigma, series } : null;
}

// Negative log likelihood of residuals scaled to unit sample variance (the variance target).
// sum ln(1 + e2 / (h s)) = sum ln(h s + e2) - sum ln h - n ln s. Both sums are taken as logs
// of products over short blocks (bounded here, so no overflow), which saves most log calls.
function negativeLogLik(e2, alpha, beta, nu) {
  const n = e2.length;
  const omega = 1 - alpha - beta;
  const spread = nu - 2;
  let h = 1;
  let sumLogH = 0;
  let sumLogMix = 0;
  for (let start = 0; start < n; start += LOG_BLOCK) {
    const end = Math.min(n, start + LOG_BLOCK);
    let productH = 1;
    let productMix = 1;
    for (let t = start; t < end; t += 1) {
      productH *= h;
      productMix *= h * spread + e2[t];
      h = omega + alpha * e2[t] + beta * h;
    }
    sumLogH += Math.log(productH);
    sumLogMix += Math.log(productMix);
  }
  const logKernel = sumLogMix - sumLogH - n * Math.log(spread);
  const constant = logGamma((nu + 1) / 2) - logGamma(nu / 2) - 0.5 * Math.log(Math.PI * spread);
  return -(n * constant - 0.5 * sumLogH - ((nu + 1) / 2) * logKernel);
}

// Unconstrained (u, v, w) -> alpha, beta >= 0, alpha + beta < 1, 2 < nu <= 200.
function fromFree([u, v, w]) {
  const persistence = PERSISTENCE_MAX * sigmoid(u);
  const alpha = persistence * sigmoid(v);
  return { alpha, beta: persistence - alpha, nu: NU_MIN + (NU_MAX - NU_MIN) * sigmoid(w) };
}

function toFree([alpha, beta, nu]) {
  const persistence = alpha + beta;
  return [logit(persistence / PERSISTENCE_MAX), logit(alpha / persistence), logit((nu - NU_MIN) / (NU_MAX - NU_MIN))];
}

/**
 * GARCH(1,1) with standardised Student-t innovations, maximum likelihood with variance
 * targeting. Returns are demeaned by their sample mean. sigmaSeries is aligned with the
 * finite observations. Needs at least 100 of them.
 */
export function fitGarch(returns) {
  const r = finiteValues(returns);
  const n = r.length;
  if (n < GARCH_MIN) return null;
  const centre = mean(r);
  const target = r.reduce((total, x) => total + (x - centre) ** 2, 0) / n;
  if (!(target > VARIANCE_FLOOR) || !Number.isFinite(target)) return null;
  // Mostly unchanged prices: the t likelihood degenerates towards a spike at zero.
  if (r.filter((x) => x === 0).length > n / 2) return null;

  const scale = Math.sqrt(target);
  const e2 = Float64Array.from(r, (x) => ((x - centre) / scale) ** 2);
  const objective = (free) => {
    const { alpha, beta, nu } = fromFree(free);
    return negativeLogLik(e2, alpha, beta, nu) / n;
  };

  let best = null;
  for (const start of STARTS) {
    const found = nelderMead(objective, toFree(start), { step: 0.5, tolerance: 1e-7, maxIterations: 120 });
    if (!best || found.value < best.value) best = found;
  }
  // Restart from the winner: guards against a collapsed simplex.
  const polished = nelderMead(objective, best.x, { step: 0.25, tolerance: 1e-9, maxIterations: 400 });
  if (!Number.isFinite(polished.value)) return null;

  let { alpha, beta, nu } = fromFree(polished.x);
  // With a variance target and alpha = 0 the variance is constant, so beta is not identified.
  if (alpha < ALPHA_ZERO) {
    alpha = 0;
    beta = 0;
  }
  const persistence = alpha + beta;
  const omegaScaled = 1 - persistence;
  const sigmaSeries = new Array(n);
  let h = 1;
  for (let t = 0; t < n; t += 1) {
    sigmaSeries[t] = Math.sqrt(h) * scale;
    h = omegaScaled + alpha * e2[t] + beta * h;
  }
  const logLik = -negativeLogLik(e2, alpha, beta, nu) - n * Math.log(scale);
  const sigmaNext = Math.sqrt(h) * scale;
  if (!Number.isFinite(logLik) || !(sigmaNext > 0)) return null;

  return {
    omega: omegaScaled * target,
    alpha,
    beta,
    nu,
    persistence,
    halfLifeDays: persistence > ALPHA_ZERO ? Math.log(0.5) / Math.log(persistence) : null,
    longRunSigma: scale,
    sigmaNext,
    sigmaSeries,
    logLik,
    converged: polished.converged,
    n,
  };
}

/**
 * Daily sigma for h = 1..horizon: variance reverts geometrically to the long-run level.
 * Returns [] for a missing fit or a non-positive horizon.
 */
export function garchForecast(fit, horizon) {
  const steps = Math.min(MAX_HORIZON, Math.floor(horizon));
  if (!fit || !(steps >= 1)) return [];
  const { persistence, longRunSigma, sigmaNext } = fit;
  if (![persistence, longRunSigma, sigmaNext].every((x) => Number.isFinite(x))) return [];
  const longRun = longRunSigma ** 2;
  const gap = sigmaNext ** 2 - longRun;
  return Array.from({ length: steps }, (_, i) => Math.sqrt(longRun + persistence ** i * gap));
}
