// Multiple testing, nonparametric event-study tests and source diversity.
// Pure ESM, deterministic (edge safe).
// Formulas and limitations: docs/math/newsflow-inference.md
import { normalCdf } from './special.js';
import { mean, quantile, ranks, round, seededRandom } from './stats.js';

const MIN_ESTIMATION = 30;
const MIN_SAMPLES = 100;
/** Work limit (about T^2 L^2) for the exact rank-sum distribution. */
const EXACT_WORK = 6e6;

const isProbability = (p) => typeof p === 'number' && p >= 0 && p <= 1;

/**
 * Benjamini-Hochberg step-up procedure. Entries that are not probabilities
 * (null, undefined, NaN) keep a null q-value and are not counted.
 * @returns {null | {qValues: (number|null)[], rejected: boolean[], discoveries: number, tested: number}}
 */
export function benjaminiHochberg(pValues, level = 0.1) {
  if (!Array.isArray(pValues) || !(level > 0 && level < 1)) return null;
  const order = [];
  pValues.forEach((p, index) => {
    if (isProbability(p)) order.push({ p, index });
  });
  order.sort((a, b) => a.p - b.p || a.index - b.index);
  const tested = order.length;
  const qValues = new Array(pValues.length).fill(null);
  const rejected = new Array(pValues.length).fill(false);
  let running = 1;
  let discoveries = 0;
  for (let i = tested - 1; i >= 0; i -= 1) {
    running = Math.min(running, (order[i].p * tested) / (i + 1));
    const { index } = order[i];
    qValues[index] = running;
    // Tolerance absorbs rounding when p sits exactly on its threshold.
    if (running <= level * (1 + 1e-12)) {
      rejected[index] = true;
      discoveries += 1;
    }
  }
  return { qValues, rejected, discoveries, tested };
}

/**
 * Exact two-sided p-value of a rank sum: the share of all subsets of `size`
 * ranks whose sum is at least as far from its expectation as the observed one.
 * Doubled midranks are integers, which keeps ties exact.
 */
function exactRankSumPValue(allRanks, size, observed) {
  const doubled = allRanks.map((r) => Math.round(2 * r));
  const total = allRanks.length;
  const top = [...doubled].sort((a, b) => b - a).slice(0, size).reduce((s, r) => s + r, 0);
  const counts = Array.from({ length: size + 1 }, () => new Float64Array(top + 1));
  const reach = new Array(size + 1).fill(-1);
  counts[0][0] = 1;
  reach[0] = 0;
  for (let item = 0; item < total; item += 1) {
    const rank = doubled[item];
    for (let k = Math.min(size, item + 1); k >= 1; k -= 1) {
      if (reach[k - 1] < 0) continue;
      const from = counts[k - 1];
      const to = counts[k];
      const limit = Math.min(reach[k - 1], top - rank);
      for (let s = 0; s <= limit; s += 1) to[s + rank] += from[s];
      reach[k] = Math.max(reach[k], limit + rank);
    }
  }
  const expected = size * (total + 1);
  const distance = Math.abs(Math.round(2 * observed) - expected);
  let extreme = 0;
  let all = 0;
  for (let s = 0; s <= top; s += 1) {
    const ways = counts[size][s];
    all += ways;
    if (Math.abs(s - expected) >= distance) extreme += ways;
  }
  return Math.min(1, extreme / all);
}

/**
 * Corrado (1989) rank test for one security. Abnormal returns of the estimation
 * and event windows are ranked together; the event-window rank sum is compared
 * with its permutation mean and variance:
 *   z = sum(K - (T+1)/2) / sqrt(L * s^2 * (T - L) / (T - 1))
 * For L = 1 this is Corrado's statistic; for longer windows it keeps the sqrt(L)
 * scaling and adds the finite-population correction. The p-value comes from the
 * exact permutation distribution for short windows, else the normal limit.
 * @returns {null | {z: number, pValue: number}}
 */
export function corradoRankTest(estimationAR, eventAR) {
  if (!Array.isArray(estimationAR) || !Array.isArray(eventAR) || !eventAR.length) return null;
  const estimation = estimationAR.filter(Number.isFinite);
  // A gap inside the event window would change the hypothesis being tested.
  if (estimation.length < MIN_ESTIMATION || !eventAR.every(Number.isFinite)) return null;
  const size = eventAR.length;
  const total = estimation.length + size;
  const allRanks = ranks([...estimation, ...eventAR]);
  const centre = (total + 1) / 2;
  const spread = allRanks.reduce((s, r) => s + (r - centre) ** 2, 0) / total;
  if (!(spread > 0)) return null;
  const observed = allRanks.slice(estimation.length).reduce((s, r) => s + r, 0);
  const z = (observed - size * centre) / Math.sqrt((size * spread * estimation.length) / (total - 1));

  let pValue;
  if (size === 1) {
    const distance = Math.abs(observed - centre);
    pValue = allRanks.filter((r) => Math.abs(r - centre) >= distance - 1e-9).length / total;
  } else if (total * total * size * size <= EXACT_WORK) {
    pValue = exactRankSumPValue(allRanks, size, observed);
  } else {
    // Floored at double-precision resolution: the tail is computed as 1 - P.
    pValue = Math.min(1, Math.max(1e-16, 2 * normalCdf(-Math.abs(z))));
  }
  // Not rounded: a tiny p-value must not turn into zero.
  return { z: round(z, 6), pValue };
}

