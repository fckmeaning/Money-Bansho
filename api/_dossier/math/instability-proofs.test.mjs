// Every property stated in docs/math/instability.md and in the proof block of the
// interface, checked on seeded random inputs.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assembleInstability } from '../instability-data.js';
import {
  composite,
  COMPONENTS,
  explainAggregate,
  invert,
  logistic,
  logit,
  oneSidedSolution,
  PARAMS,
  posterior,
  scoreFromZ,
  soften,
  studentT4,
  weightSensitivity,
} from './instability.js';
import { normalSample, seededRandom } from './stats.js';

const CASES = 400;
const Z90 = 1.6448536269514722;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27, 12);
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const within = (x, low, high, tolerance = 1e-8) => assert.ok(x >= low - tolerance && x <= high + tolerance, `${x} outside [${low}, ${high}]`);

const identity = () => COMPONENTS.map((_, i) => COMPONENTS.map((__, j) => (i === j ? 1 : 0)));

/** A random positive definite correlation matrix, shrunk like the estimated one. */
function correlation(random) {
  const a = COMPONENTS.map(() => Array.from({ length: COMPONENTS.length + 1 }, () => normalSample(random)));
  const s = a.map((x) => a.map((y) => x.reduce((t, v, k) => t + v * y[k], 0)));
  return s.map((row, i) => row.map((v, j) => (i === j ? 1 : (0.9 * v) / Math.sqrt(s[i][i] * s[j][j]))));
}

/** Pairwise estimates need not form a positive definite matrix. */
function inconsistent(random) {
  const m = identity();
  for (let i = 0; i < m.length; i += 1) {
    for (let j = i + 1; j < m.length; j += 1) m[i][j] = m[j][i] = 1.8 * random() - 0.9;
  }
  return m;
}

/** Random components present, z from ordinary to absurd. */
function sample(random, { publishedOnly = true } = {}) {
  for (;;) {
    const scale = [0.5, 2, 6, 40, 1e6][Math.floor(random() * 5)];
    const zs = {};
    for (const c of COMPONENTS) if (random() < 0.7) zs[c.id] = normalSample(random) * scale;
    const R = random() < 0.8 ? correlation(random) : inconsistent(random);
    const coverage = COMPONENTS.reduce((t, c) => t + (c.id in zs ? c.weight : 0), 0);
    if (!publishedOnly || coverage >= PARAMS.minCoverage) return { zs, R };
  }
}

test('T4 is the Student distribution function with 4 degrees of freedom', () => {
  const density = (t) => 0.375 * (1 + (t * t) / 4) ** -2.5;
  for (const t of [-8, -2, -0.3, 0, 0.7, 3, 11]) close((studentT4(t + 1e-5) - studentT4(t - 1e-5)) / 2e-5, density(t), 1e-8);
  close(studentT4(2.131846786), 0.95, 1e-8);
  close(studentT4(-2.776445105), 0.025, 1e-8);
});

test('boundedness: scores, power mean, aggregate, index and interval', () => {
  const random = seededRandom(101);
  for (let n = 0; n < CASES; n += 1) {
    const { zs, R } = sample(random);
    const e = explainAggregate(zs, { correlation: R });
    for (const s of e.scores) assert.ok(s > 0 && s < 100, `score ${s}`);
    within(e.powerMean, Math.min(...e.scores), Math.max(...e.scores));
    assert.ok(e.weights.every((w) => w > 0));
    close(e.weights.reduce((a, b) => a + b, 0), 1);
    assert.ok(e.distance >= 0);
    assert.ok(e.q > 0 && e.q < 100, `Q ${e.q}`);
    assert.ok(e.q >= e.powerMean - 1e-8, `Q ${e.q} below M ${e.powerMean}`);
    const prior = random() < 0.8 ? { mean: normalSample(random), tau2: 0.001 + random() } : null;
    const p = posterior({ theta: logit(e.q / 100), sigma: random(), coverage: e.coverage }, prior);
    assert.ok(p.index >= 0 && p.index <= 100 && p.low >= 0 && p.high <= 100);
    assert.ok(p.low <= p.index && p.index <= p.high);
  }
  const extreme = (z) => composite(Object.fromEntries(COMPONENTS.map((c) => [c.id, z]))).index;
  for (const z of [1e300, -1e300]) assert.ok(extreme(z) >= 0 && extreme(z) <= 100);
});

