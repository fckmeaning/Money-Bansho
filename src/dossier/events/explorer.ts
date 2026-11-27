// The event explorer: filters, counters, timeline or table, detail plate, charts.
import { h } from '../dom';
import { EVENT_TYPES } from '../types';
import type { EventType } from '../types';
import { carHistogram, stackedByType, toneOverTime, typeGlyph } from './charts';
import { dayZero, parse } from './data';
import type { Ev, Model } from './data';
import { detailPlate, levelTag } from './detail';
import {
  buckets,
  facetCounts,
  facetValue,
  FACETS,
  filterEvents,
  isFiling,
  mean,
  median,
  noFilters,
  present,
  sortEvents,
  SORTS,
  windowKey,
} from './stats';
import type { Facet, Filters, Sort } from './stats';
import type { Key, Lang } from './strings';
import { keepFocus, makeUi, moveNode, panel, table, tiles, toneNode, value } from './ui';
import type { Ui } from './ui';

export interface EventsOptions {
  lang: Lang;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
}

const PAGE_SIZES = [25, 50, 100];
const LEVEL_ORDER = ['significant', 'notable', 'noise', 'none'] as const;
const ORDER: Partial<Record<Facet, readonly string[]>> = {
  type: EVENT_TYPES,
  tone: ['pos', 'neu', 'neg', 'none'],
  level: LEVEL_ORDER,
  origin: ['filing', 'press'],
};

/** Explorer state outlives re-renders of the same company (polling, tab switches). */
interface Memory {
  filters: Filters;
  sort: Sort;
  view: 'timeline' | 'table';
  page: number;
  pageSize: number;
  selected: string | null;
  filtersOpen: boolean;
  root: HTMLElement | null;
}

const memories = new Map<string, Memory>();

function recall(symbol: string): Memory {
  let memory = memories.get(symbol);
  if (!memory) {
    memory = {
      filters: noFilters(),
      sort: 'newest',
      view: 'timeline',
      page: 0,
      pageSize: 50,
      selected: null,
      filtersOpen: window.innerWidth >= 700,
      root: null,
    };
    memories.set(symbol, memory);
  }
  return memory;
}

const find = (root: HTMLElement, key: string) =>
  [...root.querySelectorAll<HTMLElement>('[data-key]')].find((node) => node.dataset.key === key) ?? null;

/** Runs once the view is in the document, even if the host attaches it later in this task. */
const afterAttach = (run: () => void) => {
  setTimeout(run, 0);
};

function reveal(memory: Memory, focus: boolean): void {
  const root = memory.root;
  if (!root?.isConnected) return;
  const detail = root.querySelector<HTMLElement>('.evx-detail');
  const list = root.querySelector<HTMLElement>('.evx-list');
  if (!detail || !list || detail.hidden) return;
  const box = detail.getBoundingClientRect();
  const stacked = box.bottom <= list.getBoundingClientRect().top + 1;
  const offscreen = box.top >= window.innerHeight - 80 || box.bottom <= 80;
  if (stacked || offscreen) {
    detail.scrollIntoView({ block: 'start' });
    if (focus) find(detail, 'detail-title')?.focus({ preventScroll: true });
  }
}

export function eventsView(data: unknown, options: EventsOptions): HTMLElement {
  const ui = makeUi(options.lang);
  const { t } = ui;
  const model = parse(data);
  const root = h('div', { class: 'evx', lang: options.lang });
  if (!model.valid || !model.events.length) {
    root.append(h('p', { class: 'evx-empty' }, t(model.valid ? 'noEvents' : 'invalid')));
    return root;
  }
  build(root, ui, model, options);
  return root;
}

