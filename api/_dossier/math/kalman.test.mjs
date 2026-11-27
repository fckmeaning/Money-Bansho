import test from 'node:test';
import assert from 'node:assert/strict';
import { kalmanMarketModel } from './kalman.js';
import { mean, variance, seededRandom, normalSample } from './stats.js';

function simulate({ n = 500, seed = 1, betaAt, alpha = 0.0004, noise = 0.01, market = 0.012 }) {
  const random = seededRandom(seed);
  const stock = [];
  const bench = [];
  const truth = [];
  let previous = null;
  for (let t = 0; t < n; t += 1) {
    const beta = betaAt(t, previous, random);
    previous = beta;
    const m = market * normalSample(random);
    bench.push(m);
    truth.push(beta);
    stock.push(alpha + beta * m + noise * normalSample(random));
  }
  return { stock, bench, truth };
}

function ols(y, m) {
  const my = mean(y);
  const mm = mean(m);
  const slope = m.reduce((s, v, i) => s + (v - mm) * (y[i] - my), 0) / m.reduce((s, v) => s + (v - mm) ** 2, 0);
  const intercept = my - slope * mm;
  const s2 = y.reduce((s, v, i) => s + (v - intercept - slope * m[i]) ** 2, 0) / (y.length - 2);
  return { slope, intercept, s2 };
}

function cholesky(a) {
  const size = a.length;
  const l = a.map(() => new Array(size).fill(0));
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let s = a[i][j];
      for (let k = 0; k < j; k += 1) s -= l[i][k] * l[j][k];
      l[i][j] = i === j ? Math.sqrt(s) : s / l[j][j];
    }
  }
  return l;
}

const forwardSolve = (l, b) => {
  const z = [];
  for (let i = 0; i < b.length; i += 1) {
    let s = b[i];
    for (let k = 0; k < i; k += 1) s -= l[i][k] * z[k];
    z.push(s / l[i][i]);
  }
  return z;
};

/** Direct Gaussian conditioning on the joint law of (beta, y): no recursion shared with the filter. */
function dense(y, m, upto, { alpha, q, r, b0, p0 }) {
  const covBeta = (i, j) => p0 + q * (Math.min(i, j) + 1);
  const matrix = Array.from({ length: upto }, (_, i) => Array.from({ length: upto },
    (_, j) => m[i] * m[j] * covBeta(i, j) + (i === j ? r : 0)));
  const l = cholesky(matrix);
  const z = forwardSolve(l, Array.from({ length: upto }, (_, i) => y[i] - alpha - m[i] * b0));
  const c = forwardSolve(l, Array.from({ length: upto }, (_, i) => m[i] * covBeta(i, upto - 1)));
  const betaMean = b0 + c.reduce((s, v, i) => s + v * z[i], 0);
  const betaVar = covBeta(upto - 1, upto - 1) - c.reduce((s, v) => s + v * v, 0);
  const logLik = -0.5 * (upto * Math.log(2 * Math.PI) + z.reduce((s, v) => s + v * v, 0))
    - l.reduce((s, row, i) => s + Math.log(row[i]), 0);
  return { betaMean, betaVar, logLik };
}

const drifting = (t) => 1 + 0.6 * Math.sin((2 * Math.PI * t) / 400);

test('filter and likelihood match exact Gaussian conditioning', () => {
  const { stock, bench } = simulate({ n: 90, seed: 7, betaAt: drifting });
  const fit = kalmanMarketModel(stock, bench);
  assert.ok(fit);
  const base = ols(stock, bench);
  const params = { alpha: fit.alpha, q: fit.q, r: fit.r, b0: base.slope, p0: base.s2 / variance(bench) };
  for (const upto of [1, 10, 45, 90]) {
    const exact = dense(stock, bench, upto, params);
    assert.ok(Math.abs(exact.betaMean - fit.beta[upto - 1]) < 1e-7, `mean at ${upto}`);
    assert.ok(Math.abs(Math.sqrt(exact.betaVar) - fit.betaStd[upto - 1]) < 1e-7, `std at ${upto}`);
  }
  const burn = 9; // floor(90 / 10)
  const conditional = (alpha) => dense(stock, bench, 90, { ...params, alpha }).logLik
    - dense(stock, bench, burn, { ...params, alpha }).logLik;
  assert.ok(Math.abs(conditional(fit.alpha) - fit.logLik) < 1e-6);
  // alpha is the exact maximiser of that likelihood
  assert.ok(conditional(fit.alpha + 2e-4) < fit.logLik);
  assert.ok(conditional(fit.alpha - 2e-4) < fit.logLik);
});

