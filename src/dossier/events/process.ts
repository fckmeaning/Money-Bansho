// "How this data was produced": pipeline flow, source status, method, limits.
import { h, s } from '../dom';
import { parse } from './data';
import type { Model, Pipeline, Source } from './data';
import { responsive } from './charts';
import { median, present } from './stats';
import type { Key, Lang } from './strings';
import { keepFocus, makeUi, panel, table, tiles, value } from './ui';
import type { Cell, Ui } from './ui';

interface Step {
  id: Key;
  name: string;
  count: number | null;
  /** Stage this one is derived from, null for the first. */
  base: number | null;
  baseName: string;
  removed: number | null;
  note: string;
}

const STAGES = ['collected', 'unique', 'relevant', 'deduped', 'classified', 'priced'] as const;
/** Classification and price reaction both start from the deduplicated events. */
const BASE: Record<string, string> = {
  unique: 'collected',
  relevant: 'unique',
  deduped: 'relevant',
  classified: 'deduped',
  priced: 'deduped',
  listed: 'deduped',
};

function steps(ui: Ui, model: Model, pipeline: Pipeline): Step[] {
  const counts = new Map(pipeline.stages.map((stage) => [stage.id, stage.count]));
  counts.set('listed', model.events.length);
  return [...STAGES, 'listed' as const].map((id) => {
    const count = counts.get(id) ?? null;
    const baseId = BASE[id];
    const base = baseId ? (counts.get(baseId) ?? null) : null;
    const removed = count !== null && base !== null && base >= count ? base - count : null;
    return {
      id: `st_${id}` as Key,
      name: ui.t(`st_${id}` as Key),
      count,
      base,
      baseName: baseId ? ui.t(`st_${baseId}` as Key) : '',
      removed,
      note:
        !baseId || removed === null
          ? ''
          : removed === 0
            ? ui.t('drop_none')
            : ui.t(`drop_${id}` as Key, { n: ui.int(removed) }),
    };
  });
}

const share = (ui: Ui, part: number | null, whole: number | null) =>
  part === null || !whole ? ui.t('noData') : `${ui.num((part / whole) * 100, 1)}%`;

/**
 * A vertical chain collect → unique → relevant → deduplicate, which then forks
 * into the checks made on the deduplicated events.
 */
