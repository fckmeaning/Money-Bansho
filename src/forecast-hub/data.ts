// Data of the forecast section: the same /api/dossier answers the dossier uses (screener and company).
// Nothing is computed from invented values; a missing field stays "no data".
import { fetchDossier } from '../dossier/api';
import { fetchScreenerLite } from '../dossier/bigcharts';
import type { ScreenerLite } from '../dossier/bigcharts';
import type { Evidence, Forecast } from '../dossier/forecast';
import { uiLang } from '../dossier/i18n';
import { loadAnswer, saveAnswer } from '../dossier/persist';
import { isObj, list, num } from '../dossier/quant-parse';

export interface Bar { t: number; o: number | null; h: number | null; l: number | null; c: number }
export interface CompanyData {
  symbol: string; name: string; currency: string; forecast: Forecast | null; bars: Bar[];
  /** Time of the saved answer shown while the sources are unavailable or still loading. */
  savedAt: number | null;
}
export interface Range { low: number; high: number; width: number }
export interface BoardLine {
  symbol: string; name: string; region: string; asOf: number | null;
  ranges: Record<number, Range | null>; annual: number | null; versus: number | null; change: number | null;
}

export const HORIZONS = [1, 5, 20] as const;
const FRESH_MS = 5 * 60_000;
/** A saved answer this recent is shown at once (labelled with its time) while a new one loads. */
const RECENT_MS = 30 * 60_000;

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function remember<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

function barsOf(v: unknown): Bar[] {
  return list(v)
    .filter(isObj)
    .flatMap((b) => {
      const t = num(b.t);
      const c = num(b.c);
      return t === null || c === null ? [] : [{ t, c, o: num(b.o), h: num(b.h), l: num(b.l) }];
    })
    .sort((a, b) => a.t - b.t);
}

export function company(symbol: string): Promise<CompanyData> {
  const key = `hub|${uiLang()}|${symbol}`;
  const load = async (): Promise<CompanyData> => {
    try {
      const dossier = await fetchDossier(symbol, '1y', new AbortController().signal);
      const forecast = (dossier.raw as { forecast?: Forecast | null }).forecast ?? null;
      const data: CompanyData = {
        symbol,
        name: dossier.name,
        currency: dossier.currency,
        forecast: forecast && Array.isArray(forecast.horizons) && forecast.horizons.length ? forecast : null,
        bars: barsOf((dossier.raw as { history?: unknown }).history),
        savedAt: null,
      };
      if (data.forecast) void saveAnswer(key, data);
      return data;
    } catch (error) {
      const saved = await loadAnswer(key);
      if (saved) return { ...(saved.body as CompanyData), savedAt: saved.at };
      throw error;
    }
  };
  return remember(key, async () => {
    const saved = await loadAnswer(key);
    if (!saved || Date.now() - saved.at > RECENT_MS) return load();
    // The next draw gets the new answer.
    void load().then((data) => cache.set(key, { at: Date.now(), value: Promise.resolve(data) }), () => {});
    return { ...(saved.body as CompanyData), savedAt: saved.at };
  });
}

export interface Board { lines: BoardLine[]; raw: ScreenerLite; evidence: Evidence | null }

export function board(): Promise<Board> {
  return remember('board', async () => {
    const raw = await fetchScreenerLite(new AbortController().signal);
    const lines = raw.rows.map((row): BoardLine => {
      const o = isObj(row.outlook) ? row.outlook : null;
      const horizons = list(o?.horizons).filter(isObj);
      const ranges: Record<number, Range | null> = {};
      for (const h of HORIZONS) {
        const found = horizons.find((x) => x.h === h);
        const low = num(found?.low80Pct);
        const high = num(found?.high80Pct);
        ranges[h] = low === null || high === null ? null : { low, high, width: high - low };
      }
      const change = num(o?.change5Pct);
      return {
        symbol: row.symbol, name: row.name, region: row.region, asOf: num(o?.asOf), ranges,
        annual: num(o?.annualPct), versus: num(o?.vsUsual), change: change === null ? null : 1 + change / 100,
      };
    });
    const evidence = isObj(raw.forecastEvidence) && isObj(raw.forecastEvidence.range)
      ? (raw.forecastEvidence as unknown as Evidence)
      : null;
    return { lines, raw, evidence };
  });
}

export const median = (values: (number | null | undefined)[]): number | null => {
  const sorted = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};
