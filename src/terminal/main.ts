// Terminal mode: a full-screen, keyboard-driven view of the same keyless data.

import './terminal.css';
import { CENTRAL_BANKS, COMMODITY_HUBS, FINANCIAL_CENTERS, STOCK_EXCHANGES } from '@/config/finance-geo';
import { CONFLICT_ZONES } from '../../shared/geo-data';
import {
  loadDigestPublishers, loadNaturalEvents, loadQuakes, loadQuotes, loadWire, loadWorld,
  type Marker, type MarkerKind, type MarketMarkerKind, type Quote, type Story,
} from './data';
import { drawMap, loadLand, MARKER_STYLE } from './map';

type View = 'overview' | 'news' | 'markets' | 'conflict' | 'hazard';
type Source = 'world' | 'wire' | 'quotes' | 'quakes' | 'natural' | 'digest';

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'overview', label: 'Обзор' },
  { id: 'news', label: 'Новости' },
  { id: 'markets', label: 'Рынки' },
  { id: 'conflict', label: 'Конфликты' },
  { id: 'hazard', label: 'Стихия' },
];
const OVERVIEW_SYMBOLS = ['^GSPC', '^IXIC', '^STOXX50E', '^N225', 'BZ=F', 'GC=F', 'EURUSD=X', 'RUB=X', 'KZT=X', '^TNX', 'BTC-USD'];
const THEATERS: Array<{ name: string; regions: string[]; box: [number, number, number, number] }> = [
  // box: west, south, east, north
  { name: 'Ближний Восток', regions: ['israel', 'iran', 'middleeast', 'gulf'], box: [25, 12, 63, 42] },
  { name: 'Европа и Россия', regions: ['russia', 'ukraine', 'europe', 'eu', 'uk'], box: [-25, 42, 180, 75] },
  { name: 'Азия и Тихий океан', regions: ['china', 'japan', 'korea', 'taiwan', 'india', 'asia'], box: [63, -50, 180, 42] },
  { name: 'Африка', regions: ['africa'], box: [-20, -36, 52, 37] },
  { name: 'Америка', regions: ['us', 'usa', 'canada', 'latam', 'americas'], box: [-170, -56, -30, 75] },
];
const THEMES = ['dark', 'amber', 'light'];
const THEME_KEY = 'bansho-terminal-theme';
const REFRESH_MS = 5 * 60_000;

const conflicts: Marker[] = CONFLICT_ZONES.map(zone => ({
  kind: 'conflict', title: zone.name, url: '', lon: zone.center[0], lat: zone.center[1], time: null, magnitude: null,
}));

const MARKET_CATALOGS = {
  exchange: STOCK_EXCHANGES,
  'financial-center': FINANCIAL_CENTERS,
  'central-bank': CENTRAL_BANKS,
  'commodity-hub': COMMODITY_HUBS,
};
const MARKET_CATALOG_SOURCE = 'https://github.com/koala73/worldmonitor/blob/2ca7dd20316fafe6f9c567697a9df8503470c4a5/src/config/finance-geo.ts';

interface MarketLocation extends Marker {
  id: string;
  kind: MarketMarkerKind;
  city: string;
  country: string;
}

const marketCatalogs = (Object.keys(MARKET_CATALOGS) as MarketMarkerKind[]).map(kind => ({
  kind,
  locations: MARKET_CATALOGS[kind].map(({ id, name, city, country, lat, lon }): MarketLocation => ({
    id: `${kind}:${id}`, kind, title: name, city, country, lat, lon, url: '', time: null, magnitude: null,
  })),
}));
const marketLocationsById = new Map(marketCatalogs.flatMap(({ locations }) => locations.map(item => [item.id, item] as const)));

