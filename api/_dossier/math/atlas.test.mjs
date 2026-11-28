import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_COLUMNS,
  atlasFrom,
  BIN_EDGES,
  currencyUnit,
  distribution,
  histogram,
  regionIndices,
  riskValues,
  volumeValues,
} from './atlas.js';
import { coMentionGraph, companiesIn } from './comentions.js';
import { seededRandom, normalSample } from './stats.js';

const DAY = 86_400_000;
const FIRST = 20_000;
const NOW = (FIRST + 400) * DAY;

/** Weekday bars of a seeded random walk that shares a common factor. */
function bars(seed, common, load = 0.7, sessions = 250) {
  const random = seededRandom(seed);
  const out = [];
  let price = 100;
  let day = FIRST;
  for (let i = 0; i < sessions; i += 1) {
    while ((day + 4) % 7 === 0 || (day + 4) % 7 === 6) day += 1;
    price *= Math.exp(0.01 * (load * common[i] + Math.sqrt(1 - load * load) * normalSample(random)));
    out.push({ t: day * DAY + 14.5 * 3_600_000, day, c: price, v: 1000 + i });
    day += 1;
  }
  return out;
}

const factor = (() => {
  const random = seededRandom(99);
  return Array.from({ length: 300 }, () => normalSample(random));
})();
const entry = (history, currency = 'USD') => ({ meta: { currency }, history });
const company = (symbol, region) => ({ symbol, name: symbol, aliases: [symbol], country: 'US', region, benchmark: 'IDX' });

describe('company risk and liquidity', () => {
  it('computes tail risk from enough sessions and null otherwise', () => {
    const values = riskValues(bars(1, factor), bars(2, factor), NOW);
    assert.ok(values.var95 > 0 && values.es95 >= values.var95);
    assert.ok(values.var99 >= values.var95);
    assert.ok(values.r2 >= 0 && values.r2 <= 1);
    assert.ok(values.worstDay < 0 && values.bestDay > 0);
    const short = riskValues(bars(1, factor, 0.7, 30), bars(2, factor, 0.7, 30), NOW);
    for (const [id, value] of Object.entries(short)) assert.equal(value, null, id);
  });

  it('converts turnover with the exchange rate and the minor unit', () => {
    const history = bars(3, factor, 0.5, 40).map((b) => ({ ...b, c: 200, v: 500 }));
    const values = volumeValues(history, NOW, 4, 0.01);
    assert.equal(values.turnoverUsd, (200 * 0.01 * 500) / 4);
    assert.equal(values.relVolume, 1);
    assert.equal(values.amihud, 0);
    assert.equal(volumeValues(history, NOW, null).turnoverUsd, null);
    assert.equal(volumeValues([], NOW, 1).volume20, null);
    assert.deepEqual(currencyUnit('ILA'), ['ILS', 0.01]);
    assert.deepEqual(currencyUnit('HKD'), ['HKD', 1]);
  });

  it('bins returns and keeps the tails in the outer bins', () => {
    const counts = histogram([-50, -0.1, 0, 0.1, 50]);
    assert.equal(counts.length, BIN_EDGES.length - 1);
    assert.equal(counts[0], 1);
    assert.equal(counts[counts.length - 1], 1);
    assert.equal(counts.reduce((a, b) => a + b, 0), 5);
    assert.equal(distribution([1, 2, 3]).counts, null);
  });
});

describe('region index', () => {
  it('averages growth from a common start and drops short histories', () => {
    const days = Array.from({ length: 80 }, (_, i) => FIRST + i);
    const member = (symbol, step, from = 0) => ({
      symbol,
      region: 'us',
      days: days.slice(from),
      closes: days.slice(from).map((_, i) => 10 + i * step),
    });
    const result = regionIndices([member('A', 0), member('B', 1), member('C', 1, 40)]);
    assert.equal(result.series.us[0], 100);
    assert.equal(result.series.us.at(-1), (100 * (1 + 89 / 10)) / 2);
    assert.deepEqual(result.excluded, ['C']);
  });
});

