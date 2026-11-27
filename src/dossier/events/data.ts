// Defensive reading of the raw /api/dossier JSON. A malformed field becomes null
// ("no data"); nothing is invented.
import { EVENT_TYPES } from '../types';
import type { EventType } from '../types';

export type Level = 'noise' | 'notable' | 'significant';
export type Kind = 'news' | 'leadership' | 'filing' | 'price';

export interface Impact {
  carPct: number | null;
  z: number | null;
  level: Level | null;
  sessions: number | null;
  preCarPct: number | null;
  preZ: number | null;
  volumeRatio: number | null;
  beta: number | null;
  sample: number | null;
  model: string | null;
  p: number | null;
  q: number | null;
}

export interface Ev {
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
  outlets: number;
  impact: Impact | null;
}

export interface Bar {
  t: number;
  c: number;
  v: number | null;
  /** Estimated session close, same rule as the server's event study. */
  closeAt: number;
}

export interface Reputation {
  score: number | null;
  trend: number | null;
  label: string;
  margin: number | null;
  confidence: number | null;
  drivers: { eventId: string; impact: number }[];
}

export interface Stage {
  id: string;
  count: number | null;
}

export interface Source {
  source: string;
  kind: Kind | null;
  status: 'ok' | 'stale' | 'failed';
  items: number | null;
  ms: number | null;
  message: string | null;
}

export interface Pipeline {
  startedAt: number | null;
  durationMs: number | null;
  stages: Stage[];
  sources: Source[];
}

export interface Model {
  valid: boolean;
  symbol: string;
  name: string;
  currency: string;
  events: Ev[];
  history: Bar[];
  reputation: Reputation | null;
  pipeline: Pipeline | null;
  errors: { source: string; message: string }[];
  updatedAt: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Timestamps outside what Date can represent would throw while formatting. */
const time = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 && n < 8.64e15 ? n : null;
};
const nonNegative = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};
const unit = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 && n <= 1 ? n : null;
};

const LEVELS: readonly Level[] = ['noise', 'notable', 'significant'];
const KINDS: readonly Kind[] = ['news', 'leadership', 'filing', 'price'];

function impactOf(v: unknown): Impact | null {
  if (!isObj(v)) return null;
  const impact: Impact = {
    carPct: num(v.carPct),
    z: num(v.z),
    level: LEVELS.includes(v.level as Level) ? (v.level as Level) : null,
    sessions: nonNegative(v.sessions),
    preCarPct: num(v.preCarPct),
    preZ: num(v.preZ),
    volumeRatio: nonNegative(v.volumeRatio),
    beta: num(v.beta),
    sample: nonNegative(v.sample),
    model: str(v.model) || null,
    p: unit(v.p),
    q: unit(v.q),
  };
  return Object.values(impact).some((value) => value !== null) ? impact : null;
}

