import test from 'node:test';
import assert from 'node:assert/strict';
import { detectChangepoints } from './changepoint.js';
import { median, seededRandom, normalSample } from './stats.js';
import { logGamma } from './special.js';

const gaussian = (n, seed, sd = 0.01, mu = 0) => {
  const random = seededRandom(seed);
  return Array.from({ length: n }, () => mu + sd * normalSample(random));
};
const seeds = Array.from({ length: 20 }, (_, i) => 200 + i);

/**
 * Independent exact computation: sum over segmentations using the closed-form
 * Normal-Inverse-Gamma marginal likelihood of a segment (no sequential predictive, no truncation).
 */
function exact(x, hazard, recent) {
  const n = x.length;
  const window = x.slice(0, Math.min(50, n - recent - 1));
  const centre = median(window);
  const scale = 1.4826 * median(window.map((v) => Math.abs(v - centre)));
  const kappa0 = 0.1;
  const alpha0 = 2;
  const beta0 = scale * scale;
  const logMarginal = (from, to) => {
    const segment = x.slice(from, to);
    const k = segment.length;
    const average = segment.reduce((s, v) => s + v, 0) / k;
    const squares = segment.reduce((s, v) => s + (v - average) ** 2, 0);
    const kappa = kappa0 + k;
    const alpha = alpha0 + k / 2;
    const beta = beta0 + squares / 2 + (kappa0 * k * average ** 2) / (2 * kappa);
    return logGamma(alpha) - logGamma(alpha0) + alpha0 * Math.log(beta0) - alpha * Math.log(beta)
      + 0.5 * Math.log(kappa0 / kappa) - (k / 2) * Math.log(2 * Math.PI);
  };
  const logSum = (terms) => {
    const top = Math.max(...terms);
    return top + Math.log(terms.reduce((s, v) => s + Math.exp(v - top), 0));
  };
  const boundary = [0]; // boundary[s]: log P(x[0..s-1], a segment starts at s)
  const series = [];
  const maps = [];
  for (let end = 1; end <= n; end += 1) {
    // terms[s]: last segment is [s, end) and no change follows observation end - 1
    const terms = [];
    for (let s = 0; s < end; s += 1) terms.push(boundary[s] + (end - s) * Math.log1p(-hazard) + logMarginal(s, end));
    // posterior over the last segment start, plus the empty segment (mass = hazard)
    const total = logSum(terms);
    let recentMass = hazard;
    let best = { length: 0, p: hazard };
    terms.forEach((v, s) => {
      const p = (1 - hazard) * Math.exp(v - total);
      if (s > 0 && end - s <= recent) recentMass += p;
      if (p > best.p) best = { length: end - s, p };
    });
    series.push(recentMass);
    maps.push(best.length);
    // a change does follow observation end - 1
    boundary.push(total - Math.log1p(-hazard) + Math.log(hazard));
  }
  return { series, maps };
}

test('matches an exact sum over segmentations', () => {
  const x = [...gaussian(45, 3, 0.01), ...gaussian(35, 4, 0.035)];
  for (const [hazard, recent] of [[1 / 60, 5], [0.1, 3]]) {
    const fit = detectChangepoints(x, { hazard, recent });
    const reference = exact(x, hazard, recent);
    reference.series.forEach((p, t) => assert.ok(Math.abs(p - fit.changeSeries[t]) < 1e-6, `t=${t}: ${p} vs ${fit.changeSeries[t]}`));
    assert.equal(fit.runLengthDays, reference.maps[x.length - 1]);
  }
});

test('finds a variance break at a known index', () => {
  let located = 0;
  let signalled = 0;
  for (const seed of seeds) {
    const x = [...gaussian(250, seed, 0.01), ...gaussian(250, seed + 1000, 0.035)];
    const fit = detectChangepoints(x);
    if (fit.breaks.some((b) => Math.abs(b - 250) <= 8)) located += 1;
    // a volatility rise is sometimes recognised only after the short window has passed
    if (Math.max(...fit.changeSeries.slice(250, 262)) > 0.5) signalled += 1;
    const wide = detectChangepoints(x, { recent: 20 });
    assert.ok(Math.max(...wide.changeSeries.slice(250, 277)) > 0.5, `seed ${seed}`);
    assert.ok(fit.breaks.length <= 3, `seed ${seed}: ${fit.breaks}`);
  }
  assert.ok(located >= 19, `located ${located}/20`);
  assert.ok(signalled >= 17, `signalled ${signalled}/20`);
});

