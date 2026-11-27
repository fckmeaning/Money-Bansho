// Hand-drawn SVG price chart: close line, volume, and one marker lane per event
// type aligned to the trading-day axis.
import { DASH, barDate, compact, h, pct, price, s, shape, stamp, tone } from './dom';
import { t, typeName } from './i18n';
import { EVENT_TYPES } from './types';
import type { Bar, DossierEvent, EventType } from './types';

const DAY = 86_400_000;

export interface ChartOptions {
  symbol: string;
  history: Bar[];
  events: DossierEvent[];
  activeTypes: ReadonlySet<EventType>;
  selectedId: string | null;
  onHover(ids: string[]): void;
  onSelect(id: string): void;
  onType(type: EventType): void;
}

export interface Chart {
  hover(ids: string[]): void;
  select(id: string | null): void;
}

/** Last bar at or before the event; -1 when the event predates the chart. */
export function barIndex(history: Bar[], time: number): number {
  const first = history[0];
  if (!first || time < first.t - 1.5 * DAY) return -1;
  let lo = 0;
  let hi = history.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((history[mid] as Bar).t <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function ticks(min: number, max: number, count: number): number[] {
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}

interface Cluster {
  index: number;
  type: EventType;
  events: DossierEvent[];
  node: SVGGElement;
}

export function renderChart(host: HTMLElement, options: ChartOptions): Chart {
  const { history, events, activeTypes } = options;
  const noop: Chart = { hover: () => {}, select: () => {} };
  host.replaceChildren();
  if (history.length === 0) {
    host.append(h('div', { class: 'empty chart-empty' }, t('noPrices')));
    return noop;
  }

  const width = Math.max(280, Math.floor(host.clientWidth));
  const narrow = width < 560;
  const left = narrow ? 18 : 92;
  const right = narrow ? 48 : 62;
  const plotW = width - left - right;
  const short = window.innerHeight < 860;
  const priceH = Math.round(Math.max(150, Math.min(330, window.innerHeight * (short ? 0.22 : 0.28))));
  const volH = short ? 28 : 36;
  const laneH = short ? 13 : 15;
  const axisH = 18;

  const placed = events
    .map((event) => ({ event, index: barIndex(history, event.time) }))
    .filter((p) => p.index >= 0);
  const lanes = EVENT_TYPES.filter((type) => placed.some((p) => p.event.type === type));
  const volTop = priceH + 6;
  const laneTop = volTop + volH + 8;
  const height = laneTop + lanes.length * laneH + axisH;

  const n = history.length;
  const x = (i: number) => left + 6 + (n === 1 ? (plotW - 12) / 2 : (i / (n - 1)) * (plotW - 12));
  let min = Infinity;
  let max = -Infinity;
  let maxVol = 0;
  for (const bar of history) {
    min = Math.min(min, bar.c);
    max = Math.max(max, bar.c);
    maxVol = Math.max(maxVol, bar.v ?? 0);
  }
  const pad = (max - min) * 0.08 || Math.abs(max) * 0.01 || 1;
  min -= pad;
  max += pad;
  const y = (v: number) => 6 + (1 - (v - min) / (max - min)) * (priceH - 12);
  const first = history[0] as Bar;
  const last = history[n - 1] as Bar;

  const readout = h('div', { class: 'readout mono', 'aria-live': 'off' });
  const showReadout = (i: number) => {
    const bar = history[i] as Bar;
    const prev = history[i - 1];
    const day = prev ? (bar.c / prev.c - 1) * 100 : null;
    const total = (bar.c / first.c - 1) * 100;
    const cell = (label: string, value: string, cls = '') =>
      h('span', {}, h('em', {}, label), h('b', { class: cls }, value));
    readout.replaceChildren(
      h('span', { class: 'readout-date' }, barDate(bar.t, true)),
      cell(t('close'), price(bar.c)),
      cell(t('day'), pct(day), tone(day)),
      cell(t('fromStart'), pct(total), tone(total)),
      cell(t('vol'), bar.v ? compact(bar.v) : DASH),
    );
  };

  const svg = s('svg', {
    class: 'chart-svg',
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'group',
    'aria-label': t('chartAria', { symbol: options.symbol }),
  });

  // Grid and axes
  for (const v of ticks(min, max, 5)) {
    svg.append(
      s('line', { class: 'grid', x1: left, x2: left + plotW, y1: y(v), y2: y(v) }),
      s('text', { class: 'axis', x: left + plotW + 6, y: y(v) + 3.5 }, price(v)),
    );
  }
  const labels = Math.max(2, Math.min(7, Math.floor(plotW / 96)));
  const used = new Set<number>();
  for (let k = 0; k < labels; k++) {
    const i = Math.round((k / (labels - 1)) * (n - 1));
    if (used.has(i)) continue;
    used.add(i);
    const anchor = n === 1 ? 'middle' : k === 0 ? 'start' : k === labels - 1 ? 'end' : 'middle';
    svg.append(
      s('line', { class: 'grid', x1: x(i), x2: x(i), y1: 0, y2: height - axisH }),
      s(
        'text',
        { class: 'axis', x: x(i), y: height - 5, 'text-anchor': anchor },
        barDate((history[i] as Bar).t, n > 200),
      ),
    );
  }

  // Volume
  if (maxVol > 0) {
    const barW = Math.max(1, Math.min(14, (plotW / n) * 0.65));
    history.forEach((bar, i) => {
      if (!bar.v) return;
      const prev = history[i - 1];
      const hgt = Math.max(1, (bar.v / maxVol) * volH);
      svg.append(
        s('rect', {
          class: `volume ${prev ? tone(bar.c - prev.c, 1e-9) : 'flat'}`,
          x: x(i) - barW / 2,
          y: volTop + volH - hgt,
          width: barW,
          height: hgt,
        }),
      );
    });
    svg.append(s('text', { class: 'axis', x: left + plotW + 6, y: volTop + 9 }, compact(maxVol)));
  }

  // Price line, range-start baseline, last price tag
  svg.append(
    s('line', { class: 'baseline', x1: left, x2: left + plotW, y1: y(first.c), y2: y(first.c) }),
    s('path', {
      class: 'price-line',
      d: history.map((bar, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(bar.c).toFixed(1)}`).join(''),
    }),
    s('circle', { class: 'price-end', cx: x(n - 1), cy: y(last.c), r: 2.5 }),
    s('rect', { class: 'last-tag', x: left + plotW + 2, y: y(last.c) - 8, width: right - 3, height: 16 }),
    s('text', { class: 'last-text', x: left + plotW + 6, y: y(last.c) + 3.5 }, price(last.c)),
  );

  const crossV = s('line', { class: 'cross', y1: 0, y2: height - axisH, visibility: 'hidden' });
  const crossH = s('line', { class: 'cross', x1: left, x2: left + plotW, visibility: 'hidden' });
  const crossDot = s('circle', { class: 'cross-dot', r: 3, visibility: 'hidden' });
  const focus = s('g', { class: 'focus' });
  svg.append(crossV, crossH, crossDot, focus);

  const hit = s('rect', { class: 'hit', x: left, y: 0, width: plotW, height: laneTop - 4 });
  const leave = () => {
    for (const node of [crossV, crossH, crossDot]) node.setAttribute('visibility', 'hidden');
    showReadout(n - 1);
  };
  const move = (event: PointerEvent) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - left - 6) / (plotW - 12)) * (n - 1))));
    const bar = history[i] as Bar;
    crossV.setAttribute('x1', String(x(i)));
    crossV.setAttribute('x2', String(x(i)));
    crossH.setAttribute('y1', String(y(bar.c)));
    crossH.setAttribute('y2', String(y(bar.c)));
    crossDot.setAttribute('cx', String(x(i)));
    crossDot.setAttribute('cy', String(y(bar.c)));
    for (const node of [crossV, crossH, crossDot]) node.setAttribute('visibility', 'visible');
    showReadout(i);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
  svg.append(hit);

  // Event lanes
  const tooltip = h('div', { class: 'tooltip', hidden: true });
  const clusters: Cluster[] = [];
  const showTooltip = (cluster: Cluster, laneY: number) => {
    const shown = cluster.events.slice(0, 5);
    tooltip.replaceChildren(
      h(
        'div',
        { class: 'tooltip-head' },
        `${typeName(cluster.type)} · ${barDate((history[cluster.index] as Bar).t, true)}`,
      ),
      ...shown.map((event) =>
        h(
          'div',
          { class: 'tooltip-item' },
          h('span', { class: 'mono muted' }, `${stamp(event.time)} · ${event.source}`),
          h('span', { dir: 'auto' }, event.title),
        ),
      ),
      ...(cluster.events.length > shown.length
        ? [h('div', { class: 'muted' }, t('moreItems', { n: cluster.events.length - shown.length }))]
        : []),
    );
    tooltip.hidden = false;
    const boxW = tooltip.offsetWidth;
    const cx = x(cluster.index);
    tooltip.style.left = `${Math.max(4, Math.min(width - boxW - 4, cx - boxW / 2))}px`;
    tooltip.style.top = `${Math.max(2, laneY - tooltip.offsetHeight - 10)}px`;
  };

  lanes.forEach((type, row) => {
    const cy = laneTop + row * laneH + laneH / 2;
    const dim = activeTypes.size > 0 && !activeTypes.has(type);
    const label = s(
      'g',
      {
        class: `lane-label${dim ? ' dim' : ''}`,
        tabindex: 0,
        role: 'button',
        'aria-label': typeName(type),
        'aria-pressed': String(activeTypes.has(type)),
        onclick: () => options.onType(type),
        onkeydown: (event: KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          options.onType(type);
        },
      },
      s('rect', { x: 0, y: cy - laneH / 2, width: left - 2, height: laneH, class: 'lane-hit' }),
      shape(type, 7, cy, 3.5),
      narrow ? null : s('text', { class: 'axis', x: 16, y: cy + 3.5 }, typeName(type)),
    );
    svg.append(s('line', { class: 'lane-line', x1: left, x2: left + plotW, y1: cy, y2: cy }), label);

    const byBar = new Map<number, DossierEvent[]>();
    for (const p of placed) {
      if (p.event.type !== type) continue;
      const bucket = byBar.get(p.index);
      if (bucket) bucket.push(p.event);
      else byBar.set(p.index, [p.event]);
    }
    for (const [index, group] of [...byBar].sort((a, b) => a[0] - b[0])) {
      let cycle = 0;
      const node = s('g', {
        class: `marker${dim ? ' dim' : ''}`,
        tabindex: 0,
        role: 'button',
        'aria-label': `${typeName(type)}, ${barDate((history[index] as Bar).t)}: ${(group[0] as DossierEvent).title}`,
      });
      const cluster: Cluster = { index, type, events: group, node };
      node.append(
        s('rect', { class: 'marker-hit', x: x(index) - 6, y: cy - 7, width: 12, height: 14 }),
        shape(type, x(index), cy, group.length > 1 ? 4.5 : 3.5),
      );
      const enter = () => {
        showTooltip(cluster, cy);
        options.onHover(group.map((e) => e.id));
        chart.hover(group.map((e) => e.id));
      };
      const exit = () => {
        tooltip.hidden = true;
        options.onHover([]);
        chart.hover([]);
      };
      const activate = () => {
        options.onSelect((group[cycle % group.length] as DossierEvent).id);
        cycle += 1;
      };
      node.addEventListener('pointerenter', enter);
      node.addEventListener('pointerleave', exit);
      node.addEventListener('focus', enter);
      node.addEventListener('blur', exit);
      node.addEventListener('click', activate);
      node.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate();
      });
      clusters.push(cluster);
      svg.append(node);
    }
  });

  let hovered: string[] = [];
  let selected = options.selectedId;
  const paint = () => {
    focus.replaceChildren();
    const draw = (id: string, cls: string) => {
      const target = placed.find((p) => p.event.id === id);
      if (!target) return;
      const bar = history[target.index] as Bar;
      focus.append(
        s('line', { class: `guide ${cls}`, x1: x(target.index), x2: x(target.index), y1: 0, y2: height - axisH }),
        s('circle', { class: `ring ${cls}`, cx: x(target.index), cy: y(bar.c), r: 6 }),
      );
    };
    if (selected) draw(selected, 'selected');
    for (const id of hovered.slice(0, 1)) draw(id, 'hovered');
    for (const cluster of clusters) {
      const ids = cluster.events.map((e) => e.id);
      cluster.node.classList.toggle('selected', selected !== null && ids.includes(selected));
      cluster.node.classList.toggle('hovered', ids.some((id) => hovered.includes(id)));
    }
  };
  const chart: Chart = {
    hover(ids) {
      hovered = ids;
      paint();
    },
    select(id) {
      selected = id;
      paint();
    },
  };

  showReadout(n - 1);
  paint();
  host.append(readout, h('div', { class: 'chart-canvas' }, svg, tooltip));
  const outside = events.length - placed.length;
  if (outside > 0) host.append(h('div', { class: 'chart-note muted' }, t('offChart', { n: outside })));
  return chart;
}