function flowDiagram(ui: Ui, all: Step[]): HTMLElement {
  const max = Math.max(1, ...present(all.map((step) => step.count)));
  const summary = all.map((step) => `${step.name}: ${ui.int(step.count)}`).join('; ');
  return responsive((width) => {
    const nodeHeight = 52;
    const gap = 34;
    const indent = 26;
    const chain = all.slice(0, 4);
    const forks = all.slice(4);
    const forkTop = chain.length * (nodeHeight + gap);
    const height = forkTop + forks.length * (nodeHeight + gap) - gap + 2;
    const svg = s('svg', {
      class: 'evx-svg evx-flow',
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': ui.t('flowAria', { summary }),
    });
    const line = (d: string) => svg.append(s('path', { d, class: 'evx-link-line' }));
    const arrow = (x: number, y: number) =>
      svg.append(s('polygon', { points: `${x},${y} ${x - 4},${y - 6} ${x + 4},${y - 6}`, class: 'evx-arrow' }));
    const node = (step: Step, x: number, y: number, w: number) => {
      const barWidth = step.count === null ? 0 : Math.max(step.count ? 2 : 0, (step.count / max) * (w - 2));
      svg.append(
        s(
          'g',
          {},
          s('title', {}, `${step.name}: ${ui.int(step.count)}${step.note ? `. ${step.note}` : ''}`),
          s('rect', { x: x + 0.5, y: y + 0.5, width: w - 1, height: nodeHeight - 1, class: 'evx-node' }),
          s('rect', { x: x + 1, y: y + nodeHeight - 13, width: barWidth, height: 12, class: 'evx-node-bar' }),
          s('text', { x: x + 10, y: y + 24, class: 'evx-node-name' }, step.name),
          s(
            'text',
            { x: x + w - 10, y: y + 26, class: 'evx-node-count', 'text-anchor': 'end' },
            ui.int(step.count),
          ),
        ),
      );
    };
    const noteAt = (step: Step, x: number, y: number) => {
      if (!step.note) return;
      const ofBase = step.count !== null && step.base ? ` · ${share(ui, step.count, step.base)}` : '';
      // The percentage is dropped on narrow screens; the table below has it.
      const long = `${step.note}${ofBase}`;
      svg.append(s('text', { x, y, class: 'evx-axis' }, long.length * 6.2 > width - x ? step.note : long));
    };
    const mid = Math.min(width / 2, 120);
    chain.forEach((step, i) => {
      const y = i * (nodeHeight + gap);
      node(step, 0, y, width);
      if (i === 0) return;
      line(`M${mid} ${y - gap}V${y}`);
      arrow(mid, y);
      noteAt(step, mid + 12, y - gap / 2 + 3);
    });
    const trunk = 10;
    forks.forEach((step, i) => {
      const y = forkTop + i * (nodeHeight + gap);
      // One trunk from the deduplicated events with an elbow into every branch.
      line(`M${trunk} ${forkTop - gap}V${y + nodeHeight / 2}H${indent}`);
      svg.append(
        s('polygon', {
          points: `${indent},${y + nodeHeight / 2} ${indent - 6},${y + nodeHeight / 2 - 4} ${indent - 6},${y + nodeHeight / 2 + 4}`,
          class: 'evx-arrow',
        }),
      );
      node(step, indent, y, width - indent);
      noteAt(step, indent + 10, y - gap / 2 + 3);
    });
    return svg;
  });
}

function stageTable(ui: Ui, all: Step[]): HTMLElement {
  const first = all[0]?.count ?? null;
  return table(
    ui.t('stageTable'),
    [
      { label: ui.t('h_stage') },
      { label: ui.t('h_count'), numeric: true },
      { label: ui.t('h_base') },
      { label: ui.t('h_removed'), numeric: true },
      { label: ui.t('h_kept'), numeric: true },
      { label: ui.t('h_ofCollected'), numeric: true },
    ],
    all.map((step) => [
      step.name,
      value(ui, ui.int(step.count)),
      step.baseName || '·',
      step.baseName ? value(ui, ui.int(step.removed)) : '·',
      step.baseName ? value(ui, share(ui, step.count, step.base)) : '·',
      value(ui, share(ui, step.count, first)),
    ]),
  );
}

const STATUS_MARK = { ok: '●', stale: '▲', failed: '✕' };
const STATUS_ORDER = { failed: 0, stale: 1, ok: 2 };

function statusTag(ui: Ui, status: Source['status']): HTMLElement {
  return h(
    'span',
    { class: `evx-status-tag evx-status-${status}` },
    h('span', { 'aria-hidden': 'true' }, STATUS_MARK[status]),
    ` ${ui.t(`status_${status}`)}`,
  );
}

function meter(ui: Ui, amount: number | null, max: number, text: string): HTMLElement {
  const bar = h('span', { class: 'evx-meter-bar', 'aria-hidden': 'true' }, h('i'));
  const fill = bar.firstElementChild as HTMLElement;
  fill.style.width = amount === null || max <= 0 ? '0' : `${Math.max(amount > 0 ? 2 : 0, (amount / max) * 100)}%`;
  return h('span', { class: 'evx-meter' }, bar, value(ui, text, 'evx-num'));
}

type SortKey = 'source' | 'kind' | 'status' | 'items' | 'ms';
let sourceSort: { key: SortKey; ascending: boolean } = { key: 'status', ascending: true };

