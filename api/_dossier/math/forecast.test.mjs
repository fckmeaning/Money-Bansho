import test from 'node:test';
import assert from 'node:assert/strict';
import { computeForecasts, kernelWeight, mixture, peerBeta, peerImpact } from './forecast.js';
import { normalCdf } from './special.js';
import { seededRandom, normalSample } from './stats.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 6, 14, 30); // a Monday, session open stamp

/** Weekday bars from daily log returns. */
function bars(returns, base = 100) {
  const out = [];
  let price = base;
  let t = START;
  for (const r of returns) {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += DAY;
    price *= Math.exp(r);
    out.push({ t, c: price, v: 1000 });
    t += DAY;
  }
  return out;
}

function world(n = 320, seed = 7, beta = 0.8) {
  const random = seededRandom(seed);
  const factor = Array.from({ length: n }, () => 0.01 * normalSample(random));
  const own = factor.map((f) => beta * f + 0.005 * normalSample(random));
  const peer = factor.map((f) => f + 0.004 * normalSample(random));
  const noise = Array.from({ length: n }, () => 0.012 * normalSample(random));
  return { own, peer, noise, history: bars(own), peerHistory: bars(peer) };
}

const dayTime = (history, i) => history[i].t + 3600_000; // an hour after the open: before the close
const event = (history, i, type = 'leadership', sentiment = -0.6) => ({
  id: `e${i}`, time: dayTime(history, i), type, sentiment, title: `t${i}`, source: 'Reuters', outlets: 2,
});
const NOW = (history) => history[history.length - 1].t + DAY;

test('too little history gives null, not a made-up forecast', () => {
  const { history } = world(40);
  assert.equal(computeForecasts({ history, events: [event(history, 20)], peers: [] }, NOW(history)), null);
});

test('without analogues the horizon falls back to plain volatility and says so', () => {
  const { history } = world();
  const out = computeForecasts({ history, events: [event(history, 300)] }, NOW(history));
  const h5 = out.events[0].horizons.find((x) => x.h === 5);
  assert.equal(h5.rule, 'baseline');
  assert.equal(h5.n, 0);
  assert.equal(h5.expectedPct, 0);
  assert.equal(h5.peers, null);
});

test('other event types still inform through the kernel, with less weight, and the pool says so', () => {
  const { history } = world();
  const events = [10, 40, 70, 100, 130, 160].map((i, k) => event(history, i, k % 2 ? 'lawsuit' : 'product', -0.5));
  events.push(event(history, 300, 'regulatory', -0.5));
  const out = computeForecasts({ history, events }, NOW(history));
  const item = out.events.find((e) => e.eventId === 'e300');
  const h1 = item.horizons.find((x) => x.h === 1);
  assert.equal(h1.rule, 'kernel');
  assert.ok(h1.n >= 5);
  assert.equal(h1.sameType, 0);
  assert.ok(h1.nEff > 0 && h1.nEff <= h1.n, 'n_eff cannot exceed the number of analogues');
});

test('kernel weight falls with tone distance, type mismatch and age, and is 1 for a twin', () => {
  const a = { type: 'deal', tone: 0.5, sig: 50, vol: 0, time: 1e12 };
  assert.equal(kernelWeight(a, { ...a }), 1);
  assert.ok(kernelWeight(a, { ...a, tone: -0.5 }) < kernelWeight(a, { ...a, tone: 0.3 }));
  assert.ok(kernelWeight(a, { ...a, type: 'scandal' }) < 0.2);
  assert.ok(kernelWeight(a, { ...a, time: a.time - 700 * DAY }) < kernelWeight(a, { ...a, time: a.time - 30 * DAY }));
  assert.ok(kernelWeight(a, { ...a, sig: 95 }) < kernelWeight(a, { ...a, sig: 55 }));
});

test('mixture: no analogues is exactly the normal baseline; with analogues it stays a proper distribution', () => {
  const sigma = 0.02;
  const none = mixture([], [], sigma, 5);
  const base = sigma * Math.sqrt(5);
  assert.equal(none.enough, false);
  for (const x of [-0.05, 0, 0.03]) assert.ok(Math.abs(none.cdf(x) - normalCdf(x / base)) < 1e-12);
  assert.ok(Math.abs(none.quantile(0.9) - 1.2815515655 * base) < 1e-6);
  const values = [0.05, 0.03, -0.01, 0.04, 0.06, 0.02, 0.05];
  const m = mixture(values, values.map(() => 1), sigma, 5);
  assert.equal(m.enough, true);
  let previous = -1;
  for (const p of [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]) {
    const q = m.quantile(p);
    assert.ok(q > previous);
    assert.ok(Math.abs(m.cdf(q) - p) < 1e-6);
    previous = q;
  }
  // The mean is shrunk towards zero: far below the raw analogue mean 0.0314.
  assert.ok(m.mean > 0 && m.mean < 0.02);
});

