export const EVENT_TYPES = [
  'leadership',
  'politics',
  'regulation',
  'earnings',
  'deal',
  'scandal',
  'product',
  'other',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const RANGES = ['1mo', '3mo', '1y'] as const;
export type Range = (typeof RANGES)[number];

/** Tabs of the company view, in display order. */
export const COMPANY_VIEWS = ['overview', 'events', 'forecast', 'metrics', 'model', 'process'] as const;
export type CompanyView = (typeof COMPANY_VIEWS)[number];

export const REGIONS = ['us', 'china', 'europe', 'israel', 'korea'] as const;

export interface Company {
  symbol: string;
  name: string;
  aliases: string[];
  country: string;
  region: string;
}

export const IMPACT_LEVELS = ['noise', 'notable', 'significant'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

export type ReturnModel = 'market' | 'naive';

/** Event study around one headline. Every number may be missing on its own. */
export interface Impact {
  carPct: number | null;
  z: number | null;
  level: ImpactLevel | null;
  sessions: number | null;
  preCarPct: number | null;
  preZ: number | null;
  volumeRatio: number | null;
  beta: number | null;
  sample: number | null;
  model: ReturnModel | null;
  /** Two-sided p-value. */
  p: number | null;
  /** Benjamini-Hochberg q-value. */
  q: number | null;
}

export interface DossierEvent {
  id: string;
  time: number;
  title: string;
  /** The source wording when `title` is a translation, otherwise empty. */
  original?: string;
  url: string;
  source: string;
  lang: string;
  region: string;
  type: EventType;
  sentiment: number | null;
  people: string[];
  priceMovePct: number | null;
  abnormalMovePct: number | null;
  impact: Impact | null;
  /** Distinct outlets carrying the same story. */
  outlets: number | null;
  /** Passed through untouched to consequences.ts, which validates it itself. */
  consequences?: unknown;
}

export interface WireEvent extends DossierEvent {
  symbol: string;
  name: string;
  changePct: number | null;
}

export interface Bar {
  t: number;
  c: number;
  v: number | null;
}

export interface Quote {
  price: number;
  change: number | null;
  changePct: number | null;
  asOf: number | null;
  marketState: string;
}

export interface Reputation {
  score: number;
  trend: number | null;
  label: string;
  drivers: { eventId: string; impact: number }[];
  sample: number;
  /** 95% half-width in score points. */
  margin: number | null;
  /** 0..1 */
  confidence: number | null;
}

export const SIGNAL_PARTS = ['price', 'news', 'volume', 'volatility'] as const;
export type SignalPart = (typeof SIGNAL_PARTS)[number];

export type VolatilityLabel = 'calm' | 'normal' | 'elevated';
export type AttentionLabel = 'ordinary' | 'elevated' | 'unusual';

export interface Signals {
  price: {
    abnormalPct: number | null;
    z: number | null;
    beta: number | null;
    sample: number | null;
    model: ReturnModel | null;
  } | null;
  volumeRatio: number | null;
  volatility: { ratio: number | null; annualPct: number | null; label: VolatilityLabel | null } | null;
  news: { today: number | null; expected: number | null; z: number | null } | null;
  attention: {
    score: number | null;
    label: AttentionLabel | null;
    coverage: number | null;
    parts: { key: SignalPart; share: number }[];
  } | null;
}

export interface Garch {
  omega: number | null;
  alpha: number | null;
  beta: number | null;
  nu: number | null;
  persistence: number | null;
  halfLifeDays: number | null;
  longRunAnnualPct: number | null;
  nextAnnualPct: number | null;
  /** Index is the horizon in trading days minus one; gaps stay null. */
  termAnnualPct: (number | null)[];
  series: { time: number; annualPct: number }[];
}

export interface QuantVolatility {
  garch: Garch | null;
  ewmaAnnualPct: number | null;
}

export interface Jump {
  time: number;
  returnPct: number | null;
  statistic: number | null;
}

/** Risk figures are positive losses in percent. */
export interface QuantRisk {
  level: number | null;
  varHistoricalPct: number | null;
  varTPct: number | null;
  varCornishFisherPct: number | null;
  expectedShortfallPct: number | null;
  maxDrawdownPct: number | null;
  jumps: Jump[];
}

export interface QuantBeta {
  latest: number | null;
  low: number | null;
  high: number | null;
  constant: number | null;
  series: { time: number; beta: number; low: number | null; high: number | null }[];
}

export interface QuantRegime {
  probabilityTurbulent: number | null;
  calmAnnualPct: number | null;
  turbulentAnnualPct: number | null;
  calmDays: number | null;
  turbulentDays: number | null;
  series: { time: number; p: number }[];
}

export interface QuantChangepoint {
  recentProbability: number | null;
  runLengthDays: number | null;
  breaks: number[];
}

export interface QuantNewsflow {
  events: number | null;
  branching: number | null;
  halfLifeHours: number | null;
  intensityPerDay: number | null;
  baselinePerDay: number | null;
  selfExciting: boolean | null;
  fitPValue: number | null;
  windowStartCovered: boolean | null;
  diversity: { effectiveSources: number | null; normalized: number | null } | null;
}

export interface QuantTesting {
  tested: number | null;
  nominal: number | null;
  discoveries: number | null;
  level: number | null;
}

export interface Quant {
  asOf: number | null;
  sample: number | null;
  volatility: QuantVolatility | null;
  risk: QuantRisk | null;
  beta: QuantBeta | null;
  regime: QuantRegime | null;
  changepoint: QuantChangepoint | null;
  newsflow: QuantNewsflow | null;
  multipleTesting: QuantTesting | null;
}

export interface SourceError {
  source: string;
  message: string;
}

export interface Dossier {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  /** Exchange offset from UTC in seconds, to date the daily bars (stamped at the session open). */
  gmtoffset: number | null;
  region: string;
  country: string;
  quote: Quote | null;
  history: Bar[];
  events: DossierEvent[];
  reputation: Reputation | null;
  signals: Signals | null;
  quant: Quant | null;
  /** Passed through untouched to the metrics view, which validates it itself. */
  metrics: unknown;
  /** The response body as received, for the events and process views. */
  raw: unknown;
  updatedAt: number;
  errors: SourceError[];
}

export interface BoardQuote {
  price: number | null;
  changePct: number | null;
}

export interface Board {
  quotes: Map<string, BoardQuote>;
  updatedAt: number;
  errors: SourceError[];
}

export interface Wire {
  events: WireEvent[];
  updatedAt: number;
  errors: SourceError[];
}