const data: {
  world: Story[] | null; windowHours: number; wire: Story[] | null; quotes: Quote[] | null;
  quakes: Marker[] | null; natural: Marker[] | null; publishers: Map<Source, string[]>;
} = { world: null, windowHours: 72, wire: null, quotes: null, quakes: null, natural: null, publishers: new Map() };
const status = new Map<Source, 'loading' | 'ok' | 'failed'>();

let view: View = 'overview';
let selected = 0;
let marketLocation = marketCatalogs[0]!.locations[0]!;
let tickerIndex = 0;
let help = false;
/** What the arrow keys move through on the current view. */
let rows: Array<{ url: string; marker?: Marker }> = [];

type Child = Node | string | null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children.filter((child): child is Node | string => child !== null));
  return node;
}

function panel(title: string, className: string, note: string, ...children: Child[]): HTMLElement {
  return el('section', `t-panel ${className}`,
    el('header', 't-head', el('h2', '', title), el('span', 't-dim', note)),
    el('div', 't-body', ...children));
}

function missing(source: Source): HTMLElement {
  return el('p', 't-dim', status.get(source) === 'failed' ? 'нет данных' : 'загрузка…');
}

function age(time: number): string {
  if (!time) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} ч`;
  return `${Math.round(minutes / 1440)} дн`;
}

const number = (value: number, digits = 2) => value.toLocaleString('ru-RU', { maximumFractionDigits: digits });

function changeText(quote: Quote): string {
  if (quote.change === null) return '—';
  const sign = quote.change > 0 ? '+' : '';
  return `${sign}${number(quote.change)}${quote.unit === 'bp' ? ' б.п.' : '%'}`;
}

const tone = (value: number | null) => (value === null || value === 0 ? '' : value > 0 ? 't-up' : 't-down');

function open(url: string): void {
  if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
}

/** A selectable row: registers itself with the keyboard cursor. */
function row(url: string, marker: Marker | undefined, ...children: Child[]): HTMLElement {
  const index = rows.push({ url, marker }) - 1;
  const node = el('li', `t-row${index === selected ? ' t-selected' : ''}`, ...children);
  node.addEventListener('click', () => {
    if (selected === index) open(url);
    selected = index;
    render();
  });
  return node;
}

function storyList(stories: Story[]): HTMLElement {
  return el('ol', 't-list', ...stories.map((story, i) => row(story.url, undefined,
    el('span', 't-rank', String(i + 1).padStart(2, '0')),
    el('span', 't-title', story.title),
    el('span', 't-dim t-meta', `${story.sources} ист. · ${age(story.time)}`))));
}

function markerList(markers: Marker[]): HTMLElement {
  return el('ol', 't-list', ...markers.map(marker => row(marker.url, marker,
    el('span', `t-rank t-${marker.kind}`, marker.magnitude === null ? MARKER_STYLE[marker.kind].glyph : `M${marker.magnitude.toFixed(1)}`),
    el('span', 't-title', marker.title),
    el('span', 't-dim t-meta', marker.time ? age(marker.time) : 'справ.'))));
}

function sparkline(series: number[], change: number | null): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 24');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', `t-spark ${tone(change)}`);
  const values = series.slice(-30);
  if (values.length < 2) return svg;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${22 - ((v - min) / span) * 20}`).join(' ');
  const area = document.createElementNS(ns, 'polygon');
  area.setAttribute('points', `0,24 ${points} 100,24`);
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', points);
  svg.append(area, line);
  return svg;
}

