// Company metrics view: period returns, metric tables, time-series charts,
// distribution, monthly returns and news statistics.
import { h } from '../dom';
import { histogramChart, qqChart } from './distribution';
import { compact, formatValue, fullDate, localeOf, monthName, num, pct } from './format';
import type { Lang } from './format';
import { parseMetrics, pick } from './parse';
import type { Metrics, MetricItem, Month, NewsGroup, Nullable, Period, SeriesKey } from './parse';
import { fill, nameOf, strings } from './strings';
import type { Strings } from './strings';
import { Sync, timeChart } from './timechart';
import type { SeriesSpec, TimeChart, TimeChartSpec } from './timechart';
import { downloadCsv, empty, missing, note, panel, scroller, segmented, table, tint, track, uid } from './ui';

type RangeId = '1m' | '3m' | '6m' | 'ytd' | '1y' | 'all';

const PERIOD_NAMES: Record<string, [string, string]> = {
  '1d': ['1 day', '1 день'],
  '1w': ['1 week', '1 неделя'],
  '1m': ['1 month', '1 месяц'],
  '3m': ['3 months', '3 месяца'],
  '6m': ['6 months', '6 месяцев'],
  ytd: ['Year to date', 'С начала года'],
  '1y': ['1 year', '1 год'],
};

const periodName = (id: string, lang: Lang) => PERIOD_NAMES[id]?.[lang === 'ru' ? 1 : 0] ?? id;

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  const id = uid('section');
  return h('div', { class: 'mbx-section', id, 'data-title': title }, h('h2', {}, title), ...children);
}

function signedCell(value: Nullable, lang: Lang): HTMLElement {
  if (value === null) return h('td', { class: 'num' }, missing(lang));
  const cls = value > 0 ? 'up' : value < 0 ? 'down' : '';
  return h('td', { class: `num mbx-${cls || 'level'}` }, pct(value, lang));
}

// ---- periods --------------------------------------------------------------

function periodSection(periods: Period[], lang: Lang): HTMLElement {
  const t = strings(lang);
  if (periods.length === 0) return section(t.secPeriods, panel(t.periodTitle, empty(lang)));

  const grid = table(
    t.periodTitle,
    [
      { text: t.period },
      { text: t.ret, numeric: true },
      { text: t.bench, numeric: true },
      { text: t.excess, numeric: true },
    ],
    periods.map((p) =>
      h(
        'tr',
        {},
        h('th', { scope: 'row' }, periodName(p.id, lang)),
        signedCell(p.ret, lang),
        signedCell(p.bench, lang),
        signedCell(p.excess, lang),
      ),
    ),
  );

  // Return and benchmark on one scale; excess on its own so small gaps stay visible.
  const values = periods.flatMap((p) => [p.ret, p.bench]).filter((v): v is number => v !== null);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const pairRow = (label: string, value: Nullable, kind: 'a' | 'b', low: number, high: number) =>
    h(
      'div',
      { class: 'mbx-barrow' },
      h('span', { class: 'mbx-barlabel' }, label),
      track(value, low, high, kind),
      h('span', { class: 'mbx-barvalue' }, value === null ? missing(lang) : pct(value, lang)),
    );
  const pairs = h(
    'div',
    { class: 'mbx-bars', role: 'img', 'aria-label': `${t.periodTitle}. ${t.dataTable}` },
    h(
      'div',
      { class: 'mbx-legend' },
      h('span', { class: 'mbx-key' }, h('i', { class: 'mbx-swatch-box s1' }), h('em', {}, t.company)),
      h('span', { class: 'mbx-key' }, h('i', { class: 'mbx-swatch-box hollow' }), h('em', {}, t.bench)),
    ),
    ...periods.map((p) =>
      h(
        'div',
        { class: 'mbx-bargroup' },
        h('h5', {}, periodName(p.id, lang)),
        pairRow(t.company, p.ret, 'a', lo, hi),
        pairRow(t.bench, p.bench, 'b', lo, hi),
      ),
    ),
  );

  const excess = periods.map((p) => p.excess).filter((v): v is number => v !== null);
  const bound = Math.max(0, ...excess.map(Math.abs));
  const excessBars = excess.length
    ? h(
        'div',
        { class: 'mbx-bars', role: 'img', 'aria-label': `${t.excess}. ${t.dataTable}` },
        ...periods.map((p) => pairRow(periodName(p.id, lang), p.excess, p.excess !== null && p.excess < 0 ? 'b' : 'a', -bound, bound)),
      )
    : empty(lang);
  excessBars.classList.add('signed');

  return section(
    t.secPeriods,
    h(
      'div',
      { class: 'mbx-grid3' },
      panel(t.periodTitle, scroller(grid, t.periodTitle), note(t.excessNote)),
      panel(`${t.ret} / ${t.bench}`, pairs),
      panel(t.excess, excessBars),
    ),
  );
}

