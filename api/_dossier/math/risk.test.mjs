import assert from 'node:assert/strict';
import test from 'node:test';

import { detectJumps, maxDrawdown, valueAtRisk } from './risk.js';
import { normalSample, seededRandom } from './stats.js';

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (+-${tolerance})`);
const loss = (logReturn) => 1 - Math.exp(logReturn);

const gaussian = (n, seed, sd = 0.01) => {
  const random = seededRandom(seed);
  return Array.from({ length: n }, () => sd * normalSample(random));
};

// -0.050, -0.049, ..., 0.050 in a scrambled order (37 is coprime with 101).
const grid = Array.from({ length: 101 }, (_, i) => (((i * 37) % 101) - 50) / 1000);

test('historical VaR and expected shortfall by hand', () => {
  // The 1% quantile of 101 points sits exactly on the second smallest, -0.049.
  const result = valueAtRisk(grid);
  assert.equal(result.level, 0.99);
  near(result.historical, loss(-0.049), 1e-12);
  near(result.expectedShortfall, (loss(-0.05) + loss(-0.049)) / 2, 1e-12);
  // 5%: position 5 -> -0.045, six observations in the tail.
  const wide = valueAtRisk(grid, { level: 0.95 });
  near(wide.historical, loss(-0.045), 1e-12);
  near(wide.expectedShortfall, [50, 49, 48, 47, 46, 45].reduce((s, k) => s + loss(-k / 1000), 0) / 6, 1e-12);
});

test('tiny tail: expected shortfall falls back to the worst loss', () => {
  const returns = gaussian(60, 3);
  const result = valueAtRisk(returns);
  near(result.expectedShortfall, loss(Math.min(...returns)), 1e-15);
  assert.ok(result.expectedShortfall >= result.historical);
});

test('parametric t VaR uses the supplied sigma and nu', () => {
  // t(10) 0.975 quantile = 2.2281388519649385, unit variance factor sqrt(8/10); mean of grid is 0.
  const result = valueAtRisk(grid, { level: 0.975, sigma: 0.02, nu: 10 });
  near(result.parametricT, loss(-0.02 * 2.2281388519649385 * Math.sqrt(0.8)), 1e-9);
});

test('parametric t VaR from sample estimates', () => {
  // Gaussian data: nu goes high and the quantile approaches 2.326 sigma.
  const normal = valueAtRisk(gaussian(20000, 11));
  near(normal.parametricT / loss(-0.01 * 2.3263478740408408), 1, 0.04);
  // t(5) data scaled to sd 0.01: the 1% quantile is 3.36493 * sqrt(3/5) sigma.
  const random = seededRandom(12);
  const heavy = Array.from({ length: 20000 }, () => {
    const z = normalSample(random);
    let chi = 0;
    for (let k = 0; k < 5; k += 1) chi += normalSample(random) ** 2;
    return 0.01 * (z / Math.sqrt(chi / 5)) * Math.sqrt(3 / 5);
  });
  near(valueAtRisk(heavy).parametricT / loss(-0.01 * 3.36493 * Math.sqrt(0.6)), 1, 0.06);
  // Unusable sigma / nu are ignored rather than propagated.
  assert.deepEqual(valueAtRisk(grid, { sigma: null, nu: null }), valueAtRisk(grid));
  assert.deepEqual(valueAtRisk(grid, { sigma: -1, nu: 2 }), valueAtRisk(grid));
});

test('Cornish-Fisher by hand on a symmetric fat-tailed sample', () => {
  // 90 values of +-0.01 and 10 of +-0.04: m2 = 2.5e-4, m4 = 26.5e-8, excess kurtosis 1.24, skew 0.
  const returns = [
    ...Array.from({ length: 90 }, (_, i) => (i % 2 ? -0.01 : 0.01)),
    ...Array.from({ length: 10 }, (_, i) => (i % 2 ? -0.04 : 0.04)),
  ];
  const z = -2.3263478740408408;
  const adjusted = z + ((z ** 3 - 3 * z) * 1.24) / 24;
  const sd = Math.sqrt(2.5e-4 * (100 / 99));
  near(valueAtRisk(returns).cornishFisher, loss(sd * adjusted), 1e-9);
});

test('Cornish-Fisher is null when the expansion is not monotone', () => {
  // One enormous loss: extreme skew and kurtosis.
  const skewed = [...gaussian(99, 5), -0.5];
  const result = valueAtRisk(skewed);
  assert.equal(result.cornishFisher, null);
  assert.ok(result.historical > 0 && result.parametricT > 0);
  // A uniform sample has negative excess kurtosis and zero skew: the cubic turns back.
  assert.equal(valueAtRisk(grid).cornishFisher, null);
});

test('VaR grows with the level and never reports a gain as a loss', () => {
  const returns = gaussian(500, 21);
  const low = valueAtRisk(returns, { level: 0.95 });
  const high = valueAtRisk(returns, { level: 0.99 });
  for (const key of ['historical', 'parametricT', 'expectedShortfall']) assert.ok(high[key] > low[key] && low[key] > 0);
  assert.ok(high.expectedShortfall >= high.historical);
  const drifting = valueAtRisk(gaussian(100, 2, 0.001).map((x) => x + 0.05));
  assert.equal(drifting.historical, 0);
  assert.equal(drifting.parametricT, 0);
  assert.equal(drifting.expectedShortfall, 0);
});

test('VaR null cases', () => {
  assert.equal(valueAtRisk(gaussian(59, 1)), null);
  assert.equal(valueAtRisk([...gaussian(59, 1), NaN, Infinity]), null);
  assert.equal(valueAtRisk(new Array(100).fill(0.01)), null);
  assert.equal(valueAtRisk(gaussian(100, 1), { level: 1 }), null);
  assert.equal(valueAtRisk(gaussian(100, 1), { level: 0.01 }), null);
  assert.equal(valueAtRisk(null), null);
});

test('max drawdown by hand', () => {
  assert.deepEqual(maxDrawdown([100, 120, 90, 110, 60, 130]), { depth: 0.5, peakIndex: 1, troughIndex: 4, recovered: true });
  const open = maxDrawdown([100, 80, 90]);
  near(open.depth, 0.2, 1e-12);
  assert.equal(open.recovered, false);
  // The deepest fall is the unrecovered one, although an earlier fall recovered.
  assert.deepEqual(maxDrawdown([100, 90, 100, 200, 100, 150]), { depth: 0.5, peakIndex: 3, troughIndex: 4, recovered: false });
  assert.deepEqual(maxDrawdown([100, 50, 100]), { depth: 0.5, peakIndex: 0, troughIndex: 1, recovered: true });
  assert.deepEqual(maxDrawdown([1, 2, 3]), { depth: 0, peakIndex: 0, troughIndex: 0, recovered: true });
});

test('max drawdown skips bad prices and keeps input indices', () => {
  assert.deepEqual(maxDrawdown([null, 100, NaN, 0, 75, -3, 80]), { depth: 0.25, peakIndex: 1, troughIndex: 4, recovered: false });
  assert.equal(maxDrawdown([100]), null);
  assert.equal(maxDrawdown([NaN, 0, 100]), null);
  assert.equal(maxDrawdown([]), null);
  assert.equal(maxDrawdown(undefined), null);
});

test('jump threshold matches the Gumbel limit computed by hand', () => {
  // 100 tested returns, level 0.99: C_n = 2.594650, S_n = 0.329505, beta* = 4.600149,
  // threshold = C_n + S_n * beta* = 4.110421. Neighbours of size 0.01 give sigma = 0.01 sqrt(pi/2).
  const series = (statistic) => [
    ...Array.from({ length: 119 }, (_, i) => (i % 2 ? -0.01 : 0.01)),
    -statistic * 0.01 * Math.sqrt(Math.PI / 2),
  ];
  assert.deepEqual(detectJumps(series(4.11)), []);
  const found = detectJumps(series(4.111));
  assert.equal(found.length, 1);
  assert.equal(found[0].index, 119);
  near(found[0].statistic, 4.111, 1e-9);
  assert.ok(found[0].return < 0);
});

test('injected jumps are found at their positions', () => {
  const returns = gaussian(500, 31);
  returns[200] = -0.09;
  returns[400] = 0.1;
  const found = detectJumps(returns);
  for (const index of [200, 400]) {
    const jump = found.find((j) => j.index === index);
    assert.ok(jump, `jump at ${index} missed`);
    assert.equal(jump.return, returns[index]);
    assert.ok(jump.statistic > 5);
  }
  assert.ok(found.length <= 3, `${found.length} detections`);
});

test('pure Gaussian noise does not flood the detector', () => {
  // The Gumbel limit ignores the noise in a 20-day sigma, so the rate exceeds the nominal
  // 1% per series; it must still stay a small fraction of one detection per series.
  let total = 0;
  let worst = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    const count = detectJumps(gaussian(500, 700 + seed)).length;
    total += count;
    worst = Math.max(worst, count);
  }
  assert.ok(total / 300 < 0.4, `mean ${total / 300}`);
  assert.ok(worst <= 4, `worst ${worst}`);
  let longWindow = 0;
  for (let seed = 1; seed <= 300; seed += 1) longWindow += detectJumps(gaussian(500, 700 + seed), { window: 60 }).length;
  assert.ok(longWindow / 300 < 0.1, `mean ${longWindow / 300}`);
});

test('jump detection: small, degenerate and dirty inputs', () => {
  const returns = gaussian(100, 41);
  returns[60] = 0.2;
  assert.deepEqual(detectJumps(returns.slice(0, 39)), []);
  assert.deepEqual(detectJumps([]), []);
  assert.deepEqual(detectJumps(null), []);
  assert.deepEqual(detectJumps(returns, { window: 2 }), []);
  assert.deepEqual(detectJumps(returns, { level: 1 }), []);
  assert.deepEqual(detectJumps(new Array(100).fill(0)), []);
  // A move after a stale (all zero) window has no local scale, so it is not tested.
  const stale = new Array(100).fill(0);
  stale[60] = 0.01;
  assert.deepEqual(detectJumps(stale), []);
  // Indices refer to the input array even when non-finite values are dropped.
  const dirty = [NaN, ...returns.slice(0, 30), null, ...returns.slice(30)];
  assert.ok(detectJumps(dirty).some((j) => j.index === 62));
});

test('risk: deterministic and fast on 500 observations', () => {
  const returns = gaussian(500, 51);
  assert.deepEqual(valueAtRisk(returns), valueAtRisk(returns));
  const times = Array.from({ length: 7 }, () => {
    const start = performance.now();
    valueAtRisk(returns);
    maxDrawdown(returns.map((x) => 100 * Math.exp(x)));
    detectJumps(returns);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  assert.ok(times[3] < 20, `median ${times[3]} ms`);
});
