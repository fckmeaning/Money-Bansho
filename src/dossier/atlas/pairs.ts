// Aggregates by region, the matrix of mean correlations between regions and the
// table of the most strongly linked pairs.
import { formatValue, num } from '../analytics/format';
import { pick } from '../analytics/parse';
import { note, panel, picker, segmented } from '../analytics/ui';
import { h } from '../dom';
import { heatFill, NEGATIVE } from './charts';
import { columnOf, grid, regionKey, regionName, regionsOf, text, tickerLink } from './common';
import type { Context, GridColumn, GridState, Section } from './common';
import type { CoMentions, Company, Frequency, Nullable, RegionRow } from './data';
import { formulas } from './formulas';
import type { Key } from './strings';

type Scope = 'all' | 'cross' | 'inside';
type Direction = 'strongest' | 'negative';

const MEDIANS = ['change1d', 'return1m', 'return1y', 'vol1y', 'var95', 'maxDrawdown', 'sharpe', 'beta', 'relVolume'];

const memory = {
  frequency: 'daily' as Frequency,
  direction: 'strongest' as Direction,
  scope: 'all' as Scope,
  query: '',
  regionSort: { sort: 'turnover', dir: -1 } as GridState,
  pairSort: { sort: 'daily', dir: -1 } as GridState,
  newsSort: { sort: 'stories', dir: -1 } as GridState,
};

interface Pair {
  a: Company;
  b: Company;
  daily: Nullable;
  weekly: Nullable;
  n: Nullable;
  low: Nullable;
  high: Nullable;
}

function allPairs(context: Context): Pair[] {
  const { rows, correlation } = context.atlas;
  const out: Pair[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const daily = correlation.daily[i]?.[j] ?? null;
      const weekly = correlation.weekly[i]?.[j] ?? null;
      if (daily === null && weekly === null) continue;
      const n = correlation.overlap[i]?.[j] ?? null;
      const bounded = daily !== null && n !== null && n > 3 && Math.abs(daily) < 1;
      const z = bounded ? Math.atanh(daily) : 0;
      const half = bounded ? 1.96 / Math.sqrt(n - 3) : 0;
      out.push({
        a: rows[i] as Company,
        b: rows[j] as Company,
        daily,
        weekly,
        n,
        low: bounded ? Math.tanh(z - half) : null,
        high: bounded ? Math.tanh(z + half) : null,
      });
    }
  }
  return out;
}

