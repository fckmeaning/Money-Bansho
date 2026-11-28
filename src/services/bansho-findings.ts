// Findings for the header badge, computed from Money Bansho's own data: unusual
// market moves, the country instability index, geopolitical point scores and the
// company wire. Thresholds are fixed and stated in each finding; a source that
// does not answer leaves the scan incomplete.

import { fetchBanshoDashboardData } from './bansho-dashboard-data';
import { getCurrentLanguage } from './i18n';

export interface BanshoFinding {
  id: string;
  type: 'bansho_market' | 'bansho_country' | 'bansho_point' | 'bansho_company';
  title: string;
  description: string;
  insight: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  timestamp: Date;
  /** Opened on click when present, otherwise the page scrolls to `section`. */
  url: string | null;
  section: string | null;
}

/** Daily moves this many standard deviations from usual are findings. */
const Z_NOTABLE = 1.8;
const Z_STRONG = 2.5;
/** Index and point scores at or above these levels are findings. */
const COUNTRY_HIGH = 78;
const POINT_HIGH = 70;
const PER_SOURCE = 5;
const TTL_MS = 3 * 60_000;
const START_DELAY_MS = 8000;

type Row = Record<string, unknown>;

const list = (value: unknown): Row[] => (Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Row[]) : []);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const ru = (value: number, digits: number): string =>
  value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const when = (value: unknown, fallback: number): Date => new Date(num(value) ?? fallback);

export function marketFindings(body: Row): BanshoFinding[] {
  const news = (body.news ?? {}) as Record<string, unknown>;
  return list(body.rows)
    .flatMap((row) => {
      const z = num(row.z1d);
      return z === null || row.stale === true || Math.abs(z) < Z_NOTABLE ? [] : [{ row, z }];
    })
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, PER_SOURCE)
    .map(({ row, z }): BanshoFinding => {
      const symbol = str(row.symbol);
      const change = num(row.change1d);
      const headline = list(news[symbol])[0];
      const unit = row.unit === 'bp' ? ' б.п.' : '%';
      return {
        id: `market-${symbol}-${num(row.asOf) ?? 0}`,
        type: 'bansho_market',
        title: `${str(row.name) || symbol}: необычное движение`,
        description: `${change === null ? 'нет данных' : `${change > 0 ? '+' : ''}${ru(change, 2)}${unit}`} за день, z = ${ru(z, 2)}`,
        insight: headline ? str(headline.titleRu) || str(headline.title) : `Порог |z| ≥ ${ru(Z_NOTABLE, 1)}`,
        priority: Math.abs(z) >= Z_STRONG ? 'high' : 'medium',
        timestamp: when(row.asOf, Date.now()),
        url: null,
        section: '.bansho-economy',
      };
    });
}

export function countryFindings(body: Row): BanshoFinding[] {
  return list(body.countries)
    .flatMap((country) => {
      const index = num(country.index);
      const coverage = num(country.coverage) ?? 0;
      return index === null || index < COUNTRY_HIGH || coverage < 0.5 ? [] : [{ country, index, coverage }];
    })
    .sort((a, b) => b.index - a.index)
    .slice(0, PER_SOURCE)
    .map(({ country, index, coverage }): BanshoFinding => ({
      id: `country-${str(country.code)}`,
      type: 'bansho_country',
      title: `${str(country.name) || str(country.code)}: высокий индекс нестабильности`,
      description: `Индекс ${ru(index, 4)} из 100, покрытие данными ${ru(coverage * 100, 0)}%`,
      insight: `Порог ${COUNTRY_HIGH}; 50 означает обычный уровень компонентов`,
      priority: index >= 82 ? 'high' : 'medium',
      timestamp: when(body.updatedAt, Date.now()),
      url: null,
      section: '.bansho-instability-host',
    }));
}