function marketsPanel(full: boolean): HTMLElement {
  const quotes = data.quotes
    ? (full ? data.quotes : OVERVIEW_SYMBOLS.flatMap(symbol => data.quotes!.filter(q => q.symbol === symbol)))
    : null;
  const table = quotes && el('table', 't-table',
    el('thead', '', el('tr', '', ...['Инструмент', 'Цена', 'День', '30 сессий'].map(h => el('th', '', h)))),
    el('tbody', '', ...quotes.map(quote => {
      const url = `https://finance.yahoo.com/quote/${encodeURIComponent(quote.symbol)}`;
      const tr = el('tr', '',
        el('td', '', full ? `${quote.name} · ${quote.symbol}` : quote.name),
        el('td', 't-num', number(quote.price, quote.price < 10 ? 4 : 2)),
        el('td', `t-num ${tone(quote.change)}`, changeText(quote)),
        el('td', '', sparkline(quote.series, quote.change)));
      if (full) {
        const index = rows.push({ url }) - 1;
        if (index === selected) tr.className = 't-selected';
        tr.addEventListener('click', () => { if (selected === index) open(url); selected = index; render(); });
      }
      return tr;
    })));
  return panel('Рынки', 't-markets', 'дневное изменение', table || missing('quotes'));
}

/** A summary assembled by fixed rules from the loaded headlines and figures. */
function briefPanel(): HTMLElement {
  const lines: HTMLElement[] = [];
  const stories = data.world;
  if (stories) {
    const [first, second, third] = stories;
    lines.push(el('p', '', `За ${data.windowHours} ч отобрано сюжетов: ${stories.length}.`));
    if (first) lines.push(el('p', '', `Главный (${first.sources} ист.): ${first.title}`));
    const next = [second, third].filter((s): s is Story => !!s).map(s => s.title);
    if (next.length) lines.push(el('p', '', `Далее: ${next.join(' · ')}`));
    const topics = new Map<string, number>();
    for (const s of stories) if (s.typeLabel) topics.set(s.typeLabel, (topics.get(s.typeLabel) ?? 0) + 1);
    if (topics.size) lines.push(el('p', '', `Темы: ${[...topics].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} — ${n}`).join(', ')}.`));
  } else lines.push(missing('world'));
  const strongest = data.quakes?.[0];
  if (strongest) lines.push(el('p', '', `Сильнейший толчок за сутки: M${strongest.magnitude?.toFixed(1)}, ${strongest.title}.`));
  const mover = data.quotes?.filter(q => q.unit !== 'bp' && q.change !== null)
    .sort((a, b) => Math.abs(b.change!) - Math.abs(a.change!))[0];
  if (mover) lines.push(el('p', '', `Самое крупное дневное движение: ${mover.name} ${changeText(mover)}.`));
  return panel('Сводка по миру', 't-brief', 'по правилам из заголовков и котировок', ...lines);
}

const visibleKinds = (): MarkerKind[] => (view === 'conflict' ? ['conflict'] : view === 'hazard' ? ['quake', 'hazard', 'fire'] : ['conflict', 'hazard', 'fire', 'quake']);

function allMarkers(): Marker[] {
  // Draw order: quakes last so they stay on top.
  const all = [...(data.natural ?? []), ...conflicts, ...(data.quakes ?? [])];
  return all.filter(marker => visibleKinds().includes(marker.kind));
}

function mapPanel(): HTMLElement {
  const count = (kind: MarkerKind): string => {
    if (kind === 'conflict') return String(conflicts.length);
    const source = kind === 'quake' ? data.quakes : data.natural;
    return source ? String(source.filter(m => m.kind === kind).length) : 'нет данных';
  };
  const legend = el('ul', 't-legend',
    ...visibleKinds().map(kind => el('li', '', el('b', `t-${kind}`, MARKER_STYLE[kind].glyph), ` ${MARKER_STYLE[kind].label}: ${count(kind)}`)),
    ...(view === 'overview' ? ['волнения', 'кибер', 'сбои связи'].map(name => el('li', 't-dim', `· ${name}: нет данных`)) : []));
  return panel('Глобальная обстановка', 't-map', 'USGS 24 ч · NASA EONET 30 дн · конфликты: справочный слой',
    el('div', 't-canvas', el('canvas')), legend);
}

function marketLocationLabel({ title, city, country }: MarketLocation): string {
  const place = title === city ? country : `${city}, ${country}`;
  return `${title} · ${place}`;
}

function createMarketPicker(): HTMLSelectElement {
  const picker = el('select');
  picker.id = 't-market-location';
  for (const { kind, locations } of marketCatalogs) {
    const group = el('optgroup');
    group.label = MARKER_STYLE[kind].label;
    for (const location of locations) {
      const option = el('option', '', marketLocationLabel(location));
      option.value = location.id;
      group.append(option);
    }
    picker.append(group);
  }
  picker.value = marketLocation.id;
  picker.addEventListener('change', () => {
    const location = marketLocationsById.get(picker.value);
    if (!location) return;
    marketLocation = location;
    render();
  });
  return picker;
}

function marketMapPanel(): HTMLElement {
  const source = el('a', '', 'Источник');
  source.href = MARKET_CATALOG_SOURCE;
  source.target = '_blank';
  source.rel = 'noopener noreferrer';
  const canvas = el('canvas');
  const { kind } = marketLocation;
  const { label, glyph } = MARKER_STYLE[kind];
  const count = MARKET_CATALOGS[kind].length;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${label}, ${count}. Выбран объект ${marketLocationLabel(marketLocation)}`);

  return panel('Карта рынков', 't-map t-market-map', 'справочные данные',
    el('label', 't-market-location', el('span', '', 'Объект'), marketPicker),
    el('div', 't-canvas', canvas),
    el('ul', 't-legend', el('li', '', el('b', `t-${kind}`, glyph), ` ${label} · ${count}`), el('li', '', source)));
}

