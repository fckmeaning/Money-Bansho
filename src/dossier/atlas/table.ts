// The table of all companies: sorting on every column, search, region and country
// filters, column sets and CSV export. A row opens the dossier.
import { formatValue, localeOf } from '../analytics/format';
import { pick } from '../analytics/parse';
import { note, panel } from '../analytics/ui';
import { h, s } from '../dom';
import { grid, median, present, regionKey, regionName, regionsOf } from './common';
import type { Context, GridColumn, GridState, Section } from './common';
import type { Column, Company } from './data';
import { formulas } from './formulas';
import type { Key } from './strings';

const STORAGE_KEY = 'bansho-atlas-columns';

const SETS: Record<string, string[] | null> = {
  setMain: ['price', 'change1d', 'return1m', 'return1y', 'vol1y', 'var95', 'es95', 'maxDrawdown', 'sharpe', 'beta', 'turnoverUsd', 'relVolume', 'spark', 'region', 'country'],
  setReturns: ['price', 'change1d', 'return1w', 'return1m', 'return3m', 'return6m', 'returnYtd', 'return1y', 'excess1y', 'momentum12m1', 'smaDistance50', 'smaDistance200', 'distanceHigh52w', 'distanceLow52w', 'rsi14', 'spark'],
  setRisk: ['vol20', 'vol1y', 'downsideVol', 'var95', 'es95', 'var99', 'es99', 'var99t', 'maxDrawdown', 'currentDrawdown', 'sharpe', 'sortino', 'calmar', 'beta', 'alpha', 'r2', 'correlation', 'idioVol', 'skew', 'kurtosis', 'hitRate', 'bestDay', 'worstDay', 'avgCorr'],
  setLiquidity: ['price', 'currency', 'volumeLast', 'volume20', 'relVolume', 'turnoverUsd', 'amihud', 'vol20', 'change1d'],
  setAll: null,
};

const SIGNED = /^(change|return|excess|momentum|alpha|smaDistance|distance|bestDay|worstDay|currentDrawdown|maxDrawdown)/;

// Filters survive a visit to a dossier and a change of section.
const memory = {
  query: '',
  region: '',
  country: '',
  sort: { sort: 'turnoverUsd', dir: -1 } as GridState,
  chosen: null as string[] | null,
  restored: false,
};

function restore(): void {
  if (memory.restored) return;
  memory.restored = true;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (Array.isArray(raw)) memory.chosen = raw.filter((v): v is string => typeof v === 'string');
  } catch {
    // The choice just is not remembered.
  }
}

function remember(ids: string[]): void {
  memory.chosen = ids;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // The choice just is not remembered.
  }
}

