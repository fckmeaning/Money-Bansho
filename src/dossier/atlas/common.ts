// Shared context of the analytics sections: formatting, region markers, a sortable
// table used by every section, and small tooltips.
import { symbol as d3symbol, symbolCircle, symbolCross, symbolDiamond, symbolSquare, symbolStar, symbolTriangle } from 'd3';
import { formatValue, localeOf } from '../analytics/format';
import type { Lang, Unit } from '../analytics/format';
import { nameOf } from '../analytics/strings';
import { downloadCsv, scroller } from '../analytics/ui';
import { h, s } from '../dom';
import type { Atlas, Column, CoMentions, Nullable } from './data';
import type { Strings } from './strings';

export interface Context {
  lang: Lang;
  t: Strings;
  atlas: Atlas;
  /** Opens the company dossier. */
  open: (symbol: string) => void;
  /** Headline co-mentions, loaded on demand and shared by the sections. */
  news: () => Promise<CoMentions>;
}

/** A section owns its nodes; dispose() detaches its observers. */
export interface Section { el: HTMLElement; dispose: () => void }

const REGION_ORDER = ['us', 'china', 'europe', 'israel', 'korea', 'other'];
const SYMBOLS = [symbolCircle, symbolSquare, symbolDiamond, symbolTriangle, symbolCross, symbolStar];

export const regionClass = (region: string): string => `atl-r${Math.max(0, REGION_ORDER.indexOf(region))}`;
export const regionName = (region: string, lang: Lang): string => nameOf(region, lang);
export const regionsOf = (atlas: Atlas): string[] =>
  [...new Set(atlas.rows.map((r) => r.region))].sort((a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b));

/** SVG path of the region's marker with the area of a circle of radius r. */
export function markerPath(region: string, r: number): string {
  const type = SYMBOLS[Math.max(0, REGION_ORDER.indexOf(region)) % SYMBOLS.length] ?? symbolCircle;
  return d3symbol(type, Math.PI * r * r)() ?? '';
}

export function regionKey(region: string, lang: Lang): HTMLElement {
  return h(
    'span',
    { class: 'mbx-key' },
    s(
      'svg',
      { width: 12, height: 12, viewBox: '-6 -6 12 12', 'aria-hidden': 'true' },
      s('path', { d: markerPath(region, 4.6), class: `atl-mark ${regionClass(region)}` }),
    ),
    regionName(region, lang),
  );
}

export const columnOf = (atlas: Atlas, id: string): Column | undefined => atlas.columns.find((c) => c.id === id);

export const text = (value: Nullable | undefined, unit: Unit, lang: Lang, signed = false): string | null =>
  value === null || value === undefined ? null : formatValue(value, unit, lang, signed);

