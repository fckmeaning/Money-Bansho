/**
 * RPC: GetSectorSummary -- reads seeded sector data from Railway seed cache.
 * All external Finnhub/Yahoo Finance calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  GetSectorSummaryRequest,
  GetSectorSummaryResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { readRequiredSeed, SeedUnavailableError } from '../../../_shared/required-seed';
import { fetchLiveQuotes, redisConfigured } from './_yahoo-live';
import sectorsConfig from '../../../../shared/sectors.json';

const SEED_CACHE_KEY = 'market:sectors:v2';

export async function getSectorSummary(
  _ctx: ServerContext,
  _req: GetSectorSummaryRequest,
): Promise<GetSectorSummaryResponse> {
  // No Redis seed (local dev, free demo hosting): sector ETFs straight from Yahoo.
  if (!redisConfigured()) {
    const live = await fetchLiveQuotes(sectorsConfig.sectors.map((s) => s.symbol));
    const sectors = sectorsConfig.sectors.flatMap((s) => {
      const q = live.get(s.symbol);
      return q ? [{ symbol: s.symbol, name: s.name, change: q.change }] : [];
    });
    if (sectors.length === 0) throw new SeedUnavailableError(SEED_CACHE_KEY);
    return { sectors };
  }
  const result = await readRequiredSeed(SEED_CACHE_KEY, value => {
    const data = value as GetSectorSummaryResponse | null;
    return data && Array.isArray(data.sectors) ? data : undefined;
  });
  return result;
}