function sourceTable(ui: Ui, sources: Source[]): HTMLElement {
  const box = h('div', {});
  const maxMs = Math.max(0, ...present(sources.map((x) => x.ms)));
  const maxItems = Math.max(0, ...present(sources.map((x) => x.items)));
  const kindName = (kind: Source['kind']) => (kind ? ui.t(`kind_${kind}`) : ui.t('noData'));
  const columns: { key: SortKey | null; label: Key; numeric?: boolean }[] = [
    { key: 'source', label: 'h_source' },
    { key: 'kind', label: 'h_kind' },
    { key: 'status', label: 'h_status' },
    { key: 'items', label: 'h_items', numeric: true },
    { key: 'ms', label: 'h_latency', numeric: true },
    { key: null, label: 'h_message' },
  ];
  const compare = (a: Source, b: Source): number => {
    const { key, ascending } = sourceSort;
    const direction = ascending ? 1 : -1;
    if (key === 'items' || key === 'ms') {
      const x = a[key];
      const y = b[key];
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return (x - y) * direction;
    }
    if (key === 'status') {
      return (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) * direction || a.source.localeCompare(b.source);
    }
    return String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * direction;
  };
  const render = () => {
    const rows: Cell[][] = [...sources].sort(compare).map((x) => [
      h('span', { class: 'evx-source evx-num' }, x.source || ui.t('noData')),
      value(ui, kindName(x.kind)),
      statusTag(ui, x.status),
      meter(ui, x.items, maxItems, ui.int(x.items)),
      meter(ui, x.ms, maxMs, ui.duration(x.ms)),
      h('span', { class: x.message ? 'evx-message' : 'evx-muted' }, x.message ?? '·'),
    ]);
    const region = table(
      ui.t('sourceTitle'),
      columns.map((c) => ({ label: ui.t(c.label), numeric: c.numeric })),
      rows,
      { className: 'evx-wide' },
    );
    region.setAttribute('aria-label', ui.t('sourcesScroll'));
    region.querySelectorAll('thead th').forEach((th, i) => {
      const column = columns[i];
      if (!column?.key) return;
      const key = column.key;
      const current = sourceSort.key === key;
      if (current) th.setAttribute('aria-sort', sourceSort.ascending ? 'ascending' : 'descending');
      th.replaceChildren(
        h(
          'button',
          {
            type: 'button',
            class: 'evx-sortbutton',
            'data-key': `source-${key}`,
            onclick: () => {
              const ascending = current ? !sourceSort.ascending : !(key === 'items' || key === 'ms');
              sourceSort = { key, ascending };
              keepFocus(box, render);
            },
          },
          ui.t(column.label),
          h('span', { 'aria-hidden': 'true' }, current ? (sourceSort.ascending ? ' ↑' : ' ↓') : ''),
        ),
      );
    });
    box.replaceChildren(region);
  };
  render();
  return box;
}

function kindTable(ui: Ui, sources: Source[]): HTMLElement {
  const kinds = [...new Set(sources.map((x) => x.kind))];
  return table(
    ui.t('byKind'),
    [
      { label: ui.t('h_kind') },
      { label: ui.t('h_requests'), numeric: true },
      { label: ui.t('status_ok'), numeric: true },
      { label: ui.t('status_stale'), numeric: true },
      { label: ui.t('status_failed'), numeric: true },
      { label: ui.t('h_items'), numeric: true },
      { label: ui.t('h_slowest'), numeric: true },
    ],
    kinds.map((kind) => {
      const mine = sources.filter((x) => x.kind === kind);
      const items = present(mine.map((x) => x.items));
      const times = present(mine.map((x) => x.ms));
      const status = (name: Source['status']) => ui.int(mine.filter((x) => x.status === name).length);
      return [
        kind ? ui.t(`kind_${kind}`) : ui.t('noData'),
        ui.int(mine.length),
        status('ok'),
        status('stale'),
        status('failed'),
        value(ui, ui.int(items.length ? items.reduce((sum, v) => sum + v, 0) : null)),
        value(ui, ui.duration(times.length ? Math.max(...times) : null)),
      ];
    }),
  );
}