function postureMarkup(): HTMLElement {
  const inBox = (m: Marker, [w, s, e, n]: [number, number, number, number]) => m.lon >= w && m.lon <= e && m.lat >= s && m.lat <= n;
  const counts = THEATERS.map(theater => ({
    theater,
    stories: data.world ? data.world.filter(s => s.regions.some(r => theater.regions.includes(r))).length : null,
    conflicts: conflicts.filter(m => inBox(m, theater.box)).length,
    quakes: data.quakes ? data.quakes.filter(m => inBox(m, theater.box)).length : null,
    natural: data.natural ? data.natural.filter(m => inBox(m, theater.box)).length : null,
  }));
  const top = Math.max(1, ...counts.map(c => c.stories ?? 0));
  const cell = (value: number | null) => el('td', 't-num', value === null ? 'нет данных' : String(value));
  return panel('Обстановка по театрам', 't-posture', 'количество, не оценка риска', el('table', 't-table',
    el('thead', '', el('tr', '', ...['Театр', 'Сюжеты', '', 'Конфл. зоны', 'Толчки', 'Стихия'].map(h => el('th', '', h)))),
    el('tbody', '', ...counts.map(c => {
      const bar = el('i', 't-bar');
      bar.style.width = `${((c.stories ?? 0) / top) * 100}%`;
      return el('tr', '', el('td', '', c.theater.name), cell(c.stories), el('td', 't-barcell', bar), cell(c.conflicts), cell(c.quakes), cell(c.natural));
    }))));
}

function body(): HTMLElement {
  if (view === 'markets') return el('main', 't-grid t-market-grid', marketMapPanel(), marketsPanel(true));
  if (view === 'news') {
    return el('main', 't-grid t-news',
      panel('Лента', 't-feed', 'новые сверху', data.wire ? storyList(data.wire) : missing('wire')),
      el('div', 't-column', briefPanel()));
  }
  let side: HTMLElement[];
  if (view === 'conflict') {
    const stories = data.world?.filter(s => s.type === 'conflict');
    side = [panel('Сюжеты о конфликтах', 't-top', 'по важности', stories ? storyList(stories) : missing('world'))];
  } else if (view === 'hazard') {
    side = [
      panel('Землетрясения M2.5+', 't-top', '24 часа, USGS', data.quakes ? markerList(data.quakes.slice(0, 40)) : missing('quakes')),
      panel('Природные события', 't-top', 'NASA EONET', data.natural ? markerList(data.natural.slice(0, 40)) : missing('natural')),
    ];
  } else {
    side = [
      briefPanel(),
      panel('Главные сюжеты', 't-top', 'источники · давность', data.world ? storyList(data.world.slice(0, 12)) : missing('world')),
      marketsPanel(false),
    ];
  }
  return el('main', 't-grid', el('div', 't-column t-left', mapPanel(), postureMarkup()), el('div', 't-column', ...side));
}

