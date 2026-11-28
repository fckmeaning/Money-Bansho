// Market overview above the wire: key figures, a map of day changes by region and
// the distribution of events. Everything is counted from the wire and the board.
import { DASH, glyph, h, pct, price, s, stamp, tone } from './dom';
import { regionName, t, typeName } from './i18n';
import { panel } from './panels';
import { EVENT_TYPES, REGIONS } from './types';
import type { Board, Company, EventType, WireEvent } from './types';

/** Day change at which a map cell reaches full colour, in percent. */
const FULL_COLOUR_PCT = 5;

function changes(board: Board | null): number[] {
  return board ? [...board.quotes.values()].flatMap((q) => (q.changePct === null ? [] : [q.changePct])) : [];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function marketStrip(events: WireEvent[] | null, board: Board | null): HTMLElement {
  const all = changes(board);
  const up = all.filter((c) => c > 0).length;
  const down = all.filter((c) => c < 0).length;
  const mid = median(all);
  const figure = (label: string, value: Node | string, cls = '') =>
    h('div', { class: 'kpi' }, h('span', {}, label), h('b', { class: `mono ${cls}` }, value));
  const share = (count: number, cls: string) => {
    const part = h('i', { class: cls });
    part.style.flexGrow = String(count);
    return part;
  };
  return h(
    'section',
    { class: 'kpis' },
    figure(t('kpiEvents'), events ? String(events.length) : DASH),
    figure(t('kpiLeadership'), events ? String(events.filter((e) => e.type === 'leadership').length) : DASH, 'gold'),
    figure(t('kpiCompanies'), events ? String(new Set(events.map((e) => e.symbol)).size) : DASH),
    h(
      'div',
      { class: 'kpi kpi-wide' },
      h('span', {}, t('kpiBreadth')),
      all.length
        ? h(
            'b',
            { class: 'mono' },
            h('span', { class: 'up' }, `▲ ${up}`),
            ' ',
            h('span', { class: 'down' }, `▼ ${down}`),
          )
        : h('b', { class: 'mono' }, DASH),
      h('div', { class: 'breadth', 'aria-hidden': 'true' }, share(up, 'b-up'), share(all.length - up - down, 'b-flat'), share(down, 'b-down')),
    ),
    figure(t('kpiMedian'), pct(mid), tone(mid)),
  );
}

export function marketMap(board: Board | null, companies: Company[], onOpen: (symbol: string) => void): HTMLElement {
  const rows = REGIONS.map((region) => {
    const members = companies
      .filter((c) => c.region === region)
      .map((c) => ({ company: c, quote: board?.quotes.get(c.symbol) }))
      .sort((a, b) => (b.quote?.changePct ?? -Infinity) - (a.quote?.changePct ?? -Infinity));
    const cells = members.map(({ company, quote }) => {
      const change = quote?.changePct ?? null;
      const cell = h(
        'button',
        {
          type: 'button',
          class: `heat-cell ${tone(change)}`,
          'data-key': `map-${company.symbol}`,
          title: `${company.name}: ${price(quote?.price)} (${pct(change)})`,
          onclick: () => onOpen(company.symbol),
        },
        h('b', { class: 'mono' }, company.symbol),
        h('span', { class: 'mono' }, pct(change)),
        h('small', { class: 'clamp1', dir: 'auto' }, company.name),
      );
      cell.style.setProperty('--heat', `${Math.round(Math.min(1, Math.abs(change ?? 0) / FULL_COLOUR_PCT) * 55)}%`);
      return cell;
    });
    if (!cells.length) return null;
    const mid = median(members.flatMap((m) => (m.quote?.changePct == null ? [] : [m.quote.changePct])));
    return h(
      'div',
      { class: 'heat-row' },
      h('h3', {}, h('span', {}, regionName(region)), h('b', { class: `mono ${tone(mid)}` }, pct(mid))),
      h('div', { class: 'heat-cells' }, ...cells),
    );
  });
  return panel(
    t('marketMap'),
    h('span', {}, t('marketMapNote', { pct: FULL_COLOUR_PCT })),
    h('div', { class: 'heat' }, ...rows.filter((row): row is HTMLDivElement => row !== null)),
  );
}

function bars(items: { label: Node[]; count: number; key: string; pressed?: boolean; onclick?: () => void }[]): HTMLElement {
  const max = Math.max(1, ...items.map((i) => i.count));
  return h(
    'ul',
    { class: 'dist' },
    ...items.map((item) => {
      const fill = h('i', {});
      fill.style.width = `${(item.count / max) * 100}%`;
      const content = [h('span', { class: 'dist-label' }, ...item.label), h('span', { class: 'bar' }, fill), h('b', { class: 'mono' }, String(item.count))];
      return h(
        'li',
        {},
        item.onclick
          ? h('button', { type: 'button', class: 'dist-row', 'data-key': item.key, 'aria-pressed': String(item.pressed ?? false), onclick: item.onclick }, ...content)
          : h('div', { class: 'dist-row' }, ...content),
      );
    }),
  );
}

const W = 420;
const H = 230;
const FLOOR = H - 20;

/** An SVG with a baseline; `marks` are drawn above it. */
function plot(label: string, marks: SVGElement[]): SVGElement {
  return s(
    'svg',
    { class: 'ov-plot', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label },
    s('line', { class: 'ov-axis', x1: 0, x2: W, y1: FLOOR + 0.5, y2: FLOOR + 0.5 }),
    ...marks,
  );
}

const text = (x: number, y: number, value: string, anchor = 'middle'): SVGElement =>
  s('text', { x, y, 'text-anchor': anchor }, value);

function bar(x: number, y: number, width: number, height: number, cls: string, title: string): SVGElement {
  return s('rect', { x, y, width, height, class: cls }, s('title', {}, title));
}

/** Wire events of the latest 24 hours, hour by hour, stacked by type. */
function tempoChart(all: WireEvent[]): SVGElement {
  const BUCKETS = 24;
  const step = 3_600_000;
  const end = Math.max(...all.map((e) => e.time));
  const start = end - BUCKETS * step;
  const events = all.filter((e) => e.time >= start);
  const stacks = Array.from({ length: BUCKETS }, () => new Map<EventType, number>());
  for (const e of events) {
    const stack = stacks[Math.min(BUCKETS - 1, Math.floor((e.time - start) / step))] as Map<EventType, number>;
    stack.set(e.type, (stack.get(e.type) ?? 0) + 1);
  }
  const totals = stacks.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const width = W / BUCKETS;
  const marks = stacks.flatMap((stack, i) => {
    let y = FLOOR;
    return EVENT_TYPES.flatMap((type) => {
      const count = stack.get(type) ?? 0;
      if (!count) return [];
      const height = (count / max) * (FLOOR - 16);
      y -= height;
      const title = `${stamp(start + i * step)}: ${typeName(type)} ${count}`;
      return [bar(i * width + 1, y, width - 2, height, `ov-ev ev-${type}`, title)];
    });
  });
  return plot(t('chartTempo'), [
    ...marks,
    text(0, 10, String(max), 'start'),
    text(0, H - 5, stamp(start), 'start'),
    text(W, H - 5, stamp(end), 'end'),
  ]);
}

/** How many tracked companies moved by how much today. */
function spreadChart(values: number[]): SVGElement {
  const edges = [-5, -3, -2, -1, 0, 1, 2, 3, 5];
  const bins = Array.from({ length: edges.length + 1 }, () => 0);
  for (const v of values) {
    const i = edges.findIndex((edge) => v < edge);
    const at = i < 0 ? edges.length : i;
    bins[at] = (bins[at] as number) + 1;
  }
  const max = Math.max(1, ...bins);
  const width = W / bins.length;
  const name = (i: number): string =>
    i === 0 ? `<${edges[0]}` : i === edges.length ? `>${edges[i - 1]}` : `${edges[i - 1]}…${edges[i]}`;
  return plot(
    t('chartSpread'),
    bins.flatMap((count, i) => {
      const height = (count / max) * (FLOOR - 18);
      const cls = i <= edges.indexOf(0) ? 'ov-down' : 'ov-up';
      return [
        bar(i * width + 3, FLOOR - height, width - 6, height, cls, `${name(i)}%: ${count}`),
        text(i * width + width / 2, FLOOR - height - 4, count ? String(count) : ''),
        text(i * width + width / 2, H - 5, name(i)),
      ];
    }),
  );
}

/** The largest rises and falls of the day as bars from a common zero. */
function leadersChart(board: Board, onOpen: (symbol: string) => void): HTMLElement {
  const rows = [...board.quotes]
    .flatMap(([symbol, q]) => (q.changePct === null ? [] : [{ symbol, change: q.changePct }]))
    .sort((a, b) => b.change - a.change);
  const picked = [...rows.slice(0, 5), ...rows.slice(Math.max(5, rows.length - 5))];
  const max = Math.max(0.1, ...picked.map((r) => Math.abs(r.change)));
  return h(
    'ul',
    { class: 'ov-leaders' },
    ...picked.map((row) => {
      const size = (Math.abs(row.change) / max) * 50;
      const fill = h('i', { class: row.change < 0 ? 'ov-down' : 'ov-up' });
      fill.style.width = `${size}%`;
      fill.style.left = `${row.change < 0 ? 50 - size : 50}%`;
      return h(
        'li',
        {},
        h(
          'button',
          { type: 'button', 'data-key': `chart-${row.symbol}`, onclick: () => onOpen(row.symbol) },
          h('b', { class: 'mono' }, row.symbol),
          h('span', { class: 'ov-track' }, fill),
          h('span', { class: `mono ${tone(row.change)}` }, pct(row.change)),
        ),
      );
    }),
  );
}

export function chartRow(events: WireEvent[] | null, board: Board | null, onOpen: (symbol: string) => void): HTMLElement {
  const none = () => h('div', { class: 'empty' }, t('noData'));
  const values = changes(board);
  return h(
    'div',
    { class: 'ov-charts' },
    panel(t('chartTempo'), null, events?.length ? (tempoChart(events) as unknown as Node) : none()),
    panel(t('chartSpread'), null, values.length ? (spreadChart(values) as unknown as Node) : none()),
    panel(t('chartLeaders'), null, board && values.length ? leadersChart(board, onOpen) : none()),
  );
}

export function breakdownPanel(
  events: WireEvent[],
  companies: Company[],
  active: ReadonlySet<EventType>,
  onToggle: (type: EventType) => void,
): HTMLElement | null {
  if (!events.length) return null;
  const regionOf = new Map(companies.map((c) => [c.symbol, c.region]));
  const types = EVENT_TYPES.map((type) => ({ type, count: events.filter((e) => e.type === type).length }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
  const regions = REGIONS.map((region) => ({ region, count: events.filter((e) => regionOf.get(e.symbol) === region).length }));
  return panel(
    t('breakdown'),
    null,
    h('h3', {}, t('byType')),
    bars(
      types.map(({ type, count }) => ({
        label: [glyph(type) as unknown as Node, document.createTextNode(typeName(type))],
        count,
        key: `dist-${type}`,
        pressed: active.has(type),
        onclick: () => onToggle(type),
      })),
    ),
    h('h3', {}, t('byRegion')),
    bars(regions.map(({ region, count }) => ({ label: [document.createTextNode(regionName(region))], count, key: `dist-${region}` }))),
  );
}
