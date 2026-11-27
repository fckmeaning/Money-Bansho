import test from 'node:test';
import assert from 'node:assert/strict';
import { computeForecasts, peerBeta, peerImpact } from './forecast.js';
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

test('thin same-type pool widens to the same-tone pool and labels it', () => {
  const { history } = world();
  const events = [10, 40, 70, 100, 130, 160].map((i, k) => event(history, i, k % 2 ? 'lawsuit' : 'product', -0.5));
  events.push(event(history, 300, 'regulatory', -0.5));
  const out = computeForecasts({ history, events }, NOW(history));
  const item = out.events.find((e) => e.eventId === 'e300');
  const h1 = item.horizons.find((x) => x.h === 1);
  assert.equal(h1.rule, 'tone');
  assert.ok(h1.n >= 5);
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
