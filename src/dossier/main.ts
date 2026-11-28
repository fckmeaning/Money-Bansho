// Money Bansho company dossier: state, routing (?symbol=&range=), polling and
// layout. With no symbol in the URL the live wire (or ?view=screener) is shown;
// a company has the tabs of COMPANY_VIEWS in ?view=.
import { loadAnswer, saveAnswer } from './persist';
import { mountBanshoMenu } from '../shell/bansho-menu';
import { metricsView, screenerView } from './analytics';
import { ApiError, createPoller, fetchBoard, fetchDossier, fetchWire, parseDossier } from './api';
import { atlasView } from './atlas';
import { bigCharts, fetchScreenerLite, greeting } from './bigcharts';
import type { ScreenerLite } from './bigcharts';
import { renderChart } from './chart';
import type { Chart } from './chart';
import { SYMBOL_RE, companies, createCompanyList } from './companies';
import { h, tickAges } from './dom';
import { eventsView, processView } from './events';
import { forecastVersion, forecastView } from './forecast';
import { forecastBoard } from './forecast-board';
import { breakdownPanel, chartRow, marketMap, marketStrip } from './overview';
import { worldView } from './world';
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
import { setBarOffset } from './zone';

const DOSSIER_MS = 20_000;
const BOARD_MS = 30_000;
const WIRE_MS = 30_000;
const CACHE_LIMIT = 12;

const state = {
  symbol: null as string | null,
  view: 'overview' as CompanyView,
  screener: false,
  /** The «Мир» summary page (?view=world). */
  world: false,
  /** Tables, charts and the company graph (?view=analytics&tab=). */
  atlas: false,
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
  yearly: null as ScreenerLite | null,
  yearlyFailed: false,
  dossier: null as Dossier | null,
  dossierError: null as ApiError | null,
  /** Time of the saved answer on screen; null once fresh data has arrived. */
  savedAt: null as number | null,
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
const sidebar = h('aside', { class: 'drawer', hidden: true });
const backdrop = h('div', { class: 'backdrop', hidden: true, onclick: () => setDrawer(false) });
const status = h('div', { class: 'status', role: 'status' });
const head = h('div', { class: 'slot slot-head' });
const chartHead = h('header', { class: 'panel-head' });
const chartBody = h('div', { class: 'chart-body' });
const chartPanel = h('section', { class: 'panel slot slot-chart' }, chartHead, chartBody);
const plate = h('div', { class: 'slot slot-plate' });
const feed = h('div', { class: 'slot slot-feed' });
const tabs = h('nav', { class: 'tabs' });
const viewSlot = h('div', { class: 'slot slot-view' });
const center = h('div', { class: 'center' }, chartPanel, plate, viewSlot, feed);
/** What the tab slot currently shows; it is rebuilt only on request. */
let shown: { key: string; data: string } | null = null;
let disposeScreener: (() => void) | null = null;
let menuButton: { key: string; node: HTMLElement } | null = null;
const rail = h('aside', { class: 'rail' });
const main = h('main', { class: 'page' }, status, head, tabs, h('div', { class: 'grid' }, center, rail));
const footer = h('footer', { class: 'footer' });
root.replaceChildren(header, main, footer, backdrop, sidebar);
// Appended once the module has run, so the overlay state is initialised.
queueMicrotask(() => root.append(boot));

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

/** The company list is a drawer over the page. */
function setDrawer(open: boolean): void {
  state.menuOpen = open;
  renderChrome();
  if (open) sidebar.querySelector<HTMLInputElement>('input.search')?.focus();
  else header.querySelector<HTMLElement>('.picker')?.focus();
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.menuOpen) setDrawer(false);
  const typing = event.target instanceof HTMLElement && event.target.matches('input, textarea, select');
  if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    setDrawer(true);
  }
});

