// Fetching and validation of ?view=analytics and ?view=comentions. Anything that
// does not match is dropped; a missing number stays null and is shown as "no data".
import type { Lang, Unit } from '../analytics/format';
import { isObj, list, num, str } from '../quant-parse';
import type { Obj } from '../quant-parse';
import { localizeHeadlines } from '../translate';

export type Nullable = number | null;
export type Frequency = 'daily' | 'weekly';

export interface Column { id: string; label: { en: string; ru: string }; unit: Unit }
export interface Distribution { n: number; counts: number[] | null; mean: Nullable; sd: Nullable; beyond3: Nullable }
export interface Company {
  index: number;
  symbol: string;
  name: string;
  region: string;
  country: string;
  currency: string;
  values: Record<string, Nullable>;
  spark: number[];
  distribution: Distribution;
}
export interface Merge { a: number; b: number; height: number }
export interface Clusters { order: number[]; merges: Merge[] }
export interface Summary {
  nodes: number;
  linked: number;
  edges: number;
  density: Nullable;
  clustering: Nullable;
  modularity: Nullable;
  communities: number;
  components: number;
}
export interface GraphMetrics {
  degree: Nullable[];
  strength: Nullable[];
  pagerank: Nullable[];
  betweenness: Nullable[];
  closeness: Nullable[];
  clustering: Nullable[];
  community: Nullable[];
  summary: Summary;
}
export interface Network {
  mst: { edges: [number, number][]; length: Nullable; metrics: GraphMetrics };
  levels: { threshold: number; metrics: GraphMetrics }[];
}
export interface RegionRow {
  region: string;
  count: number;
  medians: Record<string, Nullable>;
  indexReturn: Nullable;
  indexVol: Nullable;
  indexDrawdown: Nullable;
  turnoverUsd: Nullable;
  turnoverCount: number;
  intraCorr: Nullable;
  interCorr: Nullable;
}
export interface Atlas {
  updatedAt: number;
  columns: Column[];
  rows: Company[];
  correlation: { daily: Nullable[][]; weekly: Nullable[][]; overlap: Nullable[][]; overlapWeekly: Nullable[][] };
  clusters: Record<Frequency, Clusters>;
  network: Record<Frequency, Network>;
  regions: RegionRow[];
  regionIndex: { days: number[]; series: Record<string, Nullable[]>; excluded: string[] };
  regionCorrelation: { regions: string[]; daily: Nullable[][]; weekly: Nullable[][] };
  distribution: { edges: number[]; groups: Record<string, Distribution> };
  errors: { source: string; message: string }[];
}

export interface Headline { title: string; original: string; url: string; source: string; time: number; copies: number }
export interface MentionEdge {
  a: number;
  b: number;
  count: number;
  weight: number;
  jaccard: Nullable;
  lift: Nullable;
  items: Headline[];
}
export interface CoMentions {
  updatedAt: number;
  windowDays: number;
  sample: { headlines: number; searched: number; published: number; feedsAsked: number; feedsAnswered: number; oldestAt: Nullable };
  symbols: string[];
  mentions: number[];
  stories: number;
  linkingStories: number;
  edges: MentionEdge[];
  network: Network;
  errors: { source: string; message: string }[];
}

const UNITS: readonly string[] = ['pct', 'ratio', 'num', 'price', 'days', 'money'];
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const objects = (v: unknown): Obj[] => list(v).filter(isObj);
const numbers = (v: unknown): Nullable[] => list(v).map(num);
const solid = (v: unknown): number[] => list(v).filter((x): x is number => num(x) !== null);
const count = (v: unknown): number => num(v) ?? 0;
const matrix = (v: unknown): Nullable[][] => list(v).map(numbers);
const strings = (v: unknown): string[] => list(v).map(str);
const record = (v: unknown): Record<string, Nullable> =>
  Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, num(x)]));
const errorsOf = (v: unknown) => objects(v).map((e) => ({ source: str(e.source), message: str(e.message) }));

function distributionOf(v: unknown): Distribution {
  const o = obj(v);
  return {
    n: count(o.n),
    counts: Array.isArray(o.counts) ? solid(o.counts) : null,
    mean: num(o.mean),
    sd: num(o.sd),
    beyond3: num(o.beyond3),
  };
}

function metricsOf(v: unknown): GraphMetrics {
  const o = obj(v);
  const s = obj(o.summary);
  return {
    degree: numbers(o.degree),
    strength: numbers(o.strength),
    pagerank: numbers(o.pagerank),
    betweenness: numbers(o.betweenness),
    closeness: numbers(o.closeness),
    clustering: numbers(o.clustering),
    community: numbers(o.community),
    summary: {
      nodes: count(s.nodes),
      linked: count(s.linked),
      edges: count(s.edges),
      density: num(s.density),
      clustering: num(s.clustering),
      modularity: num(s.modularity),
      communities: count(s.communities),
      components: count(s.components),
    },
  };
}

function networkOf(v: unknown): Network {
  const o = obj(v);
  const mst = obj(o.mst);
  return {
    mst: {
      edges: list(mst.edges).flatMap((e) => {
        const [a, b] = numbers(e);
        return a === undefined || b === undefined || a === null || b === null ? [] : [[a, b] as [number, number]];
      }),
      length: num(mst.length),
      metrics: metricsOf(mst.metrics),
    },
    levels: objects(o.levels).map((l) => ({ threshold: count(l.threshold), metrics: metricsOf(l.metrics) })),
  };
}

