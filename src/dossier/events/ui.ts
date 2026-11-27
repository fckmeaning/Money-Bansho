// Formatting in the requested language and small shared DOM pieces.
import { h } from '../dom';
import { exchangeDay } from '../zone';
import { translator } from './strings';
import type { Lang, T } from './strings';

const MINUS = '−';

export interface Ui {
  lang: Lang;
  t: T;
  num(value: number | null, digits?: number): string;
  signed(value: number | null, digits?: number, suffix?: string): string;
  /** p and q values: small ones must not round to zero. */
  prob(value: number | null): string;
  int(value: number | null): string;
  compact(value: number | null): string;
  dateTime(time: number | null): string;
  date(time: number): string;
  time(time: number): string;
  dayLabel(time: number): string;
  /** Daily bars are labelled by their UTC date. */
  barDate(time: number, short?: boolean): string;
  shortDate(time: number): string;
  month(time: number): string;
  duration(ms: number | null): string;
  language(code: string): string;
}

export function makeUi(lang: Lang): Ui {
  const t = translator(lang);
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
  const cache = new Map<string, Intl.DateTimeFormat>();
  const dtf = (key: string, options: Intl.DateTimeFormatOptions) => {
    let format = cache.get(key);
    if (!format) cache.set(key, (format = new Intl.DateTimeFormat(locale, options)));
    return format;
  };
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: 'language' });
  } catch {
    names = null;
  }
  const num = (value: number | null, digits = 2) =>
    value === null
      ? t('noData')
      : value
          .toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
          .replace('-', MINUS);
  return {
    lang,
    t,
    num,
    signed(value, digits = 2, suffix = '') {
      if (value === null) return t('noData');
      const rounded = Number(value.toFixed(digits));
      const sign = rounded > 0 ? '+' : rounded < 0 ? MINUS : '';
      return `${sign}${num(Math.abs(rounded), digits)}${suffix}`;
    },
    prob(value) {
      if (value === null) return t('noData');
      return value < 0.001 ? `<${num(0.001, 3)}` : num(value, 3);
    },
    int: (value) => (value === null ? t('noData') : value.toLocaleString(locale, { maximumFractionDigits: 0 })),
    compact: (value) =>
      value === null
        ? t('noData')
        : new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value),
    dateTime: (time) =>
      time === null
        ? t('noData')
        : dtf('full', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(time),
    date: (time) => dtf('date', { year: 'numeric', month: 'short', day: 'numeric' }).format(time),
    time: (time) => dtf('time', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(time),
    dayLabel: (time) =>
      dtf('day', { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' }).format(time),
    barDate: (time, short = false) =>
      dtf(short ? 'barShort' : 'bar', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
        ...(short ? {} : { year: 'numeric' }),
      }).format(exchangeDay(time)),
    shortDate: (time) => dtf('short', { month: 'short', day: 'numeric' }).format(time),
    month: (time) => dtf('month', { month: 'short', year: '2-digit' }).format(time),
    duration(ms) {
      if (ms === null) return t('noData');
      if (ms < 1000) return `${num(ms, 0)} ${lang === 'ru' ? 'мс' : 'ms'}`;
      return `${num(ms / 1000, 2)} ${lang === 'ru' ? 'с' : 's'}`;
    },
    language(code) {
      if (!code) return t('noData');
      try {
        return names?.of(code) ?? code;
      } catch {
        return code;
      }
    },
  };
}

/** Text that is muted when a value is missing. */
export function value(ui: Ui, text: string, className = ''): HTMLElement {
  const missing = text === ui.t('noData');
  return h('span', { class: `${className}${missing ? ' evx-missing' : ''}`.trim() || null }, text);
}

export function toneKey(sentiment: number | null): 'pos' | 'neu' | 'neg' | 'none' {
  if (sentiment === null) return 'none';
  if (sentiment > 0.005) return 'pos';
  return sentiment < -0.005 ? 'neg' : 'neu';
}

const TONE_MARK = { pos: '▲', neu: '■', neg: '▼', none: '' };

/** Direction mark, number and colour, so colour is never the only cue. */
export function toneNode(ui: Ui, sentiment: number | null): HTMLElement {
  const key = toneKey(sentiment);
  if (key === 'none') return h('span', { class: 'evx-missing' }, ui.t('noData'));
  return h(
    'span',
    { class: `evx-num evx-tone-${key}`, title: ui.t(`tone_${key}`) },
    h('span', { class: 'evx-mark', 'aria-hidden': 'true' }, TONE_MARK[key]),
    ` ${ui.signed(sentiment)}`,
    h('span', { class: 'evx-sr' }, ` ${ui.t(`tone_${key}`)}`),
  );
}

export function moveNode(ui: Ui, move: number | null, suffix = '%'): HTMLElement {
  if (move === null) return h('span', { class: 'evx-missing' }, ui.t('noData'));
  const direction = move > 0.005 ? 'pos' : move < -0.005 ? 'neg' : 'neu';
  return h('span', { class: `evx-num evx-tone-${direction}` }, ui.signed(move, 2, suffix));
}

export type Cell = Node | string;

export interface Column {
  label: string;
  numeric?: boolean;
}

/** A table inside its own horizontally scrollable, keyboard reachable region. */
export function table(
  caption: string,
  columns: Column[],
  rows: Cell[][],
  options: { className?: string; rowHeader?: boolean; hideCaption?: boolean } = {},
): HTMLElement {
  const { className = '', rowHeader = true, hideCaption = true } = options;
  return h(
    'div',
    { class: 'evx-scroll', tabindex: 0, role: 'region', 'aria-label': caption },
    h(
      'table',
      { class: `evx-table ${className}`.trim() },
      h('caption', { class: hideCaption ? 'evx-sr' : null }, caption),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...columns.map((c) => h('th', { scope: 'col', class: c.numeric ? 'evx-r' : null }, c.label)),
        ),
      ),
      h(
        'tbody',
        {},
        ...rows.map((row) =>
          h(
            'tr',
            {},
            ...row.map((cell, i) => {
              const props = { class: columns[i]?.numeric ? 'evx-r evx-num' : null };
              return i === 0 && rowHeader
                ? h('th', { ...props, scope: 'row' }, cell)
                : h('td', props, cell);
            }),
          ),
        ),
      ),
    ),
  );
}

export interface Tile {
  label: string;
  value: string;
  note?: string;
}

export function tiles(ui: Ui, label: string, items: Tile[]): HTMLElement {
  return h(
    'dl',
    { class: 'evx-tiles', 'aria-label': label },
    ...items.map((item) =>
      h(
        'div',
        { class: 'evx-tile' },
        h('dt', {}, item.label),
        h('dd', {}, value(ui, item.value, 'evx-tile-value'), item.note ? h('small', {}, item.note) : null),
      ),
    ),
  );
}

export function panel(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'evx-panel' }, h('h3', {}, title), ...children);
}

/** Rebuild part of the view without dropping keyboard focus. */
export function keepFocus(container: HTMLElement, render: () => void): void {
  const active = document.activeElement;
  const key = active instanceof Element && container.contains(active) ? active.getAttribute('data-key') : null;
  render();
  if (key === null) return;
  const next = [...container.querySelectorAll<HTMLElement>('[data-key]')].find((n) => n.dataset.key === key);
  if (next && !(next as HTMLButtonElement).disabled) next.focus({ preventScroll: true });
  else container.querySelector<HTMLElement>('[tabindex="-1"]')?.focus({ preventScroll: true });
}