function method(ui: Ui): HTMLElement {
  return h(
    'ol',
    { class: 'evx-method' },
    ...[1, 2, 3, 4, 5, 6, 7].map((n) =>
      h(
        'li',
        {},
        h('h4', {}, ui.t(`m${n}_t` as Key)),
        h('p', {}, ui.t(`m${n}_x` as Key)),
        h(
          'pre',
          { class: 'evx-formula', tabindex: 0, role: 'region', 'aria-label': `${ui.t('formula')}: ${ui.t(`m${n}_t` as Key)}` },
          ui.t(`m${n}_f` as Key),
        ),
      ),
    ),
  );
}

export function processView(data: unknown, options: { lang: Lang }): HTMLElement {
  const ui = makeUi(options.lang);
  const { t } = ui;
  const model = parse(data);
  const root = h('div', { class: 'evx evx-process', lang: options.lang });
  if (!model.valid) {
    root.append(h('p', { class: 'evx-empty' }, t('invalid')));
    return root;
  }
  const { pipeline } = model;
  root.append(
    h('header', { class: 'evx-head' }, h('h2', {}, t('processTitle')), h('p', { class: 'evx-note' }, t('processNote'))),
  );

  if (!pipeline) {
    root.append(h('p', { class: 'evx-empty' }, t('noPipeline')));
  } else {
    const all = steps(ui, model, pipeline);
    const count = (status: Source['status']) => pipeline.sources.filter((x) => x.status === status).length;
    const typical = median(present(pipeline.sources.map((x) => x.ms)));
    root.append(
      tiles(ui, t('processTitle'), [
        { label: t('p_updated'), value: ui.dateTime(model.updatedAt) },
        { label: t('p_started'), value: ui.dateTime(pipeline.startedAt) },
        {
          label: t('p_duration'),
          value: ui.duration(pipeline.durationMs),
          note: typical === null ? undefined : `${t('h_latency')}, median: ${ui.duration(typical)}`,
        },
        {
          label: t('p_sources'),
          value: pipeline.sources.length ? ui.int(pipeline.sources.length) : t('noData'),
          note: t('p_sourcesValue', { ok: count('ok'), stale: count('stale'), failed: count('failed') }),
        },
        { label: t('p_collected'), value: ui.int(all[0]?.count ?? null) },
        { label: t('p_listed'), value: ui.int(model.events.length) },
      ]),
      h(
        'div',
        { class: 'evx-grid-flow' },
        panel(t('flow'), h('p', { class: 'evx-note' }, t('flowNote')), flowDiagram(ui, all)),
        panel(t('stageTable'), stageTable(ui, all)),
      ),
      panel(
        t('sourceTitle'),
        ...(pipeline.sources.length
          ? [sourceTable(ui, pipeline.sources), h('p', { class: 'evx-note' }, t('cacheNote'))]
          : [h('p', { class: 'evx-empty' }, t('noSources'))]),
      ),
      ...(pipeline.sources.length ? [panel(t('byKind'), kindTable(ui, pipeline.sources))] : []),
    );
  }

  root.append(
    panel(
      t('errorsTitle'),
      model.errors.length
        ? table(
            t('errorsTitle'),
            [{ label: t('h_source') }, { label: t('h_message') }],
            model.errors.map((e) => [
              h('span', { class: 'evx-source evx-num' }, e.source || t('noData')),
              h('span', { class: 'evx-message' }, e.message || t('noData')),
            ]),
          )
        : h('p', { class: 'evx-empty' }, t('noErrors')),
    ),
    panel(t('method'), method(ui)),
    panel(
      t('limits'),
      h('ul', { class: 'evx-limits' }, ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('li', {}, t(`l${n}` as Key)))),
    ),
  );
  return root;
}