test('fan: seven horizons, quantiles ordered, corridor widens with the horizon', () => {
  const { history } = world();
  const events = Array.from({ length: 9 }, (_, k) => event(history, 20 + k * 25, 'leadership', -0.6));
  events.push(event(history, 300, 'leadership', -0.6));
  const out = computeForecasts({ history, events }, NOW(history));
  const { fan } = out.events.find((e) => e.eventId === 'e300');
  assert.equal(fan.length, 7);
  for (const row of fan) assert.ok(row.q10 < row.q25 && row.q25 < row.q50 && row.q50 < row.q75 && row.q75 < row.q90);
  assert.ok(fan[6].q90 - fan[6].q10 > fan[0].q90 - fan[0].q10);
});

test('every horizon reports its sample size and a coherent corridor', () => {
  const { history } = world();
  const events = Array.from({ length: 9 }, (_, k) => event(history, 20 + k * 25, 'leadership', -0.6));
  events.push(event(history, 300, 'leadership', -0.6));
  const out = computeForecasts({ history, events }, NOW(history));
  for (const e of out.events) {
    for (const h of e.horizons) {
      assert.ok(h.lowPrice < h.midPrice && h.midPrice < h.highPrice);
      assert.ok(h.low80Pct < h.high80Pct);
      assert.ok(Number.isInteger(h.n));
      const s = h.scenarios;
      assert.ok(Math.abs(s.adverse + s.base + s.favourable - 1) < 0.01);
    }
  }
  const h20 = out.events.find((e) => e.eventId === 'e300').horizons.find((x) => x.h === 20);
  assert.ok(h20.n <= 12, 'non-overlapping 20-session windows cannot be more than the span allows');
});

test('peerBeta recovers the loading of a peer on a common factor', () => {
  const { history, peerHistory } = world(320, 11, 1);
  const rowsLike = history.map((b, i) => ({
    day: Math.floor(b.t / DAY),
    s: i ? Math.log(b.c / history[i - 1].c) : null,
  }));
  const byDay = new Map(peerHistory.map((b) => [Math.floor(b.t / DAY), b.c]));
  const fit = peerBeta(rowsLike, byDay);
  assert.ok(fit.n > 250);
  assert.ok(fit.corr > 0.8, `corr ${fit.corr}`);
  assert.ok(Math.abs(fit.beta - 1) < 0.25, `beta ${fit.beta}`);
});

test('related companies: estimate with sample sizes; uncorrelated peers are dropped', () => {
  const w = world();
  const unrelated = bars(w.noise);
  const events = Array.from({ length: 12 }, (_, k) => event(w.history, 20 + k * 22, 'leadership', -0.6));
  events.push(event(w.history, 300, 'leadership', -0.6));
  const peers = [
    { symbol: 'PEER', name: 'Peer', history: w.peerHistory },
    { symbol: 'NOISE', name: 'Noise', history: unrelated },
    { symbol: 'TINY', name: 'Tiny', history: w.peerHistory.slice(0, 20) },
  ];
  const out = computeForecasts({ history: w.history, events, peers }, NOW(w.history));
  const h = out.events.find((e) => e.eventId === 'e300').horizons.find((x) => x.h === 5);
  assert.ok(h.peers, 'peers expected');
  assert.deepEqual(h.peers.map((p) => p.symbol), ['PEER']);
  const p = h.peers[0];
  assert.ok(p.pairs >= 60 && p.corr >= 0.3);
  assert.ok(p.cases >= 3 ? typeof p.analoguePct === 'number' : p.analoguePct === null);
});

test('peerImpact returns null when nothing qualifies', () => {
  assert.equal(peerImpact([], [], [], 0, 5), null);
});

test('no peers at all: horizons carry peers null', () => {
  const { history } = world();
  const out = computeForecasts({ history, events: [event(history, 300)], peers: [] }, NOW(history));
  assert.ok(out.events[0].horizons.every((h) => h.peers === null));
});

test('the analogue mean is shrunk harder than the spread (calibrated on real 8-K events)', () => {
  const { history } = world();
  const events = Array.from({ length: 9 }, (_, k) => event(history, 20 + k * 25, 'leadership', -0.6));
  events.push(event(history, 300, 'leadership', -0.6));
  const out = computeForecasts({ history, events }, NOW(history));
  const h1 = out.events.find((e) => e.eventId === 'e300').horizons.find((x) => x.h === 1);
  assert.ok(h1.n >= 5);
  assert.ok(Math.abs(h1.weight - h1.nEff / (h1.nEff + 30)) < 0.003, 'mean weight uses the effective sample size');
  assert.ok(h1.spreadWeight > h1.weight, 'the spread is trusted sooner than the mean');
});
