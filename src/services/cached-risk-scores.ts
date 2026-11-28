// Country scores of the whole dashboard (map shading, lists, search, share cards). They are
// the Money Bansho instability index and nothing else: a country without an index has no
// score. The inherited upstream index is not requested.
import type { CountryScore } from './country-instability';
import { setHasCachedScores } from './country-instability';
import { loadCountryIndex, peekCountryIndex, countryName, indexLang } from './bansho-country-index';
import type { IndexPayload } from './bansho-country-index';
import { getCurrentLanguage } from './i18n';

export interface CachedRiskScores {
  cii: CountryScore[];
  computedAt: string | null;
  cached: boolean;
  degraded: boolean;
  stale: boolean;
}

/** Colour band of the map and lists: neutral below 60, accent from 60, red only from 90. */
function getScoreLevel(score: number): CountryScore['level'] {
  if (score >= 90) return 'high';
  if (score >= 60) return 'elevated';
  return 'normal';
}

export function isElevatedCiiScore(score: number): boolean {
  return getScoreLevel(score) !== 'normal';
}

export function toRiskScores(payload: IndexPayload): CachedRiskScores {
  const lang = indexLang(getCurrentLanguage());
  const updated = new Date(payload.updatedAt);
  const cii = payload.countries.flatMap((country): CountryScore[] => (country.index === null ? [] : [{
    code: country.code,
    name: countryName(country, lang),
    score: Math.round(country.index * 10) / 10,
    level: getScoreLevel(country.index),
    low: country.low,
    high: country.high,
    coverage: country.coverage,
    components: country.components.map(({ id, score }) => ({ id, score })),
    lastUpdated: updated,
  }]));
  return {
    cii: cii.sort((a, b) => b.score - a.score),
    computedAt: updated.toISOString(),
    cached: true,
    degraded: payload.degraded === true,
    stale: false,
  };
}

// One object per payload, so callers can detect a change by identity.
let converted: { payload: IndexPayload; lang: string; scores: CachedRiskScores } | null = null;

function convert(payload: IndexPayload): CachedRiskScores {
  const lang = getCurrentLanguage();
  if (converted?.payload !== payload || converted.lang !== lang) {
    converted = { payload, lang, scores: toRiskScores(payload) };
  }
  return converted.scores;
}

export async function fetchCachedRiskScores(signal?: AbortSignal): Promise<CachedRiskScores | null> {
  let payload: IndexPayload;
  try {
    payload = await loadCountryIndex(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return getCachedScores();
  }
  const scores = convert(payload);
  if (!scores.cii.length) return null;
  setHasCachedScores(true);
  return scores;
}

export function getCachedScores(): CachedRiskScores | null {
  const payload = peekCountryIndex();
  return payload ? convert(payload) : null;
}

export function hasCachedScores(): boolean {
  return peekCountryIndex() !== null;
}

export function normalizeCiiCountryCode(code: string): string {
  return code.toUpperCase();
}

export function getCachedCountryScore(code: string): CountryScore | null {
  const normalizedCode = normalizeCiiCountryCode(code);
  return getCachedScores()?.cii.find((score) => score.code === normalizedCode) ?? null;
}

export function getCachedCountryScoreValue(code: string): number | null {
  return getCachedCountryScore(code)?.score ?? null;
}

export function getCachedCountryScores(): CountryScore[] {
  return getCachedScores()?.cii ?? [];
}