// ---- metric tables ---------------------------------------------------------

function itemValue(item: MetricItem, lang: Lang): Node | string {
  if (item.value === null) return missing(lang);
  const signed = /return|excess|change|alpha|momentum|distance|^ret|_ret|chg/i.test(item.id);
  return formatValue(item.value, item.unit, lang, signed);
}

function metricSection(data: Metrics, lang: Lang): HTMLElement {
  const t = strings(lang);
  if (data.groups.length === 0) return section(t.secMetrics, panel(t.secMetrics, empty(lang)));
  const total = data.groups.reduce((sum, g) => sum + g.items.length, 0);
  const open = new Set<string>();
  let query = '';
  let groupId = '';
  let onlyData = false;
  let helpAll = false;

  const host = h('div', { class: 'mbx-metric-grid' });
  const count = h('span', { class: 'mbx-count', role: 'status' });

  const filtered = () => {
    const needle = query.trim().toLocaleLowerCase(localeOf(lang));
    return data.groups
      .filter((g) => !groupId || g.id === groupId)
      .map((group) => ({
        group,
        items: group.items.filter((item) => {
          if (onlyData && item.value === null) return false;
          if (!needle) return true;
          return [item.id, item.label.en, item.label.ru, item.hint[lang], item.formula, group.title[lang]]
            .join(' ')
            .toLocaleLowerCase(localeOf(lang))
            .includes(needle);
        }),
      }))
      .filter((g) => g.items.length > 0);
  };

  const render = () => {
    const groups = filtered();
    const shown = groups.reduce((sum, g) => sum + g.items.length, 0);
    count.textContent = fill(t.shown, { n: shown, total });
    host.replaceChildren(
      ...(groups.length === 0
        ? [empty(lang, t.noMatch)]
        : groups.map(({ group, items }) => {
            const title = pick(group.title, lang);
            const rows: Node[] = [];
            for (const item of items) {
              const key = `${group.id}/${item.id}`;
              const expanded = helpAll || open.has(key);
              const detailId = uid('hint');
              const detail = h(
                'tr',
                { class: 'mbx-hint', id: detailId, hidden: !expanded },
                h(
                  'td',
                  { colspan: 2 },
                  h('p', {}, pick(item.hint, lang) || t.noExplain),
                  item.formula ? h('p', {}, h('em', {}, `${t.formula}: `), h('code', {}, item.formula)) : null,
                ),
              );
              const button = h(
                'button',
                { type: 'button', class: 'mbx-metric-name', 'aria-expanded': String(expanded), 'aria-controls': detailId },
                pick(item.label, lang),
              );
              button.addEventListener('click', () => {
                const next = detail.hidden;
                detail.hidden = !next;
                button.setAttribute('aria-expanded', String(next));
                if (next) open.add(key);
                else open.delete(key);
              });
              rows.push(h('tr', {}, h('th', { scope: 'row' }, button), h('td', { class: 'num' }, itemValue(item, lang))), detail);
            }
            return panel(title, table(title, [{ text: t.metric }, { text: t.value, numeric: true }], rows, 'mbx-metrics-table'));
          })),
    );
  };

  const check = (label: string, onChange: (on: boolean) => void) => {
    const input = h('input', { type: 'checkbox', onchange: () => onChange(input.checked) });
    return h('label', { class: 'mbx-check' }, input, label);
  };

  const exportButton = h(
    'button',
    {
      type: 'button',
      class: 'mbx-button',
      onclick: () => {
        const rows: (string | number | null)[][] = [[t.group, t.metric, t.value, 'unit', t.formula, t.explanation]];
        for (const { group, items } of filtered()) {
          for (const item of items) {
            rows.push([pick(group.title, lang), pick(item.label, lang), item.value, item.unit, item.formula, pick(item.hint, lang)]);
          }
        }
        downloadCsv('metrics.csv', rows, lang);
      },
    },
    t.exportCsv,
  );

  const chips = segmented(
    t.group,
    [['', t.allGroups] as const, ...data.groups.map((g) => [g.id, pick(g.title, lang)] as const)],
    '',
    (value) => {
      groupId = value;
      render();
    },
  );
  chips.classList.add('mbx-wrap');

  const toolbar = h(
    'div',
    { class: 'mbx-toolbar' },
    h('input', {
      type: 'search',
      class: 'mbx-search',
      placeholder: t.searchMetrics,
      'aria-label': t.searchMetrics,
      oninput: (event: Event) => {
        query = (event.target as HTMLInputElement).value;
        render();
      },
    }),
    check(t.onlyData, (on) => {
      onlyData = on;
      render();
    }),
    check(t.showHelp, (on) => {
      helpAll = on;
      if (!on) open.clear();
      render();
    }),
    exportButton,
    count,
  );

  render();
  return section(t.secMetrics, toolbar, chips, host);
}