function spark(values: number[]): Node | null {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * 70 + 1).toFixed(1)},${(17 - ((v - lo) / span) * 15).toFixed(1)}`)
    .join(' ');
  return s('svg', { class: 'atl-spark', width: 72, height: 18, viewBox: '0 0 72 18', 'aria-hidden': 'true' }, s('polyline', { points }));
}

export function tableSection(context: Context): Section {
  restore();
  const { atlas, lang, t, open } = context;
  const countryName = (() => {
    const names = new Intl.DisplayNames([localeOf(lang)], { type: 'region' });
    return (code: string) => names.of(code) ?? code;
  })();

  // Columns that are not metrics of the response.
  const extra: Record<string, { label: string; column: GridColumn<Company> }> = {
    region: {
      label: t('region'),
      column: {
        id: 'region',
        label: t('region'),
        value: (r) => regionName(r.region, lang),
        cell: (r) => regionKey(r.region, lang),
      },
    },
    country: { label: t('country'), column: { id: 'country', label: t('country'), value: (r) => countryName(r.country) } },
    currency: { label: t('currency'), column: { id: 'currency', label: t('currency'), value: (r) => r.currency || null } },
    spark: {
      label: t('trend'),
      column: {
        id: 'spark',
        label: t('trend'),
        numeric: true,
        value: (r) => {
          const first = r.spark[0];
          const last = r.spark[r.spark.length - 1];
          return first && last !== undefined ? Number(((last / first - 1) * 100).toFixed(2)) : null;
        },
        cell: (r) => spark(r.spark),
      },
    },
  };
  const everything = [...atlas.columns.map((c) => c.id), ...Object.keys(extra)];

  const metricColumn = (column: Column): GridColumn<Company> => {
    const signed = SIGNED.test(column.id);
    return {
      id: column.id,
      label: pick(column.label, lang),
      numeric: true,
      value: (r) => r.values[column.id] ?? null,
      cell: (r) => {
        const v = r.values[column.id];
        if (v === null || v === undefined) return null;
        const body = formatValue(v, column.unit, lang, signed);
        // Colour is kept for the day's move only.
        if (column.id !== 'change1d' || v === 0) return body;
        return h('span', { class: v > 0 ? 'mbx-up' : 'mbx-down' }, body);
      },
      foot: (rows) => {
        // Prices and share counts of different companies have no useful median.
        if (column.unit === 'price' || column.id === 'volumeLast' || column.id === 'volume20') return null;
        const m = median(present(rows.map((r) => r.values[column.id])));
        return m === null ? null : formatValue(m, column.unit, lang, signed);
      },
    };
  };

  const chosen = (): string[] => {
    const kept = (memory.chosen ?? SETS.setMain ?? []).filter((id) => everything.includes(id));
    return kept.length ? kept : [...(SETS.setMain ?? [])];
  };

  const identity: GridColumn<Company> = {
    id: 'symbol',
    label: t('company'),
    value: (r) => r.symbol,
    cell: (r) =>
      h(
        'button',
        { type: 'button', class: 'mbx-company', onclick: () => open(r.symbol), title: r.name },
        h('b', {}, r.symbol),
        h('span', {}, r.name),
      ),
  };

  const visibleColumns = (): GridColumn<Company>[] => [
    identity,
    ...chosen().flatMap((id) => {
      const metric = atlas.columns.find((c) => c.id === id);
      if (metric) return [metricColumn(metric)];
      const other = extra[id];
      return other ? [other.column] : [];
    }),
  ];

  const filtered = (): Company[] => {
    const needle = memory.query.trim().toLocaleLowerCase(localeOf(lang));
    return atlas.rows.filter(
      (r) =>
        (!memory.region || r.region === memory.region) &&
        (!memory.country || r.country === memory.country) &&
        (!needle || `${r.symbol} ${r.name}`.toLocaleLowerCase(localeOf(lang)).includes(needle)),
    );
  };

  const table = grid<Company>({
    lang,
    caption: t('tableTitle'),
    noData: t('noData'),
    state: memory.sort,
    onOpen: (r) => open(r.symbol),
    footLabel: t('median'),
    className: 'atl-main',
  });
  const shown = h('span', { class: 'mbx-count', role: 'status' });

  const draw = () => {
    const rows = filtered();
    shown.textContent = t('shown', { n: rows.length, total: atlas.rows.length });
    table.set(visibleColumns(), rows);
  };

  const search = h('input', {
    type: 'search',
    class: 'mbx-search',
    placeholder: t('search'),
    'aria-label': t('search'),
    value: memory.query,
    oninput: () => {
      memory.query = search.value;
      draw();
    },
  });
  const countries = () =>
    [...new Set(atlas.rows.filter((r) => !memory.region || r.region === memory.region).map((r) => r.country))].sort(
      (a, b) => countryName(a).localeCompare(countryName(b), localeOf(lang)),
    );
  const countrySelect = h('select', {
    'aria-label': t('country'),
    onchange: () => {
      memory.country = countrySelect.value;
      draw();
    },
  });
  const fillCountries = () => {
    const list = countries();
    if (memory.country && !list.includes(memory.country)) memory.country = '';
    countrySelect.replaceChildren(
      h('option', { value: '' }, t('allCountries')),
      ...list.map((c) => h('option', { value: c }, countryName(c))),
    );
    countrySelect.value = memory.country;
  };

  const regionBar = h('div', { class: 'mbx-segment mbx-wrap', role: 'group', 'aria-label': t('region') });
  const drawRegions = () => {
    regionBar.replaceChildren(
      ...['', ...regionsOf(atlas)].map((id) =>
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(memory.region === id),
            onclick: (event: Event) => {
              memory.region = id;
              for (const b of regionBar.querySelectorAll('button')) {
                b.setAttribute('aria-pressed', String(b === event.currentTarget));
              }
              fillCountries();
              draw();
            },
          },
          id ? regionName(id, lang) : t('allRegions'),
        ),
      ),
    );
  };

  // ---- column choice ------------------------------------------------------

  const summary = h('summary', {});
  const boxes = h('div', { class: 'mbx-columns-list' });
  const drawBoxes = () => {
    const active = new Set(chosen());
    summary.textContent = t('columns', { n: active.size, total: everything.length });
    boxes.replaceChildren(
      ...everything.map((id) => {
        const metric = atlas.columns.find((c) => c.id === id);
        const box = h('input', {
          type: 'checkbox',
          checked: active.has(id),
          onchange: () => {
            const now = new Set(chosen());
            if (box.checked) now.add(id);
            else now.delete(id);
            remember(everything.filter((x) => now.has(x)));
            summary.textContent = t('columns', { n: now.size, total: everything.length });
            draw();
          },
        });
        return h('label', { class: 'mbx-check' }, box, metric ? pick(metric.label, lang) : (extra[id]?.label ?? id));
      }),
    );
  };
  const sets = h(
    'div',
    { class: 'mbx-toolbar' },
    ...Object.entries(SETS).map(([key, ids]) =>
      h(
        'button',
        {
          type: 'button',
          class: 'mbx-button',
          onclick: () => {
            remember(ids ?? everything);
            drawBoxes();
            draw();
          },
        },
        t(key as Key),
      ),
    ),
  );

  fillCountries();
  drawRegions();
  drawBoxes();
  draw();

  const el = h(
    'div',
    { class: 'mbx-stack' },
    h('div', { class: 'mbx-toolbar' }, search, regionBar, h('label', { class: 'mbx-picker' }, countrySelect)),
    panel(
      t('tableTitle'),
      h(
        'div',
        { class: 'mbx-toolbar atl-bar' },
        sets,
        shown,
        h('button', { type: 'button', class: 'mbx-button', onclick: () => table.csv('bansho-companies.csv') }, t('exportCsv')),
      ),
      h('details', { class: 'mbx-details mbx-columns' }, summary, h('div', { class: 'mbx-details-body' }, boxes)),
      table.el,
      note(t('tableNote')),
      formulas('table', lang),
    ),
  );
  return { el, dispose: () => {} };
}