function liveState(): [string, string] {
  const values = (['world', 'wire', 'quotes', 'quakes', 'natural'] as Source[]).map(s => status.get(s));
  // Everything answering needs no badge: only trouble is announced.
  if (values.every(v => v === 'ok')) return ['', 't-dim'];
  if (values.includes('ok')) return ['● ЧАСТИЧНО', 't-quake'];
  if (values.includes('loading')) return ['○ ПОДКЛЮЧЕНИЕ', 't-dim'];
  return ['○ НЕТ СВЯЗИ', 't-down'];
}

const clock = el('span', 't-clock');
const ticker = el('span', 't-ticker-text');
const marketPicker = createMarketPicker();

function tick(): void {
  clock.textContent = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function showTicker(): void {
  const stories = data.wire;
  if (!stories?.length) {
    ticker.textContent = status.get('wire') === 'failed' ? 'нет данных' : 'загрузка…';
    return;
  }
  const story = stories[tickerIndex % stories.length]!;
  ticker.textContent = `${age(story.time)} · ${story.title}`;
}

function button(label: string, action: () => void, className = 't-button'): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

const root = document.getElementById('terminal')!;

function render(): void {
  const scroll = [...root.querySelectorAll('.t-body')].map(node => node.scrollTop);
  const previousView = root.dataset.view;
  const marketPickerFocused = document.activeElement === marketPicker;
  rows = [];
  const [live, liveClass] = liveState();
  const publishers = new Set([...data.publishers.values()].flat());
  const main = body();
  const helpBox = help ? el('div', 't-help', panel('Клавиши', '', '? — закрыть', el('dl', '',
    ...[['1–5, Tab', 'переключить вид'], ['↑ ↓ / j k', 'двигаться по списку'], ['Enter, o', 'открыть выбранное в новой вкладке'],
      ['f', 'выбрать объект на карте рынков'], ['t', 'сменить тему'], ['r', 'обновить данные'], ['?', 'эта справка'], ['q, Esc', 'выйти на дашборд']]
      .flatMap(([key, label]) => [el('dt', '', key!), el('dd', '', label!)])))) : null;

  root.replaceChildren(
    el('header', 't-top-bar',
      el('strong', '', 'MONEY BANSHO'), el('span', 't-dim', 'режим: терминал'), el('span', liveClass, live),
      el('span', 't-dim', `источников новостей: ${publishers.size || 'нет данных'}`), clock,
      button('q выход', quit)),
    el('nav', 't-tabs', ...VIEWS.map((v, i) => button(`${i + 1}:${v.label}`, () => setView(v.id), `t-tab${v.id === view ? ' active' : ''}`))),
    main,
    el('div', 't-ticker', el('b', '', 'ЛЕНТА '), ticker),
    el('footer', 't-keys', `1–5 виды · ↑↓ выбор · Enter открыть · ${view === 'markets' ? 'f карта · ' : ''}t тема · r обновить · ? справка · q выход`),
    ...(helpBox ? [helpBox] : []),
  );
  root.dataset.view = view;
  if (selected >= rows.length && rows.length) {
    selected = rows.length - 1;
    render();
    return;
  }
  if (previousView === view) root.querySelectorAll('.t-body').forEach((node, i) => { node.scrollTop = scroll[i] ?? 0; });
  if (marketPickerFocused && view === 'markets') marketPicker.focus({ preventScroll: true });
  else root.querySelector('.t-selected')?.scrollIntoView({ block: 'nearest' });
  showTicker();
  paintMap();
}

function paintMap(): void {
  const canvas = root.querySelector<HTMLCanvasElement>('.t-canvas canvas');
  if (!canvas) return;
  if (view === 'markets') {
    const catalog = marketCatalogs.find(({ kind }) => kind === marketLocation.kind);
    drawMap(canvas, catalog?.locations ?? [], marketLocation);
  } else {
    drawMap(canvas, allMarkers(), rows[selected]?.marker ?? null);
  }
}

function setView(next: View): void {
  view = next;
  selected = 0;
  render();
}

function setTheme(theme: string): void {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* the theme lasts for this page */ }
}

