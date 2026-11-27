// News -> conditional scenario. Not a price promise: a kernel-weighted summary of what followed
// earlier headlines that looked like this one (type, tone, significance, volatility regime, age),
// shrunk to ordinary volatility in proportion to the effective sample size. See docs/math/forecast.md.
import { reputationScore } from '../analyze.js';
import { alignedReturns, withCloseTimes } from '../quant.js';
import { normalCdf } from './special.js';
import { mean, round, stdev } from './stats.js';

const HORIZONS = [1, 5, 20];
const FAN_HORIZONS = [1, 2, 3, 5, 8, 12, 20];
const PRIOR = 10; // pseudo-observations of "nothing special happens"
const MIN_ANALOGUES = 5;
const MIN_N_EFF = 3;
const MAX_ANALOGUES = 80;
const MAX_EVENTS = 15;
const MAX_PEERS = 5;
const MIN_PEER_PAIRS = 60; // common daily returns needed for beta
const MIN_PEER_CORR = 0.3;
const MIN_PEER_CASES = 3; // analogue windows with a peer price needed to show co-movement
const DAY = 86_400_000;

/** Gaussian kernel bandwidths of the similarity between two headlines. */
export const KERNEL = {
  tone: 0.5, // sentiment, -1..1
  significance: 25, // ex-ante significance points, 0..100
  volatility: 0.35, // ln of the 20/120-session volatility ratio
  timeDays: 365, // older cases matter less
  otherType: 0.15, // kernel factor for a different event type
};

const sign = (x) => (x > 0.05 ? 1 : x < -0.05 ? -1 : 0);
const pct = (log) => round((Math.exp(log) - 1) * 100, 2);
const gauss = (u) => Math.exp(-0.5 * u * u);

/** ln(20-session / 120-session volatility) before session `index`, or null. */
function volRegime(rows, index) {
  const past = rows.slice(Math.max(0, index - 120), index).map((r) => r.s).filter(Number.isFinite);
  if (past.length < 40) return null;
  const long = stdev(past);
  const short = stdev(past.slice(-20));
  return long > 0 && short > 0 ? Math.log(short / long) : null;
}

/** Kernel weight of an earlier case for a target: product of Gaussian kernels over the similarity axes. */
export function kernelWeight(target, other) {
  let w = target.type === other.type ? 1 : KERNEL.otherType;
  w *= gauss(((target.tone ?? 0) - (other.tone ?? 0)) / KERNEL.tone);
  if (Number.isFinite(target.sig) && Number.isFinite(other.sig)) w *= gauss((target.sig - other.sig) / KERNEL.significance);
  if (Number.isFinite(target.vol) && Number.isFinite(other.vol)) w *= gauss((target.vol - other.vol) / KERNEL.volatility);
  return w * gauss((target.time - other.time) / DAY / KERNEL.timeDays);
}

/**
 * Earlier cases with a finished h-session window, weighted by the kernel; heaviest first, windows
 * that overlap a heavier one are dropped so that the outcomes stay independent.
 */
function analogues(target, candidates, closes, h, before) {
  const weighted = [];
  for (const c of candidates) {
    const end = c.day0 + h - 1;
    if (end >= closes.length || end >= before) continue;
    const w = kernelWeight(target, c);
    if (w >= 1e-3) weighted.push({ ...c, w, value: Math.log(closes[end] / closes[c.day0 - 1]) });
  }
  weighted.sort((a, b) => b.w - a.w);
  const picked = [];
  for (const c of weighted) {
    if (picked.length >= MAX_ANALOGUES) break;
    if (picked.every((p) => c.day0 + h - 1 < p.day0 || c.day0 > p.day0 + h - 1)) picked.push(c);
  }
  return picked.sort((a, b) => a.day0 - b.day0);
}

/**
 * Mixture of the kernel-smoothed empirical distribution of outcomes and ordinary volatility:
 * F(x) = lambda * sum w_j Phi((x - x_j)/b) / sum w + (1 - lambda) * Phi(x / (sigma sqrt h)),
 * lambda = n_eff / (n_eff + PRIOR). Returns the CDF, quantile function and mean.
 */