test('finds a mean break and reports it as recent just after it happens', () => {
  let strong = 0;
  for (const seed of seeds) {
    const x = [...gaussian(200, seed, 0.01), ...gaussian(4, seed + 2000, 0.01, -0.06)];
    const fit = detectChangepoints(x);
    // the last pre-break returns can look like part of the new segment, so not every run is > 0.8
    assert.ok(fit.recentProbability > 0.5, `seed ${seed}: ${fit.recentProbability}`);
    if (fit.recentProbability > 0.8) strong += 1;
    assert.ok(fit.runLengthDays <= 8, `seed ${seed}: ${fit.runLengthDays}`);
    const longer = detectChangepoints([...gaussian(200, seed, 0.01), ...gaussian(60, seed + 2000, 0.01, -0.06)]);
    assert.ok(longer.breaks.some((b) => Math.abs(b - 200) <= 2), `seed ${seed}: ${longer.breaks}`);
    assert.ok(Math.abs(longer.runLengthDays - 60) <= 2, `seed ${seed}: ${longer.runLengthDays}`);
    assert.ok(longer.recentProbability < 0.3);
  }
  assert.ok(strong >= 18, `strong ${strong}/20`);
});

test('no flood of breaks on stationary data', () => {
  let total = 0;
  let alarms = 0;
  for (const seed of seeds) {
    const fit = detectChangepoints(gaussian(500, seed));
    total += fit.breaks.length;
    alarms += fit.changeSeries.filter((p) => p > 0.5).length;
    assert.ok(fit.breaks.length <= 2, `seed ${seed}: ${fit.breaks}`);
  }
  assert.ok(total <= 6, `total breaks ${total}`);
  assert.ok(alarms / (500 * seeds.length) < 0.02, `alarm share ${alarms / 10000}`);
});

test('heavy tails (Student t, 5 df) do not flood either', () => {
  let total = 0;
  for (const seed of seeds) {
    const random = seededRandom(seed);
    const x = Array.from({ length: 500 }, () => {
      const z = normalSample(random);
      let chi = 0;
      for (let k = 0; k < 5; k += 1) chi += normalSample(random) ** 2;
      return 0.01 * z / Math.sqrt(chi / 5);
    });
    total += detectChangepoints(x).breaks.length;
  }
  assert.ok(total / seeds.length <= 2, `mean breaks ${total / seeds.length}`);
});

test('output shape and invariants', () => {
  const x = [...gaussian(150, 1, 0.01), ...gaussian(150, 2, 0.03)];
  const fit = detectChangepoints(x);
  assert.equal(fit.n, 300);
  assert.equal(fit.changeSeries.length, 300);
  assert.equal(fit.recentProbability, fit.changeSeries[299]);
  assert.ok(fit.changeSeries.every((p) => p >= 0 && p <= 1));
  assert.ok(Number.isInteger(fit.runLengthDays) && fit.runLengthDays >= 0 && fit.runLengthDays <= 300);
  fit.breaks.forEach((b, i) => {
    assert.ok(Number.isInteger(b) && b > 0 && b < 300);
    if (i) assert.ok(b > fit.breaks[i - 1]);
  });
});

test('no look-ahead: later data do not rewrite the signal', () => {
  const x = [...gaussian(150, 5, 0.01), ...gaussian(150, 6, 0.03)];
  const whole = detectChangepoints(x);
  const prefix = detectChangepoints(x.slice(0, 180));
  assert.deepEqual(prefix.changeSeries, whole.changeSeries.slice(0, 180));
});

test('null on small, malformed or degenerate input', () => {
  const x = gaussian(100, 9);
  assert.equal(detectChangepoints(x.slice(0, 59)), null);
  assert.ok(detectChangepoints(x.slice(0, 60)));
  assert.equal(detectChangepoints(null), null);
  assert.equal(detectChangepoints(x.map((v, i) => (i === 2 ? NaN : v))), null);
  assert.equal(detectChangepoints(new Array(100).fill(0)), null);
  assert.equal(detectChangepoints(x, { hazard: 0 }), null);
  assert.equal(detectChangepoints(x, { hazard: 1 }), null);
  assert.equal(detectChangepoints(x, { recent: 2.5 }), null);
  assert.equal(detectChangepoints(x, { recent: 90 }), null);
});

test('survives an extreme outlier', () => {
  const x = gaussian(200, 15);
  x[100] = 3;
  const fit = detectChangepoints(x);
  assert.ok(fit);
  assert.ok(fit.changeSeries.every(Number.isFinite));
});

test('deterministic, does not mutate inputs, fast on 500 observations', () => {
  const x = gaussian(500, 42);
  const copy = [...x];
  assert.deepEqual(detectChangepoints(x), detectChangepoints(x));
  assert.deepEqual(x, copy);
  const times = [];
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    detectChangepoints(x);
    times.push(performance.now() - start);
  }
  const typical = times.sort((a, b) => a - b)[2];
  console.log(`changepoint median ms: ${typical.toFixed(2)}`);
  assert.ok(typical < 50);
});