function quit(): void {
  window.location.assign('/dashboard');
}

function load<T>(source: Source, request: () => Promise<T>, apply: (value: T) => void): void {
  if (status.get(source) !== 'ok') status.set(source, 'loading');
  request().then((value) => {
    apply(value);
    status.set(source, 'ok');
  }).catch((error: unknown) => {
    console.warn(`[terminal] ${source}`, error);
    status.set(source, 'failed');
  }).finally(render);
}

function refresh(): void {
  load('world', loadWorld, (v) => { data.world = v.stories; data.windowHours = v.windowHours; });
  load('wire', loadWire, (v) => { data.wire = v.stories; data.publishers.set('wire', v.publishers); });
  load('digest', loadDigestPublishers, (v) => { data.publishers.set('digest', v); });
  load('quotes', loadQuotes, (v) => { data.quotes = v; });
  load('quakes', loadQuakes, (v) => { data.quakes = v; });
  load('natural', loadNaturalEvents, (v) => { data.natural = v; });
}

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target === marketPicker) return;
  if (event.key === 'Enter' && event.target instanceof HTMLAnchorElement) return;
  // `code` keeps the letter keys working on a Russian keyboard layout.
  const { key, code } = event;
  const digit = Number(key);
  if (digit >= 1 && digit <= VIEWS.length) setView(VIEWS[digit - 1]!.id);
  else if (key === 'Tab') {
    const step = event.shiftKey ? VIEWS.length - 1 : 1;
    setView(VIEWS[(VIEWS.findIndex(v => v.id === view) + step) % VIEWS.length]!.id);
  } else if (key === 'ArrowDown' || code === 'KeyJ') {
    selected = Math.min(selected + 1, Math.max(0, rows.length - 1));
    render();
  } else if (key === 'ArrowUp' || code === 'KeyK') {
    selected = Math.max(0, selected - 1);
    render();
  } else if (key === 'Enter' || code === 'KeyO') {
    open(rows[selected]?.url ?? '');
  } else if (code === 'KeyF' && view === 'markets') {
    marketPicker.focus();
  } else if (code === 'KeyT') {
    setTheme(THEMES[(THEMES.indexOf(document.documentElement.dataset.theme ?? '') + 1) % THEMES.length]!);
    paintMap();
  } else if (code === 'KeyR') refresh();
  else if (key === '?' || (code === 'Slash' && event.shiftKey) || key === 'F1') {
    help = !help;
    render();
  } else if (key === 'Escape' && help) {
    help = false;
    render();
  } else if (key === 'Escape' || code === 'KeyQ') quit();
  else return;
  event.preventDefault();
});

let storedTheme: string | null = null;
try { storedTheme = localStorage.getItem(THEME_KEY); } catch { /* default theme */ }
setTheme(storedTheme && THEMES.includes(storedTheme) ? storedTheme : 'dark');
new ResizeObserver(() => paintMap()).observe(root);
window.addEventListener('resize', paintMap);
setInterval(tick, 1000);
setInterval(() => { tickerIndex += 1; showTicker(); }, 8000);
setInterval(refresh, REFRESH_MS);
tick();
render();
void loadLand().then(paintMap).catch((error: unknown) => console.warn('[terminal] land', error));
refresh();
