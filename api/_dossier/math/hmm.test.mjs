import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRegimes } from './hmm.js';
import { mean, seededRandom, normalSample } from './stats.js';
import { normalLogPdf } from './special.js';

const TRUTH = { sigma: [0.008, 0.025], mu: [0.0006, -0.001], stay: [0.97, 0.93] };

function simulate(n, seed, { sigma, mu, stay } = TRUTH) {
  const random = seededRandom(seed);
  const x = [];
  const hidden = [];
  let state = 0;
  for (let t = 0; t < n; t += 1) {
    if (t && random() > stay[state]) state = 1 - state;
    hidden.push(state);
    x.push(mu[state] + sigma[state] * normalSample(random));
  }
  return { x, hidden };
}

const gaussian = (n, seed, sd = 0.015) => {
  const random = seededRandom(seed);
  return Array.from({ length: n }, () => sd * normalSample(random));
};

/** Plain forward filter written independently from the model's output. */
function referenceFilter(x, fit) {
  let p = [0.5, 0.5];
  let logLik = 0;
  const series = x.map((v, t) => {
    const prior = t === 0 ? p : [0, 1].map((j) => p[0] * fit.transition[0][j] + p[1] * fit.transition[1][j]);
    const joint = prior.map((w, j) => w * Math.exp(normalLogPdf(v, fit.states[j].mean, fit.states[j].sigma)));
    const total = joint[0] + joint[1];
    logLik += Math.log(total);
    p = joint.map((w) => w / total);
    return p[1];
  });
  return { series, logLik };
}

test('recovers a two-regime series', () => {
  for (const seed of [1, 2, 3, 4]) {
    const { x, hidden } = simulate(2000, seed);
    const fit = fitRegimes(x);
    assert.ok(fit, `seed ${seed}`);
    assert.equal(fit.n, 2000);
    assert.equal(fit.series.length, 2000);
    assert.ok(fit.states[0].sigma < fit.states[1].sigma);
    assert.ok(Math.abs(fit.states[0].sigma / TRUTH.sigma[0] - 1) < 0.1, `calm sigma ${fit.states[0].sigma}`);
    assert.ok(Math.abs(fit.states[1].sigma / TRUTH.sigma[1] - 1) < 0.15, `wild sigma ${fit.states[1].sigma}`);
    assert.ok(Math.abs(fit.transition[0][0] - 0.97) < 0.025, `p00 ${fit.transition[0][0]}`);
    assert.ok(Math.abs(fit.transition[1][1] - 0.93) < 0.06, `p11 ${fit.transition[1][1]}`);
    for (const i of [0, 1]) {
      assert.ok(Math.abs(fit.transition[i][0] + fit.transition[i][1] - 1) < 1e-12);
      assert.ok(Math.abs(fit.expectedDurationDays[i] - 1 / (1 - fit.transition[i][i])) < 1e-9);
    }
    const accuracy = mean(hidden.map((s, t) => ((fit.series[t] > 0.5 ? 1 : 0) === s ? 1 : 0)));
    assert.ok(accuracy > 0.87, `accuracy ${accuracy}`);
    assert.ok(fit.series.every((p) => p >= 0 && p <= 1));
    assert.equal(fit.probabilityTurbulent, fit.series[1999]);
    assert.ok(fit.iterations > 0);
  }
});

test('series is the filtered probability and logLik matches', () => {
  const { x } = simulate(500, 8);
  const fit = fitRegimes(x);
  assert.ok(fit);
  const reference = referenceFilter(x, fit);
  assert.ok(Math.abs(reference.logLik - fit.logLik) < 1e-7);
  reference.series.forEach((p, t) => assert.ok(Math.abs(p - fit.series[t]) < 1e-9, `t=${t}`));
});

