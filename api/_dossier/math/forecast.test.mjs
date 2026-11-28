import test from 'node:test';
import assert from 'node:assert/strict';
import { computeForecasts, computeOutlooks, EVENT_SCALE, eventScale, kernelWeight, peerBeta, peerImpact } from './forecast.js';
import { seededRandom, normalSample } from './stats.js';

const DAY = 86_400_000;
const START = Date.UTC(2023, 0, 2, 14, 30); // a Monday, session open stamp

/** Weekday bars from daily log returns; with `ranges` also open/high/low around them. */
function bars(returns, { base = 100, ranges = false } = {}) {
  const random = seededRandom(99);
  const out = [];
  let price = base;
  let t = START;
  for (const r of returns) {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += DAY;
    const previous = price;
    price *= Math.exp(r);
    const bar = { t, c: price, v: 1000 };
    if (ranges) {
      bar.o = previous * Math.exp(0.002 * normalSample(random));
      bar.h = Math.max(bar.o, price) * Math.exp(0.004 * Math.abs(normalSample(random)));
      bar.l = Math.min(bar.o, price) * Math.exp(-0.004 * Math.abs(normalSample(random)));
    }
    out.push(bar);
    t += DAY;
  }
  return out;
}

function world(n = 320, seed = 7, beta = 0.8, ranges = false) {
  const random = seededRandom(seed);
  const factor = Array.from({ length: n }, () => 0.01 * normalSample(random));
  const own = factor.map((f) => beta * f + 0.005 * normalSample(random));
  const peer = factor.map((f) => f + 0.004 * normalSample(random));
  const noise = Array.from({ length: n }, () => 0.012 * normalSample(random));
  return { history: bars(own, { ranges }), peerHistory: bars(peer), marketHistory: bars(factor), noiseHistory: bars(noise) };
}

const dayTime = (history, i) => history[i].t + 3600_000; // an hour after the open: before the close
const event = (history, i, type = 'leadership', sentiment = -0.6, source = 'Reuters') => ({
  id: `e${i}-${type}`, time: dayTime(history, i), type, sentiment, title: `t${i}`, url: `https://example.org/${i}`, source, outlets: 2,
});
const NOW = (history) => history[history.length - 1].t + DAY;
/** A headline published after the last close: no session has traded on it. */
const fresh = (history, type, source = 'Reuters') => ({
  ...event(history, history.length - 1, type, -0.5, source), id: `fresh-${type}`, time: history[history.length - 1].t + DAY - 60_000,
});

test('too little history gives null, not a made-up forecast', () => {
  const { history } = world(40);
  assert.equal(computeForecasts({ history, events: [event(history, 20)] }, NOW(history)), null);
});

test('the model follows the data: ranges, closes only, or the plain 60-session fallback', () => {
  const full = world(320, 7, 0.8, true);
  const closes = world(320);
  const short = world(120);
  const kind = (w) => computeForecasts({ history: w.history, benchmarkHistory: w.marketHistory, events: [] }, NOW(w.history)).model;
  assert.equal(kind(full).kind, 'range');
  assert.equal(kind(full).marketUsed, true);
  assert.equal(kind(closes).kind, 'close');
  assert.equal(kind(short).kind, 'simple');
  assert.equal(computeForecasts({ history: short.history, events: [] }, NOW(short.history)).drivers, null);
});

test('corridors are centred on zero, symmetric in probability and wider with the horizon', () => {
  const w = world(560, 3, 0.8, true);
  const out = computeForecasts({ history: w.history, benchmarkHistory: w.marketHistory, events: [] }, NOW(w.history));
  let width = 0;
  for (const h of out.horizons) {
    assert.ok(h.low80Pct < 0 && h.high80Pct > 0);
    assert.ok(h.lowPrice < out.lastClose && out.lastClose < h.highPrice);
    assert.equal(h.quantilesPct.q50, 0);
    const s = h.scenarios;
    assert.ok(Math.abs(s.adverse - s.favourable) < 0.002);
    assert.ok(Math.abs(s.adverse + s.base + s.favourable - 1) < 0.01);
    assert.ok(h.exceed[0].prob > h.exceed[1].prob && h.exceed[1].prob > h.exceed[2].prob);
    assert.ok(h.high80Pct - h.low80Pct > width);
    width = h.high80Pct - h.low80Pct;
  }
  assert.equal(out.fan.length, 7);
  for (let i = 1; i < out.fan.length; i += 1) assert.ok(out.fan[i].q90 > out.fan[i - 1].q90);
  for (const row of out.drivers) assert.ok(Math.abs(row.parts.reduce((a, p) => a + p.share, 0) - 1) < 0.01);
});

