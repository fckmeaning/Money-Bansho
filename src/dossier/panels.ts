// Company view panels: quote header, reputation, leadership, largest moves, timeline.
import { DASH, barDate, compact, glyph, h, link, pct, price, signed, stamp, tone, updatedLabel } from './dom';
import { regionName, scoreLabel, t, typeName } from './i18n';
import { largestMoves } from './moves';
import { EVENT_TYPES } from './types';
import type { Dossier, DossierEvent, EventType, SourceError } from './types';

export const TIMELINE_PAGE = 60;

export function panel(title: string, aside: Node | string | null, ...body: (Node | null)[]): HTMLElement {
  return h(
    'section',
    { class: 'panel' },
    h('header', { class: 'panel-head' }, h('h2', {}, title), aside ? h('div', { class: 'panel-aside' }, aside) : null),
    ...body,
  );
}

export const empty = (text: string): HTMLElement => h('div', { class: 'empty' }, text);

export function sourceIssues(errors: SourceError[]): HTMLElement | null {
  if (errors.length === 0) return null;
  return h(
    'details',
    { class: 'issues' },
    h('summary', {}, `${t('sourceIssues')}: ${errors.length}`),
    h('ul', {}, ...errors.slice(0, 20).map((e) => h('li', {}, h('b', {}, e.source), ` ${e.message}`))),
  );
}

export const typeTag = (type: EventType): HTMLElement =>
  h('span', { class: 'tag' }, glyph(type), h('span', {}, typeName(type)));

const langBadge = (lang: string): HTMLElement | null =>
  lang ? h('span', { class: 'badge mono' }, lang.slice(0, 5).toUpperCase()) : null;

export const sourceLine = (event: DossierEvent): HTMLElement =>
  h(
    'span',
    { class: 'src' },
    event.source || DASH,
    langBadge(event.lang),
    event.people.length ? h('span', { class: 'people', dir: 'auto' }, event.people.join(', ')) : null,
  );

/** Headline in its own language; direction follows the text (Hebrew renders RTL). */
export function headline(event: DossierEvent): HTMLElement {
  const node = link(event.url, event.title, 'headline');
  if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(event.lang)) node.setAttribute('lang', event.lang);
  return node;
}

export function quoteHeader(data: Dossier): HTMLElement {
  const q = data.quote;
  const closes = data.history.map((b) => b.c);
  const first = closes[0];
  const last = closes[closes.length - 1];
  const rangePct = first && last !== undefined && closes.length > 1 ? (last / first - 1) * 100 : null;
  const lastVolume = data.history[data.history.length - 1]?.v;
  const stat = (label: string, value: string, cls = '') =>
    h('div', { class: 'stat' }, h('span', {}, label), h('b', { class: `mono ${cls}` }, value));

  return h(
    'section',
    { class: 'panel quote' },
    h(
      'div',
      { class: 'quote-main' },
      h(
        'div',
        { class: 'quote-id' },
        h('h1', { dir: 'auto' }, data.name || data.symbol),
        h(
          'div',
          { class: 'quote-meta' },
          h('b', { class: 'mono gold' }, data.symbol),
          data.exchange ? h('span', {}, data.exchange) : null,
          data.country ? h('span', {}, data.country) : null,
          data.region && regionName(data.region) !== data.country ? h('span', {}, regionName(data.region)) : null,
          q?.marketState ? h('span', { class: 'badge mono' }, q.marketState) : null,
          q?.asOf ? h('span', {}, t('asOf', { time: stamp(q.asOf) })) : null,
          updatedLabel(data.updatedAt),
        ),
      ),
      q
        ? h(
            'div',
            { class: 'quote-price mono' },
            h('b', {}, price(q.price)),
            h('span', { class: 'muted' }, data.currency),
            h('span', { class: `change ${tone(q.changePct)}` }, `${signed(q.change)}  ${pct(q.changePct)}`),
          )
        : h('div', { class: 'quote-price muted' }, t('noData')),
    ),
    h(
      'div',
      { class: 'stats' },
      stat(t('rangeChange'), pct(rangePct), tone(rangePct)),
      stat(t('high'), price(closes.length ? Math.max(...closes) : null)),
      stat(t('low'), price(closes.length ? Math.min(...closes) : null)),
      stat(t('volume'), lastVolume ? compact(lastVolume) : DASH),
      stat(t('eventsStat'), String(data.events.length)),
    ),
  );
}

