// Descriptive statistics and a seeded random generator. Pure ESM (edge safe).
export const sum = (xs) => xs.reduce((total, x) => total + x, 0);
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);

/** Sample variance (n - 1). */
export function variance(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return xs.reduce((total, x) => total + (x - m) ** 2, 0) / (xs.length - 1);
}

export function stdev(xs) {
  const v = variance(xs);
  return v === null ? null : Math.sqrt(v);
}

/** Linear-interpolation quantile, q in 0..1. */
export function quantile(xs, q) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export const median = (xs) => quantile(xs, 0.5);

function standardizedMoment(xs, order) {
  if (xs.length < 4) return null;
  const m = mean(xs);
  const second = xs.reduce((total, x) => total + (x - m) ** 2, 0) / xs.length;
  if (!(second > 0)) return null;
  return xs.reduce((total, x) => total + (x - m) ** order, 0) / xs.length / second ** (order / 2);
}

export const skewness = (xs) => standardizedMoment(xs, 3);
export function excessKurtosis(xs) {
  const k = standardizedMoment(xs, 4);
  return k === null ? null : k - 3;
}

/** 1-based ranks, ties receive their average rank. */
export function ranks(xs) {
  const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const result = new Array(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    for (let k = i; k <= j; k += 1) result[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return result;
}

/** mulberry32: small deterministic generator, so published numbers do not flicker. */
export function seededRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box-Muller) from a uniform generator. */
export function normalSample(random) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

export const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
