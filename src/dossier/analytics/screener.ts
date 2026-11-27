// Cross-company screener: data loading plus the table, rankings, scatter plot,
// region medians and correlation matrix that all read the same filtered rows.
import { h, s } from '../dom';
import { correlationView } from './correlation';
import { dateTime, formatValue, localeOf, num, pct } from './format';
import type { Lang } from './format';
import { parseScreener, pick } from './parse';
import type { Column, Row, Screener } from './parse';
import { scatterPlot } from './scatter';
import { fill, nameOf, strings } from './strings';
import { disclosure, downloadCsv, empty, missing, note, panel, picker, scroller, table, tint, track } from './ui';

const ENDPOINT = '/api/dossier?view=screener';
const REFRESH_MS = 5 * 60_000;
const TIMEOUT_MS = 60_000;
const DEFAULT_COLUMNS = 14;
const STORAGE_KEY = 'money-bansho-screener-columns';

type Failure = { kind: 'timeout' | 'network' | 'invalid' } | { kind: 'http'; status: number };

function readColumns(): string[] | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : null;
  } catch {
    return null;
  }
}

function writeColumns(ids: string[] | null): void {
  try {
    if (ids) localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The choice just is not remembered.
  }
}

function sparkline(values: number[], lang: Lang): Node {
  const t = strings(lang);
  const first = values[0];
  const last = values[values.length - 1];
  if (values.length < 2 || first === undefined || last === undefined) return missing(lang);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * 76 + 2).toFixed(1)},${(hi === lo ? 11 : 19 - ((v - lo) / span) * 16).toFixed(1)}`)
    .join(' ');
  const change = first > 0 ? pct((last / first - 1) * 100, lang) : formatValue(last - first, 'num', lang, true);
  const label = fill(t.trendAria, { change });
  return s(
    'svg',
    { class: `mbx-spark ${last > first ? 'up' : last < first ? 'down' : ''}`, width: 80, height: 22, viewBox: '0 0 80 22', role: 'img', 'aria-label': label },
    s('title', {}, label),
    // Dashed line at the starting level, so direction reads without colour.
    s('line', { class: 'start', x1: 2, x2: 78, y1: hi === lo ? 11 : 19 - ((first - lo) / span) * 16, y2: hi === lo ? 11 : 19 - ((first - lo) / span) * 16 }),
    s('polyline', { points }),
  );
}

interface ColumnStats { column: Column; signed: boolean; min: number; max: number }

function columnStats(column: Column, rows: Row[]): ColumnStats {
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    const v = row.values.get(column.id);
    if (v === undefined) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { column, signed: min < 0 && max > 0, min, max };
}

function shade(stats: ColumnStats, value: number): string {
  if (stats.signed) {
    const bound = Math.max(Math.abs(stats.min), Math.abs(stats.max));
    return tint(Math.abs(value) / bound, value < 0 ? 'neg' : 'pos');
  }
  return stats.max > stats.min ? tint((value - stats.min) / (stats.max - stats.min), 'flat') : '';
}

export function screenerView(options: { lang: Lang; onSelect: (symbol: string) => void }): {
  el: HTMLElement;
  dispose: () => void;
} {
  const { lang, onSelect } = options;
  const t = strings(lang);
  const collator = new Intl.Collator(localeOf(lang), { numeric: true, sensitivity: 'base' });

  let data: Screener | null = null;
  let controller: AbortController | null = null;
  let disposed = false;
  let fetchedAt = 0;
  let signature = '';

  let query = '';
  let region = '';
  let sortId = 'symbol';
  let sortDir: 1 | -1 = 1;
  let chosen: string[] | null = readColumns();
  let scatterX = '';
  let scatterY = '';
  let rankId = '';
  let medianId = '';

  // ---- skeleton -------------------------------------------------------------

  const stamp = h('span', { class: 'mbx-count', role: 'status' });
  const refreshButton = h('button', { type: 'button', class: 'mbx-button', onclick: () => void load() }, t.refresh);
  const alerts = h('div', {});
  const issues = h('div', {});
  const state = h('div', {});

  const search = h('input', {
    type: 'search',
    class: 'mbx-search',
    placeholder: t.filterText,
    'aria-label': t.filterText,
    oninput: () => {
      query = search.value;
      renderFiltered();
    },
  });
  const regionBar = h('div', { class: 'mbx-segment mbx-wrap', role: 'group', 'aria-label': t.region });
  const columnSummary = h('summary', {});
  const columnList = h('div', { class: 'mbx-columns-list' });
  const columnPanel = h('details', { class: 'mbx-details mbx-columns' }, columnSummary, h('div', { class: 'mbx-details-body' }, columnList));
  const shownCount = h('span', { class: 'mbx-count', role: 'status' });
  const tableHost = h('div', {});
  const exportButton = h('button', { type: 'button', class: 'mbx-button', onclick: () => exportCsv() }, t.exportCsv);

  const rankPick = picker(t.rankMetric, (v) => {
    rankId = v;
    renderRanking();
  });
  const rankHost = h('div', { class: 'mbx-grid2' });
  const xPick = picker(t.xAxis, (v) => {
    scatterX = v;
    renderScatter();
  });
  const yPick = picker(t.yAxis, (v) => {
    scatterY = v;
    renderScatter();
  });
  const scatter = scatterPlot(lang, onSelect);
  const medianPick = picker(t.medianMetric, (v) => {
    medianId = v;
    renderMedians();
  });
  const medianBars = h('div', {});
  const medianTable = h('div', {});
  const correlation = correlationView(lang, onSelect);

  const content = h(
    'div',
    { class: 'mbx-stack', hidden: true },
    h(
      'div',
      { class: 'mbx-toolbar' },
      search,
      regionBar,
    ),
    panel(
      t.tableTitle,
      h('div', { class: 'mbx-toolbar' }, shownCount, exportButton),
      columnPanel,
      tableHost,
      note(t.tableNote),
    ),
    h(
      'div',
      { class: 'mbx-grid2' },
      panel(t.scatterTitle, h('div', { class: 'mbx-toolbar' }, xPick.el, yPick.el), scatter.el),
      panel(t.rankTitle, h('div', { class: 'mbx-toolbar' }, rankPick.el), rankHost),
    ),
    panel(t.mediansTitle, h('div', { class: 'mbx-toolbar' }, medianPick.el), medianBars, medianTable, note(t.mediansNote)),
    panel(t.corrTitle, correlation.el),
  );

  const el = h(
    'div',
    { class: 'mbx mbx-screener', lang },
    h('div', { class: 'mbx-viewhead' }, h('h2', {}, t.screener), stamp, refreshButton),
    alerts,
    issues,
    state,
    content,
  );

  // ---- derived ----------------------------------------------------------------

  const visibleColumns = (): Column[] => {
    if (!data) return [];
    if (chosen) {
      const wanted = new Set(chosen);
      const found = data.columns.filter((c) => wanted.has(c.id));
      // A stored choice that matches nothing is from another data set.
      if (found.length || chosen.length === 0) return found;
    }
    return data.columns.slice(0, DEFAULT_COLUMNS);
  };

  const filteredRows = (): Row[] => {
    if (!data) return [];
    const needle = query.trim().toLocaleLowerCase(localeOf(lang));
    return data.rows.filter(
      (row) =>
        (!region || row.region === region) &&
        (!needle || `${row.symbol} ${row.name}`.toLocaleLowerCase(localeOf(lang)).includes(needle)),
    );
  };

  const sortedRows = (): Row[] => {
    const text = (row: Row) => (sortId === 'name' ? row.name : sortId === 'region' ? nameOf(row.region, lang) : row.symbol);
    const numeric = sortId !== 'symbol' && sortId !== 'name' && sortId !== 'region';
    return [...filteredRows()].sort((a, b) => {
      if (!numeric) return sortDir * collator.compare(text(a), text(b));
      const x = a.values.get(sortId);
      const y = b.values.get(sortId);
      // Rows without a value stay at the bottom in both directions.
      if (x === undefined || y === undefined) {
        return x === y ? collator.compare(a.symbol, b.symbol) : x === undefined ? 1 : -1;
      }
      return sortDir * (x - y) || collator.compare(a.symbol, b.symbol);
    });
  };

  const regionNames = (): string[] => [...new Set((data?.rows ?? []).map((r) => r.region))].filter(Boolean);
  const columnById = (id: string) => data?.columns.find((c) => c.id === id);
  const columnOptions = () => (data?.columns ?? []).map((c) => [c.id, pick(c.label, lang)] as const);
  const cellText = (row: Row, column: Column, stats: ColumnStats) => {
    const v = row.values.get(column.id);
    return v === undefined ? null : formatValue(v, column.unit, lang, stats.signed);
  };

  // ---- renderers ----------------------------------------------------------------

  const renderRegions = () => {
    const names = regionNames();
    if (region && !names.includes(region)) region = '';
    regionBar.replaceChildren(
      ...['', ...names].map((name) => {
        const button = h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(name === region),
            onclick: () => {
              region = name;
              for (const other of regionBar.children) other.setAttribute('aria-pressed', String(other === button));
              renderFiltered();
            },
          },
          name ? nameOf(name, lang) : t.all,
        );
        return button;
      }),
    );
  };

  const renderColumnChooser = () => {
    const shown = new Set(visibleColumns().map((c) => c.id));
    const total = data?.columns.length ?? 0;
    columnSummary.textContent = fill(t.columns, { n: shown.size, total });
    const apply = (ids: string[] | null) => {
      chosen = ids;
      writeColumns(ids);
      renderColumnChooser();
      renderTable();
    };
    const action = (label: string, ids: () => string[] | null) =>
      h('button', { type: 'button', class: 'mbx-button', onclick: () => apply(ids()) }, label);
    // Update existing checkboxes in place so keyboard focus is not lost.
    const boxes = [...columnList.querySelectorAll<HTMLInputElement>('input')];
    const ids = (data?.columns ?? []).map((c) => c.id).join('\u0000');
    if (columnList.dataset.ids === ids) {
      for (const box of boxes) box.checked = shown.has(box.value);
      return;
    }
    columnList.dataset.ids = ids;
    columnList.replaceChildren(
      h(
        'div',
        { class: 'mbx-toolbar' },
        action(t.selectAll, () => (data?.columns ?? []).map((c) => c.id)),
        action(t.selectNone, () => []),
        action(t.selectDefault, () => null),
      ),
      ...(data?.columns ?? []).map((column) => {
        const input = h('input', {
          type: 'checkbox',
          value: column.id,
          checked: shown.has(column.id),
          onchange: () => {
            const next = new Set(visibleColumns().map((c) => c.id));
            if (input.checked) next.add(column.id);
            else next.delete(column.id);
            apply((data?.columns ?? []).map((c) => c.id).filter((id) => next.has(id)));
          },
        });
        return h('label', { class: 'mbx-check' }, input, pick(column.label, lang));
      }),
    );
  };

  const renderTable = () => {
    if (!data) return;
    const columns = visibleColumns();
    if (!['symbol', 'name', 'region'].includes(sortId) && !columns.some((c) => c.id === sortId)) {
      sortId = 'symbol';
      sortDir = 1;
    }
    const rows = sortedRows();
    // Shading scale covers the whole universe, so a cell keeps its shade under filtering.
    const stats = columns.map((c) => columnStats(c, data?.rows ?? []));
    shownCount.textContent = fill(t.companies, { n: rows.length, total: data.rows.length });

    const head = (id: string, label: string, numeric: boolean) => {
      const active = sortId === id;
      return h(
        'th',
        { scope: 'col', class: numeric ? 'num' : '', 'aria-sort': active ? (sortDir === 1 ? 'ascending' : 'descending') : null },
        h(
          'button',
          {
            type: 'button',
            'data-sort': id,
            onclick: () => {
              if (sortId === id) sortDir = sortDir === 1 ? -1 : 1;
              else {
                sortId = id;
                sortDir = numeric ? -1 : 1;
              }
              renderTable();
            },
          },
          label,
          h('span', { class: 'mbx-arrow', 'aria-hidden': 'true' }, active ? (sortDir === 1 ? ' ↑' : ' ↓') : ''),
        ),
      );
    };

    const body = rows.map((row) =>
      h(
        'tr',
        { class: 'mbx-clickable', onclick: () => onSelect(row.symbol) },
        h(
          'th',
          { scope: 'row' },
          h(
            'button',
            { type: 'button', class: 'mbx-company', 'data-symbol': row.symbol, title: row.name, 'aria-label': `${fill(t.openCompany, { symbol: row.symbol })} ${row.name}` },
            h('b', {}, row.symbol),
            h('span', { dir: 'auto' }, row.name),
          ),
        ),
        h('td', {}, row.region ? nameOf(row.region, lang) : missing(lang)),
        h('td', {}, sparkline(row.spark, lang)),
        ...stats.map((stat) => {
          const value = row.values.get(stat.column.id);
          return value === undefined
            ? h('td', { class: 'num' }, missing(lang))
            : h('td', { class: 'num', style: shade(stat, value) }, cellText(row, stat.column, stat));
        }),
      ),
    );
    const grid = h(
      'table',
      { class: 'mbx-table mbx-screen-table' },
      h('caption', { class: 'mbx-sr' }, t.tableTitle),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          head('symbol', t.symbol, false),
          head('region', t.region, false),
          h('th', { scope: 'col' }, t.trend),
          ...columns.map((c) => head(c.id, pick(c.label, lang), true)),
        ),
      ),
      h('tbody', {}, ...body),
    );

    // Replacing the table must not lose the reader's scroll position or focus.
    const old = tableHost.querySelector<HTMLElement>('.mbx-scroll');
    const left = old?.scrollLeft ?? 0;
    const top = old?.scrollTop ?? 0;
    const active = document.activeElement instanceof HTMLElement && tableHost.contains(document.activeElement) ? document.activeElement : null;
    const wrap = scroller(grid, t.tableTitle, 'mbx-screen-scroll');
    tableHost.replaceChildren(wrap, ...(rows.length ? [] : [empty(lang, t.noMatch)]));
    wrap.scrollLeft = left;
    wrap.scrollTop = top;
    if (active) {
      const attribute = active.dataset.sort !== undefined ? 'data-sort' : active.dataset.symbol !== undefined ? 'data-symbol' : null;
      if (attribute) {
        const value = active.getAttribute(attribute);
        [...wrap.querySelectorAll<HTMLElement>(`[${attribute}]`)]
          .find((node) => node.getAttribute(attribute) === value)
          ?.focus({ preventScroll: true });
      } else wrap.focus({ preventScroll: true });
    }
  };

  const exportCsv = () => {
    const columns = visibleColumns();
    downloadCsv(
      'screener.csv',
      [
        [t.symbol, t.name, t.region, ...columns.map((c) => pick(c.label, lang) + (c.unit === 'pct' ? ', %' : ''))],
        ...sortedRows().map((row) => [
          row.symbol,
          row.name,
          nameOf(row.region, lang),
          ...columns.map((c) => row.values.get(c.id) ?? null),
        ]),
      ],
      lang,
    );
  };

  const renderRanking = () => {
    const column = columnById(rankId);
    if (!column) {
      rankHost.replaceChildren(empty(lang));
      return;
    }
    const ranked = filteredRows()
      .flatMap((row) => {
        const v = row.values.get(column.id);
        return v === undefined ? [] : [{ row, v }];
      })
      .sort((a, b) => b.v - a.v);
    const top = Math.min(10, Math.ceil(ranked.length / 2));
    const bottom = Math.min(10, ranked.length - top);
    const lo = Math.min(0, ...ranked.map((r) => r.v));
    const hi = Math.max(0, ...ranked.map((r) => r.v));
    const signed = lo < 0 && hi > 0;
    const list = (title: string, entries: typeof ranked, start: number, step: number) =>
      h(
        'div',
        { class: 'mbx-sub' },
        h('h4', {}, title),
        entries.length === 0
          ? empty(lang)
          : table(
              `${title}: ${pick(column.label, lang)}`,
              [{ text: '#', numeric: true }, { text: t.symbol }, { text: '' }, { text: t.value, numeric: true }],
              entries.map((entry, i) =>
                h(
                  'tr',
                  { class: 'mbx-clickable', onclick: () => onSelect(entry.row.symbol) },
                  h('td', { class: 'num mbx-rank' }, String(start + i * step)),
                  h('th', { scope: 'row' }, h('button', { type: 'button', class: 'mbx-link', title: entry.row.name }, entry.row.symbol)),
                  h('td', { class: 'mbx-trackcell' }, track(entry.v, lo, hi)),
                  h('td', { class: 'num' }, formatValue(entry.v, column.unit, lang, signed)),
                ),
              ),
              'mbx-barstable',
            ),
      );
    rankHost.replaceChildren(
      list(t.highest, ranked.slice(0, top), 1, 1),
      list(t.lowest, bottom ? ranked.slice(-bottom).reverse() : [], ranked.length, -1),
    );
  };

  const renderScatter = () => {
    const x = columnById(scatterX);
    const y = columnById(scatterY);
    scatter.update(x && y ? { rows: filteredRows(), x, y, regions: regionNames() } : null);
  };

  const renderMedians = () => {
    const regions = data?.regions ?? [];
    if (regions.length === 0) {
      medianBars.replaceChildren(empty(lang));
      medianTable.replaceChildren();
      return;
    }
    const column = columnById(medianId);
    if (column) {
      const entries = [...regions].sort((a, b) => (b.medians.get(column.id) ?? -Infinity) - (a.medians.get(column.id) ?? -Infinity));
      const values = entries.flatMap((r) => r.medians.get(column.id) ?? []);
      const lo = Math.min(0, ...values);
      const hi = Math.max(0, ...values);
      medianBars.replaceChildren(
        h(
          'div',
          { class: 'mbx-bars signed', role: 'img', 'aria-label': `${t.mediansTitle}: ${pick(column.label, lang)}. ${t.dataTable}` },
          ...entries.map((entry) => {
            const v = entry.medians.get(column.id);
            return h(
              'div',
              { class: `mbx-barrow${entry.region === region ? ' active' : ''}` },
              h('span', { class: 'mbx-barlabel' }, `${nameOf(entry.region, lang)}${entry.count === null ? '' : ` (${num(entry.count, lang, 0, 0)})`}`),
              track(v ?? null, lo, hi),
              h('span', { class: 'mbx-barvalue' }, v === undefined ? missing(lang) : formatValue(v, column.unit, lang, lo < 0 && hi > 0)),
            );
          }),
        ),
      );
    } else medianBars.replaceChildren(empty(lang));

    const columns = data?.columns ?? [];
    const stats = columns.map((c) => {
      const values = regions.flatMap((r) => r.medians.get(c.id) ?? []);
      return { column: c, min: Math.min(...values), max: Math.max(...values), signed: Math.min(...values) < 0 && Math.max(...values) > 0 };
    });
    // Metrics as rows keeps the table narrow: there are few regions and many metrics.
    const rows = stats.map((stat) =>
      h(
        'tr',
        {},
        h('th', { scope: 'row' }, pick(stat.column.label, lang)),
        ...regions.map((r) => {
          const v = r.medians.get(stat.column.id);
          return v === undefined
            ? h('td', { class: 'num' }, missing(lang))
            : h('td', { class: 'num', style: shade(stat, v) }, formatValue(v, stat.column.unit, lang, stat.signed));
        }),
      ),
    );
    const old = medianTable.querySelector<HTMLElement>('.mbx-scroll');
    const wrap = scroller(
      table(
        t.mediansTitle,
        [
          { text: t.metric },
          ...regions.map((r) => ({
            text: `${nameOf(r.region, lang)}${r.count === null ? '' : ` (${num(r.count, lang, 0, 0)})`}`,
            numeric: true,
          })),
        ],
        rows,
        'mbx-sticky-first',
      ),
      t.mediansTitle,
      'mbx-medium',
    );
    medianTable.replaceChildren(wrap);
    wrap.scrollTop = old?.scrollTop ?? 0;
    wrap.scrollLeft = old?.scrollLeft ?? 0;
  };

  const renderCorrelation = () =>
    correlation.update(data?.correlation ? { data: data.correlation, rows: filteredRows() } : null);

  const renderFiltered = () => {
    renderTable();
    renderRanking();
    renderScatter();
    renderMedians();
    renderCorrelation();
  };

  const choosePreferred = (current: string, preferred: RegExp, fallback: number): string => {
    const columns = data?.columns ?? [];
    if (columns.some((c) => c.id === current)) return current;
    return (columns.find((c) => preferred.test(c.id)) ?? columns[fallback] ?? columns[0])?.id ?? '';
  };

  const renderAll = () => {
    if (!data) return;
    scatterX = choosePreferred(scatterX, /vol(?!ume)/i, 0);
    scatterY = choosePreferred(scatterY, /(ytd|1y|3m|ret)/i, 1);
    rankId = choosePreferred(rankId, /(ytd|1m|ret|change)/i, 0);
    medianId = choosePreferred(medianId, /(ytd|1m|ret|change)/i, 0);
    const choices = columnOptions();
    xPick.set(choices, scatterX);
    yPick.set(choices, scatterY);
    rankPick.set(choices, rankId);
    medianPick.set(choices, medianId);
    renderRegions();
    renderColumnChooser();
    renderFiltered();
  };

  // ---- loading ----------------------------------------------------------------

  const describe = (failure: Failure): string =>
    failure.kind === 'http'
      ? fill(t.errHttp, { status: failure.status })
      : failure.kind === 'timeout'
        ? t.errTimeout
        : failure.kind === 'invalid'
          ? t.errInvalid
          : t.errNetwork;

  const retryButton = () => h('button', { type: 'button', class: 'mbx-button', onclick: () => void load() }, t.retry);

  const renderStatus = (failure: Failure | null) => {
    const busy = controller !== null;
    refreshButton.disabled = busy;
    el.setAttribute('aria-busy', String(busy));
    const hasRows = (data?.rows.length ?? 0) > 0;
    content.hidden = !hasRows;
    stamp.textContent = busy && data ? t.refreshing : data?.updatedAt ? fill(t.updated, { date: dateTime(data.updatedAt, lang) }) : '';
    if (failure) {
      alerts.replaceChildren(
        h(
          'div',
          { class: 'mbx-alert', role: 'alert' },
          h('span', {}, `${data ? t.stale : t.loadFailed} ${describe(failure)}`),
          retryButton(),
        ),
      );
    } else if (!busy) alerts.replaceChildren();

    if (!data && busy) state.replaceChildren(h('p', { class: 'mbx-empty', role: 'status' }, t.loading));
    else if (data && !hasRows) {
      state.replaceChildren(h('div', { class: 'mbx-empty' }, h('p', {}, t.emptyScreen), busy ? null : retryButton()));
    } else state.replaceChildren();
  };

  const renderIssues = () => {
    const errors = data?.errors ?? [];
    if (errors.length === 0) {
      issues.replaceChildren();
      return;
    }
    const list = disclosure(
      fill(t.issues, { n: errors.length }),
      () =>
        h(
          'ul',
          { class: 'mbx-issues' },
          ...errors.map((error) => h('li', {}, h('b', {}, error.source || '—'), ` ${error.message}`)),
        ),
      'mbx-warning',
    );
    list.el.open = issues.querySelector('details')?.open ?? false;
    list.refresh();
    issues.replaceChildren(list.el);
  };

  async function load(): Promise<void> {
    if (disposed || controller) return;
    const own = new AbortController();
    controller = own;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      own.abort();
    }, TIMEOUT_MS);
    let failure: Failure | null = null;
    let next: Screener | null = null;
    let body = '';
    renderStatus(null);
    try {
      const response = await fetch(ENDPOINT, { signal: own.signal, headers: { accept: 'application/json' } });
      if (!response.ok) failure = { kind: 'http', status: response.status };
      else {
        body = await response.text();
        next = parseScreener(JSON.parse(body));
        if (!next) failure = { kind: 'invalid' };
      }
    } catch (error) {
      failure = { kind: timedOut ? 'timeout' : error instanceof SyntaxError ? 'invalid' : 'network' };
    } finally {
      clearTimeout(timer);
    }
    if (disposed) return;
    controller = null;
    fetchedAt = Date.now();
    // An empty refresh must not wipe a populated screen.
    if (next && next.rows.length === 0 && data && data.rows.length > 0) {
      data = { ...data, errors: next.errors };
      renderIssues();
      alerts.replaceChildren(h('div', { class: 'mbx-alert', role: 'alert' }, h('span', {}, `${t.stale} ${t.emptyScreen}`), retryButton()));
      refreshButton.disabled = false;
      el.setAttribute('aria-busy', 'false');
      stamp.textContent = data.updatedAt ? fill(t.updated, { date: dateTime(data.updatedAt, lang) }) : '';
      return;
    }
    const changed = next !== null && body !== signature;
    if (next) {
      signature = body;
      data = next;
    }
    renderStatus(failure);
    renderIssues();
    if (changed) renderAll();
  }

  const due = () => {
    if (!document.hidden && Date.now() - fetchedAt >= REFRESH_MS) void load();
  };
  const timer = setInterval(due, 30_000);
  const onVisible = () => {
    if (!document.hidden) due();
  };
  document.addEventListener('visibilitychange', onVisible);
  void load();

  return {
    el,
    dispose() {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      controller?.abort();
      controller = null;
      scatter.dispose();
      correlation.dispose();
    },
  };
}
