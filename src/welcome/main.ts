// Start page: what the project is, how it works and where to go. Static text and
// counts taken from the repository, so it opens at once and shows no live data.
import companies from '../../shared/dossier-companies.json';
import { mountBanshoMenu } from '../shell/bansho-menu';
import { applyStoredView } from '../shell/bansho-view';
import { safeStorageGet, safeStorageSet } from '../utils/safe-storage';
import { openStartMenu } from './start-menu';
import './welcome.css';

type Lang = 'en' | 'ru';

const LANG_KEY = 'money-bansho-dossier-lang';
const SOURCE_URL = 'https://github.com/fckmeaning/Money-Bansho';
const UPSTREAM_URL = 'https://github.com/koala73/worldmonitor';
/** Size of the feed catalogue in api/_dossier/feeds.js (not all answer at once). */
const FEEDS_IN_CATALOGUE = 1688;

interface Card {
  href: string;
  title: string;
  text: string;
  points: string[];
  chart: keyof typeof CHARTS;
}

const CHARTS = {
  line: 'M2 34 L14 26 L24 30 L36 16 L48 21 L60 8 L74 14 L94 4',
  bars: 'M6 38V24M20 38V12M34 38V28M48 38V6M62 38V18M76 38V22M90 38V10',
  net: 'M14 30L36 10M36 10L60 24M60 24L84 8M14 30L60 24M36 10L84 8M60 24L74 36',
  fan: 'M4 22L36 22L92 4M36 22L92 14M36 22L92 30M36 22L92 40',
  grid: 'M4 4H44V18H4zM52 4H92V18H52zM4 24H44V38H4zM52 24H92V38H52z',
  globe: 'M48 3a19 19 0 1 0 0 38a19 19 0 0 0 0-38zM29 22H67M48 3c9 10 9 28 0 38M48 3c-9 10-9 28 0 38',
} as const;

