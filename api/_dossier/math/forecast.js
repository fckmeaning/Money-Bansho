// News -> conditional scenario. Not a price promise: a shrunk summary of what
// followed earlier headlines of the same kind for the same company.
import { reputationScore } from '../analyze.js';
import { alignedReturns, withCloseTimes } from '../quant.js';
import { normalCdf } from './special.js';
import { mean, round, stdev, variance } from './stats.js';

const HORIZONS = [1, 5, 20];
const PRIOR = 10; // pseudo-observations of "nothing special happens"
const MIN_ANALOGUES = 5;
const MAX_EVENTS = 15;
const MAX_PEERS = 5;
const MIN_PEER_PAIRS = 60; // common daily returns needed for beta
const MIN_PEER_CORR = 0.3;
const MIN_PEER_CASES = 3; // analogue windows with a peer price needed to show co-movement
const Z80 = 1.2815515655;
const DAY = 86_400_000;

const sign = (x) => (x > 0.05 ? 1 : x < -0.05 ? -1 : 0);
const pct = (log) => round((Math.exp(log) - 1) * 100, 2);

/** Non-overlapping h-session returns after earlier matching days, oldest first. */
function analogues(candidates, closes, h, before) {
  const picked = [];
  let free = 0;
  for (const c of candidates) {
    const end = c.day0 + h - 1;
    // The whole window must be over before the target's first session.
    if (c.day0 < free || end >= closes.length || end >= before) continue;
    picked.push({ ...c, value: Math.log(closes[end] / closes[c.day0 - 1]) });
    free = c.day0 + h;
  }
  return picked;
}

/** Shrinks the analogue mean and variance towards zero drift and normal volatility. */
function estimate(values, sigma, h) {
  const n = values.length;
  const weight = n / (n + PRIOR);
  const mu = n ? weight * mean(values) : 0;
  const base = sigma ** 2 * h;
  const spread = n > 1 ? (1 - weight) * base + weight * variance(values) : base;
  return { mu, sd: Math.sqrt(spread), weight };
}

/** Walk-forward: did the sign of earlier analogues match the next one? */
function selfCheck(sample, sigma, h) {
  let tested = 0;
  let hits = 0;
  let covered = 0;
  let up = 0;
  for (let i = MIN_ANALOGUES; i < sample.length; i += 1) {
    const { mu, sd } = estimate(sample.slice(0, i).map((s) => s.value), sigma, h);
    const actual = sample[i].value;
    tested += 1;
    if ((mu >= 0) === (actual >= 0)) hits += 1;
    if (actual >= 0) up += 1;
    if (Math.abs(actual - mu) <= Z80 * sd) covered += 1;
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
      analoguePct: enough ? pct((nCases / (nCases + PRIOR)) * mean(cases)) : null,
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
  const indexed = events
    .map((event) => ({ event, day0: dayOf(event.time) }))
    .filter((c) => c.day0 !== 0)
    .sort((a, b) => a.event.time - b.event.time);

  const targets = indexed
    .filter((c) => c.event.type !== 'other')
    .sort((a, b) => b.event.time - a.event.time)
    .slice(0, MAX_EVENTS);

  const list = targets.map(({ event, day0 }) => {
    // day0 = -1: no session has closed since the headline.
    const before = day0 < 0 ? closes.length : day0;
    const tone = sign(event.sentiment);
    const earlier = indexed.filter((c) => c.day0 > 0 && c.day0 < before && c.event.type === event.type);
    const sameTone = earlier.filter((c) => sign(c.event.sentiment) === tone);
    const sameToneAny = indexed.filter(
      (c) => c.day0 > 0 && c.day0 < before && c.event.type !== 'other' && sign(c.event.sentiment) === tone,
    );

    const horizons = HORIZONS.map((h) => {
      let rule = 'type+tone';
      let sample = analogues(sameTone, closes, h, before);
      if (sample.length < MIN_ANALOGUES) {
        rule = 'type';
        sample = analogues(earlier, closes, h, before);
      }
      if (sample.length < MIN_ANALOGUES && tone) {
        // Widest pool: any classified headline of the same tone. Less alike, so
        // it only fills in when the narrower pools are too thin.
        rule = 'tone';
        sample = analogues(sameToneAny, closes, h, before);
      }
      if (sample.length < MIN_ANALOGUES) {
        rule = 'baseline';
        sample = [];
      }
      const { mu, sd, weight } = estimate(sample.map((s) => s.value), sigma, h);
      const threshold = 0.5 * sigma * Math.sqrt(h);
      const adverse = normalCdf((-threshold - mu) / sd);
      const favourable = 1 - normalCdf((threshold - mu) / sd);
      return {
        h,
        rule,
        n: sample.length,
        weight: round(weight, 3),
        expectedPct: pct(mu),
        low80Pct: pct(mu - Z80 * sd),
        high80Pct: pct(mu + Z80 * sd),
        lowPrice: round(last * Math.exp(mu - Z80 * sd), 4),
        midPrice: round(last * Math.exp(mu), 4),
        highPrice: round(last * Math.exp(mu + Z80 * sd), 4),
        probUp: round(normalCdf(mu / sd), 3),
        thresholdPct: pct(threshold),
        scenarios: {
          adverse: round(adverse, 3),
          base: round(1 - adverse - favourable, 3),
          favourable: round(favourable, 3),
        },
        check: sample.length ? selfCheck(sample, sigma, h) : null,
        peers: peerList.length && rule !== 'baseline' ? peerImpact(rows, peerList, sample, mu, h) : null,
      };
    });

    return {
      eventId: event.id,
      time: event.time,
      title: event.title,
      type: event.type,
      tone,
      horizons,
      reputation: reputationBranches(events, event, nowMs),
    };
  });

  return { asOf: rows[rows.length - 1].closeAt, lastClose: last, dailySigmaPct: round(sigma * 100, 3), events: list };
}
