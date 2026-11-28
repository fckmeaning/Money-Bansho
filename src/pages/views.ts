// Page bodies. Live numbers come from /api/dossier; lists come from the
// repository. Nothing is filled in when a source does not answer.
import companies from '../../shared/dossier-companies.json';
import { MODELS, type Model } from './models';
import { NEWS_REPORT, REAL_REPORT } from './reports';
import {
  a, api, cards, change, el, external, formula, h2, isNum, type L, linkRow, live, markdown, noData, num, p, state,
  table, tr, ul,
} from './ui';

export interface Company { symbol: string; name: string; aliases?: string[]; country: string; region: string; benchmark?: string; cik?: string }
export const COMPANIES = companies as Company[];

export const REGIONS: Array<{ id: string; title: L; forecast: boolean; panel?: string; about: L }> = [
  { id: 'us', title: ['США', 'United States'], forecast: true, about: ['Крупные компании США. Для них доступны официальные документы SEC EDGAR; бенчмарк берётся из списка компаний.', 'Large US companies. Official SEC EDGAR filings are available for them; the benchmark comes from the company list.'] },
  { id: 'china', title: ['Китай', 'China'], forecast: true, panel: 'china', about: ['Компании Китая и Гонконга. Заголовки берутся из англо- и китайскоязычных лент и поиска новостей.', 'Companies of China and Hong Kong. Headlines come from English and Chinese feeds and news search.'] },
  { id: 'europe', title: ['Европа', 'Europe'], forecast: true, panel: 'europe', about: ['Европейские компании с разных бирж; у каждой свой домашний индекс.', 'European companies on several exchanges, each with its home index.'] },
  { id: 'israel', title: ['Израиль', 'Israel'], forecast: true, panel: 'israel', about: ['Израильские компании; источники на английском и иврите.', 'Israeli companies; sources in English and Hebrew.'] },
  { id: 'korea', title: ['Корея', 'Korea'], forecast: true, panel: 'north-korea', about: ['Южнокорейские компании, а также новости о КНДР из открытых изданий. Официальных лент КНДР найти не удалось.', 'South Korean companies, plus news about North Korea from open publications. No official North Korean feeds were found.'] },
  { id: 'other', title: ['Другие рынки', 'Other markets'], forecast: false, about: ['Компании вне пяти основных регионов.', 'Companies outside the five main regions.'] },
];

const COUNTRY_NAMES: Record<string, L> = {
  US: ['США', 'United States'], CN: ['Китай', 'China'], DE: ['Германия', 'Germany'], FR: ['Франция', 'France'],
  NL: ['Нидерланды', 'Netherlands'], CH: ['Швейцария', 'Switzerland'], DK: ['Дания', 'Denmark'], GB: ['Великобритания', 'United Kingdom'],
  IL: ['Израиль', 'Israel'], KR: ['Южная Корея', 'South Korea'], TW: ['Тайвань', 'Taiwan'], JP: ['Япония', 'Japan'],
};
export const COUNTRIES = [...new Set(COMPANIES.map((c) => c.country))];
export const countryName = (code: string): string => (COUNTRY_NAMES[code] ? tr(COUNTRY_NAMES[code]) : code);
const regionTitle = (id: string): string => { const r = REGIONS.find((x) => x.id === id); return r ? tr(r.title) : id; };

// ---- shared live blocks -----------------------------------------------------

interface Quote { symbol: string; price?: number; changePct?: number }
interface Item { title?: string; titleRu?: string; url?: string; source?: string; time?: number; lastAt?: number; symbol?: string; name?: string; sources?: Array<{ url?: string; name?: string }>; regions?: string[] }