const TEXT = {
  ru: {
    kicker: 'Финансово-геополитический терминал',
    title: 'Почему движется акция',
    lead: 'Money Bansho связывает цену компании с тем, что происходило вокруг неё: экономика, политика, смена руководителей, репутация и свежие новости из Китая, Европы, Израиля и о КНДР. Поверх этого работают математические модели с открытыми формулами.',
    open: 'Открыть обзор рынка',
    demo: 'Демо за 2 минуты',
    map: 'Карта мира',
    stats: ['компаний в досье', 'лент в каталоге', 'регионов в фокусе', 'платных ключей'],
    sections: 'Разделы',
    how: 'Как это работает',
    steps: [
      ['1. Источники', 'Котировки, официальные документы, ленты изданий и поиск новостей. Только бесплатные, без ключей.'],
      ['2. События', 'Заголовки очищаются от дублей, получают тип, дату и источник: руководство, регулирование, сделки, скандалы.'],
      ['3. Математика', 'Реакция цены на событие, волатильность, риск, режимы рынка, связи между компаниями.'],
      ['4. Сценарий', 'Коридор возможного движения по похожим случаям прошлого и проверка, как часто он попадал.'],
    ],
    math: 'Что считается',
    mathHead: ['Вопрос', 'Модель'],
    mathRows: [
      ['Сильнее ли обычного отреагировала цена?', 'Событийный анализ: накопленная избыточная доходность и z-оценка'],
      ['Насколько бурным будет ближайшее время?', 'GARCH / GJR для условной волатильности'],
      ['Сколько можно потерять в плохой день?', 'VaR и ожидаемые потери в хвосте (ES)'],
      ['Изменился ли режим рынка?', 'Скрытая марковская модель и точки перелома'],
      ['Порождают ли новости новые новости?', 'Процесс Хокса'],
      ['Кто с кем движется вместе?', 'Корреляции, остовное дерево, PageRank'],
      ['Не случайна ли находка?', 'Поправка на множественные проверки (FDR)'],
    ],
    honestTitle: 'Чего здесь нет',
    honest: [
      'Нет обещаний цены и советов покупать или продавать.',
      'Нет выдуманных данных: если источник не ответил, написано «нет данных».',
      'Новости обновляются опросом, а не посекундно.',
      'Разбор заголовков идёт по словарю и может ошибаться.',
    ],
    cards: [
      { href: '/dossier.html', title: 'Обзор рынка', text: 'С чего начать: весь рынок на одном экране.', points: ['Карта компаний', 'Прогнозные коридоры', 'Лента заголовков'], chart: 'bars' },
      { href: '/dossier.html?symbol=NVDA', title: 'Досье компании', text: 'Цена, события и репутация одной компании.', points: ['События на графике', 'Прогноз и сценарии', 'Метрики и модели'], chart: 'line' },
      { href: '/dossier.html?view=analytics', title: 'Аналитика и графы', text: 'Сравнение всех компаний и их связей.', points: ['Таблицы с сортировкой', 'Тепловая карта', 'Сеть взаимодействий'], chart: 'net' },
      { href: '/dossier.html?view=world', title: 'Мир: главные события', text: 'Что важно сейчас и как ответили рынки.', points: ['Рейтинг значимости', 'Реакция индексов', 'Объяснение балла'], chart: 'fan' },
      { href: '/dossier.html?view=screener', title: 'Скринер', text: 'Быстрый отбор компаний по метрикам.', points: ['Фильтры по регионам', 'Сортировка', 'Переход в досье'], chart: 'grid' },
      { href: '/dashboard', title: 'Карта мира', text: 'Геополитический фон по странам.', points: ['Слои на карте', 'Индекс нестабильности', 'Новости регионов'], chart: 'globe' },
    ] as Card[],
    examples: 'Примеры досье',
    about: 'О проекте',
    disclaimer: 'Данные из открытых источников, могут запаздывать или отсутствовать. Не является инвестиционной рекомендацией.',
  },
  en: {
    kicker: 'Markets and geopolitics terminal',
    title: 'Why a stock moves',
    lead: 'Money Bansho links a company’s price to what happened around it: the economy, politics, leadership changes, reputation and fresh news from China, Europe, Israel and about North Korea. Mathematical models with open formulas work on top.',
    open: 'Open market overview',
    demo: 'Two-minute demo',
    map: 'World map',
    stats: ['companies in dossiers', 'feeds in the catalogue', 'regional focuses', 'paid keys'],
    sections: 'Sections',
    how: 'How it works',
    steps: [
      ['1. Sources', 'Quotes, official filings, publisher feeds and news search. Free only, no keys.'],
      ['2. Events', 'Headlines are de-duplicated and get a type, a date and a source: leadership, regulation, deals, scandals.'],
      ['3. Mathematics', 'Price reaction to an event, volatility, risk, market regimes, links between companies.'],
      ['4. Scenario', 'A corridor of possible movement from similar past cases, with a check of how often it held.'],
    ],
    math: 'What is computed',
    mathHead: ['Question', 'Model'],
    mathRows: [
      ['Did the price react more than usual?', 'Event study: cumulative abnormal return and z-score'],
      ['How turbulent is the near term?', 'GARCH / GJR conditional volatility'],
      ['How much can a bad day cost?', 'Value at Risk and expected shortfall'],
      ['Has the market regime changed?', 'Hidden Markov model and change points'],
      ['Do news breed more news?', 'Hawkes process'],
      ['What moves together?', 'Correlations, spanning tree, PageRank'],
      ['Is the finding just chance?', 'Multiple-testing correction (FDR)'],
    ],
    honestTitle: 'What is not here',
    honest: [
      'No price promises and no advice to buy or sell.',
      'No invented data: when a source fails the page says there is no data.',
      'News is refreshed by polling, not second by second.',
      'Headline analysis is dictionary based and can be wrong.',
    ],
    cards: [
      { href: '/dossier.html', title: 'Market overview', text: 'Start here: the whole market on one screen.', points: ['Company map', 'Forecast corridors', 'Headline wire'], chart: 'bars' },
      { href: '/dossier.html?symbol=NVDA', title: 'Company dossier', text: 'Price, events and reputation of one company.', points: ['Events on the chart', 'Forecast and scenarios', 'Metrics and models'], chart: 'line' },
      { href: '/dossier.html?view=analytics', title: 'Analytics and graphs', text: 'All companies compared, with their links.', points: ['Sortable tables', 'Heat map', 'Interaction network'], chart: 'net' },
      { href: '/dossier.html?view=world', title: 'World events', text: 'What matters now and how markets answered.', points: ['Significance ranking', 'Index reaction', 'Score explained'], chart: 'fan' },
      { href: '/dossier.html?view=screener', title: 'Screener', text: 'Pick companies by their metrics.', points: ['Region filters', 'Sorting', 'Jump to a dossier'], chart: 'grid' },
      { href: '/dashboard', title: 'World map', text: 'The geopolitical background by country.', points: ['Map layers', 'Instability index', 'Regional news'], chart: 'globe' },
    ] as Card[],
    examples: 'Example dossiers',
    about: 'About',
    disclaimer: 'Open sources, may be delayed or missing. Not investment advice.',
  },
};

