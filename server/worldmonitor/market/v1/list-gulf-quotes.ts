/**
 * RPC: ListGulfQuotes -- reads seeded GCC market data from Railway seed cache.
 * All external Yahoo Finance calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  ListGulfQuotesRequest,
  ListGulfQuotesResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { fetchLiveQuotes, redisConfigured } from './_yahoo-live';
import gulfConfig from '../../../../shared/gulf.json';

const SEED_CACHE_KEY = 'market:gulf-quotes:v1';

export async function listGulfQuotes(
  ctx: ServerContext,
  _req: ListGulfQuotesRequest,
): Promise<ListGulfQuotesResponse> {
  // No Redis seed (local dev, free demo hosting): GCC indices/ETFs straight from Yahoo.
  if (!redisConfigured()) {
    const live = await fetchLiveQuotes(gulfConfig.symbols.map((s) => s.symbol));
    const quotes = gulfConfig.symbols.flatMap((s) => {
      const q = live.get(s.symbol);
      return q
        ? [{ symbol: s.symbol, name: s.name, flag: s.flag, country: s.country, type: s.type, price: q.price, change: q.change, sparkline: q.sparkline }]
        : [];
    });
    return quotes.length > 0 ? { quotes, rateLimited: false } : markNoStoreFallbackResponse(ctx.request, { quotes: [], rateLimited: false });
  }
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as ListGulfQuotesResponse | null;
    return Array.isArray(seedData?.quotes) ? seedData : markNoStoreFallbackResponse(ctx.request, { quotes: [], rateLimited: false });
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { quotes: [], rateLimited: false });
  }
}
