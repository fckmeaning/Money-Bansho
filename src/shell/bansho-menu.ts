// Money Bansho navigation menu: a compact "Menu" button that opens a left
// drawer. Framework-free and shared by the dashboard and the dossier page.
// The drawer is built on open and removed on close, so language, URL and
// recent companies are always current.
import './bansho-menu.css';

export type BanshoPage = 'dossier' | 'wire' | 'dashboard' | 'screener' | 'world';
export type BanshoLang = 'en' | 'ru';

export interface BanshoMenuOptions {
  active: BanshoPage;
  lang?: BanshoLang;
}

/**
 * Cancelable window event a dashboard handles to scroll to a section. The menu
 * falls back to a normal navigation when nothing calls preventDefault().
 */
export const BANSHO_SECTION_EVENT = 'bansho:section';

export type BanshoSection =
  | 'map'
  | 'markets'
  | 'news'
  | 'corporate'
  | 'china'
  | 'europe'
  | 'israel'
  | 'north-korea';

interface Company {
  symbol: string;
  name: string;
  aliases?: string[];
  country?: string;
  region?: string;
}

const SOURCE_URL = 'https://github.com/fckmeaning/Money-Bansho';
const UPSTREAM_URL = 'https://github.com/koala73/worldmonitor';
const RECENT_KEY = 'bansho-recent-companies';
const RECENT_MAX = 5;
const RESULT_MAX = 20;
const DEFAULT_SYMBOL = 'NVDA';
const DEMO_COMPANIES: ReadonlyArray<readonly [string, string]> = [
  ['NVDA', 'Nvidia'],
  ['0700.HK', 'Tencent'],
  ['TEVA.TA', 'Teva'],
];
const SYMBOL_RE = /^[A-Za-z0-9^][A-Za-z0-9.^=-]{0,19}$/;

const EN = {
  menu: 'Menu',
  openMenu: 'Open navigation menu',
  close: 'Close menu',
  navigation: 'Money Bansho navigation',
  tagline: 'Markets terminal',
  searchLabel: 'Find a company',
  searchPlaceholder: 'Name, ticker or region',
  results: 'Search results',
  found: 'Companies found: {n}',
  firstShown: 'Companies found: {n}. Showing the first {max}.',
  noMatch: 'No company matches.',
  loading: 'Loading company list…',
  listFailed: 'The company list could not be loaded.',
  openSymbol: 'Open symbol {symbol}',
  overview: 'Overview',
  wire: 'Live wire',
  dossier: 'Company dossier',
  analytics: 'Analytics',
  metrics: 'Metrics',
  model: 'Model',
  screener: 'Screener',
  world: 'World events',
  markets: 'Markets',
  marketsPanel: 'Market quotes',
  news: 'World news',
  corporate: 'Corporate leadership',
  regions: 'Regions',
  china: 'China',
  europe: 'Europe',
  israel: 'Israel',
  northKorea: 'North Korea',
  companies: 'Companies',
  examples: 'Examples',
  recent: 'Recently viewed',
  dashboard: 'Dashboard',
  dashboardHome: 'Open dashboard',
  map: 'Global map',
  keys: 'Open or close: {shortcut}. Move: arrow keys. Close: Esc.',
};

type Strings = typeof EN;

