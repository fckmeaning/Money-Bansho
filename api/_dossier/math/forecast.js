// Headline -> conditional corridor. Not a price promise: the width comes from a variance model checked
// out of sample (volmodel.js), a headline type may widen it by a factor measured on past events, and the
// centre stays at zero because analogue means did not predict the sign. See docs/math/forecast.md.
import { reputationScore } from '../analyze.js';
import { withCloseTimes } from '../quant.js';
import { EVIDENCE } from './forecast-evidence.js';
import {
  ANCHORS, byHorizon, distribution, MODELS, prepareSeries, rangeVariance, stateAt, tQuantile, trackRecord,
} from './volmodel.js';
import { mean, round, stdev } from './stats.js';

export const HORIZONS = ANCHORS;
const FAN_HORIZONS = [1, 2, 3, 5, 8, 12, 20];
const MIN_ANALOGUES = 5;
const MIN_N_EFF = 3;
const MAX_ANALOGUES = 80;
const MAX_EVENTS = 15;
const MAX_PEERS = 5;
const MAX_NEAREST = 3;
const MIN_PEER_PAIRS = 60; // common daily returns needed for beta
const MIN_PEER_CORR = 0.3;
const PEER_DAYS = 365; // the window the link was checked on
const DAY = 86_400_000;

/**
 * Multipliers of the corridor width at 1/5/20 sessions, estimated by Student-t likelihood on events
 * before the test period, shrunk by n/(n+30) on the log scale and never below 1.
 * filing: SEC 8-K item 2.02 (results), 128 filings of 10 US companies, 2022-2024.
 * headline: classified English headlines of 19 US companies, 2024-07..2025-05.
 */
export const EVENT_SCALE = {
  filing: { earnings: [2.45, 1.45, 1.18] },
  headline: {
    leadership: [1.1, 1.25, 1.12],
    scandal: [1.08, 1.13, 1.05],
    regulation: [1.04, 1.15, 1.14],
    earnings: [1.15, 1.23, 1.15],
    deal: [1, 1.06, 1.06],
    politics: [1.1, 1.09, 1.11],
    product: [1.01, 1, 1.01],
  },
};

/** Which measured multiplier a headline gets: {kind: 'filing'|'headline'|'none', scale: [k1, k5, k20]}. */
export function eventScale(event) {
  const filing = event.source === 'SEC EDGAR';
  const scale = (filing ? EVENT_SCALE.filing : EVENT_SCALE.headline)[event.type];
  return scale?.some((k) => k > 1)
    ? { kind: filing ? 'filing' : 'headline', scale }
    : { kind: 'none', scale: HORIZONS.map(() => 1) };
}

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
  return picked;
}

