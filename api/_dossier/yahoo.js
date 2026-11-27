// Keyless Yahoo Finance chart and spark endpoints.
import { cached, errorMessage, fetchText } from './util.js';

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

async function yahooJson(path, timeoutMs) {
  let lastError;
  for (const host of HOSTS) {
    try {
      return JSON.parse(await fetchText(host + path, { timeoutMs, headers: { Accept: 'application/json' } }));
    } catch (error) {
      lastError = error;
      if (error.status === 404 || error.status === 400) break;
    }
  }
  throw lastError;
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const round = (value, digits = 4) => (value === null ? null : Number(value.toFixed(digits)));

function marketState(meta, nowMs) {
  const periods = meta.currentTradingPeriod;
  if (!periods) return null;
  const now = nowMs / 1000;
  const inside = (p) => p && now >= p.start && now < p.end;
  if (inside(periods.regular)) return 'REGULAR';
  if (inside(periods.pre)) return 'PRE';
  if (inside(periods.post)) return 'POST';
  return 'CLOSED';
}

export function quoteFrom(meta, history, nowMs = Date.now()) {
  const price = num(meta?.regularMarketPrice);
  if (price === null) return null;
  const asOf = num(meta.regularMarketTime) === null ? null : meta.regularMarketTime * 1000;
  let changePct = num(meta.regularMarketChangePercent);
  let change = null;
  // Previous close = last daily bar on an earlier exchange-local date.
  const offset = (meta.gmtoffset || 0) * 1000;
  const day = (t) => new Date(t + offset).toISOString().slice(0, 10);
  const previous = asOf === null ? null : history.findLast((bar) => day(bar.t) < day(asOf));
  const barPct = previous?.c ? ((price - previous.c) / previous.c) * 100 : null;
  if (changePct !== null && changePct > -100) {
    // Prefer the exact bar difference when it agrees with Yahoo's percentage.
    change = barPct !== null && Math.abs(barPct - changePct) < 0.01
      ? price - previous.c
      : price - price / (1 + changePct / 100);
  } else if (barPct !== null) {
    change = price - previous.c;
    changePct = barPct;
  } else {
    changePct = null;
  }
  return { price, change: round(change), changePct: round(changePct), asOf, marketState: marketState(meta, nowMs) };
}

export function parseChart(body) {
  const result = body?.chart?.result?.[0];
  if (!result?.meta) throw new Error('No chart data');
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const volumes = result.indicators?.quote?.[0]?.volume ?? [];
  const offset = (result.meta.gmtoffset || 0) * 1000;
  const byDay = new Map();
  (result.timestamp ?? []).forEach((seconds, i) => {
    const c = num(closes[i]);
    if (c === null || c <= 0) return;
    const t = seconds * 1000;
    byDay.set(new Date(t + offset).toISOString().slice(0, 10), { t, c: round(c), v: num(volumes[i]) });
  });
  return { meta: result.meta, history: [...byDay.values()].sort((a, b) => a.t - b.t) };
}

/** One year of daily bars plus live quote metadata. */
export function loadChart(symbol, ttlMs = 15_000) {
  return cached(`chart:${symbol}`, ttlMs, async () => parseChart(
    await yahooJson(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`, 9000),
  ), 5 * 60_000);
}

/** Quotes for many symbols; spark accepts at most 20 per request. */
export async function loadBoard(symbols) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 20) chunks.push(symbols.slice(i, i + 20));
  const errors = [];
  const bySymbol = new Map();
  await Promise.all(chunks.map(async (chunk, index) => {
    try {
      const { value, staleError } = await cached(`spark:${chunk.join(',')}`, 15_000, async () => {
        const body = await yahooJson(
          `/v7/finance/spark?symbols=${chunk.map(encodeURIComponent).join(',')}&range=1d&interval=1d`,
          10_000,
        );
        const rows = body?.spark?.result;
        if (!Array.isArray(rows)) throw new Error('No spark data');
        return rows.flatMap((row) => {
          const quote = quoteFrom(row.response?.[0]?.meta, []);
          return quote ? [{ symbol: row.symbol, price: quote.price, changePct: quote.changePct }] : [];
        });
      }, 5 * 60_000);
      if (staleError) errors.push({ source: `yahoo:board:${index + 1}`, message: staleError });
      for (const row of value) bySymbol.set(row.symbol, row);
    } catch (error) {
      errors.push({ source: `yahoo:board:${index + 1}`, message: errorMessage(error) });
    }
  }));
  const quotes = symbols.flatMap((symbol) => (bySymbol.has(symbol) ? [bySymbol.get(symbol)] : []));
  const missing = symbols.filter((symbol) => !bySymbol.has(symbol));
  if (missing.length && quotes.length) {
    errors.push({ source: 'yahoo:board', message: `No quote for ${missing.join(', ')}`.slice(0, 200) });
  }
  return { quotes, errors };
}