export function mixture(values, weights, sigma, h) {
  const base = sigma * Math.sqrt(h);
  const total = weights.reduce((a, b) => a + b, 0);
  const squares = weights.reduce((a, b) => a + b * b, 0);
  const nEff = total > 0 ? (total * total) / squares : 0;
  const enough = values.length >= MIN_ANALOGUES && nEff >= MIN_N_EFF;
  const lambda = enough ? nEff / (nEff + PRIOR) : 0;
  const centre = enough ? values.reduce((a, x, i) => a + weights[i] * x, 0) / total : 0;
  const spread = enough ? Math.sqrt(values.reduce((a, x, i) => a + weights[i] * (x - centre) ** 2, 0) / total) : 0;
  const bandwidth = enough ? Math.max(1.06 * spread * nEff ** -0.2, 0.15 * base) : base;
  const cdf = (x) => {
    let own = 0;
    if (lambda > 0) for (let i = 0; i < values.length; i += 1) own += weights[i] * normalCdf((x - values[i]) / bandwidth);
    return (lambda > 0 ? lambda * (own / total) : 0) + (1 - lambda) * normalCdf(x / base);
  };
  const scale = Math.max(base, spread) * 8;
  const quantile = (p) => {
    let lo = -scale;
    let hi = scale;
    for (let i = 0; i < 48; i += 1) {
      const mid = (lo + hi) / 2;
      if (cdf(mid) < p) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  return { cdf, quantile, mean: lambda * centre, lambda, nEff, enough };
}

/** Walk-forward over the picked analogues: weights and outcomes of earlier ones only. */
function selfCheck(sample, sigma, h) {
  let tested = 0;
  let hits = 0;
  let covered = 0;
  let up = 0;
  for (let i = MIN_ANALOGUES; i < sample.length; i += 1) {
    const earlier = sample.slice(0, i);
    const target = sample[i];
    const m = mixture(earlier.map((s) => s.value), earlier.map((s) => kernelWeight(target, s)), sigma, h);
    const actual = target.value;
    tested += 1;
    if ((m.mean >= 0) === (actual >= 0)) hits += 1;
    if (actual >= 0) up += 1;
    if (actual >= m.quantile(0.1) && actual <= m.quantile(0.9)) covered += 1;
  }
  if (!tested) return null;
  return {
    n: tested,
    hitRate: round(hits / tested, 3),
    // What always guessing the more frequent direction would have scored.
    baseRate: round(Math.max(up, tested - up) / tested, 3),
    coverage80: round(covered / tested, 3),
  };
}

/** Peer closes by calendar day, from the same bars the target uses. */
function peerSeries(peer, nowMs) {
  const bars = withCloseTimes(peer?.history).filter((b) => b.closeAt <= nowMs);
  if (bars.length < MIN_PEER_PAIRS) return null;
  return { symbol: peer.symbol, name: peer.name ?? peer.symbol, byDay: new Map(bars.map((b) => [b.day, b.c])) };
}

/** Beta, correlation and sample size of the peer's daily returns on the target's. */
export function peerBeta(rows, byDay) {
  const xs = [];
  const ys = [];
  for (let i = 1; i < rows.length; i += 1) {
    const a = byDay.get(rows[i - 1].day);
    const b = byDay.get(rows[i].day);
    if (Number.isFinite(rows[i].s) && a && b) {
      xs.push(rows[i].s);
      ys.push(Math.log(b / a));
    }
  }
  const n = xs.length;
  if (n < MIN_PEER_PAIRS) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  return { beta: sxy / sxx, corr: sxy / Math.sqrt(sxx * syy), n };
}

/**
 * Estimate (not a forecast) of how listed peers of the same market could move.
 * Two readings: beta x the company's expected move, and the peer's own mean
 * return over the same analogue windows (shrunk like the company's). Both are
 * flagged with their sample sizes; no peer passing the checks gives null.
 */
export function peerImpact(rows, peers, sample, mu, h) {
  const out = [];
  for (const peer of peers) {
    const fit = peerBeta(rows, peer.byDay);
    if (!fit || fit.corr < MIN_PEER_CORR) continue;
    const cases = [];
    for (const c of sample) {
      const a = peer.byDay.get(rows[c.day0 - 1]?.day);
      const b = peer.byDay.get(rows[c.day0 + h - 1]?.day);
      if (a && b) cases.push(Math.log(b / a));
    }
    const nCases = cases.length;
    const enough = nCases >= MIN_PEER_CASES;
    out.push({
      symbol: peer.symbol,
      name: peer.name,
      beta: round(fit.beta, 2),
      corr: round(fit.corr, 2),
      pairs: fit.n,
      betaPct: pct(fit.beta * mu),
      analoguePct: enough ? pct((nCases / (nCases + PRIOR_MEAN)) * mean(cases)) : null,
      cases: nCases,
    });
  }
  out.sort((a, b) => b.corr - a.corr);
  return out.length ? out.slice(0, MAX_PEERS) : null;
}

function reputationBranches(events, event, nowMs) {
  const tone = sign(event.sentiment) * Math.max(0.5, Math.abs(event.sentiment || 0));
  const followUp = (sentiment, source, outlets) => [
    ...events, { id: 'scenario', time: nowMs, type: event.type, sentiment, source, outlets },
  ];
  return {
    now: reputationScore(events, nowMs).score,
    confirmed: tone ? reputationScore(followUp(tone, event.source, 4), nowMs).score : null,
    denied: tone ? reputationScore(followUp(-tone, 'Reuters', 1), nowMs).score : null,
    quietWeek: reputationScore(events, nowMs + 7 * DAY).score,
  };
}

/** One horizon for one target: kernel-weighted analogues -> mixture distribution -> corridor and scenarios. */
function horizonEstimate({ target, candidates, closes, rows, sigma, last, before, h, peerList, withExtras }) {
  const sample = analogues(target, candidates, closes, h, before);
  const m = mixture(sample.map((x) => x.value), sample.map((x) => x.w), sigma, h);
  const used = m.enough ? sample : [];
  const threshold = 0.5 * sigma * Math.sqrt(h);
  const adverse = m.cdf(-threshold);
  const favourable = 1 - m.cdf(threshold);
  const q = (p) => m.quantile(p);
  const q10 = q(0.1);
  const q90 = q(0.9);
  const q50 = q(0.5);
  const base = {
    h,
    rule: m.enough ? 'kernel' : 'baseline',
    n: used.length,
    nEff: round(m.enough ? m.nEff : 0, 1),
    weight: round(m.lambda, 3),
    expectedPct: pct(m.mean),
    low80Pct: pct(q10),
    high80Pct: pct(q90),
    lowPrice: round(last * Math.exp(q10), 4),
    midPrice: round(last * Math.exp(q50), 4),
    highPrice: round(last * Math.exp(q90), 4),
    quantilesPct: { q10: pct(q10), q25: pct(q(0.25)), q50: pct(q50), q75: pct(q(0.75)), q90: pct(q90) },
    probUp: round(1 - m.cdf(0), 3),
    thresholdPct: pct(threshold),
    scenarios: {
      adverse: round(adverse, 3),
      base: round(1 - adverse - favourable, 3),
      favourable: round(favourable, 3),
    },
  };
  if (!withExtras) return base;
  return {
    ...base,
    sameType: used.length ? round(used.filter((x) => x.type === target.type).length / used.length, 2) : null,
    check: used.length ? selfCheck(used, sigma, h) : null,
    peers: peerList.length && m.enough ? peerImpact(rows, peerList, used, m.mean, h) : null,
  };
}

export function computeForecasts({ history, events, peers = [] }, nowMs = Date.now()) {
  const rows = alignedReturns(history, [], nowMs);
  const returns = rows.map((r) => r.s).filter(Number.isFinite);
  if (returns.length < 60) return null;
  const sigma = stdev(returns.slice(-60));
  if (!(sigma > 0)) return null;
  const closes = rows.map((r) => r.c);
  const last = closes[closes.length - 1];
  const peerList = (peers || []).map((p) => peerSeries(p, nowMs)).filter(Boolean);
  const dayOf = (time) => rows.findIndex((r) => r.closeAt > time);
  const featuresOf = (event, day0) => ({
    event,
    day0,
    type: event.type,
    tone: Number(event.sentiment) || 0,
    sig: Number.isFinite(event.significance?.ex) ? event.significance.ex : null,
    vol: volRegime(rows, day0 < 0 ? closes.length : day0),
    time: event.time,
  });
  const indexed = events
    .map((event) => ({ event, day0: dayOf(event.time) }))
    .filter((c) => c.day0 !== 0)
    .sort((a, b) => a.event.time - b.event.time)
    .map((c) => featuresOf(c.event, c.day0));

  const targets = indexed
    .filter((c) => c.type !== 'other')
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_EVENTS);

  const list = targets.map((target) => {
    const { event, day0 } = target;
    // day0 = -1: no session has closed since the headline.
    const before = day0 < 0 ? closes.length : day0;
    const candidates = indexed.filter((c) => c.day0 > 0 && c.day0 < before && c.type !== 'other' && c.event !== event);
    const common = { target, candidates, closes, rows, sigma, last, before, peerList };
    return {
      eventId: event.id,
      time: event.time,
      title: event.title,
      type: event.type,
      tone: sign(event.sentiment),
      significance: event.significance ? { score: event.significance.score, ex: event.significance.ex } : null,
      horizons: HORIZONS.map((h) => horizonEstimate({ ...common, h, withExtras: true })),
      fan: FAN_HORIZONS.map((h) => {
        const e = horizonEstimate({ ...common, h, withExtras: false });
        return { h, ...e.quantilesPct, n: e.n, nEff: e.nEff };
      }),
      reputation: reputationBranches(events, event, nowMs),
    };
  });

  return {
    asOf: rows[rows.length - 1].closeAt,
    lastClose: last,
    dailySigmaPct: round(sigma * 100, 3),
    model: { kernel: KERNEL, prior: PRIOR, minAnalogues: MIN_ANALOGUES, minNEff: MIN_N_EFF },
    events: list,
  };
}
