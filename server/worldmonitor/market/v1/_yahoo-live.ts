/**
 * Keyless live quotes for the market RPCs when no Redis seed exists.
 *
 * ListMarketQuotes, ListCommodityQuotes, GetSectorSummary and ListGulfQuotes
 * normally answer from snapshots that Railway seeders write into Redis. A
 * deployment without Redis (local dev, a free Vercel demo) therefore showed
 * every market panel empty. This module is the no-key path for that case: it
 * reads the public Yahoo Finance chart endpoint directly and keeps results in
 * a small per-process cache, so panel refreshes do not fan out to Yahoo.
 *
 * It is used ONLY when Redis credentials are absent (`redisConfigured()`).
 * With Redis configured the seed-first behaviour is unchanged. A symbol that
 * Yahoo does not answer stays absent (callers report it as unavailable); no
 * value is ever invented or carried over past `STALE_MAX_MS`.
 */

import { CHROME_UA } from '../../../_shared/constants';

export interface LiveQuote {
  price: number;
  /** Percent change versus the previous session close. */
  change: number;
  /** Daily closes, oldest first (at most `SPARK_POINTS`). */
  sparkline: number[];
}

const FRESH_MS = 60_000;
const MISS_MS = 30_000;
const STALE_MAX_MS = 15 * 60_000;
const SYMBOL_TIMEOUT_MS = 6_000;
const LANES = 8;
const SPARK_POINTS = 22;

interface Entry {
  at: number;
  quote: LiveQuote | null;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<LiveQuote | null>>();

/** True when seeds can exist (Upstash REST credentials are set). */
export function redisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

interface YahooChart {
  chart?: {
    result?: Array<{
      meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number };
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }> | null;
  };
}

export function parseYahooChart(json: unknown): LiveQuote | null {
  const result = (json as YahooChart)?.chart?.result?.[0];
  if (!result) return null;
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(isFiniteNumber);
  const price = isFiniteNumber(result.meta?.regularMarketPrice)
    ? result.meta.regularMarketPrice
    : closes[closes.length - 1];
  if (!isFiniteNumber(price) || price <= 0) return null;
  // The last bar is the current (or last completed) session, so the previous
  // close is the bar before it. With a single bar fall back to Yahoo's own field.
  const prev = closes.length >= 2
    ? closes[closes.length - 2]
    : (result.meta?.chartPreviousClose ?? result.meta?.previousClose);
  const change = isFiniteNumber(prev) && prev > 0 ? ((price - prev) / prev) * 100 : 0;
  return { price, change, sparkline: closes.slice(-SPARK_POINTS) };
}

async function fetchOne(symbol: string): Promise<LiveQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(SYMBOL_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`yahoo ${resp.status}`);
  return parseYahooChart(await resp.json());
}

async function liveQuote(symbol: string): Promise<LiveQuote | null> {
  const now = Date.now();
  const hit = cache.get(symbol);
  if (hit && now - hit.at < (hit.quote ? FRESH_MS : MISS_MS)) return hit.quote;
  const pending = inflight.get(symbol);
  if (pending) return pending;
  const task = fetchOne(symbol)
    .then((quote) => {
      cache.set(symbol, { at: Date.now(), quote });
      return quote;
    })
    .catch((): LiveQuote | null => {
      // Transient failure: serve the last good value for a few minutes, never older.
      if (hit?.quote && now - hit.at < STALE_MAX_MS) return hit.quote;
      cache.set(symbol, { at: Date.now(), quote: null });
      return null;
    })
    .finally(() => {
      inflight.delete(symbol);
    });
  inflight.set(symbol, task);
  return task;
}

/**
 * Fetch quotes for the given Yahoo-notation symbols. Resolves with the symbols
 * that produced a quote; the rest are simply absent.
 */
export async function fetchLiveQuotes(symbols: string[]): Promise<Map<string, LiveQuote>> {
  const unique = [...new Set(symbols)];
  const out = new Map<string, LiveQuote>();
  let next = 0;
  const lanes = Math.min(LANES, unique.length);
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < unique.length) {
        const symbol = unique[next++]!;
        const quote = await liveQuote(symbol);
        if (quote) out.set(symbol, quote);
      }
    }),
  );
  return out;
}