export function reputationPanel(data: Dossier, onSelect: (id: string) => void): HTMLElement {
  const rep = data.reputation;
  if (!rep || rep.sample <= 0) return panel(t('reputation'), null, empty(t('repNone')));
  const score = Math.max(0, Math.min(100, rep.score));
  const byId = new Map(data.events.map((e) => [e.id, e]));
  const fill = h('i', {});
  fill.style.width = `${score}%`;

  const drivers = rep.drivers.slice(0, 5).map((driver) => {
    const event = byId.get(driver.eventId);
    const impact = h('b', { class: `mono impact ${tone(driver.impact)}` }, signed(driver.impact, 1));
    if (!event) return h('li', { class: 'driver' }, impact, h('span', { class: 'muted' }, t('driverGone')));
    return h(
      'li',
      {},
      h(
        'button',
        { type: 'button', class: 'driver', onclick: () => onSelect(event.id) },
        impact,
        h(
          'span',
          { class: 'driver-text' },
          h('span', { class: 'clamp', dir: 'auto' }, event.title),
          h('span', { class: 'src' }, glyph(event.type), `${stamp(event.time)} · ${event.source}`),
        ),
      ),
    );
  });

  return panel(
    t('reputation'),
    null,
    h(
      'div',
      { class: 'rep' },
      h('div', { class: 'rep-score mono' }, h('b', {}, String(Math.round(score))), h('span', {}, '/100')),
      h(
        'div',
        { class: 'rep-side' },
        rep.label ? h('strong', {}, scoreLabel(rep.label)) : null,
        rep.trend === null
          ? null
          : h(
              'span',
              {},
              h('b', { class: `mono ${tone(rep.trend, 0.05)}` }, signed(rep.trend, 1)),
              ` ${t('repTrend')}`,
            ),
        h('span', { class: 'muted' }, `${t('repSample')}: ${rep.sample}`),
      ),
    ),
    h('div', { class: 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(score), 'aria-label': t('reputation') }, fill),
    h('p', { class: 'explain' }, t('repExplain')),
    h('h3', {}, t('drivers')),
    drivers.length ? h('ul', { class: 'drivers' }, ...drivers) : empty(t('noDrivers')),
  );
}

export function leadershipPanel(
  data: Dossier,
  onSelect: (id: string) => void,
  onShowAll: () => void,
): HTMLElement {
  const shown = 4;
  const items = data.events.filter((e) => e.type === 'leadership');
  return panel(
    t('leadership'),
    items.length ? h('span', { class: 'mono muted' }, String(items.length)) : null,
    items.length
      ? h(
          'ul',
          { class: 'cards' },
          ...items.slice(0, shown).map((event) =>
            h(
              'li',
              { class: 'card', 'data-event': event.id, onclick: () => onSelect(event.id) },
              h(
                'div',
                { class: 'card-top mono' },
                // The click bubbles to the card, which selects the event.
                h('button', { type: 'button', class: 'linklike', 'data-key': `lead-${event.id}` }, stamp(event.time)),
                h('span', { class: tone(event.priceMovePct) }, pct(event.priceMovePct)),
              ),
              event.people.length ? h('div', { class: 'card-people', dir: 'auto' }, event.people.join(', ')) : null,
              headline(event),
              h('div', { class: 'src' }, event.source, langBadge(event.lang)),
            ),
          ),
        )
      : empty(t('noLeadership')),
    items.length > shown
      ? h(
          'button',
          { type: 'button', class: 'more', 'data-key': 'lead-all', onclick: onShowAll },
          t('allInTimeline', { n: items.length }),
        )
      : null,
  );
}

export function movesPanel(data: Dossier, onSelect: (id: string) => void): HTMLElement {
  const moves = largestMoves(data.history, data.events);
  return panel(
    t('movesTitle'),
    null,
    moves.length
      ? h(
          'ol',
          { class: 'moves' },
          ...moves.map((move) =>
            h(
              'li',
              {},
              h(
                'div',
                { class: 'move-head mono' },
                h('span', {}, barDate(move.t, true)),
                h('b', { class: tone(move.movePct) }, pct(move.movePct)),
              ),
              move.events.length
                ? h(
                    'ul',
                    {},
                    ...move.events.slice(0, 3).map((event) =>
                      h(
                        'li',
                        {},
                        h(
                          'button',
                          { type: 'button', class: 'move-news', onclick: () => onSelect(event.id) },
                          glyph(event.type),
                          h('span', { class: 'clamp', dir: 'auto' }, event.title),
                        ),
                      ),
                    ),
                    move.events.length > 3
                      ? h('li', { class: 'muted' }, t('moreItems', { n: move.events.length - 3 }))
                      : null,
                  )
                : h('div', { class: 'muted no-news' }, t('noMatchingNews')),
            ),
          ),
        )
      : empty(t('noMoves')),
    h('p', { class: 'explain' }, t('movesNote')),
  );
}

