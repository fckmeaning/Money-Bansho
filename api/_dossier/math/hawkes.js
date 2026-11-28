// Univariate Hawkes process with an exponential kernel, fitted by maximum
// likelihood to headline timestamps. Pure ESM, deterministic (edge safe).
// Formulas and limitations: docs/math/newsflow-inference.md
//
//   lambda(t) = mu + sum_{t_i < t} n * beta * exp(-beta (t - t_i))      (t in days)
//
// n is the branching ratio (expected direct offspring per event), ln 2 / beta the
// half-life of the excitation. History before the window is taken as empty.
import { round } from './stats.js';

const DAY_MS = 86_400_000;
/** Upper limit of the branching ratio: the process must stay stationary (n < 1). */
const MAX_BRANCHING = 0.999;
/** Shortest identifiable half-life, 15 minutes: below it we would fit timestamp noise. */
const MIN_HALF_LIFE_DAYS = 15 / 1440;
/** Longest half-life as a share of the window: slower decay is indistinguishable from a trend. */
const MAX_HALF_LIFE_SHARE = 1 / 5;
/** Required AIC advantage over homogeneous Poisson (equals a likelihood ratio above 10). */
const AIC_MARGIN = 6;
/** Identical timestamps are spread evenly over this much time. */
const TIE_SPAN_MS = 60_000;
const GRID_POINTS = 40;
const GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * Identical timestamps come from finite clock resolution, not from simultaneous
 * events. Left as they are they make the likelihood reward beta -> infinity.
 * Each group of k equal times is placed at the midpoints of k equal slices of a
 * one-minute interval centred on the stamp and clipped to the window.
 */
function spreadTies(sorted, start, end) {
  const times = [];
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j] === sorted[i]) j += 1;
    const size = j - i;
    if (size === 1) {
      times.push(sorted[i]);
    } else {
      const span = Math.min(TIE_SPAN_MS, end - start);
      const from = Math.min(Math.max(sorted[i] - span / 2, start), end - span);
      for (let k = 0; k < size; k += 1) times.push(from + ((k + 0.5) * span) / size);
    }
    i = j;
  }
  return times.sort((a, b) => a - b);
}

/** A_i = sum_{j<i} exp(-beta (t_i - t_j)) by the O(N) recursion. */
function excitationSums(t, beta, out) {
  out[0] = 0;
  for (let i = 1; i < t.length; i += 1) out[i] = Math.exp(-beta * (t[i] - t[i - 1])) * (1 + out[i - 1]);
  return out;
}

/**
 * Exact maximiser over (mu, n) for a fixed beta. The log-likelihood
 *   sum ln(mu + n beta A_i) - mu T - n C
 * is concave in (mu, n). Euler's identity puts every optimum with n < max on the
 * line mu T + n C = N, which leaves a one-dimensional concave problem.
 */
function solveForBeta(t, horizon, beta, a) {
  const count = t.length;
  excitationSums(t, beta, a);
  let c = 0;
  for (let i = 0; i < count; i += 1) c -= Math.expm1(-beta * (horizon - t[i]));
  const slopeShift = c / horizon;

  // First and second derivative of the likelihood along the line.
  const derivatives = (n) => {
    const base = (count - n * c) / horizon;
    let first = 0;
    let second = 0;
    for (let i = 0; i < count; i += 1) {
      const ratio = (beta * a[i] - slopeShift) / (base + n * beta * a[i]);
      first += ratio;
      second -= ratio * ratio;
    }
    return [first, second];
  };

  const finish = (mu, n) => {
    let logLik = -mu * horizon - n * c;
    for (let i = 0; i < count; i += 1) logLik += Math.log(mu + n * beta * a[i]);
    return { mu, n, beta, logLik };
  };

  if (derivatives(0)[0] <= 0) return finish(count / horizon, 0);

  // Largest n that keeps mu positive on the line.
  const positiveLimit = c > 0 ? (count / c) * (1 - 1e-12) : Infinity;
  if (MAX_BRANCHING < positiveLimit && derivatives(MAX_BRANCHING)[0] >= 0) {
    // Branching bound active: solve sum 1 / lambda_i = T for mu alone. The left
    // side is convex and decreasing, so Newton from the left cannot overshoot.
    let mu = 1 / horizon;
    for (let step = 0; step < 100; step += 1) {
      let value = -horizon;
      let slope = 0;
      for (let i = 0; i < count; i += 1) {
        const inverse = 1 / (mu + MAX_BRANCHING * beta * a[i]);
        value += inverse;
        slope -= inverse * inverse;
      }
      const delta = -value / slope;
      if (!(delta > mu * 1e-12)) break;
      mu += delta;
    }
    return finish(mu, MAX_BRANCHING);
  }

  let low = 0;
  let high = Math.min(MAX_BRANCHING, positiveLimit);
  let n = high / 2;
  for (let step = 0; step < 100; step += 1) {
    const [first, second] = derivatives(n);
    if (first > 0) low = n;
    else high = n;
    let next = n - first / second;
    if (!(next > low && next < high)) next = (low + high) / 2;
    const moved = Math.abs(next - n);
    n = next;
    if (moved < 1e-10) break;
  }
  return finish((count - n * c) / horizon, n);
}

