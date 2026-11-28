// The Money Bansho country instability index on the client: the single source of every
// country score shown on the dashboard. Data: /api/dossier?view=instability
// (math: api/_dossier/math/instability.js, docs/math/instability.md).
import { fetchBanshoDashboardData } from './bansho-dashboard-data';

export interface IndexComponent {
  id: string;
  score: number | null;
  z: number | null;
  raw: { value: number; unit: string } | null;
  weight: number | null;
  contribution: number | null;
  reason: string | null;
  reasonEn: string | null;
}

export interface MarketInput {
  kind: 'market';
  x: number;
  median: number;
  scale: number;
  meanDeviation: boolean;
  observations: number;
  from: string;
  to: string;
  symbol: string;
  asOf: string;
}
export interface VolumeInput {
  kind: 'volume';
  observed: number;
  expected: number;
  variance: number;
  zRaw: number;
  phi: number;
  mentions: number;
  comparable: number;
  recent: number;
}
export interface ToneInput {
  kind: 'tone';
  share: number;
  effective: number;
  pooled: number;
  strength: number;
  shrunk: number;
  centre: number;
  scale: number;
  mentions: number;
  negative: number;
}
export type IndexInput = MarketInput | VolumeInput | ToneInput;

/** Arrays follow `ids`; the fields after `published` exist only when it is true. */
export interface AggregateProof {
  ids: string[];
  absent: string[];
  z: number[];
  soft: number[];
  scores: number[];
  base: number[];
  coverage: number;
  published: boolean;
  rowSums: number[];
  weights: number[];
  R: number[][];
  precision: number[][];
  identityFallback: boolean;
  point: number[];
  gradient: number[];
  sweeps: number;
  distance: number;
  powerMean: number;
  stress: number;
  shift: number;
  q: number;
  sensitivity: {
    derivative: number[];
    anyWeights: [number, number];
    delta: number;
    range: [number, number];
    leaveOneOut: (number | null)[];
  };
}

export interface CountryPrior { mean: number; tau2: number; countries: number }
export interface PosteriorProof {
  theta: number;
  sigma: number;
  draws: number;
  coverage: number;
  prior: CountryPrior | null;
  variance: number;
  reliability: number;
  mean: number;
  half: number;
  index: number;
  low: number;
  high: number;
}

export interface VolatilityModel { type: string; alpha?: number; beta?: number; nu?: number; lambda?: number }
export interface IndexInstrument {
  symbol: string | null;
  name: string | null;
  asOf: string | null;
  reason: string | null;
  reasonEn: string | null;
  model: VolatilityModel | null;
}
export interface IndexHeadline { title: string; titleRu?: string; url: string; source: string; time: number; negative: boolean }

export interface IndexCountry {
  code: string;
  name: string;
  region: string;
  rank: number | null;
  index: number | null;
  low: number | null;
  high: number | null;
  coverage: number;
  aggregate: number | null;
  shrinkage: number | null;
  reliability: number | null;
  confidence: string | null;
  reason: string | null;
  reasonEn: string | null;
  marketChange5: number | null;
  components: IndexComponent[];
  proof: { inputs: Record<string, IndexInput>; aggregate: AggregateProof; posterior: PosteriorProof | null };
  newsDates: [number, number] | null;
  equity: IndexInstrument;
  fx: IndexInstrument;
  news: { mentions: number; recent: number; negative: number };
  headlines: IndexHeadline[];
  history: [string, number][];
}

export interface IndexDefinition { id: string; group: string; weight: number; label: string }
export interface GdeltContext { code: string; series: [string, number][]; z: number | null; reason: string | null }

export interface IndexPayload {
  countries: IndexCountry[];
  regions: { name: string; index: number | null; countries: string[] }[];
  components: IndexDefinition[];
  updatedAt: number;
  sources: { feeds: number; feedsOk: number; symbols: number; symbolsOk: number };
  method: {
    newsHeadlines: number;
    newsWindowHours: number;
    params: {
      power: number; beta: number; softLimit: number; minCoverage: number; draws: number;
      referenceWindow: number; toneStrength: number;
    };
    prior: CountryPrior | null;
    correlation: { matrix: number[][]; marketShrinkage: number | null; newsShrinkage: number | null };
  };
  gdelt: GdeltContext | null;
  degraded?: boolean;
}

