// Tail risk of daily log returns: VaR / expected shortfall, drawdown, jump detection.
// Pure ESM, no dependencies (edge safe), deterministic.
// Formulas and limitations: docs/math/volatility-risk.md
import { logGamma, normalQuantile, studentTQuantile } from './special.js';
import { excessKurtosis, mean, quantile, skewness, stdev } from './stats.js';

const VAR_MIN = 60;
const JUMP_MIN_TESTED = 20;
const NU_MIN = 2.05;
const NU_MAX = 200;
const SIGMA_FLOOR = 1e-8;
const TIE = 1e-12;

const isList = (xs) => Array.isArray(xs) || ArrayBuffer.isView(xs);

// Log return -> loss as a positive fraction of the simple return; a gain counts as no loss.
const lossFraction = (logReturn) => Math.max(0, -Math.expm1(logReturn));

// Maximum likelihood degrees of freedom of a unit-variance Student t, location and scale
// held at their sample estimates. Golden-section search over ln(nu - 2).
function estimateNu(z) {
  const logLik = (x) => {
    const nu = 2 + Math.exp(x);
    let kernel = 0;
    for (const value of z) kernel += Math.log1p((value * value) / (nu - 2));
    return z.length * (logGamma((nu + 1) / 2) - logGamma(nu / 2) - 0.5 * Math.log(Math.PI * (nu - 2)))
      - ((nu + 1) / 2) * kernel;
  };
  const ratio = (Math.sqrt(5) - 1) / 2;
  let low = Math.log(NU_MIN - 2);
  let high = Math.log(NU_MAX - 2);
  let a = high - ratio * (high - low);
  let b = low + ratio * (high - low);
  let fa = logLik(a);
  let fb = logLik(b);
  while (high - low > 1e-6) {
    if (fa >= fb) {
      high = b;
      b = a;
      fb = fa;
      a = high - ratio * (high - low);
      fa = logLik(a);
    } else {
      low = a;
      a = b;
      fa = fb;
      b = low + ratio * (high - low);
      fb = logLik(b);
    }
  }
  return 2 + Math.exp((low + high) / 2);
}

// Is z -> Cornish-Fisher(z) non-decreasing on the whole line? Its derivative is a z^2 + b z + c.
function cornishFisherIsMonotone(s, k) {
  const a = k / 8 - (s * s) / 6;
  const b = s / 3;
  const c = 1 - k / 8 + (5 * s * s) / 36;
  if (Math.abs(a) < TIE) return Math.abs(b) < TIE && c > 0;
  return a > 0 && b * b - 4 * a * c <= 0;
}

function cornishFisherQuantile(z, s, k) {
  return z + ((z * z - 1) * s) / 6 + ((z ** 3 - 3 * z) * k) / 24 - ((2 * z ** 3 - 5 * z) * s * s) / 36;
}

/**
 * One-day value at risk and expected shortfall, as positive loss fractions of simple return.
 *
 * expectedShortfall is the average simple loss over observations at or beyond the historical
 * VaR. The interpolated quantile never exceeds the worst loss, so the tail holds at least one
 * observation; when n * (1 - level) <= 1 it is just the worst loss seen (a weak estimate).
 *
 * @param {number[]} returns daily log returns, oldest first (at least 60 finite values)
 * @param {{level?: number, sigma?: number, nu?: number}} [options] sigma and nu (for example
 *   fit.sigmaNext and fit.nu from fitGarch) drive parametricT; otherwise sample estimates
 */
