import assert from 'node:assert/strict';
import test from 'node:test';

import { nelderMead } from './optimize.js';
import { betaI, chiSquareSf, erf, gammaP, logGamma, normalCdf, normalQuantile, studentTCdf, studentTQuantile, studentTTwoSided } from './special.js';
import { excessKurtosis, quantile, ranks, seededRandom } from './stats.js';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('special functions match reference values', () => {
  near(logGamma(5), Math.log(24), 1e-10);
  near(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-10);
  near(erf(1), 0.8427007929497149, 1e-10);
  near(erf(-0.5), -0.5204998778130465, 1e-10);
  near(gammaP(1, 2), 1 - Math.exp(-2), 1e-10);
  near(betaI(0.3, 1, 1), 0.3, 1e-10);
  near(betaI(0.5, 4, 4), 0.5, 1e-10);
  near(normalCdf(1.959963984540054), 0.975, 1e-10);
  near(normalQuantile(0.975), 1.959963984540054, 1e-8);
  near(normalQuantile(0.001), -3.090232306167813, 1e-8);
  near(studentTCdf(2.2281388519649385, 10), 0.975, 1e-8);
  near(studentTQuantile(0.975, 10), 2.2281388519649385, 1e-7);
  near(studentTTwoSided(2.2281388519649385, 10), 0.05, 1e-8);
  near(chiSquareSf(3.841458820694124, 1), 0.05, 1e-8);
});

test('statistics helpers', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.deepEqual(ranks([10, 30, 20, 20]), [1, 4, 2.5, 2.5]);
  assert.ok(excessKurtosis([-1, 1, -1, 1]) < 0);
  assert.equal(excessKurtosis([2, 2, 2, 2]), null);
  const a = seededRandom(7);
  const b = seededRandom(7);
  assert.equal(a(), b());
});

test('nelder-mead finds the Rosenbrock minimum and survives bad regions', () => {
  const rosenbrock = ([x, y]) => (1 - x) ** 2 + 100 * (y - x * x) ** 2;
  const found = nelderMead(rosenbrock, [-1.2, 1], { maxIterations: 4000, tolerance: 1e-12 });
  near(found.x[0], 1, 1e-3);
  near(found.x[1], 1, 1e-3);
  const guarded = nelderMead(([x]) => (x < 0 ? NaN : (x - 2) ** 2), [0.1]);
  near(guarded.x[0], 2, 1e-3);
});