test('a turbulent last month widens the corridor, and the benchmark calming down narrows it', () => {
  const random = seededRandom(5);
  const calm = Array.from({ length: 520 }, () => 0.008 * normalSample(random));
  const stormy = calm.map((r, i) => (i >= 495 ? r * 4 : r));
  const run = (returns, benchmarkHistory) => computeForecasts(
    { history: bars(returns, { ranges: false }), benchmarkHistory, events: [] }, NOW(bars(returns)),
  );
  assert.ok(run(stormy).horizons[0].high80Pct > 1.5 * run(calm).horizons[0].high80Pct);
  assert.ok(run(calm, bars(calm)).horizons[0].high80Pct < run(calm, bars(stormy)).horizons[0].high80Pct);
});

test('only measured event types widen the corridor; a SEC results filing more than a headline', () => {
  assert.deepEqual(eventScale({ type: 'other', source: 'Reuters' }), { kind: 'none', scale: [1, 1, 1] });
  assert.deepEqual(eventScale({ type: 'leadership', source: 'SEC EDGAR' }), { kind: 'none', scale: [1, 1, 1] });
  const filing = eventScale({ type: 'earnings', source: 'SEC EDGAR' });
  assert.equal(filing.kind, 'filing');
  assert.ok(filing.scale[0] > eventScale({ type: 'earnings', source: 'Reuters' }).scale[0]);
  for (const group of Object.values(EVENT_SCALE)) for (const scale of Object.values(group)) assert.ok(scale.every((k) => k >= 1));
});

test('the outlook is widened only while no session has closed since the item', () => {
  const w = world(320);
  const now = NOW(w.history);
  const results = fresh(w.history, 'earnings', 'SEC EDGAR');
  const old = event(w.history, 250, 'earnings', 0, 'SEC EDGAR');
  const out = computeOutlooks({ history: w.history, events: [results, old] }, now);
  const [a] = out.get(results);
  const [b] = out.get(old);
  assert.equal(a.rule, 'event');
  assert.equal(a.multiplier, EVENT_SCALE.filing.earnings[0]);
  assert.equal(b.rule, 'volatility');
  assert.equal(b.multiplier, 1);
  assert.ok(a.high80Pct > 2 * b.high80Pct);
});

test('earlier headlines describe the past but do not move the corridor', () => {
  const w = world(320);
  const target = fresh(w.history, 'leadership');
  const history = Array.from({ length: 9 }, (_, k) => event(w.history, 20 + k * 25, 'leadership', -0.6));
  const alone = computeForecasts({ history: w.history, events: [target] }, NOW(w.history));
  const many = computeForecasts({ history: w.history, events: [...history, target] }, NOW(w.history));
  const pick = (out) => out.events.find((e) => e.eventId === target.id);
  assert.deepEqual(pick(many).horizons, pick(alone).horizons);
  assert.equal(pick(alone).analogues[0].n, 0);
  assert.equal(pick(alone).analogues[0].medianPct, null);
  const seen = pick(many).analogues[0];
  assert.ok(seen.n >= 5 && seen.low80Pct <= seen.medianPct && seen.medianPct <= seen.high80Pct);
  assert.ok(seen.nEff > 0 && seen.nEff <= seen.n);
  assert.equal(pick(many).fresh, true);
  assert.equal(pick(many).realized, null);
  assert.equal(pick(many).url, target.url);
});