const clustersOf = (v: unknown): Clusters => ({
  order: solid(obj(v).order),
  merges: objects(obj(v).merges).map((m) => ({ a: count(m.a), b: count(m.b), height: count(m.height) })),
});

export function parseAtlas(body: unknown): Atlas {
  const o = obj(body);
  if (!Array.isArray(o.rows) || !Array.isArray(o.columns)) throw new Error('invalid');
  const correlation = obj(o.correlation);
  const clusters = obj(o.clusters);
  const network = obj(o.network);
  const index = obj(o.regionIndex);
  const between = obj(o.regionCorrelation);
  const distribution = obj(o.distribution);
  return {
    updatedAt: count(o.updatedAt),
    columns: objects(o.columns).map((c) => {
      const label = obj(c.label);
      const unit = str(c.unit);
      return {
        id: str(c.id),
        label: { en: str(label.en) || str(c.id), ru: str(label.ru) || str(c.id) },
        unit: (UNITS.includes(unit) ? unit : 'num') as Unit,
      };
    }),
    rows: objects(o.rows).map((r, i) => ({
      index: i,
      symbol: str(r.symbol),
      name: str(r.name),
      region: str(r.region),
      country: str(r.country),
      currency: str(r.currency),
      values: record(r.values),
      spark: solid(r.spark),
      distribution: distributionOf(r.distribution),
    })),
    correlation: {
      daily: matrix(correlation.daily),
      weekly: matrix(correlation.weekly),
      overlap: matrix(correlation.overlap),
      overlapWeekly: matrix(correlation.overlapWeekly),
    },
    clusters: { daily: clustersOf(clusters.daily), weekly: clustersOf(clusters.weekly) },
    network: { daily: networkOf(network.daily), weekly: networkOf(network.weekly) },
    regions: objects(o.regions).map((r) => ({
      region: str(r.region),
      count: count(r.count),
      medians: record(r.medians),
      indexReturn: num(r.indexReturn),
      indexVol: num(r.indexVol),
      indexDrawdown: num(r.indexDrawdown),
      turnoverUsd: num(r.turnoverUsd),
      turnoverCount: count(r.turnoverCount),
      intraCorr: num(r.intraCorr),
      interCorr: num(r.interCorr),
    })),
    regionIndex: {
      days: solid(index.days),
      series: Object.fromEntries(Object.entries(obj(index.series)).map(([k, v]) => [k, numbers(v)])),
      excluded: strings(index.excluded),
    },
    regionCorrelation: {
      regions: strings(between.regions),
      daily: matrix(between.daily),
      weekly: matrix(between.weekly),
    },
    distribution: {
      edges: solid(distribution.edges),
      groups: Object.fromEntries(Object.entries(obj(distribution.groups)).map(([k, v]) => [k, distributionOf(v)])),
    },
    errors: errorsOf(o.errors),
  };
}

export function parseCoMentions(body: unknown): CoMentions {
  const o = obj(body);
  if (!Array.isArray(o.edges) || !Array.isArray(o.symbols)) throw new Error('invalid');
  localizeHeadlines(o);
  const sample = obj(o.sample);
  return {
    updatedAt: count(o.updatedAt),
    windowDays: count(o.windowDays),
    sample: {
      headlines: count(sample.headlines),
      searched: count(sample.searched),
      published: count(sample.published),
      feedsAsked: count(sample.feedsAsked),
      feedsAnswered: count(sample.feedsAnswered),
      oldestAt: num(sample.oldestAt),
    },
    symbols: strings(o.symbols),
    mentions: numbers(o.mentions).map((v) => v ?? 0),
    stories: count(o.stories),
    linkingStories: count(o.linkingStories),
    edges: objects(o.edges).map((e) => ({
      a: count(e.a),
      b: count(e.b),
      count: count(e.count),
      weight: count(e.weight),
      jaccard: num(e.jaccard),
      lift: num(e.lift),
      items: objects(e.items).map((i) => ({
        title: str(i.title),
        original: str(i.originalTitle),
        url: str(i.url),
        source: str(i.source),
        time: count(i.time),
        copies: count(i.copies),
      })),
    })),
    network: networkOf(o.network),
    errors: errorsOf(o.errors),
  };
}

const KEEP_MS = 5 * 60_000;
const TIMEOUT_MS = 40_000;
const cache = new Map<string, { at: number; value: unknown }>();
const pending = new Map<string, Promise<unknown>>();

function load<T>(key: string, url: string, parse: (body: unknown) => T, force: boolean): Promise<T> {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < KEEP_MS) return Promise.resolve(hit.value as T);
  let running = pending.get(key) as Promise<T> | undefined;
  if (!running) {
    running = (async () => {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = parse(await response.json());
      cache.set(key, { at: Date.now(), value });
      return value;
    })().finally(() => pending.delete(key));
    pending.set(key, running);
  }
  return running;
}

export const loadAtlas = (force = false): Promise<Atlas> =>
  load('atlas', '/api/dossier?view=analytics', parseAtlas, force);

export const loadCoMentions = (lang: Lang, force = false): Promise<CoMentions> =>
  load(`comentions|${lang}`, `/api/dossier?view=comentions${lang === 'ru' ? '&tl=ru' : ''}`, parseCoMentions, force);
