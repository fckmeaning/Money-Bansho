// Validation of the raw JSON. Anything that does not match is dropped, never
// repaired with made-up values.
import type { Lang, Unit } from './format';

export type Nullable = number | null;
export interface Bi { en: string; ru: string }

export interface MetricItem { id: string; label: Bi; value: Nullable; unit: Unit; hint: Bi; formula: string }
export interface MetricGroup { id: string; title: Bi; items: MetricItem[] }

export const SERIES_KEYS = [
  'close', 'sma20', 'sma50', 'sma200', 'bollUpper', 'bollLower', 'rsi14', 'macd', 'macdSignal', 'macdHist',
  'drawdownPct', 'rollVolPct', 'rollBeta60', 'rollCorr60', 'rollSharpe60', 'relativeStrength', 'volume',
] as const;
export type SeriesKey = (typeof SERIES_KEYS)[number];
export interface Series { time: number[]; data: Partial<Record<SeriesKey, Nullable[]>> }

export interface Histogram { edges: number[]; counts: number[]; expected: Nullable[] }
export interface QQ { theoretical: number[]; sample: number[] }
export interface Month { year: number; month: number; ret: Nullable; bench: Nullable }
export interface Period { id: string; ret: Nullable; bench: Nullable; excess: Nullable }
export interface NewsGroup { key: string; count: number; tone: Nullable }
export interface NewsDay { time: number; count: Nullable; tone: Nullable }
export interface NewsStats { byType: NewsGroup[]; bySource: NewsGroup[]; byLang: NewsGroup[]; daily: NewsDay[] }

export interface Metrics {
  asOf: number | null;
  sessions: number | null;
  groups: MetricGroup[];
  series: Series | null;
  histogram: Histogram | null;
  qq: QQ | null;
  monthly: Month[];
  periods: Period[];
  news: NewsStats | null;
}

export interface Column { id: string; label: Bi; unit: Unit }
export interface Row { symbol: string; name: string; region: string; values: Map<string, number>; spark: number[] }
export interface Correlation { symbols: string[]; matrix: Nullable[][] }
export interface Region { region: string; count: Nullable; medians: Map<string, number> }
export interface Screener {
  updatedAt: number | null;
  errors: { source: string; message: string }[];
  columns: Column[];
  rows: Row[];
  correlation: Correlation | null;
  regions: Region[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const objects = (v: unknown): Obj[] => list(v).filter(isObj);
const finite = (v: unknown): Nullable => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function bi(v: unknown, fallback = ''): Bi {
  if (typeof v === 'string') return { en: v, ru: v };
  const o = obj(v);
  const en = text(o.en);
  const ru = text(o.ru);
  return { en: en || ru || fallback, ru: ru || en || fallback };
}

export const pick = (value: Bi, lang: Lang): string => value[lang];

const UNITS: readonly string[] = ['pct', 'ratio', 'num', 'price', 'days', 'money'];
const unit = (v: unknown): Unit => (typeof v === 'string' && UNITS.includes(v) ? (v as Unit) : 'num');

function groups(v: unknown): MetricGroup[] {
  return objects(v)
    .map((g, gi) => {
      const id = text(g.id) || `group-${gi}`;
      const items = objects(g.items)
        .filter((item) => text(item.id) || item.label)
        .map((item, i) => {
          const itemId = text(item.id) || `${id}-${i}`;
          return {
            id: itemId,
            label: bi(item.label, itemId),
            value: finite(item.value),
            unit: unit(item.unit),
            hint: bi(item.hint),
            formula: text(item.formula),
          };
        });
      return { id, title: bi(g.title, id), items };
    })
    .filter((g) => g.items.length > 0);
}

function series(v: unknown): Series | null {
  const o = obj(v);
  const raw = list(o.time);
  const order = raw
    .map((t, index) => ({ time: toMs(t), index }))
    .filter((p): p is { time: number; index: number } => p.time !== null)
    .sort((a, b) => a.time - b.time);
  if (order.length === 0) return null;
  const data: Partial<Record<SeriesKey, Nullable[]>> = {};
  for (const key of SERIES_KEYS) {
    const values = o[key];
    // A series of a different length cannot be aligned to dates, so it is dropped.
    if (!Array.isArray(values) || values.length !== raw.length) continue;
    const aligned = order.map((p) => finite(values[p.index]));
    if (aligned.some((x) => x !== null)) data[key] = aligned;
  }
  return Object.keys(data).length ? { time: order.map((p) => p.time), data } : null;
}

function histogram(v: unknown): Histogram | null {
  const o = obj(v);
  const edges = list(o.edgesPct).map(finite);
  const counts = list(o.counts).map(finite);
  if (counts.length === 0 || edges.length !== counts.length + 1) return null;
  if (edges.some((e) => e === null) || counts.some((c) => c === null || c < 0)) return null;
  const expected = list(o.normalExpected);
  return {
    edges: edges as number[],
    counts: counts as number[],
    expected: expected.length === counts.length ? expected.map(finite) : [],
  };
}

function qq(v: unknown): QQ | null {
  const o = obj(v);
  const a = list(o.theoretical);
  const b = list(o.sample);
  if (a.length !== b.length) return null;
  const pairs: [number, number][] = [];
  a.forEach((value, i) => {
    const x = finite(value);
    const y = finite(b[i]);
    if (x !== null && y !== null) pairs.push([x, y]);
  });
  if (pairs.length < 2) return null;
  pairs.sort((p, q) => p[0] - q[0]);
  return { theoretical: pairs.map((p) => p[0]), sample: pairs.map((p) => p[1]) };
}

function monthly(v: unknown): Month[] {
  const rows = objects(v);
  const zeroBased = rows.some((r) => r.month === 0);
  const out: Month[] = [];
  for (const r of rows) {
    const year = finite(r.year);
    const rawMonth = finite(r.month);
    if (year === null || rawMonth === null) continue;
    const month = zeroBased ? rawMonth + 1 : rawMonth;
    if (!Number.isInteger(month) || month < 1 || month > 12) continue;
    out.push({ year, month, ret: finite(r.returnPct), bench: finite(r.benchmarkPct) });
  }
  return out.sort((a, b) => a.year - b.year || a.month - b.month);
}

const PERIOD_ORDER = ['1d', '1w', '1m', '3m', '6m', 'ytd', '1y'];

function periods(v: unknown): Period[] {
  const rank = (id: string) => {
    const i = PERIOD_ORDER.indexOf(id);
    return i < 0 ? PERIOD_ORDER.length : i;
  };
  return objects(v)
    .filter((p) => text(p.id))
    .map((p) => ({ id: text(p.id), ret: finite(p.returnPct), bench: finite(p.benchmarkPct), excess: finite(p.excessPct) }))
    .sort((a, b) => rank(a.id) - rank(b.id));
}

function newsGroups(v: unknown, field: string): NewsGroup[] {
  return objects(v)
    .map((r) => ({ key: text(r[field]), count: finite(r.count), tone: finite(r.meanTone) }))
    .filter((r): r is NewsGroup => r.key !== '' && r.count !== null)
    .sort((a, b) => b.count - a.count);
}

function news(v: unknown): NewsStats | null {
  if (!isObj(v)) return null;
  const daily: NewsDay[] = [];
  for (const r of objects(v.daily)) {
    const time = toMs(r.time);
    if (time !== null) daily.push({ time, count: finite(r.count), tone: finite(r.meanTone) });
  }
  daily.sort((a, b) => a.time - b.time);
  const out = {
    byType: newsGroups(v.byType, 'type'),
    bySource: newsGroups(v.bySource, 'source'),
    byLang: newsGroups(v.byLang, 'lang'),
    daily,
  };
  return out.byType.length || out.bySource.length || out.byLang.length || daily.length ? out : null;
}

export function parseMetrics(raw: unknown): Metrics | null {
  if (!isObj(raw)) return null;
  const out: Metrics = {
    asOf: toMs(raw.asOf),
    sessions: finite(raw.sessions),
    groups: groups(raw.groups),
    series: series(raw.series),
    histogram: histogram(raw.histogram),
    qq: qq(raw.qq),
    monthly: monthly(raw.monthly),
    periods: periods(raw.periods),
    news: news(raw.newsStats),
  };
  const any =
    out.groups.length || out.series || out.histogram || out.qq || out.monthly.length || out.periods.length || out.news;
  return any ? out : null;
}

function numberMap(v: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, value] of Object.entries(obj(v))) {
    const n = finite(value);
    if (n !== null) out.set(key, n);
  }
  return out;
}

