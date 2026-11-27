// Time-series chart: SVG lines/bars/area on one y axis, a crosshair shared by all
// charts in a sync group, keyboard navigation and a data-table alternative.
import { h, s } from '../dom';
import { dayLabel, fullDate, monthYear } from './format';
import type { Lang } from './format';
import type { Nullable } from './parse';
import { decimate, extent, linear, padded, ticks } from './scale';
import type { Scale } from './scale';
import { fill, strings } from './strings';
import { disclosure, empty, observeWidth, scroller, table, uid } from './ui';

export type Tone = 'text' | 's1' | 's2' | 's3' | 'gold';

export interface SeriesSpec {
  label: string;
  values: Nullable[];
  tone: Tone;
  kind?: 'line' | 'area' | 'bars' | 'signbars';
  dash?: string;
}

export interface TimeChartSpec {
  title: string;
  unit: string;
  lang: Lang;
  times: number[];
  series: SeriesSpec[];
  /** Series that the data did not supply, named under the chart. */
  absent?: string[];
  band?: { label: string; upper: Nullable[]; lower: Nullable[] };
  refs?: number[];
  domain?: [number, number];
  zero?: boolean;
  height: number;
  format(value: number): string;
  axis(value: number): string;
  /** 'time' spaces points by date (for series with gaps in the calendar). */
  spacing?: 'index' | 'time';
  barSummary?: 'mean' | 'extreme';
  sync: Sync;
}

export class Sync {
  private listeners: ((time: number | null) => void)[] = [];
  subscribe(listener: (time: number | null) => void): void {
    this.listeners.push(listener);
  }
  set(time: number | null): void {
    for (const listener of this.listeners) listener(time);
  }
}

export interface TimeChart {
  el: HTMLElement;
  /** Show points with time >= since. */
  setSince(since: number): void;
}

const TABLE_CAP = 120;
const MARGIN = { left: 4, right: 62, top: 8, bottom: 18 };

function nearest(times: number[], time: number, from: number, to: number): number {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) < time) lo = mid + 1;
    else hi = mid;
  }
  const before = lo - 1;
  if (before >= from && time - (times[before] as number) <= (times[lo] as number) - time) return before;
  return lo;
}

