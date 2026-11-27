// Special functions and distributions. Pure ESM, no dependencies (edge safe).
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];
const TINY = 1e-300;
const EPS = 1e-14;
const MAX_TERMS = 500;

/** ln Γ(x), Lanczos approximation (g = 7), reflection for x < 0.5. */
export function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0];
  for (let i = 1; i < 9; i += 1) sum += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Regularised lower incomplete gamma P(a, x). */
export function gammaP(a, x) {
  if (!(a > 0) || !(x >= 0)) return NaN;
  if (x === 0) return 0;
  const scale = Math.exp(-x + a * Math.log(x) - logGamma(a));
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < MAX_TERMS; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPS) break;
    }
    return sum * scale;
  }
  // Lentz continued fraction for Q(a, x)
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_TERMS; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < EPS) break;
  }
  return 1 - scale * h;
}

function betaFraction(x, a, b) {
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < MAX_TERMS; m += 1) {
    const m2 = 2 * m;
    const even = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    const odd = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    let step = 1;
    for (const k of [even, odd]) {
      d = 1 + k * d;
      if (Math.abs(d) < TINY) d = TINY;
      c = 1 + k / c;
      if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      step = d * c;
      h *= step;
    }
    if (Math.abs(step - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). */
export function betaI(x, a, b) {
  if (!(x >= 0 && x <= 1) || !(a > 0) || !(b > 0)) return NaN;
  if (x === 0 || x === 1) return x;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2)
    ? (front * betaFraction(x, a, b)) / a
    : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

export function erf(x) {
  if (x === 0) return 0;
  return Math.sign(x) * gammaP(0.5, x * x);
}

export const normalCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
export const normalLogPdf = (x, mean = 0, sd = 1) => -0.5 * Math.log(2 * Math.PI) - Math.log(sd) - 0.5 * ((x - mean) / sd) ** 2;

/** Inverse standard normal CDF (Acklam) with one Halley refinement. */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  let x;
  if (p < 0.02425) x = tail(Math.sqrt(-2 * Math.log(p)));
  else if (p > 0.97575) x = -tail(Math.sqrt(-2 * Math.log1p(-p)));
  else {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q)
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const u = (normalCdf(x) - p) * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export function studentTCdf(t, nu) {
  if (!(nu > 0) || Number.isNaN(t)) return NaN;
  const tail = 0.5 * betaI(nu / (nu + t * t), nu / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/** Two-sided p-value of a Student t statistic. */
export function studentTTwoSided(t, nu) {
  if (!(nu > 0) || !Number.isFinite(t)) return NaN;
  return betaI(nu / (nu + t * t), nu / 2, 0.5);
}

export function studentTQuantile(p, nu) {
  if (!(p > 0 && p < 1) || !(nu > 0)) return NaN;
  let low = -1;
  let high = 1;
  while (studentTCdf(low, nu) > p) low *= 2;
  while (studentTCdf(high, nu) < p) high *= 2;
  for (let i = 0; i < 200 && high - low > 1e-10; i += 1) {
    const mid = (low + high) / 2;
    if (studentTCdf(mid, nu) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Log density of a located and scaled Student t. */
export function studentTLogPdf(x, nu, location = 0, scale = 1) {
  const z = (x - location) / scale;
  return logGamma((nu + 1) / 2) - logGamma(nu / 2) - 0.5 * Math.log(nu * Math.PI)
    - Math.log(scale) - ((nu + 1) / 2) * Math.log1p((z * z) / nu);
}

/** Upper tail of a chi-square distribution with k degrees of freedom. */
export const chiSquareSf = (x, k) => (x <= 0 ? 1 : 1 - gammaP(k / 2, x / 2));