const RU: Strings = {
  menu: 'Меню',
  openMenu: 'Открыть меню навигации',
  close: 'Закрыть меню',
  navigation: 'Навигация Money Bansho',
  tagline: 'Рыночный терминал',
  searchLabel: 'Найти компанию',
  searchPlaceholder: 'Название, тикер или регион',
  results: 'Результаты поиска',
  found: 'Найдено компаний: {n}',
  firstShown: 'Найдено компаний: {n}. Показаны первые {max}.',
  noMatch: 'Компании не найдены.',
  loading: 'Загружается список компаний…',
  listFailed: 'Не удалось загрузить список компаний.',
  openSymbol: 'Открыть тикер {symbol}',
  overview: 'Обзор',
  wire: 'Лента новостей',
  dossier: 'Досье компании',
  analytics: 'Аналитика',
  metrics: 'Метрики',
  model: 'Модель',
  screener: 'Скринер',
  world: 'Мир: главные события',
  markets: 'Рынки',
  marketsPanel: 'Котировки',
  news: 'Мировые новости',
  corporate: 'Руководство компаний',
  regions: 'Регионы',
  china: 'Китай',
  europe: 'Европа',
  israel: 'Израиль',
  northKorea: 'Северная Корея',
  companies: 'Компании',
  examples: 'Примеры',
  recent: 'Недавно открытые',
  dashboard: 'Панель',
  dashboardHome: 'Открыть панель',
  map: 'Карта мира',
  keys: 'Открыть или закрыть: {shortcut}. Переход: стрелки. Закрыть: Esc.',
};

const STRINGS: Record<BanshoLang, Strings> = { en: EN, ru: RU };

const REGION_WORDS: Record<string, string> = {
  us: 'us usa united states america сша америка',
  china: 'china hong kong китай гонконг',
  europe: 'europe eu европа',
  israel: 'israel израиль',
  korea: 'korea корея',
  other: 'other другие',
};

const ICONS = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zM20 20l-4-4',
  wire: 'M3 12h4l3-7 4 14 3-7h4',
  dossier: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  metrics: 'M4 20h16M7 20v-8M12 20V5M17 20v-12',
  model: 'M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4',
  screener: 'M4 5h16l-6 8v6l-4-2v-4z',
  world: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  markets: 'M3 17l6-6 4 4 8-9M15 6h6v6',
  news: 'M4 5h13v14H4zM17 9h3v10h-3M7 9h7M7 13h7M7 16h4',
  corporate: 'M4 21V4h10v17M14 10h6v11M3 21h18M7 8h4M7 12h4M7 16h4',
  dashboard: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14',
} as const;

type IconName = keyof typeof ICONS;

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'bm-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));