export const INDEX_QUERY = 'view=instability&tl=ru';
export const INDEX_POLL_MS = 5 * 60_000;

let latest: { payload: IndexPayload; at: number } | null = null;

/** Keeps a payload any surface has received, so the others can read it at once. */
export function rememberCountryIndex(payload: IndexPayload): void {
  latest = { payload, at: Date.now() };
}

export const peekCountryIndex = (): IndexPayload | null => latest?.payload ?? null;

/** The last answer while it is younger than the polling interval, else a new one. */
export async function loadCountryIndex(signal?: AbortSignal): Promise<IndexPayload> {
  if (latest && Date.now() - latest.at < INDEX_POLL_MS) return latest.payload;
  const payload = await fetchBanshoDashboardData<IndexPayload>(INDEX_QUERY, signal);
  if (!Array.isArray(payload?.countries) || !payload.countries.every((c) => c.proof)) {
    throw new Error('Invalid index response');
  }
  // A degraded answer is shown but asked again next time.
  if (!payload.degraded) rememberCountryIndex(payload);
  return payload;
}

// ---- Russian and English wording -----------------------------------------------------

export type IndexLang = 'ru' | 'en';

/** The dashboard language reduced to the two the index is written in. */
export const indexLang = (code: string): IndexLang => (code.toLowerCase().startsWith('ru') ? 'ru' : 'en');

const COMPONENT_EN: Record<string, string> = {
  eqVol: 'Conditional equity volatility',
  eqDrawdown: 'Equity index drawdown',
  eqShock: 'Abnormal 5-day fall',
  fxVol: 'Conditional currency volatility',
  fxDep: 'Abnormal 21-day depreciation',
  newsVolume: 'News volume surge',
  newsTone: 'Share of negative headlines',
};
const REGION_EN: Record<string, string> = {
  Америка: 'Americas', Европа: 'Europe', 'Восточная Европа': 'Eastern Europe',
  'Ближний Восток': 'Middle East', Африка: 'Africa', Азия: 'Asia', Океания: 'Oceania',
};
const CONFIDENCE_EN: Record<string, string> = { высокая: 'high', средняя: 'medium', низкая: 'low' };

export function componentLabel(definition: IndexDefinition, lang: IndexLang): string {
  return lang === 'ru' ? definition.label : COMPONENT_EN[definition.id] ?? definition.id;
}

export function countryName(country: Pick<IndexCountry, 'code' | 'name'>, lang: IndexLang): string {
  if (lang === 'ru') return country.name;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(country.code) ?? country.code;
  } catch {
    return country.code;
  }
}

export const regionName = (name: string, lang: IndexLang): string => (lang === 'ru' ? name : REGION_EN[name] ?? name);
export const confidenceName = (value: string, lang: IndexLang): string => (lang === 'ru' ? value : CONFIDENCE_EN[value] ?? value);

export function instrumentName(name: string, lang: IndexLang): string {
  if (lang === 'ru') return name;
  return name
    .replace('Индекс доллара DXY', 'US Dollar Index DXY')
    .replace('ETF на ', 'ETF on ')
    .replace(' за USD', ' per USD')
    .replace('(прокси)', '(proxy)');
}

/** Colour band of a 0..100 score: neutral below 60, accent from 60, red only from 90. */
export const scoreBand = (score: number | null): 'none' | 'low' | 'mid' | 'high' =>
  score === null ? 'none' : score >= 90 ? 'high' : score >= 60 ? 'mid' : 'low';

export function formatNumber(value: number | null | undefined, lang: IndexLang, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return lang === 'ru' ? 'нет данных' : 'no data';
  const text = value.toFixed(digits).replace(/^-(?=[0.]*$)/, '').replace('-', '−');
  return lang === 'ru' ? text.replace('.', ',') : text;
}
