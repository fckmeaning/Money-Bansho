import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  benjaminiHochberg, bootstrapCarTest, corradoRankTest, fisherCombine, sourceDiversity,
} from './inference.js';
import { normalSample, seededRandom } from './stats.js';

const close = (actual, expected, tolerance = 1e-5) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`,
);
const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);

// Benjamini & Hochberg (1995), section 4: fifteen p-values, four rejections at 0.05.
const PAPER = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344,
  0.0459, 0.324, 0.4262, 0.5719, 0.6528, 0.759, 1];

test('BH reproduces the textbook example computed by hand', () => {
  const result = benjaminiHochberg(PAPER, 0.05);
  assert.equal(result.tested, 15);
  assert.equal(result.discoveries, 4);
  assert.deepEqual(result.rejected, PAPER.map((_, i) => i < 4));
  const expected = [
    0.0015, 0.003, 0.0095, 0.035625, 0.0603,
    (15 * 0.0298) / 7, (15 * 0.0298) / 7, // q6 is capped by the smaller value at rank 7
    0.0645, 0.0765, 0.486, (15 * 0.4262) / 11, (15 * 0.5719) / 12, (15 * 0.6528) / 13,
    (15 * 0.759) / 14, 1,
  ];
  result.qValues.forEach((q, i) => close(q, expected[i], 1e-12));
});

test('BH keeps alignment, skips nulls and stays monotone', () => {
  const input = [0.04, null, 0.001, undefined, 0.03, NaN, 0.8];
  const result = benjaminiHochberg(input);
  assert.equal(result.tested, 4);
  assert.deepEqual(result.qValues.map((q) => q === null), [false, true, false, true, false, true, false]);
  close(result.qValues[2], 0.004, 1e-12);
  close(result.qValues[4], (4 * 0.04) / 3, 1e-12);
  close(result.qValues[0], (4 * 0.04) / 3, 1e-12);
  close(result.qValues[6], 0.8, 1e-12);
  assert.deepEqual(result.rejected, [true, false, true, false, true, false, false]);
  assert.equal(result.discoveries, 3);
  // A p-value exactly on its threshold is rejected.
  assert.equal(benjaminiHochberg([0.05, 0.1], 0.1).discoveries, 2);
  assert.deepEqual(benjaminiHochberg([null]), { qValues: [null], rejected: [false], discoveries: 0, tested: 0 });
  assert.equal(benjaminiHochberg(null), null);
  assert.equal(benjaminiHochberg([0.5], 0), null);
});

test('Corrado: one day, by hand', () => {
  const result = corradoRankTest(range(1, 30), [100]);
  // rank 31 of 31, mean 16, population variance of ranks (31^2 - 1)/12 = 80
  close(result.z, 15 / Math.sqrt(80));
  close(result.pValue, 2 / 31, 1e-12);
});

test('Corrado: five days, by hand, with exact permutation p-value', () => {
  const result = corradoRankTest(range(1, 30), range(31, 5));
  // sum 165, mean 90, variance 5 * 102 * 30 / 34 = 450
  close(result.z, 75 / Math.sqrt(450));
  close(result.pValue, 2 / 324632, 1e-12);
});

test('Corrado: exact p-value agrees with brute-force enumeration, ties included', () => {
  const estimation = range(0, 30).map((i) => Math.floor(i / 3));
  const event = [9, 2];
  const result = corradoRankTest(estimation, event);
  const all = [...estimation, ...event];
  const midrank = all.map((v) => all.filter((x) => x < v).length + (all.filter((x) => x === v).length + 1) / 2);
  const centre = 2 * (all.length + 1) / 2;
  const observed = Math.abs(midrank[30] + midrank[31] - centre);
  let extreme = 0;
  let pairs = 0;
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      pairs += 1;
      if (Math.abs(midrank[i] + midrank[j] - centre) >= observed - 1e-9) extreme += 1;
    }
  }
  close(result.pValue, extreme / pairs, 1e-12);
});

test('Corrado: invariant to monotone transforms and robust to outliers', () => {
  const random = seededRandom(4);
  const estimation = range(0, 100).map(() => normalSample(random));
  const event = [0.5, 1.2, 0.9];
  const base = corradoRankTest(estimation, event);
  assert.deepEqual(corradoRankTest(estimation.map(Math.exp), event.map(Math.exp)), base);
});

function rejectionRate(replications, draw) {
  let rejected = 0;
  for (let r = 0; r < replications; r += 1) if (draw(r) <= 0.05) rejected += 1;
  return rejected / replications;
}

test('Corrado: calibrated under the null for heavy tails and several window lengths', () => {
  for (const length of [1, 3, 5, 21]) {
    const random = seededRandom(1000 + length);
    // Student-like heavy tails: a normal divided by a random scale.
    const draw = () => normalSample(random) / Math.max(0.2, Math.abs(normalSample(random)));
    const rate = rejectionRate(2000, () => corradoRankTest(
      range(0, 120).map(draw), range(0, length).map(draw),
    ).pValue);
    console.log(`corrado L=${length}: rejection at 5% = ${rate.toFixed(4)}`);
    assert.ok(rate > 0.03 && rate < 0.07, `L=${length}: ${rate}`);
  }
});

test('Corrado: detects a shift and returns null on thin or degenerate input', () => {
  const random = seededRandom(5);
  const estimation = range(0, 120).map(() => normalSample(random));
  const result = corradoRankTest(estimation, range(0, 5).map(() => 2.5 + normalSample(random)));
  assert.ok(result.z > 3 && result.pValue < 0.005);
  assert.equal(corradoRankTest(estimation.slice(0, 29), [1]), null);
  assert.equal(corradoRankTest(estimation, []), null);
  assert.equal(corradoRankTest(estimation, [1, NaN]), null);
  assert.equal(corradoRankTest(Array(50).fill(1), [1, 1]), null);
  assert.equal(corradoRankTest(null, [1]), null);
});

test('bootstrap: calibrated under the null', () => {
  const random = seededRandom(77);
  const rate = rejectionRate(2000, (r) => {
    const residuals = range(0, 150).map(() => normalSample(random));
    let car = 0;
    for (let i = 0; i < 5; i += 1) car += normalSample(random);
    return bootstrapCarTest(residuals, car, 5, { samples: 999, seed: r + 1 }).pValue;
  });
  console.log(`bootstrap: rejection at 5% = ${rate.toFixed(4)}`);
  assert.ok(rate > 0.035 && rate < 0.075, `rate ${rate}`);
});

test('bootstrap: band matches theory, extremes and determinism', () => {
  const random = seededRandom(6);
  const residuals = range(0, 500).map(() => 0.3 + 0.01 * normalSample(random));
  const result = bootstrapCarTest(residuals, 0.2, 9);
  assert.equal(result.pValue, 1 / 2001);
  // Centred sums of nine draws: standard deviation about 0.03, whatever the mean.
  close(result.low, -1.96 * 0.03, 0.01);
  close(result.high, 1.96 * 0.03, 0.01);
  assert.equal(bootstrapCarTest(residuals, 0, 9).pValue, 1);
  assert.deepEqual(bootstrapCarTest(residuals, 0.04, 9, { seed: 3 }), bootstrapCarTest(residuals, 0.04, 9, { seed: 3 }));
  assert.equal(bootstrapCarTest(residuals, -0.2, 9).pValue, 1 / 2001);
});

test('bootstrap: null cases', () => {
  const ok = range(0, 60).map((i) => Math.sin(i));
  assert.equal(bootstrapCarTest(ok.slice(0, 29), 0.1, 3), null);
  assert.equal(bootstrapCarTest(ok, NaN, 3), null);
  assert.equal(bootstrapCarTest(ok, 0.1, 0), null);
  assert.equal(bootstrapCarTest(ok, 0.1, 2.5), null);
  assert.equal(bootstrapCarTest(ok, 0.1, 61), null);
  assert.equal(bootstrapCarTest(ok, 0.1, 3, { samples: 10 }), null);
  assert.equal(bootstrapCarTest(Array(60).fill(0.1), 0.1, 3), null);
  assert.equal(bootstrapCarTest(null, 0.1, 3), null);
});

test('source diversity by hand', () => {
  const result = sourceDiversity(['Reuters', ' reuters ', 'Bloomberg', 'FT', null, '']);
  assert.equal(result.sources, 3);
  const entropy = -(0.5 * Math.log(0.5) + 0.5 * Math.log(0.25));
  close(result.entropy, entropy);
  close(result.normalized, entropy / Math.log(3));
  close(result.herfindahl, 0.375);
  close(result.effectiveSources, Math.exp(entropy));
  assert.deepEqual(sourceDiversity(['A', 'A']), {
    sources: 1, entropy: 0, normalized: 0, herfindahl: 1, effectiveSources: 1,
  });
  const even = sourceDiversity(['a', 'b', 'c', 'd']);
  close(even.normalized, 1);
  close(even.effectiveSources, 4);
  assert.equal(sourceDiversity(['A']), null);
  assert.equal(sourceDiversity([]), null);
  assert.equal(sourceDiversity([null, ' ']), null);
  assert.equal(sourceDiversity('Reuters'), null);
});

test('Fisher combination by hand, tails and nulls', () => {
  const two = fisherCombine([0.05, null, 0.05]);
  close(two.statistic, -4 * Math.log(0.05), 1e-12);
  assert.equal(two.df, 4);
  close(two.pValue, 0.0025 * (1 - 2 * Math.log(0.05)), 1e-12);
  close(fisherCombine([0.2]).pValue, 0.2, 1e-12);
  close(fisherCombine([1, 1, 1]).pValue, 1, 1e-12);
  const tiny = fisherCombine([1e-20, 1e-20]);
  assert.ok(tiny.pValue > 0 && tiny.pValue < 1e-37);
  assert.ok(Number.isFinite(fisherCombine([0, 0.5]).statistic));
  const many = fisherCombine(Array(2000).fill(0.5));
  assert.ok(many.pValue > 0.99 && many.pValue <= 1);
  assert.equal(fisherCombine([]), null);
  assert.equal(fisherCombine([null, 2, -1]), null);
  assert.equal(fisherCombine(undefined), null);
});

test('Fisher: calibrated for independent uniform p-values', () => {
  const random = seededRandom(12);
  const rate = rejectionRate(4000, () => fisherCombine(range(0, 6).map(random)).pValue);
  assert.ok(rate > 0.038 && rate < 0.062, `rate ${rate}`);
});

test('each call stays well under 50 ms', () => {
  const random = seededRandom(30);
  const estimation = range(0, 250).map(() => normalSample(random));
  const many = range(0, 500).map(random);
  const names = range(0, 500).map((i) => `outlet ${i % 40}`);
  const longest = Math.floor(Math.sqrt(6e6) / 260);
  const cases = {
    benjaminiHochberg: () => benjaminiHochberg(many),
    corradoExact: () => corradoRankTest(estimation, estimation.slice(0, longest)),
    corradoNormal: () => corradoRankTest(estimation, estimation.slice(0, 60)),
    bootstrap: () => bootstrapCarTest(estimation, 1, 61),
    sourceDiversity: () => sourceDiversity(names),
    fisherCombine: () => fisherCombine(many),
  };
  for (const [name, run] of Object.entries(cases)) {
    run();
    const start = performance.now();
    for (let i = 0; i < 5; i += 1) run();
    const each = (performance.now() - start) / 5;
    console.log(`${name}: ${each.toFixed(2)} ms`);
    assert.ok(each < 50, `${name}: ${each} ms`);
  }
});