export function timeChart(spec: TimeChartSpec): TimeChart {
  const { lang, times } = spec;
  const t = strings(lang);
  const last = times.length - 1;
  const heading = h(
    'div',
    { class: 'mbx-chart-head' },
    h('h4', {}, spec.title),
    h('span', { class: 'mbx-unit' }, spec.unit),
  );
  const series = spec.series.filter((line) => line.values.some((v) => v !== null));
  const absentNames = [...(spec.absent ?? []), ...spec.series.filter((l) => !series.includes(l)).map((l) => l.label)];
  if (series.length === 0 || last < 0) {
    return { el: h('figure', { class: 'mbx-chart' }, heading, empty(lang)), setSince: () => {} };
  }

  const dateText = h('span', { class: 'mbx-readout-date' });
  const cells = series.map((line) => ({ line, value: h('b', {}) }));
  const bandValue = spec.band ? h('b', {}) : null;
  const legend = h(
    'div',
    { class: 'mbx-legend' },
    dateText,
    ...cells.map(({ line, value }) => h('span', { class: 'mbx-key' }, swatch(line), h('em', {}, line.label), value)),
    spec.band && bandValue
      ? h('span', { class: 'mbx-key' }, h('i', { class: 'mbx-swatch-band' }), h('em', {}, spec.band.label), bandValue)
      : null,
  );

  const host = h('div', { class: 'mbx-plot', style: `min-height:${spec.height}px` });
  const live = h('span', { class: 'mbx-sr', 'aria-live': 'polite' });
  const footnote = h('p', { class: 'mbx-note', hidden: true });
  const helpId = uid('help');

  let from = 0;
  const to = last;
  let width = 0;
  let cursor: number | null = null;
  let paintCursor: (index: number | null) => void = () => {};
  let showEveryRow = false;

  const text = (v: Nullable | undefined) => (v === null || v === undefined ? t.noData : spec.format(v));

  const readout = (index: number) => {
    dateText.textContent = fullDate(times[index] as number, lang);
    for (const { line, value } of cells) {
      value.textContent = text(line.values[index]);
      value.className = line.values[index] === null ? 'mbx-missing' : '';
    }
    if (bandValue && spec.band) {
      const lo = spec.band.lower[index];
      const hi = spec.band.upper[index];
      bandValue.textContent = lo === null || hi === null ? t.noData : `${text(lo)} – ${text(hi)}`;
    }
  };

  const columns = () => [
    ...series.map((line) => ({ label: line.label, values: line.values })),
    ...(spec.band
      ? [
          { label: `${spec.band.label}: ${t.upper}`, values: spec.band.upper },
          { label: `${spec.band.label}: ${t.lower}`, values: spec.band.lower },
        ]
      : []),
  ];

  const data = disclosure(t.dataTable, () => {
    const cols = columns();
    const rows: Node[] = [];
    const total = to - from + 1;
    const limit = showEveryRow ? total : Math.min(total, TABLE_CAP);
    for (let k = 0; k < limit; k++) {
      const i = to - k;
      rows.push(
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, fullDate(times[i] as number, lang)),
          ...cols.map((c) => h('td', { class: 'num' }, text(c.values[i]))),
        ),
      );
    }
    const grid = table(spec.title, [{ text: t.date }, ...cols.map((c) => ({ text: c.label, numeric: true }))], rows);
    const wrap = h('div', {}, scroller(grid, spec.title, 'mbx-short'));
    if (limit < total) {
      wrap.append(
        h(
          'button',
          {
            type: 'button',
            class: 'mbx-button',
            onclick: () => {
              showEveryRow = true;
              data.refresh();
            },
          },
          fill(t.showAll, { n: total }),
        ),
      );
    }
    return wrap;
  });

  const summary = () => {
    const lead = series[0] as SeriesSpec;
    const range = extent([lead.values], from, to);
    let firstValue: Nullable = null;
    let lastValue: Nullable = null;
    for (let i = from; i <= to; i++) {
      const v = lead.values[i] ?? null;
      if (v === null) continue;
      firstValue ??= v;
      lastValue = v;
    }
    const parts = [spec.title, `${fullDate(times[from] as number, lang)} – ${fullDate(times[to] as number, lang)}`];
    if (range) {
      parts.push(
        `${lead.label}: ${t.first} ${text(firstValue)}, ${t.last} ${text(lastValue)}, ${t.min} ${text(range[0])}, ${t.max} ${text(range[1])}`,
      );
    }
    return parts.join('. ');
  };

  const draw = () => {
    if (width < 40) return;
    paintCursor = () => {};
    const lists = series.map((line) => line.values);
    if (spec.band) lists.push(spec.band.upper, spec.band.lower);
    const found = from <= to ? extent(lists, from, to) : null;
    if (!found) {
      host.replaceChildren(empty(lang, t.noRange));
      footnote.hidden = absentNames.length === 0;
      footnote.textContent = absentNames.length ? fill(t.noSeries, { list: absentNames.join(', ') }) : '';
      return;
    }
    const height = spec.height;
    const plotW = width - MARGIN.left - MARGIN.right;
    const plotH = height - MARGIN.top - MARGIN.bottom;
    const barsPresent = series.some((l) => l.kind === 'bars' || l.kind === 'signbars');
    const zero = spec.zero === true || series.some((l) => l.kind === 'bars' || l.kind === 'signbars' || l.kind === 'area');
    const [lo, hi] = spec.domain ?? padded(found, zero);
    const y: Scale = linear(lo, hi, MARGIN.top + plotH, MARGIN.top);
    const count = to - from + 1;
    const byTime = spec.spacing === 'time';
    const t0 = times[from] as number;
    const t1 = times[to] as number;
    // Slot width: one session, or one day when spaced by date.
    const slot = byTime ? plotW / Math.max(1, (t1 - t0) / 86_400_000 + 1) : plotW / count;
    const x: Scale = byTime
      ? (i) => MARGIN.left + slot / 2 + (((times[i] as number) - t0) / Math.max(1, t1 - t0)) * (plotW - slot)
      : (i) => MARGIN.left + (i - from + 0.5) * slot;

    const svg = s('svg', {
      class: 'mbx-svg',
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      tabindex: 0,
      role: 'group',
      'aria-label': summary(),
      'aria-describedby': helpId,
    });

    for (const v of ticks(lo, hi, Math.max(2, Math.floor(plotH / 34)))) {
      svg.append(
        s('line', { class: 'mbx-grid', x1: MARGIN.left, x2: MARGIN.left + plotW, y1: y(v), y2: y(v) }),
        s('text', { class: 'mbx-axis', x: MARGIN.left + plotW + 6, y: y(v) + 3.5 }, spec.axis(v)),
      );
    }
    const labels = Math.max(2, Math.min(8, Math.floor(plotW / 92), count));
    const long = t1 - t0 > 400 * 86_400_000;
    for (let k = 0; k < labels && count > 0; k++) {
      const share = labels === 1 ? 0 : k / (labels - 1);
      const i = byTime ? nearest(times, t0 + share * (t1 - t0), from, to) : from + Math.round(share * (count - 1));
      const anchor = count === 1 ? 'middle' : k === 0 ? 'start' : k === labels - 1 ? 'end' : 'middle';
      const px = anchor === 'start' ? MARGIN.left : anchor === 'end' ? MARGIN.left + plotW : x(i);
      svg.append(
        s(
          'text',
          { class: 'mbx-axis', x: px, y: height - 5, 'text-anchor': anchor },
          long ? monthYear(times[i] as number, lang) : dayLabel(times[i] as number, lang),
        ),
      );
    }

    if (spec.band) drawBand(svg, spec.band.upper, spec.band.lower, from, to, plotW, x, y);

    let bucketed = false;
    for (const line of series) {
      if (line.kind !== 'bars' && line.kind !== 'signbars') continue;
      const perBar = byTime ? 1 : Math.max(1, Math.ceil(2 / slot));
      if (perBar > 1) bucketed = true;
      const barW = Math.max(1, Math.min(14, slot * perBar * 0.7));
      let up = '';
      let down = '';
      for (let start = from; start <= to; start += perBar) {
        const end = Math.min(to, start + perBar - 1);
        let sum = 0;
        let n = 0;
        let extreme = 0;
        for (let i = start; i <= end; i++) {
          const v = line.values[i];
          if (v === null || v === undefined) continue;
          sum += v;
          n += 1;
          if (Math.abs(v) >= Math.abs(extreme)) extreme = v;
        }
        if (n === 0) continue;
        const v = spec.barSummary === 'extreme' ? extreme : sum / n;
        const cx = (x(start) + x(end)) / 2;
        const top = Math.min(y(v), y(0));
        const size = Math.max(v === 0 ? 0 : 0.8, Math.abs(y(v) - y(0)));
        const rect = `M${(cx - barW / 2).toFixed(1)} ${top.toFixed(1)}h${barW.toFixed(1)}v${size.toFixed(1)}h${(-barW).toFixed(1)}z`;
        if (v < 0) down += rect;
        else up += rect;
      }
      const signed = line.kind === 'signbars';
      if (up) svg.append(s('path', { class: `mbx-bar ${signed ? 'pos' : line.tone}`, d: up }));
      if (down) svg.append(s('path', { class: `mbx-bar ${signed ? 'neg' : line.tone}`, d: down }));
    }

    if (lo < 0 && hi > 0) {
      svg.append(s('line', { class: 'mbx-zeroline', x1: MARGIN.left, x2: MARGIN.left + plotW, y1: y(0), y2: y(0) }));
    }
    for (const ref of spec.refs ?? []) {
      if (ref < lo || ref > hi) continue;
      svg.append(s('line', { class: 'mbx-ref', x1: MARGIN.left, x2: MARGIN.left + plotW, y1: y(ref), y2: y(ref) }));
    }

    let decimated = false;
    for (const line of [...series].reverse()) {
      if (line.kind === 'bars' || line.kind === 'signbars') continue;
      if (!byTime && count > plotW * 1.5) decimated = true;
      const points = decimate(line.values, from, to, byTime ? count : plotW);
      let d = '';
      let area = '';
      let run: string[] = [];
      let runStart = 0;
      let runEnd = 0;
      const flush = () => {
        if (run.length === 0) return;
        // An isolated point still needs a visible mark.
        d += `M${run.join('L')}${run.length === 1 ? 'h0.01' : ''}`;
        if (line.kind === 'area') area += `M${runStart.toFixed(1)} ${y(0).toFixed(1)}L${run.join('L')}L${runEnd.toFixed(1)} ${y(0).toFixed(1)}z`;
        run = [];
      };
      for (const i of points) {
        if (i === null) {
          flush();
          continue;
        }
        const px = x(i);
        if (run.length === 0) runStart = px;
        runEnd = px;
        run.push(`${px.toFixed(1)} ${y(line.values[i] as number).toFixed(1)}`);
      }
      flush();
      if (area) svg.append(s('path', { class: `mbx-area ${line.tone}`, d: area }));
      svg.append(s('path', { class: `mbx-line ${line.tone}`, d, 'stroke-dasharray': line.dash ?? null }));
    }

    const cross = s('line', { class: 'mbx-cross', y1: MARGIN.top, y2: MARGIN.top + plotH, visibility: 'hidden' });
    const dots = series
      .filter((l) => l.kind !== 'bars' && l.kind !== 'signbars')
      .map((line) => ({ line, node: s('circle', { class: `mbx-dot ${line.tone}`, r: 3, visibility: 'hidden' }) }));
    svg.append(cross, ...dots.map((d) => d.node));

    paintCursor = (index) => {
      const visible = index !== null;
      cross.setAttribute('visibility', visible ? 'visible' : 'hidden');
      if (index !== null) {
        cross.setAttribute('x1', String(x(index)));
        cross.setAttribute('x2', String(x(index)));
      }
      for (const { line, node } of dots) {
        const v = index === null ? null : (line.values[index] ?? null);
        node.setAttribute('visibility', v === null ? 'hidden' : 'visible');
        if (index !== null && v !== null) {
          node.setAttribute('cx', String(x(index)));
          node.setAttribute('cy', String(y(v)));
        }
      }
    };

    const pointer = (event: PointerEvent) => {
      const box = svg.getBoundingClientRect();
      const px = ((event.clientX - box.left) / (box.width || width)) * width;
      const index = byTime
        ? nearest(times, t0 + ((px - MARGIN.left - slot / 2) / Math.max(1, plotW - slot)) * (t1 - t0), from, to)
        : Math.max(from, Math.min(to, from + Math.floor((px - MARGIN.left) / slot)));
      spec.sync.set(times[index] as number);
    };
    svg.addEventListener('pointermove', pointer);
    svg.addEventListener('pointerdown', pointer);
    svg.addEventListener('pointerleave', (event) => {
      // Touch keeps the last reading on screen after the finger lifts.
      if (event.pointerType !== 'touch') spec.sync.set(null);
    });
    svg.addEventListener('blur', () => spec.sync.set(null));
    svg.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 10 : 1;
      let next = cursor ?? to;
      if (event.key === 'ArrowLeft') next -= step;
      else if (event.key === 'ArrowRight') next += step;
      else if (event.key === 'Home') next = from;
      else if (event.key === 'End') next = to;
      else if (event.key === 'Escape') {
        spec.sync.set(null);
        return;
      } else return;
      event.preventDefault();
      next = Math.max(from, Math.min(to, next));
      spec.sync.set(times[next] as number);
      live.textContent = [
        fullDate(times[next] as number, lang),
        ...series.map((l) => `${l.label} ${text(l.values[next])}`),
      ].join(', ');
    });

    const hadFocus = host.contains(document.activeElement);
    host.replaceChildren(svg);
    if (hadFocus) svg.focus({ preventScroll: true });

    const notes: string[] = [];
    if (absentNames.length) notes.push(fill(t.noSeries, { list: absentNames.join(', ') }));
    if (decimated) notes.push(t.downsampled);
    if (barsPresent && bucketed) notes.push(spec.barSummary === 'extreme' ? t.barsExtreme : t.barsMean);
    footnote.textContent = notes.join(' ');
    footnote.hidden = notes.length === 0;
    paintCursor(cursor);
  };

  spec.sync.subscribe((time) => {
    if (time === null || from > to) cursor = null;
    else if (time < (times[from] as number) || time > (times[to] as number)) cursor = null;
    else cursor = nearest(times, time, from, to);
    paintCursor(cursor);
    if (from <= to) readout(cursor ?? to);
  });

  readout(to);
  observeWidth(host, (w) => {
    width = w;
    draw();
  });

  const el = h(
    'figure',
    { class: 'mbx-chart' },
    heading,
    legend,
    host,
    h('span', { class: 'mbx-sr', id: helpId }, t.chartKeys),
    live,
    footnote,
    data.el,
  );

  return {
    el,
    setSince(since) {
      let index = 0;
      while (index < times.length && (times[index] as number) < since) index += 1;
      from = index;
      cursor = null;
      showEveryRow = false;
      readout(Math.max(0, to));
      draw();
      data.refresh();
    },
  };
}