// ---- time series ------------------------------------------------------------

function cutoff(range: RangeId, last: number): number {
  if (range === 'all') return -Infinity;
  const date = new Date(last);
  if (range === 'ytd') return Date.UTC(date.getUTCFullYear(), 0, 1);
  const months = range === '1m' ? 1 : range === '3m' ? 3 : range === '6m' ? 6 : 12;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  // Clamp to the end of shorter months.
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, end));
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

type Def = Omit<TimeChartSpec, 'lang' | 'times' | 'series' | 'sync' | 'absent' | 'band'> & {
  lines: (Omit<SeriesSpec, 'values'> & { key: SeriesKey })[];
  band?: boolean;
  wide?: boolean;
};

function seriesCharts(data: Metrics, lang: Lang): { el: HTMLElement; charts: TimeChart[] } {
  const t = strings(lang);
  const series = data.series;
  if (!series) return { el: panel(t.secCharts, empty(lang)), charts: [] };
  const sync = new Sync();
  const price = (v: number) => formatValue(v, 'price', lang);
  const ratio = (v: number) => num(v, lang, 2, 2);
  const axis = (v: number) => (Math.abs(v) >= 10_000 ? compact(v, lang) : num(v, lang, 0, 2));
  const percent = (v: number) => pct(v, lang, false);
  const percentAxis = (v: number) => `${num(v, lang, 0, 1)}%`;

  const defs: Def[] = [
    {
      title: t.chPrice,
      unit: t.unitPrice,
      height: 300,
      wide: true,
      band: true,
      format: price,
      axis,
      lines: [
        { key: 'close', label: t.close, tone: 'text' },
        { key: 'sma20', label: 'SMA 20', tone: 's1' },
        { key: 'sma50', label: 'SMA 50', tone: 's2', dash: '6 3' },
        { key: 'sma200', label: 'SMA 200', tone: 's3', dash: '2 3' },
      ],
    },
    {
      title: t.chVolume,
      unit: t.unitShares,
      height: 110,
      wide: true,
      zero: true,
      barSummary: 'mean',
      format: (v) => compact(v, lang),
      axis: (v) => compact(v, lang),
      lines: [{ key: 'volume', label: t.volume, tone: 's1', kind: 'bars' }],
    },
    {
      title: t.chRsi,
      unit: t.unitIndex,
      height: 130,
      wide: true,
      domain: [0, 100],
      refs: [30, 70],
      format: (v) => num(v, lang, 1, 1),
      axis: (v) => num(v, lang, 0, 0),
      lines: [{ key: 'rsi14', label: 'RSI 14', tone: 's3' }],
    },
    {
      title: t.chMacd,
      unit: t.unitPrice,
      height: 160,
      wide: true,
      zero: true,
      barSummary: 'extreme',
      format: ratio,
      axis,
      lines: [
        { key: 'macd', label: 'MACD', tone: 'text' },
        { key: 'macdSignal', label: t.signal, tone: 'gold', dash: '5 3' },
        { key: 'macdHist', label: t.histogramS, tone: 's1', kind: 'signbars' },
      ],
    },
    {
      title: t.chDrawdown,
      unit: t.unitPct,
      height: 150,
      zero: true,
      format: percent,
      axis: percentAxis,
      lines: [{ key: 'drawdownPct', label: t.drawdown, tone: 's2', kind: 'area' }],
    },
    {
      title: t.chVol,
      unit: t.unitPct,
      height: 150,
      format: percent,
      axis: percentAxis,
      lines: [{ key: 'rollVolPct', label: t.volS, tone: 's1' }],
    },
    {
      title: t.chBeta,
      unit: t.unitRatio,
      height: 150,
      refs: [1],
      format: ratio,
      axis,
      lines: [{ key: 'rollBeta60', label: t.beta, tone: 's3' }],
    },
    {
      title: t.chCorr,
      unit: t.unitCorr,
      height: 150,
      domain: [-1, 1],
      format: ratio,
      axis,
      lines: [{ key: 'rollCorr60', label: t.corr, tone: 's1' }],
    },
    {
      title: t.chSharpe,
      unit: t.unitRatio,
      height: 150,
      refs: [0],
      format: ratio,
      axis,
      lines: [{ key: 'rollSharpe60', label: t.sharpe, tone: 'gold' }],
    },
    {
      title: t.chRs,
      unit: t.unitRatio,
      height: 150,
      format: (v) => num(v, lang, 2, 3),
      axis: (v) => num(v, lang, 0, 3),
      lines: [{ key: 'relativeStrength', label: t.rs, tone: 's2' }],
    },
  ];

  const wide = h('div', { class: 'mbx-stack' });
  const pairs = h('div', { class: 'mbx-grid2' });
  const charts = defs.map((def) => {
    const upper = series.data.bollUpper;
    const lower = series.data.bollLower;
    const band = def.band && upper && lower ? { label: t.bollinger, upper, lower } : undefined;
    const chart = timeChart({
      ...def,
      lang,
      sync,
      times: series.time,
      band,
      absent: [
        ...def.lines.filter((l) => !series.data[l.key]).map((l) => l.label),
        ...(def.band && !band ? [t.bollinger] : []),
      ],
      series: def.lines.flatMap(({ key, ...line }) => {
        const values = series.data[key];
        return values ? [{ ...line, values }] : [];
      }),
    });
    (def.wide ? wide : pairs).append(chart.el);
    return chart;
  });
  return { el: h('div', { class: 'mbx-stack' }, wide, pairs), charts };
}