/**
 * Bootstrap null distribution of a cumulative abnormal return: sums of
 * `windowLength` residuals drawn with replacement from the centred estimation
 * residuals. `low` and `high` are the 2.5% and 97.5% quantiles of that null
 * distribution (a CAR outside them is unusual), not a confidence interval for CAR.
 * @returns {null | {pValue: number, low: number, high: number}}
 */
export function bootstrapCarTest(residuals, car, windowLength, { samples = 2000, seed = 1 } = {}) {
  if (!Array.isArray(residuals) || !Number.isFinite(car)) return null;
  if (!Number.isInteger(windowLength) || windowLength < 1) return null;
  if (!Number.isInteger(samples) || samples < MIN_SAMPLES) return null;
  const clean = residuals.filter(Number.isFinite);
  if (clean.length < MIN_ESTIMATION || windowLength > clean.length) return null;
  const centre = mean(clean);
  const centred = clean.map((x) => x - centre);
  const scale = Math.max(...centred.map(Math.abs));
  // Constant residuals (up to rounding noise) give no distribution to test against.
  if (!(scale > 1e-12 * Math.max(1, Math.abs(centre)))) return null;

  const random = seededRandom(seed);
  const sums = new Array(samples);
  const threshold = Math.abs(car) - 1e-12 * scale;
  let extreme = 0;
  for (let s = 0; s < samples; s += 1) {
    let total = 0;
    for (let i = 0; i < windowLength; i += 1) total += centred[Math.floor(random() * centred.length)];
    sums[s] = total;
    if (Math.abs(total) >= threshold) extreme += 1;
  }
  return {
    pValue: (extreme + 1) / (samples + 1),
    low: round(quantile(sums, 0.025), 8),
    high: round(quantile(sums, 0.975), 8),
  };
}

/**
 * Concentration of coverage across outlets. Names are compared ignoring case and
 * surrounding spaces; blank entries are skipped.
 * @returns {null | {sources: number, entropy: number, normalized: number,
 *   herfindahl: number, effectiveSources: number}}
 *   entropy in nats; normalized = entropy / ln(sources), 0 for a single outlet;
 *   effectiveSources = exp(entropy).
 */
export function sourceDiversity(sourceNames) {
  if (!Array.isArray(sourceNames)) return null;
  const counts = new Map();
  let total = 0;
  for (const name of sourceNames) {
    if (typeof name !== 'string') continue;
    const key = name.trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  if (total < 2) return null;
  let entropy = 0;
  let herfindahl = 0;
  for (const count of counts.values()) {
    const share = count / total;
    entropy -= share * Math.log(share);
    herfindahl += share * share;
  }
  const sources = counts.size;
  return {
    sources,
    entropy: round(entropy, 6),
    normalized: sources > 1 ? round(Math.min(1, entropy / Math.log(sources)), 6) : 0,
    herfindahl: round(herfindahl, 6),
    effectiveSources: round(Math.exp(entropy), 6),
  };
}

/**
 * Fisher's method: -2 sum ln p ~ chi-square with 2k degrees of freedom under the
 * joint null, assuming the p-values are independent. For even degrees of freedom
 * the upper tail is exactly exp(-x/2) * sum_{j<k} (x/2)^j / j!.
 * @returns {null | {statistic: number, df: number, pValue: number}}
 */
export function fisherCombine(pValues) {
  if (!Array.isArray(pValues)) return null;
  const clean = pValues.filter(isProbability);
  if (!clean.length) return null;
  // A reported zero would make the statistic infinite.
  const half = -clean.reduce((s, p) => s + Math.log(Math.max(p, 1e-300)), 0);
  let pValue = 1;
  if (half > 0) {
    // Summed in log space so that neither the powers nor exp(-x/2) overflow.
    let logTerm = 0;
    let logSum = 0;
    for (let j = 1; j < clean.length; j += 1) {
      logTerm += Math.log(half / j);
      const high = Math.max(logSum, logTerm);
      logSum = high + Math.log1p(Math.exp(Math.min(logSum, logTerm) - high));
    }
    pValue = Math.min(1, Math.exp(logSum - half));
  }
  // Not rounded: tail values far below 1e-8 are meaningful.
  return { statistic: 2 * half, df: 2 * clean.length, pValue };
}
