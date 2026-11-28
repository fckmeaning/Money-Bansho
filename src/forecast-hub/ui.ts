// Shared state and controls of the forecast pages.
import { companies } from '../dossier/companies';
import { h } from '../dossier/dom';
import { locale, regionName, uiLang } from '../dossier/i18n';
import { REGIONS } from '../dossier/types';
import { WORDS } from './text';

const SYMBOL_KEY = 'bansho-forecast-symbol';

const stored = (): string => {
  try {
    const value = window.localStorage.getItem(SYMBOL_KEY) ?? '';
    return companies.some((c) => c.symbol === value) ? value : 'NVDA';
  } catch {
    return 'NVDA';
  }
};

export const state = { symbol: stored(), horizon: 5 as 1 | 5 | 20, query: '', region: '' };

export function selectSymbol(symbol: string): void {
  state.symbol = symbol;
  try {
    window.localStorage.setItem(SYMBOL_KEY, symbol);
  } catch {
    // Storage blocked: the choice lasts until the page is closed.
  }
}

/** Set by main.ts: redraws the current route in place. */
export const app = { redraw: () => {} };

export const words = () => WORDS[uiLang()];
export const dec = (v: number, digits = 1) => v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const signed = (v: number, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${dec(Math.abs(v), digits)}`;
export const share = (x: number, digits = 1) => `${dec(x * 100, digits)}%`;
export const pctText = (x: number, digits = 1) => `${dec(x, digits)}%`;
/** A figure written with a point (copied from the report) in the notation of the language. */
export const local = (text: string) => (uiLang() === 'ru' ? text.replace(/(\d)\.(\d)/g, '$1,$2') : text);
export const companyHref = (symbol: string) => `#/company/${encodeURIComponent(symbol)}`;
export const missing = () => h('div', { class: 'empty' }, words().none);

/** Goes to a route; when it is the current one, only redraws. */
export function go(hash: string, symbol?: string): void {
  if (symbol) selectSymbol(symbol);
  if ((window.location.hash || '#/') === hash) app.redraw();
  else window.location.hash = hash;
}

/** A block that shows "loading" until the answer arrives, then the content or "no data" with a retry. */
export function later<T>(promise: Promise<T>, build: (data: T) => (Node | null)[], loading: string, className = 'fh-stack'): HTMLElement {
  const box = h('div', { class: className }, h('div', { class: 'empty' }, loading));
  const put = (nodes: (Node | null)[]) => box.replaceChildren(...nodes.filter((n): n is Node => n !== null));
  promise.then(
    (data) => {
      try {
        put(build(data));
      } catch (error) {
        console.error('[forecast] view failed', error);
        put([missing()]);
      }
    },
    (error) => {
      console.error('[forecast] load failed', error);
      put([h('div', { class: 'empty error' }, h('span', {}, words().failed), h('button', { type: 'button', class: 'retry', onclick: () => app.redraw() }, words().retry))]);
    },
  );
  return box;
}

export function horizonSwitch(): HTMLElement {
  const w = words();
  return h(
    'div',
    { class: 'segment', role: 'group', 'aria-label': w.horizon },
    ...([1, 5, 20] as const).map((n) => h(
      'button',
      {
        type: 'button', 'aria-pressed': String(state.horizon === n), 'data-key': `h${n}`,
        onclick: () => {
          state.horizon = n;
          app.redraw();
        },
      },
      w[`h${n}`],
    )),
  );
}

const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

/** Search and choice among all listed companies. */
export function picker(selected: string, onPick: (symbol: string) => void): HTMLElement {
  const w = words();
  const list = h('div', { class: 'fh-list' });
  const regions = h('div', { class: 'fh-actions' });
  const draw = () => {
    const q = fold(state.query.trim());
    const found = companies.filter((c) =>
      (!state.region || c.region === state.region) && (!q || fold([c.symbol, c.name, ...c.aliases].join('\n')).includes(q)));
    regions.replaceChildren(...['', ...REGIONS].map((r) => h(
      'button',
      {
        type: 'button', class: 'fh-toggle', 'aria-pressed': String(state.region === r),
        onclick: () => {
          state.region = r;
          draw();
        },
      },
      r ? regionName(r) : w.all,
    )));
    list.replaceChildren(
      ...found.map((c) => h(
        'button',
        { type: 'button', class: 'fh-company', 'aria-current': c.symbol === selected ? 'true' : null, onclick: () => onPick(c.symbol) },
        h('b', { class: 'mono' }, c.symbol),
        h('span', { class: 'clamp1' }, c.name),
      )),
      ...(found.length ? [] : [h('div', { class: 'empty' }, w.noMatch)]),
    );
  };
  const input = h('input', {
    type: 'search', class: 'fh-search', placeholder: w.search, 'aria-label': w.search, autocomplete: 'off', value: state.query,
    oninput: () => {
      state.query = input.value;
      draw();
    },
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') list.querySelector('button')?.click();
    },
  });
  draw();
  return h('div', { class: 'fh-picker' }, input, regions, list);
}