// ---- monthly ---------------------------------------------------------------

type MonthlyMode = 'asset' | 'bench' | 'excess';

function monthlySection(months: Month[], lang: Lang): HTMLElement {
  const t = strings(lang);
  if (months.length === 0) return section(t.secMonthly, panel(t.chMonthly, empty(lang)));
  let mode: MonthlyMode = 'asset';
  const grid = h('div', {});
  const season = h('div', {});
  const years = [...new Set(months.map((m) => m.year))].sort((a, b) => b - a);
  const names = Array.from({ length: 12 }, (_, i) => monthName(i + 1, lang));

  const valueOf = (m: Month): Nullable =>
    mode === 'asset' ? m.ret : mode === 'bench' ? m.bench : m.ret === null || m.bench === null ? null : m.ret - m.bench;

  const render = () => {
    const values = months.map(valueOf).filter((v): v is number => v !== null);
    const bound = Math.max(1e-9, ...values.map(Math.abs));
    const shaded = (v: Nullable, className = 'num'): HTMLElement =>
      v === null
        ? h('td', { class: className }, missing(lang))
        : h('td', { class: className, style: tint(Math.abs(v) / bound, v < 0 ? 'neg' : 'pos') }, formatValue(v, 'pct', lang, true));

    let partial = false;
    const rows = years.map((year) => {
      const own = months.filter((m) => m.year === year);
      const cells = names.map((_, i) => {
        const found = own.find((m) => m.month === i + 1);
        return found ? shaded(valueOf(found)) : h('td', { class: 'num' }, h('span', { class: 'mbx-missing', title: t.noData }, '—'));
      });
      // A difference of returns does not compound, so excess has no yearly total.
      const listed = own.map(valueOf).filter((v): v is number => v !== null);
      let totalCell: HTMLElement | null = null;
      if (mode !== 'excess') {
        const compounded = listed.length ? (listed.reduce((acc, v) => acc * (1 + v / 100), 1) - 1) * 100 : null;
        const incomplete = listed.length < 12;
        if (compounded !== null && incomplete) partial = true;
        totalCell = h(
          'td',
          { class: 'num mbx-total' },
          compounded === null ? missing(lang) : `${pct(compounded, lang)}${incomplete ? '*' : ''}`,
        );
      }
      return h('tr', {}, h('th', { scope: 'row' }, String(year)), ...cells, totalCell);
    });
    const head = [
      { text: t.year },
      ...names.map((name) => ({ text: name, numeric: true })),
      ...(mode === 'excess' ? [] : [{ text: t.total, numeric: true }]),
    ];
    grid.replaceChildren(
      scroller(table(t.chMonthly, head, rows, 'mbx-heat'), t.chMonthly),
      note(partial ? `${t.shading} ${t.partial}` : t.shading),
    );

    const averages = names.map((name, i) => {
      const list = months.filter((m) => m.month === i + 1).map(valueOf).filter((v): v is number => v !== null);
      return { name, n: list.length, mean: list.length ? list.reduce((a, b) => a + b, 0) / list.length : null };
    });
    const top = Math.max(0, ...averages.map((a) => Math.abs(a.mean ?? 0)));
    season.replaceChildren(
      scroller(
        table(
          t.chSeason,
          [{ text: t.month }, { text: '' }, { text: t.value, numeric: true }, { text: t.years, numeric: true }],
          averages.map((a) =>
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, a.name),
              h('td', { class: 'mbx-trackcell' }, track(a.mean, -top, top)),
              signedCell(a.mean, lang),
              h('td', { class: 'num' }, String(a.n)),
            ),
          ),
          'mbx-barstable',
        ),
        t.chSeason,
      ),
      note(t.seasonNote),
    );
  };

  const modes = segmented<MonthlyMode>(
    t.chMonthly,
    [
      ['asset', t.mAsset],
      ['bench', t.mBench],
      ['excess', t.mExcess],
    ],
    mode,
    (value) => {
      mode = value;
      render();
    },
  );
  render();
  return section(t.secMonthly, modes, panel(t.chMonthly, grid), panel(t.chSeason, season));
}