function swatch(line: SeriesSpec): SVGElement {
  const kind = line.kind ?? 'line';
  const mark =
    kind === 'line'
      ? s('line', { class: `mbx-line ${line.tone}`, x1: 0, x2: 18, y1: 5, y2: 5, 'stroke-dasharray': line.dash ?? null })
      : kind === 'signbars'
        ? s('g', {}, s('rect', { class: 'mbx-bar pos', x: 2, y: 0, width: 5, height: 5 }), s('rect', { class: 'mbx-bar neg', x: 10, y: 5, width: 5, height: 5 }))
        : s('rect', { class: `${kind === 'area' ? 'mbx-area' : 'mbx-bar'} ${line.tone}`, x: 3, y: 1, width: 12, height: 8 });
  return s('svg', { class: 'mbx-swatch', width: 18, height: 10, viewBox: '0 0 18 10', 'aria-hidden': 'true' }, mark);
}

function drawBand(
  svg: SVGSVGElement,
  upper: Nullable[],
  lower: Nullable[],
  from: number,
  to: number,
  plotW: number,
  x: Scale,
  y: Scale,
): void {
  const step = Math.max(1, Math.floor((to - from + 1) / plotW));
  let fillPath = '';
  let edges = '';
  let top: string[] = [];
  let bottom: string[] = [];
  const flush = () => {
    if (top.length > 1) {
      fillPath += `M${top.join('L')}L${[...bottom].reverse().join('L')}z`;
      edges += `M${top.join('L')}M${bottom.join('L')}`;
    }
    top = [];
    bottom = [];
  };
  for (let start = from; start <= to; start += step) {
    let hi: number | null = null;
    let lo: number | null = null;
    for (let i = start; i <= Math.min(to, start + step - 1); i++) {
      const u = upper[i] ?? null;
      const l = lower[i] ?? null;
      if (u !== null) hi = hi === null ? u : Math.max(hi, u);
      if (l !== null) lo = lo === null ? l : Math.min(lo, l);
    }
    if (hi === null || lo === null) {
      flush();
      continue;
    }
    const px = x(start).toFixed(1);
    top.push(`${px} ${y(hi).toFixed(1)}`);
    bottom.push(`${px} ${y(lo).toFixed(1)}`);
  }
  flush();
  svg.append(s('path', { class: 'mbx-band', d: fillPath }), s('path', { class: 'mbx-band-edge', d: edges }));
}
