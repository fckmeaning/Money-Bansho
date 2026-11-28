import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assembleInstability, COUNTRIES, NEWS_FEEDS } from '../instability-data.js';
import {
  bootstrapSigma,
  composite,
  COMPONENTS,
  crossCountryPrior,
  despike,
  dispersion,
  invert,
  isPegged,
  logit,
  marketFeatures,
  oneSidedDistance,
  PARAMS,
  pooledCorrelation,
  posterior,
  recencySurprise,
  referenceAt,
  robustLocationScale,
  robustZ,
  scoreFromZ,
  shrinkageIntensity,
  shrunkShare,
  soften,
  studentT4,
  zSeries,
} from './instability.js';
import { normalSample, seededRandom } from './stats.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27, 12);
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

function walk(n, sigma = 0.01, seed = 3, stress = 0) {
  const random = seededRandom(seed);
  let price = 100;
  return Array.from({ length: n }, (_, i) => {
    const stressed = i >= n - stress;
    price *= Math.exp(normalSample(random) * (stressed ? sigma * 5 : sigma) - (stressed ? 0.03 : 0));
    const t = NOW - (n - 1 - i) * DAY;
    return { t, day: Math.floor(t / DAY), c: price };
  });
}

const equicorrelated = (rho) => COMPONENTS.map((_, i) => COMPONENTS.map((__, j) => (i === j ? 1 : rho)));

test('base weights sum to one', () => {
  close(COMPONENTS.reduce((t, c) => t + c.weight, 0), 1);
});

test('robust z uses median and MAD, is not clipped and refuses a flat sample', () => {
  const fit = robustLocationScale([1, 2, 3, 4, 1000]);
  close(fit.centre, 3);
  close(fit.scale, 1.4826);
  close(robustZ(3 + 1.4826, [1, 2, 3, 4, 1000]), 1);
  assert.ok(robustZ(1e6, [1, 2, 3, 4, 5]) > 1000);
  assert.equal(robustZ(2, [1, 1, 1, 1]), null);
});

test('score is a Student t(4) transform: symmetric, strictly increasing, without ties in the tail', () => {
  close(scoreFromZ(0), 50);
  close(studentT4(2.776445105), 0.975, 1e-6);
  close(scoreFromZ(2) + scoreFromZ(-2), 100);
  const scores = [3, 6, 7, 10, 20, 50].map(scoreFromZ);
  assert.ok(scores.every((s, i) => s < 100 && (i === 0 || s > scores[i - 1])));
  close(soften(0.001), 0.001, 1e-9);
  assert.equal(scoreFromZ(undefined), null);
});

test('matrix inverse and one-sided Mahalanobis distance', () => {
  const R = [[1, 0.6], [0.6, 1]];
  const P = invert(R);
  close(P[0][0], 1 / 0.64);
  close(P[0][1], -0.6 / 0.64);
  assert.equal(invert([[1, 1], [1, 1]]), null);
  close(oneSidedDistance([-1, -2], P), 0);
  close(oneSidedDistance([3, 4], invert([[1, 0], [0, 1]])), 5);
  // Two jointly high correlated components are less surprising than two independent ones.
  assert.ok(oneSidedDistance([2, 2], P) < Math.hypot(2, 2));
  // Monotone in every coordinate.
  const random = seededRandom(11);
  for (let i = 0; i < 200; i += 1) {
    const z = [normalSample(random) * 2, normalSample(random) * 2];
    const base = oneSidedDistance(z, P);
    assert.ok(oneSidedDistance([z[0] + 0.3, z[1]], P) >= base - 1e-8);
    assert.ok(oneSidedDistance([z[0], z[1] + 0.3], P) >= base - 1e-8);
  }
});

test('aggregate: neutral state is 50, Shapley contributions are exact, nothing is invented', () => {
  close(composite(Object.fromEntries(COMPONENTS.map((c) => [c.id, 0]))).index, 50);
  const zs = { eqVol: 1.7, fxDep: -0.8, newsTone: 0.4, newsVolume: 2.2 };
  const result = composite(zs, { correlation: equicorrelated(0.3) });
  close(50 + Object.values(result.contributions).reduce((a, b) => a + b, 0), result.index);
  close(Object.values(result.weights).reduce((a, b) => a + b, 0), 1);
  close(result.coverage, 0.18 + 0.13 + 0.18 + 0.12);
  assert.ok(result.contributions.eqVol > 0 && result.contributions.fxDep < 0);
  assert.equal(composite({}).index, null);
  assert.equal(composite({ eqVol: 3 }).index, null);
});

