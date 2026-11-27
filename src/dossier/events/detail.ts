// The detail plate for one selected event.
import { currencyLabel } from '../currency';
import { h } from '../dom';
import { priceWindow, typeGlyph } from './charts';
import { dayZero } from './data';
import type { Ev, Model } from './data';
import { isFiling, windowKey } from './stats';
import type { Key } from './strings';
import { moveNode, table, toneNode, value } from './ui';
import type { Ui } from './ui';

export interface DetailActions {
  close(): void;
  select(id: string): void;
  /** Neighbours in the currently filtered list. */
  previous: string | null;
  next: string | null;
}

export function httpsUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function levelTag(ui: Ui, level: string | null): HTMLElement {
  if (!level) return h('span', { class: 'evx-missing' }, ui.t('noData'));
  return h('span', { class: `evx-level evx-level-${level}` }, ui.t(`level_${level}` as Key));
}

function button(label: string, key: string, onClick: (() => void) | null): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: 'evx-btn', 'data-key': key, disabled: !onClick, onclick: onClick },
    label,
  );
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'evx-detail-section' }, h('h4', {}, title), ...children);
}

function chartSection(ui: Ui, model: Model, event: Ev): HTMLElement[] {
  const index = dayZero(model.history, event.time);
  if (typeof index !== 'number') {
    const key: Key = index === 'before' ? 'chartBefore' : index === 'pending' ? 'chartPending' : 'chartNone';
    return [section(ui.t('priceWindow'), h('p', { class: 'evx-empty' }, ui.t(key)))];
  }
  const day = model.history[index];
  const open = day && model.updatedAt !== null && day.closeAt > model.updatedAt;
  const rows = [];
  for (let i = Math.max(0, index - 5); i <= Math.min(model.history.length - 1, index + 2); i++) {
    const bar = model.history[i];
    if (!bar) continue;
    const previous = model.history[i - 1];
    const offset = i - index;
    rows.push([
      offset === 0 ? ui.t('day0') : ui.signed(offset, 0),
      ui.barDate(bar.t),
      ui.num(bar.c),
      moveNode(ui, previous ? (bar.c / previous.c - 1) * 100 : null),
      value(ui, ui.compact(bar.v)),
    ]);
  }
  const title = `${ui.t('priceWindow')}${model.currency ? `, ${currencyLabel(model.currency, ui.lang)}` : ''}`;
  return [
    section(
      title,
      priceWindow(ui, model.history, index, event, model.symbol),
      open ? h('p', { class: 'evx-note' }, ui.t('dayOpen')) : null,
      h(
        'details',
        { class: 'evx-data' },
        h('summary', {}, `${ui.t('sessions')} (${ui.signed(-Math.min(5, index), 0)} … +2)`),
        table(
          ui.t('sessions'),
          [
            { label: ui.t('s_offset') },
            { label: ui.t('s_date') },
            { label: ui.t('s_close'), numeric: true },
            { label: ui.t('s_change'), numeric: true },
            { label: ui.t('s_volume'), numeric: true },
          ],
          rows,
        ),
      ),
    ),
  ];
}

function numbers(ui: Ui, event: Ev): HTMLElement {
  const i = event.impact;
  const item = (key: Key, content: Node | string) =>
    h(
      'div',
      { class: 'evx-number' },
      h('dt', {}, ui.t(key)),
      h('dd', {}, typeof content === 'string' ? value(ui, content, 'evx-num') : content),
      h('dd', { class: 'evx-explain' }, ui.t(`${key}_x` as Key)),
    );
  return section(
    ui.t('numbers'),
    i ? null : h('p', { class: 'evx-empty' }, ui.t('noImpact')),
    h(
      'dl',
      { class: 'evx-numbers' },
      item('n_car', moveNode(ui, i?.carPct ?? null)),
      item('n_z', ui.signed(i?.z ?? null)),
      item('n_level', levelTag(ui, i?.level ?? null)),
      item('n_p', ui.prob(i?.p ?? null)),
      item('n_q', ui.prob(i?.q ?? null)),
      item('n_preCar', moveNode(ui, i?.preCarPct ?? null)),
      item('n_preZ', ui.signed(i?.preZ ?? null)),
      item('n_volume', i?.volumeRatio === null || i === null ? ui.t('noData') : `×${ui.num(i.volumeRatio)}`),
      item('n_move', moveNode(ui, event.priceMovePct)),
      item('n_abnormal', moveNode(ui, event.abnormalMovePct)),
      item('n_beta', ui.num(i?.beta ?? null)),
      item('n_sample', ui.int(i?.sample ?? null)),
      item('n_model', i?.model ?? ui.t('noData')),
      item('n_sessions', ui.int(i?.sessions ?? null)),
      item('n_tone', toneNode(ui, event.sentiment)),
      item('n_outlets', ui.int(event.outlets)),
    ),
  );
}