export function valueAtRisk(returns, { level = 0.99, sigma, nu } = {}) {
  if (!isList(returns) || !(level > 0.5 && level < 1)) return null;
  const r = Array.from(returns).filter((x) => Number.isFinite(x));
  if (r.length < VAR_MIN) return null;
  const location = mean(r);
  const sampleSigma = stdev(r);
  if (!(sampleSigma > SIGMA_FLOOR) || !Number.isFinite(sampleSigma)) return null;
  const p = 1 - level;

  const cut = quantile(r, p);
  const tail = r.filter((x) => x <= cut + TIE);
  const historical = lossFraction(cut);
  const expectedShortfall = mean(tail.map(lossFraction));

  const scaleSigma = Number.isFinite(sigma) && sigma > 0 ? sigma : sampleSigma;
  const dof = Number.isFinite(nu) && nu > 2 ? nu : estimateNu(r.map((x) => (x - location) / sampleSigma));
  const tQuantile = studentTQuantile(p, dof) * Math.sqrt((dof - 2) / dof);
  const parametricT = lossFraction(location + scaleSigma * tQuantile);

  const s = skewness(r);
  const k = excessKurtosis(r);
  const cornishFisher = s !== null && k !== null && cornishFisherIsMonotone(s, k)
    ? lossFraction(location + sampleSigma * cornishFisherQuantile(normalQuantile(p), s, k))
    : null;

  return { level, historical, parametricT, cornishFisher, expectedShortfall };
}

/**
 * Largest peak-to-trough fall of a price series. Non-finite and non-positive prices are
 * skipped; indices refer to the input array. A series that never falls gives depth 0.
 * recovered: some close after the trough is back at or above the peak.
 * @returns {{depth: number, peakIndex: number, troughIndex: number, recovered: boolean} | null}
 */
export function maxDrawdown(closes) {
  if (!isList(closes)) return null;
  let peak = null;
  let peakIndex = -1;
  let worst = null;
  let valid = 0;
  for (let i = 0; i < closes.length; i += 1) {
    const price = closes[i];
    if (!Number.isFinite(price) || !(price > 0)) continue;
    valid += 1;
    if (!worst) worst = { depth: 0, peakIndex: i, troughIndex: i, recovered: true };
    if (worst.depth > 0 && price >= closes[worst.peakIndex]) worst.recovered = true;
    if (peak === null || price >= peak) {
      peak = price;
      peakIndex = i;
    } else if (1 - price / peak > worst.depth) {
      worst = { depth: 1 - price / peak, peakIndex, troughIndex: i, recovered: false };
    }
  }
  return valid >= 2 ? worst : null;
}

/**
 * Lee-Mykland (2008) jump test. For each return, sigma_i^2 is pi/2 times the mean product of
 * neighbouring absolute returns inside the preceding `window` returns (bipower variation), so
 * statistic = |r_i| / sigma_i is in standard deviations. The threshold is the `level` quantile
 * of the Gumbel limit of the maximum over all tested returns. This is the paper's test with
 * the constant sqrt(2/pi) moved from C_n and S_n into sigma_i.
 *
 * Windows where more than half of the products are zero are not tested.
 * @returns {{index: number, statistic: number, return: number}[]} index refers to the input
 */
export function detectJumps(returns, { window = 20, level = 0.99 } = {}) {
  if (!isList(returns) || !Number.isInteger(window) || window < 3 || !(level > 0 && level < 1)) return [];
  const r = [];
  const positions = [];
  for (let i = 0; i < returns.length; i += 1) {
    if (Number.isFinite(returns[i])) {
      r.push(returns[i]);
      positions.push(i);
    }
  }
  const tested = r.length - window;
  if (tested < JUMP_MIN_TESTED) return [];

  const root = Math.sqrt(2 * Math.log(tested));
  const centre = root - (Math.log(Math.PI) + Math.log(Math.log(tested))) / (2 * root);
  const threshold = centre - Math.log(-Math.log(level)) / root;

  const jumps = [];
  const products = window - 1;
  for (let i = window; i < r.length; i += 1) {
    let total = 0;
    let nonZero = 0;
    for (let j = i - window + 1; j < i; j += 1) {
      const product = Math.abs(r[j] * r[j - 1]);
      total += product;
      if (product > 0) nonZero += 1;
    }
    if (nonZero * 2 < products) continue;
    const sigma = Math.sqrt((Math.PI / 2) * (total / products));
    if (!(sigma > SIGMA_FLOOR)) continue;
    const statistic = Math.abs(r[i]) / sigma;
    if (statistic > threshold) jumps.push({ index: positions[i], statistic, return: r[i] });
  }
  return jumps;
}