describe('atlas assembly', () => {
  const list = [company('AAA', 'us'), company('BBB', 'us'), company('CCC', 'china'), company('GONE', 'china')];
  const series = new Map([
    ['AAA', entry(bars(11, factor, 0.9))],
    ['BBB', entry(bars(12, factor, 0.9))],
    ['CCC', entry(bars(13, factor, 0), 'HKD')],
    ['IDX', entry(bars(14, factor, 0.9))],
  ]);
  const last = series.get('AAA').history.at(-1).t;
  const atlas = atlasFrom(list, series, new Map([['AAA', series.get('AAA')]]), new Map([['HKD', 7.8]]), last + DAY);

  it('has one row per company with data and reports the rest', () => {
    assert.deepEqual(atlas.symbols, ['AAA', 'BBB', 'CCC']);
    assert.ok(atlas.errors.some((e) => e.message.includes('GONE')));
    assert.ok(atlas.errors.some((e) => e.source === 'yahoo:volume'));
    for (const row of atlas.rows) assert.deepEqual(Object.keys(row.values), ALL_COLUMNS.map((c) => c.id));
    assert.ok(atlas.rows[0].values.turnoverUsd > 0);
    assert.equal(atlas.rows[1].values.turnoverUsd, null);
  });

  it('links the correlated pair and clusters it', () => {
    assert.ok(atlas.correlation.daily[0][1] > 0.6);
    assert.ok(Math.abs(atlas.correlation.daily[0][2]) < 0.3);
    const level = atlas.network.daily.levels.find((l) => l.threshold === 0.5);
    assert.deepEqual(level.metrics.degree, [1, 1, 0]);
    assert.equal(atlas.network.daily.mst.edges.length, 2);
    const { order } = atlas.clusters.daily;
    assert.equal(Math.abs(order.indexOf(0) - order.indexOf(1)), 1);
    assert.deepEqual(atlas.regionCorrelation.regions, ['us', 'china']);
    assert.equal(atlas.regionCorrelation.daily[1][1], null);
  });
});

describe('co-mentions', () => {
  const list = [
    { symbol: 'NVDA', name: 'Nvidia', aliases: ['Nvidia'] },
    { symbol: 'INTC', name: 'Intel', aliases: ['Intel', '英特尔'] },
    { symbol: '2330.TW', name: 'TSMC', aliases: ['TSMC', '台积电'] },
  ];
  const item = (title, n) => ({ title, url: `https://example.com/${n}`, source: 'test', time: 1_000_000 + n });

  it('ignores a lower-case common word', () => {
    assert.deepEqual(companiesIn('US intel says nothing about Nvidia', list), ['NVDA']);
    assert.deepEqual(companiesIn('Intel and TSMC talk', list), ['INTC', '2330.TW']);
    assert.deepEqual(companiesIn('台积电与英特尔合作', list), ['INTC', '2330.TW']);
  });

  it('counts stories once, weights long lists less and gives association measures', () => {
    const graph = coMentionGraph([
      item('Nvidia and TSMC expand chip packaging plans in Arizona', 1),
      item('Nvidia and TSMC expand chip packaging plans in Arizona today', 2),
      item('Nvidia, Intel, TSMC: three chip stocks to watch', 3),
      item('Intel names a new finance chief', 4),
    ], list);
    assert.equal(graph.stories, 3);
    assert.equal(graph.linkingStories, 2);
    assert.deepEqual(graph.mentions, [2, 2, 2]);
    const main = graph.edges[0];
    assert.deepEqual([graph.symbols[main.a], graph.symbols[main.b]], ['NVDA', '2330.TW']);
    assert.equal(main.count, 2);
    assert.equal(main.weight, 1.5);
    assert.equal(main.jaccard, 1);
    assert.equal(main.lift, 1.5);
    assert.equal(main.items.find((i) => i.copies === 2).title, 'Nvidia and TSMC expand chip packaging plans in Arizona');
    assert.deepEqual(graph.network.levels.map((l) => l.metrics.summary.edges), [3, 1, 0, 0]);
  });

  it('is empty without headlines', () => {
    const graph = coMentionGraph([], list);
    assert.deepEqual(graph.edges, []);
    assert.equal(graph.stories, 0);
  });
});
