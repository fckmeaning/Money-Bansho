// Analytics screen (?view=analytics&tab=): loading, the summary strip and the
// four sections. Drawn once; new data only on the reader's request.
import '../analytics/analytics.css';
import './atlas.css';
import { dateTime, formatValue, num, pct } from '../analytics/format';
import type { Lang } from '../analytics/format';
import { h } from '../dom';
import { chartsSection } from './charts';
import { median, present } from './common';
import type { Context, Section } from './common';
import { loadAtlas, loadCoMentions } from './data';
import type { Atlas } from './data';
import { graphSection } from './graph';
import { pairsSection } from './pairs';
import { texts } from './strings';
import type { Key } from './strings';
import { tableSection } from './table';

const TABS = ['table', 'charts', 'graph', 'pairs'] as const;
type Tab = (typeof TABS)[number];
const SECTIONS: Record<Tab, (context: Context) => Section> = {
  table: tableSection,
  charts: chartsSection,
  graph: graphSection,
  pairs: pairsSection,
};

const tabFromUrl = (): Tab => {
  const value = new URLSearchParams(location.search).get('tab') as Tab;
  return TABS.includes(value) ? value : 'table';
};

function writeTab(tab: Tab): void {
  const params = new URLSearchParams(location.search);
  if (tab === 'table') params.delete('tab');
  else params.set('tab', tab);
  history.replaceState(history.state, '', `${location.pathname}?${params}`);
}

export function atlasView(options: { lang: Lang; onSelect: (symbol: string) => void }): {
  el: HTMLElement;
  dispose: () => void;
} {
  const { lang, onSelect } = options;
  const t = texts(lang);
  let tab = tabFromUrl();
  let atlas: Atlas | null = null;
  let section: Section | null = null;
  let disposed = false;
  let forceNews = false;

  const stamp = h('span', { class: 'mbx-count', role: 'status' });
  const refresh = h('button', { type: 'button', class: 'mbx-button', onclick: () => void load(true) }, t('refresh'));
  const strip = h('dl', { class: 'atl-stats atl-summary', hidden: true });
  const issues = h('div', {});
  const body = h('div', { class: 'mbx-stack' });
  const buttons = TABS.map((id) =>
    h(
      'button',
      {
        type: 'button',
        'aria-current': id === tab ? 'page' : null,
        onclick: () => {
          if (id === tab) return;
          tab = id;
          writeTab(tab);
          buttons.forEach((b, i) => {
            if (TABS[i] === tab) b.setAttribute('aria-current', 'page');
            else b.removeAttribute('aria-current');
          });
          draw();
        },
      },
      t(`tab_${id}` as Key),
    ),
  );

  const el = h(
    'div',
    { class: 'mbx atl', lang },
    h('div', { class: 'mbx-viewhead' }, h('h2', {}, t('title')), h('div', { class: 'mbx-toolbar' }, stamp, refresh)),
    strip,
    h('nav', { class: 'atl-tabs', 'aria-label': t('tabsLabel') }, ...buttons),
    issues,
    body,
  );

  const context = (data: Atlas): Context => ({
    lang,
    t,
    atlas: data,
    open: onSelect,
    news: () => {
      const force = forceNews;
      forceNews = false;
      return loadCoMentions(lang, force);
    },
  });

  const summary = (data: Atlas) => {
    const values = (id: string) => present(data.rows.map((r) => r.values[id]));
    const day = values('change1d');
    const turnover = values('turnoverUsd');
    const pairs = present(data.correlation.daily.flatMap((row, i) => row.slice(i + 1)));
    const show = (value: number | null, format: (v: number) => string) => (value === null ? t('noData') : format(value));
    const item = (label: Key, value: string) => h('div', {}, h('dt', {}, t(label)), h('dd', {}, value));
    strip.replaceChildren(
      item('kCompanies', num(data.rows.length, lang)),
      item('kBreadth', day.length ? `${day.filter((v) => v > 0).length} / ${day.filter((v) => v < 0).length}` : t('noData')),
      item('kMedianDay', show(median(day), (v) => pct(v, lang))),
      item('kMedianVol', show(median(values('vol1y')), (v) => pct(v, lang, false))),
      item('kTurnover', turnover.length ? formatValue(turnover.reduce((sum, v) => sum + v, 0), 'money', lang) : t('noData')),
      item('kCorr', show(median(pairs), (v) => formatValue(v, 'ratio', lang, true))),
    );
    strip.hidden = false;
  };

  const draw = () => {
    section?.dispose();
    section = null;
    if (!atlas) return;
    try {
      section = SECTIONS[tab](context(atlas));
      body.replaceChildren(section.el);
    } catch (error) {
      console.error('[atlas] section failed', error);
      body.replaceChildren(h('p', { class: 'mbx-empty' }, t('failed')));
    }
  };

  async function load(force: boolean): Promise<void> {
    refresh.disabled = true;
    if (!atlas) body.replaceChildren(h('p', { class: 'mbx-empty atl-wait', role: 'status' }, t('loading')));
    else stamp.textContent = t('loading');
    forceNews = force;
    try {
      const data = await loadAtlas(force);
      if (disposed) return;
      if (!data.rows.length) throw new Error('empty');
      atlas = data;
      stamp.textContent = t('asOf', { time: dateTime(data.updatedAt, lang) });
      summary(data);
      issues.replaceChildren();
      if (data.errors.length) {
        issues.append(
          h(
            'details',
            { class: 'mbx-details mbx-warning' },
            h('summary', {}, t('issues', { n: data.errors.length })),
            h('ul', { class: 'mbx-issues' }, ...data.errors.map((e) => h('li', {}, `${e.source}: ${e.message}`))),
          ),
        );
      }
      draw();
    } catch (error) {
      if (disposed) return;
      console.error('[atlas] load failed', error);
      const alert = h(
        'div',
        { class: 'mbx-alert', role: 'alert' },
        h('span', {}, t('failed')),
        h('button', { type: 'button', class: 'mbx-button', onclick: () => void load(true) }, t('retry')),
      );
      issues.replaceChildren(alert);
      if (!atlas) {
        stamp.textContent = '';
        body.replaceChildren(h('p', { class: 'mbx-empty' }, t('noData')));
      } else stamp.textContent = t('asOf', { time: dateTime(atlas.updatedAt, lang) });
    } finally {
      refresh.disabled = false;
    }
  }

  void load(false);

  return {
    el,
    dispose: () => {
      disposed = true;
      section?.dispose();
    },
  };
}