/** Profile likelihood over ln(beta): coarse grid, then golden section at every grid peak. */
function maximise(t, horizon, lowLog, highLog) {
  const a = new Float64Array(t.length);
  const at = (x) => ({ x, ...solveForBeta(t, horizon, Math.exp(x), a) });
  const grid = [];
  for (let i = 0; i < GRID_POINTS; i += 1) grid.push(at(lowLog + ((highLog - lowLog) * i) / (GRID_POINTS - 1)));
  let best = grid[0];
  for (const point of grid) if (point.logLik > best.logLik) best = point;
  for (let i = 0; i < GRID_POINTS; i += 1) {
    const here = grid[i].logLik;
    const left = i > 0 ? grid[i - 1].logLik : -Infinity;
    const right = i < GRID_POINTS - 1 ? grid[i + 1].logLik : -Infinity;
    if (!(here >= left && here >= right && (here > left || here > right))) continue;
    let from = grid[Math.max(0, i - 1)].x;
    let to = grid[Math.min(GRID_POINTS - 1, i + 1)].x;
    let first = at(to - GOLDEN * (to - from));
    let second = at(from + GOLDEN * (to - from));
    for (let step = 0; step < 40 && to - from > 1e-6; step += 1) {
      if (first.logLik >= second.logLik) {
        to = second.x;
        second = first;
        first = at(to - GOLDEN * (to - from));
      } else {
        from = first.x;
        first = second;
        second = at(from + GOLDEN * (to - from));
      }
    }
    for (const point of [first, second]) if (point.logLik > best.logLik) best = point;
  }
  return best;
}

/**
 * Maximised log-likelihood of an inhomogeneous Poisson process with a log-linear
 * rate exp(a + b t): the rival explanation "coverage drifts, nothing triggers
 * anything". With x = bT the score equation is 1/(1 - e^-x) - 1/x = mean(t)/T.
 */
function trendLogLik(t, horizon) {
  const count = t.length;
  const total = t.reduce((s, time) => s + time / horizon, 0);
  const meanShare = (x) => (Math.abs(x) < 1e-4 ? 0.5 + x / 12 : -1 / Math.expm1(-x) - 1 / x);
  let low = -1e5;
  let high = 1e5;
  for (let step = 0; step < 100; step += 1) {
    const mid = (low + high) / 2;
    if (meanShare(mid) < total / count) low = mid;
    else high = mid;
  }
  const x = (low + high) / 2;
  // ln(x / (e^x - 1)), written so that neither sign of x overflows.
  let logNorm = 0;
  if (x > 1e-8) logNorm = Math.log(x) - x - Math.log(-Math.expm1(-x));
  else if (x < -1e-8) logNorm = Math.log(-x) - Math.log(-Math.expm1(x));
  return count * (Math.log(count / horizon) + logNorm) + x * total - count;
}

/**
 * Third rival: Poisson with one change of level (two rates and a change point),
 * the shape a capped search leaves behind: a few old items, then a dense recent
 * block. Both segments last at least one day, otherwise a tiny segment around a
 * burst would win trivially. Returns -Infinity when the window is too short.
 */
function stepLogLik(t, horizon) {
  const count = t.length;
  const segment = (events, length) => (events ? events * Math.log(events / length) : 0);
  let best = -Infinity;
  for (let i = 0; i < count; i += 1) {
    // The likelihood peaks with the change point right at an event, on either side.
    for (const before of [i, i + 1]) {
      const change = Math.min(Math.max(t[i], 1), horizon - 1);
      if (horizon < 2 || (change !== t[i] && before !== i)) continue;
      let head = before;
      // A clipped change point no longer sits on event i: recount its side.
      if (change !== t[i]) {
        head = 0;
        while (head < count && t[head] < change) head += 1;
      }
      best = Math.max(best, segment(head, change) + segment(count - head, horizon - change) - count);
    }
  }
  return best;
}