function correlation(v: unknown): Correlation | null {
  const o = obj(v);
  const symbols = list(o.symbols).map(text);
  const matrix = list(o.matrix);
  if (symbols.length < 2 || matrix.length !== symbols.length || symbols.some((s) => !s)) return null;
  const rows: Nullable[][] = [];
  for (const row of matrix) {
    if (!Array.isArray(row) || row.length !== symbols.length) return null;
    rows.push(
      row.map((x) => {
        const n = finite(x);
        // Allow floating-point overshoot only; other out-of-range values are not correlations.
        return n === null || Math.abs(n) > 1.0001 ? null : Math.max(-1, Math.min(1, n));
      }),
    );
  }
  return { symbols, matrix: rows };
}

export function parseScreener(raw: unknown): Screener | null {
  if (!isObj(raw) || !Array.isArray(raw.rows) || !Array.isArray(raw.columns)) return null;
  const seenColumns = new Set<string>();
  const columns: Column[] = [];
  for (const c of objects(raw.columns)) {
    const id = text(c.id);
    if (!id || seenColumns.has(id)) continue;
    seenColumns.add(id);
    columns.push({ id, label: bi(c.label, id), unit: unit(c.unit) });
  }
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const r of objects(raw.rows)) {
    const symbol = text(r.symbol);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    rows.push({
      symbol,
      name: text(r.name),
      region: text(r.region),
      values: numberMap(r.values),
      spark: list(r.spark).map(finite).filter((x): x is number => x !== null),
    });
  }
  return {
    updatedAt: toMs(raw.updatedAt),
    errors: objects(raw.errors).map((e) => ({ source: text(e.source), message: text(e.message) })),
    columns,
    rows,
    correlation: correlation(raw.correlation),
    regions: objects(raw.regions)
      .filter((r) => text(r.region))
      .map((r) => ({ region: text(r.region), count: finite(r.count), medians: numberMap(r.medians) })),
  };
}
