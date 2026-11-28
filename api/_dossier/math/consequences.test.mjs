import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  companyConsequences, explainDossier, explainEconomy, explainWire, explainWorld, headlineConsequences, worldConsequences,
} from './consequences.js';
import { computeOutlooks } from './forecast.js';

const impact = { carPct: -3.24, z: -2.4, p: 0.018, q: 0.04, sessions: 2, volumeRatio: 1.8, preCarPct: 0.1, preZ: 0.1, model: 'market' };
const outlook = [1, 5, 20].map((h) => ({ h, rule: 'event', fresh: true, multiplier: 1.23, n: 20, low80Pct: -4, high80Pct: 3.5 }));
const event = { id: 'a', type: 'earnings', source: 'Reuters', outlets: 4, impact, outlook, significance: { score: 70, low: 60, high: 78 } };
const BANNED = /покуп|продав|продай|рекомендуем|вырастет|упад[её]т|из-за|buy|sell|will (?:rise|fall)/i;
const text = (value) => JSON.stringify(value).replace(/не инвестиционная рекомендация|not investment advice/g, '');

test('a measured event reports reaction, corridor, channels and confidence without advice', () => {
  const r = companyConsequences(event, { symbol: 'AAPL', name: 'Apple', country: 'US' });
  assert.match(r.summary, /CAR −3,2%/);
  assert.match(r.summary, /направление не определено/);
  assert.equal(r.direction.code, 'uncertain');
  assert.equal(r.confidence.level, 'high');
  assert.equal(r.magnitude.horizons.length, 3);
  assert.ok(r.channels.length >= 3 && r.watch.length >= 2);
  assert.ok(r.exposed.some((x) => x.symbol === 'AAPL') && r.exposed.some((x) => x.symbol === '^GSPC'));
  assert.doesNotMatch(text(r), BANNED);
  assert.deepEqual(r, companyConsequences(event, { symbol: 'AAPL', name: 'Apple', country: 'US' }));
});

test('missing data is said, never filled in', () => {
  const r = companyConsequences({ id: 'b', type: 'deal', source: 'Blog', impact: null });
  assert.match(r.summary, /нет данных/);
  assert.equal(r.direction.code, 'insufficient');
  assert.equal(r.confidence.level, 'low');
  assert.deepEqual(r.magnitude.horizons, []);
  assert.match(r.magnitude.text, /нет данных/);
});

test('an unadjusted corridor is called ordinary volatility, and no direction or centre is claimed', () => {
  const plain = outlook.map((h) => ({ ...h, rule: 'volatility', fresh: false, multiplier: 1, n: 0 }));
  const r = companyConsequences({ ...event, outlook: plain });
  assert.equal(r.direction.code, 'uncertain');
  assert.match(r.magnitude.text, /обычная волатильность/);
  assert.match(r.direction.text, /не прогнозируется/);
  assert.ok(r.magnitude.horizons.every((h) => h.multiplier === 1 && !('expectedPct' in h) && !('probUp' in h)));
});

test('a reaction that fails the multiple-testing correction is not called distinct', () => {
  const r = companyConsequences({ ...event, impact: { ...impact, q: 0.4 } });
  assert.match(r.observed[0], /не отличима/);
  assert.notEqual(r.confidence.level, 'high');
});

test('world events and headlines use measured moves only and stay at most medium', () => {
  const world = worldConsequences({
    type: 'conflict', regions: ['israel'], sourceCount: 9, independent: 5, score: 71.5,
    assets: [
      { symbol: 'CL=F', name: 'Нефть WTI', kind: 'commodity', observed: { change: 4.1, unit: 'pct', z: 2.3, sessions: 2 } },
      { symbol: 'GC=F', name: 'Золото', observed: null, reason: 'нет данных' },
    ],
    companies: [{ symbol: 'ESLT.TA', name: 'Elbit', basis: 'сектор: оборона' }],
  });
  assert.equal(world.confidence.level, 'medium');
  assert.match(world.summary, /Нефть WTI \+4,10%/);
  assert.match(world.magnitude.text, /нет данных/);
  assert.doesNotMatch(text(world), BANNED);
  const lone = headlineConsequences({ title: 'Oil prices climb', source: 'X' }, null);
  assert.equal(lone.confidence.level, 'low');
  assert.match(lone.summary, /нет данных/);
});

test('every listed event gets consequences and inputs are not mutated', () => {
  const bodies = [
    [explainDossier({ symbol: 'AAPL', events: [event, { id: 'z', type: 'other' }], forecast: null }), (b) => b.events],
    [explainWire({ events: [{ ...event, symbol: 'AAPL', changePct: 1 }] }), (b) => b.events],
    [explainWorld({ events: [{ type: 'other' }], more: [{ type: 'energy', primaryRegion: 'us' }] }), (b) => [...b.events, ...b.more]],
    [explainEconomy({ rows: [], news: { 'BZ=F': [{ title: 'Brent oil slips' }] } }), (b) => b.news['BZ=F']],
  ];
  for (const [body, list] of bodies) for (const item of list(body)) assert.ok(item.consequences?.summary);
  assert.equal(event.consequences, undefined);
  assert.match(companyConsequences(event, {}, 'en').summary, /direction undetermined/);
});

test('outlooks cover every classified event, not only the latest fifteen', () => {
  const DAY = 86_400_000;
  const start = Date.UTC(2026, 0, 5, 14, 30);
  const history = Array.from({ length: 200 }, (_, i) => ({ t: start + i * DAY, c: 100 + Math.sin(i / 3) * 4 + (i % 7), v: 1000 }));
  const events = Array.from({ length: 25 }, (_, i) => ({ id: `e${i}`, type: 'deal', sentiment: 0, time: start + (70 + i * 5) * DAY }));
  const out = computeOutlooks({ history, events }, start + 210 * DAY);
  assert.equal(out.size, 25);
  assert.deepEqual(out.get(events[0]).map((h) => h.h), [1, 5, 20]);
  assert.equal(computeOutlooks({ history, events, only: new Set(['e3']) }, start + 210 * DAY).size, 1);
});
