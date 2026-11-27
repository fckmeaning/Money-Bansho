// Money Bansho company dossier: state, routing (?symbol=&range=), polling and
// layout. With no symbol in the URL the live wire (or ?view=screener) is shown;
// a company has the tabs of COMPANY_VIEWS in ?view=.
import { mountBanshoMenu } from '../shell/bansho-menu';
import { metricsView, screenerView } from './analytics';
import { ApiError, createPoller, fetchBoard, fetchDossier, fetchWire } from './api';
import { renderChart } from './chart';
import type { Chart } from './chart';
import { SYMBOL_RE, companies, createCompanyList } from './companies';
import { h, tickAges } from './dom';
import { eventsView, processView } from './events';
import { forecastView } from './forecast';
import { rangeName, setUiLang, t, uiLang } from './i18n';
import {
  TIMELINE_PAGE,
  empty,
  leadershipPanel,
  movesPanel,
  openedPanel,
  panel,
  quoteHeader,
  reputationPanel,
  sourceIssues,
  timelinePanel,
} from './panels';
import { modelView } from './model';
import { signalPlate } from './plate';
import { COMPANY_VIEWS, RANGES } from './types';
import type { Board, CompanyView, Dossier, EventType, Range, Wire, WireEvent } from './types';
import { moversPanel, radarPanel, wireFeed, wireKey } from './wire';

const DOSSIER_MS = 20_000;
const BOARD_MS = 30_000;
const WIRE_MS = 30_000;
const SOURCE_URL = 'https://github.com/fckmeaning/Money-Bansho';
const UPSTREAM_URL = 'https://github.com/koala73/worldmonitor';

const state = {
  symbol: null as string | null,
  view: 'overview' as CompanyView,
  screener: false,
  range: '3mo' as Range,
  query: '',
  region: 'all',
  menuOpen: false,
  types: new Set<EventType>(),
  limit: TIMELINE_PAGE,
  selectedId: null as string | null,
  /** Headline clicked in the wire, to be located once its dossier arrives. */
  opened: null as WireEvent | null,
  openedPending: false,
  board: null as Board | null,
  boardError: null as ApiError | null,
  dossier: null as Dossier | null,
  dossierError: null as ApiError | null,
  /** A newly chosen range is still loading. */
  rangePending: false,
  wire: null as Wire | null,
  wireError: null as ApiError | null,
  newIds: new Set<string>(),
  wireNewIds: new Set<string>(),
};

const cache = new Map<string, Dossier>();
const seen = new Map<string, Set<string>>();
let wireSeen: Set<string> | null = null;
let poller: { refresh(): void; stop(): void } | null = null;
let chart: Chart | null = null;
let chartWidth = 0;

// ---- shell ----------------------------------------------------------------

const root = document.getElementById('app') as HTMLElement;
const header = h('header', { class: 'topbar' });
const sidebar = h('aside', { class: 'sidebar' });
const status = h('div', { class: 'status', role: 'status' });
const head = h('div', { class: 'slot slot-head' });
const chartHead = h('header', { class: 'panel-head' });
const chartBody = h('div', { class: 'chart-body' });
const chartPanel = h('section', { class: 'panel slot slot-chart' }, chartHead, chartBody);
const feed = h('div', { class: 'slot slot-feed' });
const tabs = h('nav', { class: 'tabs' });
const viewSlot = h('div', { class: 'slot slot-view' });
const center = h('div', { class: 'center' }, status, head, tabs, chartPanel, viewSlot, feed);
/** What the tab slot currently shows; it is rebuilt only on request. */
let shown: { key: string; data: string } | null = null;
let disposeScreener: (() => void) | null = null;
let menuButton: { key: string; node: HTMLElement } | null = null;
const rail = h('aside', { class: 'rail' });
const main = h('main', { class: 'main' }, center, rail);
const footer = h('footer', { class: 'footer' });
root.replaceChildren(header, h('div', { class: 'body' }, sidebar, main), footer);