test('aggregate is monotone and weighs tail stress more than the mean does', () => {
  const R = equicorrelated(0.4);
  const low = composite({ eqVol: 0.5, fxVol: 0.5, newsTone: 0.5 }, { correlation: R }).index;
  const higher = composite({ eqVol: 0.9, fxVol: 0.5, newsTone: 0.5 }, { correlation: R }).index;
  assert.ok(higher > low);
  const spread = composite({ eqVol: 4, fxVol: -4 }, { correlation: R });
  assert.ok(spread.index > 50);
});

test('redundant components lose weight', () => {
  const R = equicorrelated(0);
  R[0][1] = R[1][0] = 0.9;
  const { weights } = composite({ eqVol: 1, eqDrawdown: 1, newsTone: 1 }, { correlation: R });
  const plain = composite({ eqVol: 1, eqDrawdown: 1, newsTone: 1 }).weights;
  assert.ok(weights.newsTone > plain.newsTone && weights.eqVol < plain.eqVol);
});

test('correlation estimate and its shrinkage intensity', () => {
  close(pooledCorrelation([[[1, 2], [2, 4], [3, 6]], [[10, 1], [11, 3], [12, 5]]]).r, 1);
  close(shrinkageIntensity([{ r: 0.9, nEff: 1000 }]), PARAMS.minCorrelationShrinkage);
  assert.equal(shrinkageIntensity([{ r: 0.05, nEff: 10 }]), 1);
});

test('empirical Bayes shrinks poorly covered countries more and widens their interval', () => {
  const prior = crossCountryPrior([-0.5, 0.1, 0.4, 0.9, 1.4].map((theta) => ({ theta, sigma: 0.2 })));
  const full = posterior({ theta: 2, sigma: 0.2, coverage: 1 }, prior);
  const thin = posterior({ theta: 2, sigma: 0.2, coverage: 0.3 }, prior);
  assert.ok(thin.reliability < full.reliability);
  assert.ok(logit(thin.index / 100) - prior.mean < logit(full.index / 100) - prior.mean);
  assert.ok(thin.high - thin.low > full.high - full.low);
  assert.ok(full.low < full.index && full.index < full.high);
  assert.equal(crossCountryPrior([{ theta: 1, sigma: 0.1 }]), null);
  close(posterior({ theta: 0, sigma: 0.1, coverage: 0.5 }, null).index, 50);
});

test('z-series has no look-ahead and needs a minimum history', () => {
  const values = walk(400).map((bar) => Math.log(bar.c));
  const full = zSeries(values);
  const prefix = zSeries(values.slice(0, 300));
  assert.deepEqual(full.slice(0, 300), prefix);
  assert.ok(full.slice(0, 120).every((z) => z === null));
  assert.equal(referenceAt(values, 119), null);
  assert.equal(referenceAt(values, 399).length, 252);
});

test('market stress raises volatility, drawdown and the standardised shock', () => {
  const { features, model } = marketFeatures(walk(500, 0.008, 5, 5), 'equity');
  for (const values of Object.values(features)) assert.ok(zSeries(values).at(-1) > 1);
  assert.ok(model.type);
});

test('currency depreciation follows the quote direction', () => {
  const bars = walk(100).map((bar, i) => ({ ...bar, c: 10 * 1.001 ** i }));
  assert.ok(marketFeatures(bars, 'fx', 1).features.fxDep.at(-1) > 0);
  assert.ok(marketFeatures(bars, 'fx', -1).features.fxDep.at(-1) < 0);
});

test('bad ticks are removed and pegs are detected', () => {
  const bars = walk(300, 0.005);
  bars[150] = { ...bars[150], c: bars[150].c * 1.5 };
  assert.equal(despike(bars).removed, 1);
  assert.equal(isPegged(walk(300, 0.00001)), true);
  assert.equal(isPegged(walk(300, 0.006)), false);
});