test('estimate is a local maximum of the likelihood', () => {
  const { x } = simulate(800, 12);
  const fit = fitRegimes(x);
  assert.ok(fit);
  const changes = [];
  for (const factor of [0.96, 1.04]) {
    for (const i of [0, 1]) {
      changes.push((f) => { f.states[i].sigma *= factor; });
      changes.push((f) => {
        const leave = (1 - f.transition[i][i]) * factor ** 3;
        f.transition[i][i] = 1 - leave;
        f.transition[i][1 - i] = leave;
      });
    }
  }
  for (const i of [0, 1]) for (const shift of [-0.0005, 0.0005]) changes.push((f) => { f.states[i].mean += shift; });
  for (const change of changes) {
    const other = structuredClone(fit);
    change(other);
    assert.ok(referenceFilter(x, other).logLik <= fit.logLik + 1e-4);
  }
});

test('works on 500 observations and flags a turbulent ending', () => {
  const x = [...gaussian(400, 31, 0.008), ...gaussian(100, 32, 0.028)];
  const fit = fitRegimes(x);
  assert.ok(fit);
  assert.ok(fit.probabilityTurbulent > 0.9);
  assert.ok(mean(fit.series.slice(100, 400)) < 0.1);
});

test('null on a single-regime Gaussian series', () => {
  let found = 0;
  for (let seed = 100; seed < 130; seed += 1) if (fitRegimes(gaussian(500, seed))) found += 1;
  assert.equal(found, 0);
});

test('independent heavy-tailed noise is rarely mistaken for regimes', () => {
  let found = 0;
  for (let seed = 400; seed < 440; seed += 1) {
    const random = seededRandom(seed);
    const x = Array.from({ length: 500 }, () => {
      const z = normalSample(random);
      let chi = 0;
      for (let k = 0; k < 5; k += 1) chi += normalSample(random) ** 2;
      return 0.01 * z / Math.sqrt(chi / 5);
    });
    const fit = fitRegimes(x);
    if (fit) {
      found += 1;
      assert.ok(Math.min(fit.expectedDurationDays[0], fit.expectedDurationDays[1]) >= 3 - 1e-9);
    }
  }
  assert.ok(found <= 10, `false regimes ${found}/40`);
});

test('null when volatilities are not meaningfully distinct', () => {
  const { x } = simulate(1500, 3, { sigma: [0.01, 0.0108], mu: [0, 0], stay: [0.97, 0.93] });
  assert.equal(fitRegimes(x), null);
});

test('null on small, malformed or degenerate input', () => {
  const { x } = simulate(300, 2);
  assert.equal(fitRegimes(x.slice(0, 99)), null);
  assert.equal(fitRegimes(null), null);
  assert.equal(fitRegimes(x.map((v, i) => (i === 5 ? Infinity : v))), null);
  assert.equal(fitRegimes(new Array(300).fill(0)), null);
  assert.equal(fitRegimes(new Array(300).fill(0.01)), null);
  // one wild outlier is not a regime
  const outlier = gaussian(300, 55, 0.01);
  outlier[150] = 0.6;
  assert.equal(fitRegimes(outlier), null);
});

test('stale prices (many exact zeros) do not produce a collapsed state', () => {
  const x = gaussian(400, 77, 0.02).map((v, i) => (i % 2 ? 0 : v));
  const fit = fitRegimes(x);
  if (fit) assert.ok(fit.states[0].sigma > 0.0004);
});

test('deterministic, does not mutate inputs, fast on 500 observations', () => {
  const { x } = simulate(500, 6);
  const copy = [...x];
  assert.deepEqual(fitRegimes(x), fitRegimes(x));
  assert.deepEqual(x, copy);
  for (const [label, series] of [['two-regime', x], ['gaussian', gaussian(500, 101)]]) {
    const times = [];
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      fitRegimes(series);
      times.push(performance.now() - start);
    }
    const typical = times.sort((a, b) => a - b)[2];
    console.log(`hmm median ms (${label}): ${typical.toFixed(2)}`);
    assert.ok(typical < 50);
  }
});
