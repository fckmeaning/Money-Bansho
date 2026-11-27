import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDate, parseChart, quoteFrom } from './yahoo.js';

const at = (iso) => Date.parse(iso);
const seconds = (iso) => at(iso) / 1000;

/** A Yahoo chart body: one entry per [timestamp, close]. */
function body(gmtoffset, rows, meta = {}) {
  return {
    chart: {
      result: [
        {
          meta: { gmtoffset, regularMarketPrice: rows.at(-1)[1], ...meta },
          timestamp: rows.map(([iso]) => seconds(iso)),
          indicators: { quote: [{ close: rows.map((r) => r[1]), open: [], high: [], low: [], volume: [] }] },
        },
      ],
    },
  };
}

// Daily bars carry the session OPEN. The open of the 27th is, in UTC, the 26th at 23:00 for
// Sydney (UTC+11) but the 27th itself for Tokyo and Hong Kong, so the UTC date is not the
// trading day everywhere. The live bar of a running session carries the last trade time.
const EXCHANGES = [
  {
    name: 'ASX (.AX, AEDT)',
    gmtoffset: 39600,
    opens: ['2026-11-24T23:00:00Z', '2026-11-25T23:00:00Z', '2026-11-26T23:00:00Z'],
    live: '2026-11-27T04:30:00Z',
    dates: ['2026-11-25', '2026-11-26', '2026-11-27'],
  },
  {
    name: 'Tokyo (.T, JST)',
    gmtoffset: 32400,
    opens: ['2026-11-25T00:00:00Z', '2026-11-26T00:00:00Z', '2026-11-27T00:00:00Z'],
    live: '2026-11-27T05:00:00Z',
    dates: ['2026-11-25', '2026-11-26', '2026-11-27'],
  },
  {
    name: 'Hong Kong (.HK, HKT)',
    gmtoffset: 28800,
    opens: ['2026-11-25T01:30:00Z', '2026-11-26T01:30:00Z', '2026-11-27T01:30:00Z'],
    live: '2026-11-27T07:00:00Z',
    dates: ['2026-11-25', '2026-11-26', '2026-11-27'],
  },
  {
    name: 'New York (EST)',
    gmtoffset: -18000,
    opens: ['2026-11-25T14:30:00Z', '2026-11-26T14:30:00Z', '2026-11-27T14:30:00Z'],
    live: '2026-11-27T19:00:00Z',
    dates: ['2026-11-25', '2026-11-26', '2026-11-27'],
  },
];

test('localDate is the exchange-local trading day of a bar timestamp', () => {
  for (const x of EXCHANGES) {
    x.opens.forEach((iso, i) => assert.equal(localDate(at(iso), x.gmtoffset), x.dates[i], `${x.name} ${iso}`));
    assert.equal(localDate(at(x.live), x.gmtoffset), x.dates[2], `${x.name} live bar`);
  }
  // Without an offset the UTC date is used.
  assert.equal(localDate(at('2026-11-26T23:00:00Z'), undefined), '2026-11-26');
  assert.equal(localDate(at('2026-11-26T23:00:00Z'), null), '2026-11-26');
});

test('parseChart keeps one bar per local trading day and lets the live bar replace the open stamp', () => {
  for (const x of EXCHANGES) {
    const rows = [...x.opens.map((iso, i) => [iso, 100 + i]), [x.live, 103]];
    const { history } = parseChart(body(x.gmtoffset, rows));
    assert.equal(history.length, 3, `${x.name}: the live bar must replace today's open bar, not add a fourth`);
    assert.deepEqual(history.map((bar) => bar.c), [100, 101, 103], x.name);
    assert.equal(history.at(-1).t, at(x.live), x.name);
    assert.deepEqual(history.map((bar) => localDate(bar.t, x.gmtoffset)), x.dates, x.name);
  }
});

test('previous close is the last bar of an earlier local day, never today\'s own open-stamped bar', () => {
  for (const x of EXCHANGES) {
    const history = x.opens.map((iso, i) => ({ t: at(iso), c: 100 + i }));
    const meta = { regularMarketPrice: 104, regularMarketTime: seconds(x.live), gmtoffset: x.gmtoffset };
    const quote = quoteFrom(meta, history, at(x.live));
    // History ends with today's bar (102), stamped at the open: the reference is yesterday's 101.
    assert.equal(quote.change, 3, x.name);
    assert.equal(quote.changePct, Number(((3 / 101) * 100).toFixed(4)), x.name);
  }
});

test('a body with a corrupt timestamp skips that bar instead of failing the whole chart', () => {
  const parsed = body(39600, [['2026-11-25T23:00:00Z', 100], ['2026-11-26T23:00:00Z', 101]]);
  parsed.chart.result[0].timestamp[0] = 'not a number';
  const { history } = parseChart(parsed);
  assert.equal(history.length, 1);
  assert.equal(history[0].c, 101);
});
