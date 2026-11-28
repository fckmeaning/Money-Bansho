import assert from 'node:assert/strict';
import test from 'node:test';

import { studentTLogPdf } from './special.js';
import { mean, normalSample, seededRandom } from './stats.js';
import { ewmaVolatility, fitGarch, garchForecast } from './volatility.js';

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (+-${tolerance})`);

const TRUE = { omega: 4e-6, alpha: 0.08, beta: 0.9, nu: 7 };

// GARCH(1,1) with unit-variance Student-t shocks (integer nu), after a burn-in.
function simulateGarchT(n, seed, { omega, alpha, beta, nu } = TRUE) {
  const random = seededRandom(seed);
  let h = omega / (1 - alpha - beta);
  const out = [];
  for (let t = -500; t < n; t += 1) {
    const z = normalSample(random);
    let chi = 0;
    for (let k = 0; k < nu; k += 1) chi += normalSample(random) ** 2;
    const e = Math.sqrt(h) * (z / Math.sqrt(chi / nu)) * Math.sqrt((nu - 2) / nu);
    if (t >= 0) out.push(e);
    h = omega + alpha * e * e + beta * h;
  }
  return out;
}

const gaussian = (n, seed, sd = 0.01) => {
  const random = seededRandom(seed);
  return Array.from({ length: n }, () => sd * normalSample(random));
};

// Independent likelihood (public density, original units), variance targeting included.
function referenceLogLik(returns, alpha, beta, nu) {
  const m = mean(returns);
  const e = returns.map((x) => x - m);
  const target = e.reduce((total, x) => total + x * x, 0) / e.length;
  let h = target;
  let total = 0;
  for (const x of e) {
    total += studentTLogPdf(x, nu, 0, Math.sqrt((h * (nu - 2)) / nu));
    h = target * (1 - alpha - beta) + alpha * x * x + beta * h;
  }
  return total;
}

const alternating = (n, size = 0.01) => Array.from({ length: n }, (_, i) => (i % 2 ? -size : size));

test('ewma: constant absolute returns give that sigma', () => {
  const result = ewmaVolatility(alternating(40));
  near(result.sigma, 0.01, 1e-15);
  assert.equal(result.series.length, 40);
  for (const s of result.series) near(s, 0.01, 1e-15);
});

test('ewma: one-step recursion by hand', () => {
  const result = ewmaVolatility([...alternating(20), 0.05]);
  near(result.series[20], 0.01, 1e-15); // conditional: the shock is not in its own sigma
  near(result.sigma ** 2, 0.94 * 1e-4 + 0.06 * 0.0025, 1e-15);
  near(ewmaVolatility([...alternating(20), 0.05], 0.8).sigma ** 2, 0.8 * 1e-4 + 0.2 * 0.0025, 1e-15);
});

test('ewma: null cases and filtering', () => {
  assert.equal(ewmaVolatility(alternating(19)), null);
  assert.equal(ewmaVolatility(new Array(50).fill(0)), null);
  assert.equal(ewmaVolatility(alternating(50), 1), null);
  assert.equal(ewmaVolatility(alternating(50), 0), null);
  assert.equal(ewmaVolatility(null), null);
  assert.equal(ewmaVolatility([...alternating(19), NaN, Infinity, null]), null);
  assert.equal(ewmaVolatility([NaN, ...alternating(20), undefined]).series.length, 20);
});

test('garch-t: recovers the parameters of simulated series', () => {
  for (const seed of [1, 2, 3]) {
    const returns = simulateGarchT(3000, seed);
    const fit = fitGarch(returns);
    assert.ok(fit.converged);
    assert.equal(fit.n, 3000);
    near(fit.alpha, TRUE.alpha, 0.035);
    near(fit.beta, TRUE.beta, 0.045);
    near(fit.persistence, 0.98, 0.025);
    assert.ok(fit.nu > 5 && fit.nu < 12, `nu ${fit.nu}`);
    near(fit.longRunSigma / Math.sqrt(2e-4), 1, 0.2);
    // The maximum cannot be below the likelihood at the true parameters.
    assert.ok(fit.logLik >= referenceLogLik(returns, TRUE.alpha, TRUE.beta, TRUE.nu) - 1e-6);
  }
});

test('garch-t: output is internally consistent and matches an independent likelihood', () => {
  const returns = simulateGarchT(500, 5);
  const fit = fitGarch(returns);
  const m = mean(returns);
  assert.ok(fit.alpha >= 0 && fit.beta >= 0 && fit.alpha + fit.beta < 1);
  assert.ok(fit.nu > 2 && fit.nu <= 200);
  near(fit.persistence, fit.alpha + fit.beta, 1e-15);
  near(fit.omega, fit.longRunSigma ** 2 * (1 - fit.persistence), 1e-15);
  near(fit.halfLifeDays, Math.log(0.5) / Math.log(fit.persistence), 1e-9);
  assert.equal(fit.sigmaSeries.length, 500);
  near(fit.sigmaSeries[0], fit.longRunSigma, 1e-15);
  for (let t = 1; t <= 500; t += 1) {
    const next = t === 500 ? fit.sigmaNext : fit.sigmaSeries[t];
    const expected = fit.omega + fit.alpha * (returns[t - 1] - m) ** 2 + fit.beta * fit.sigmaSeries[t - 1] ** 2;
    near(next ** 2, expected, 1e-14);
  }
  near(fit.logLik, referenceLogLik(returns, fit.alpha, fit.beta, fit.nu), 1e-7);
});

test('garch-t: no nearby parameter vector has a higher likelihood', () => {
  for (const seed of [2, 7]) {
    const returns = simulateGarchT(500, seed);
    const { alpha, beta, nu, logLik } = fitGarch(returns);
    for (const [da, db, dn] of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, -1, 0]]) {
      for (const sign of [-1, 1]) {
        for (const size of [0.001, 0.01]) {
          const a = alpha + sign * da * size;
          const b = beta + sign * db * size;
          if (a < 0 || b < 0 || a + b >= 1) continue;
          assert.ok(referenceLogLik(returns, a, b, nu * (1 + sign * dn * size)) <= logLik + 1e-4);
        }
      }
    }
  }
});

test('garch-t: scaling the returns scales sigma and leaves the dynamics', () => {
  const returns = simulateGarchT(500, 3);
  const base = fitGarch(returns);
  const scaled = fitGarch(returns.map((x) => 4 * x));
  near(scaled.alpha, base.alpha, 1e-5);
  near(scaled.beta, base.beta, 1e-5);
  near(scaled.sigmaNext / base.sigmaNext, 4, 1e-4);
  near(scaled.logLik, base.logLik - 500 * Math.log(4), 1e-5);
});

test('garch-t: constant-variance Gaussian data has no invented persistence', () => {
  const fit = fitGarch(gaussian(500, 101));
  assert.equal(fit.alpha, 0);
  assert.equal(fit.beta, 0);
  assert.equal(fit.persistence, 0);
  assert.equal(fit.halfLifeDays, null);
  assert.ok(fit.nu > 30, `nu ${fit.nu}`);
  near(fit.sigmaNext, fit.longRunSigma, 1e-15);
});

test('garch-t: null cases and filtering', () => {
  assert.equal(fitGarch(simulateGarchT(99, 1)), null);
  assert.ok(fitGarch(simulateGarchT(100, 1)));
  assert.equal(fitGarch(new Array(300).fill(0)), null);
  assert.equal(fitGarch(new Array(300).fill(0.001)), null);
  assert.equal(fitGarch(gaussian(300, 4).map((x, i) => (i % 5 < 3 ? 0 : x))), null);
  assert.equal(fitGarch(undefined), null);
  assert.equal(fitGarch(new Array(300).fill(NaN)), null);
  const clean = simulateGarchT(200, 8);
  const dirty = [NaN, ...clean.slice(0, 50), Infinity, null, ...clean.slice(50)];
  assert.deepEqual(fitGarch(dirty), fitGarch(clean));
});

test('forecast: geometric mean reversion by hand', () => {
  const path = garchForecast({ persistence: 0.5, longRunSigma: 0.01, sigmaNext: 0.03 }, 3);
  near(path[0] ** 2, 9e-4, 1e-15);
  near(path[1] ** 2, 5e-4, 1e-15);
  near(path[2] ** 2, 3e-4, 1e-15);
});

test('forecast: follows the fitted recursion and reaches the long-run level', () => {
  const fit = fitGarch(simulateGarchT(500, 4));
  const path = garchForecast(fit, 5000);
  assert.equal(path.length, 5000);
  near(path[0], fit.sigmaNext, 1e-15);
  near(path[1] ** 2, fit.omega + fit.persistence * fit.sigmaNext ** 2, 1e-15);
  near(path[4999], fit.longRunSigma, 1e-9);
  const direction = Math.sign(fit.longRunSigma - fit.sigmaNext);
  for (let h = 1; h < 100; h += 1) assert.ok((path[h] - path[h - 1]) * direction >= 0);
  assert.deepEqual(garchForecast(null, 5), []);
  assert.deepEqual(garchForecast(fit, 0), []);
  assert.deepEqual(garchForecast(fit, NaN), []);
});

test('volatility: deterministic and fast on 500 observations', () => {
  const returns = simulateGarchT(500, 6);
  assert.deepEqual(fitGarch(returns), fitGarch(returns));
  const times = Array.from({ length: 7 }, () => {
    const start = performance.now();
    fitGarch(returns);
    ewmaVolatility(returns);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  assert.ok(times[3] < 50, `median ${times[3]} ms`);
});