const companyList = createCompanyList(
  sidebar,
  () => ({
    query: state.query,
    region: state.region,
    symbol: state.symbol,
    board: state.board,
    boardFailed: state.boardError !== null,
  }),
  {
    setQuery(query) {
      state.query = query;
      companyList.render();
    },
    setRegion(region) {
      state.region = region;
      companyList.render();
    },
    open: (symbol) => navigate(symbol),
  },
);

function renderChrome(): void {
  document.documentElement.lang = uiLang();
  document.title = `${state.symbol ?? t(state.screener ? 'screener' : 'liveWire')} · Money Bansho`;
  const active = state.symbol ? 'dossier' : state.screener ? 'screener' : 'wire';
  const menuKey = `${active}|${uiLang()}`;
  if (menuButton?.key !== menuKey) menuButton = { key: menuKey, node: mountBanshoMenu({ active, lang: uiLang() }) };
  header.replaceChildren(
    menuButton.node,
    h(
      'button',
      {
        type: 'button',
        class: 'menu',
        'aria-expanded': String(state.menuOpen),
        onclick: () => {
          state.menuOpen = !state.menuOpen;
          renderChrome();
        },
      },
      t('companies'),
    ),
    h('a', { class: 'brand', href: location.pathname, onclick: internal(null) }, 'Money Bansho'),
    h('span', { class: 'subtitle' }, t('subtitle')),
    h(
      'nav',
      {},
      h(
        'a',
        { href: location.pathname, 'aria-current': state.symbol || state.screener ? null : 'page', onclick: internal(null) },
        t('liveWire'),
      ),
      h(
        'a',
        { href: `${location.pathname}?view=screener`, 'aria-current': state.screener ? 'page' : null, onclick: internal(null, true) },
        t('screener'),
      ),
      h('a', { href: '/dashboard' }, t('dashboard')),
      h(
        'div',
        { class: 'segment', role: 'group', 'aria-label': 'Language' },
        ...(['en', 'ru'] as const).map((lang) =>
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(uiLang() === lang),
              onclick: () => {
                setUiLang(lang);
                companyList.relabel();
                renderAll();
              },
            },
            lang.toUpperCase(),
          ),
        ),
      ),
    ),
  );
  sidebar.classList.toggle('open', state.menuOpen);
  const external = (href: string, text: string) =>
    h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  footer.replaceChildren(
    h('span', {}, external(SOURCE_URL, t('source')), ' (AGPL-3.0)'),
    h('span', {}, `${t('basedOn')} `, external(UPSTREAM_URL, 'World Monitor')),
    h('span', {}, t('disclaimer')),
  );
}

/** Plain left-clicks navigate in place; modified clicks keep browser behaviour. */
function internal(symbol: string | null, screener = false) {
  return (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(symbol, null, screener);
  };
}

function errorText(error: ApiError): string {
  if (error.status === 400) return t('errSymbol', { detail: error.detail || String(error.status) });
  if (error.detail === 'timeout') return t('errTimeout');
  if (error.detail === 'invalid-response') return t('errInvalid');
  if (error.status === 0) return t('errNetwork');
  return `${t('errHttp', { status: error.status })}${error.detail ? ` ${error.detail}` : ''}`;
}

const retry = () => h('button', { type: 'button', class: 'retry', onclick: () => poller?.refresh() }, t('retry'));

function errorPanel(error: ApiError): HTMLElement {
  return panel(
    t('loadFailed'),
    null,
    h('div', { class: 'empty error' }, h('span', {}, errorText(error)), retry()),
  );
}

function renderStatus(): void {
  const data = state.symbol ? state.dossier : state.wire;
  const error = state.symbol ? state.dossierError : state.wireError;
  const issues = data ? sourceIssues(data.errors) : null;
  const wasOpen = status.querySelector('details')?.open;
  if (issues && wasOpen) issues.setAttribute('open', '');
  status.replaceChildren(
    ...(data && error
      ? [h('div', { class: 'banner' }, h('span', {}, `${t('stale')} ${errorText(error)}`), retry())]
      : []),
    ...(issues ? [issues] : []),
  );
}