function build(root: HTMLElement, ui: Ui, model: Model, options: EventsOptions): void {
  const { t } = ui;
  const memory = recall(model.symbol);
  const byId = new Map(model.events.map((e) => [e.id, e]));
  const drivers = new Set(model.reputation?.drivers.map((d) => d.eventId));

  // Remember where the keyboard was in the view being replaced.
  const active = document.activeElement;
  const focusKey =
    memory.root && active instanceof HTMLElement && memory.root.contains(active)
      ? (active.dataset.key ?? null)
      : null;
  const caret = active instanceof HTMLInputElement ? active.selectionStart : null;
  memory.root = root;

  const external = options.selectedId !== undefined && options.selectedId !== memory.selected;
  if (options.selectedId !== undefined) memory.selected = options.selectedId;
  if (memory.selected !== null && !byId.has(memory.selected)) memory.selected = null;
  // A language filter whose chip no longer exists would hide events with no way to see why.
  const languages = new Set(model.events.map((e) => e.lang));
  for (const key of memory.filters.lang) if (!languages.has(key)) memory.filters.lang.delete(key);

  let shown: Ev[] = [];

  const summary = h('div', { class: 'evx-summary' });
  const status = h('p', { class: 'evx-status', role: 'status' });
  const listBody = h('div', { class: 'evx-list-body' });
  const pager = h('nav', { class: 'evx-pager', 'aria-label': t('pager') });
  const list = h('div', { class: 'evx-list' }, status, listBody, pager);
  const detail = h('aside', { class: 'evx-detail', 'aria-label': t('detail') });
  const main = h('div', { class: 'evx-main' }, list, detail);
  const analysis = h('div', { class: 'evx-analysis' });

  // ---- selection ----------------------------------------------------------

  const pageOfSelected = () => {
    const index = shown.findIndex((e) => e.id === memory.selected);
    return index < 0 ? null : Math.floor(index / memory.pageSize);
  };

  function select(id: string | null, how: 'list' | 'detail' | 'analysis' = 'list'): void {
    const previous = memory.selected;
    memory.selected = id;
    const page = pageOfSelected();
    if (how !== 'list' && page !== null && page !== memory.page) {
      memory.page = page;
      renderList();
    }
    markSelected();
    keepFocus(detail, renderDetail);
    options.onSelect?.(id);
    afterAttach(() => {
      if (id) reveal(memory, how !== 'detail');
      else if (previous && memory.root?.isConnected) {
        const row = find(memory.root, `row-${previous}`);
        row?.focus({ preventScroll: true });
        row?.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function markSelected(): void {
    for (const node of listBody.querySelectorAll<HTMLElement>('[data-event]')) {
      const current = node.dataset.event === memory.selected;
      node.classList.toggle('evx-selected', current);
      const button = node.matches('button') ? node : node.querySelector('button');
      if (current) button?.setAttribute('aria-current', 'true');
      else button?.removeAttribute('aria-current');
    }
  }

  function renderDetail(): void {
    const event = memory.selected ? byId.get(memory.selected) : undefined;
    main.classList.toggle('evx-has-detail', Boolean(event));
    detail.hidden = !event;
    if (!event) {
      detail.replaceChildren();
      return;
    }
    const index = shown.indexOf(event);
    detail.replaceChildren(
      detailPlate(ui, model, event, {
        close: () => select(null),
        select: (id) => select(id, 'detail'),
        previous: index > 0 ? (shown[index - 1]?.id ?? null) : null,
        next: index >= 0 ? (shown[index + 1]?.id ?? null) : null,
      }),
    );
  }

  // ---- list ---------------------------------------------------------------

  const outletsText = (e: Ev) => t('outletsN', { n: e.outlets });

  function tags(e: Ev): (HTMLElement | null)[] {
    return [
      isFiling(e) ? h('span', { class: 'evx-tag' }, t('filing')) : null,
      drivers.has(e.id) ? h('span', { class: 'evx-tag evx-tag-driver' }, t('driver')) : null,
    ];
  }

  const typeCell = (type: EventType) => h('span', { class: 'evx-type' }, typeGlyph(type), t(`t_${type}`));

  function row(e: Ev, withDate: boolean): HTMLElement {
    const stat = (label: string, content: Node | string) =>
      h(
        'span',
        { class: 'evx-stat' },
        h('span', { class: 'evx-muted' }, `${label} `),
        typeof content === 'string' ? value(ui, content, 'evx-num') : content,
      );
    return h(
      'li',
      {},
      h(
        'button',
        {
          type: 'button',
          class: 'evx-row',
          'data-event': e.id,
          'data-key': `row-${e.id}`,
          onclick: () => select(e.id),
        },
        h(
          'span',
          { class: 'evx-row-head' },
          h('span', { class: 'evx-when evx-num' }, withDate ? ui.dateTime(e.time) : ui.time(e.time)),
          typeCell(e.type),
          stat(t('col_tone').toLowerCase(), toneNode(ui, e.sentiment)),
          e.impact?.level ? levelTag(ui, e.impact.level) : null,
        ),
        h('span', { class: 'evx-row-title', dir: 'auto', lang: e.lang || null }, e.title),
        h(
          'span',
          { class: 'evx-row-meta' },
          h('span', { class: 'evx-source' }, e.source || t('noData')),
          h('span', {}, outletsText(e)),
          ...tags(e),
          stat('CAR', moveNode(ui, e.impact?.carPct ?? null)),
          stat('z', ui.signed(e.impact?.z ?? null)),
          stat('q', ui.prob(e.impact?.q ?? null)),
        ),
      ),
    );
  }

  function timeline(items: Ev[]): HTMLElement {
    const grouped = memory.sort === 'newest' || memory.sort === 'oldest';
    if (!grouped) return h('ol', { class: 'evx-rows' }, ...items.map((e) => row(e, true)));
    const dayOf = (time: number) => new Date(time).toDateString();
    const totals = new Map<string, number>();
    for (const e of shown) totals.set(dayOf(e.time), (totals.get(dayOf(e.time)) ?? 0) + 1);
    const days: Ev[][] = [];
    for (const e of items) {
      const last = days[days.length - 1];
      if (last && dayOf((last[0] as Ev).time) === dayOf(e.time)) last.push(e);
      else days.push([e]);
    }
    return h(
      'div',
      {},
      ...days.map((day) => {
        const first = day[0] as Ev;
        return h(
          'section',
          { class: 'evx-day' },
          h(
            'h3',
            {},
            h('span', {}, ui.dayLabel(first.time)),
            h('span', { class: 'evx-muted' }, t('dayCount', { n: totals.get(dayOf(first.time)) ?? day.length })),
          ),
          h('ol', { class: 'evx-rows' }, ...day.map((e) => row(e, false))),
        );
      }),
    );
  }

  function eventTable(items: Ev[]): HTMLElement {
    const columns: { key: Key; numeric?: boolean; sorts?: Sort[] }[] = [
      { key: 'col_time', sorts: ['newest', 'oldest'] },
      { key: 'col_type' },
      { key: 'col_title' },
      { key: 'col_tone', numeric: true, sorts: ['toneLow', 'toneHigh'] },
      { key: 'col_source' },
      { key: 'col_outlets', numeric: true, sorts: ['outlets'] },
      { key: 'col_car', numeric: true, sorts: ['car'] },
      { key: 'col_z', numeric: true, sorts: ['z'] },
      { key: 'col_q', numeric: true, sorts: ['q'] },
      { key: 'col_level' },
    ];
    const ascending: Sort[] = ['oldest', 'toneLow', 'q'];
    const head = columns.map((column) => {
      const activeSort = column.sorts?.includes(memory.sort) ? memory.sort : null;
      const props = {
        scope: 'col',
        class: column.numeric ? 'evx-r' : null,
        'aria-sort': activeSort ? (ascending.includes(activeSort) ? 'ascending' : 'descending') : null,
      };
      if (!column.sorts) return h('th', props, t(column.key));
      const next = column.sorts[(column.sorts.indexOf(memory.sort) + 1) % column.sorts.length] as Sort;
      return h(
        'th',
        props,
        h(
          'button',
          {
            type: 'button',
            class: 'evx-sortbutton',
            'data-key': `th-${column.key}`,
            title: `${t('sort')}: ${t(`sort_${next}`)}`,
            onclick: () => setSort(next),
          },
          t(column.key),
          h(
            'span',
            { 'aria-hidden': 'true' },
            activeSort ? (ascending.includes(activeSort) ? ' ↑' : ' ↓') : '',
          ),
        ),
      );
    });
    const cell = (content: Node | string, className: string | null = null) =>
      h('td', { class: className }, typeof content === 'string' ? value(ui, content) : content);
    const numeric = 'evx-r evx-num';
    return h(
      'div',
      { class: 'evx-scroll', tabindex: 0, role: 'region', 'aria-label': t('tableScroll'), 'data-key': 'event-table' },
      h(
        'table',
        { class: 'evx-table evx-events-table' },
        h('caption', { class: 'evx-sr' }, t('eventsTitle')),
        h('thead', {}, h('tr', {}, ...head)),
        h(
          'tbody',
          {},
          ...items.map((e) =>
            h(
              'tr',
              { 'data-event': e.id },
              cell(ui.dateTime(e.time), 'evx-num evx-nowrap'),
              cell(typeCell(e.type), 'evx-nowrap'),
              h(
                'th',
                { scope: 'row', class: 'evx-cell-title' },
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'evx-linkbutton',
                    'data-key': `row-${e.id}`,
                    onclick: () => select(e.id),
                  },
                  h('span', { dir: 'auto', lang: e.lang || null }, e.title),
                ),
                ...tags(e),
              ),
              cell(toneNode(ui, e.sentiment), `${numeric} evx-nowrap`),
              cell(e.source || t('noData'), 'evx-source'),
              cell(ui.int(e.outlets), numeric),
              cell(moveNode(ui, e.impact?.carPct ?? null), numeric),
              cell(ui.signed(e.impact?.z ?? null), numeric),
              cell(ui.prob(e.impact?.q ?? null), numeric),
              cell(levelTag(ui, e.impact?.level ?? null)),
            ),
          ),
        ),
      ),
    );
  }

  function renderList(): void {
    const pages = Math.max(1, Math.ceil(shown.length / memory.pageSize));
    memory.page = Math.min(Math.max(0, memory.page), pages - 1);
    const from = memory.page * memory.pageSize;
    const items = shown.slice(from, from + memory.pageSize);
    status.textContent = items.length
      ? `${t('rangeOf', { from: from + 1, to: from + items.length, n: shown.length })}. ${t('localTime')}`
      : t('noMatch');
    keepFocus(list, () => {
      listBody.replaceChildren(
        ...(items.length ? [memory.view === 'table' ? eventTable(items) : timeline(items)] : []),
      );
      markSelected();
      renderPager(pages);
    });
  }

  function renderPager(pages: number): void {
    pager.hidden = !shown.length;
    const go = (key: Key, target: number) =>
      h(
        'button',
        {
          type: 'button',
          class: 'evx-btn',
          'data-key': `page-${key}`,
          disabled: target < 0 || target >= pages || target === memory.page,
          onclick: () => {
            memory.page = target;
            renderList();
            if (list.getBoundingClientRect().top < 0) list.scrollIntoView({ block: 'start' });
          },
        },
        t(key),
      );
    const size = h(
      'select',
      {
        class: 'evx-select',
        'data-key': 'page-size',
        onchange: (event: Event) => {
          const first = memory.page * memory.pageSize;
          memory.pageSize = Number((event.target as HTMLSelectElement).value) || 50;
          memory.page = Math.floor(first / memory.pageSize);
          renderList();
        },
      },
      ...PAGE_SIZES.map((n) => h('option', { value: n, selected: n === memory.pageSize }, String(n))),
    );
    pager.replaceChildren(
      go('first', 0),
      go('prev', memory.page - 1),
      h('span', { class: 'evx-num' }, t('pageOf', { page: memory.page + 1, pages })),
      go('next', memory.page + 1),
      go('last', pages - 1),
      h('label', { class: 'evx-inline' }, t('perPage'), size),
    );
  }

  // ---- counters -----------------------------------------------------------

  function renderSummary(): void {
    const filings = shown.filter(isFiling).length;
    const priced = shown.filter((e) => e.impact);
    const windows = new Set(priced.map((e) => windowKey(e, model.history))).size;
    const level = (name: string) => shown.filter((e) => e.impact?.level === name).length;
    const tones = present(shown.map((e) => e.sentiment));
    const mid = median(present(shown.map((e) => e.impact?.carPct)).map(Math.abs));
    summary.replaceChildren(
      tiles(ui, t('summary'), [
        { label: t('c_shown'), value: ui.int(shown.length), note: t('c_ofListed', { n: model.events.length }) },
        { label: t('c_filings'), value: ui.int(filings), note: t('c_press', { n: shown.length - filings }) },
        { label: t('c_priced'), value: ui.int(priced.length), note: t('c_windows', { n: windows }) },
        { label: t('c_significant'), value: ui.int(level('significant')), note: t('c_significantNote') },
        { label: t('c_notable'), value: ui.int(level('notable')), note: t('c_notableNote') },
        { label: t('c_positive'), value: ui.int(tones.filter((v) => v > 0.005).length) },
        {
          label: t('c_negative'),
          value: ui.int(tones.filter((v) => v < -0.005).length),
          note: t('c_neutral', { n: tones.filter((v) => Math.abs(v) <= 0.005).length }),
        },
        { label: t('c_medianCar'), value: mid === null ? t('noData') : `${ui.num(mid)}%`, note: t('c_medianNote') },
      ]),
    );
  }

  // ---- analysis -----------------------------------------------------------

  const eventButton = (e: Ev, key: string) =>
    h(
      'button',
      { type: 'button', class: 'evx-linkbutton', 'data-key': key, onclick: () => select(e.id, 'analysis') },
      h('span', { dir: 'auto', lang: e.lang || null }, e.title),
    );

  function matrix(): HTMLElement {
    const open: Filters = { ...memory.filters, type: new Set(), level: new Set() };
    const pool = filterEvents(model.events, open);
    const types = EVENT_TYPES.filter((type) => model.events.some((e) => e.type === type));
    const maxCell = Math.max(
      1,
      ...types.flatMap((type) =>
        LEVEL_ORDER.map((l) => pool.filter((e) => e.type === type && (e.impact?.level ?? 'none') === l).length),
      ),
    );
    const only = (set: Set<string>, key: string) => set.size === 1 && set.has(key);
    const rows = types.map((type) => {
      const mine = pool.filter((e) => e.type === type);
      const cells = LEVEL_ORDER.map((level) => {
        const n = mine.filter((e) => (e.impact?.level ?? 'none') === level).length;
        const pressed = only(memory.filters.type, type) && only(memory.filters.level, level);
        const name = t(level === 'none' ? 'level_none' : `level_${level}`);
        const button = h(
          'button',
          {
            type: 'button',
            class: 'evx-cell',
            'data-key': `m-${type}-${level}`,
            'aria-pressed': String(pressed),
            'aria-label': t('m_filter', { type: t(`t_${type}`), level: name, n }),
            disabled: !n && !pressed,
            onclick: () => {
              memory.filters.type = new Set(pressed ? [] : [type]);
              memory.filters.level = new Set(pressed ? [] : [level]);
              changed();
            },
          },
          ui.int(n),
        );
        // Shade strength repeats the count; the number carries the information.
        button.style.setProperty('--evx-heat', `${Math.round((n / maxCell) * 38)}%`);
        return button;
      });
      const car = median(present(mine.map((e) => e.impact?.carPct)));
      return [
        typeCell(type),
        ...cells,
        ui.int(mine.length),
        moveNode(ui, car),
        toneNode(ui, mean(present(mine.map((e) => e.sentiment)))),
      ];
    });
    rows.push([
      h('span', {}, t('m_total')),
      ...LEVEL_ORDER.map((level) =>
        h('span', {}, ui.int(pool.filter((e) => (e.impact?.level ?? 'none') === level).length)),
      ),
      ui.int(pool.length),
      moveNode(ui, median(present(pool.map((e) => e.impact?.carPct)))),
      toneNode(ui, mean(present(pool.map((e) => e.sentiment)))),
    ]);
    return panel(
      t('matrix'),
      h('p', { class: 'evx-note' }, t('matrixNote')),
      table(
        t('matrix'),
        [
          { label: t('col_type') },
          ...LEVEL_ORDER.map((l) => ({ label: t(l === 'none' ? 'level_none' : `level_${l}`), numeric: true })),
          { label: t('m_total'), numeric: true },
          { label: t('m_median'), numeric: true },
          { label: t('m_tone'), numeric: true },
        ],
        rows,
        { className: 'evx-matrix' },
      ),
    );
  }

  function topMoves(): HTMLElement {
    const groups = new Map<string, Ev[]>();
    for (const e of shown) {
      const key = windowKey(e, model.history);
      if (!key || e.impact?.carPct === null) continue;
      const group = groups.get(key);
      if (group) group.push(e);
      else groups.set(key, [e]);
    }
    const rows = [...groups.values()]
      .map((group) => {
        // The most widely carried headline stands for the window.
        const lead = [...group].sort((a, b) => b.outlets - a.outlets || a.time - b.time)[0] as Ev;
        return { lead, count: group.length };
      })
      .sort((a, b) => Math.abs(b.lead.impact?.carPct ?? 0) - Math.abs(a.lead.impact?.carPct ?? 0))
      .slice(0, 10)
      .map(({ lead, count }) => {
        const index = dayZero(model.history, lead.time);
        const bar = typeof index === 'number' ? model.history[index] : undefined;
        return [
          h('span', { class: 'evx-nowrap' }, bar ? ui.barDate(bar.t) : ui.date(lead.time)),
          moveNode(ui, lead.impact?.carPct ?? null),
          value(ui, ui.signed(lead.impact?.z ?? null)),
          levelTag(ui, lead.impact?.level ?? null),
          ui.int(count),
          eventButton(lead, `top-${lead.id}`),
        ];
      });
    return panel(
      t('topMoves'),
      h('p', { class: 'evx-note' }, `${t('topMovesNote')} ${t('noCause')}`),
      rows.length
        ? table(
            t('topMoves'),
            [
              { label: t('day0Col') },
              { label: t('col_car'), numeric: true },
              { label: t('col_z'), numeric: true },
              { label: t('col_level') },
              { label: t('m_events'), numeric: true },
              { label: t('col_title') },
            ],
            rows,
            { className: 'evx-wide' },
          )
        : h('p', { class: 'evx-empty' }, t('noData')),
    );
  }

  function breakdown(title: string, note: string | null, first: string, groups: [string, Ev[]][]): HTMLElement {
    return panel(
      title,
      note ? h('p', { class: 'evx-note' }, note) : null,
      groups.length
        ? table(
            title,
            [
              { label: first },
              { label: t('b_events'), numeric: true },
              { label: t('b_pos'), numeric: true },
              { label: t('b_neg'), numeric: true },
              { label: t('b_sig'), numeric: true },
              { label: t('b_latest'), numeric: true },
            ],
            groups.map(([name, events]) => [
              h('span', { dir: 'auto' }, name),
              ui.int(events.length),
              ui.int(events.filter((e) => (e.sentiment ?? 0) > 0.005).length),
              ui.int(events.filter((e) => (e.sentiment ?? 0) < -0.005).length),
              ui.int(events.filter((e) => e.impact?.level === 'significant').length),
              h('span', { class: 'evx-nowrap' }, ui.shortDate(Math.max(...events.map((e) => e.time)))),
            ]),
          )
        : h('p', { class: 'evx-empty' }, t('noData')),
    );
  }

  function group(keys: (e: Ev) => string[], limit: number): [string, Ev[]][] {
    const groups = new Map<string, Ev[]>();
    for (const e of shown) {
      for (const key of new Set(keys(e))) {
        const found = groups.get(key);
        if (found) found.push(e);
        else groups.set(key, [e]);
      }
    }
    return [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, limit);
  }

  function renderAnalysis(): void {
    const { unit, list: periods } = buckets(shown);
    const suffix = unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month';
    const priced = shown.filter((e) => e.impact && e.impact.carPct !== null);
    const open = new Set(
      [...analysis.querySelectorAll<HTMLDetailsElement>('details[open] > summary')].map(
        (node) => node.parentElement?.closest('figure')?.querySelector('figcaption')?.textContent,
      ),
    );
    keepFocus(analysis, () => {
      analysis.replaceChildren(
        h('h2', { tabindex: -1 }, t('analysis')),
        h('p', { class: 'evx-note' }, t('analysisNote')),
        h(
          'div',
          { class: 'evx-grid-2' },
          ...(periods.length
            ? [
                stackedByType(ui, periods, unit, t(`per${suffix}`)),
                toneOverTime(ui, periods, unit, t(`tone${suffix}`)),
              ]
            : [h('p', { class: 'evx-empty' }, t('noMatch'))]),
          carHistogram(
            ui,
            present(priced.map((e) => e.impact?.carPct)),
            new Set(priced.map((e) => windowKey(e, model.history))).size,
          ),
          breakdown(
            t('byLang'),
            null,
            t('b_lang'),
            group((e) => [ui.language(e.lang)], 12),
          ),
        ),
        matrix(),
        topMoves(),
        h(
          'div',
          { class: 'evx-grid-2' },
          breakdown(
            t('bySource'),
            t('bySourceNote', { n: 12 }),
            t('b_name'),
            group((e) => [e.source || t('noData')], 12),
          ),
          breakdown(t('byPeople'), t('byPeopleNote'), t('b_name'), group((e) => e.people, 12)),
        ),
      );
      for (const figure of analysis.querySelectorAll('figure')) {
        const details = figure.querySelector('details');
        if (details && open.has(figure.querySelector('figcaption')?.textContent)) details.open = true;
      }
    });
  }

  // ---- controls -----------------------------------------------------------

  const search = h('input', {
    type: 'search',
    class: 'evx-search',
    placeholder: t('search'),
    'aria-label': t('search'),
    'data-key': 'search',
    value: memory.filters.query,
    autocomplete: 'off',
  });
  let timer = 0;
  search.addEventListener('input', () => {
    memory.filters.query = search.value;
    window.clearTimeout(timer);
    timer = window.setTimeout(changed, 160);
  });

  const sortSelect = h(
    'select',
    {
      class: 'evx-select',
      'data-key': 'sort',
      onchange: (event: Event) => setSort((event.target as HTMLSelectElement).value as Sort),
    },
    ...SORTS.map((sort) => h('option', { value: sort }, t(`sort_${sort}`))),
  );

  const viewButtons = (['timeline', 'table'] as const).map((view) =>
    h(
      'button',
      {
        type: 'button',
        class: 'evx-btn',
        'data-key': `view-${view}`,
        onclick: () => {
          memory.view = view;
          syncControls();
          renderList();
        },
      },
      t(view),
    ),
  );

  const optionLabel = (facet: Facet, key: string): string => {
    if (facet === 'lang') return key ? ui.language(key) : t('noData');
    const prefix = { type: 't', tone: 'tone', level: 'level', origin: 'origin' }[facet];
    return t(`${prefix}_${key}` as Key);
  };

  const chips: { facet: Facet; key: string; button: HTMLButtonElement; count: HTMLElement }[] = [];
  const groups = FACETS.map((facet) => {
    const available = [...new Set(model.events.map((e) => facetValue(e, facet)))];
    const order = ORDER[facet];
    const keys = order ? order.filter((k) => available.includes(k) || memory.filters[facet].has(k)) : available.sort();
    return h(
      'fieldset',
      { class: 'evx-facet' },
      h('legend', {}, t(`f_${facet}`)),
      ...keys.map((key) => {
        const count = h('span', { class: 'evx-count evx-num' });
        const button = h(
          'button',
          {
            type: 'button',
            class: 'evx-chip',
            'data-key': `chip-${facet}-${key}`,
            onclick: () => {
              const set = memory.filters[facet];
              if (!set.delete(key)) set.add(key);
              changed();
            },
          },
          h('span', { class: 'evx-check', 'aria-hidden': 'true' }),
          facet === 'type' ? typeGlyph(key as EventType) : null,
          optionLabel(facet, key),
          count,
        );
        chips.push({ facet, key, button, count });
        return button;
      }),
    );
  });

  const filtersSummary = h('summary', { 'data-key': 'filters' });
  const filtersBox = h(
    'details',
    { class: 'evx-filters', open: memory.filtersOpen },
    filtersSummary,
    h('div', { class: 'evx-facets' }, ...groups),
  );
  filtersBox.addEventListener('toggle', () => {
    memory.filtersOpen = filtersBox.open;
  });

  const reset = h(
    'button',
    {
      type: 'button',
      class: 'evx-btn',
      'data-key': 'reset',
      onclick: () => {
        memory.filters = noFilters();
        search.value = '';
        changed();
        search.focus();
      },
    },
    t('reset'),
  );

  function syncControls(): void {
    sortSelect.value = memory.sort;
    viewButtons.forEach((button, i) => {
      button.setAttribute('aria-pressed', String((i === 0 ? 'timeline' : 'table') === memory.view));
    });
    const counts = new Map(FACETS.map((facet) => [facet, facetCounts(model.events, memory.filters, facet)]));
    for (const chip of chips) {
      const n = counts.get(chip.facet)?.get(chip.key) ?? 0;
      chip.count.textContent = String(n);
      chip.button.setAttribute('aria-pressed', String(memory.filters[chip.facet].has(chip.key)));
      chip.button.classList.toggle('evx-zero-count', n === 0);
    }
    const active = FACETS.reduce((sum, facet) => sum + memory.filters[facet].size, 0);
    filtersSummary.textContent = active ? t('filtersActive', { n: active }) : t('filters');
    reset.disabled = !active && !memory.filters.query;
  }

  function apply(): void {
    shown = sortEvents(filterEvents(model.events, memory.filters), memory.sort);
  }

  function setSort(sort: Sort): void {
    memory.sort = SORTS.includes(sort) ? sort : 'newest';
    memory.page = 0;
    apply();
    syncControls();
    renderList();
    renderDetail();
  }

  function changed(): void {
    memory.page = 0;
    apply();
    syncControls();
    renderSummary();
    renderList();
    renderDetail();
    renderAnalysis();
  }

  // ---- assembly -----------------------------------------------------------

  const total = model.pipeline?.stages.find((s) => s.id === 'deduped')?.count ?? null;
  const hasPq = model.events.some((e) => (e.impact?.p ?? e.impact?.q ?? null) !== null);

  root.append(
    h(
      'header',
      { class: 'evx-head' },
      h('h2', {}, t('eventsTitle')),
      h(
        'p',
        { class: 'evx-note' },
        total !== null && total >= model.events.length
          ? t('listedOf', { n: model.events.length, total })
          : t('listed', { n: model.events.length }),
        ' ',
        t('caveat'),
        hasPq ? '' : ` ${t('noPq')}`,
      ),
    ),
    h(
      'div',
      { class: 'evx-controls', role: 'search' },
      h(
        'div',
        { class: 'evx-toolbar' },
        search,
        h('label', { class: 'evx-inline' }, t('sort'), sortSelect),
        h('div', { class: 'evx-segment', role: 'group', 'aria-label': t('view') }, ...viewButtons),
        reset,
        h(
          'button',
          {
            type: 'button',
            class: 'evx-btn',
            'data-key': 'jump',
            onclick: () => {
              analysis.scrollIntoView({ block: 'start' });
              analysis.querySelector('h2')?.focus({ preventScroll: true });
            },
          },
          `${t('analysis')} ↓`,
        ),
      ),
      filtersBox,
    ),
    summary,
    main,
    analysis,
  );

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && memory.selected && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      select(null);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.dataset.key?.startsWith('row-') || !listBody.contains(target)) return;
    const rows = [...listBody.querySelectorAll<HTMLElement>('[data-key^="row-"]')];
    const next = rows[rows.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });

  apply();
  if (external) memory.page = pageOfSelected() ?? memory.page;
  syncControls();
  renderSummary();
  renderList();
  renderDetail();
  renderAnalysis();

  if (focusKey || (external && memory.selected)) {
    afterAttach(() => {
      if (!root.isConnected) return;
      if (focusKey) {
        const node = find(root, focusKey);
        node?.focus({ preventScroll: true });
        if (node instanceof HTMLInputElement && caret !== null) node.setSelectionRange(caret, caret);
      }
      if (external && memory.selected) reveal(memory, !focusKey);
    });
  }
}