// ---- recent companies -------------------------------------------------------

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === 'string' && SYMBOL_RE.test(s))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function rememberCompany(symbol: string): void {
  const normalized = symbol.trim().toUpperCase();
  if (!SYMBOL_RE.test(normalized)) return;
  try {
    const next = [normalized, ...readRecent().filter((s) => s !== normalized)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked or full: the menu simply has no recent list.
  }
}

const isDossierPath = (): boolean => /\/dossier(\.html)?$/.test(window.location.pathname);

function urlSymbol(): string | null {
  if (!isDossierPath()) return null;
  const symbol = (new URLSearchParams(window.location.search).get('symbol') ?? '').trim().toUpperCase();
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

function recordCurrentCompany(): void {
  const symbol = urlSymbol();
  if (symbol) rememberCompany(symbol);
}

// ---- company list -------------------------------------------------------------

let companyList: Promise<Company[]> | null = null;

/** Loaded on first open so the dashboard entry chunk does not carry it. */
function loadCompanies(): Promise<Company[]> {
  companyList ??= import('../../shared/dossier-companies.json')
    .then((module) => module.default as Company[])
    .catch((error: unknown) => {
      companyList = null;
      throw error;
    });
  return companyList;
}

const fold = (value: string): string => value.normalize('NFKC').toLocaleLowerCase();

function searchCompanies(companies: readonly Company[], query: string): Company[] {
  const needle = fold(query.trim());
  const words = needle.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const rank = (c: Company): number => {
    if (fold(c.symbol).startsWith(needle)) return 0;
    return fold(c.name).startsWith(needle) ? 1 : 2;
  };
  return companies
    .filter((c) => {
      const symbolAndName = fold([c.symbol, c.name, ...(c.aliases ?? [])].join('\n'));
      // Region words match whole prefixes only, so "us" does not hit "Asustek".
      const regionWords = (REGION_WORDS[c.region ?? ''] ?? '').split(' ');
      return words.every((word) =>
        symbolAndName.includes(word) || regionWords.some((region) => region.startsWith(word)));
    })
    .sort((a, b) => rank(a) - rank(b));
}

// ---- drawer -------------------------------------------------------------------

interface OpenDrawer {
  close(restoreFocus?: boolean): void;
}

let current: OpenDrawer | null = null;
let latestOptions: BanshoMenuOptions = { active: 'dashboard' };
const triggers = new Set<HTMLButtonElement>();
let globalListeners: AbortController | null = null;

const resolveLang = (lang?: BanshoLang): BanshoLang =>
  lang ?? (document.documentElement.lang.toLowerCase().startsWith('ru') ? 'ru' : 'en');

const isApple = (): boolean => /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const shortcutLabel = (): string => (isApple() ? 'Option+Shift+M' : 'Alt+Shift+M');

function currentPage(active: BanshoPage): string {
  if (!isDossierPath()) return active;
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  if (view === 'screener') return 'screener';
  if (view === 'world') return 'world';
  if (!urlSymbol()) return 'wire';
  return view === 'metrics' || view === 'model' ? view : 'dossier';
}

const dossierUrl = (symbol: string, view: 'overview' | 'metrics' | 'model'): string =>
  `/dossier.html?symbol=${encodeURIComponent(symbol)}&view=${view}`;

function setTriggersExpanded(expanded: boolean): void {
  for (const trigger of triggers) trigger.setAttribute('aria-expanded', String(expanded));
}

function openDrawer(options: BanshoMenuOptions): void {
  if (current) return;
  recordCurrentCompany();

  const lang = resolveLang(options.lang);
  const s = STRINGS[lang];
  const page = currentPage(options.active);
  const symbol = urlSymbol();
  const recent = readRecent();
  const analyticsSymbol = symbol ?? recent[0] ?? DEFAULT_SYMBOL;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const previousOverflow = document.documentElement.style.overflow;

  const dialog = el('dialog', { class: 'bm-drawer', 'aria-label': s.navigation, lang });

  const close = (restoreFocus = true): void => {
    if (current !== drawer) return;
    current = null;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    dialog.remove();
    document.documentElement.style.overflow = previousOverflow;
    setTriggersExpanded(false);
    if (!restoreFocus) return;
    // The page may have re-rendered its header while the drawer was open.
    const target = opener?.isConnected && opener !== document.body
      ? opener
      : [...triggers].reverse().find((trigger) => trigger.isConnected);
    target?.focus({ preventScroll: true });
  };
  const drawer: OpenDrawer = { close };

  // ---- builders

  const link = (
    href: string,
    label: string,
    config: { icon?: IconName; code?: string; note?: string; currentAs?: 'page' | 'true' } = {},
  ): HTMLAnchorElement => {
    const anchor = el('a', { class: 'bm-item', href });
    if (config.icon) anchor.append(icon(config.icon));
    if (config.code) anchor.append(el('span', { class: 'bm-code', 'aria-hidden': 'true' }, config.code));
    anchor.append(el('span', { class: 'bm-label' }, label));
    if (config.note) anchor.append(el('span', { class: 'bm-note' }, config.note));
    if (config.currentAs) anchor.setAttribute('aria-current', config.currentAs);
    anchor.addEventListener('click', () => close(false));
    return anchor;
  };

  const pageLink = (id: string, href: string, label: string, iconName: IconName, note?: string) =>
    link(href, label, { icon: iconName, note, currentAs: page === id ? 'page' : undefined });

  /** On the dashboard the jump happens in place; elsewhere it is a navigation. */
  const sectionLink = (
    section: BanshoSection,
    label: string,
    config: { icon?: IconName; code?: string },
  ): HTMLAnchorElement => {
    const href = `/dashboard?section=${section}`;
    const anchor = el('a', { class: 'bm-item', href });
    if (config.icon) anchor.append(icon(config.icon));
    if (config.code) anchor.append(el('span', { class: 'bm-code', 'aria-hidden': 'true' }, config.code));
    anchor.append(el('span', { class: 'bm-label' }, label));
    anchor.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (options.active !== 'dashboard') {
        close(false);
        return;
      }
      event.preventDefault();
      close(false);
      const jump = new CustomEvent(BANSHO_SECTION_EVENT, { detail: { section }, cancelable: true });
      if (window.dispatchEvent(jump)) window.location.assign(href);
    });
    return anchor;
  };

  const companyLink = (company: string, name: string): HTMLAnchorElement => {
    const anchor = link(dossierUrl(company, 'overview'), name, {
      note: company,
      currentAs: company === symbol ? 'true' : undefined,
    });
    anchor.classList.add('bm-company');
    anchor.addEventListener('click', () => rememberCompany(company));
    return anchor;
  };

  let groupCount = 0;
  const group = (title: string, items: HTMLElement[], listClass = ''): HTMLElement => {
    const id = `bm-group-${++groupCount}`;
    const list = el('ul', { class: `bm-list ${listClass}`.trim(), 'aria-labelledby': id });
    list.append(...items.map((item) => el('li', {}, item)));
    return el('section', { class: 'bm-group' }, el('h3', { class: 'bm-group-title', id }, title), list);
  };

  // ---- header and search

  const closeButton = el('button', { type: 'button', class: 'bm-close', 'aria-label': s.close }, icon('close'));
  closeButton.addEventListener('click', () => close());
  const header = el(
    'header',
    { class: 'bm-head' },
    el(
      'div',
      { class: 'bm-brand' },
      el('h2', { class: 'bm-title' }, 'Money Bansho'),
      el('p', { class: 'bm-tagline' }, s.tagline),
    ),
    closeButton,
  );

  const input = el('input', {
    type: 'search',
    class: 'bm-input',
    placeholder: s.searchPlaceholder,
    'aria-label': s.searchLabel,
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: '60',
  });
  const search = el('div', { class: 'bm-search' }, icon('search'), input);

  const resultStatus = el('p', { class: 'bm-status', role: 'status' });
  const resultList = el('ul', { class: 'bm-list', 'aria-label': s.results });
  const results = el('div', { class: 'bm-results' }, resultStatus, resultList);
  results.hidden = true;

  // ---- navigation

  const byName = new Map<string, string>(DEMO_COMPANIES);
  const recentItems = recent.map((company) => companyLink(company, byName.get(company) ?? company));
  const examples = group(s.companies, DEMO_COMPANIES.map(([company, name]) => companyLink(company, name)));
  examples.querySelector('h3')?.append(el('span', { class: 'bm-group-note' }, s.examples));

  const nav = el(
    'nav',
    { class: 'bm-nav', 'aria-label': s.navigation },
    group(s.overview, [
      pageLink('wire', '/dossier.html', s.wire, 'wire'),
      pageLink('world', '/dossier.html?view=world', s.world, 'world'),
      pageLink('dossier', dossierUrl(analyticsSymbol, 'overview'), s.dossier, 'dossier', analyticsSymbol),
    ]),
    group(s.analytics, [
      pageLink('metrics', dossierUrl(analyticsSymbol, 'metrics'), s.metrics, 'metrics', analyticsSymbol),
      pageLink('model', dossierUrl(analyticsSymbol, 'model'), s.model, 'model', analyticsSymbol),
      pageLink('screener', '/dossier.html?view=screener', s.screener, 'screener'),
    ]),
    group(s.markets, [
      sectionLink('markets', s.marketsPanel, { icon: 'markets' }),
      sectionLink('news', s.news, { icon: 'news' }),
      sectionLink('corporate', s.corporate, { icon: 'corporate' }),
    ]),
    group(
      s.regions,
      [
        sectionLink('china', s.china, { code: 'CN' }),
        sectionLink('europe', s.europe, { code: 'EU' }),
        sectionLink('israel', s.israel, { code: 'IL' }),
        sectionLink('north-korea', s.northKorea, { code: 'KP' }),
      ],
      'bm-grid',
    ),
    examples,
    ...(recentItems.length > 0 ? [group(s.recent, recentItems)] : []),
    group(s.dashboard, [
      pageLink('dashboard', '/dashboard', s.dashboardHome, 'dashboard'),
      sectionLink('map', s.map, { icon: 'map' }),
    ]),
  );

  // Attribution stays in English in every language.
  const external = (href: string, text: string): HTMLAnchorElement =>
    el('a', { class: 'bm-item bm-external', href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const footer = el(
    'footer',
    { class: 'bm-foot' },
    el(
      'p',
      { lang: 'en' },
      'Data: public market, filing and news sources. May be delayed or missing. Not investment advice.',
    ),
    el(
      'p',
      { class: 'bm-credits', lang: 'en' },
      external(UPSTREAM_URL, 'Based on World Monitor'),
      external(SOURCE_URL, 'Source code (AGPL-3.0)'),
    ),
    el('p', { class: 'bm-keys' }, fill(s.keys, { shortcut: shortcutLabel() })),
  );

  const body = el('div', { class: 'bm-scroll' }, results, nav, footer);
  dialog.append(el('div', { class: 'bm-panel' }, header, search, body));

  // ---- search behaviour

  let searchRun = 0;
  const runSearch = async (): Promise<void> => {
    const run = ++searchRun;
    const query = input.value.trim();
    results.hidden = !query;
    nav.hidden = Boolean(query);
    body.scrollTop = 0;
    if (!query) {
      resultList.replaceChildren();
      resultStatus.textContent = '';
      return;
    }
    let companies: Company[];
    try {
      resultStatus.textContent = s.loading;
      companies = await loadCompanies();
    } catch {
      if (run === searchRun) resultStatus.textContent = s.listFailed;
      return;
    }
    if (run !== searchRun) return;
    const matches = searchCompanies(companies, query);
    const items = matches.slice(0, RESULT_MAX).map((c) => companyLink(c.symbol, c.name));
    // A ticker outside the curated list can still be opened.
    const typed = query.toUpperCase();
    if (SYMBOL_RE.test(typed) && !companies.some((c) => c.symbol.toUpperCase() === typed)) {
      items.push(companyLink(typed, fill(s.openSymbol, { symbol: typed })));
    }
    resultList.replaceChildren(...items.map((item) => el('li', {}, item)));
    if (matches.length === 0) resultStatus.textContent = s.noMatch;
    else if (matches.length > RESULT_MAX) {
      resultStatus.textContent = fill(s.firstShown, { n: matches.length, max: RESULT_MAX });
    } else resultStatus.textContent = fill(s.found, { n: matches.length });
  };
  input.addEventListener('input', () => { void runSearch(); });

  // ---- keyboard and pointer

  const visible = (selector: string): HTMLElement[] =>
    [...dialog.querySelectorAll<HTMLElement>(selector)].filter((node) => !node.closest('[hidden]'));

  dialog.addEventListener('keydown', (event) => {
    // Page-level shortcuts must not act behind the open drawer.
    event.stopPropagation();
    if (isToggleShortcut(event)) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (input.value && document.activeElement === input) {
        input.value = '';
        void runSearch();
      } else close();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = visible('a[href], button, input');
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const at = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && at <= 0) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (at === -1 || at === focusable.length - 1)) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const items = visible('a.bm-item');
    const at = items.indexOf(document.activeElement as HTMLElement);
    const inInput = document.activeElement === input;
    if (event.key === 'Enter' && inInput) {
      event.preventDefault();
      if (!results.hidden) resultList.querySelector<HTMLAnchorElement>('a')?.click();
      return;
    }
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = items[at + 1] ?? items[0];
    else if (event.key === 'ArrowUp') next = at > 0 ? items[at - 1] : input;
    else if (event.key === 'Home' && !inInput) next = items[0];
    else if (event.key === 'End' && !inInput) next = items[items.length - 1];
    else return;
    event.preventDefault();
    next?.focus();
  });

  // The panel fills the dialog, so a click on the dialog itself is the backdrop.
  let pressedBackdrop = false;
  dialog.addEventListener('pointerdown', (event) => { pressedBackdrop = event.target === dialog; });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && pressedBackdrop) close();
    pressedBackdrop = false;
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  // A second Esc in a row closes a modal dialog even when cancel is prevented.
  dialog.addEventListener('close', () => close());

  current = drawer;
  document.body.append(dialog);
  document.documentElement.style.overflow = 'hidden';
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  setTriggersExpanded(true);
  // Focusing the search box on touch devices would open the keyboard over the menu.
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  (coarse ? closeButton : input).focus({ preventScroll: true });
}