/** Replaces content while keeping keyboard focus on the equivalent control. */
function swap(host: HTMLElement, ...children: (Node | null)[]): void {
  const key = host.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : null;
  host.replaceChildren(...children.filter((c): c is Node => c !== null));
  if (key) host.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

// ---- company tabs ---------------------------------------------------------

function setView(view: CompanyView): void {
  if (view === state.view) return;
  state.view = view;
  writeUrl(true);
  renderView();
}

function renderTabs(): void {
  tabs.hidden = !state.symbol;
  swap(
    tabs,
    ...(state.symbol ? COMPANY_VIEWS : []).map((view) =>
      h(
        'button',
        {
          type: 'button',
          'data-key': `tab-${view}`,
          'aria-current': state.view === view ? 'page' : null,
          onclick: () => setView(view),
        },
        t(`tab_${view}`),
      ),
    ),
  );
}

function buildTab(data: Dossier): HTMLElement {
  const lang = uiLang();
  switch (state.view) {
    case 'events':
      return eventsView(data.raw, {
        lang,
        selectedId: state.selectedId,
        onSelect: (id) => {
          state.selectedId = id;
        },
      });
    case 'forecast':
      return forecastView(data.raw, {
        lang,
        selectedId: state.selectedId,
        onSelect: (id) => {
          state.selectedId = id;
        },
      });
    case 'metrics':
      return metricsView(data.metrics, lang);
    case 'process':
      return processView(data.raw, { lang });
    default:
      return modelView(data, (id) => {
        state.selectedId = id;
        setView('events');
      });
  }
}

/**
 * A tab is drawn once and then left alone, so filters, scroll position and open
 * details survive polling. Newer data is offered, never forced on the reader.
 */
function renderTab(data: Dossier): void {
  const key = `${data.symbol}|${state.view}|${uiLang()}`;
  const version = JSON.stringify([data.events.map((e) => e.id), data.history[data.history.length - 1]?.t]);
  if (shown?.key === key) {
    const banner = viewSlot.querySelector<HTMLElement>(':scope > .newer');
    if (banner) banner.hidden = shown.data === version;
    return;
  }
  shown = { key, data: version };
  let body: HTMLElement;
  try {
    body = buildTab(data);
  } catch (error) {
    console.error('[dossier] view failed', error);
    body = panel(t(`tab_${state.view}`), null, empty(t('viewFailed')));
  }
  const update = h(
    'button',
    {
      type: 'button',
      class: 'retry',
      onclick: () => {
        shown = null;
        renderView();
      },
    },
    t('retry'),
  );
  const banner = h('div', { class: 'banner newer' }, h('span', {}, t('newData')), update);
  banner.hidden = true;
  viewSlot.replaceChildren(banner, body);
}

// ---- company view ---------------------------------------------------------

function toggleType(type: EventType | null): void {
  if (type === null) state.types.clear();
  else if (!state.types.delete(type)) state.types.add(type);
  state.limit = TIMELINE_PAGE;
  renderView();
}

function showLeadership(): void {
  state.types = new Set<EventType>(['leadership']);
  state.limit = TIMELINE_PAGE;
  renderView();
  feed.scrollIntoView({ block: 'start' });
}

function selectEvent(id: string): void {
  const data = state.dossier;
  const index = data?.events.findIndex((e) => e.id === id) ?? -1;
  if (!data || index < 0) return;
  const event = data.events[index] as Dossier['events'][number];
  const filteredOut = state.types.size > 0 && !state.types.has(event.type);
  if (filteredOut) state.types.clear();
  const visible = state.types.size ? data.events.filter((e) => state.types.has(e.type)) : data.events;
  const position = visible.findIndex((e) => e.id === id);
  const beyond = position >= state.limit;
  if (beyond) state.limit = position + 10;
  state.selectedId = id;
  state.newIds.delete(id);
  if (filteredOut || beyond) renderView();
  else {
    chart?.select(id);
    for (const row of feed.querySelectorAll<HTMLElement>('.row[data-event]')) {
      const match = row.dataset.event === id;
      row.classList.toggle('selected', match);
      if (match) row.classList.remove('fresh');
    }
  }
  scrollToRow(id);
}

function scrollToRow(id: string): void {
  const row = feed.querySelector<HTMLElement>(`.row[data-event="${CSS.escape(id)}"]`);
  if (!row) return;
  // Only scroll when the row is off screen, so the chart stays put when possible.
  const box = row.getBoundingClientRect();
  const bounds = center.getBoundingClientRect();
  const top = Math.max(0, bounds.top);
  const bottom = Math.min(window.innerHeight, getComputedStyle(center).overflowY === 'auto' ? bounds.bottom : window.innerHeight);
  if (box.top < top || box.bottom > bottom) row.scrollIntoView({ block: 'nearest' });
}

function hoverRows(ids: string[]): void {
  for (const row of feed.querySelectorAll<HTMLElement>('.row[data-event]')) {
    row.classList.toggle('linked', ids.includes(row.dataset.event ?? ''));
  }
}

function renderChartPanel(): void {
  const data = state.dossier;
  swap(
    chartHead,
    h('h2', {}, t('priceTitle')),
    h(
      'div',
      { class: 'segment mono', role: 'group' },
      ...RANGES.map((range) =>
        h(
          'button',
          {
            type: 'button',
            'data-key': `range-${range}`,
            'aria-pressed': String(state.range === range),
            onclick: () => setRange(range),
          },
          rangeName(range),
        ),
      ),
    ),
  );
  chart = null;
  chartWidth = Math.floor(chartBody.clientWidth);
  if (!data || state.rangePending) {
    chartBody.replaceChildren(
      h(
        'div',
        { class: 'empty chart-empty' },
        state.dossierError ? t('noData') : t('loadingSymbol', { symbol: state.symbol ?? '' }),
      ),
    );
    return;
  }
  chart = renderChart(chartBody, {
    symbol: data.symbol,
    history: data.history,
    events: data.events,
    activeTypes: state.types,
    selectedId: state.selectedId,
    onHover: hoverRows,
    onSelect: selectEvent,
    onType: toggleType,
  });
}

function renderCompany(): void {
  const data = state.dossier;
  if (state.view !== 'overview') {
    chartPanel.hidden = true;
    chartBody.replaceChildren();
    chart = null;
    swap(feed);
    swap(rail);
    if (data) {
      swap(head, quoteHeader(data));
      renderTab(data);
    } else {
      shown = null;
      viewSlot.replaceChildren();
      swap(head, state.dossierError ? errorPanel(state.dossierError) : panel(state.symbol ?? '', null, empty(t('loading'))));
    }
    return;
  }
  shown = null;
  viewSlot.replaceChildren();
  chartPanel.hidden = !data && state.dossierError !== null;
  renderChartPanel();
  if (!data) {
    const loading = () => empty(t('loading'));
    if (state.dossierError) {
      swap(head, errorPanel(state.dossierError));
      swap(feed);
      swap(rail);
    } else {
      swap(head, panel(state.symbol ?? '', null, loading()));
      swap(feed, panel(t('timeline'), null, loading()));
      swap(rail, panel(t('reputation'), null, loading()), panel(t('leadership'), null, loading()));
    }
    return;
  }
  const opened = state.opened;
  swap(
    head,
    quoteHeader(data),
    signalPlate(data, () => setView('model')),
    opened && !findOpened(data, opened) ? openedPanel(opened) : null,
  );
  swap(
    feed,
    timelinePanel({
      data,
      activeTypes: state.types,
      selectedId: state.selectedId,
      newIds: state.newIds,
      limit: state.limit,
      onToggle: toggleType,
      onSelect: selectEvent,
      onHover: (id) => chart?.hover(id ? [id] : []),
      onMore: () => {
        state.limit += TIMELINE_PAGE;
        renderView();
      },
    }),
  );
  swap(
    rail,
    reputationPanel(data, selectEvent),
    leadershipPanel(data, selectEvent, showLeadership),
    state.rangePending ? panel(t('movesTitle'), null, empty(t('loading'))) : movesPanel(data, selectEvent),
  );
}

// ---- wire view ------------------------------------------------------------

function renderMovers(): HTMLElement {
  return moversPanel(state.board, companies, state.boardError === null, (symbol) => navigate(symbol));
}

function renderWire(): void {
  chartPanel.hidden = true;
  chartBody.replaceChildren();
  chart = null;
  swap(head);
  const data = state.wire;
  if (!data) {
    swap(
      feed,
      state.wireError ? errorPanel(state.wireError) : panel(t('latest'), null, empty(t('loading'))),
    );
    swap(rail, renderMovers());
    return;
  }
  const options = {
    data,
    activeTypes: state.types,
    newIds: state.wireNewIds,
    limit: state.limit,
    onToggle: toggleType,
    onMore: () => {
      state.limit += TIMELINE_PAGE;
      renderView();
    },
    onOpen: (event: WireEvent) => navigate(event.symbol, event),
  };
  swap(feed, wireFeed(options));
  swap(rail, radarPanel(options), renderMovers());
}

function renderScreener(): void {
  chartPanel.hidden = true;
  chartBody.replaceChildren();
  chart = null;
  swap(head);
  swap(feed);
  swap(rail);
  const key = `screener|${uiLang()}`;
  if (shown?.key === key) return;
  disposeScreener?.();
  shown = { key, data: '' };
  const view = screenerView({ lang: uiLang(), onSelect: (symbol) => navigate(symbol) });
  disposeScreener = view.dispose;
  viewSlot.replaceChildren(view.el);
}

function renderView(): void {
  const wide = state.screener || (state.symbol !== null && state.view !== 'overview');
  main.classList.toggle('wire', !state.symbol && !state.screener);
  main.classList.toggle('full', wide);
  if (!state.screener && disposeScreener) {
    disposeScreener();
    disposeScreener = null;
    shown = null;
    viewSlot.replaceChildren();
  }
  renderTabs();
  renderStatus();
  if (state.symbol) renderCompany();
  else if (state.screener) renderScreener();
  else {
    shown = null;
    viewSlot.replaceChildren();
    renderWire();
  }
}

function renderAll(): void {
  renderChrome();
  companyList.render();
  renderView();
}

// ---- data -----------------------------------------------------------------

/** Everything except the timestamp, to skip re-rendering unchanged data. */
const signature = (data: Dossier | Wire) =>
  // The raw response and the model blocks carry timings that differ on every poll.
  JSON.stringify({ ...data, updatedAt: 0, raw: undefined, metrics: undefined, quant: undefined });

function refreshUpdated(host: ParentNode, updatedAt: number): void {
  for (const node of host.querySelectorAll<HTMLElement>('[data-since]')) node.dataset.since = String(updatedAt);
  tickAges(host);
}

function onDossier(data: Dossier, key: string, first: boolean): void {
  state.rangePending = false;
  const previous = state.dossier;
  const known = seen.get(state.symbol ?? '') ?? new Set<string>();
  // Only arrivals during polling are marked; the first load of a range is not news.
  if (!first) for (const event of data.events) if (!known.has(event.id)) state.newIds.add(event.id);
  for (const event of data.events) known.add(event.id);
  seen.set(state.symbol ?? '', known);
  cache.set(key, data);
  const recovered = state.dossierError !== null;
  state.dossier = data;
  state.dossierError = null;
  if (previous && !recovered && signature(previous) === signature(data)) refreshUpdated(head, data.updatedAt);
  else renderView();
  if (state.openedPending && state.opened) {
    state.openedPending = false;
    const match = findOpened(data, state.opened);
    if (match) selectEvent(match.id);
  }
}

function findOpened(data: Dossier, opened: WireEvent) {
  return data.events.find((e) => e.id === opened.id || (opened.url !== '' && e.url === opened.url));
}

function startPolling(): void {
  poller?.stop();
  const { symbol, range } = state;
  if (!symbol) {
    poller = createPoller(
      fetchWire,
      WIRE_MS,
      (data) => {
        if (wireSeen) {
          for (const event of data.events) if (!wireSeen.has(wireKey(event))) state.wireNewIds.add(wireKey(event));
        }
        wireSeen ??= new Set();
        for (const event of data.events) wireSeen.add(wireKey(event));
        const unchanged = state.wire && !state.wireError && signature(state.wire) === signature(data);
        state.wire = data;
        state.wireError = null;
        if (unchanged) {
          refreshUpdated(feed, data.updatedAt);
          return;
        }
        renderView();
      },
      (error) => {
        state.wireError = error;
        renderView();
      },
    );
    return;
  }
  const key = `${symbol}|${range}`;
  let first = true;
  poller = createPoller(
    (signal) => fetchDossier(symbol, range, signal),
    DOSSIER_MS,
    (data) => {
      onDossier(data, key, first);
      first = false;
    },
    (error) => {
      state.rangePending = false;
      state.dossierError = error;
      renderView();
    },
  );
}

function startBoard(): void {
  createPoller(
    fetchBoard,
    BOARD_MS,
    (board) => {
      state.board = board;
      state.boardError = null;
      companyList.render();
      if (!state.symbol) renderView();
    },
    (error) => {
      state.boardError = error;
      companyList.render();
      if (!state.symbol) renderView();
    },
  );
}

// ---- routing --------------------------------------------------------------

function readUrl(): void {
  const params = new URLSearchParams(location.search);
  const symbol = (params.get('symbol') ?? '').trim().toUpperCase();
  const range = params.get('range') as Range;
  state.symbol = SYMBOL_RE.test(symbol) ? symbol : null;
  state.range = RANGES.includes(range) ? range : '3mo';
  const view = params.get('view') as CompanyView;
  state.view = COMPANY_VIEWS.includes(view) ? view : 'overview';
  state.screener = !state.symbol && params.get('view') === 'screener';
}

function writeUrl(push: boolean): void {
  const params = new URLSearchParams(location.search);
  if (state.symbol) params.set('symbol', state.symbol);
  else params.delete('symbol');
  if (state.symbol && state.range !== '3mo') params.set('range', state.range);
  else params.delete('range');
  if (state.symbol && state.view !== 'overview') params.set('view', state.view);
  else if (state.screener) params.set('view', 'screener');
  else params.delete('view');
  const query = params.toString();
  const url = `${location.pathname}${query ? `?${query}` : ''}`;
  history[push ? 'pushState' : 'replaceState'](null, '', url);
}

function enterView(): void {
  state.dossier = state.symbol ? (cache.get(`${state.symbol}|${state.range}`) ?? null) : null;
  state.dossierError = null;
  state.rangePending = false;
  state.wireError = null;
  state.selectedId = null;
  state.newIds = new Set();
  state.types.clear();
  state.limit = TIMELINE_PAGE;
  state.menuOpen = false;
  center.scrollTop = 0;
  rail.scrollTop = 0;
  if (window.scrollY > 0) window.scrollTo(0, 0);
  renderAll();
  startPolling();
}

function navigate(symbol: string | null, opened: WireEvent | null = null, screener = false): void {
  state.opened = opened;
  state.openedPending = opened !== null;
  if (symbol === state.symbol && (symbol !== null || screener === state.screener)) {
    state.menuOpen = false;
    renderChrome();
    return;
  }
  state.symbol = symbol;
  state.screener = screener && !symbol;
  if (opened) state.view = 'overview';
  writeUrl(true);
  enterView();
}

function setRange(range: Range): void {
  if (range === state.range) return;
  state.range = range;
  writeUrl(false);
  // Without a cached copy, keep events and scores on screen but never show the
  // previous range's prices under the new range button.
  const cached = cache.get(`${state.symbol}|${range}`);
  state.rangePending = !cached && state.dossier !== null;
  if (cached) state.dossier = cached;
  else if (state.dossier) state.dossier = { ...state.dossier, history: [] };
  state.dossierError = null;
  renderView();
  startPolling();
}

window.addEventListener('popstate', () => {
  state.opened = null;
  state.openedPending = false;
  readUrl();
  enterView();
});

new ResizeObserver(() => {
  const width = Math.floor(chartBody.clientWidth);
  if (state.symbol && state.dossier && width > 0 && width !== chartWidth) renderChartPanel();
}).observe(chartBody);

setInterval(() => tickAges(), 1000);

readUrl();
startBoard();
enterView();
