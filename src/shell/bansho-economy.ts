// Under the dashboard map: significant moves in the economy, with charts,
// and the world event flow. Real data from /api/dossier only; anything missing
// is shown as "no data".
import { fetchBanshoDashboardData } from '@/services/bansho-dashboard-data';
import './bansho-economy.css';
import './bansho-skin.css';
import { consequencesBlock } from '../dossier/consequences';

type Lang = 'ru' | 'en';
type Group = 'index' | 'fx' | 'commodity' | 'yield' | 'crypto' | 'stock';
type Point = [number, number];

interface Row {
  symbol: string;
  name: string;
  group: Group;
  unit: 'pct' | 'bp';
  price: number;
  change1d: number | null;
  change5d: number | null;
  change1m: number | null;
  z1d: number | null;
  asOf: number;
  stale: boolean;
  series: Point[];
}
interface Headline { title: string; titleRu?: string; url: string; source: string; time: number; consequences?: unknown }
interface Economy { updatedAt: number; asked: number; rows: Row[]; movers: string[]; news: Record<string, Headline[]> }
interface WorldEvent { title: string; titleRu?: string; url: string; typeLabel: string; sourceCount: number; lastAt: number; consequences?: unknown }
interface World {
  windowHours: number;
  events: WorldEvent[];
  regions: Array<{ id: string; label: string; events: number; articles: number }>;
  timeline: { binHours: number; feeds: { volume: Array<{ t: number; value: number | null }> } };
}

const TEXT = {
  ru: {
    title: 'Значимые изменения в экономике',
    note: 'Дневные движения, отсортированы по необычности: z — во сколько раз изменение больше обычного дневного колебания за 60 сессий.',
    loading: 'Загрузка котировок', none: 'нет данных', retry: 'Повтор через минуту', updated: 'Обновлено',
    unusual: 'Отклонение от обычной волатильности, z', curve: 'Кривая доходности US Treasuries, %', now: 'сейчас', week: 'неделю назад', month: 'месяц назад',
    history: 'История за 6 месяцев', day: '1 день', five: '5 дней', mon: '1 месяц', price: 'Цена', instrument: 'Инструмент',
    noNews: 'Заголовков за 3 дня не найдено', stale: 'котировка устарела',
    events: 'События в мире', volume: 'Публикаций в отслеживаемых лентах по 3-часовым интервалам', regions: 'События по регионам', top: 'Главные события', sources: 'источников',
    groups: { index: 'Индексы', fx: 'Валюты', commodity: 'Сырьё', yield: 'Доходности', crypto: 'Криптовалюты', stock: 'Крупные акции' },
    unitNote: 'доходности — в базисных пунктах',
  },
  en: {
    title: 'Significant moves in the economy',
    note: 'Daily moves ranked by how unusual they are: z is the change relative to the usual daily swing over 60 sessions.',
    loading: 'Loading quotes', none: 'no data', retry: 'Retrying in a minute', updated: 'Updated',
    unusual: 'Deviation from usual volatility, z', curve: 'US Treasury yield curve, %', now: 'now', week: 'a week ago', month: 'a month ago',
    history: '6-month history', day: '1 day', five: '5 days', mon: '1 month', price: 'Price', instrument: 'Instrument',
    noNews: 'No headlines in the last 3 days', stale: 'stale quote',
    events: 'World events', volume: 'Articles in tracked feeds per 3 hours', regions: 'Events by region', top: 'Top events', sources: 'sources',
    groups: { index: 'Indices', fx: 'Currencies', commodity: 'Commodities', yield: 'Yields', crypto: 'Crypto', stock: 'Large stocks' },
    unitNote: 'yields in basis points',
  },
} as const;

const GROUPS: Group[] = ['index', 'fx', 'commodity', 'yield', 'crypto', 'stock'];
const KEY_NUMBERS = ['^GSPC', '^IXIC', 'DX-Y.NYB', 'EURUSD=X', 'RUB=X', 'KZT=X', 'BZ=F', 'GC=F', '^TNX', 'BTC-USD', '^VIX', '^STOXX50E'];
const REFRESH_MS = 2 * 60_000;
const RETRY_MS = 60_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function svg(tag: string, attributes: Record<string, string | number>): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

