import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { POINTS, assembleGeoscore, siteTerm, termsRe } from '../geoscore-data.js';
import {
  COMPONENTS, PARAMS, aggregate, conflictProximity, corpusStats, corroboration, haversineKm,
  populationPrior, prepareNews, scoreEntity, volumeSurprise, zoneDistanceKm,
} from './geoscore.js';

const NOW = Date.UTC(2026, 10, 27, 12);
const HOUR = 3_600_000;
const v = (value, sd = 0.05) => ({ value, sd });
const all = (x, sd) => Object.fromEntries(COMPONENTS.map((c) => [c.id, v(x, sd)]));
const prior = { mean: 0.4, between: 0.02, spread: Object.fromEntries(COMPONENTS.map((c) => [c.id, 0.05])), n: 100 };
const square = { name: 'Z', intensity: 'high', center: [1, 1], coords: [[0, 0], [2, 0], [2, 2], [0, 2]] };

describe('geography', () => {
  it('measures great-circle distance and polygon membership', () => {
    assert.ok(Math.abs(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111.195) < 0.01);
    assert.equal(zoneDistanceKm({ lat: 1, lon: 1.5 }, square), 0);
    assert.ok(zoneDistanceKm({ lat: 10, lon: 10 }, square) > 1000);
  });

  it('decays conflict proximity with distance', () => {
    const near = conflictProximity({ lat: 1, lon: 1 }, [square]);
    const far = conflictProximity({ lat: 1, lon: 12 }, [square]);
    assert.equal(near.value, 1);
    assert.ok(far.value < 0.2 && far.value > 0 && far.sd > 0);
  });
});

describe('news evidence', () => {
  const items = [];
  for (let i = 0; i < 40; i += 1) {
    // "Alpha" is only in the last day; the rest of the feed is spread over a week.
    items.push({ feed: 'f', source: `s${i % 5}`, title: `Item ${i}`, time: NOW - (i * 4) * HOUR });
  }
  for (let i = 0; i < 6; i += 1) items.push({ feed: 'f', source: `s${i}`, title: `Alpha attack ${i}`, time: NOW - i * HOUR });
  const news = prepareNews(items, () => -0.5, NOW);
  const corpus = corpusStats(news);
  const alpha = news.filter((n) => n.title.startsWith('Alpha'));

  it('finds a surprise only with enough mentions', () => {
    assert.ok(volumeSurprise(alpha, corpus).z > 2);
    assert.equal(volumeSurprise(alpha.slice(0, 2), corpus), null);
  });

  it('saturates corroboration and reports silence as missing', () => {
    assert.ok(corroboration(alpha).value > corroboration(alpha.slice(0, 1)).value);
    assert.ok(corroboration(alpha).value < 1);
    assert.equal(corroboration([], []).value, undefined);
    assert.ok(corroboration([], alpha).value <= 1 - Math.exp(-PARAMS.countryCap / PARAMS.corroborationScale));
  });
});

describe('aggregation', () => {
  it('has weights summing to one', () => {
    assert.ok(Math.abs(COMPONENTS.reduce((t, c) => t + c.weight, 0) - 1) < 1e-12);
  });

  it('renormalises weights and gives no score to static geography alone', () => {
    const agg = aggregate({ instability: v(0.6), conflict: v(0.6) });
    assert.ok(Math.abs(agg.raw - 0.6) < 1e-12);
    assert.ok(Math.abs(agg.coverage - 0.38) < 1e-12);
    const none = scoreEntity({ conflict: v(0.9), exposure: v(0.9) }, prior);
    assert.equal(none.score, null);
    assert.match(none.explain, /Оценки нет/);
  });

  it('decomposes the score additively and brackets it', () => {
    const s = scoreEntity({ surprise: v(0.9), instability: v(0.3), conflict: v(0.7) }, prior);
    const parts = s.components.reduce((t, c) => t + (c.points ?? 0), 0) + s.priorPart;
    assert.ok(Math.abs(parts - s.score) < 0.001);
    assert.ok(s.low < s.score && s.score < s.high);
  });

  it('shrinks and widens when evidence is thin', () => {
    const full = scoreEntity(all(0.8, 0.05), prior);
    const thin = scoreEntity({ instability: v(0.8, 0.05), conflict: v(0.8, 0.05) }, prior);
    assert.ok(thin.shrinkage < full.shrinkage);
    assert.ok(Math.abs(thin.score - 40) < Math.abs(full.score - 40));
    assert.ok(thin.high - thin.low > full.high - full.low);
  });

  it('estimates the prior from the scored population only', () => {
    const p = populationPrior([all(0.2, 0.05), all(0.5, 0.05), all(0.8, 0.05), { conflict: v(1) }]);
    assert.equal(p.n, 3);
    assert.ok(Math.abs(p.mean - 0.5) < 1e-12);
    assert.equal(populationPrior([all(0.5, 0.05)]), null);
  });
});

describe('assembly', () => {
  it('builds matchers without generic words or bare country names', () => {
    assert.equal(termsRe(['oil', 'ai']), null);
    assert.ok(termsRe(['hormuz']).test('Tankers leave Hormuz'));
    assert.equal(siteTerm('Iran Nuclear Facility'), null);
    assert.equal(siteTerm('Bushehr Nuclear Power Plant'), 'Bushehr');
  });

  it('scores real map points from evidence and leaves the rest unscored', () => {
    const items = [];
    for (let i = 0; i < 60; i += 1) items.push({ feed: 'a', source: `o${i % 4}`, title: `Quiet note ${i}`, time: NOW - i * 2 * HOUR });
    for (let i = 0; i < 8; i += 1) items.push({ feed: 'a', source: `o${i}`, title: `Iran missile strike near Tehran ${i}`, time: NOW - i * HOUR });
    const instability = { countries: [{ code: 'IR', name: 'Иран', index: 70, low: 60, high: 80, coverage: 0.3 },
      { code: 'US', name: 'США', index: 40, low: 35, high: 45, coverage: 1 },
      { code: 'RU', name: 'Россия', index: 55, low: 50, high: 60, coverage: 1 }] };
    const { body } = assembleGeoscore({ items, instability, world: null, nowMs: NOW });
    assert.equal(body.points.length, POINTS.length);
    const byKey = new Map(body.points.map((p) => [p.key, p]));
    assert.ok(byKey.get('hotspot:tehran').score > byKey.get('hotspot:dc').score);
    assert.equal(byKey.get('waterway:cape_of_good_hope').score, null);
    for (const p of body.points) if (p.score !== null) assert.ok(p.low <= p.score && p.score <= p.high);
    // No world events collected: the market component is missing everywhere.
    assert.ok(body.points.every((p) => p.components.find((c) => c.id === 'market').value === null));
  });
});
