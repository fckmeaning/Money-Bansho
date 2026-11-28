// Entry of /pages.html: hash routes, shared header, section index, breadcrumbs,
// previous / next, page search.
import { mountBanshoMenu } from '../shell/bansho-menu';
import { applyStoredView } from '../shell/bansho-view';
import { safeStorageGet, safeStorageSet } from '../utils/safe-storage';
import { MODELS } from './models';
import { a, el, type L, p, state, tr, ul } from './ui';
import * as v from './views';
import './pages.css';

const LANG_KEY = 'money-bansho-dossier-lang';

interface Page {
  /** Hash path without "#/". */
  path: string;
  title: () => string;
  section: string;
  /** Parent page path, for breadcrumbs. */
  parent?: string;
  body: () => Node[] | null;
}

const SECTIONS: Array<[string, L]> = [
  ['start', ['Начало', 'Start']],
  ['markets', ['Рынки и регионы', 'Markets and regions']],
  ['countries', ['Страны', 'Countries']],
  ['models', ['Модели', 'Models']],
  ['data', ['Данные и проверки', 'Data and checks']],
  ['info', ['Справка', 'Reference']],
];

const fixed = (path: string, section: string, title: L, body: () => Node[] | null, parent = ''): Page =>
  ({ path, section, title: () => tr(title), body, parent: path ? parent : undefined });

const PAGES: Page[] = [
  fixed('', 'start', ['Все разделы', 'All sections'], homePage),
  fixed('sitemap', 'start', ['Карта сайта', 'Site map'], sitemapPage),
  fixed('regions', 'markets', ['Регионы', 'Regions'], v.regionsPage),
  ...v.REGIONS.map((r) => fixed(`region/${r.id}`, 'markets', r.title, () => v.regionPage(r.id), 'regions')),
  fixed('companies', 'markets', ['Каталог компаний', 'Company catalogue'], v.companiesPage),
  fixed('countries', 'countries', ['Страны', 'Countries'], v.countriesPage),
  ...v.COUNTRIES.map((code): Page => ({ path: `country/${code}`, section: 'countries', parent: 'countries', title: () => v.countryName(code), body: () => v.countryPage(code) })),
  fixed('models', 'models', ['Модели', 'Models'], v.modelsPage),
  ...MODELS.map((m) => fixed(`model/${m.id}`, 'models', m.title, () => v.modelPage(m), 'models')),
  fixed('data', 'data', ['Источники данных', 'Data sources'], v.sourcesPage),
  fixed('data/feeds', 'data', ['Каталог лент', 'Feed catalogue'], v.feedsPage, 'data'),
  fixed('pipeline', 'data', ['Как работает конвейер', 'How the pipeline works'], v.pipelinePage),
  fixed('backtests', 'data', ['Проверки на истории', 'Backtests'], v.backtestsPage),
  fixed('backtest/news', 'data', ['Бэктест: тон новостей', 'Backtest: news tone'], () => v.reportPage('news'), 'backtests'),
  fixed('backtest/real', 'data', ['Бэктест: веса, коридор, VaR', 'Backtest: weights, corridor, VaR'], () => v.reportPage('real'), 'backtests'),
  fixed('limits', 'info', ['Ограничения', 'Limitations'], v.limitsPage),
  fixed('glossary', 'info', ['Глоссарий', 'Glossary'], v.glossaryPage),
  fixed('about', 'info', ['О проекте', 'About the project'], v.aboutPage),
];

/** Company pages are not part of the previous / next order or the side index. */
const companyRoute = (symbol: string): Page | null => {
  const company = v.COMPANIES.find((c) => c.symbol === symbol.toUpperCase());
  if (!company) return null;
  return { path: `company/${company.symbol}`, section: 'markets', parent: 'companies', title: () => company.name, body: () => v.companyPage(company.symbol) };
};

/** The other pages of the site. */
const OUTSIDE: Array<[string, L]> = [
  ['/forecast.html#/', ['Прогноз', 'Forecast']],
  ['/welcome.html', ['Главная', 'Start page']],
  ['/dossier.html', ['Обзор рынка', 'Market overview']],
  ['/dossier.html?view=analytics', ['Аналитика и графы', 'Analytics and graphs']],
  ['/dossier.html?view=screener', ['Скринер', 'Screener']],
  ['/dossier.html?view=world', ['Мир: главные события', 'World events']],
  ['/dashboard', ['Карта мира', 'World map']],
  ['/terminal', ['Терминал', 'Terminal']],
];

const FORECAST_PAGES: Array<[string, L]> = [
  ['#/', ['Прогноз: начало', 'Forecast home']], ['#/compare', ['Сравнение', 'Compare']], ['#/regions', ['Регионы', 'Regions']],
  ['#/scenarios', ['Сценарии', 'Scenarios']], ['#/accuracy', ['Точность', 'Accuracy']], ['#/method', ['Метод', 'Method']], ['#/limits', ['Ограничения', 'Limitations']],
];