export function pairsSection(context: Context): Section {
  const { atlas, lang, t, open } = context;
  let news: CoMentions | null = null;
  let disposed = false;
  const rho = (v: Nullable) => (v === null ? null : formatValue(v, 'ratio', lang, true));

  // ---- regions --------------------------------------------------------------

  const regions = grid<RegionRow>({
    lang,
    caption: t('regionTable'),
    noData: t('noData'),
    state: memory.regionSort,
    className: 'atl-regions',
  });
  const metric = (id: string, label: Key, unit: 'pct' | 'money' | 'ratio', value: (r: RegionRow) => Nullable, signed = false): GridColumn<RegionRow> => ({
    id,
    label: t(label),
    numeric: true,
    value,
    cell: (r) => text(value(r), unit, lang, signed),
  });
  regions.set(
    [
      { id: 'region', label: t('region'), value: (r) => regionName(r.region, lang), cell: (r) => regionKey(r.region, lang) },
      { id: 'count', label: t('rCount'), numeric: true, value: (r) => r.count },
      metric('indexReturn', 'rReturn', 'pct', (r) => r.indexReturn, true),
      metric('indexVol', 'rVol', 'pct', (r) => r.indexVol),
      metric('indexDrawdown', 'rDrawdown', 'pct', (r) => r.indexDrawdown),
      metric('turnover', 'rTurnover', 'money', (r) => r.turnoverUsd),
      metric('intra', 'rIntra', 'ratio', (r) => r.intraCorr, true),
      metric('inter', 'rInter', 'ratio', (r) => r.interCorr, true),
      ...MEDIANS.flatMap((id): GridColumn<RegionRow>[] => {
        const column = columnOf(atlas, id);
        if (!column) return [];
        return [{
          id: `median-${id}`,
          label: t('rMedian', { name: pick(column.label, lang) }),
          numeric: true,
          value: (r) => r.medians[id] ?? null,
          cell: (r) => text(r.medians[id], column.unit, lang, id.startsWith('return') || id === 'change1d'),
        }];
      }),
    ],
    atlas.regions,
  );

  const matrixHost = h('div', {});
  const drawMatrix = () => {
    const { regions: ids } = atlas.regionCorrelation;
    const matrix = atlas.regionCorrelation[memory.frequency];
    matrixHost.replaceChildren(
      h(
        'div',
        { class: 'mbx-scroll' },
        h(
          'table',
          { class: 'mbx-table atl-matrix' },
          h('caption', { class: 'mbx-sr' }, t('regionMatrix')),
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('region')), ...ids.map((r) => h('th', { scope: 'col', class: 'num' }, regionName(r, lang))))),
          h(
            'tbody',
            {},
            ...ids.map((a, i) =>
              h(
                'tr',
                {},
                h('th', { scope: 'row' }, regionKey(a, lang)),
                ...ids.map((_, j) => {
                  const v = matrix[i]?.[j] ?? null;
                  const strength = v === null ? 0 : Math.round(Math.min(1, Math.abs(v) / 0.6) * 45);
                  return h(
                    'td',
                    { class: 'num', style: v === null ? '' : `background:color-mix(in srgb, ${v >= 0 ? 'var(--gold)' : NEGATIVE} ${strength}%, transparent)` },
                    rho(v) ?? t('noData'),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
    );
  };

  // ---- pairs ------------------------------------------------------------------

  const pairs = allPairs(context);
  const stories = (p: Pair): number | null => {
    if (!news) return null;
    const i = news.symbols.indexOf(p.a.symbol);
    const j = news.symbols.indexOf(p.b.symbol);
    return news.edges.find((e) => (e.a === i && e.b === j) || (e.a === j && e.b === i))?.count ?? 0;
  };
  const pairName = (p: Pair) =>
    h(
      'span',
      { class: 'atl-pair', title: `${p.a.name} — ${p.b.name}` },
      tickerLink(p.a.symbol, open),
      h('span', {}, '×'),
      tickerLink(p.b.symbol, open),
    );
  const pairColumns = (): GridColumn<Pair>[] => [
    { id: 'pair', label: t('pair'), value: (p) => `${p.a.symbol} × ${p.b.symbol}`, cell: pairName },
    { id: 'names', label: t('company'), value: (p) => `${p.a.name} — ${p.b.name}` },
    { id: 'regions', label: t('regionsOf'), value: (p) => `${regionName(p.a.region, lang)} — ${regionName(p.b.region, lang)}` },
    {
      id: 'daily',
      label: t('rhoDaily'),
      numeric: true,
      value: (p) => p.daily,
      cell: (p) => rho(p.daily),
    },
    {
      id: 'bar',
      label: '',
      value: (p) => p.daily,
      cell: (p) =>
        p.daily === null
          ? ''
          : h('span', { class: 'atl-strength', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.min(100, Math.abs(p.daily) * 100)}%;${heatFill(p.daily).replace('fill:', 'background:')}` })),
    },
    {
      id: 'low',
      label: t('interval'),
      numeric: true,
      value: (p) => p.low,
      cell: (p) => (p.low === null || p.high === null ? null : `${rho(p.low)} … ${rho(p.high)}`),
    },
    { id: 'n', label: t('observations'), numeric: true, value: (p) => p.n },
    { id: 'weekly', label: t('rhoWeekly'), numeric: true, value: (p) => p.weekly, cell: (p) => rho(p.weekly) },
    { id: 'stories', label: t('stories'), numeric: true, value: stories },
  ];
  const table = grid<Pair>({
    lang,
    caption: t('pairsTitle'),
    noData: t('noData'),
    state: memory.pairSort,
    limit: 25,
    more: (left) => t('more', { left, n: left }),
    className: 'atl-pairs',
  });
  const shown = h('span', { class: 'mbx-count', role: 'status' });
  const drawPairs = () => {
    const needle = memory.query.trim().toLocaleLowerCase();
    const list = pairs.filter((p) => {
      if (memory.scope === 'cross' && p.a.region === p.b.region) return false;
      if (memory.scope === 'inside' && p.a.region !== p.b.region) return false;
      if (memory.direction === 'negative' && !(p.daily !== null && p.daily < 0)) return false;
      return !needle || `${p.a.symbol} ${p.a.name} ${p.b.symbol} ${p.b.name}`.toLocaleLowerCase().includes(needle);
    });
    shown.textContent = t('shown', { n: num(list.length, lang), total: num(pairs.length, lang) });
    table.set(pairColumns(), list);
  };

  const search = h('input', {
    type: 'search',
    class: 'mbx-search',
    placeholder: t('search'),
    'aria-label': t('search'),
    value: memory.query,
    oninput: () => {
      memory.query = search.value;
      drawPairs();
    },
  });
  const scope = picker(t('scope'), (v) => {
    memory.scope = v as Scope;
    drawPairs();
  });
  scope.set([['all', t('scopeAll')], ['cross', t('scopeCross')], ['inside', t('scopeInside')]], memory.scope);
  const direction = segmented<Direction>(
    t('direction'),
    [['strongest', t('strongest')], ['negative', t('negative')]],
    memory.direction,
    (v) => {
      memory.direction = v;
      memory.pairSort.sort = 'daily';
      memory.pairSort.dir = v === 'negative' ? 1 : -1;
      drawPairs();
    },
  );

  // ---- pairs from headlines -----------------------------------------------------

  const newsHost = h('div', {}, h('p', { class: 'mbx-empty' }, t('loadingNews')));
  const drawNews = () => {
    if (!news) return;
    const found = news;
    if (!found.edges.length) {
      newsHost.replaceChildren(h('p', { class: 'mbx-empty' }, t('noLinks')));
      return;
    }
    type Edge = CoMentions['edges'][number];
    const names = (e: Edge): [string, string] => [found.symbols[e.a] ?? '', found.symbols[e.b] ?? ''];
    const list = grid<Edge>({
      lang,
      caption: t('mentionPairs'),
      noData: t('noData'),
      state: memory.newsSort,
      limit: 15,
      more: (left) => t('more', { left, n: left }),
      className: 'atl-newspairs',
    });
    list.set(
      [
        {
          id: 'pair',
          label: t('pair'),
          value: (e) => names(e).join(' × '),
          cell: (e) => {
            const [a, b] = names(e);
            return h('span', { class: 'atl-pair' }, tickerLink(a, open), h('span', {}, '×'), tickerLink(b, open));
          },
        },
        { id: 'stories', label: t('stories'), numeric: true, value: (e) => e.count },
        { id: 'weight', label: t('weight'), numeric: true, value: (e) => e.weight, cell: (e) => num(e.weight, lang, 0, 2) },
        { id: 'jaccard', label: t('jaccard'), numeric: true, value: (e) => e.jaccard, cell: (e) => (e.jaccard === null ? null : num(e.jaccard, lang, 0, 3)) },
        { id: 'lift', label: t('lift'), numeric: true, value: (e) => e.lift, cell: (e) => (e.lift === null ? null : num(e.lift, lang, 0, 1)) },
        {
          id: 'headline',
          label: t('headlines'),
          value: (e) => e.items[0]?.title ?? null,
          cell: (e) => {
            const item = e.items[0];
            if (!item) return null;
            return h(
              'a',
              { class: 'atl-headline', href: /^https?:/.test(item.url) ? item.url : null, target: '_blank', rel: 'noopener noreferrer', dir: 'auto', title: `${item.source}: ${item.original || item.title}` },
              item.title,
            );
          },
        },
      ],
      found.edges,
    );
    newsHost.replaceChildren(
      h(
        'div',
        { class: 'mbx-toolbar atl-bar' },
        h('button', { type: 'button', class: 'mbx-button', onclick: () => list.csv('bansho-comentions.csv') }, t('exportCsv')),
      ),
      list.el,
      note(
        t('newsNote', {
          headlines: found.sample.headlines,
          days: found.windowDays,
          searched: found.sample.searched,
          published: found.sample.published,
          ok: found.sample.feedsAnswered,
          asked: found.sample.feedsAsked,
          linking: found.linkingStories,
        }),
      ),
    );
  };

  drawMatrix();
  drawPairs();
  context.news().then(
    (value) => {
      if (disposed) return;
      news = value;
      drawPairs();
      drawNews();
    },
    (error) => {
      console.error('[atlas] co-mentions failed', error);
      if (!disposed) newsHost.replaceChildren(h('p', { class: 'mbx-empty' }, t('failed')));
    },
  );

  const csvButton = (run: () => void) => h('button', { type: 'button', class: 'mbx-button', onclick: run }, t('exportCsv'));
  const el = h(
    'div',
    { class: 'mbx-stack' },
    panel(
      t('regionTable'),
      h('div', { class: 'mbx-toolbar atl-bar' }, ...regionsOf(atlas).map((r) => regionKey(r, lang)), csvButton(() => regions.csv('bansho-regions.csv'))),
      regions.el,
      note(t('regionsNote')),
    ),
    panel(
      t('regionMatrix'),
      h(
        'div',
        { class: 'mbx-toolbar' },
        segmented<Frequency>(t('frequency'), [['daily', t('daily')], ['weekly', t('weekly')]], memory.frequency, (v) => {
          memory.frequency = v;
          drawMatrix();
        }),
      ),
      matrixHost,
      note(t('heatNote')),
    ),
    panel(
      t('pairsTitle'),
      h('div', { class: 'mbx-toolbar' }, search, direction, scope.el, shown, csvButton(() => table.csv('bansho-pairs.csv'))),
      table.el,
      note(t('pairsNote')),
      formulas('pairs', lang),
    ),
    panel(t('mentionPairs'), newsHost),
  );
  return {
    el,
    dispose: () => {
      disposed = true;
    },
  };
}
