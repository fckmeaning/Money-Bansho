// Large charts and the greeting of the market overview. The series and metrics come
// from the screener response (one year of daily closes per company).
import { h, pct, s } from './dom';
import { regionName, t, uiLang, locale } from './i18n';
import { panel } from './panels';
import { REGIONS } from './types';
import type { Board, WireEvent } from './types';

export interface ScreenerLite {
  rows: { symbol: string; name: string; region: string; vol: number | null; ret: number | null; spark: number[]; outlook: unknown }[];
  /** Out-of-sample record of the corridor in `outlook`. */
  forecastEvidence: unknown;
}

const W = 700;
const H = 380;
const PAD = { left: 52, right: 14, top: 14, bottom: 30 };
const REGION_COLOUR: Record<string, string> = {
  us: '#5b7fd1',
  china: '#d4a94a',
  europe: '#6fb3e0',
  israel: '#8aa0c8',
  korea: '#5566a8',
};

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function fetchScreenerLite(signal: AbortSignal): Promise<ScreenerLite> {
  const res = await fetch('/api/dossier?view=screener', { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { rows?: unknown; forecastEvidence?: unknown };
  if (!Array.isArray(body.rows)) throw new Error('invalid-response');
  return {
    forecastEvidence: body.forecastEvidence,
    rows: body.rows.map((raw) => {
      const row = raw as { symbol?: string; name?: string; region?: string; values?: Record<string, unknown>; spark?: unknown[]; outlook?: unknown };
      return {
        symbol: String(row.symbol ?? ''),
        name: String(row.name ?? ''),
        region: String(row.region ?? ''),
        vol: finite(row.values?.vol20),
        ret: finite(row.values?.return3m),
        spark: Array.isArray(row.spark) ? row.spark.filter((v): v is number => finite(v) !== null) : [],
        outlook: row.outlook,
      };
    }),
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/** Evenly spaced round values covering [min, max]. */
function ticks(min: number, max: number, count = 5): number[] {
  const raw = (max - min) / count || 1;
  const unit = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * unit >= raw) ?? 10) * unit;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step / 1000; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

const label = (x: number, y: number, value: string, anchor = 'middle', cls = ''): SVGElement =>
  s('text', { x, y, 'text-anchor': anchor, class: cls }, value);

const number = (v: number): string => v.toLocaleString(locale(), { maximumFractionDigits: 1 });

function frame(title: string, marks: SVGElement[]): SVGElement {
  return s('svg', { class: 'ov-big-plot', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title }, ...marks);
}

/** Median path of each region's companies, first point of the year = 100. */
function regionLines(data: ScreenerLite): HTMLElement {
  const series = REGIONS.flatMap((region) => {
    const members = data.rows.filter((r) => r.region === region && r.spark.length > 1);
    if (!members.length) return [];
    const length = Math.min(...members.map((r) => r.spark.length));
    const values = Array.from({ length }, (_, i) => median(members.map((r) => r.spark[i] as number)));
    return [{ region, values }];
  });
  if (!series.length) return h('div', { class: 'empty' }, t('noData'));
  const all = series.flatMap((x) => x.values);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const x = (i: number, n: number) => PAD.left + (i / (n - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - min) / (max - min || 1)) * (H - PAD.top - PAD.bottom);
  const grid = ticks(min, max).flatMap((v) => [
    s('line', { class: v === 100 ? 'ov-base' : 'ov-grid', x1: PAD.left, x2: W - PAD.right, y1: y(v), y2: y(v) }),
    label(PAD.left - 8, y(v) + 4, number(v), 'end'),
  ]);
  const lines = series.map(({ region, values }) => {
    const line = s('polyline', { class: 'ov-line', points: values.map((v, i) => `${x(i, values.length)},${y(v)}`).join(' ') });
    line.setAttribute('stroke', REGION_COLOUR[region] ?? '#8a95a5');
    return line;
  });
  const legend = h(
    'ul',
    { class: 'ov-legend' },
    ...series.map(({ region, values }) => {
      const swatch = h('i', {});
      swatch.style.background = REGION_COLOUR[region] ?? '#8a95a5';
      const change = (values[values.length - 1] as number) - 100;
      return h('li', {}, swatch, regionName(region), h('b', { class: `mono ${change < 0 ? 'down' : 'up'}` }, pct(change)));
    }),
  );
  return h(
    'div',
    {},
    frame(t('chartRegions'), [
      ...grid,
      ...lines,
      label(PAD.left, H - 8, t('yearAgo'), 'start'),
      label(W - PAD.right, H - 8, t('now'), 'end'),
    ]) as unknown as Node,
    legend,
  );
}

/** Each company: 20-day volatility against its three-month return. */
function riskReturn(data: ScreenerLite, onOpen: (symbol: string) => void): HTMLElement {
  const points = data.rows.flatMap((r) => (r.vol === null || r.ret === null ? [] : [{ ...r, vol: r.vol, ret: r.ret }]));
  if (points.length < 2) return h('div', { class: 'empty' }, t('noData'));
  const maxVol = Math.max(...points.map((p) => p.vol)) * 1.05;
  const minRet = Math.min(0, ...points.map((p) => p.ret));
  const maxRet = Math.max(0, ...points.map((p) => p.ret));
  const x = (v: number) => PAD.left + (v / maxVol) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - minRet) / (maxRet - minRet || 1)) * (H - PAD.top - PAD.bottom);
  const extremes = new Set(
    [
      ...[...points].sort((a, b) => b.ret - a.ret).slice(0, 4),
      ...[...points].sort((a, b) => a.ret - b.ret).slice(0, 4),
      ...[...points].sort((a, b) => b.vol - a.vol).slice(0, 3),
    ].map((p) => p.symbol),
  );
  const grid = [
    ...ticks(minRet, maxRet).flatMap((v) => [
      s('line', { class: v === 0 ? 'ov-base' : 'ov-grid', x1: PAD.left, x2: W - PAD.right, y1: y(v), y2: y(v) }),
      label(PAD.left - 8, y(v) + 4, `${number(v)}%`, 'end'),
    ]),
    ...ticks(0, maxVol).map((v) => label(x(v), H - 14, `${number(v)}%`)),
  ];
  const dots = points.flatMap((p) => {
    const dot = s(
      'circle',
      { class: 'ov-dot', cx: x(p.vol), cy: y(p.ret), r: 5, onclick: () => onOpen(p.symbol) },
      s('title', {}, `${p.symbol} ${p.name}: ${t('axisReturn')} ${pct(p.ret)}, ${t('axisVol')} ${number(p.vol)}%`),
    );
    dot.setAttribute('fill', REGION_COLOUR[p.region] ?? '#8a95a5');
    const right = x(p.vol) > W - 90;
    return extremes.has(p.symbol)
      ? [dot, label(x(p.vol) + (right ? -8 : 8), y(p.ret) + 4, p.symbol, right ? 'end' : 'start', 'ov-name')]
      : [dot];
  });
  return h(
    'div',
    {},
    frame(t('chartRisk'), [...grid, ...dots]) as unknown as Node,
    h('p', { class: 'explain' }, t('chartRiskNote')),
  );
}

export function bigCharts(data: ScreenerLite | null, failed: boolean, onOpen: (symbol: string) => void): HTMLElement {
  const waiting = () => h('div', { class: 'empty ov-wait' }, failed ? t('noData') : t('loading'));
  return h(
    'div',
    { class: 'ov-big' },
    panel(t('chartRegions'), null, data ? regionLines(data) : waiting()),
    panel(t('chartRisk'), null, data ? riskReturn(data, onOpen) : waiting()),
  );
}

/** A short welcome line with today's date and what the wire holds right now. */
export function greeting(board: Board | null, events: WireEvent[] | null, onOpen: (symbol: string) => void): HTMLElement {
  const now = new Date();
  const hour = now.getHours();
  const key = hour < 5 ? 'helloNight' : hour < 12 ? 'helloMorning' : hour < 18 ? 'helloDay' : 'helloEvening';
  const date = now.toLocaleDateString(uiLang() === 'ru' ? 'ru-RU' : 'en-US', { weekday: 'long', day: 'numeric', month: 'long' });
  const quotes = board ? [...board.quotes.values()].filter((q) => q.changePct !== null) : [];
  const summary =
    quotes.length && events
      ? t('helloSummary', {
          up: quotes.filter((q) => (q.changePct as number) > 0).length,
          total: quotes.length,
          lead: events.filter((e) => e.type === 'leadership').length,
        })
      : t('loading');
  return h(
    'section',
    { class: 'hello' },
    h('div', {}, h('h1', {}, t(key)), h('p', {}, h('span', { class: 'gold' }, date), ` · ${summary}`)),
    h(
      'div',
      { class: 'hello-links' },
      h('span', { class: 'muted' }, t('helloOpen')),
      ...(['NVDA', '0700.HK', 'TEVA.TA'] as const).map((symbol) =>
        h('button', { type: 'button', class: 'chip mono', 'data-key': `hello-${symbol}`, onclick: () => onOpen(symbol) }, symbol),
      ),
    ),
  );
}