/** Solves the symmetric positive definite system A x = b (Cholesky), or null. */
function solveSymmetric(matrix, vector) {
  const size = vector.length;
  const lower = matrix.map(() => new Array(size).fill(0));
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let rest = matrix[i][j];
      for (let k = 0; k < j; k += 1) rest -= lower[i][k] * lower[j][k];
      if (i !== j) lower[i][j] = rest / lower[j][j];
      else if (rest > 0) lower[i][i] = Math.sqrt(rest);
      else return null;
    }
  }
  const x = [...vector];
  for (let i = 0; i < size; i += 1) {
    for (let k = 0; k < i; k += 1) x[i] -= lower[i][k] * x[k];
    x[i] /= lower[i][i];
  }
  for (let i = size - 1; i >= 0; i -= 1) {
    for (let k = i + 1; k < size; k += 1) x[i] -= lower[k][i] * x[k];
    x[i] /= lower[i][i];
  }
  return x;
}

/**
 * Second rival: inhomogeneous Poisson with a drifting, daily and weekly rhythm,
 *   ln rate = trend + two harmonics of one day + two harmonics of one week,
 * fitted by damped Newton (concave) with midpoint quadrature of the compensator.
 * Newsrooms sleep at night and at weekends; that alone must not look like
 * self-excitation. Rhythms the window is too short to identify are left out.
 * @returns {{logLik: number, parameters: number}}
 */
function calendarFit(t, horizon) {
  const periods = [];
  if (horizon >= 2) periods.push(1, 0.5);
  if (horizon >= 14) periods.push(7, 3.5);
  const size = 2 + 2 * periods.length;
  const features = (time) => {
    const row = [1, time / horizon - 0.5];
    for (const period of periods) {
      const angle = (2 * Math.PI * time) / period;
      row.push(Math.cos(angle), Math.sin(angle));
    }
    return row;
  };
  const nodes = Math.max(200, Math.ceil(horizon * 48));
  const width = horizon / nodes;
  const grid = Array.from({ length: nodes }, (_, q) => features((q + 0.5) * width));
  const observed = new Array(size).fill(0);
  for (const time of t) features(time).forEach((value, j) => { observed[j] += value; });
  const dot = (row, theta) => row.reduce((s, value, j) => s + value * theta[j], 0);
  const evaluate = (theta) => {
    const rates = grid.map((row) => width * Math.exp(dot(row, theta)));
    return { theta, rates, logLik: dot(observed, theta) - rates.reduce((s, r) => s + r, 0) };
  };

  let state = evaluate([Math.log(t.length / horizon), ...new Array(size - 1).fill(0)]);
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const gradient = [...observed];
    const information = Array.from({ length: size }, () => new Array(size).fill(0));
    for (let q = 0; q < nodes; q += 1) {
      const row = grid[q];
      for (let i = 0; i < size; i += 1) {
        const weighted = state.rates[q] * row[i];
        gradient[i] -= weighted;
        for (let j = 0; j <= i; j += 1) information[i][j] += weighted * row[j];
      }
    }
    for (let i = 0; i < size; i += 1) information[i][i] += 1e-8;
    const step = solveSymmetric(information, gradient);
    if (!step) break;
    let next = null;
    for (let scale = 1; scale > 1e-4; scale /= 2) {
      const trial = evaluate(state.theta.map((value, i) => value + scale * step[i]));
      if (trial.logLik > state.logLik) {
        next = trial;
        break;
      }
    }
    if (!next) break;
    const gain = next.logLik - state.logLik;
    state = next;
    if (gain < 1e-7) break;
  }
  return { logLik: state.logLik, parameters: size };
}

/**
 * Kolmogorov-Smirnov test of the compensator increments against Exp(1)
 * (time-rescaling theorem). Asymptotic distribution with Stephens' correction.
 */
function timeRescalingPValue(t, { mu, n, beta }) {
  const a = excitationSums(t, beta, new Float64Array(t.length));
  const uniforms = t.map((time, i) => {
    const gap = i === 0 ? time : time - t[i - 1];
    const excited = i === 0 ? 0 : -n * Math.expm1(-beta * gap) * (1 + a[i - 1]);
    return -Math.expm1(-(mu * gap + excited));
  }).sort((x, y) => x - y);
  const size = uniforms.length;
  let distance = 0;
  for (let i = 0; i < size; i += 1) {
    distance = Math.max(distance, (i + 1) / size - uniforms[i], uniforms[i] - i / size);
  }
  const root = Math.sqrt(size);
  const lambda = (root + 0.12 + 0.11 / root) * distance;
  if (lambda < 0.2) return 1;
  let total = 0;
  for (let k = 1; k <= 100; k += 1) {
    const term = Math.exp(-2 * k * k * lambda * lambda);
    total += k % 2 ? term : -term;
    if (term < 1e-16) break;
  }
  return Math.min(1, Math.max(0, 2 * total));
}

