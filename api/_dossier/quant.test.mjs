import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alignedReturns, attentionIndex, companySignals, corroborationWeight, eventStudy, evidenceWeight,
  fitMarketModel, newsSurprise, scoreUncertainty, significance, sourceWeight, volatilityRegime,
} from './quant.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 0, 5, 14.5);

// Deterministic pseudo-noise, so the tests never flake.
const noise = (i, scale) => Math.sin(i * 12.9898) * scale;

/** Stock follows alpha + beta * market + noise, with optional extra log returns. */
function series({ days = 180, beta = 1.5, shocks = {}, volume = {} } = {}) {
  const bench = [];
  const stock = [];
  let m = 1000;
  let s = 100;
  for (let i = 0; i < days; i += 1) {
    const t = START + i * DAY;
    if (i) {
      const rm = noise(i, 0.012);
      m *= Math.exp(rm);
      s *= Math.exp(beta * rm + noise(i + 500, 0.004) + (shocks[i] ?? 0));
    }
    bench.push({ t, c: m });
    stock.push({ t, c: s, v: volume[i] ?? 1000 });
  }
  return { stock, bench, now: START + days * DAY, at: (i) => START + i * DAY + HOUR };
}

test('aligned returns need the benchmark on both dates', () => {
  const { stock, bench, now } = series({ days: 5 });
  const rows = alignedReturns(stock, bench.filter((_, i) => i !== 2), now);
  assert.equal(rows[0].s, null);
  assert.ok(Number.isFinite(rows[1].m));
  assert.equal(rows[2].m, null);
  assert.equal(rows[3].m, null);
  assert.ok(Number.isFinite(rows[4].m));
});

test('market model recovers beta and shrinks it towards one', () => {
  const { stock, bench, now } = series();
  const fit = fitMarketModel(alignedReturns(stock, bench, now));
  assert.equal(fit.model, 'market');
  assert.ok(Math.abs(fit.beta - (0.67 * 1.5 + 0.33)) < 0.08, String(fit.beta));
  assert.ok(fit.sigma > 0);
});

test('short samples fall back to the naive model', () => {
  const { stock, bench, now } = series({ days: 20 });
  const fit = fitMarketModel(alignedReturns(stock, bench, now));
  assert.equal(fit.model, 'naive');
  assert.equal(fit.beta, 1);
  assert.equal(fit.alpha, 0);
});

test('event study separates a real shock from noise', () => {
  const quiet = series();
  const calm = eventStudy(quiet.stock, quiet.bench, quiet.at(150), quiet.now);
  const hit = series({ shocks: { 151: -0.09 } });
  // Published after the close of day 150, so day 151 is day 0.
  const shock = eventStudy(hit.stock, hit.bench, hit.at(150) + 8 * HOUR, hit.now);
  assert.equal(shock.level, 'significant');
  assert.ok(shock.carPct < -7 && shock.carPct > -11, String(shock.carPct));
  assert.ok(Math.abs(shock.z) > Math.abs(calm.z));
  assert.equal(shock.sessions, 2);
  assert.equal(shock.volumeRatio, 1);
});

test('event study reports a move that happened before the news', () => {
  const { stock, bench, now, at } = series({ shocks: { 148: 0.05, 149: 0.04 } });
  const study = eventStudy(stock, bench, at(150), now);
  assert.ok(study.preCarPct > 6);
  assert.ok(study.preZ > 1.96);
});

test('event study returns null when it cannot know', () => {
  const { stock, bench, now, at } = series();
  assert.equal(eventStudy(stock, bench, now + DAY, now), null); // no later close
  assert.equal(eventStudy(stock, bench, START - 30 * DAY, now), null); // before history
  assert.equal(eventStudy(stock, [], at(150), now), null); // no benchmark
  assert.equal(eventStudy([], [], at(150), now), null);
});

test('significance thresholds', () => {
  assert.equal(significance(0.4), 'noise');
  assert.equal(significance(-1.2), 'notable');
  assert.equal(significance(2.5), 'significant');
  assert.equal(significance(null), null);
});

test('news surprise needs a baseline and grows with the count', () => {
  const now = START + 40 * DAY;
  const baseline = Array.from({ length: 28 }, (_, i) => now - (1.5 + (i % 14)) * DAY);
  assert.equal(newsSurprise([now - HOUR], now), null);
  const normal = newsSurprise([...baseline, now - HOUR, now - 2 * HOUR], now);
  assert.equal(normal.expected, 2);
  assert.ok(Math.abs(normal.z) < 0.1);
  const burst = newsSurprise([...baseline, ...Array(12).fill(now - HOUR)], now);
  assert.ok(burst.z > 3);
});

test('volatility regime compares recent and long-run movement', () => {
  const stormy = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [160 + i, i % 2 ? 0.07 : -0.07]));
  const { stock, now } = series({ shocks: stormy });
  assert.equal(volatilityRegime(stock, now).label, 'elevated');
  assert.equal(volatilityRegime(stock.slice(0, 30), now), null);
});

test('attention index is bounded, monotonic and explainable', () => {
  const zero = attentionIndex({ priceZ: 0, newsZ: 0, volumeRatio: 1, volatilityRatio: 1 });
  assert.equal(zero.score, 0);
  assert.equal(zero.label, 'ordinary');
  const high = attentionIndex({ priceZ: -3, newsZ: 3, volumeRatio: 4, volatilityRatio: 1.6 });
  assert.ok(high.score > 80 && high.score <= 100);
  assert.ok(Math.abs(high.parts.reduce((sum, p) => sum + p.share, 0) - 1) < 0.03);
  assert.equal(attentionIndex({ volumeRatio: 3 }), null); // not enough evidence
  assert.equal(attentionIndex({ priceZ: 1, newsZ: 0 }).coverage, 0.7);
});

test('company signals ignore a stale price series', () => {
  const { stock, bench, now } = series();
  const live = companySignals({ history: stock, benchmarkHistory: bench, eventTimes: [] }, now);
  assert.equal(live.price.model, 'market');
  assert.ok(live.attention);
  const stale = companySignals({ history: stock, benchmarkHistory: bench, eventTimes: [] }, now + 60 * DAY);
  assert.equal(stale.price, null);
  assert.equal(stale.attention, null);
});

test('evidence weights prefer filings, corroborated and recent items', () => {
  assert.ok(sourceWeight('SEC EDGAR') > sourceWeight('Reuters'));
  assert.ok(sourceWeight('Reuters') > sourceWeight('Some Blog'));
  assert.equal(corroborationWeight(undefined), 1);
  assert.ok(corroborationWeight(4) > corroborationWeight(2));
  assert.equal(corroborationWeight(1000), 2);
  const event = { type: 'scandal', source: 'Reuters' };
  assert.ok(Math.abs(evidenceWeight(event, 45 * DAY) / evidenceWeight(event, 0) - 0.5) < 1e-9);
});

test('uncertainty narrows with more agreeing evidence', () => {
  const same = (n) => Array.from({ length: n }, () => ({ weight: 1, sentiment: -0.5 }));
  assert.ok(scoreUncertainty(same(30)).margin < scoreUncertainty(same(2)).margin);
  assert.ok(scoreUncertainty(same(30)).confidence > 0.8);
  const split = Array.from({ length: 30 }, (_, i) => ({ weight: 1, sentiment: i % 2 ? 1 : -1 }));
  assert.ok(scoreUncertainty(split).margin > scoreUncertainty(same(30)).margin);
  assert.equal(scoreUncertainty([]).confidence, 0);
});