function renderChrome(): void {
  document.documentElement.lang = uiLang();
  document.title = `${state.symbol ?? (state.atlas ? t('analytics') : state.world ? t('world') : t(state.screener ? 'screener' : 'liveWire'))} · Money Bansho`;
  const active = state.symbol ? 'dossier' : state.screener ? 'screener' : state.world ? 'world' : state.atlas ? 'analytics' : 'wire';
  const menuKey = `${active}|${uiLang()}`;
  if (menuButton?.key !== menuKey) menuButton = { key: menuKey, node: mountBanshoMenu({ active, lang: uiLang() }) };
  header.replaceChildren(
    menuButton.node,
    h(
      'button',
      {
        type: 'button',
        class: 'picker',
        'aria-expanded': String(state.menuOpen),
        onclick: () => setDrawer(!state.menuOpen),
      },
      h('span', {}, t('search')),
      h('kbd', { class: 'mono' }, '/'),
    ),
    h('a', { class: 'brand', href: location.pathname, onclick: internal(null) }, 'Money Bansho'),
    h('span', { class: 'subtitle' }, t('subtitle')),
    h(
      'nav',
      {},
      h(
        'a',
        { class: 'nav-forecast', href: state.symbol && companies.some((c) => c.symbol === state.symbol) ? `/forecast.html#/company/${encodeURIComponent(state.symbol)}` : '/forecast.html' },
        t('forecastHub'),
      ),
      h(
        'a',
        { href: location.pathname, 'aria-current': state.symbol || state.screener || state.world || state.atlas ? null : 'page', onclick: internal(null) },
        t('liveWire'),
      ),
      h(
        'a',
        {
          href: `${location.pathname}?view=analytics`,
          'aria-current': state.atlas ? 'page' : null,
          onclick: (event: MouseEvent) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            navigateAtlas();
          },
        },
        t('analytics'),
      ),
      h(
        'a',
        { href: `${location.pathname}?view=screener`, 'aria-current': state.screener ? 'page' : null, onclick: internal(null, true) },
        t('screener'),
      ),
      h(
        'a',
        {
          href: `${location.pathname}?view=world`,
          'aria-current': state.world ? 'page' : null,
          onclick: (event: MouseEvent) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            navigateWorld();
          },
        },
        t('world'),
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
                // Headlines are translated by the server, so cached answers are stale.
                cache.clear();
                state.wire = null;
                shown = null;
                enterView();
              },
            },
            lang.toUpperCase(),
          ),
        ),
      ),
    ),
  );
  sidebar.hidden = !state.menuOpen;
  backdrop.hidden = !state.menuOpen;
  footer.replaceChildren(
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
  // Source diagnostics live on the "Data and process" tab, not above the page.
  status.replaceChildren(
    ...(data && error
      ? [h('div', { class: 'banner' }, h('span', {}, `${t('stale')} ${errorText(error)}`), retry())]
      : []),
    ...(data && !error && state.savedAt !== null
      ? [h('div', { class: 'banner saved' }, h('span', {}, savedNote(state.savedAt)))]
      : []),
  );
}

