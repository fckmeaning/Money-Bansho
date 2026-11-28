// DOM construction and formatting. All external text goes through text nodes;
// nothing in the dossier parses HTML.
import { locale, t, uiLang } from './i18n';
import type { EventType } from './types';
import { exchangeDay } from './zone';

type Child = Node | string | null | undefined | false;
type Props = Record<string, string | number | boolean | null | undefined | ((event: never) => void)>;

function apply(node: Element, props: Props, children: Child[]): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function') node.addEventListener(key.slice(2), value as EventListener);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  apply(node, props, children);
  return node;
}

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  apply(node, props, children);
  return node;
}

export function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function link(raw: string, text: string, className = ''): HTMLElement {
  const href = safeUrl(raw);
  const props: Props = { class: className, dir: 'auto' };
  if (!href) return h('span', props, text);
  return h(
    'a',
    {
      ...props,
      href,
      target: '_blank',
      rel: 'noopener noreferrer',
      onclick: (event: Event) => event.stopPropagation(),
    },
    text,
  );
}

/** One shape per event type, so type is readable without relying on colour. */
export function shape(type: EventType, cx: number, cy: number, r: number): SVGElement {
  const poly = (points: [number, number][]) =>
    s('polygon', { points: points.map(([x, y]) => `${cx + x * r},${cy + y * r}`).join(' ') });
  let node: SVGElement;
  switch (type) {
    case 'leadership':
      node = poly([[0, -1.25], [1.25, 0], [0, 1.25], [-1.25, 0]]);
      break;
    case 'politics':
      node = poly([[0, -1.15], [1.15, 0.9], [-1.15, 0.9]]);
      break;
    case 'regulation':
      node = poly([[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]]);
      break;
    case 'deal':
      node = poly([[0, 1.15], [1.15, -0.9], [-1.15, -0.9]]);
      break;
    case 'scandal':
      node = s('path', {
        d: `M${cx - r} ${cy - r}L${cx + r} ${cy + r}M${cx + r} ${cy - r}L${cx - r} ${cy + r}`,
        class: 'stroke',
      });
      break;
    case 'product':
      node = poly([[-1.1, 0], [-0.55, -1], [0.55, -1], [1.1, 0], [0.55, 1], [-0.55, 1]]);
      break;
    case 'earnings':
      node = s('circle', { cx, cy, r });
      break;
    default:
      node = s('circle', { cx, cy, r: r * 0.65 });
  }
  node.classList.add('shape', `ty-${type}`);
  return node;
}

export function glyph(type: EventType): SVGSVGElement {
  return s(
    'svg',
    { class: 'glyph', width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true' },
    shape(type, 5, 5, 3.5),
  );
}

// ---- formatting -----------------------------------------------------------

export const DASH = '—';
const MINUS = '−';

export function price(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  const digits = Math.abs(value) >= 10_000 ? 0 : Math.abs(value) < 1 ? 4 : 2;
  return value.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signed(value: number | null | undefined, digits = 2, suffix = ''): string {
  if (value === null || value === undefined) return DASH;
  const rounded = Number(value.toFixed(digits));
  const sign = rounded > 0 ? '+' : rounded < 0 ? MINUS : '';
  const body = Math.abs(rounded).toLocaleString(locale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${sign}${body}${suffix}`;
}

export const pct = (value: number | null | undefined): string => signed(value, 2, '%');

export function tone(value: number | null | undefined, deadzone = 0.005): string {
  if (value === null || value === undefined || Math.abs(value) < deadzone) return 'flat';
  return value > 0 ? 'up' : 'down';
}

/** Unsigned number with a fixed number of decimals. */
export function fixed(value: number | null | undefined, digits = 2, suffix = ''): string {
  if (value === null || value === undefined) return t('noData');
  const body = value.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${body.replace('-', MINUS)}${suffix}`;
}

/** A share in 0..1 shown as a percentage. */
export const share = (value: number | null | undefined, digits = 0): string =>
  value === null || value === undefined ? t('noData') : fixed(value * 100, digits, '%');

/** Signed value, or the "no data" text where a dash would be too terse. */
export const signedText = (value: number | null | undefined, digits = 2, suffix = ''): string =>
  value === null || value === undefined ? t('noData') : signed(value, digits, suffix);

/** p- and q-values: three decimals, never rounded down to a misleading zero. */
export function pValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  return value < 0.001 ? `<${fixed(0.001, 3)}` : fixed(value, 3);
}

/** Small parameters such as GARCH omega, in scientific notation when needed. */
export function precise(value: number | null | undefined): string {
  if (value === null || value === undefined) return t('noData');
  if (value !== 0 && Math.abs(value) < 0.001) {
    const [mantissa = '', exponent = ''] = value.toExponential(2).split('e');
    return `${fixed(Number(mantissa), 2)}·10^${exponent.replace('-', MINUS).replace('+', '')}`;
  }
  return fixed(value, 4);
}

export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  return new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function format(time: number, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? DASH : new Intl.DateTimeFormat(locale(), options).format(date);
}

export function stamp(time: number): string {
  const otherYear = new Date(time).getFullYear() !== new Date().getFullYear();
  return format(time, {
    // Russian short month names are long; digits keep the time column narrow.
    month: uiLang() === 'ru' ? '2-digit' : 'short',
    day: uiLang() === 'ru' ? '2-digit' : 'numeric',
    ...(otherYear ? { year: '2-digit' } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  });
}

/** Daily bars are labelled by the exchange's calendar date, so it does not shift with the viewer. */
export function barDate(time: number, withYear = false): string {
  return format(exchangeDay(time), {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

export function age(since: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - since) / 1000));
  const [s_, m, hr, d] = uiLang() === 'ru' ? ['с', 'мин', 'ч', 'д'] : ['s', 'm', 'h', 'd'];
  const gap = uiLang() === 'ru' ? ' ' : '';
  if (sec < 120) return `${sec}${gap}${s_}`;
  if (sec < 7200) return `${Math.floor(sec / 60)}${gap}${m}`;
  if (sec < 172_800) return `${Math.floor(sec / 3600)}${gap}${hr}`;
  return `${Math.floor(sec / 86_400)}${gap}${d}`;
}

/** An element whose "updated Ns ago" text is refreshed by tickAges(). */
export function updatedLabel(since: number): HTMLElement {
  return h('span', { class: 'updated mono', 'data-since': since }, t('updated', { age: age(since) }));
}

export function tickAges(root: ParentNode = document): void {
  const now = Date.now();
  for (const node of root.querySelectorAll<HTMLElement>('[data-since]')) {
    node.textContent = t('updated', { age: age(Number(node.dataset.since), now) });
  }
}
