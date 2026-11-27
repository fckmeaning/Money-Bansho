// Left column: search, region filter and the company list with live quotes.
import raw from '../../shared/dossier-companies.json';
import { h, pct, price, tone, updatedLabel } from './dom';
import { regionName, t } from './i18n';
import { REGIONS } from './types';
import type { Board, Company } from './types';

export const companies: Company[] = (raw as Company[]).map((c) => ({
  symbol: c.symbol,
  name: c.name,
  aliases: c.aliases ?? [],
  country: c.country,
  region: c.region,
}));

export const SYMBOL_RE = /^[A-Za-z0-9^][A-Za-z0-9.^=-]{0,19}$/;

const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
const haystack = new Map(companies.map((c) => [c.symbol, fold([c.symbol, c.name, ...c.aliases].join('\n'))]));

export interface ListState {
  query: string;
  region: string;
  symbol: string | null;
  board: Board | null;
  boardFailed: boolean;
}

export function createCompanyList(
  host: HTMLElement,
  state: () => ListState,
  actions: { setQuery(q: string): void; setRegion(r: string): void; open(symbol: string): void },
): { render(): void; relabel(): void } {
  const input = h('input', {
    type: 'search',
    class: 'search',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: 60,
    oninput: () => {
      actions.setQuery(input.value);
      rows.scrollTop = 0;
    },
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        const first = rows.querySelector<HTMLButtonElement>('button');
        first?.click();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        rows.querySelector<HTMLButtonElement>('button')?.focus();
      }
    },
  });
  const regions = h('div', { class: 'chips regions' });
  const rows = h('div', {
    class: 'list',
    onkeydown: (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const buttons = [...rows.querySelectorAll<HTMLButtonElement>('button')];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = buttons[at + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) next.focus();
      else if (event.key === 'ArrowUp') input.focus();
    },
  });
  const foot = h('div', { class: 'list-foot muted' });
  host.replaceChildren(h('div', { class: 'list-head' }, input, regions), rows, foot);

  function relabel(): void {
    input.placeholder = t('search');
    input.setAttribute('aria-label', t('search'));
  }

  function render(): void {
    const { query, region, symbol, board, boardFailed } = state();
    const q = fold(query.trim());
    const matches = companies.filter(
      (c) => (region === 'all' || c.region === region) && (!q || haystack.get(c.symbol)?.includes(q)),
    );
    const focused = (document.activeElement as HTMLElement | null)?.dataset.key;
    const scroll = rows.scrollTop;

    regions.replaceChildren(
      ...['all', ...REGIONS].map((r) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip',
            'data-key': `region-${r}`,
            'aria-pressed': String(region === r),
            onclick: () => actions.setRegion(r),
          },
          r === 'all' ? t('all') : regionName(r),
        ),
      ),
    );

    const items = matches.map((c) => {
      const quote = board?.quotes.get(c.symbol);
      return h(
        'button',
        {
          type: 'button',
          class: 'company',
          'data-key': `company-${c.symbol}`,
          'aria-current': symbol === c.symbol ? 'true' : null,
          onclick: () => actions.open(c.symbol),
        },
        h('b', { class: 'mono' }, c.symbol),
        h('span', { class: 'mono num' }, price(quote?.price)),
        h('span', { class: 'name clamp1', dir: 'auto' }, c.name),
        h('span', { class: `mono num ${tone(quote?.changePct)}` }, pct(quote?.changePct)),
      );
    });

    // A ticker outside the curated list can still be opened.
    const typed = query.trim().toUpperCase();
    if (SYMBOL_RE.test(typed) && !companies.some((c) => c.symbol.toUpperCase() === typed)) {
      items.push(
        h(
          'button',
          { type: 'button', class: 'company open-symbol', 'data-key': 'open', onclick: () => actions.open(typed) },
          `${t('openSymbol')} ${typed}`,
        ),
      );
    }
    rows.replaceChildren(...items);
    if (matches.length === 0) rows.prepend(h('div', { class: 'empty' }, t('noMatch')));
    rows.scrollTop = scroll;
    if (focused) host.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });

    foot.replaceChildren(
      h('span', {}, t('listCount', { n: matches.length })),
      board
        ? updatedLabel(board.updatedAt)
        : h('span', {}, boardFailed ? t('quotesNoData') : t('loading')),
      ...(board && boardFailed ? [h('span', { class: 'down' }, t('stale'))] : []),
    );
  }

  relabel();
  return { render, relabel };
}