const FORECAST: Record<Lang, { title: string; text: string; open: string; links: Array<[string, string]>; pages: string; pageLinks: Array<[string, string]> }> = {
  ru: {
    title: 'Прогноз',
    text: 'Главная функция проекта: коридор возможной цены на 1, 5 и 20 сессий, сценарии после новостей и проверка, как часто коридор попадал.',
    open: 'Открыть прогноз',
    links: [['/forecast.html#/compare', 'Сравнение'], ['/forecast.html#/regions', 'Регионы'], ['/forecast.html#/scenarios', 'Сценарии'], ['/forecast.html#/accuracy', 'Точность'], ['/forecast.html#/method', 'Метод']],
    pages: 'Все разделы сайта',
    pageLinks: [['/pages.html#/', 'Все разделы'], ['/pages.html#/regions', 'Регионы'], ['/pages.html#/companies', 'Компании'], ['/pages.html#/countries', 'Страны'], ['/pages.html#/models', 'Модели'], ['/pages.html#/data', 'Источники'], ['/pages.html#/backtests', 'Проверки'], ['/pages.html#/glossary', 'Глоссарий'], ['/pages.html#/sitemap', 'Карта сайта'], ['/terminal', 'Терминал']],
  },
  en: {
    title: 'Forecast',
    text: 'The main feature: a price corridor for 1, 5 and 20 sessions, scenarios after headlines and a check of how often the corridor held.',
    open: 'Open the forecast',
    links: [['/forecast.html#/compare', 'Compare'], ['/forecast.html#/regions', 'Regions'], ['/forecast.html#/scenarios', 'Scenarios'], ['/forecast.html#/accuracy', 'Accuracy'], ['/forecast.html#/method', 'Method']],
    pages: 'All site sections',
    pageLinks: [['/pages.html#/', 'All sections'], ['/pages.html#/regions', 'Regions'], ['/pages.html#/companies', 'Companies'], ['/pages.html#/countries', 'Countries'], ['/pages.html#/models', 'Models'], ['/pages.html#/data', 'Sources'], ['/pages.html#/backtests', 'Backtests'], ['/pages.html#/glossary', 'Glossary'], ['/pages.html#/sitemap', 'Site map'], ['/terminal', 'Terminal']],
  },
};

const SVG_NS = 'http://www.w3.org/2000/svg';

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

function chart(name: keyof typeof CHARTS): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 96 44');
  svg.setAttribute('class', 'wl-glyph');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', CHARTS[name]);
  svg.append(path);
  return svg;
}

function storedLang(): Lang {
  const param = new URLSearchParams(window.location.search).get('lang');
  let value = param;
  value ??= safeStorageGet(LANG_KEY);
  return value === 'en' ? 'en' : 'ru';
}