function isToggleShortcut(event: KeyboardEvent): boolean {
  // event.code, because Option on macOS changes event.key. Ctrl is excluded so
  // AltGr layouts keep typing normally.
  return event.code === 'KeyM' && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey;
}

function installGlobalListeners(): void {
  if (globalListeners) return;
  globalListeners = new AbortController();
  const { signal } = globalListeners;
  document.addEventListener('keydown', (event) => {
    if (event.repeat || !isToggleShortcut(event)) return;
    // Another modal dialog owns the screen.
    if (!current && document.querySelector('dialog[open], [aria-modal="true"].active')) return;
    event.preventDefault();
    if (current) current.close();
    else openDrawer(latestOptions);
  }, { signal });
  // Arrow keys move between the dossier tab buttons (plain buttons in a nav).
  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const target = event.target as HTMLElement | null;
    const bar = target?.closest?.('nav.tabs');
    if (!bar || target?.tagName !== 'BUTTON') return;
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button')];
    const at = buttons.indexOf(target as HTMLButtonElement);
    if (at < 0) return;
    let next: number;
    if (event.key === 'ArrowRight') next = (at + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = (at - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else next = buttons.length - 1;
    event.preventDefault();
    buttons[next]?.focus();
  }, { signal });
  window.addEventListener('popstate', () => {
    recordCurrentCompany();
    current?.close(false);
  }, { signal });
  window.addEventListener('pagehide', () => {
    recordCurrentCompany();
    current?.close(false);
  }, { signal });
  // In-place navigation (history.pushState) is only observable here.
  const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
  navigation?.addEventListener('currententrychange', recordCurrentCompany, { signal });
}