// ---- news ------------------------------------------------------------------

function languageName(code: string, lang: Lang): string {
  try {
    return new Intl.DisplayNames([localeOf(lang)], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function newsTable(title: string, keyLabel: string, rows: NewsGroup[], label: (key: string) => string, lang: Lang): HTMLElement {
  const t = strings(lang);
  if (rows.length === 0) return panel(title, empty(lang));
  const CAP = 12;
  let all = false;
  const host = h('div', {});
  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  const withTone = rows.some((r) => r.tone !== null);
  const bound = Math.max(1e-9, ...rows.map((r) => Math.abs(r.tone ?? 0)));
  const render = () => {
    const shown = all ? rows : rows.slice(0, CAP);
    const grid = table(
      title,
      [
        { text: keyLabel },
        { text: '' },
        { text: t.count, numeric: true },
        ...(withTone ? [{ text: '' }, { text: t.meanTone, numeric: true }] : []),
      ],
      shown.map((r) =>
        h(
          'tr',
          {},
          h('th', { scope: 'row', dir: 'auto' }, label(r.key)),
          h('td', { class: 'mbx-trackcell' }, track(r.count, 0, maxCount, 'a')),
          h('td', { class: 'num' }, num(r.count, lang, 0, 0)),
          withTone ? h('td', { class: 'mbx-trackcell' }, track(r.tone, -bound, bound)) : null,
          withTone ? h('td', { class: 'num' }, r.tone === null ? missing(lang) : formatValue(r.tone, 'ratio', lang, true)) : null,
        ),
      ),
      'mbx-barstable',
    );
    const more =
      rows.length > CAP
        ? h(
            'button',
            {
              type: 'button',
              class: 'mbx-button',
              onclick: () => {
                all = !all;
                render();
              },
            },
            all ? t.showLess : fill(t.showMore, { n: rows.length }),
          )
        : null;
    host.replaceChildren(scroller(grid, title), ...(more ? [more] : []));
  };
  render();
  return panel(title, host);
}

function newsSection(data: Metrics, lang: Lang): { el: HTMLElement; charts: TimeChart[] } {
  const t: Strings = strings(lang);
  const news = data.news;
  if (!news) return { el: section(t.secNews, panel(t.secNews, empty(lang))), charts: [] };
  const sync = new Sync();
  const times = news.daily.map((d) => d.time);
  const charts = [
    timeChart({
      title: t.chNewsCount,
      unit: t.unitItems,
      lang,
      times,
      sync,
      height: 150,
      zero: true,
      spacing: 'time',
      format: (v) => num(v, lang, 0, 0),
      axis: (v) => num(v, lang, 0, 1),
      series: [{ label: t.items, values: news.daily.map((d) => d.count), tone: 's1', kind: 'bars' }],
    }),
    timeChart({
      title: t.chNewsTone,
      unit: t.unitTone,
      lang,
      times,
      sync,
      height: 150,
      zero: true,
      spacing: 'time',
      format: (v) => formatValue(v, 'ratio', lang, true),
      axis: (v) => num(v, lang, 0, 2),
      series: [{ label: t.tone, values: news.daily.map((d) => d.tone), tone: 's1', kind: 'signbars' }],
    }),
  ];
  const el = section(
    t.secNews,
    h('div', { class: 'mbx-grid2' }, ...charts.map((c) => c.el)),
    h(
      'div',
      { class: 'mbx-grid3' },
      newsTable(t.newsType, t.type, news.byType, (k) => nameOf(k, lang), lang),
      newsTable(t.newsSource, t.source, news.bySource, (k) => k, lang),
      newsTable(t.newsLang, t.language, news.byLang, (k) => languageName(k, lang), lang),
    ),
    note(t.toneNote),
  );
  return { el, charts };
}

// ---- view -------------------------------------------------------------------

export function metricsView(metrics: unknown, lang: Lang): HTMLElement {
  const t = strings(lang);
  const root = h('div', { class: 'mbx mbx-metrics', lang });
  const data = parseMetrics(metrics);
  if (!data) {
    root.append(panel(t.secMetrics, empty(lang, t.noMetrics)));
    return root;
  }

  const time = seriesCharts(data, lang);
  const news = newsSection(data, lang);
  const lastTime = data.series?.time[data.series?.time.length - 1] ?? data.news?.daily[data.news?.daily.length - 1]?.time ?? null;
  const options: readonly (readonly [RangeId, string])[] = [
    ['1m', t.r1m],
    ['3m', t.r3m],
    ['6m', t.r6m],
    ['ytd', t.rytd],
    ['1y', t.r1y],
    ['all', t.rall],
  ];
  // One selection, shown above both groups of time charts.
  const bars: { buttons: Element[]; span: HTMLElement; times: number[] }[] = [];

  const apply = (range: RangeId) => {
    if (lastTime === null) return;
    const since = cutoff(range, lastTime);
    for (const chart of [...time.charts, ...news.charts]) chart.setSince(since);
    for (const bar of bars) {
      bar.buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i]?.[0] === range)));
      const visible = bar.times.filter((v) => v >= since);
      const first = visible[0];
      const last = visible[visible.length - 1];
      bar.span.textContent =
        first !== undefined && last !== undefined
          ? fill(t.span, { from: fullDate(first, lang), to: fullDate(last, lang), n: visible.length })
          : t.noRange;
    }
  };

  const rangeBar = (times: number[]) => {
    const control = segmented(t.range, options, '1y', apply);
    const span = h('span', { class: 'mbx-count', role: 'status' });
    bars.push({ buttons: [...control.children], span, times });
    return h('div', { class: 'mbx-rangebar' }, h('span', { class: 'mbx-unit' }, t.range), control, span);
  };

  // The range selector stays pinned while its time-based charts are on screen.
  const charts = section(t.secCharts, time.el);
  if (data.series) charts.firstElementChild?.after(rangeBar(data.series.time));
  if (data.news?.daily.length) {
    news.el.firstElementChild?.after(rangeBar(data.news.daily.map((d) => d.time)));
  }
  const distribution = section(
    t.secDist,
    h(
      'div',
      { class: 'mbx-grid2' },
      data.histogram ? histogramChart(data.histogram, lang) : panel(t.chHist, empty(lang)),
      data.qq ? qqChart(data.qq, lang) : panel(t.chQq, empty(lang)),
    ),
  );

  const sections = [
    periodSection(data.periods, lang),
    metricSection(data, lang),
    charts,
    distribution,
    monthlySection(data.monthly, lang),
    news.el,
  ];
  const jump = h(
    'nav',
    { class: 'mbx-jump', 'aria-label': t.jump },
    ...sections.map((node) =>
      h(
        'button',
        { type: 'button', class: 'mbx-button', onclick: () => node.scrollIntoView({ block: 'start' }) },
        node.dataset.title ?? '',
      ),
    ),
  );
  const meta = [
    data.asOf === null ? null : fill(t.asOf, { date: fullDate(data.asOf, lang) }),
    data.sessions === null ? null : fill(t.sessions, { n: num(data.sessions, lang, 0, 0) }),
  ]
    .filter(Boolean)
    .join(' · ');

  root.append(h('div', { class: 'mbx-viewhead' }, h('span', { class: 'mbx-count' }, meta), jump), ...sections);
  apply('1y');
  return root;
}