const enc = encodeURIComponent;
const tl = (): string => (state.lang === 'ru' ? '&tl=ru&cl=ru' : '&cl=en');
const when = (ms: unknown): string =>
  isNum(ms) ? new Date(ms).toLocaleString(state.lang === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '';

function companyTable(list: Company[]): HTMLElement {
  return live<{ quotes?: Quote[]; updatedAt?: number }>('view=board', (data) => {
    const quotes = new Map((data.quotes ?? []).map((q) => [q.symbol, q]));
    return el('div', {},
      table([tr(['Тикер', 'Ticker']), tr(['Компания', 'Company']), tr(['Страна', 'Country']), tr(['Цена', 'Price']), tr(['За день', 'Day']), tr(['Переходы', 'Links'])],
        list.map((c) => {
          const q = quotes.get(c.symbol);
          return [
            a(`#/company/${enc(c.symbol)}`, c.symbol), c.name, a(`#/country/${c.country}`, countryName(c.country)),
            num(q?.price), change(q?.changePct),
            el('span', { class: 'pg-inline' }, a(`/dossier.html?symbol=${enc(c.symbol)}`, tr(['досье', 'dossier'])), a(`/forecast.html#/company/${enc(c.symbol)}`, tr(['прогноз', 'forecast']))),
          ];
        })),
      el('p', { class: 'pg-muted' }, `${tr(['Котировки Yahoo, в валюте биржи; могут запаздывать. Получено', 'Yahoo quotes in exchange currency; may be delayed. Fetched'])}: ${when(data.updatedAt) || tr(['нет данных', 'no data'])}`));
  });
}

function headlines(items: Item[], limit = 12): HTMLElement | null {
  if (!items.length) return null;
  return el('ul', { class: 'pg-news' }, ...items.slice(0, limit).map((item) => {
    const first = item.sources?.[0];
    const title = (state.lang === 'ru' ? item.titleRu : undefined) ?? item.title ?? '';
    return el('li', {},
      external(item.url ?? first?.url, title),
      el('small', {},
        [item.source ?? first?.name, when(item.time ?? item.lastAt)].filter(Boolean).join(' · '),
        item.symbol ? ' · ' : '',
        item.symbol ? a(`#/company/${enc(item.symbol)}`, item.symbol) : null));
  }));
}

const wireBlock = (symbols: Set<string>): HTMLElement =>
  live<{ events?: Item[] }>(`view=wire${tl()}`, (data) => headlines((data.events ?? []).filter((e) => e.symbol && symbols.has(e.symbol))));

// ---- regions, companies, countries ------------------------------------------

export function regionsPage(): Node[] {
  return [
    p(tr(['Пять фокусных регионов и остальные рынки. На странице региона: компании, котировки, свежие заголовки и источники.', 'Five focus regions and other markets. Each region page lists companies, quotes, fresh headlines and sources.'])),
    cards(REGIONS.map((r) => ({ href: `#/region/${r.id}`, title: tr(r.title), text: `${tr(['Компаний', 'Companies'])}: ${COMPANIES.filter((c) => c.region === r.id).length}` }))),
    linkRow([['/forecast.html#/regions', tr(['Прогноз по регионам', 'Forecast by region'])], ['/dossier.html?view=analytics', tr(['Сравнение регионов в аналитике', 'Regions in analytics'])], ['/dashboard', tr(['Карта мира', 'World map'])]]),
  ];
}

export function regionPage(id: string): Node[] | null {
  const region = REGIONS.find((r) => r.id === id);
  if (!region) return null;
  const list = COMPANIES.filter((c) => c.region === id);
  const feedGroup = id === 'other' ? 'asia' : id;
  const links: Array<[string, string]> = [['/dossier.html?view=screener', tr(['Скринер', 'Screener'])], ['/dossier.html?view=world', tr(['Мир: главные события', 'World events'])]];
  if (region.forecast) links.unshift([`/forecast.html#/region/${id}`, tr(['Прогноз по региону', 'Region forecast'])]);
  if (region.panel) links.push([`/dashboard?section=${region.panel}`, tr(['Панель региона на карте', 'Region panel on the map'])]);
  return [
    p(tr(region.about)), linkRow(links),
    h2(tr(['Компании и котировки', 'Companies and quotes'])), companyTable(list),
    h2(tr(['Заголовки о компаниях региона', 'Headlines on the region’s companies'])), wireBlock(new Set(list.map((c) => c.symbol))),
    h2(tr(['Крупные события региона', 'Major events of the region'])),
    id === 'other' ? noData(tr(['для этой группы события не выделяются', 'events are not grouped for these markets'])) : live<{ events?: Item[]; more?: Item[] }>(`view=world${tl()}`, (data) =>
      headlines([...(data.events ?? []), ...(data.more ?? [])].filter((e) => e.regions?.includes(id) || (e as { primaryRegion?: string }).primaryRegion === id))),
    h2(tr(['Источники', 'Sources'])), feedList(feedGroup, 25),
    linkRow([['#/data/feeds', tr(['Весь каталог лент', 'Full feed catalogue'])]]),
  ];
}

export function companiesPage(): Node[] {
  const input = el('input', { type: 'search', class: 'pg-filter', placeholder: tr(['Фильтр: название, тикер, страна', 'Filter: name, ticker, country']), 'aria-label': tr(['Фильтр компаний', 'Company filter']) });
  const holder = el('div', {});
  const draw = (): void => {
    const q = input.value.trim().toLowerCase();
    const list = COMPANIES.filter((c) => !q || [c.symbol, c.name, c.country, countryName(c.country), regionTitle(c.region), ...(c.aliases ?? [])].join(' ').toLowerCase().includes(q));
    holder.replaceChildren(list.length ? companyTable(list) : noData(tr(['нет совпадений', 'no matches'])));
  };
  input.addEventListener('input', draw);
  draw();
  return [
    p(`${tr(['Компаний в каталоге', 'Companies in the catalogue'])}: ${COMPANIES.length}. ${tr(['Поля отрасли в данных проекта нет, поэтому группировка только по регионам и странам.', 'The project data has no sector field, so grouping is by region and country only.'])}`),
    linkRow([...REGIONS.map((r): [string, string] => [`#/region/${r.id}`, tr(r.title)]), ['#/countries', tr(['Страны', 'Countries'])], ['/dossier.html?view=screener', tr(['Скринер', 'Screener'])], ['/forecast.html#/compare', tr(['Сравнить прогнозы', 'Compare forecasts'])]]),
    input, holder,
  ];
}

interface ScreenerRow { symbol: string; currency?: string; values?: Record<string, number | null> }
interface Screener { columns?: Array<{ id: string; label: { en: string; ru: string }; unit?: string }>; rows?: ScreenerRow[] }

export function companyPage(symbol: string): Node[] | null {
  const company = COMPANIES.find((c) => c.symbol === symbol.toUpperCase());
  if (!company) return null;
  const s = enc(company.symbol);
  const peers = COMPANIES.filter((c) => c.region === company.region && c.symbol !== company.symbol);
  return [
    p(`${company.symbol} · `, a(`#/country/${company.country}`, countryName(company.country)), ' · ', a(`#/region/${company.region}`, regionTitle(company.region)),
      company.benchmark ? ` · ${tr(['бенчмарк', 'benchmark'])} ${company.benchmark}` : ''),
    cards([
      { href: `/dossier.html?symbol=${s}`, title: tr(['Досье', 'Dossier']), text: tr(['Цена, события и репутация', 'Price, events and reputation']) },
      { href: `/forecast.html#/company/${s}`, title: tr(['Прогноз', 'Forecast']), text: tr(['Коридор на 1, 5 и 20 сессий', 'Corridor for 1, 5 and 20 sessions']) },
      { href: `/dossier.html?symbol=${s}&view=metrics`, title: tr(['Метрики', 'Metrics']), text: tr(['Доходность и риск', 'Return and risk']) },
      { href: `/dossier.html?symbol=${s}&view=model`, title: tr(['Модели', 'Models']), text: tr(['GARCH, режимы, Хокс', 'GARCH, regimes, Hawkes']) },
    ]),
    h2(tr(['Показатели из скринера', 'Screener figures'])),
    live<Screener>('view=screener', (data) => {
      const row = data.rows?.find((r) => r.symbol === company.symbol);
      if (!row?.values) return null;
      return el('div', {},
        table([tr(['Показатель', 'Measure']), tr(['Значение', 'Value'])], (data.columns ?? []).map((c) => {
          const v = row.values?.[c.id];
          return [c.label[state.lang], isNum(v) ? `${num(v)}${c.unit === 'pct' ? '%' : c.unit === 'price' && row.currency ? ` ${row.currency}` : ''}` : tr(['нет данных', 'no data'])];
        })),
        linkRow([['#/model/metrics', tr(['Как считаются метрики', 'How metrics are computed'])]]));
    }),
    h2(tr(['Свежие заголовки', 'Fresh headlines'])), wireBlock(new Set([company.symbol])),
    el('p', { class: 'pg-muted' }, tr(['Здесь только общая лента; полный список событий — в досье.', 'This is the shared wire only; the full event list is in the dossier.'])),
    h2(tr(['Другие компании региона', 'Other companies of the region'])),
    linkRow(peers.map((c) => [`#/company/${enc(c.symbol)}`, c.name])),
  ];
}

interface Country { code: string; name: string; index?: number | null; low?: number; high?: number; confidence?: string; coverage?: number; rank?: number }

export function countriesPage(): Node[] {
  return [
    p(tr(['Страны компаний каталога и их индекс нестабильности (0–100, отклонение от нормы в сторону риска).', 'Countries of the catalogue companies and their instability index (0–100, deviation from normal towards risk).'])),
    live<{ countries?: Country[] }>('view=instability', (data) => {
      const by = new Map((data.countries ?? []).map((c) => [c.code, c]));
      return table([tr(['Страна', 'Country']), tr(['Компаний', 'Companies']), tr(['Индекс', 'Index']), tr(['Интервал 90%', '90% interval'])],
        COUNTRIES.map((code) => {
          const row = by.get(code);
          return [a(`#/country/${code}`, countryName(code)), String(COMPANIES.filter((c) => c.country === code).length), num(row?.index, 1), isNum(row?.low) && isNum(row?.high) ? `${num(row.low, 1)} – ${num(row.high, 1)}` : tr(['нет данных', 'no data'])];
        }));
    }),
    linkRow([['#/model/instability', tr(['Как считается индекс', 'How the index is computed'])], ['/dashboard', tr(['Карта мира', 'World map'])]]),
  ];
}

export function countryPage(code: string): Node[] | null {
  if (!COUNTRIES.includes(code)) return null;
  const list = COMPANIES.filter((c) => c.country === code);
  const regions = [...new Set(list.map((c) => c.region))];
  return [
    linkRow([...regions.map((r): [string, string] => [`#/region/${r}`, regionTitle(r)]), ['#/countries', tr(['Все страны', 'All countries'])], ['/dashboard', tr(['Карта мира', 'World map'])]]),
    h2(tr(['Индекс нестабильности', 'Instability index'])),
    live<{ countries?: Country[] }>(`view=instability`, (data) => {
      const row = data.countries?.find((c) => c.code === code);
      if (!row || !isNum(row.index)) return null;
      return table([tr(['Индекс', 'Index']), tr(['Интервал 90%', '90% interval']), tr(['Покрытие данных', 'Data coverage'])],
        [[num(row.index, 1), `${num(row.low, 1)} – ${num(row.high, 1)}`, isNum(row.coverage) ? `${num(row.coverage * 100, 0)}%` : tr(['нет данных', 'no data'])]]);
    }),
    linkRow([['#/model/instability', tr(['Формулы индекса', 'Index formulas'])]]),
    h2(tr(['Компании и котировки', 'Companies and quotes'])), companyTable(list),
    h2(tr(['Заголовки о компаниях', 'Company headlines'])), wireBlock(new Set(list.map((c) => c.symbol))),
  ];
}

// ---- models -------------------------------------------------------------------

export function modelsPage(): Node[] {
  return [
    p(tr(['Каждая модель отвечает на свой вопрос. На странице: формулы, правила, ограничения, код и место, где число видно.', 'Each model answers its own question. Its page gives formulas, rules, limits, code and where the number is shown.'])),
    cards(MODELS.map((m) => ({ href: `#/model/${m.id}`, title: tr(m.title), text: tr(m.question) }))),
    linkRow([['#/backtests', tr(['Проверки на истории', 'Backtests'])], ['#/limits', tr(['Ограничения', 'Limitations'])], ['/forecast.html#/method', tr(['Метод прогноза', 'Forecast method'])]]),
  ];
}

export function modelPage(model: Model): Node[] {
  return [
    el('p', { class: 'pg-lead' }, tr(model.question)),
    ...model.explain.map((text) => p(tr(text))),
    h2(tr(['Формулы', 'Formulas'])),
    ...model.formulas.flatMap(([label, source]) => [el('h3', {}, tr(label)), formula(source)]),
    h2(tr(['Где используется', 'Where it is used'])), ul(model.used.map(([href, label]) => a(href, tr(label)))),
    h2(tr(['Ограничения', 'Limitations'])), ul(model.limits.map((l) => tr(l))),
    h2(tr(['Код', 'Code'])), ul(model.code.map((path) => external(`https://github.com/fckmeaning/Money-Bansho/blob/main/${path}`, path))),
    h2(tr(['Связанные модели', 'Related models'])),
    linkRow(model.related.flatMap((id) => { const m = MODELS.find((x) => x.id === id); return m ? [[`#/model/${id}`, tr(m.title)] as [string, string]] : []; })),
  ];
}

// ---- data and documents -----------------------------------------------------

type Feed = { n: string; host: string; g: string; l: string; gn: boolean };
// Loaded only when a page lists feeds.
const loadFeeds = (): Promise<Feed[]> =>
  import('./feed-catalogue').then((m) => m.FEED_ROWS.map(([n, host, g, l, gn]) => ({ n, host, g, l, gn: gn === 1 })));

const GROUPS: Record<string, L> = {
  fin: ['Финансы и рынки', 'Finance and markets'], corp: ['Корпоративные', 'Corporate'], us: ['США', 'United States'], europe: ['Европа', 'Europe'],
  china: ['Китай', 'China'], israel: ['Израиль', 'Israel'], mideast: ['Ближний Восток', 'Middle East'], korea: ['КНДР и Корея', 'Korea'],
  asia: ['Азия', 'Asia'], world: ['Мир и политика', 'World and politics'], tech: ['Технологии', 'Technology'], latam: ['Латинская Америка', 'Latin America'], africa: ['Африка', 'Africa'],
};

function lazy<T>(task: Promise<T>, render: (value: T) => Node): HTMLElement {
  const box = el('div', {}, el('p', { class: 'pg-muted' }, tr(['Загрузка…', 'Loading…'])));
  task.then((value) => box.replaceChildren(render(value))).catch(() => box.replaceChildren(noData()));
  return box;
}

function feedList(group: string, limit: number): HTMLElement {
  return lazy(loadFeeds(), (feeds) => {
    const list = feeds.filter((f) => f.g === group);
    if (!list.length) return noData();
    return el('div', {},
      p(`${tr(['Лент в группе', 'Feeds in the group'])} «${GROUPS[group] ? tr(GROUPS[group]) : group}»: ${list.length}. ${list.length > limit ? `${tr(['Показаны первые', 'First shown'])} ${limit}. ` : ''}${tr(['Наличие в каталоге не означает, что лента отвечает сейчас.', 'Being listed does not mean a feed answers now.'])}`),
      table([tr(['Издание', 'Outlet']), tr(['Адрес', 'Host']), tr(['Язык', 'Language']), tr(['Способ', 'Route'])],
        list.slice(0, limit).map((f) => [f.n, f.host, f.l, f.gn ? 'Google News' : 'RSS'])));
  });
}

export function sourcesPage(): Node[] {
  return [
    p(tr(['Только бесплатные источники без ключей. При сбое показывается «нет данных».', 'Free sources without keys only. A failure reads as no data.'])),
    table([tr(['Источник', 'Source']), tr(['Что даёт', 'Provides']), tr(['Оговорка', 'Caveat'])], [
      ['Yahoo Finance', tr(['Котировки, дневные бары, индексы, валюты, лента по тикеру', 'Quotes, daily bars, indices, FX, ticker feed']), tr(['Цены без дивидендов, могут запаздывать', 'Prices without dividends, may be delayed'])],
      ['SEC EDGAR', tr(['Официальные документы компаний США', 'Official filings of US companies']), tr(['Только эмитенты SEC', 'SEC registrants only'])],
      ['Google News RSS', tr(['Поиск заголовков на разных языках', 'Headline search in several languages']), tr(['Ограниченный объём, иногда 429; условия разрешают личное некоммерческое использование', 'Limited volume, sometimes 429; terms allow personal non-commercial use'])],
      [tr(['RSS изданий', 'Publisher RSS']), tr(['Прямые ленты из каталога', 'Direct feeds from the catalogue']), tr(['Часть лент молчит или отстаёт', 'Some feeds are silent or stale'])],
      ['GDELT DOC 2.0', tr(['Справочный объём публикаций', 'Reference publication volume']), tr(['Ограничение частоты, не всегда доступен', 'Rate limited, not always available'])],
    ]),
    h2(tr(['Каталог лент по группам', 'Feed catalogue by group'])),
    lazy(loadFeeds(), (feeds) => table([tr(['Группа', 'Group']), tr(['Лент', 'Feeds'])], Object.entries(GROUPS).map(([id, label]) => [tr(label), String(feeds.filter((f) => f.g === id).length)]))),
    linkRow([['#/data/feeds', tr(['Смотреть ленты', 'Browse feeds'])], ['#/pipeline', tr(['Как обрабатываются данные', 'How data is processed'])], ['/dossier.html?symbol=NVDA&view=data', tr(['Досье: данные и процесс', 'Dossier: data and process'])]]),
  ];
}

export function feedsPage(): Node[] {
  const holder = el('div', {});
  const select = el('select', { class: 'pg-filter', 'aria-label': tr(['Группа лент', 'Feed group']) },
    ...Object.entries(GROUPS).map(([id, label]) => el('option', { value: id }, tr(label))));
  const draw = (): void => holder.replaceChildren(feedList(select.value, 500));
  select.addEventListener('change', draw);
  draw();
  return [p(tr(['Выберите группу каталога.', 'Choose a catalogue group.'])), select, holder, linkRow([['#/data', tr(['Об источниках', 'About sources'])], ['#/regions', tr(['Регионы', 'Regions'])]])];
}

export function backtestsPage(): Node[] {
  return [
    p(tr(['Отчёты о проверках на реальной истории. Это отчёты, а не гарантии.', 'Reports on checks against real history. They are reports, not guarantees.'])),
    cards([
      { href: '#/backtest/news', title: tr(['Тон новостей и репутация', 'News tone and reputation']), text: tr(['Заголовки Google News и цены: что подтверждается и что нет.', 'Google News headlines and prices: what holds and what does not.']) },
      { href: '#/backtest/real', title: tr(['Веса, коридор, VaR', 'Weights, corridor, VaR']), text: tr(['Пять лет цен и события 8-K.', 'Five years of prices and 8-K events.']) },
    ]),
    linkRow([['/forecast.html#/accuracy', tr(['Точность прогноза', 'Forecast accuracy'])], ['#/models', tr(['Модели', 'Models'])]]),
  ];
}

export function reportPage(id: string): Node[] | null {
  const src = id === 'news' ? NEWS_REPORT : id === 'real' ? REAL_REPORT : null;
  if (!src) return null;
  const summary: L[] = id === 'news' ? [
    ['Тон словаря согласуется с движением цены в те же дни, но не предсказывает следующие 1, 5 и 20 сессий. Константы не менялись.', 'Dictionary tone agrees with same-day price moves but does not predict the next 1, 5 or 20 sessions. Constants were not changed.'],
  ] : [
    ['Веса индекса внимания для цены, объёма и волатильности заменены на равные; сжатие прогноза усилено; часть проверок не выполнена из-за нехватки данных.', 'Attention weights for price, volume and volatility became equal; forecast shrinkage was strengthened; some checks lack data.'],
  ];
  return [
    ...summary.map((s) => el('p', { class: 'pg-lead' }, tr(s))),
    state.lang === 'en' ? el('p', { class: 'pg-muted' }, 'The full report below is in Russian, as written in the repository.') : el('p', { class: 'pg-muted' }, 'Полный текст отчёта из репозитория.'),
    markdown(src),
    linkRow(id === 'news' ? [['#/model/reputation', tr(['Модель репутации', 'Reputation model'])], ['#/backtest/real', tr(['Проверка на ценах', 'Price backtest'])]]
      : [['#/model/attention', tr(['Индекс внимания', 'Attention index'])], ['#/model/var-es', 'VaR / ES'], ['#/model/forecast', tr(['Коридор прогноза', 'Forecast corridor'])]]),
  ];
}

export function pipelinePage(): Node[] {
  const steps: Array<[L, L, string, L]> = [
    [['Сбор', 'Collection'], ['Котировки, документы, ленты и поиск новостей опрашиваются по запросу страницы; у каждого этапа свой лимит времени, ответы кратко кэшируются.', 'Quotes, filings, feeds and news search are polled on request; each stage has a time budget and answers are cached briefly.'], '#/data', ['Источники', 'Sources']],
    [['Отбор', 'Selection'], ['Проверяется упоминание компании, убираются торговые предложения и дубли; одинаковые сюжеты объединяются по сходству слов.', 'Company mention is checked, shopping noise and duplicates removed; same stories are clustered by word similarity.'], '#/glossary', ['Термины', 'Terms']],
    [['Разметка', 'Labelling'], ['По словарю определяются тип события (руководство, скандал, регулирование, отчётность, сделка, политика, продукт) и тон.', 'A dictionary assigns event type (leadership, scandal, regulation, earnings, deal, politics, product) and tone.'], '#/model/significance', ['Значимость', 'Significance']],
    [['Реакция цены', 'Price reaction'], ['Рыночная модель, накопленная аномальная доходность и поправка на множественные проверки.', 'Market model, cumulative abnormal return and multiple-testing correction.'], '#/model/event-study', ['Событийный анализ', 'Event study']],
    [['Модели', 'Models'], ['Волатильность, риск, режимы, связи, индекс стран.', 'Volatility, risk, regimes, links, country index.'], '#/models', ['Все модели', 'All models']],
    [['Выводы', 'Conclusions'], ['Коридор прогноза и экономические последствия по фиксированным правилам.', 'Forecast corridor and economic consequences by fixed rules.'], '#/model/consequences', ['Последствия', 'Consequences']],
    [['Показ', 'Display'], ['Досье, прогноз и карта. Заголовки по желанию переводятся; расчёты всегда по оригиналу. Чего нет — «нет данных».', 'Dossier, forecast and map. Headlines may be translated; analysis uses originals. Missing means no data.'], '/dossier.html', ['Обзор рынка', 'Market overview']],
  ];
  return [
    p(tr(['Путь от источника до экрана.', 'The path from source to screen.'])),
    table([tr(['Этап', 'Stage']), tr(['Что происходит', 'What happens']), tr(['Подробнее', 'Details'])],
      steps.map(([title, text, href, label], i) => [`${i + 1}. ${tr(title)}`, tr(text), a(href, tr(label))])),
    h2(tr(['Частота обновления', 'Refresh'])),
    p(tr(['Новости обновляются опросом (досье около 20 секунд, лента около 30), а не посекундно.', 'News is refreshed by polling (dossier about 20 s, wire about 30 s), not second by second.'])),
  ];
}

export function limitsPage(): Node[] {
  const rows: Array<[L, L]> = [
    [['Это не совет', 'Not advice'], ['Нет обещаний цены и рекомендаций покупать или продавать.', 'No price promises and no buy or sell advice.']],
    [['Причинность', 'Causation'], ['Совпадение новости и движения цены не доказывает причину.', 'A headline coinciding with a move does not prove a cause.']],
    [['Словарь', 'Dictionary'], ['Тип и тон определяются по словам: смена руководства без названия должности может не распознаться, чужие назначения иногда приписываются упомянутой компании.', 'Type and tone are keyword based: a leadership change without a job title may be missed, and appointments are sometimes attributed to a merely mentioned company.']],
    [['Всплески', 'Bursts'], ['Поиск новостей ограничен по объёму и тяготеет к свежему: всплеск может быть завышен.', 'News search is capped and favours fresh items: bursts may be overstated.']],
    [['Лицензия источника', 'Source terms'], ['Google News иногда отвечает 429; условия разрешают только личное некоммерческое использование.', 'Google News sometimes answers 429; terms allow personal non-commercial use only.']],
    [['КНДР', 'North Korea'], ['Официальных лент найти не удалось.', 'No official feeds were found.']],
    [['Веса', 'Weights'], ['Часть весов и порогов — эвристики, не подобранные на истории.', 'Some weights and thresholds are heuristics not fitted to history.']],
    [['Задержки', 'Delays'], ['Данные открытых источников могут запаздывать или отсутствовать.', 'Open-source data may be delayed or missing.']],
  ];
  return [
    table([tr(['Тема', 'Topic']), tr(['Ограничение', 'Limitation'])], rows.map(([k, v]) => [tr(k), tr(v)])),
    h2(tr(['Ограничения по моделям', 'Per-model limitations'])),
    table([tr(['Модель', 'Model']), tr(['Ограничения', 'Limitations'])], MODELS.map((m) => [a(`#/model/${m.id}`, tr(m.title)), m.limits.map((l) => tr(l)).join(' ')])),
    linkRow([['/forecast.html#/limits', tr(['Ограничения прогноза', 'Forecast limitations'])], ['#/backtests', tr(['Проверки', 'Backtests'])]]),
  ];
}

const TERMS: Array<[L, L, string]> = [
  [['Бета', 'Beta'], ['Насколько акция в среднем движется на единицу движения индекса.', 'Average stock move per unit index move.'], 'kalman'],
  [['Аномальная доходность', 'Abnormal return'], ['Доходность сверх ожидаемой по рыночной модели.', 'Return beyond the market model expectation.'], 'event-study'],
  [['CAR', 'CAR'], ['Накопленная аномальная доходность за окно.', 'Cumulative abnormal return over a window.'], 'event-study'],
  [['z-оценка', 'z score'], ['Отклонение в стандартных ошибках.', 'Deviation in standard errors.'], 'event-study'],
  [['p-значение', 'p value'], ['Вероятность не менее крайнего результата, если эффекта нет.', 'Probability of a result at least this extreme with no effect.'], 'fdr'],
  [['q-значение', 'q value'], ['p после поправки на множество проверок.', 'p after multiple-testing correction.'], 'fdr'],
  [['Волатильность', 'Volatility'], ['Разброс доходностей, обычно в годовых процентах.', 'Spread of returns, usually annualised percent.'], 'volatility'],
  [['VaR', 'VaR'], ['Потеря, которую плохой день превышает с заданной малой вероятностью.', 'Loss exceeded on a bad day with a small stated probability.'], 'var-es'],
  [['ES', 'ES'], ['Средняя потеря в хвосте за VaR.', 'Average loss in the tail beyond VaR.'], 'var-es'],
  [['Просадка', 'Drawdown'], ['Падение от предыдущего максимума.', 'Fall from the previous peak.'], 'var-es'],
  [['Шарп', 'Sharpe ratio'], ['Средняя доходность на единицу разброса.', 'Mean return per unit of spread.'], 'metrics'],
  [['Коридор 80%', '80% corridor'], ['Диапазон между квантилями 10% и 90%.', 'Range between the 10% and 90% quantiles.'], 'forecast'],
  [['Режим', 'Regime'], ['Скрытое состояние рынка: спокойное или турбулентное.', 'Hidden market state: calm or turbulent.'], 'hmm'],
  [['Полураспад', 'Half-life'], ['Время, за которое влияние уменьшается вдвое.', 'Time for an influence to halve.'], 'reputation'],
  [['Остовное дерево', 'Spanning tree'], ['Самые сильные связи без циклов.', 'Strongest links without cycles.'], 'networks'],
];

export function glossaryPage(): Node[] {
  return [table([tr(['Термин', 'Term']), tr(['Значение', 'Meaning']), tr(['Модель', 'Model'])], TERMS.map(([term, meaning, id]) => {
    const m = MODELS.find((x) => x.id === id);
    return [tr(term), tr(meaning), m ? a(`#/model/${id}`, tr(m.title)) : ''];
  }))];
}

export function aboutPage(): Node[] {
  return [
    p(tr(['Money Bansho связывает цену компании с тем, что происходило вокруг неё: экономика, политика, смена руководителей, репутация и свежие новости. Поверх — математические модели с открытыми формулами.', 'Money Bansho links a company’s price to what happened around it: economy, politics, leadership changes, reputation and fresh news, with open-formula models on top.'])),
    cards([
      { href: '/welcome.html', title: tr(['Главная', 'Start page']), text: tr(['С чего начать', 'Where to begin']) },
      { href: '/forecast.html#/', title: tr(['Прогноз', 'Forecast']), text: tr(['Главная функция проекта', 'The main feature']) },
      { href: '/dossier.html', title: tr(['Досье и обзор рынка', 'Dossier and market overview']), text: tr(['Компании и события', 'Companies and events']) },
      { href: '/dashboard', title: tr(['Карта мира', 'World map']), text: tr(['Геополитический фон', 'Geopolitical background']) },
      { href: '/terminal', title: tr(['Терминал', 'Terminal']), text: tr(['Режим командной строки', 'Command line mode']) },
    ]),
    el('details', {}, el('summary', {}, tr(['О проекте и лицензия', 'About and licence'])),
      el('p', { lang: 'en' }, 'Money Bansho is based on ', external('https://github.com/koala73/worldmonitor', 'World Monitor'), ', © 2026 Elie Habib. Licensed under AGPL-3.0, without any warranty. ',
        external('https://github.com/fckmeaning/Money-Bansho', 'Source code'), ' · ', external('https://github.com/fckmeaning/Money-Bansho/blob/main/LICENSE', 'Licence text (AGPL-3.0)'))),
  ];
}

/** Warms the answer the home and company pages need most. */
export const prefetch = (): void => { void api('view=board').catch(() => {}); };
