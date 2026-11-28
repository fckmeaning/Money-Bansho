import test from 'node:test';
import assert from 'node:assert/strict';
import { companyOutlook } from './outlook-board.js';
import { screenerFrom } from './market.js';
import { addSessions, byHorizon, distribution, MODELS, prepareSeries, rangeVariance, stateAt, tQuantile } from './volmodel.js';
import { normalSample, seededRandom } from './stats.js';
import { studentTCdf } from './special.js';

const DAY = 86_400_000;
const START = Date.UTC(2023, 0, 2, 14, 30);

function bars(n, seed = 1, sigma = 0.012, ranges = true) {
  const random = seededRandom(seed);
  const out = [];
  let c = 100;
  let t = START;
  for (let i = 0; i < n; i += 1) {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += DAY;
    const o = c;
    c *= Math.exp(sigma * normalSample(random));
    out.push(ranges
      ? { t, c, o, h: Math.max(o, c) * 1.004, l: Math.min(o, c) * 0.996, v: 1 }
      : { t, c, v: 1 });
    t += DAY;
  }
  return out;
}
const NOW = (history) => history[history.length - 1].t + DAY;

test('range variance adds the overnight gap and the intraday estimate, and refuses broken bars', () => {
  assert.equal(rangeVariance({ o: 100, h: 100, l: 100, c: 100 }, 100), 0);
  assert.ok(Math.abs(rangeVariance({ o: 101, h: 101, l: 101, c: 101 }, 100) - Math.log(1.01) ** 2) < 1e-15);
  assert.ok(rangeVariance({ o: 100, h: 103, l: 97, c: 100 }, 100) > 0);
  assert.equal(rangeVariance({ o: 100, h: 97, l: 103, c: 100 }, 100), null);
  assert.equal(rangeVariance({ o: null, h: 1, l: 1, c: 1 }, 1), null);
});

test('sessions skip weekends and horizons interpolate between the fitted ones', () => {
  const friday = Math.floor(Date.UTC(2026, 10, 27) / DAY);
  assert.equal(addSessions(friday, 1), friday + 3);
  assert.equal(addSessions(friday, 5), friday + 7);
  assert.equal(byHorizon([1, 2, 3], 1), 1);
  assert.equal(byHorizon([1, 2, 3], 5), 2);
  assert.equal(byHorizon([1, 2, 3], 40), 3);
  const mid = byHorizon([[1, 10], [2, 20], [3, 30]], 10);
  assert.ok(Math.abs(mid[0] - 2.5) < 1e-12 && Math.abs(mid[1] - 25) < 1e-12);
});

test('every model has a weight per feature for every horizon', () => {
  for (const model of Object.values(MODELS)) {
    assert.equal(model.weights.length, 3);
    for (const row of model.weights) assert.ok(row.length === model.features.length && row.every((w) => w >= 0));
    for (const [scale, nu] of model.t) assert.ok(scale > 0 && nu > 2);
  }
});

test('no look-ahead: the state at t is the same whether or not later bars exist', () => {
  const history = bars(560, 4);
  const market = bars(560, 8);
  const now = NOW(history);
  const whole = stateAt(prepareSeries(history, market, now), 400);
  const cut = stateAt(prepareSeries(history.slice(0, 401), market.slice(0, 401), now), 400);
  assert.equal(whole.kind, 'range');
  for (const h of [1, 5, 20]) assert.deepEqual(whole.forecast(h), cut.forecast(h));
});

test('the distribution is a proper symmetric Student t, widened by the event factor', () => {
  const d = distribution({ sd: 0.02, scale: 0.8, nu: 5 });
  assert.equal(d.quantile(0.5), 0);
  assert.ok(Math.abs(d.cdf(d.quantile(0.9)) - 0.9) < 1e-9);
  assert.ok(Math.abs(d.quantile(0.1) + d.quantile(0.9)) < 1e-9);
  assert.ok(Math.abs(studentTCdf(tQuantile(0.975, 5), 5) - 0.975) < 1e-9);
  assert.ok(Math.abs(distribution({ sd: 0.02, scale: 0.8, nu: 5 }, 2).quantile(0.9) - 2 * d.quantile(0.9)) < 1e-12);
});

test('on a stationary series the stated 80 % corridor holds about that often', () => {
  const history = bars(900, 17, 0.012, false);
  const series = prepareSeries(history, [], NOW(history));
  let inside = 0;
  let n = 0;
  for (let t = 300; t < 899; t += 1) {
    const d = distribution(stateAt(series, t).forecast(1));
    const y = Math.log(series.rows[t + 1].c / series.rows[t].c);
    inside += Number(y >= d.quantile(0.1) && y <= d.quantile(0.9));
    n += 1;
  }
  assert.ok(inside / n > 0.72 && inside / n < 0.9, `coverage ${inside / n}`);
});

test('the overview forecast needs a year of closes and reports the change in expectation', () => {
  const calm = bars(250, 3, 0.01, false);
  const out = companyOutlook(calm, bars(250, 4, 0.01, false), NOW(calm));
  assert.deepEqual(out.horizons.map((h) => h.h), [1, 5, 20]);
  assert.ok(out.horizons[0].widthPct < out.horizons[1].widthPct && out.horizons[1].widthPct < out.horizons[2].widthPct);
  assert.ok(out.vsUsual > 0.6 && out.vsUsual < 1.5);
  const jolt = calm.map((b, i) => (i >= 246 ? { ...b, c: b.c * (i % 2 ? 1.09 : 0.93) } : b));
  const after = companyOutlook(jolt, [], NOW(jolt));
  assert.ok(after.change5Pct > 20 && after.vsUsual > out.vsUsual);
  assert.equal(companyOutlook(calm.slice(0, 150), [], NOW(calm)), null);
  assert.equal(companyOutlook([], [], NOW(calm)), null);
});

test('screener rows carry the outlook, or null without history', () => {
  const history = bars(250, 3, 0.01, false);
  const series = new Map([['A', { meta: {}, history }], ['B', { meta: {}, history: history.slice(-90) }], ['^I', { meta: {}, history }]]);
  const list = ['A', 'B'].map((symbol) => ({ symbol, name: symbol, region: 'us', benchmark: '^I' }));
  const { rows } = screenerFrom(list, series, NOW(history));
  assert.equal(rows[0].outlook.horizons.length, 3);
  assert.equal(rows[1].outlook, null);
});