export function typeFilters(
  events: DossierEvent[],
  active: ReadonlySet<EventType>,
  onToggle: (type: EventType | null) => void,
): HTMLElement {
  const counts = new Map<EventType, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  const chip = (type: EventType | null, label: string, count: number, pressed: boolean) =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(pressed),
        'data-key': `type-${type ?? 'all'}`,
        onclick: () => onToggle(type),
      },
      type ? glyph(type) : null,
      label,
      h('span', { class: 'mono muted' }, String(count)),
    );
  return h(
    'div',
    { class: 'chips' },
    chip(null, t('all'), events.length, active.size === 0),
    ...EVENT_TYPES.filter((type) => counts.has(type) || active.has(type)).map((type) =>
      chip(type, typeName(type), counts.get(type) ?? 0, active.has(type)),
    ),
  );
}

/** The wire headline the visitor clicked, when the company list does not carry it. */
export function openedPanel(event: DossierEvent): HTMLElement {
  return panel(
    t('fromWire'),
    h('span', { class: 'mono' }, stamp(event.time)),
    h('div', { class: 'opened' }, typeTag(event.type), h('div', { class: 'title-cell' }, headline(event), sourceLine(event))),
  );
}

export interface TimelineOptions {
  data: Dossier;
  activeTypes: ReadonlySet<EventType>;
  selectedId: string | null;
  newIds: ReadonlySet<string>;
  limit: number;
  onToggle(type: EventType | null): void;
  onSelect(id: string): void;
  onHover(id: string | null): void;
  onMore(): void;
}

export function timelinePanel(o: TimelineOptions): HTMLElement {
  const all = o.data.events;
  const events = o.activeTypes.size ? all.filter((e) => o.activeTypes.has(e.type)) : all;
  const fresh = all.filter((e) => o.newIds.has(e.id)).length;
  const col = (key: 'colTime' | 'colType' | 'colHeadline' | 'colSent' | 'colMove' | 'colAbn', title?: string) =>
    h('span', { title }, t(key));
  const sentiment = (value: number | null) =>
    h('span', { class: `num mono ${tone(value, 0.05)}`, 'data-label': t('colSent') }, signed(value));

  const rows = events.slice(0, o.limit).map((event) =>
    h(
      'li',
      {
        class: `row${o.newIds.has(event.id) ? ' fresh' : ''}${event.id === o.selectedId ? ' selected' : ''}`,
        'data-event': event.id,
        onclick: () => o.onSelect(event.id),
        onpointerenter: () => o.onHover(event.id),
        onpointerleave: () => o.onHover(null),
      },
      h(
        'button',
        {
          type: 'button',
          class: 'linklike time mono',
          'data-key': `row-${event.id}`,
          onfocus: () => o.onHover(event.id),
          onblur: () => o.onHover(null),
        },
        stamp(event.time),
      ),
      typeTag(event.type),
      h('div', { class: 'title-cell' }, headline(event), sourceLine(event)),
      sentiment(event.sentiment),
      h('span', { class: `num mono ${tone(event.priceMovePct)}`, 'data-label': t('colMove') }, pct(event.priceMovePct)),
      h(
        'span',
        { class: `num mono ${tone(event.abnormalMovePct)}`, 'data-label': t('colAbn') },
        pct(event.abnormalMovePct),
      ),
    ),
  );

  return panel(
    t('timeline'),
    fresh ? h('span', { class: 'gold mono' }, t('newSince', { n: fresh })) : null,
    typeFilters(all, o.activeTypes, o.onToggle),
    events.length
      ? h(
          'div',
          { class: 'table' },
          h(
            'div',
            { class: 'row row-head', 'aria-hidden': 'true' },
            col('colTime'),
            col('colType'),
            col('colHeadline'),
            col('colSent', t('colSentHint')),
            col('colMove', t('colMoveHint')),
            col('colAbn', t('colAbnHint')),
          ),
          h('ol', {}, ...rows),
          events.length > o.limit
            ? h(
                'button',
                { type: 'button', class: 'more', 'data-key': 'more', onclick: o.onMore },
                t('showMore', { n: Math.min(TIMELINE_PAGE, events.length - o.limit) }),
              )
            : null,
        )
      : empty(all.length ? t('noEventsFiltered') : t('noEvents')),
  );
}
