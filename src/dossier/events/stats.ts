// Pure selection and aggregation over parsed events.
import { dayZero } from './data';
import type { Bar, Ev, Level } from './data';
import { toneKey } from './ui';

export type Facet = 'type' | 'tone' | 'level' | 'lang' | 'origin';
export const FACETS: readonly Facet[] = ['type', 'tone', 'level', 'lang', 'origin'];

export const SORTS = ['newest', 'oldest', 'car', 'z', 'q', 'outlets', 'toneLow', 'toneHigh'] as const;
export type Sort = (typeof SORTS)[number];

export type Filters = Record<Facet, Set<string>> & { query: string };

export const noFilters = (): Filters => ({
  type: new Set(),
  tone: new Set(),
  level: new Set(),
  lang: new Set(),
  origin: new Set(),
  query: '',
});

export const isFiling = (e: Ev): boolean => e.source === 'SEC EDGAR';
export const levelOf = (e: Ev): Level | 'none' => e.impact?.level ?? 'none';

export function facetValue(e: Ev, facet: Facet): string {
  switch (facet) {
    case 'type':
      return e.type;
    case 'tone':
      return toneKey(e.sentiment);
    case 'level':
      return levelOf(e);
    case 'lang':
      return e.lang;
    default:
      return isFiling(e) ? 'filing' : 'press';
  }
}

function matches(e: Ev, filters: Filters, words: string[], skip?: Facet): boolean {
  for (const facet of FACETS) {
    if (facet !== skip && filters[facet].size && !filters[facet].has(facetValue(e, facet))) return false;
  }
  if (!words.length) return true;
  const haystack = `${e.title}\n${e.source}\n${e.people.join('\n')}`.toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

const wordsOf = (query: string) => query.toLocaleLowerCase().split(/\s+/).filter(Boolean);

export function filterEvents(events: Ev[], filters: Filters): Ev[] {
  const words = wordsOf(filters.query);
  return events.filter((e) => matches(e, filters, words));
}

/** How many events each option of a facet would match under the other filters. */
export function facetCounts(events: Ev[], filters: Filters, facet: Facet): Map<string, number> {
  const words = wordsOf(filters.query);
  const counts = new Map<string, number>();
  for (const e of events) {
    if (!matches(e, filters, words, facet)) continue;
    const key = facetValue(e, facet);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const abs = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.abs(v));

/** Missing values always sort last; ties fall back to newest first. */
export function sortEvents(events: Ev[], sort: Sort): Ev[] {
  const keys: Record<Sort, [(e: Ev) => number | null, 1 | -1]> = {
    newest: [(e) => e.time, -1],
    oldest: [(e) => e.time, 1],
    car: [(e) => abs(e.impact?.carPct), -1],
    z: [(e) => abs(e.impact?.z), -1],
    q: [(e) => e.impact?.q ?? null, 1],
    outlets: [(e) => e.outlets, -1],
    toneLow: [(e) => e.sentiment, 1],
    toneHigh: [(e) => e.sentiment, -1],
  };
  const [key, direction] = keys[sort];
  return [...events].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null || y === null) return x === y ? b.time - a.time : x === null ? 1 : -1;
    return (x - y) * direction || b.time - a.time;
  });
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export const mean = (values: number[]): number | null =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

export const present = (values: (number | null | undefined)[]): number[] =>
  values.filter((v): v is number => typeof v === 'number');

/**
 * Key of the price window an event belongs to. Events with the same day-0
 * session share one CAR, so charts can say how many independent windows exist.
 */
export function windowKey(e: Ev, history: Bar[]): string | null {
  if (!e.impact) return null;
  const index = dayZero(history, e.time);
  if (typeof index === 'number') return `s${index}`;
  // Outside the shown history: identical statistics imply the same window.
  const { carPct, z, preCarPct, volumeRatio } = e.impact;
  return `v${carPct}|${z}|${preCarPct}|${volumeRatio}`;
}

export type Unit = 'day' | 'week' | 'month';

export interface Bucket {
  start: number;
  events: Ev[];
}

/** Calendar buckets in local time, including the empty ones in between. */
export function buckets(events: Ev[]): { unit: Unit; list: Bucket[] } {
  if (!events.length) return { unit: 'day', list: [] };
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    min = Math.min(min, e.time);
    max = Math.max(max, e.time);
  }
  const days = (max - min) / 86_400_000;
  const unit: Unit = days <= 62 ? 'day' : days <= 550 ? 'week' : 'month';
  const floor = (time: number): Date => {
    const d = new Date(time);
    d.setHours(0, 0, 0, 0);
    if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    if (unit === 'month') d.setDate(1);
    return d;
  };
  const list: Bucket[] = [];
  const index = new Map<number, Bucket>();
  // A corrupt timestamp must not create an unbounded number of buckets.
  for (const d = floor(min); d.getTime() <= max && list.length < 1200; ) {
    const bucket = { start: d.getTime(), events: [] as Ev[] };
    list.push(bucket);
    index.set(bucket.start, bucket);
    if (unit === 'month') d.setMonth(d.getMonth() + 1);
    else d.setDate(d.getDate() + (unit === 'week' ? 7 : 1));
  }
  for (const e of events) index.get(floor(e.time).getTime())?.events.push(e);
  return { unit, list };
}

export interface Bin {
  from: number;
  to: number;
  count: number;
}

/** Symmetric histogram around zero with a round bin width. Bins are [from, to). */
export function histogram(values: number[]): Bin[] {
  if (!values.length) return [];
  const extent = Math.max(0.5, ...values.map(Math.abs));
  const width = [0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100].find((w) => extent / w <= 8) ?? extent / 8;
  const half = Math.floor(extent / width) + 1;
  const bins: Bin[] = [];
  for (let i = -half; i < half; i++) bins.push({ from: i * width, to: (i + 1) * width, count: 0 });
  for (const v of values) {
    const bin = bins[Math.min(bins.length - 1, Math.max(0, Math.floor(v / width) + half))];
    if (bin) bin.count++;
  }
  // Trim empty tails on both sides together so zero stays in the middle.
  while (bins.length > 4 && !bins[0]?.count && !bins[bins.length - 1]?.count) {
    bins.shift();
    bins.pop();
  }
  return bins;
}