function render(lang: Lang): void {
  const t = TEXT[lang];
  document.documentElement.lang = lang;

  const language = el('div', { class: 'wl-segment', role: 'group', 'aria-label': 'Language' });
  for (const code of ['ru', 'en'] as const) {
    const button = el('button', { type: 'button', 'aria-pressed': String(code === lang) }, code.toUpperCase());
    button.addEventListener('click', () => {
      safeStorageSet(LANG_KEY, code);
      render(code);
    });
    language.append(button);
  }

  const header = el(
    'header',
    { class: 'wl-top' },
    mountBanshoMenu({ active: 'wire', lang }),
    el('img', { src: '/favico/icon.svg', alt: '', width: '28', height: '28' }),
    el('b', {}, 'Money Bansho'),
    language,
  );

  const regions = new Set((companies as Array<{ region?: string }>).map((c) => c.region));
  regions.delete('other');
  const numbers = [companies.length, FEEDS_IN_CATALOGUE, regions.size, 0];

  const hero = el(
    'section',
    { class: 'wl-hero' },
    el('p', { class: 'wl-kicker' }, t.kicker),
    el('h1', {}, t.title),
    el('p', { class: 'wl-lead' }, t.lead),
    el(
      'p',
      { class: 'wl-actions' },
      el('a', { class: 'wl-primary', href: '/dossier.html' }, t.open),
      el('a', { class: 'wl-secondary', href: '/dashboard' }, t.map),
      el('a', { class: 'wl-secondary', href: '/dossier.html?tour=1' }, t.demo),
    ),
    el(
      'dl',
      { class: 'wl-stats' },
      ...numbers.map((value, index) => el(
        'div',
        {},
        el('dt', {}, t.stats[index] ?? ''),
        el('dd', {}, value.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US')),
      )),
    ),
  );

  const cards = el(
    'section',
    {},
    el('h2', {}, t.sections),
    el(
      'div',
      { class: 'wl-cards' },
      ...t.cards.map((card) => el(
        'a',
        { class: 'wl-card', href: card.href },
        chart(card.chart),
        el('h3', {}, card.title),
        el('p', {}, card.text),
        el('ul', {}, ...card.points.map((point) => el('li', {}, point))),
      )),
    ),
    el(
      'p',
      { class: 'wl-examples' },
      el('span', {}, t.examples),
      ...[['NVDA', 'Nvidia'], ['0700.HK', 'Tencent'], ['TEVA.TA', 'Teva']].map(([symbol, name]) =>
        el('a', { href: `/dossier.html?symbol=${symbol}` }, el('b', {}, symbol ?? ''), ` ${name}`)),
    ),
  );

  const how = el(
    'section',
    {},
    el('h2', {}, t.how),
    el('ol', { class: 'wl-steps' }, ...t.steps.map(([title, text]) =>
      el('li', {}, el('h3', {}, title ?? ''), el('p', {}, text ?? '')))),
  );

  const math = el(
    'section',
    {},
    el('h2', {}, t.math),
    el(
      'div',
      { class: 'wl-scroll' },
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ...t.mathHead.map((head) => el('th', { scope: 'col' }, head)))),
        el('tbody', {}, ...t.mathRows.map(([question, model]) =>
          el('tr', {}, el('td', {}, question ?? ''), el('td', {}, model ?? '')))),
      ),
    ),
  );

  const honest = el(
    'section',
    { class: 'wl-honest' },
    el('h2', {}, t.honestTitle),
    el('ul', {}, ...t.honest.map((line) => el('li', {}, line))),
  );

  const external = (href: string, text: string): HTMLAnchorElement =>
    el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const footer = el(
    'footer',
    {},
    el('p', {}, t.disclaimer),
    el(
      'details',
      {},
      el('summary', {}, t.about),
      el(
        'p',
        { lang: 'en' },
        'Money Bansho is based on ',
        external(UPSTREAM_URL, 'World Monitor'),
        ', © 2026 Elie Habib. Licensed under AGPL-3.0, without any warranty. ',
        external(SOURCE_URL, 'Source code'),
      ),
    ),
  );

  // The forecast is the main feature, so it opens the page.
  const f = FORECAST[lang];
  const forecast = el(
    'section',
    { class: 'wl-forecast' },
    el('a', { class: 'wl-forecast-main', href: '/forecast.html' },
      el('h2', {}, f.title),
      el('p', {}, f.text),
      el('span', {}, f.open),
      chart('fan')),
    el('p', { class: 'wl-examples' }, ...f.links.map(([href, label]) => el('a', { href }, label))),
  );
  const sections = el(
    'section',
    {},
    el('h2', {}, f.pages),
    el('p', { class: 'wl-examples' }, ...f.pageLinks.map(([href, label]) => el('a', { href }, label))),
  );

  document.getElementById('app')?.replaceChildren(header, el('main', {}, forecast, hero, cards, sections, how, math, honest), footer);
}

applyStoredView();
render(storedLang());

// The main menu opens first. ?menu=0 and the guided demo go straight to the overview.
const query = new URLSearchParams(window.location.search);
if (query.get('menu') !== '0' && !query.has('tour')) {
  openStartMenu({
    lang: storedLang(),
    upstreamUrl: UPSTREAM_URL,
    sourceUrl: SOURCE_URL,
    onLanguage: (lang) => {
      safeStorageSet(LANG_KEY, lang);
      // A ?lang= address would override the choice on the next load.
      if (query.has('lang')) window.history.replaceState(null, '', window.location.pathname);
      render(lang);
    },
  });
}