test('monotonicity: raising any z never lowers D or Q, at fixed R and component set', () => {
  const random = seededRandom(202);
  for (let n = 0; n < CASES; n += 1) {
    const { zs, R } = sample(random);
    const base = explainAggregate(zs, { correlation: R });
    base.ids.forEach((id, i) => {
      const step = [1e-6, 0.05, 1, 25][Math.floor(random() * 4)];
      const moved = { ...zs, [id]: zs[id] + step * (1 + random()) };
      const next = explainAggregate(moved, { correlation: R });
      assert.ok(next.scores[i] >= base.scores[i] - 1e-10, `score fell ${base.scores[i]} -> ${next.scores[i]}`); // rounding noise only
      assert.ok(next.distance >= base.distance - 1e-7, `D fell ${base.distance} -> ${next.distance}`);
      assert.ok(next.q >= base.q - 1e-7, `Q fell ${base.q} -> ${next.q}`);
    });
  }
  // Strict in the ordinary range.
  for (let z = -6; z < 6; z += 0.25) assert.ok(scoreFromZ(z + 0.25) > scoreFromZ(z) && soften(z + 0.25) > soften(z));
});

test('monotonicity: the index rises with theta at fixed sigma, coverage and prior', () => {
  const random = seededRandom(203);
  for (let n = 0; n < CASES; n += 1) {
    const prior = { mean: normalSample(random), tau2: 0.001 + random() };
    const fixed = { sigma: random(), coverage: 0.25 + 0.75 * random() };
    const theta = 3 * normalSample(random);
    assert.ok(posterior({ ...fixed, theta: theta + 0.01 }, prior).index > posterior({ ...fixed, theta }, prior).index);
  }
});

test('the stress distance is certified optimal (Karush-Kuhn-Tucker) and beats random points', () => {
  const random = seededRandom(303);
  for (let n = 0; n < CASES; n += 1) {
    const { zs, R } = sample(random);
    const e = explainAggregate(zs, { correlation: R });
    const size = Math.max(1, ...e.soft.map(Math.abs));
    e.point.forEach((y, i) => {
      assert.ok(y >= e.soft[i] - 1e-9);
      assert.ok(e.gradient[i] >= -1e-6 * size, `gradient ${e.gradient[i]}`);
      assert.ok(Math.abs(e.gradient[i] * (y - e.soft[i])) <= 1e-5 * size * size);
    });
    for (let trial = 0; trial < 20; trial += 1) {
      const y = e.soft.map((z) => z + Math.max(0, -z + normalSample(random)));
      const value = y.reduce((t, a, i) => t + a * y.reduce((u, b, j) => u + e.precision[i][j] * b, 0), 0);
      assert.ok(value >= e.distance ** 2 - 1e-6 * size * size);
    }
    assert.equal(e.distance <= 1e-9, e.soft.every((z) => z <= 0));
  }
  // Two positively correlated signals never count for more than two independent ones.
  for (let n = 0; n < CASES; n += 1) {
    const r = 0.95 * random();
    const z = [5 * random(), 5 * random()];
    assert.ok(oneSidedSolution(z, invert([[1, r], [r, 1]])).distance <= Math.hypot(...z) + 1e-9);
  }
});

test('missing data: nothing is substituted, weights and coverage follow the present set', () => {
  const random = seededRandom(404);
  for (let n = 0; n < CASES; n += 1) {
    const { zs, R } = sample(random, { publishedOnly: false });
    const padded = Object.fromEntries(COMPONENTS.map((c) => [c.id, zs[c.id] ?? [undefined, null, Number.NaN][n % 3]]));
    const a = composite(zs, { correlation: R });
    assert.deepEqual(composite(padded, { correlation: R }), a);
    close(a.coverage, Math.min(1, COMPONENTS.reduce((t, c) => t + (c.id in zs ? c.weight : 0), 0)));
    const e = explainAggregate(zs, { correlation: R });
    assert.equal(a.index === null, !e.published);
    assert.equal(e.published, e.ids.length > 0 && a.coverage >= PARAMS.minCoverage - 1e-9);
    assert.equal(e.ids.length + e.absent.length, COMPONENTS.length);
    if (!e.published) assert.equal(e.q, undefined);
    else close(e.q, a.index);
  }
});