test('q and r are a maximum of the likelihood', () => {
  const { stock, bench } = simulate({ n: 90, seed: 11, betaAt: drifting, noise: 0.006 });
  const fit = kalmanMarketModel(stock, bench);
  const base = ols(stock, bench);
  const params = { alpha: fit.alpha, q: fit.q, r: fit.r, b0: base.slope, p0: base.s2 / variance(bench) };
  const value = (p) => dense(stock, bench, 90, p).logLik - dense(stock, bench, 9, p).logLik;
  for (const factor of [0.7, 1.4]) {
    assert.ok(value({ ...params, r: fit.r * factor }) <= fit.logLik + 1e-5);
    assert.ok(value({ ...params, q: fit.q * factor }) <= fit.logLik + 1e-5);
  }
});

test('tracks a smoothly drifting beta far better than constant OLS', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { stock, bench, truth } = simulate({ seed, betaAt: drifting, noise: 0.008 });
    const fit = kalmanMarketModel(stock, bench);
    assert.ok(fit, `seed ${seed}`);
    assert.equal(fit.beta.length, 500);
    assert.equal(fit.betaStd.length, 500);
    assert.equal(fit.n, 500);
    assert.equal(fit.latestBeta, fit.beta[499]);
    assert.equal(fit.latestStd, fit.betaStd[499]);
    const flat = ols(stock, bench).slope;
    const rmse = (estimate) => Math.sqrt(mean(truth.slice(50).map((b, i) => (estimate(i + 50) - b) ** 2)));
    assert.ok(rmse((t) => fit.beta[t]) < 0.6 * rmse(() => flat), `seed ${seed}`);
    assert.ok(Math.abs(fit.latestBeta - truth[499]) < 3.5 * fit.latestStd, `seed ${seed}`);
    assert.ok(Math.abs(Math.sqrt(fit.r) / 0.008 - 1) < 0.12, `seed ${seed}`);
  }
});

test('recovers q, r and alpha of a true random walk', () => {
  const q = 0.001;
  const ratios = [];
  for (const seed of [21, 22, 23]) {
    const { stock, bench, truth } = simulate({
      n: 2000, seed, noise: 0.01, alpha: 0.0008,
      betaAt: (t, previous, random) => (t === 0 ? 1 : previous + Math.sqrt(q) * normalSample(random)),
    });
    const fit = kalmanMarketModel(stock, bench);
    assert.ok(fit);
    ratios.push(fit.q / q);
    assert.ok(Math.abs(fit.r / 1e-4 - 1) < 0.1);
    assert.ok(Math.abs(fit.alpha - 0.0008) < 4 * 0.01 / Math.sqrt(2000));
    const covered = truth.slice(100).filter((b, i) => Math.abs(b - fit.beta[i + 100]) < 1.96 * fit.betaStd[i + 100]).length / 1900;
    assert.ok(covered > 0.9 && covered < 0.99, `coverage ${covered}`);
  }
  for (const ratio of ratios) assert.ok(ratio > 0.4 && ratio < 2.5, `q ratio ${ratio}`);
});

test('constant beta gives a nearly constant filtered path', () => {
  const { stock, bench } = simulate({ seed: 5, betaAt: () => 1.3 });
  const fit = kalmanMarketModel(stock, bench);
  assert.ok(fit);
  assert.ok(Math.abs(fit.latestBeta - 1.3) < 3.5 * fit.latestStd);
  assert.ok(fit.latestStd < 0.1);
  const tail = fit.beta.slice(250);
  assert.ok(Math.max(...tail) - Math.min(...tail) < 0.25);
});

test('null on small, malformed or degenerate input', () => {
  const { stock, bench } = simulate({ n: 120, betaAt: () => 1 });
  assert.equal(kalmanMarketModel(stock.slice(0, 59), bench.slice(0, 59)), null);
  assert.ok(kalmanMarketModel(stock.slice(0, 60), bench.slice(0, 60)));
  assert.equal(kalmanMarketModel(stock, bench.slice(1)), null);
  assert.equal(kalmanMarketModel(null, bench), null);
  assert.equal(kalmanMarketModel(stock.map((v, i) => (i === 3 ? NaN : v)), bench), null);
  assert.equal(kalmanMarketModel(stock, bench.map((v, i) => (i === 3 ? undefined : v))), null);
  assert.equal(kalmanMarketModel(stock, bench.map(() => 0.001)), null);
  assert.equal(kalmanMarketModel(stock.map(() => 0), bench), null);
  assert.equal(kalmanMarketModel(bench.map((v) => 0.001 + 2 * v), bench), null);
});

test('deterministic, does not mutate inputs, fast on 500 observations', () => {
  const { stock, bench } = simulate({ seed: 9, betaAt: drifting });
  const copy = [...stock];
  const first = kalmanMarketModel(stock, bench);
  assert.deepEqual(kalmanMarketModel(stock, bench), first);
  assert.deepEqual(stock, copy);
  const times = [];
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    kalmanMarketModel(stock, bench);
    times.push(performance.now() - start);
  }
  const typical = times.sort((a, b) => a - b)[2];
  console.log(`kalman median ms: ${typical.toFixed(2)}`);
  assert.ok(typical < 50);
});