/**
 * Returns a compact "Menu" button for the caller to place in its header. Safe to
 * call repeatedly: there is one drawer and one keyboard shortcut per page.
 */
export function mountBanshoMenu(options: BanshoMenuOptions): HTMLButtonElement {
  latestOptions = { ...options };
  const mountedOptions = latestOptions;
  installGlobalListeners();
  recordCurrentCompany();

  const s = STRINGS[resolveLang(options.lang)];
  const button = el(
    'button',
    {
      type: 'button',
      class: 'bm-trigger',
      'aria-haspopup': 'dialog',
      'aria-expanded': String(current !== null),
      'aria-keyshortcuts': 'Alt+Shift+M',
      'aria-label': `${s.menu}: ${s.openMenu}`,
      title: `${s.openMenu} (${shortcutLabel()})`,
    },
    icon('menu'),
    el('span', { class: 'bm-trigger-label' }, s.menu),
  );
  button.addEventListener('click', () => {
    // Safari does not focus a button on click; restoring focus needs it.
    button.focus({ preventScroll: true });
    openDrawer(mountedOptions);
  });
  // Buttons from earlier header renders are no longer needed.
  for (const old of triggers) if (!old.isConnected) triggers.delete(old);
  triggers.add(button);
  return button;
}

/** Closes the drawer and drops page listeners (app teardown and tests). */
export function unmountBanshoMenu(): void {
  current?.close(false);
  globalListeners?.abort();
  globalListeners = null;
  triggers.clear();
}