test('missing weight: own data weigh at most C, and the logit interval widens', () => {
  const random = seededRandom(405);
  for (let n = 0; n < CASES; n += 1) {
    const prior = { mean: normalSample(random), tau2: 0.001 + random() };
    const sigma = random();
    const theta = 3 * normalSample(random);
    const coverage = 0.25 + 0.75 * random();
    const p = posterior({ theta, sigma, coverage }, prior);
    close(p.reliability, 1 / (1 / coverage + sigma ** 2 / prior.tau2));
    assert.ok(p.reliability <= coverage + 1e-12);
    assert.ok(Math.abs(p.mean - prior.mean) <= coverage * Math.abs(theta - prior.mean) + 1e-12);
    close(p.half, Z90 * Math.sqrt(prior.tau2 * (1 - p.reliability)));
    const thinner = posterior({ theta, sigma, coverage: coverage * 0.8 }, prior);
    assert.ok(thinner.reliability < p.reliability && thinner.half >= p.half - 1e-12);
    // Without sampling error the weight of the own data is exactly the coverage.
    close(posterior({ theta, sigma: 0, coverage }, prior).reliability, coverage);
    // Without a prior there is nothing to shrink to: B = 1 whatever the coverage.
    assert.equal(posterior({ theta, sigma, coverage }, null).reliability, 1);
  }
});

test('weight sensitivity: derivative, zero weighted sum and both ranges', () => {
  const random = seededRandom(505);
  for (let n = 0; n < CASES; n += 1) {
    const zs = {};
    for (const c of COMPONENTS) if (random() < 0.8) zs[c.id] = 2.5 * normalSample(random);
    const R = correlation(random);
    const e = explainAggregate(zs, { correlation: R });
    if (!e.published) continue;
    const s = e.sensitivity;
    close(s.derivative.reduce((t, d, i) => t + d * e.base[i], 0), 0, 1e-7);
    // Coverage is not under test here: every reweighted set is allowed to publish.
    const present = COMPONENTS.filter((c) => c.id in zs);
    const q = (weights) => composite(zs, {
      correlation: R,
      components: present.map((c, i) => ({ ...c, weight: weights[i] })),
      shapley: false,
    }).index;
    close(q(e.base), e.q);
    e.base.forEach((w, i) => {
      const h = 1e-6 * w;
      const at = (value) => q(e.base.map((x, j) => (j === i ? value : x)));
      close((at(w + h) - at(w - h)) / (2 * h), s.derivative[i], 1e-3);
    });
    for (let trial = 0; trial < 10; trial += 1) {
      within(q(e.base.map(() => 0.001 + random())), ...s.anyWeights);
      within(q(e.base.map((w) => w * (1 - s.delta + 2 * s.delta * random()))), ...s.range);
    }
    within(e.q, ...s.range);
    within(s.range[0], ...s.anyWeights);
    within(s.range[1], ...s.anyWeights);
  }
  const one = weightSensitivity({ base: [0.4], R: [[1]], scores: [70], shift: 0 });
  close(one.derivative[0], 0);
  close(one.range[0], 70);
});

test('leave-one-out equals the aggregate computed without that component', () => {
  const zs = { eqVol: 1, fxVol: -0.4, fxDep: 2, newsTone: 0.8 };
  const e = explainAggregate(zs, { correlation: correlation(seededRandom(9)) });
  const R = correlation(seededRandom(9));
  e.ids.forEach((id, i) => {
    const { [id]: omitted, ...rest } = zs;
    assert.equal(e.sensitivity.leaveOneOut[i], composite(rest, { correlation: R }).index);
  });
});