function homePage(): Node[] {
  return [
    el('a', { class: 'pg-feature', href: '/forecast.html#/' },
      el('b', {}, tr(['Прогноз', 'Forecast'])),
      el('span', {}, tr(['Главная функция: коридор цены на 1, 5 и 20 сессий, сценарии и проверка точности.', 'The main feature: price corridor for 1, 5 and 20 sessions, scenarios and accuracy checks.']))),
    ...SECTIONS.flatMap(([id, label]) => [
      el('h2', {}, tr(label)),
      el('div', { class: 'pg-cards' }, ...PAGES.filter((pg) => pg.section === id && pg.path && !pg.path.startsWith('country/')).map((pg) =>
        el('a', { class: 'pg-card', href: `#/${pg.path}` }, el('h3', {}, pg.title())))),
    ]),
    el('h2', {}, tr(['Остальной сайт', 'The rest of the site'])),
    el('p', { class: 'pg-links' }, ...OUTSIDE.map(([href, label]) => a(href, tr(label)))),
  ];
}

function sitemapPage(): Node[] {
  const list = (items: Array<[string, string]>): HTMLElement => ul(items.map(([href, text]) => a(href, text)));
  return [
    p(`${tr(['Страниц в этом разделе', 'Pages in this section'])}: ${PAGES.length}; ${tr(['страниц компаний', 'company pages'])}: ${v.COMPANIES.length}.`),
    el('div', { class: 'pg-columns' },
      ...SECTIONS.map(([id, label]) => el('section', {}, el('h2', {}, tr(label)), list(PAGES.filter((pg) => pg.section === id).map((pg) => [`#/${pg.path}`, pg.title()])))),
      el('section', {}, el('h2', {}, tr(['Прогноз', 'Forecast'])), list(FORECAST_PAGES.map(([hash, label]) => [`/forecast.html${hash}`, tr(label)]))),
      el('section', {}, el('h2', {}, tr(['Остальной сайт', 'The rest of the site'])), list(OUTSIDE.map(([href, label]) => [href, tr(label)])))),
    el('h2', {}, tr(['Страницы компаний', 'Company pages'])),
    el('div', { class: 'pg-columns' }, list(v.COMPANIES.map((c) => [`#/company/${encodeURIComponent(c.symbol)}`, `${c.name} (${c.symbol})`]))),
  ];
}

function route(): { path: string; page: Page | null } {
  let path = window.location.hash.replace(/^#\/?/, '').replace(/\/$/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape is simply an unknown address.
  }
  const page = path.startsWith('company/') ? companyRoute(path.slice(8)) : PAGES.find((pg) => pg.path === path) ?? null;
  return { path, page };
}

function storedLang(): 'ru' | 'en' {
  let value = new URLSearchParams(window.location.search).get('lang');
  value ??= safeStorageGet(LANG_KEY);
  return value === 'en' ? 'en' : 'ru';
}

function searchBox(): HTMLElement {
  const input = el('input', { type: 'search', class: 'pg-search-input', placeholder: tr(['Поиск по страницам', 'Search pages']), 'aria-label': tr(['Поиск по страницам', 'Search pages']), autocomplete: 'off' });
  const results = el('ul', { class: 'pg-results' });
  results.hidden = true;
  const entries = (): Array<[string, string, string]> => [
    ...PAGES.map((pg): [string, string, string] => [`#/${pg.path}`, pg.title(), pg.path]),
    ...v.COMPANIES.map((c): [string, string, string] => [`#/company/${encodeURIComponent(c.symbol)}`, `${c.name} (${c.symbol})`, (c.aliases ?? []).join(' ')]),
    ...OUTSIDE.map(([href, label]): [string, string, string] => [href, tr(label), label.join(' ')]),
  ];
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    results.hidden = !q;
    if (!q) return;
    const found = entries().filter(([, title, extra]) => `${title} ${extra}`.toLowerCase().includes(q)).slice(0, 12);
    results.replaceChildren(...(found.length ? found.map(([href, title]) => el('li', {}, a(href, title))) : [el('li', { class: 'pg-muted' }, tr(['Ничего не найдено', 'Nothing found']))]));
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { input.value = ''; results.hidden = true; }
    if (event.key === 'Enter') results.querySelector('a')?.click();
  });
  results.addEventListener('click', () => { input.value = ''; results.hidden = true; });
  return el('div', { class: 'pg-search', role: 'search' }, input, results);
}

let main: HTMLElement;
let side: HTMLElement;

function sideNav(current: Page | null): void {
  const nav = el('nav', { 'aria-label': tr(['Разделы', 'Sections']) },
    a('/forecast.html#/', tr(['Прогноз', 'Forecast'])),
    ...SECTIONS.map(([id, label]) => {
      const group = el('details', {}, el('summary', {}, tr(label)),
        ul(PAGES.filter((pg) => pg.section === id).map((pg) => {
          const link = a(`#/${pg.path}`, pg.title());
          if (pg.path === current?.path) link.setAttribute('aria-current', 'page');
          return link;
        })));
      group.open = current ? current.section === id : id === 'start';
      return group;
    }),
    el('details', {}, el('summary', {}, tr(['Остальной сайт', 'The rest of the site'])), ul(OUTSIDE.map(([href, label]) => a(href, tr(label))))));
  const box = el('details', { class: 'pg-side-box' }, el('summary', {}, tr(['Указатель разделов', 'Section index'])), nav);
  box.open = window.matchMedia('(min-width: 861px)').matches;
  side.replaceChildren(box);
}