function savedNote(at: number): string {
  const english = uiLang() === 'en';
  const time = new Intl.DateTimeFormat(english ? 'en-GB' : 'ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
  return english ? `Saved data from ${time}. Refreshing.` : `Сохранённые данные от ${time}. Идёт обновление.`;
}

// ---- first load -----------------------------------------------------------

/** The page opens as a whole: one quiet screen until the main blocks are ready. */
const BOOT_LIMIT_MS = 12_000;
const boot = h('div', { class: 'boot', role: 'status', hidden: true });
let bootTimer: ReturnType<typeof setTimeout> | undefined;
let bootExpired = false;

function waitingForMain(): boolean {
  if (state.symbol) return !state.dossier && !state.dossierError;
  if (state.screener || state.world || state.atlas) return false;
  return (!state.wire && !state.wireError) || (!state.yearly && !state.yearlyFailed);
}

function updateBoot(): void {
  const waiting = !bootExpired && waitingForMain();
  boot.hidden = !waiting;
  if (!waiting) return;
  const english = uiLang() === 'en';
  const subject = state.symbol ?? (english ? 'market overview' : 'обзор рынка');
  boot.replaceChildren(
    h('div', { class: 'boot-box' },
      h('strong', {}, 'Money Bansho'),
      h('span', {}, english ? `Loading: ${subject}` : `Загрузка: ${subject}`),
    ),
  );
}

function armBoot(): void {
  bootExpired = false;
  clearTimeout(bootTimer);
  bootTimer = setTimeout(() => {
    bootExpired = true;
    updateBoot();
  }, BOOT_LIMIT_MS);
}

function showSaved(): void {
  const { symbol, range } = state;
  if (symbol && !state.dossier) {
    void loadAnswer(`dossier|${uiLang()}|${symbol}|${range}`).then((saved) => {
      if (!saved || state.dossier || state.symbol !== symbol || state.range !== range) return;
      try {
        state.dossier = parseDossier(saved.body as Parameters<typeof parseDossier>[0], symbol);
      } catch {
        return;
      }
      state.savedAt = saved.at;
      renderView();
    });
  } else if (!symbol && !state.wire && !state.screener && !state.world && !state.atlas) {
    void loadAnswer(`wire|${uiLang()}`).then((saved) => {
      if (!saved || state.wire || state.symbol) return;
      const wire = saved.body as Wire;
      if (!Array.isArray(wire.events)) return;
      state.wire = wire;
      state.savedAt = saved.at;
      renderView();
    });
  }
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
    case 'process': {
      const issues = sourceIssues(data.errors);
      const view = processView(data.raw, { lang });
      return issues ? h('div', {}, view, issues) : view;
    }
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
  // The forecast changes with a new close or other headlines, not with every poll of the sources.
  const version = state.view === 'forecast'
    ? forecastVersion(data.raw)
    : JSON.stringify([data.events.map((e) => e.id), data.history[data.history.length - 1]?.t]);
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
  // The sticky header and tabs cover the top of the window.
  if (box.top < 110 || box.bottom > window.innerHeight) row.scrollIntoView({ block: 'center' });
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
    swap(plate);
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
    swap(plate);
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
    opened && !findOpened(data, opened) ? openedPanel(opened) : null,
  );
  swap(plate, signalPlate(data, () => setView('model')));
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
  swap(plate);
  const data = state.wire;
  swap(
    head,
    greeting(state.board, data?.events ?? null, (symbol) => navigate(symbol)),
    forecastBoard(state.yearly, state.yearlyFailed, (symbol) => {
      state.view = 'forecast';
      navigate(symbol);
    }),
    marketMap(state.board, companies, (symbol) => navigate(symbol)),
    bigCharts(state.yearly, state.yearlyFailed, (symbol) => navigate(symbol)),
    chartRow(data?.events ?? null, state.board, (symbol) => navigate(symbol)),
    marketStrip(data?.events ?? null, state.board),
  );
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
  swap(
    rail,
    radarPanel(options),
    breakdownPanel(data.events, companies, state.types, toggleType),
    renderMovers(),
  );
}