export function detailPlate(ui: Ui, model: Model, event: Ev, actions: DetailActions): HTMLElement {
  const href = httpsUrl(event.url);
  const reputation = model.reputation;
  const driver = reputation?.drivers.find((d) => d.eventId === event.id);

  const key = windowKey(event, model.history);
  const sharing = key ? model.events.filter((e) => e !== event && windowKey(e, model.history) === key) : [];

  const fact = (label: string, content: string) => [h('dt', {}, label), h('dd', {}, value(ui, content))];

  return h(
    'article',
    { class: 'evx-plate' },
    h(
      'div',
      { class: 'evx-plate-bar' },
      h(
        'span',
        { class: 'evx-type' },
        typeGlyph(event.type),
        ui.t(`t_${event.type}`),
        h('span', { class: 'evx-origin' }, ui.t(isFiling(event) ? 'origin_filing' : 'origin_press')),
      ),
      h(
        'span',
        { class: 'evx-plate-buttons' },
        button(
          ui.t('prevEvent'),
          'detail-prev',
          actions.previous ? () => actions.select(actions.previous as string) : null,
        ),
        button(ui.t('nextEvent'), 'detail-next', actions.next ? () => actions.select(actions.next as string) : null),
        button(ui.t('close'), 'detail-close', actions.close),
      ),
    ),
    h(
      'h3',
      { class: 'evx-plate-title', tabindex: -1, lang: event.lang || null, dir: 'auto', 'data-key': 'detail-title' },
      event.title,
    ),
    href
      ? h(
          'p',
          {},
          h(
            'a',
            { class: 'evx-link', href, target: '_blank', rel: 'noopener noreferrer', 'data-key': 'detail-link' },
            `${ui.t('openSource')} (${new URL(href).hostname}) ↗`,
          ),
        )
      : h('p', { class: 'evx-missing' }, ui.t('noLink')),
    h(
      'dl',
      { class: 'evx-facts' },
      ...fact(ui.t('published'), ui.dateTime(event.time)),
      ...fact(ui.t('source'), event.source || ui.t('noData')),
      ...fact(ui.t('language'), ui.language(event.lang)),
      ...fact(ui.t('region'), event.region || ui.t('noData')),
      ...fact(ui.t('people'), event.people.length ? event.people.join(', ') : ui.t('noData')),
    ),
    h('p', { class: 'evx-warning' }, ui.t('noCause')),
    ...chartSection(ui, model, event),
    sharing.length
      ? h(
          'div',
          { class: 'evx-shared' },
          h('p', {}, ui.t('shared', { n: sharing.length })),
          h(
            'ul',
            {},
            ...sharing
              .slice(0, 5)
              .map((other) =>
                h(
                  'li',
                  {},
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'evx-linkbutton',
                      'data-key': `shared-${other.id}`,
                      onclick: () => actions.select(other.id),
                    },
                    h('span', { class: 'evx-muted' }, `${ui.t(`t_${other.type}`)} · `),
                    h('span', { dir: 'auto', lang: other.lang || null }, other.title),
                  ),
                ),
              ),
            sharing.length > 5
              ? h('li', { class: 'evx-muted' }, ui.t('sharedMore', { n: sharing.length - 5 }))
              : null,
          ),
        )
      : null,
    numbers(ui, event),
    section(
      ui.t('repTitle'),
      h(
        'p',
        {},
        !reputation
          ? ui.t('noData')
          : driver
            ? ui.t('repDriver', { impact: ui.signed(driver.impact), score: ui.int(reputation.score) })
            : ui.t('repNot'),
      ),
    ),
  );
}
