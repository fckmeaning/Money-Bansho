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

export const REGIONS = ['us', 'china', 'europe', 'israel', 'korea'] as const;

export interface Company {
  symbol: string;
  name: string;
  aliases: string[];
  country: string;
  region: string;
}

export interface DossierEvent {
  id: string;
  time: number;
  title: string;
  url: string;
  source: string;
  lang: string;
  region: string;
  type: EventType;
  sentiment: number | null;
  people: string[];
  priceMovePct: number | null;
  abnormalMovePct: number | null;
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
  region: string;
  country: string;
  quote: Quote | null;
  history: Bar[];
  events: DossierEvent[];
  reputation: Reputation | null;
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