function renderScreener(): void {
  chartPanel.hidden = true;
  chartBody.replaceChildren();
  chart = null;
  swap(head);
  swap(plate);
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

function renderWorld(): void {
  chartPanel.hidden = true;
  chartBody.replaceChildren();
  chart = null;
  swap(head);
  swap(plate);
  swap(feed);
  swap(rail);
  if (shown?.key === 'world') return;
  disposeScreener?.();
  shown = { key: 'world', data: '' };
  const view = worldView({ onSelect: (symbol) => navigate(symbol) });
  disposeScreener = view.dispose;
  viewSlot.replaceChildren(view.el);
}

function renderAtlas(): void {
  chartPanel.hidden = true;
  chartBody.replaceChildren();
  chart = null;
  swap(head);
  swap(plate);
  swap(feed);
  swap(rail);
  const key = `analytics|${uiLang()}`;
  if (shown?.key === key) return;
  disposeScreener?.();
  shown = { key, data: '' };
  const view = atlasView({ lang: uiLang(), onSelect: (symbol) => navigate(symbol) });
  disposeScreener = view.dispose;
  viewSlot.replaceChildren(view.el);
}

function renderView(): void {
  // Date the bars on screen by their own exchange, not by UTC.
  setBarOffset(state.symbol ? state.dossier?.gmtoffset : null);
  const wide = state.screener || state.world || state.atlas || (state.symbol !== null && state.view !== 'overview');
  main.classList.toggle('wire', !state.symbol && !state.screener && !state.world && !state.atlas);
  main.classList.toggle('full', wide);
  if (!state.screener && !state.world && !state.atlas && disposeScreener) {
    disposeScreener();
    disposeScreener = null;
    shown = null;
    viewSlot.replaceChildren();
  }
  renderTabs();
  renderStatus();
  if (state.symbol) renderCompany();
  else if (state.screener) renderScreener();
  else if (state.world) renderWorld();
  else if (state.atlas) renderAtlas();
  else {
    shown = null;
    viewSlot.replaceChildren();
    renderWire();
  }
  updateBoot();
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
  // Each entry holds the whole response; keep only the most recently used few.
  cache.delete(key);
  cache.set(key, data);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  const recovered = state.dossierError !== null;
  const replacesSaved = state.savedAt !== null;
  state.savedAt = null;
  // A tab drawn from the saved answer is redrawn with the fresh one.
  if (replacesSaved) shown = null;
  state.dossier = data;
  state.dossierError = null;
  void saveAnswer(`dossier|${uiLang()}|${key}`, data.raw);
  if (previous && !recovered && !replacesSaved && signature(previous) === signature(data)) refreshUpdated(head, data.updatedAt);
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
  if (!symbol && (state.world || state.atlas)) {
    // The world page polls its own endpoint; analytics reloads only on request.
    poller = null;
    return;
  }
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
        const unchanged = state.wire && !state.wireError && state.savedAt === null && signature(state.wire) === signature(data);
        state.wire = data;
        state.wireError = null;
        state.savedAt = null;
        void saveAnswer(`wire|${uiLang()}`, data);
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

/** One-year series for the large charts of the market overview. */
function startYearly(): void {
  const onWire = () => !state.symbol && !state.screener && !state.world && !state.atlas;
  createPoller(
    fetchScreenerLite,
    5 * 60_000,
    (data) => {
      state.yearly = data;
      state.yearlyFailed = false;
      if (onWire()) renderView();
    },
    () => {
      state.yearlyFailed = true;
      if (onWire()) renderView();
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
  state.world = !state.symbol && params.get('view') === 'world';
  state.atlas = !state.symbol && params.get('view') === 'analytics';
}

function writeUrl(push: boolean): void {
  const params = new URLSearchParams(location.search);
  if (state.symbol) params.set('symbol', state.symbol);
  else params.delete('symbol');
  if (state.symbol && state.range !== '3mo') params.set('range', state.range);
  else params.delete('range');
  if (state.symbol && state.view !== 'overview') params.set('view', state.view);
  else if (state.screener) params.set('view', 'screener');
  else if (state.world) params.set('view', 'world');
  else if (state.atlas) params.set('view', 'analytics');
  else params.delete('view');
  if (!state.atlas) params.delete('tab');
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
  state.savedAt = null;
  if (window.scrollY > 0) window.scrollTo(0, 0);
  armBoot();
  renderAll();
  showSaved();
  startPolling();
}

function navigate(symbol: string | null, opened: WireEvent | null = null, screener = false): void {
  state.opened = opened;
  state.openedPending = opened !== null;
  if (symbol === state.symbol && (symbol !== null || (screener === state.screener && !state.world && !state.atlas))) {
    state.menuOpen = false;
    renderChrome();
    return;
  }
  state.symbol = symbol;
  state.screener = screener && !symbol;
  state.world = false;
  state.atlas = false;
  if (opened) state.view = 'overview';
  writeUrl(true);
  enterView();
}

function navigateWorld(): void {
  state.opened = null;
  state.openedPending = false;
  if (state.world && !state.symbol) {
    state.menuOpen = false;
    renderChrome();
    return;
  }
  state.symbol = null;
  state.screener = false;
  state.world = true;
  state.atlas = false;
  writeUrl(true);
  enterView();
}

function navigateAtlas(): void {
  state.opened = null;
  state.openedPending = false;
  if (state.atlas && !state.symbol) {
    state.menuOpen = false;
    renderChrome();
    return;
  }
  state.symbol = null;
  state.screener = false;
  state.world = false;
  state.atlas = true;
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
  state.savedAt = null;
  renderView();
  startPolling();
}

// The demo tour asks for a company before it gets there, so the step opens with
// data already in the cache. A failure is ignored: the page loads it as usual.
window.addEventListener('bansho:prefetch', (event) => {
  const symbol = (event as CustomEvent<{ symbol: string }>).detail.symbol;
  const key = `${symbol}|${state.range}`;
  if (cache.has(key)) return;
  fetchDossier(symbol, state.range, new AbortController().signal)
    .then((data) => {
      if (!cache.has(key)) cache.set(key, data);
    })
    .catch(() => {});
});

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
startYearly();
enterView();
