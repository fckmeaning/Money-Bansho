// Significant moves across the economy for the dashboard's first screen:
// daily changes of a fixed instrument list, ranked by how unusual they are
// against each instrument's own volatility. Keyless Yahoo spark data only.
import { cached, errorMessage, fetchText, pool } from './util.js';
import { moveSince, parseFeed } from './world.js';
import { loadSparkSeries } from './yahoo.js';

const DAY = 86_400_000;
export const SERIES_POINTS = 126;
export const NEWS_MOVERS = 6;

const group = (id, rows) => rows.map(([symbol, name, query]) => ({ symbol, name, query: query ?? name, group: id }));

export const INSTRUMENTS = [
  ...group('index', [
    ['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq'], ['^DJI', 'Dow Jones'], ['^RUT', 'Russell 2000'],
    ['^STOXX50E', 'Euro Stoxx 50'], ['^GDAXI', 'DAX'], ['^FTSE', 'FTSE 100'], ['^N225', 'Nikkei 225'],
    ['^HSI', 'Hang Seng'], ['000001.SS', 'Shanghai Composite'], ['^TA125.TA', 'TA-125'], ['^VIX', 'VIX', 'VIX volatility index'],
  ]),
  ...group('fx', [
    ['DX-Y.NYB', 'Индекс доллара', 'US dollar index'], ['EURUSD=X', 'EUR/USD'], ['GBPUSD=X', 'GBP/USD'], ['JPY=X', 'USD/JPY'],
    ['CNY=X', 'USD/CNY', 'yuan dollar'], ['CHF=X', 'USD/CHF', 'Swiss franc'], ['RUB=X', 'USD/RUB', 'Russian rouble'],
    ['KZT=X', 'USD/KZT', 'Kazakhstan tenge'], ['TRY=X', 'USD/TRY', 'Turkish lira'], ['INR=X', 'USD/INR', 'Indian rupee'],
    ['ILS=X', 'USD/ILS', 'Israeli shekel'],
  ]),
  ...group('commodity', [
    ['BZ=F', 'Нефть Brent', 'Brent crude oil'], ['CL=F', 'Нефть WTI', 'WTI crude oil'], ['NG=F', 'Газ (Henry Hub)', 'natural gas prices'],
    ['GC=F', 'Золото', 'gold price'], ['SI=F', 'Серебро', 'silver price'], ['HG=F', 'Медь', 'copper price'],
    ['PL=F', 'Платина', 'platinum price'], ['ZW=F', 'Пшеница', 'wheat futures'], ['ZC=F', 'Кукуруза', 'corn futures'],
  ]),
  // Yahoo quotes these four in percent; their moves are measured in basis points.
  ...group('yield', [
    ['^IRX', 'UST 3М', 'Treasury bill yields'], ['^FVX', 'UST 5Л', '5-year Treasury yield'],
    ['^TNX', 'UST 10Л', '10-year Treasury yield'], ['^TYX', 'UST 30Л', '30-year Treasury yield'],
  ]),
  ...group('crypto', [
    ['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum'], ['SOL-USD', 'Solana'], ['XRP-USD', 'XRP'], ['BNB-USD', 'BNB'],
  ]),
  ...group('stock', [
    ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['GOOGL', 'Alphabet'], ['AMZN', 'Amazon'],
    ['META', 'Meta Platforms'], ['TSLA', 'Tesla'], ['AVGO', 'Broadcom'], ['JPM', 'JPMorgan'], ['XOM', 'ExxonMobil'],
    ['LLY', 'Eli Lilly'], ['TSM', 'TSMC'], ['ASML', 'ASML'], ['BABA', 'Alibaba'], ['0700.HK', 'Tencent'], ['TEVA', 'Teva'],
  ]),
];

const round = (value, digits) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

/** One table row from daily bars; null when the series is too short to say anything. */
export function economyRow(instrument, chart, nowMs) {
  const bars = chart?.history ?? [];
  if (bars.length < 8) return null;
  const closes = bars.map((b) => b.c);
  const n = closes.length;
  const absolute = instrument.group === 'yield';
  const since = (sessions) => (n > sessions ? moveSince(closes, n - 1 - sessions, absolute) : null);
  // Yields: percentage points to basis points. Everything else: fraction to percent.
  const scaled = (move) => (move ? round(move.change * 100, absolute ? 1 : 2) : null);
  const day = since(1);
  const quoted = chart.meta?.regularMarketTime;
  const asOf = Number.isFinite(quoted) ? quoted * 1000 : bars[n - 1].t;
  return {
    symbol: instrument.symbol,
    name: instrument.name,
    group: instrument.group,
    unit: absolute ? 'bp' : 'pct',
    price: round(closes[n - 1], 4),
    change1d: scaled(day),
    change5d: scaled(since(5)),
    change1m: scaled(since(21)),
    z1d: round(day?.z ?? null, 2),
    asOf,
    // A quote that has not moved for four days is history, not today's move.
    stale: nowMs - asOf > 4 * DAY,
    series: bars.slice(-SERIES_POINTS).map((b) => [b.t, b.c]),
  };
}

/** Fresh rows with a z-score, the most unusual first. */
export function rankMovers(rows) {
  return rows
    .filter((row) => !row.stale && row.z1d !== null)
    .sort((a, b) => Math.abs(b.z1d) - Math.abs(a.z1d));
}

const GENERIC_WORDS = new Set(['index', 'price', 'prices', 'futures', 'dollar', 'yield', 'yields', 'bill', 'composite', 'platforms']);

/** A search result counts only when its title names the instrument itself. */
export function namesInstrument(title, query) {
  const words = query.split(/\s+/).filter((w) => w.length > 2 && !GENERIC_WORDS.has(w.toLowerCase()));
  const text = title.toLowerCase();
  return (words.length ? words : [query]).some((word) => text.includes(word.toLowerCase()));
}

function loadHeadlines(instrument, nowMs) {
  const query = `${instrument.query} when:3d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return cached(`econnews:${instrument.symbol}`, 10 * 60_000, async () => (
    parseFeed(await fetchText(url, { timeoutMs: 6000 }), nowMs)
      .filter((item) => namesInstrument(item.title, instrument.query))
      .sort((a, b) => b.time - a.time)
      .slice(0, 3)
  ), 60 * 60_000);
}

export async function buildEconomy(nowMs = Date.now()) {
  const { series, errors } = await loadSparkSeries(INSTRUMENTS.map((i) => i.symbol));
  const rows = INSTRUMENTS.flatMap((instrument) => {
    const row = economyRow(instrument, series.get(instrument.symbol), nowMs);
    return row ? [row] : [];
  });
  const movers = rankMovers(rows).slice(0, NEWS_MOVERS);
  const news = {};
  await pool(movers, NEWS_MOVERS, async (mover) => {
    const instrument = INSTRUMENTS.find((i) => i.symbol === mover.symbol);
    try {
      news[mover.symbol] = (await loadHeadlines(instrument, nowMs)).value;
    } catch (error) {
      errors.push({ source: `news:${mover.symbol}`, message: errorMessage(error) });
    }
  });
  return {
    updatedAt: nowMs,
    asked: INSTRUMENTS.length,
    rows,
    movers: movers.map((m) => m.symbol),
    news,
    errors,
  };
}