/**
 * @param {number[]} timesMs event times (publication times, ms), any order
 * @param {number} nowMs right edge of the observation window
 * @returns {null | {events: number, mu: number, branching: number, halfLifeHours: number|null,
 *   intensityNow: number, baselinePerDay: number, logLik: number, aic: number, poissonAic: number,
 *   trendAic: number, calendarAic: number, stepAic: number|null, selfExciting: boolean, fitPValue: number, windowStartCovered: boolean,
 *   halfLifeAtBound: 'min'|'max'|null, branchingAtBound: boolean}}
 *   mu, intensityNow and baselinePerDay are events per day; baselinePerDay is the
 *   plain average N / windowDays (the Poisson estimate), mu the fitted exogenous rate.
 */
export function fitHawkes(timesMs, nowMs, { windowDays = 30, minEvents = 20 } = {}) {
  if (!Array.isArray(timesMs) || !Number.isFinite(nowMs) || !(windowDays > 0) || !Number.isFinite(windowDays)) return null;
  const start = nowMs - windowDays * DAY_MS;
  const inside = timesMs
    .filter((time) => Number.isFinite(time) && time >= start && time <= nowMs)
    .sort((x, y) => x - y);
  const needed = Math.max(5, Number.isFinite(minEvents) ? minEvents : 20);
  if (inside.length < needed) return null;
  // Mostly identical stamps carry no information about timing.
  if (new Set(inside).size < Math.max(5, Math.ceil(needed / 2))) return null;

  const t = spreadTies(inside, start, nowMs).map((time) => (time - start) / DAY_MS);
  const count = t.length;
  const horizon = windowDays;
  const maxHalfLife = Math.max(windowDays * MAX_HALF_LIFE_SHARE, 2 * MIN_HALF_LIFE_DAYS);
  const lowLog = Math.log(Math.LN2 / maxHalfLife);
  const highLog = Math.log(Math.LN2 / MIN_HALF_LIFE_DAYS);
  const best = maximise(t, horizon, lowLog, highLog);
  if (!Number.isFinite(best.logLik)) return null;

  const excited = best.n > 1e-6;
  const poissonLogLik = count * Math.log(count / horizon) - count;
  const aic = 2 * 3 - 2 * best.logLik;
  const poissonAic = 2 - 2 * poissonLogLik;
  const trendAic = 2 * 2 - 2 * trendLogLik(t, horizon);
  const calendar = calendarFit(t, horizon);
  const calendarAic = 2 * calendar.parameters - 2 * calendar.logLik;
  const step = stepLogLik(t, horizon);
  const stepAic = Number.isFinite(step) ? 2 * 3 - 2 * step : Infinity;
  const branchingAtBound = best.n >= MAX_BRANCHING - 1e-3;
  let halfLifeAtBound = null;
  if (excited && best.x - lowLog < 1e-3) halfLifeAtBound = 'max';
  if (excited && highLog - best.x < 1e-3) halfLifeAtBound = 'min';

  // A capped, recency-biased feed leaves the start of the window empty. The
  // silent stretch is "far" when it exceeds both 20% of the window and five
  // average gaps; the fit then confuses missing data with clustering.
  const windowStartCovered = t[0] <= Math.max(0.2 * horizon, (5 * horizon) / count);

  let intensityNow = best.mu;
  for (let i = 0; i < count; i += 1) intensityNow += best.n * best.beta * Math.exp(-best.beta * (horizon - t[i]));

  return {
    events: count,
    mu: round(best.mu, 6),
    branching: round(best.n, 6),
    halfLifeHours: excited ? round((Math.LN2 / best.beta) * 24, 4) : null,
    intensityNow: round(intensityNow, 6),
    baselinePerDay: round(count / horizon, 6),
    logLik: round(best.logLik, 6),
    aic: round(aic, 6),
    poissonAic: round(poissonAic, 6),
    trendAic: round(trendAic, 6),
    calendarAic: round(calendarAic, 6),
    stepAic: round(stepAic, 6),
    // Claimed only when clustering beats every Poisson rival (flat, drifting,
    // calendar-driven, one level shift), the sample covers the window and the fit
    // is inside its bounds.
    selfExciting: Math.min(poissonAic, trendAic, calendarAic, stepAic) - aic > AIC_MARGIN
      && windowStartCovered && !branchingAtBound && halfLifeAtBound !== 'max',
    fitPValue: round(timeRescalingPValue(t, best), 6),
    windowStartCovered,
    halfLifeAtBound,
    branchingAtBound,
  };
}