function show(): void {
  const { path, page } = route();
  const body = page?.body() ?? null;
  const title = page && body ? page.title() : tr(['Страница не найдена', 'Page not found']);
  document.title = `${title} — Money Bansho`;

  const crumbs: Array<Node | string> = [a('#/', tr(['Все разделы', 'All sections']))];
  const parent = PAGES.find((pg) => pg.path === page?.parent);
  if (parent?.path) crumbs.push(a(`#/${parent.path}`, parent.title()));
  if (path) crumbs.push(el('span', { 'aria-current': 'page' }, title));

  const index = page ? PAGES.findIndex((pg) => pg.path === page.path) : -1;
  let previous = index > 0 ? PAGES[index - 1] : undefined;
  let next = index >= 0 ? PAGES[index + 1] : undefined;
  if (page?.path.startsWith('company/')) {
    const at = v.COMPANIES.findIndex((c) => `company/${c.symbol}` === page.path);
    const before = v.COMPANIES[at - 1];
    const after = v.COMPANIES[at + 1];
    previous = before ? companyRoute(before.symbol) ?? undefined : PAGES.find((pg) => pg.path === 'companies');
    next = after ? companyRoute(after.symbol) ?? undefined : PAGES.find((pg) => pg.path === 'countries');
  }
  const pager = el('nav', { class: 'pg-pager', 'aria-label': tr(['Назад и далее', 'Previous and next']) },
    previous ? el('a', { href: `#/${previous.path}`, rel: 'prev' }, el('small', {}, tr(['Назад', 'Previous'])), previous.title()) : el('span'),
    next ? el('a', { href: `#/${next.path}`, rel: 'next' }, el('small', {}, tr(['Далее', 'Next'])), next.title()) : el('span'));

  main.replaceChildren(
    el('nav', { class: 'pg-crumbs', 'aria-label': tr(['Хлебные крошки', 'Breadcrumbs']) }, ...crumbs),
    el('h1', {}, title),
    ...(body ?? [
      p(tr(['Такого адреса нет. Выберите раздел в указателе, воспользуйтесь поиском или откройте карту сайта.', 'This address does not exist. Pick a section, use search or open the site map.'])),
      el('p', { class: 'pg-links' }, a('#/', tr(['Все разделы', 'All sections'])), a('#/sitemap', tr(['Карта сайта', 'Site map']))),
    ]),
    pager);
  sideNav(page);
}

function render(): void {
  document.documentElement.lang = state.lang;
  const language = el('div', { class: 'pg-segment', role: 'group', 'aria-label': 'Language' });
  for (const code of ['ru', 'en'] as const) {
    const button = el('button', { type: 'button', 'aria-pressed': String(code === state.lang) }, code.toUpperCase());
    button.addEventListener('click', () => {
      safeStorageSet(LANG_KEY, code);
      state.lang = code;
      render();
    });
    language.append(button);
  }
  const header = el('header', { class: 'pg-top' },
    mountBanshoMenu({ active: 'wire', lang: state.lang }),
    el('a', { class: 'pg-brand', href: '/welcome.html' }, el('img', { src: '/favico/icon.svg', alt: '', width: '28', height: '28' }), el('b', {}, 'Money Bansho')),
    el('nav', { class: 'pg-topnav', 'aria-label': tr(['Основные разделы', 'Main sections']) },
      a('/forecast.html#/', tr(['Прогноз', 'Forecast'])), a('/dossier.html', tr(['Досье', 'Dossier'])), a('/dashboard', tr(['Карта', 'Map'])), a('#/sitemap', tr(['Карта сайта', 'Site map']))),
    searchBox(), language);

  main = el('main', { class: 'pg-main', tabindex: '-1' });
  side = el('aside', { class: 'pg-side' });
  const footer = el('footer', {},
    el('p', {}, tr(['Данные из открытых источников, могут запаздывать или отсутствовать. Не является инвестиционной рекомендацией.', 'Open sources, may be delayed or missing. Not investment advice.'])),
    el('details', {}, el('summary', {}, tr(['О проекте', 'About'])),
      el('p', { lang: 'en' }, 'Money Bansho is based on ', el('a', { href: 'https://github.com/koala73/worldmonitor', target: '_blank', rel: 'noopener noreferrer' }, 'World Monitor'),
        ', © 2026 Elie Habib. Licensed under AGPL-3.0, without any warranty. ', el('a', { href: 'https://github.com/fckmeaning/Money-Bansho', target: '_blank', rel: 'noopener noreferrer' }, 'Source code'))));
  document.getElementById('app')?.replaceChildren(header, el('div', { class: 'pg-layout' }, side, main), footer);
  show();
}

window.addEventListener('hashchange', () => {
  show();
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
});
// The router decides the scroll position, including on browser back.
window.history.scrollRestoration = 'manual';
applyStoredView();
state.lang = storedLang();
render();
v.prefetch();