export function mountBanshoEconomy(main: HTMLElement, lang: Lang): () => void {
  const t = TEXT[lang];
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
  const number = (value: number, digits: number) => value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const price = (value: number) => number(value, Math.abs(value) >= 1000 ? 0 : Math.abs(value) >= 20 ? 2 : 4);
  const signed = (value: number, digits: number) => `${value > 0 ? '+' : ''}${number(value, digits)}`;
  const day = (ms: number) => new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  const clock = (ms: number) => new Date(ms).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  const change = (value: number | null, unit: Row['unit']): HTMLElement => {
    if (value === null) return el('span', 'be-muted', t.none);
    const suffix = unit === 'bp' ? (lang === 'ru' ? ' б.п.' : ' bp') : '%';
    // A rising yield is a falling bond price, so only price growth is green.
    const tone = unit === 'bp' || value === 0 ? 'be-flat' : value > 0 ? 'be-up' : 'be-down';
    return el('span', tone, `${signed(value, unit === 'bp' ? 1 : 2)}${suffix}`);
  };

  const line = (series: Point[], width: number, height: number, className: string): SVGElement => {
    const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', class: className, 'aria-hidden': 'true' });
    const values = series.map((p) => p[1]);
    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    const points = values
      .map((v, i) => `${((i * width) / Math.max(1, values.length - 1)).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`)
      .join(' ');
    chart.append(svg('polyline', { points, fill: 'none', 'vector-effect': 'non-scaling-stroke' }));
    return chart;
  };

  const box = (title: string, className = ''): HTMLElement => {
    const node = el('div', `be-box ${className}`.trim());
    node.append(el('h3', '', title));
    return node;
  };

  const headline = (item: { title: string; titleRu?: string; url: string; consequences?: unknown }, meta: string, scope: string): HTMLElement => {
    const row = el('li');
    const link = el('a', '', lang === 'ru' ? item.titleRu || item.title : item.title);
    if (/^https?:\/\//i.test(item.url)) link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = item.title;
    row.append(link, el('span', 'be-muted', meta), consequencesBlock(item.consequences, `${scope}-${item.url}`, lang));
    return row;
  };

  const root = el('section', 'bansho-economy');
  root.id = 'banshoEconomy';
  root.setAttribute('aria-label', t.title);
  const head = el('div', 'be-head');
  const status = el('span', 'be-muted', t.loading);
  head.append(el('h2', '', t.title), status);
  const market = el('div', 'be-market');
  const world = el('div', 'be-world');
  root.append(head, market, el('p', 'be-muted be-note', t.note), world);
  const map = main.querySelector(':scope > .map-section');
  if (map) map.after(root);
  else main.prepend(root);

  let selected = '';
  let economy: Economy | null = null;

  const renderHistory = (host: HTMLElement, row: Row): void => {
    host.replaceChildren(el('h3', '', `${t.history}: ${row.name}`));
    if (row.series.length < 2) {
      host.append(el('p', 'be-muted', t.none));
      return;
    }
    const values = row.series.map((p) => p[1]);
    const frame = el('div', 'be-history-frame');
    const axis = el('div', 'be-axis');
    const max = Math.max(...values);
    const min = Math.min(...values);
    for (const value of [max, (max + min) / 2, min]) axis.append(el('span', '', price(value)));
    frame.append(line(row.series, 600, 180, 'be-history-line'), axis);
    const dates = el('div', 'be-dates');
    for (const i of [0, Math.floor(row.series.length / 2), row.series.length - 1]) dates.append(el('span', '', day(row.series[i]![0])));
    host.append(frame, dates);
  };

  const renderMarket = (data: Economy): void => {
    const bySymbol = new Map(data.rows.map((r) => [r.symbol, r]));
    const movers = data.movers.flatMap((s) => bySymbol.get(s) ?? []);
    if (!bySymbol.has(selected)) selected = bySymbol.has('^GSPC') ? '^GSPC' : data.rows[0]?.symbol ?? '';

    const history = box(t.history, 'be-history');
    const select = (symbol: string): void => {
      const row = bySymbol.get(symbol);
      if (!row) return;
      selected = symbol;
      renderHistory(history, row);
      for (const node of market.querySelectorAll<HTMLElement>('[data-symbol]')) {
        node.classList.toggle('be-selected', node.dataset.symbol === symbol);
      }
    };
    const pickable = (node: HTMLElement, row: Row): void => {
      node.dataset.symbol = row.symbol;
      node.addEventListener('click', () => select(row.symbol));
    };

    const numbers = el('div', 'be-kpis');
    for (const row of KEY_NUMBERS.flatMap((symbol) => bySymbol.get(symbol) ?? [])) {
      const tile = el('button', 'be-kpi');
      tile.type = 'button';
      pickable(tile, row);
      tile.append(el('span', 'be-kpi-name', row.name), el('b', '', price(row.price)), change(row.change1d, row.unit), line(row.series.slice(-42), 120, 26, 'be-kpi-spark'));
      numbers.append(tile);
    }

    const cards = el('div', 'be-movers');
    for (const row of movers) {
      const card = el('article', 'be-card');
      const top = el('button', 'be-card-top');
      top.type = 'button';
      pickable(top, row);
      const title = el('div', 'be-card-title');
      title.append(el('strong', '', row.name), el('span', 'be-z', `z ${signed(row.z1d ?? 0, 1)}`));
      const quote = el('div', 'be-card-quote');
      quote.append(el('span', 'be-price', price(row.price)), change(row.change1d, row.unit));
      top.append(title, quote, line(row.series.slice(-63), 200, 44, 'be-spark'));
      const list = el('ul', 'be-news');
      for (const item of (data.news[row.symbol] ?? []).slice(0, 2)) list.append(headline(item, `${item.source} · ${clock(item.time)}`, `eco-${row.symbol}`));
      if (!list.childElementCount) list.append(el('li', 'be-muted', t.noNews));
      card.append(top, list);
      cards.append(card);
    }
    if (!movers.length) cards.append(el('p', 'be-muted', t.none));

    // Diverging bars: how far each instrument is from its usual daily swing.
    const ranked = data.rows.filter((r) => !r.stale && r.z1d !== null)
      .sort((a, b) => Math.abs(b.z1d!) - Math.abs(a.z1d!)).slice(0, 16);
    const bars = box(t.unusual, 'be-bars');
    const scale = Math.max(1, ...ranked.map((r) => Math.abs(r.z1d!)));
    for (const row of ranked) {
      const item = el('button', 'be-bar');
      item.type = 'button';
      pickable(item, row);
      const track = el('span', 'be-track');
      const fill = el('span', row.unit === 'bp' ? 'be-fill be-fill-flat' : row.z1d! > 0 ? 'be-fill be-fill-up' : 'be-fill be-fill-down');
      const width = (Math.abs(row.z1d!) / scale) * 50;
      fill.style.width = `${width}%`;
      fill.style.left = `${row.z1d! >= 0 ? 50 : 50 - width}%`;
      track.append(fill);
      item.append(el('span', 'be-bar-name', row.name), track, el('span', 'be-num', signed(row.z1d!, 1)));
      bars.append(item);
    }
    if (!ranked.length) bars.append(el('p', 'be-muted', t.none));

    const curve = box(t.curve, 'be-curve');
    const tenors = ['^IRX', '^FVX', '^TNX', '^TYX'].flatMap((s) => bySymbol.get(s) ?? []);
    if (tenors.length >= 2) {
      const sets = [[t.now, 0, 'be-c0'], [t.week, 5, 'be-c1'], [t.month, 21, 'be-c2']] as const;
      const values = sets.map(([, back]) => tenors.map((r) => r.series[r.series.length - 1 - back]?.[1] ?? null));
      const known = values.flat().filter((v): v is number => v !== null);
      const min = Math.min(...known) - 0.1;
      const span = Math.max(...known) + 0.1 - min;
      const chart = svg('svg', { viewBox: '0 0 400 150', preserveAspectRatio: 'none', class: 'be-curve-chart', role: 'img' });
      values.forEach((set, k) => {
        const points = set.flatMap((v, i) => (v === null ? [] : [`${20 + (i * 360) / (tenors.length - 1)},${145 - ((v - min) / span) * 140}`]));
        chart.append(svg('polyline', { points: points.join(' '), fill: 'none', class: sets[k]![2], 'vector-effect': 'non-scaling-stroke' }));
      });
      const table = el('table', 'be-table');
      const header = el('tr');
      header.append(el('th'), ...tenors.map((r) => el('th', 'be-num', r.name.replace('UST ', ''))));
      table.append(header);
      sets.forEach(([label, , className], k) => {
        const tr = el('tr');
        tr.append(el('td', `be-key ${className}`, label), ...values[k]!.map((v) => el('td', 'be-num', v === null ? t.none : number(v, 2))));
        table.append(tr);
      });
      curve.append(chart, table);
    } else curve.append(el('p', 'be-muted', t.none));

    const tables = el('div', 'be-groups');
    for (const group of GROUPS) {
      const rows = data.rows.filter((r) => r.group === group);
      const card = box(group === 'yield' ? `${t.groups[group]} (${t.unitNote})` : t.groups[group]);
      if (!rows.length) {
        card.append(el('p', 'be-muted', t.none));
        tables.append(card);
        continue;
      }
      const table = el('table', 'be-table');
      const header = el('tr');
      header.append(el('th', '', t.instrument), el('th', 'be-num', t.price), el('th', 'be-num', t.day), el('th', 'be-num be-wide', t.five), el('th', 'be-num be-wide', t.mon), el('th', 'be-wide'));
      table.append(header);
      for (const row of rows) {
        const tr = el('tr');
        pickable(tr, row);
        const name = el('td');
        const button = el('button', 'be-link', row.name);
        button.type = 'button';
        if (row.stale) button.title = `${t.stale}: ${day(row.asOf)}`;
        name.append(button);
        if (row.stale) name.append(el('span', 'be-muted', ` ${day(row.asOf)}`));
        const cell = (node: Node, className = 'be-num') => { const td = el('td', className); td.append(node); return td; };
        tr.append(
          name,
          el('td', 'be-num', price(row.price)),
          cell(change(row.change1d, row.unit)),
          cell(change(row.change5d, row.unit), 'be-num be-wide'),
          cell(change(row.change1m, row.unit), 'be-num be-wide'),
          cell(line(row.series.slice(-63), 90, 22, 'be-mini'), 'be-wide'),
        );
        table.append(tr);
      }
      card.append(table);
      tables.append(card);
    }

    const charts = el('div', 'be-charts');
    charts.append(history, bars, curve);
    market.replaceChildren(numbers, cards, charts, tables);
    select(selected);
  };

  const renderWorld = (data: World): void => {
    const volume = box(t.volume, 'be-volume');
    const bins = data.timeline?.feeds?.volume ?? [];
    const peak = Math.max(0, ...bins.map((b) => b.value ?? 0));
    if (peak > 0) {
      const columns = el('div', 'be-columns');
      for (const bin of bins) {
        const column = el('span');
        column.style.height = `${((bin.value ?? 0) / peak) * 100}%`;
        column.title = `${clock(bin.t)}: ${bin.value ?? 0}`;
        columns.append(column);
      }
      const dates = el('div', 'be-dates');
      dates.append(el('span', '', clock(bins[0]!.t)), el('span', '', `max ${peak}`), el('span', '', clock(bins[bins.length - 1]!.t)));
      volume.append(columns, dates);
    } else volume.append(el('p', 'be-muted', t.none));

    const regions = box(t.regions, 'be-bars');
    const most = Math.max(1, ...data.regions.map((r) => r.events));
    for (const region of data.regions.slice(0, 8)) {
      const item = el('div', 'be-bar');
      const track = el('span', 'be-track');
      const fill = el('span', 'be-fill be-fill-flat');
      fill.style.width = `${(region.events / most) * 100}%`;
      fill.style.left = '0';
      track.append(fill);
      item.append(el('span', 'be-bar-name', region.label), track, el('span', 'be-num', String(region.events)));
      regions.append(item);
    }
    if (!data.regions.length) regions.append(el('p', 'be-muted', t.none));

    const top = box(t.top, 'be-events');
    const list = el('ul', 'be-news');
    for (const event of data.events.slice(0, 8)) {
      list.append(headline(event, `${lang === 'ru' ? `${event.typeLabel} · ` : ''}${t.sources}: ${event.sourceCount} · ${clock(event.lastAt)}`, 'eco-world'));
    }
    top.append(list.childElementCount ? list : el('p', 'be-muted', t.none));
    world.replaceChildren(el('h2', '', t.events), volume, regions, top);
  };

  const abort = new AbortController();
  const timers = new Map<string, number>();

  const poll = <T>(view: string, valid: (body: T) => boolean, render: (body: T) => void, failed: () => void): void => {
    const run = async (): Promise<void> => {
      if (abort.signal.aborted) return;
      let delay = REFRESH_MS;
      // A hidden tab keeps what it has and asks again later.
      if (document.visibilityState !== 'hidden' || !timers.has(view)) {
        try {
          const body = await fetchBanshoDashboardData<T>(`view=${view}${lang === 'ru' ? '&tl=ru' : '&cl=en'}`, abort.signal);
          if (abort.signal.aborted) return;
          if (!valid(body)) throw new Error('Empty response');
          render(body);
        } catch {
          if (abort.signal.aborted) return;
          delay = RETRY_MS;
          failed();
        }
      }
      timers.set(view, window.setTimeout(() => void run(), delay));
    };
    void run();
  };

  poll<Economy>('economy', (body) => Array.isArray(body?.rows) && body.rows.length > 0, (body) => {
    economy = body;
    status.textContent = `${t.updated} ${clock(body.updatedAt)} · ${body.rows.length}/${body.asked}`;
    renderMarket(body);
  }, () => {
    status.textContent = economy ? `${t.updated} ${clock(economy.updatedAt)} · ${t.retry}` : `${t.none}. ${t.retry}`;
    if (!economy) market.replaceChildren(el('p', 'be-muted', t.none));
  });

  let hasWorld = false;
  poll<World>('world', (body) => Array.isArray(body?.events) && Array.isArray(body?.regions), (body) => {
    hasWorld = true;
    renderWorld(body);
  }, () => {
    if (!hasWorld) world.replaceChildren(el('h2', '', t.events), el('p', 'be-muted', `${t.none}. ${t.retry}`));
  });

  return () => {
    abort.abort();
    for (const id of timers.values()) window.clearTimeout(id);
    root.remove();
  };
}
