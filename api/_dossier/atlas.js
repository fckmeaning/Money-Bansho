// Loads what the market atlas needs from keyless Yahoo endpoints: one year of
// closes (shared with the screener), three months of volume and exchange rates.
import companies from './companies.js';
import { atlasFrom, currencyUnit } from './math/atlas.js';
import { cached, errorMessage, pool } from './util.js';
import { loadSparkSeries, parseChart, yahooJson } from './yahoo.js';

const VOLUME_BUDGET_MS = 11_000;
const VOLUME_TIMEOUT_MS = 5000;
const VOLUME_TTL_MS = 5 * 60_000;

/** Daily bars with volume for every symbol; whatever has not answered in time is absent. */
async function loadVolumes(symbols) {
  const out = new Map();
  const deadline = Date.now() + VOLUME_BUDGET_MS;
  const work = pool(symbols, 16, async (symbol) => {
    const left = deadline - Date.now();
    if (left < 800) return;
    try {
      const { value } = await cached(`volume:${symbol}`, VOLUME_TTL_MS, async () => parseChart(
        await yahooJson(
          `/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`,
          Math.min(VOLUME_TIMEOUT_MS, left),
        ),
      ), 60 * 60_000);
      out.set(symbol, value);
    } catch {
      // The company is listed in `errors` as having no volume history.
    }
  });
  let timer;
  await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, VOLUME_BUDGET_MS); })]);
  clearTimeout(timer);
  return out;
}

/** Currency units per US dollar, from the latest Yahoo quote of `XXX=X`. */
export function ratesFrom(series) {
  const rates = new Map();
  for (const [symbol, { meta, history }] of series) {
    const rate = meta?.regularMarketPrice ?? history?.[history.length - 1]?.c;
    if (symbol.endsWith('=X') && rate > 0) rates.set(symbol.slice(0, -2), rate);
  }
  return rates;
}

export async function buildAtlas(nowMs = Date.now(), list = companies) {
  // The same list and order as the screener, so that both share the cached requests.
  const symbols = [...new Set([...list.map((c) => c.symbol), ...list.map((c) => c.benchmark)])];
  const volumesLoading = loadVolumes(list.map((c) => c.symbol));
  const { series, errors } = await loadSparkSeries(symbols);
  const currencies = [...new Set(list.map((c) => currencyUnit(series.get(c.symbol)?.meta?.currency)[0]))]
    .filter((code) => code && code !== 'USD');
  let rates = new Map();
  try {
    const fx = await loadSparkSeries(currencies.map((code) => `${code}=X`), 5 * 60_000);
    rates = ratesFrom(fx.series);
    errors.push(...fx.errors);
  } catch (error) {
    errors.push({ source: 'yahoo:fx', message: errorMessage(error) });
  }
  const atlas = atlasFrom(list, series, await volumesLoading, rates, nowMs);
  return { updatedAt: Date.now(), ...atlas, errors: [...errors, ...atlas.errors] };
}