export function pointFindings(body: Row): BanshoFinding[] {
  return list(body.points)
    .flatMap((point) => {
      const score = num(point.score);
      return score === null || score < POINT_HIGH ? [] : [{ point, score }];
    })
    .slice(0, PER_SOURCE)
    .map(({ point, score }): BanshoFinding => {
      const low = num(point.low);
      const high = num(point.high);
      return {
        id: `point-${str(point.key)}`,
        type: 'bansho_point',
        title: `${str(point.name)}: высокая геополитическая оценка`,
        description: `Балл ${ru(score, 4)}${low === null || high === null ? '' : `, интервал ${ru(low, 2)} – ${ru(high, 2)}`}`,
        insight: `Порог ${POINT_HIGH} из 100`,
        priority: score >= 74 ? 'high' : 'medium',
        timestamp: when(body.updatedAt, Date.now()),
        url: null,
        section: '.bansho-geoscore',
      };
    });
}

export function companyFindings(body: Row): BanshoFinding[] {
  return list(body.events)
    .filter((event) => event.type === 'leadership' || event.type === 'scandal')
    .slice(0, PER_SOURCE)
    .map((event): BanshoFinding => ({
      id: `company-${str(event.symbol)}-${str(event.id)}`,
      type: 'bansho_company',
      title: `${str(event.name) || str(event.symbol)}: ${event.type === 'leadership' ? 'кадровое изменение' : 'скандал или происшествие'}`,
      description: str(event.titleRu) || str(event.title),
      insight: str(event.source),
      priority: 'medium',
      timestamp: when(event.time, Date.now()),
      url: /^https?:\/\//.test(str(event.url)) ? str(event.url) : null,
      section: null,
    }));
}

// The market panel has already started its request. Keep the other expensive
// calculations sequential and give the map a chance to finish loading first.
const SOURCES = [
  ['economy', 'rows', marketFindings],
  ['wire', 'events', companyFindings],
  ['instability', 'countries', countryFindings],
  ['geoscore', 'points', pointFindings],
] as const;

export type BanshoFindingsStatus = 'loading' | 'ready' | 'partial' | 'unavailable';

const listeners = new Set<() => void>();
const found = new Map<string, BanshoFinding[]>();
let refreshAfter: number | null = null;
let status: BanshoFindingsStatus = 'loading';
let scan: AbortController | null = null;

export function subscribeBanshoFindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      scan?.abort();
      scan = null;
    }
  };
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function waitForBoot(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function refresh(controller: AbortController): Promise<void> {
  const startedAt = Date.now();
  const bootUntil = refreshAfter === null ? startedAt + START_DELAY_MS : 0;
  const { signal } = controller;
  status = 'loading';
  let complete = 0;
  try {
    for (const [view, field, extract] of SOURCES) {
      const remaining = bootUntil - Date.now();
      if (view === 'wire' && remaining > 0) await waitForBoot(remaining, signal);
      if (signal.aborted) return;
      try {
        const locale = view === 'economy' && getCurrentLanguage() !== 'ru' ? 'cl=en' : 'tl=ru';
        const body = await fetchBanshoDashboardData<Row>(`view=${view}&${locale}`, signal);
        if (signal.aborted) return;
        const rows = body?.[field];
        if (!Array.isArray(rows)) throw new Error('Invalid findings response');
        const incomplete = body.degraded === true || (rows.length === 0 && (
          view === 'economy' || view === 'instability' || list(body.errors).length > 0
        ));
        found.set(view, extract(body));
        if (!incomplete) complete++;
      } catch (error) {
        if (signal.aborted) return;
        console.warn(`[findings] ${view} unavailable`, error);
      }
      notifyListeners();
    }
  } finally {
    if (scan === controller) {
      scan = null;
      // A slow or failed scan still gets a pause before the next one can start.
      refreshAfter = Math.max(startedAt + TTL_MS, Date.now() + 30_000);
      status = complete === SOURCES.length ? 'ready' : complete === 0 ? 'unavailable' : 'partial';
      notifyListeners();
    }
  }
}

/** Returns the current view and refreshes snapshots when their polling window expires. */
export function getBanshoFindings(): { findings: BanshoFinding[]; status: BanshoFindingsStatus } {
  if (!scan && (refreshAfter === null || Date.now() >= refreshAfter)) {
    scan = new AbortController();
    void refresh(scan);
  }
  return { findings: [...found.values()].flat(), status };
}