test('a past headline is compared with what followed, using only bars known before it', () => {
  const w = world(320);
  const target = event(w.history, 280, 'earnings');
  const now = NOW(w.history);
  const full = computeForecasts({ history: w.history, events: [target] }, now).events[0];
  assert.equal(full.fresh, false);
  assert.deepEqual(full.realized.map((r) => r.h), [1, 5, 20]);
  const first = full.realized[0];
  const move = (w.history[280].c / w.history[279].c - 1) * 100;
  assert.ok(Math.abs(first.actualPct - move) < 0.01);
  assert.equal(first.inside, first.actualPct >= first.low80Pct && first.actualPct <= first.high80Pct);
  // Changing the prices after the event cannot change the corridor drawn before it.
  const changed = w.history.map((b, i) => (i >= 280 ? { ...b, c: b.c * 1.3 } : b));
  const again = computeForecasts({ history: changed, events: [target] }, now).events[0];
  assert.deepEqual(again.realized.map((r) => [r.low80Pct, r.high80Pct]), full.realized.map((r) => [r.low80Pct, r.high80Pct]));
});

test('the live record is walk-forward and sized to the history', () => {
  const w = world(560, 21, 0.8, true);
  const out = computeForecasts({ history: w.history, events: [] }, NOW(w.history));
  assert.deepEqual(out.record.map((r) => r.h), [1, 5, 20]);
  for (const r of out.record) {
    assert.equal(r.n, 250);
    assert.equal(r.independent, Math.floor(250 / r.h));
    assert.ok(r.cover80 > 0.6 && r.cover80 <= 1);
    assert.ok(r.cover95 >= r.cover80);
  }
});

test('kernel weight falls with tone distance, type mismatch and age, and is 1 for a twin', () => {
  const a = { type: 'deal', tone: 0.5, sig: 50, vol: 0, time: 1e12 };
  assert.equal(kernelWeight(a, { ...a }), 1);
  assert.ok(kernelWeight(a, { ...a, tone: -0.5 }) < kernelWeight(a, { ...a, tone: 0.3 }));
  assert.ok(kernelWeight(a, { ...a, type: 'scandal' }) < 0.2);
  assert.ok(kernelWeight(a, { ...a, time: a.time - 700 * DAY }) < kernelWeight(a, { ...a, time: a.time - 30 * DAY }));
  assert.ok(kernelWeight(a, { ...a, sig: 95 }) < kernelWeight(a, { ...a, sig: 55 }));
});

const rowsOf = (history) => history.map((b, i) => ({ day: Math.floor(b.t / DAY), s: i ? Math.log(b.c / history[i - 1].c) : null }));
const byDayOf = (history) => new Map(history.map((b) => [Math.floor(b.t / DAY), b.c]));

test('peerBeta recovers the loading of a peer on a common factor', () => {
  const { history, peerHistory } = world(320, 11, 1);
  const fit = peerBeta(rowsOf(history), byDayOf(peerHistory));
  assert.ok(fit.n > 250);
  assert.ok(fit.corr > 0.8, `corr ${fit.corr}`);
  assert.ok(Math.abs(fit.beta - 1) < 0.25, `beta ${fit.beta}`);
});

test('linked companies: only correlated ones get an estimate, the rest are named without one', () => {
  const w = world(320);
  const corridors = [{ h: 5, low80Pct: -4, high80Pct: 4.2 }];
  const peers = (list) => list.map(([symbol, history]) => ({ symbol, name: symbol, byDay: byDayOf(history) }));
  const out = peerImpact(rowsOf(w.history), peers([['PEER', w.peerHistory], ['NOISE', w.noiseHistory], ['TINY', w.peerHistory.slice(0, 20)]]), corridors);
  assert.equal(out.checked, 2);
  assert.deepEqual(out.linked.map((p) => p.symbol), ['PEER']);
  const [move] = out.linked[0].moves;
  assert.ok(move.downPct < 0 && move.upPct > 0);
  assert.deepEqual(out.nearest, []);
  const none = peerImpact(rowsOf(w.history), peers([['NOISE', w.noiseHistory]]), corridors);
  assert.deepEqual(none.linked, []);
  assert.deepEqual(none.nearest.map((p) => p.symbol), ['NOISE']);
  assert.equal('moves' in none.nearest[0], false);
  assert.equal(peerImpact([], [], corridors), null);
  assert.equal(computeForecasts({ history: w.history, events: [], peers: [] }, NOW(w.history)).links, null);
});