export function median(values: number[]): Nullable {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export const present = (values: (Nullable | undefined)[]): number[] =>
  values.filter((v): v is number => typeof v === 'number');

/** A positioned tooltip inside a relatively positioned host. */
export function tooltip(host: HTMLElement): { show(x: number, y: number, ...lines: string[]): void; hide(): void; el: HTMLElement } {
  const el = h('div', { class: 'mbx-tip', hidden: true });
  return {
    el,
    show(x, y, ...lines) {
      el.replaceChildren(...lines.map((line, i) => h(i ? 'span' : 'b', {}, line)));
      el.hidden = false;
      const width = host.clientWidth;
      el.style.left = `${Math.max(0, Math.min(x + 12, width - el.offsetWidth - 2))}px`;
      el.style.top = `${Math.max(0, y - el.offsetHeight - 8)}px`;
    },
    hide() {
      el.hidden = true;
    },
  };
}

// ---- sortable table -------------------------------------------------------

export interface GridColumn<T> {
  id: string;
  label: string;
  numeric?: boolean;
  /** Sorting and CSV value; null sorts last. */
  value: (row: T) => number | string | null;
  /** Cell content; defaults to the value as text. */
  cell?: (row: T) => Node | string | null;
  /** Value of a summary row. */
  foot?: (rows: T[]) => string | null;
}

export interface GridState { sort: string; dir: 1 | -1 }

export interface GridOptions<T> {
  lang: Lang;
  caption: string;
  noData: string;
  state: GridState;
  onOpen?: (row: T) => void;
  selected?: (row: T) => boolean;
  /** Rows drawn before "show more". */
  limit?: number;
  more?: (left: number) => string;
  footLabel?: string;
  className?: string;
}

export interface Grid<T> {
  el: HTMLElement;
  set(columns: GridColumn<T>[], rows: T[]): void;
  csv(filename: string): void;
}

/** First column is the row header and stays in place on horizontal scrolling. */
export function grid<T>(options: GridOptions<T>): Grid<T> {
  const { lang, state } = options;
  const collator = new Intl.Collator(localeOf(lang), { numeric: true, sensitivity: 'base' });
  let columns: GridColumn<T>[] = [];
  let rows: T[] = [];
  let limit = options.limit ?? Number.POSITIVE_INFINITY;
  const thead = h('thead', {});
  const tbody = h('tbody', {});
  const tfoot = h('tfoot', {});
  const more = h('div', { class: 'atl-more' });
  const table = h(
    'table',
    { class: `mbx-table atl-grid ${options.className ?? ''}`.trim() },
    h('caption', { class: 'mbx-sr' }, options.caption),
    thead,
    tbody,
    tfoot,
  );
  const el = h('div', {}, scroller(table, options.caption, 'atl-scroll'), more);

  const sorted = (): T[] => {
    const column = columns.find((c) => c.id === state.sort);
    if (!column) return rows;
    return [...rows].sort((a, b) => {
      const x = column.value(a);
      const y = column.value(b);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      if (typeof x === 'number' && typeof y === 'number') return state.dir * (x - y);
      return state.dir * collator.compare(String(x), String(y));
    });
  };

  const head = () => {
    thead.replaceChildren(
      h(
        'tr',
        {},
        ...columns.map((c) => {
          const active = c.id === state.sort;
          return h(
            'th',
            {
              scope: 'col',
              class: c.numeric ? 'num' : '',
              'aria-sort': active ? (state.dir === 1 ? 'ascending' : 'descending') : null,
            },
            h(
              'button',
              {
                type: 'button',
                'data-key': c.id,
                onclick: () => {
                  // Numbers start from the largest, texts from the first letter.
                  if (state.sort === c.id) state.dir = state.dir === 1 ? -1 : 1;
                  else {
                    state.sort = c.id;
                    state.dir = c.numeric ? -1 : 1;
                  }
                  draw();
                  thead.querySelector<HTMLElement>(`[data-key="${CSS.escape(c.id)}"]`)?.focus({ preventScroll: true });
                },
              },
              c.label,
              h('i', { 'aria-hidden': 'true' }, active ? (state.dir === 1 ? ' ▲' : ' ▼') : ''),
            ),
          );
        }),
      ),
    );
  };

  const content = (column: GridColumn<T>, row: T): Node | string => {
    const made = column.cell ? column.cell(row) : column.value(row);
    if (made === null) return h('span', { class: 'mbx-missing' }, options.noData);
    return typeof made === 'number' ? String(made) : made;
  };

  const draw = () => {
    head();
    const all = sorted();
    tbody.replaceChildren(
      ...all.slice(0, limit).map((row) => {
        const tr = h(
          'tr',
          {
            class: `${options.onOpen ? 'atl-clickable' : ''}${options.selected?.(row) ? ' selected' : ''}`,
            onclick: options.onOpen
              ? (event: MouseEvent) => {
                  if ((event.target as Element).closest('a, button')) return;
                  if (window.getSelection()?.toString()) return;
                  options.onOpen?.(row);
                }
              : null,
          },
          ...columns.map((c, i) => h(i ? 'td' : 'th', { class: c.numeric ? 'num' : '', scope: i ? null : 'row' }, content(c, row))),
        );
        return tr;
      }),
    );
    tfoot.replaceChildren();
    if (options.footLabel && all.length && columns.some((c) => c.foot)) {
      tfoot.append(
        h(
          'tr',
          {},
          ...columns.map((c, i) =>
            i
              ? h('td', { class: c.numeric ? 'num' : '' }, c.foot?.(all) ?? '')
              : h('th', { scope: 'row' }, options.footLabel),
          ),
        ),
      );
    }
    more.replaceChildren();
    if (all.length > limit) {
      more.append(
        h(
          'button',
          {
            type: 'button',
            class: 'mbx-button',
            onclick: () => {
              limit += options.limit ?? 50;
              draw();
            },
          },
          options.more?.(all.length - limit) ?? '+',
        ),
      );
    }
  };

  return {
    el,
    set(nextColumns, nextRows) {
      columns = nextColumns;
      rows = nextRows;
      limit = options.limit ?? Number.POSITIVE_INFINITY;
      draw();
    },
    csv(filename) {
      downloadCsv(filename, [columns.map((c) => c.label), ...sorted().map((row) => columns.map((c) => c.value(row)))], lang);
    },
  };
}

/** A ticker button that opens the dossier. */
export const tickerLink = (symbol: string, open: (symbol: string) => void): HTMLElement =>
  h('button', { type: 'button', class: 'mbx-link', onclick: () => open(symbol) }, symbol);