test('recency surprise is zero for an average share and ignores single-date feeds', () => {
  const flat = recencySurprise([
    { N: 100, sum: 40, squares: 25, m: 20, x: 8 },
    { N: 50, sum: 50, squares: 50, m: 30, x: 30 },
  ]);
  close(flat.z, 0);
  assert.ok(recencySurprise([{ N: 100, sum: 20, squares: 20, m: 20, x: 15 }]).z > 4);
  assert.equal(recencySurprise([{ N: 50, sum: 50, squares: 50, m: 30, x: 30 }]), null);
  assert.equal(dispersion([0.1, -0.2, 0.3, 0.1, -0.1]), 1);
  assert.ok(dispersion([4, -5, 6, 3, -4]) > 1);
});

test('shrinkage pulls small samples to the pooled share', () => {
  close(shrunkShare(0, 0, 0.3), 0.3);
  assert.ok(shrunkShare(5, 5, 0.2) < shrunkShare(500, 500, 0.2));
});

test('bootstrap standard error is deterministic and positive', () => {
  const reference = walk(252).map((bar) => bar.c);
  const inputs = {
    eqVol: { x: reference.at(-1), reference },
    newsVolume: { z: 1 },
    newsTone: { share: 0.4, n: 23.7, pooled: 0.3, centre: 0.3, scale: 0.08 },
  };
  const sigma = bootstrapSigma(inputs, { seed: 7 });
  assert.equal(sigma, bootstrapSigma(inputs, { seed: 7 }));
  assert.ok(sigma > 0 && sigma < 3);
  assert.equal(bootstrapSigma({}), null);
});

test('universe and feeds satisfy the method', () => {
  assert.ok(COUNTRIES.length >= 20);
  for (const code of ['UA', 'IL', 'CN', 'RU', 'IR', 'TW', 'KR', 'KP', 'US', 'DE']) assert.ok(COUNTRIES.some((c) => c.code === code));
  assert.ok(NEWS_FEEDS.every((feed) => !feed.url.includes('news.google.com') && feed.lang !== 'zh'));
});

test('without any data every country is reported as missing', () => {
  const body = assembleInstability({ charts: new Map(), items: [], nowMs: NOW });
  for (const country of body.countries) {
    assert.equal(country.index, null);
    assert.equal(country.low, null);
    assert.ok(country.components.every((c) => c.score === null && c.reason));
  }
  assert.ok(body.regions.every((region) => region.index === null));
});

test('partial coverage, exact decomposition and stale series', () => {
  const charts = new Map([
    ['^GSPC', { meta: {}, history: walk(500) }],
    ['DX-Y.NYB', { meta: {}, history: walk(500, 0.004, 9) }],
    ['^MERV', { meta: {}, history: walk(500).map((b) => ({ ...b, t: b.t - 40 * DAY, day: b.day - 40 })) }],
  ]);
  // Tone compares countries, so at least five of them need five headlines each.
  const names = ['North Korea', 'China', 'Japan', 'India', 'France'];
  const items = Array.from({ length: 50 }, (_, i) => ({
    title: `${names[i % 5]} ${i % 3 ? 'report' : 'missile threat'} ${i}`,
    url: `https://example.org/${i}`, source: 'Test', feed: 'a', time: NOW - i * 3 * 3_600_000,
  }));
  const body = assembleInstability({ charts, items, nowMs: NOW });
  const by = (code) => body.countries.find((c) => c.code === code);
  const us = by('US');
  close(us.coverage, 0.7);
  assert.ok(us.index > 0 && us.history.length > 100);
  assert.ok(us.low <= us.index && us.index <= us.high);
  close(50 + us.components.reduce((t, c) => t + (c.contribution ?? 0), 0) + us.shrinkage, us.index, 1e-4);
  close(by('KP').coverage, 0.3);
  assert.equal(by('KP').rank, null);
  assert.equal(by('KP').history.length, 0);
  assert.match(by('AR').equity.reason, /не обновляется/);
  assert.equal(by('AR').index, null);
});
