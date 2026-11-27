// Small hand-drawn SVG charts for the Model view. They scale uniformly with the
// card, and each carries a text summary for screen readers.
import { barDate, h, s } from './dom';
import { t } from './i18n';

const WIDTH = 360;
const LEFT = 4;
const RIGHT = 46;
const TOP = 8;
const BOTTOM = 18;

export interface Point {
  x: number;
  y: number;
}

export interface LineSpec {
  name: string;
  points: Point[];
  band?: { x: number; low: number; high: number }[];
  reference?: number | null;
  /** Vertical lines at these x values. */
  marks?: number[];
  domain?: [number, number];
  height?: number;
  format(y: number): string;
  /** Label of an x value; dates by default. */
  xLabel?(x: number): string;
}

export function lineChart(spec: LineSpec): HTMLElement {
  const { points, band = [], format } = spec;
  const caption = h('figcaption', {}, spec.name);
  if (points.length < 2) return h('figure', { class: 'spark' }, caption, h('p', { class: 'muted' }, t('noSeries')));
  const xLabel = spec.xLabel ?? ((x: number) => barDate(x, points.length > 200));
  const height = spec.height ?? 130;
  const plotW = WIDTH - LEFT - RIGHT;
  const plotH = height - TOP - BOTTOM;

  const x0 = (points[0] as Point).x;
  const x1 = (points[points.length - 1] as Point).x;
  const values = points.map((p) => p.y);
  const min = Math.min(...values);
  const max = Math.max(...values);
  let [low, high] = spec.domain ?? [
    Math.min(min, ...band.map((b) => b.low), spec.reference ?? min),
    Math.max(max, ...band.map((b) => b.high), spec.reference ?? max),
  ];
  if (!spec.domain) {
    const pad = (high - low) * 0.08 || Math.abs(high) * 0.05 || 1;
    low -= pad;
    high += pad;
  }
  const x = (v: number) => LEFT + (x1 === x0 ? plotW / 2 : ((v - x0) / (x1 - x0)) * plotW);
  const y = (v: number) => TOP + (1 - (v - low) / (high - low)) * plotH;
  const path = (list: Point[]) =>
    list.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)} ${y(p.y).toFixed(1)}`).join('');
  const last = points[points.length - 1] as Point;

  const svg = s('svg', {
    viewBox: `0 0 ${WIDTH} ${height}`,
    role: 'img',
    'aria-label': t('chartSummary', {
      name: spec.name,
      from: xLabel(x0),
      to: xLabel(x1),
      last: format(last.y),
      min: format(min),
      max: format(max),
    }),
  });

  for (const v of [low + (high - low) * 0.08, (low + high) / 2, high - (high - low) * 0.08]) {
    svg.append(
      s('line', { class: 'grid', x1: LEFT, x2: LEFT + plotW, y1: y(v), y2: y(v) }),
      s('text', { class: 'axis', x: LEFT + plotW + 5, y: y(v) + 3.5 }, format(v)),
    );
  }
  if (band.length > 1) {
    const upper = path(band.map((b) => ({ x: b.x, y: b.high })));
    const lower = [...band]
      .reverse()
      .map((b) => `L${x(b.x).toFixed(1)} ${y(b.low).toFixed(1)}`)
      .join('');
    svg.append(s('path', { class: 'band', d: `${upper}${lower}Z` }));
  }
  for (const mark of spec.marks ?? []) {
    if (mark < x0 || mark > x1) continue;
    svg.append(s('line', { class: 'mark', x1: x(mark), x2: x(mark), y1: TOP, y2: TOP + plotH }));
  }
  if (spec.reference !== undefined && spec.reference !== null && spec.reference >= low && spec.reference <= high) {
    svg.append(
      s('line', { class: 'reference', x1: LEFT, x2: LEFT + plotW, y1: y(spec.reference), y2: y(spec.reference) }),
    );
  }
  svg.append(
    s('path', { class: 'line', d: path(points) }),
    s('circle', { class: 'end', cx: x(last.x), cy: y(last.y), r: 2.5 }),
    s('text', { class: 'axis', x: LEFT, y: height - 5 }, xLabel(x0)),
    s('text', { class: 'axis', x: LEFT + plotW, y: height - 5, 'text-anchor': 'end' }, xLabel(x1)),
  );
  return h('figure', { class: 'spark' }, caption, svg);
}

/** Horizontal bars with the value printed beside each; missing values say so. */
export function barChart(
  name: string,
  rows: { label: string; value: number | null }[],
  format: (value: number) => string,
): HTMLElement {
  const max = Math.max(0, ...rows.map((r) => r.value ?? 0));
  return h(
    'figure',
    { class: 'spark' },
    h('figcaption', {}, name),
    h(
      'ul',
      { class: 'hbars' },
      ...rows.map((item) => {
        const bar = s('rect', {
          class: 'hbar',
          x: 0,
          y: 0,
          height: 8,
          width: item.value === null || max <= 0 ? 0 : (item.value / max) * 100,
        });
        return h(
          'li',
          {},
          h('span', {}, item.label),
          s(
            'svg',
            { viewBox: '0 0 100 8', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
            s('rect', { class: 'hbar-track', x: 0, y: 0, width: 100, height: 8 }),
            bar,
          ),
          h('b', { class: 'mono' }, item.value === null ? t('noData') : format(item.value)),
        );
      }),
    ),
  );
}