function eventsOf(v: unknown): Ev[] {
  const seen = new Set<string>();
  const out: Ev[] = [];
  for (const raw of arr(v)) {
    if (!isObj(raw)) continue;
    const at = time(raw.time);
    const title = str(raw.title).trim();
    if (at === null || !title) continue;
    let id = str(raw.id) || `${at}:${title}`;
    while (seen.has(id)) id += '~';
    seen.add(id);
    const type = str(raw.type) as EventType;
    const sentiment = num(raw.sentiment);
    const outlets = num(raw.outlets);
    out.push({
      id,
      time: at,
      title,
      url: str(raw.url),
      source: str(raw.source),
      lang: str(raw.lang),
      region: str(raw.region),
      type: EVENT_TYPES.includes(type) ? type : 'other',
      sentiment: sentiment === null ? null : Math.max(-1, Math.min(1, sentiment)),
      people: arr(raw.people).map(str).filter(Boolean),
      priceMovePct: num(raw.priceMovePct),
      abnormalMovePct: num(raw.abnormalMovePct),
      // The service sends `outlets` only when more than one source carried the story.
      outlets: outlets !== null && outlets > 1 ? Math.round(outlets) : 1,
      impact: impactOf(raw.impact),
    });
  }
  return out.sort((a, b) => b.time - a.time);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function barsOf(v: unknown): Bar[] {
  const raw: { t: number; c: number; v: number | null }[] = [];
  for (const item of arr(v)) {
    if (!isObj(item)) continue;
    const t = time(item.t);
    const c = num(item.c);
    if (t !== null && c !== null && c > 0) raw.push({ t, c, v: nonNegative(item.v) });
  }
  raw.sort((a, b) => a.t - b.t);
  // Mirrors withCloseTimes() in api/_dossier/quant.js.
  const timeOfDay = (t: number) => t - Math.floor(t / DAY) * DAY;
  return raw.map((bar, i) => {
    let open = timeOfDay(bar.t);
    const previous = raw[i - 1];
    if (i === raw.length - 1 && previous) {
      const usual = timeOfDay(previous.t);
      if (Math.abs(open - usual) > 1.5 * HOUR) open = usual;
    }
    const hour = open / HOUR;
    const length = (hour >= 6 && hour < 11 ? 8.5 : 6.5) * HOUR;
    return { ...bar, closeAt: Math.max(Math.floor(bar.t / DAY) * DAY + open + length, bar.t) };
  });
}

/** Index of the first session that closes after publication, or why it cannot be shown. */
export function dayZero(bars: Bar[], at: number): number | 'none' | 'before' | 'pending' {
  if (!bars.length) return 'none';
  const index = bars.findIndex((bar) => bar.closeAt > at);
  if (index < 0) return 'pending';
  const bar = bars[index] as Bar;
  if (index === 0 && bar.closeAt - at > 1.5 * DAY) return 'before';
  return bar.closeAt - at > 10 * DAY ? 'none' : index;
}

function reputationOf(v: unknown): Reputation | null {
  if (!isObj(v)) return null;
  const drivers: Reputation['drivers'] = [];
  for (const d of arr(v.drivers)) {
    if (!isObj(d)) continue;
    const impact = num(d.impact);
    if (impact !== null && str(d.eventId)) drivers.push({ eventId: str(d.eventId), impact });
  }
  return {
    score: num(v.score),
    trend: num(v.trend),
    label: str(v.label),
    margin: nonNegative(v.margin),
    confidence: unit(v.confidence),
    drivers,
  };
}

function pipelineOf(v: unknown): Pipeline | null {
  if (!isObj(v)) return null;
  const stages = arr(v.stages)
    .filter(isObj)
    .map((s) => ({ id: str(s.id), count: nonNegative(s.count) }))
    .filter((s) => s.id);
  const sources = arr(v.sources)
    .filter(isObj)
    .map((s): Source => ({
      source: str(s.source),
      kind: KINDS.includes(s.kind as Kind) ? (s.kind as Kind) : null,
      status: s.ok !== true ? 'failed' : s.stale === true ? 'stale' : 'ok',
      items: nonNegative(s.items),
      ms: nonNegative(s.ms),
      message: str(s.message) || null,
    }));
  return { startedAt: time(v.startedAt), durationMs: nonNegative(v.durationMs), stages, sources };
}

export function parse(data: unknown): Model {
  const root: Obj = isObj(data) ? data : {};
  return {
    valid: isObj(data) && (Array.isArray(root.events) || isObj(root.pipeline)),
    symbol: str(root.symbol),
    name: str(root.name),
    currency: str(root.currency),
    events: eventsOf(root.events),
    history: barsOf(root.history),
    reputation: reputationOf(root.reputation),
    pipeline: pipelineOf(root.pipeline),
    errors: arr(root.errors)
      .filter(isObj)
      .map((e) => ({ source: str(e.source), message: str(e.message) })),
    updatedAt: time(root.updatedAt),
  };
}