test('Shapley contributions: exact sum, zero for a typical component, sign of z', () => {
  const random = seededRandom(606);
  for (let n = 0; n < CASES; n += 1) {
    const { zs, R } = sample(random);
    const typical = Object.keys(zs)[0];
    zs[typical] = 0;
    const result = composite(zs, { correlation: R });
    close(50 + Object.values(result.contributions).reduce((a, b) => a + b, 0), result.index, 1e-7);
    close(result.contributions[typical], 0);
    for (const [id, phi] of Object.entries(result.contributions)) {
      if (zs[id] >= 0) assert.ok(phi >= -1e-7, `${id}: z ${zs[id]}, phi ${phi}`);
      if (zs[id] <= 0) assert.ok(phi <= 1e-7, `${id}: z ${zs[id]}, phi ${phi}`);
    }
  }
});

test('the published proof reproduces every number of a country', () => {
  const walk = (seed, sigma = 0.01) => {
    const random = seededRandom(seed);
    let price = 100;
    return Array.from({ length: 500 }, (_, i) => {
      price *= Math.exp(normalSample(random) * sigma);
      const t = NOW - (499 - i) * DAY;
      return { t, day: Math.floor(t / DAY), c: price };
    });
  };
  const symbols = ['^GSPC', 'DX-Y.NYB', '^GDAXI', 'EUR=X', '^N225', 'JPY=X', '^BSESN', 'INR=X', '000001.SS', 'CNY=X', '^FTSE', 'GBP=X'];
  const charts = new Map(symbols.map((symbol, i) => [symbol, { meta: {}, history: walk(i + 1) }]));
  const names = ['Germany', 'China', 'Japan', 'India', 'France', 'Ukraine'];
  // Two feeds, so the recency test has several strata.
  const items = Array.from({ length: 120 }, (_, i) => ({
    title: `${names[i % 6]} ${i % 4 ? 'report' : 'war crisis'} ${i}`,
    url: `https://example.org/${i}`, source: 'Test', feed: i % 2 ? 'a' : 'b', time: NOW - i * 3_600_000,
  }));
  const body = assembleInstability({ charts, items, nowMs: NOW });
  let published = 0;
  for (const country of body.countries) {
    const { aggregate, posterior: post, inputs } = country.proof;
    for (const part of country.components) {
      if (part.score === null) {
        assert.ok(part.reason && part.reasonEn, `${country.code} ${part.id}`);
        assert.ok(aggregate.absent.includes(part.id));
        assert.equal(part.contribution, null);
        continue;
      }
      const input = inputs[part.id];
      const z = aggregate.z[aggregate.ids.indexOf(part.id)];
      if (input.kind === 'market') close(z, (input.x - input.median) / input.scale);
      else if (input.kind === 'volume') {
        close(z, input.zRaw / input.phi);
        close(input.zRaw, (input.observed - input.expected) / Math.sqrt(input.variance));
      } else {
        close(input.shrunk, (input.effective * input.share + input.strength * input.pooled) / (input.effective + input.strength));
        close(z, (input.shrunk - input.centre) / input.scale);
      }
    }
    if (country.index === null) {
      assert.equal(post, null);
      assert.ok(country.reason && country.reasonEn);
      assert.equal(country.aggregate, null);
      continue;
    }
    published += 1;
    assert.equal(country.reason, null);
    const m = Math.sqrt(aggregate.weights.reduce((t, w, i) => t + w * aggregate.scores[i] ** 2, 0));
    close(m, aggregate.powerMean);
    const q = 100 * logistic(logit(m / 100) + (PARAMS.beta * aggregate.distance) / Math.sqrt(aggregate.ids.length));
    close(q, aggregate.q);
    close(q, country.aggregate, 1e-6);
    close(post.theta, logit(q / 100));
    const v = post.sigma ** 2 + (post.prior ? (post.prior.tau2 * (1 - post.coverage)) / post.coverage : 0);
    const B = post.prior ? post.prior.tau2 / (post.prior.tau2 + v) : 1;
    const mean = post.prior ? post.prior.mean + B * (post.theta - post.prior.mean) : post.theta;
    close(100 * logistic(mean), country.index, 1e-6);
    close(100 * logistic(mean - Z90 * Math.sqrt(B * v)), country.low, 1e-6);
    close(100 * logistic(mean + Z90 * Math.sqrt(B * v)), country.high, 1e-6);
  }
  assert.ok(published >= 5, `published ${published}`);
});