function weightedQuantile(sorted, total, p) {
  let seen = 0;
  for (const item of sorted) {
    seen += item.w;
    if (seen >= p * total) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * What actually followed similar earlier headlines: a description only. It does not move the corridor,
 * because on held-out events it added no accuracy beyond the type multiplier (docs/math/forecast.md).
 */
export function describeAnalogues(sample, type) {
  const total = sample.reduce((a, x) => a + x.w, 0);
  const squares = sample.reduce((a, x) => a + x.w * x.w, 0);
  const nEff = total > 0 ? (total * total) / squares : 0;
  const enough = sample.length >= MIN_ANALOGUES && nEff >= MIN_N_EFF;
  const sorted = enough ? [...sample].sort((a, b) => a.value - b.value) : [];
  const at = (p) => (enough ? pct(weightedQuantile(sorted, total, p)) : null);
  return {
    n: sample.length,
    nEff: round(enough ? nEff : 0, 1),
    sameType: sample.length ? round(sample.filter((x) => x.type === type).length / sample.length, 2) : null,
    low80Pct: at(0.1),
    medianPct: at(0.5),
    high80Pct: at(0.9),
    upShare: enough ? round(sample.reduce((a, x) => a + (x.value > 0 ? x.w : 0), 0) / total, 3) : null,
  };
}

/** The corridor of one horizon from a model state, `widen` being the event multiplier. */
function corridor(state, last, h, widen = 1) {
  const forecast = state.forecast(h);
  const d = distribution(forecast, widen);
  const q = (p) => d.quantile(p);
  // "Usual move": half a 60-session deviation over the horizon, the same line for every model.
  const threshold = 0.5 * state.sigma60 * Math.sqrt(h);
  const adverse = d.cdf(-threshold);
  const favourable = 1 - d.cdf(threshold);
  return {
    h,
    low80Pct: pct(q(0.1)),
    high80Pct: pct(q(0.9)),
    lowPrice: round(last * Math.exp(q(0.1)), 4),
    midPrice: round(last, 4),
    highPrice: round(last * Math.exp(q(0.9)), 4),
    quantilesPct: { q025: pct(q(0.025)), q10: pct(q(0.1)), q25: pct(q(0.25)), q50: 0, q75: pct(q(0.75)), q90: pct(q(0.9)), q975: pct(q(0.975)) },
    thresholdPct: pct(threshold),
    scenarios: { adverse: round(adverse, 3), base: round(1 - adverse - favourable, 3), favourable: round(favourable, 3) },
    // Probability of a move larger than k usual daily deviations times sqrt(h), either way.
    exceed: [0.5, 1, 2].map((k) => {
      const size = k * state.sigma60 * Math.sqrt(h);
      return { k, pct: pct(size), prob: round(d.cdf(-size) + 1 - d.cdf(size), 3) };
    }),
    annualPct: round((d.stdev / Math.sqrt(h)) * Math.sqrt(252) * 100, 1),
    vsUsual: round(d.stdev / Math.sqrt(h) / state.usual, 2),
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
 * Linked companies: IF the company moves to an edge of its 80% corridor, a linked one moved on
 * average beta times as much. `linked` passes the correlation threshold; when nothing does, `nearest`
 * says how close the best ones came, without an estimate. Null when no pair has enough common days.
 */
export function peerImpact(rows, peers, corridors) {
  const recent = rows.length ? rows.filter((r) => r.day >= rows[rows.length - 1].day - PEER_DAYS) : [];
  const fits = [];
  for (const peer of peers) {
    const fit = peerBeta(recent, peer.byDay);
    if (fit) fits.push({ symbol: peer.symbol, name: peer.name, ...fit });
  }
  if (!fits.length) return null;
  fits.sort((a, b) => b.corr - a.corr);
  const brief = (f) => ({ symbol: f.symbol, name: f.name, beta: round(f.beta, 2), corr: round(f.corr, 2), pairs: f.n });
  const linked = fits.filter((f) => f.corr >= MIN_PEER_CORR).slice(0, MAX_PEERS).map((f) => ({
    ...brief(f),
    moves: corridors.map((c) => ({
      h: c.h,
      downPct: pct(f.beta * Math.log(1 + c.low80Pct / 100)),
      upPct: pct(f.beta * Math.log(1 + c.high80Pct / 100)),
    })),
  }));
  return {
    threshold: MIN_PEER_CORR,
    checked: fits.length,
    linked,
    nearest: linked.length ? [] : fits.slice(0, MAX_NEAREST).map(brief),
  };
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

/** Price series, the model state at the last close and event features; null without enough history. */
function prepare(history, benchmarkHistory, events, nowMs) {
  const series = prepareSeries(history, benchmarkHistory, nowMs);
  const { rows } = series;
  if (rows.length < 61) return null;
  const state = stateAt(series, rows.length - 1);
  if (!state) return null;
  const closes = rows.map((r) => r.c);
  const last = closes[closes.length - 1];
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
  return { series, state, rows, closes, last, indexed };
}

/** day0 = -1: no session has closed since the headline. */
function sampleOf(target, indexed, closes, h) {
  const before = target.day0 < 0 ? closes.length : target.day0;
  const candidates = indexed.filter((c) => c.day0 > 0 && c.day0 < before && c.type !== 'other' && c.event !== target.event);
  return analogues(target, candidates, closes, h, before);
}

/**
 * The 1/5/20-session corridor for EVERY classified event (computeForecasts details only the latest
 * ones). The type multiplier is applied only while no session has closed since the headline: after
 * that the reaction is already in the price. Returns a Map from the event object to its horizons.
 */
export function computeOutlooks({ history, benchmarkHistory, events, only = null }, nowMs = Date.now()) {
  const prepared = prepare(history, benchmarkHistory, events, nowMs);
  const out = new Map();
  if (!prepared) return out;
  const { state, closes, last, indexed } = prepared;
  const plain = HORIZONS.map((h) => corridor(state, last, h));
  for (const target of indexed) {
    if (target.type === 'other' || (only && !only.has(target.event.id))) continue;
    const fresh = target.day0 < 0;
    const { scale } = eventScale(target.event);
    out.set(target.event, HORIZONS.map((h, i) => {
      const multiplier = fresh ? scale[i] : 1;
      const c = multiplier > 1 ? corridor(state, last, h, multiplier) : plain[i];
      const sample = sampleOf(target, indexed, closes, h);
      return {
        h, rule: multiplier > 1 ? 'event' : 'volatility', fresh, multiplier, n: sample.length,
        low80Pct: c.low80Pct, high80Pct: c.high80Pct,
      };
    }));
  }
  return out;
}

/** What the corridor said at the close before a past headline, and what followed. */
function realized(series, target, scale) {
  const { rows } = series;
  if (target.day0 < 1) return null;
  const origin = target.day0 - 1;
  const state = stateAt(series, origin);
  if (!state) return null;
  return HORIZONS.flatMap((h, i) => {
    const end = target.day0 + h - 1;
    if (end >= rows.length) return [];
    const c = corridor(state, rows[origin].c, h, scale[i]);
    const actualPct = pct(Math.log(rows[end].c / rows[origin].c));
    return [{ h, actualPct, low80Pct: c.low80Pct, high80Pct: c.high80Pct, inside: actualPct >= c.low80Pct && actualPct <= c.high80Pct }];
  });
}

/** Share of each input in the variance forecast, for the "what it rests on" table. */
function drivers(state) {
  if (!state.features) return null;
  const ids = MODELS[state.kind].features;
  return HORIZONS.map((h) => {
    const { parts } = state.forecast(h);
    const values = state.features(h);
    return {
      h,
      parts: ids.map((id, i) => ({
        id,
        share: round(parts[i], 3),
        // The input itself as an annualised volatility.
        annualPct: round(Math.sqrt(Math.max(values[i], 0) * 252) * 100, 1),
      })),
    };
  });
}

/**
 * The constants and the last daily bar behind the corridor, so that the method page can redo the
 * calculation step by step with the same numbers.
 */
function workings(history, rows, state) {
  const last = rows[rows.length - 1];
  const bar = (history || []).find((b) => (Number.isInteger(b?.day) ? b.day : Math.floor(b?.t / DAY)) === last.day);
  const previousClose = rows[rows.length - 2].c;
  const variance = bar ? rangeVariance({ o: bar.o, h: bar.h, l: bar.l, c: last.c }, previousClose) : null;
  const model = state.kind === 'simple' ? null : MODELS[state.kind];
  return {
    lastBar: variance === null ? null : { o: bar.o, h: bar.h, l: bar.l, c: last.c, previousClose, variance },
    constants: model ? HORIZONS.map((h, i) => {
      const [scale, nu] = model.t[i];
      return { h, weights: model.weights[i], scale, nu, q90: tQuantile(0.9, nu) };
    }) : null,
    eventScale: EVENT_SCALE,
  };
}

export function computeForecasts({ history, benchmarkHistory, events, peers = [] }, nowMs = Date.now()) {
  const prepared = prepare(history, benchmarkHistory, events, nowMs);
  if (!prepared) return null;
  const { series, state, rows, closes, last, indexed } = prepared;
  const peerList = (peers || []).map((p) => peerSeries(p, nowMs)).filter(Boolean);
  const horizons = HORIZONS.map((h) => corridor(state, last, h));
  const fanScale = (scale, h) => byHorizon(scale, h);
  const fan = (scale = null) => FAN_HORIZONS.map((h) => {
    const c = corridor(state, last, h, scale ? fanScale(scale, h) : 1);
    return { h, ...c.quantilesPct };
  });

  const targets = indexed
    .filter((c) => c.type !== 'other')
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_EVENTS);

  const list = targets.map((target) => {
    const { event } = target;
    const adjustment = eventScale(event);
    return {
      eventId: event.id,
      time: event.time,
      title: event.title,
      // With a link the headline is translated like every other one (translate.js).
      url: event.url ?? '',
      type: event.type,
      tone: sign(event.sentiment),
      significance: event.significance ? { score: event.significance.score, ex: event.significance.ex } : null,
      fresh: target.day0 < 0,
      adjustment,
      horizons: HORIZONS.map((h, i) => ({ ...corridor(state, last, h, adjustment.scale[i]), multiplier: adjustment.scale[i] })),
      fan: adjustment.kind === 'none' ? null : fan(adjustment.scale),
      realized: realized(series, target, adjustment.scale),
      analogues: HORIZONS.map((h) => ({ h, ...describeAnalogues(sampleOf(target, indexed, closes, h), target.type) })),
      reputation: reputationBranches(events, event, nowMs),
    };
  });

  const records = HORIZONS.map((h) => trackRecord(series, h)).filter(Boolean);
  return {
    asOf: rows[rows.length - 1].closeAt,
    lastClose: last,
    dailySigmaPct: round(state.sigma60 * 100, 3),
    model: {
      kind: state.kind,
      marketUsed: state.marketUsed,
      sessions: rows.length - 1,
      usualAnnualPct: round(state.usual * Math.sqrt(252) * 100, 1),
      recentAnnualPct: round(state.sigma60 * Math.sqrt(252) * 100, 1),
      seasonQuarters: state.seasonQuarters ? HORIZONS.map((h) => state.seasonQuarters(h)) : null,
    },
    horizons,
    fan: fan(),
    drivers: drivers(state),
    workings: workings(history, rows, state),
    record: records,
    evidence: EVIDENCE,
    links: peerList.length ? peerImpact(rows, peerList, horizons) : null,
    events: list,
  };
}
