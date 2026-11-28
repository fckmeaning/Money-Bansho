// Directional forecast: always names a side (up or down) and a price. The drift is a deliberately simple
// estimate from closing prices with weights fixed in advance. The sign is a weak signal, so every answer
// carries its own walk-forward record on the same history, next to the "always up" baseline.
import { mean, round, stdev } from './stats.js';

export const DRIFT = {
  longRun: 0.4, // mean daily log return of up to 250 sessions
  trend: 0.4, // mean daily log return of the last 60 sessions
  reversal: 0.2, // share of the last week's move expected to be given back
  cap: 0.5, // limit of the drift in 60-session deviations over the horizon
};
const MIN_SESSIONS = 60;
const CHECKS_SPAN = 250;

/** Expected log change over `h` sessions, using only closes up to index `t`; null without history. */
export function drift(closes, t, h) {
  if (t < MIN_SESSIONS) return null;
  const returns = [];
  for (let i = Math.max(1, t - 249); i <= t; i += 1) returns.push(Math.log(closes[i] / closes[i - 1]));
  const recent = returns.slice(-MIN_SESSIONS);
  const week = Math.log(closes[t] / closes[t - 5]);
  const raw = h * (DRIFT.longRun * mean(returns) + DRIFT.trend * mean(recent))
    - DRIFT.reversal * week * (Math.min(h, 5) / 5);
  const limit = DRIFT.cap * stdev(recent) * Math.sqrt(h);
  return Math.max(-limit, Math.min(limit, raw));
}

const sideOf = (x) => (x < 0 ? 'down' : 'up');

/**
 * How often the sign was right on non-overlapping past windows of `h` sessions, the newest ending at the
 * last close. `upShare` is what answering "up" every time would have scored. Flat outcomes are skipped.
 */
export function directionRecord(closes, h, span = CHECKS_SPAN) {
  const last = closes.length - 1;
  let n = 0;
  let hits = 0;
  let ups = 0;
  for (let t = last - h; t >= Math.max(MIN_SESSIONS, last - h - span + 1); t -= h) {
    const actual = closes[t + h] - closes[t];
    if (!actual) continue;
    n += 1;
    if (sideOf(drift(closes, t, h)) === sideOf(actual)) hits += 1;
    if (actual > 0) ups += 1;
  }
  return n ? { n, hit: round(hits / n, 3), upShare: round(ups / n, 3) } : null;
}

/**
 * The directional forecast of one horizon. `spread` is the centred distribution of the corridor;
 * shifted by the drift it gives the probability of a rise.
 */
export function directionAt(closes, h, spread) {
  const mu = drift(closes, closes.length - 1, h);
  if (mu === null) return null;
  const last = closes[closes.length - 1];
  return {
    h,
    side: sideOf(mu),
    movePct: round((Math.exp(mu) - 1) * 100, 2),
    price: round(last * Math.exp(mu), 4),
    probUp: round(spread.cdf(mu), 3),
    record: directionRecord(closes, h),
  };
}
