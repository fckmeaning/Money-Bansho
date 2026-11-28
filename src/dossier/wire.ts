// Live wire: latest events across companies, leadership radar and biggest movers.
import { glyph, h, pct, price, stamp, tone, updatedLabel } from './dom';
import { locale, t } from './i18n';
import { consequencesOf, empty, headline, panel, sourceLine, typeFilters, typeTag } from './panels';
import type { Board, Company, EventType, Wire, WireEvent } from './types';

export interface WireOptions {
  data: Wire;
  activeTypes: ReadonlySet<EventType>;
  newIds: ReadonlySet<string>;
  limit: number;
  onToggle(type: EventType | null): void;
  onMore(): void;
  onOpen(event: WireEvent): void;
}

export const wireKey = (event: WireEvent): string => `${event.symbol}|${event.id}`;

/** No handler of its own: the click bubbles to the row or card, which opens the company. */
const companyButton = (event: WireEvent, scope: string): HTMLElement =>
  h(
    'button',
    { type: 'button', class: 'linklike company-cell', 'data-key': `${scope}-${wireKey(event)}` },
    h('b', { class: 'mono gold' }, event.symbol),
    h('span', { class: 'clamp1', dir: 'auto' }, event.name),
  );

export function wireFeed(o: WireOptions): HTMLElement {
  const all = o.data.events;
  const events = o.activeTypes.size ? all.filter((e) => o.activeTypes.has(e.type)) : all;
  let day = '';
  const rows = events.slice(0, o.limit).flatMap((event) => {
    const open = () => o.onOpen(event);
    const date = new Date(event.time).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
    const heading = date === day ? [] : [h('li', { class: 'day-head' }, date)];
    day = date;
    const row = h(
      'li',
      { class: `row wire-row ev-${event.type}${o.newIds.has(wireKey(event)) ? ' fresh' : ''}`, onclick: open },
      h('span', { class: 'time mono' }, stamp(event.time)),
      companyButton(event, 'wire'),
      typeTag(event.type),
      h('div', { class: 'title-cell' }, headline(event), sourceLine(event), consequencesOf(event, `wire-${event.symbol}`)),
      h('span', { class: `num mono ${tone(event.changePct)}`, 'data-label': t('colDay') }, pct(event.changePct)),
    );
    return [...heading, row];
  });
  return panel(
    t('latest'),
    updatedLabel(o.data.updatedAt),
    typeFilters(all, o.activeTypes, o.onToggle),
    events.length
      ? h(
          'div',
          { class: 'table' },
          h(
            'div',
            { class: 'row row-head wire-row', 'aria-hidden': 'true' },
            ...(['colTime', 'colCompany', 'colType', 'colHeadline', 'colDay'] as const).map((key) =>
              h('span', {}, t(key)),
            ),
          ),
          h('ol', {}, ...rows),
          events.length > o.limit
            ? h(
                'button',
                { type: 'button', class: 'more', 'data-key': 'more', onclick: o.onMore },
                t('showMore', { n: Math.min(60, events.length - o.limit) }),
              )
            : null,
        )
      : empty(all.length ? t('noEventsFiltered') : t('wireEmpty')),
  );
}

export function radarPanel(o: WireOptions): HTMLElement {
  const items = o.data.events.filter((e) => e.type === 'leadership');
  return panel(
    t('radar'),
    items.length ? h('span', { class: 'mono muted' }, String(items.length)) : null,
    items.length
      ? h(
          'ul',
          { class: 'cards' },
          ...items.slice(0, 7).map((event) => {
            const open = () => o.onOpen(event);
            return h(
              'li',
              { class: `card${o.newIds.has(wireKey(event)) ? ' fresh' : ''}`, onclick: open },
              h(
                'div',
                { class: 'card-top mono' },
                companyButton(event, 'radar'),
                h('span', { class: tone(event.changePct) }, pct(event.changePct)),
              ),
              event.people.length ? h('div', { class: 'card-people', dir: 'auto' }, event.people.join(', ')) : null,
              headline(event),
              h('div', { class: 'src' }, glyph('leadership'), `${stamp(event.time)} · ${event.source}`),
              consequencesOf(event, `radar-${event.symbol}`),
            );
          }),
        )
      : empty(t('radarEmpty')),
  );
}

export function moversPanel(
  board: Board | null,
  companies: Company[],
  loading: boolean,
  onOpen: (symbol: string) => void,
): HTMLElement {
  const names = new Map(companies.map((c) => [c.symbol, c.name]));
  const rows = board
    ? [...board.quotes]
        .flatMap(([symbol, q]) => (q.changePct === null ? [] : [{ symbol, price: q.price, changePct: q.changePct }]))
        .sort((a, b) => b.changePct - a.changePct)
    : [];
  const table = (title: string, items: typeof rows) =>
    items.length
      ? h(
          'div',
          { class: 'movers' },
          h('h3', {}, title),
          ...items.map((item) =>
            h(
              'button',
              { type: 'button', class: 'mover', 'data-key': `mover-${item.symbol}`, onclick: () => onOpen(item.symbol) },
              h('b', { class: 'mono' }, item.symbol),
              h('span', { class: 'clamp1' }, names.get(item.symbol) ?? ''),
              h('span', { class: 'mono' }, price(item.price)),
              h('span', { class: `mono ${tone(item.changePct)}` }, pct(item.changePct)),
            ),
          ),
        )
      : null;
  const up = rows.filter((r) => r.changePct > 0).slice(0, 5);
  const down = rows
    .filter((r) => r.changePct < 0)
    .slice(-5)
    .reverse();
  return panel(
    t('movers'),
    board ? updatedLabel(board.updatedAt) : null,
    table(t('gainers'), up),
    table(t('losers'), down),
    up.length || down.length ? null : empty(loading ? t('loading') : t('moversEmpty')),
  );
}
