// Fetching and defensive normalisation of /api/dossier responses. A malformed
// field becomes "no data"; it is never replaced with an invented value.
import { impactOf, isObj, list, num, quantOf, signalsOf, str, within } from './quant-parse';
import type { Obj } from './quant-parse';
import { EVENT_TYPES } from './types';
import type {
  Bar,
  Board,
  BoardQuote,
  Dossier,
  DossierEvent,
  EventType,
  Quote,
  Range,
  Reputation,
  SourceError,
  Wire,
  WireEvent,
} from './types';

const ENDPOINT = '/api/dossier';
const TIMEOUT_MS = 25_000;

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

function errorsOf(v: unknown): SourceError[] {
  return list(v)
    .filter(isObj)
    .map((e) => ({ source: str(e.source), message: str(e.message) }));
}

function eventOf(v: unknown): DossierEvent | null {
  if (!isObj(v)) return null;
  const time = num(v.time);
  const title = str(v.title).trim();
  if (time === null || !title) return null;
  const type = str(v.type) as EventType;
  return {
    id: str(v.id) || `${time}:${title}`,
    time,
    title,
    url: str(v.url),
    source: str(v.source),
    lang: str(v.lang),
    region: str(v.region),
    type: EVENT_TYPES.includes(type) ? type : 'other',
    sentiment: num(v.sentiment),
    people: list(v.people).map(str).filter(Boolean),
    priceMovePct: num(v.priceMovePct),
    abnormalMovePct: num(v.abnormalMovePct),
    impact: impactOf(v.impact),
    outlets: within(v.outlets, 1),
  };
}

const newestFirst = (a: DossierEvent, b: DossierEvent) => b.time - a.time;

function quoteOf(v: unknown): Quote | null {
  if (!isObj(v)) return null;
  const price = num(v.price);
  if (price === null) return null;
  const asOf = num(v.asOf) ?? (typeof v.asOf === 'string' ? Date.parse(v.asOf) || null : null);
  return {
    price,
    change: num(v.change),
    changePct: num(v.changePct),
    asOf,
    marketState: str(v.marketState),
  };
}

function reputationOf(v: unknown): Reputation | null {
  if (!isObj(v)) return null;
  const score = num(v.score);
  if (score === null) return null;
  const drivers: Reputation['drivers'] = [];
  for (const d of list(v.drivers)) {
    if (!isObj(d)) continue;
    const impact = num(d.impact);
    if (impact !== null && str(d.eventId)) drivers.push({ eventId: str(d.eventId), impact });
  }
  return {
    score,
    trend: num(v.trend),
    label: str(v.label),
    drivers,
    sample: num(v.sample) ?? 0,
    margin: within(v.margin, 0, 100),
    confidence: within(v.confidence, 0, 1),
  };
}

async function getJson(query: Record<string, string>, signal: AbortSignal): Promise<Obj> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  try {
    const res = await fetch(`${ENDPOINT}?${new URLSearchParams(query)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (err) {
      if (controller.signal.aborted) throw err;
    }
    if (!res.ok) throw new ApiError(res.status, isObj(body) ? str(body.error) : '');
    if (!isObj(body)) throw new ApiError(res.status, 'invalid-response');
    return body;
  } catch (err) {
    if (timedOut) throw new ApiError(0, 'timeout');
    if (err instanceof ApiError || signal.aborted) throw err;
    throw new ApiError(0, 'network');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function fetchDossier(symbol: string, range: Range, signal: AbortSignal): Promise<Dossier> {
  return parseDossier(await getJson({ symbol, range }, signal), symbol);
}

export function parseDossier(body: Obj, symbol: string): Dossier {
  if (!Array.isArray(body.history) || !Array.isArray(body.events)) {
    throw new ApiError(200, 'invalid-response');
  }
  const history: Bar[] = [];
  for (const b of body.history) {
    if (!isObj(b)) continue;
    const t = num(b.t);
    const c = num(b.c);
    if (t !== null && c !== null) history.push({ t, c, v: num(b.v) });
  }
  history.sort((a, b) => a.t - b.t);
  return {
    symbol: str(body.symbol) || symbol,
    name: str(body.name),
    exchange: str(body.exchange),
    currency: str(body.currency),
    region: str(body.region),
    country: str(body.country),
    quote: quoteOf(body.quote),
    history,
    events: body.events
      .map(eventOf)
      .filter((e): e is DossierEvent => e !== null)
      .sort(newestFirst),
    reputation: reputationOf(body.reputation),
    signals: signalsOf(body.signals),
    quant: quantOf(body.quant),
    metrics: body.metrics,
    raw: body,
    updatedAt: num(body.updatedAt) ?? Date.now(),
    errors: errorsOf(body.errors),
  };
}

export async function fetchBoard(signal: AbortSignal): Promise<Board> {
  const body = await getJson({ view: 'board' }, signal);
  if (!Array.isArray(body.quotes)) throw new ApiError(200, 'invalid-response');
  const quotes = new Map<string, BoardQuote>();
  for (const q of body.quotes) {
    if (!isObj(q) || !str(q.symbol)) continue;
    quotes.set(str(q.symbol), { price: num(q.price), changePct: num(q.changePct) });
  }
  return { quotes, updatedAt: num(body.updatedAt) ?? Date.now(), errors: errorsOf(body.errors) };
}

export async function fetchWire(signal: AbortSignal): Promise<Wire> {
  const body = await getJson({ view: 'wire' }, signal);
  if (!Array.isArray(body.events)) throw new ApiError(200, 'invalid-response');
  const events: WireEvent[] = [];
  for (const raw of body.events) {
    const event = eventOf(raw);
    if (!event || !isObj(raw) || !str(raw.symbol)) continue;
    events.push({
      ...event,
      symbol: str(raw.symbol),
      name: str(raw.name),
      changePct: num(raw.changePct),
    });
  }
  events.sort(newestFirst);
  return { events, updatedAt: num(body.updatedAt) ?? Date.now(), errors: errorsOf(body.errors) };
}

/** Self-rescheduling poll: never overlaps, pauses while the tab is hidden. */
export function createPoller<T>(
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  onData: (data: T) => void,
  onError: (error: ApiError) => void,
): { refresh(): void; stop(): void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let lastRun = 0;

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!controller.signal.aborted && !document.hidden) timer = setTimeout(run, ms);
  };
  async function run(): Promise<void> {
    if (busy || controller.signal.aborted) return;
    busy = true;
    lastRun = Date.now();
    clearTimeout(timer);
    try {
      let data: T;
      try {
        data = await load(controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) {
          if (!(err instanceof ApiError)) console.error('[dossier] poll failed', err);
          onError(err instanceof ApiError ? err : new ApiError(0, 'network'));
        }
        return;
      }
      if (!controller.signal.aborted) onData(data);
    } catch (err) {
      // A view that fails to draw is a bug, not a network failure: log it instead of
      // reporting "no connection" or leaving an unhandled rejection.
      console.error('[dossier] update failed', err);
    } finally {
      busy = false;
      schedule(intervalMs);
    }
  }
  const onVisibility = () => {
    if (document.hidden) clearTimeout(timer);
    else schedule(Math.max(0, intervalMs - (Date.now() - lastRun)));
  };
  document.addEventListener('visibilitychange', onVisibility);
  void run();
  return {
    refresh: () => void run(),
    stop: () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
