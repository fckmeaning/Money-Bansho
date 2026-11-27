// Small DOM building blocks shared by both views.
import { h } from '../dom';
import type { Lang } from './format';
import { strings } from './strings';

let counter = 0;
export const uid = (prefix: string): string => `mbx-${prefix}-${(counter += 1)}`;

export function panel(title: string, ...children: (Node | null)[]): HTMLElement {
  return h(
    'section',
    { class: 'mbx-panel', 'aria-label': title },
    h('header', { class: 'mbx-panel-head' }, h('h3', {}, title)),
    ...children,
  );
}

export const note = (text: string): HTMLElement => h('p', { class: 'mbx-note' }, text);

export const empty = (lang: Lang, text?: string): HTMLElement =>
  h('p', { class: 'mbx-empty' }, text ?? strings(lang).noData);

export const missing = (lang: Lang): HTMLElement => h('span', { class: 'mbx-missing' }, strings(lang).noData);

export function segmented<T extends string>(
  label: string,
  options: readonly (readonly [T, string])[],
  initial: T,
  onChange: (value: T) => void,
): HTMLElement {
  const buttons = options.map(([value, text]) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(value === initial),
        onclick: () => {
          buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i]?.[0] === value)));
          onChange(value);
        },
      },
      text,
    ),
  );
  return h('div', { class: 'mbx-segment', role: 'group', 'aria-label': label }, ...buttons);
}

export interface Picker {
  el: HTMLLabelElement;
  select: HTMLSelectElement;
  set(options: readonly (readonly [string, string])[], value: string): void;
}

export function picker(label: string, onChange: (value: string) => void): Picker {
  const select = h('select', { onchange: () => onChange(select.value) });
  return {
    el: h('label', { class: 'mbx-picker' }, h('span', {}, label), select),
    select,
    set(options, value) {
      select.replaceChildren(...options.map(([v, text]) => h('option', { value: v }, text)));
      select.value = value;
    },
  };
}

export interface HeadCell { text: string; numeric?: boolean }

export function table(caption: string, head: HeadCell[], rows: Node[], className = ''): HTMLTableElement {
  return h(
    'table',
    { class: `mbx-table ${className}`.trim() },
    h('caption', { class: 'mbx-sr' }, caption),
    h(
      'thead',
      {},
      h('tr', {}, ...head.map((c) => h('th', { scope: 'col', class: c.numeric ? 'num' : '' }, c.text))),
    ),
    h('tbody', {}, ...rows),
  );
}

export function scroller(content: Node, label: string, className = ''): HTMLElement {
  return h(
    'div',
    { class: `mbx-scroll ${className}`.trim(), tabindex: 0, role: 'region', 'aria-label': label },
    content,
  );
}

export interface Lazy { el: HTMLDetailsElement; refresh(): void }

/** A disclosure whose content is built only while open. */
export function disclosure(summary: string, render: () => Node, className = ''): Lazy {
  const body = h('div', { class: 'mbx-details-body' });
  const el = h('details', { class: `mbx-details ${className}`.trim() }, h('summary', {}, summary), body);
  const refresh = () => {
    if (el.open) body.replaceChildren(render());
    else body.replaceChildren();
  };
  el.addEventListener('toggle', refresh);
  return { el, refresh };
}

/** A bar from zero on a shared [lo, hi] scale; the value itself is printed next to it by the caller. */
export function track(value: number | null, lo: number, hi: number, kind: 'sign' | 'a' | 'b' = 'sign'): HTMLElement {
  const low = Math.min(0, lo);
  const high = Math.max(0, hi);
  const span = high - low || 1;
  const at = (v: number) => ((v - low) / span) * 100;
  const node = h('span', { class: 'mbx-track', 'aria-hidden': 'true' });
  if (low < 0 && high > 0) node.append(h('i', { class: 'mbx-zero', style: `left:${at(0)}%` }));
  if (value !== null) {
    const from = Math.min(at(0), at(value));
    const width = Math.abs(at(value) - at(0));
    const cls = kind === 'sign' ? (value < 0 ? 'neg' : 'pos') : kind;
    node.append(h('b', { class: cls, style: `left:${from}%;width:${width}%` }));
  }
  return node;
}

/** Background tint for a table cell. The number is always printed, so shading is secondary. */
export function tint(strength: number, kind: 'pos' | 'neg' | 'flat'): string {
  const share = Math.round(6 + Math.max(0, Math.min(1, strength)) * (kind === 'flat' ? 16 : 34));
  return `background-color:color-mix(in srgb, var(--mbx-${kind}) ${share}%, transparent)`;
}

export function downloadCsv(filename: string, rows: (string | number | null)[][], lang: Lang): void {
  const separator = lang === 'ru' ? ';' : ',';
  const cell = (value: string | number | null): string => {
    if (value === null) return '';
    if (typeof value === 'number') return lang === 'ru' ? String(value).replace('.', ',') : String(value);
    // Text that a spreadsheet would run as a formula is prefixed with an apostrophe.
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /["\r\n,;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const body = rows.map((row) => row.map(cell).join(separator)).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿', body], { type: 'text/csv;charset=utf-8' }));
  const anchor = h('a', { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Calls `draw` with the host width whenever it changes; hidden hosts are skipped. */
export function observeWidth(host: HTMLElement, draw: (width: number) => void): () => void {
  let last = 0;
  const observer = new ResizeObserver(() => {
    const width = Math.floor(host.clientWidth);
    if (width < 40 || width === last) return;
    last = width;
    draw(width);
  });
  observer.observe(host);
  return () => observer.disconnect();
}
