import { safeStorageGet, safeStorageSet } from '../utils/safe-storage';
import { EN_QUANT, RU_QUANT } from './i18n-quant';
import type { EventType, Range } from './types';

export type UiLang = 'en' | 'ru';
const STORAGE_KEY = 'money-bansho-dossier-lang';

const EN = {
  ...EN_QUANT,
  subtitle: 'Company dossier',
  liveWire: 'Live wire',
  dashboard: 'Dashboard',
  companies: 'Companies',
  search: 'Search name, ticker, alias',
  all: 'All',
  us: 'US',
  china: 'China',
  europe: 'Europe',
  israel: 'Israel',
  korea: 'Korea',
  other: 'Other',
  noMatch: 'No company matches.',
  openSymbol: 'Open symbol',
  listCount: '{n} companies',
  quotesNoData: 'quotes: no data',
  noData: 'no data',
  loading: 'Loading…',
  loadingSymbol: 'Loading {symbol}…',
  retry: 'Retry',
  updated: 'updated {age} ago',
  stale: 'Update failed; showing earlier data.',
  errTimeout: 'The request timed out.',
  errNetwork: 'Network error: the data service could not be reached.',
  errInvalid: 'The data service returned an unreadable response.',
  errHttp: 'The data service returned HTTP {status}.',
  errSymbol: 'Symbol was not accepted: {detail}',
  loadFailed: 'Could not load data',
  sourceIssues: 'Source issues',
  asOf: 'as of {time}',
  rangeChange: 'Range change',
  high: 'High close',
  low: 'Low close',
  volume: 'Last volume',
  eventsStat: 'Events',
  priceTitle: 'Price and events',
  range1mo: '1M',
  range3mo: '3M',
  range1y: '1Y',
  noPrices: 'No price data for this range.',
  close: 'Close',
  day: 'Day',
  fromStart: 'Range',
  vol: 'Vol',
  moreItems: '+{n} more',
  offChart: '{n} events predate the chart range',
  chartAria: 'Closing price of {symbol} with event markers',
  reputation: 'Reputation score',
  repExplain:
    'Automated score from headline sentiment over the last 90 days; 50 is neutral. Recent items weigh more, with a half-life that depends on the event type; leadership, scandal and regulation items count for more.',
  repSample: 'Headlines scored',
  repTrend: 'vs 7 days ago',
  repNone: 'No data: no headlines to score.',
  drivers: 'Top drivers',
  noDrivers: 'No individual drivers reported.',
  driverGone: 'Headline not in the current list',
  leadership: 'Leadership changes',
  noLeadership: 'No leadership headlines in the current feed.',
  allInTimeline: 'All {n} in the timeline',
  movesTitle: 'What moved the price',
  movesNote:
    'The 5 largest daily closes-to-close moves in the selected range, with news published from the previous session to that day. Closeness in time is not proof of cause.',
  noMatchingNews: 'no matching news',
  noMoves: 'Not enough price history.',
  timeline: 'Event timeline',
  noEvents: 'No events found for this company.',
  noEventsFiltered: 'No events of the selected types.',
  colTime: 'Time',
  colType: 'Type',
  colHeadline: 'Headline',
  colSent: 'Sent.',
  colMove: 'Move',
  colAbn: 'Abn.',
  colSentHint: 'Headline sentiment, −1 to +1',
  colMoveHint: 'Last close before the news to the first close after it',
  colAbnHint: 'The same move minus the benchmark index move',
  newSince: '{n} new since opened',
  showMore: 'Show {n} more',
  radar: 'Leadership change radar',
  radarEmpty: 'No leadership headlines across tracked companies right now.',
  latest: 'Latest events across companies',
  fromWire: 'Opened from the live wire',
  wireEmpty: 'No events in the wire right now.',
  movers: 'Biggest movers',
  gainers: 'Up',
  losers: 'Down',
  moversEmpty: 'No quotes available.',
  colCompany: 'Company',
  colDay: 'Day',
  source: 'Source',
  basedOn: 'Based on',
  disclaimer: 'Automated headline analysis. Not investment advice.',
  t_leadership: 'Leadership',
  t_politics: 'Politics',
  t_regulation: 'Regulation',
  t_earnings: 'Earnings',
  t_deal: 'Deal',
  t_scandal: 'Scandal',
  t_product: 'Product',
  t_other: 'Other',
};

export type Key = keyof typeof EN;

const RU: Record<Key, string> = {
  ...RU_QUANT,
  subtitle: 'Досье компании',
  liveWire: 'Лента',
  dashboard: 'Панель',
  companies: 'Компании',
  search: 'Название, тикер, псевдоним',
  all: 'Все',
  us: 'США',
  china: 'Китай',
  europe: 'Европа',
  israel: 'Израиль',
  korea: 'Корея',
  other: 'Другие',
  noMatch: 'Компании не найдены.',
  openSymbol: 'Открыть тикер',
  listCount: 'Компаний: {n}',
  quotesNoData: 'котировки: нет данных',
  noData: 'нет данных',
  loading: 'Загрузка…',
  loadingSymbol: 'Загрузка {symbol}…',
  retry: 'Повторить',
  updated: 'обновлено {age} назад',
  stale: 'Обновление не удалось; показаны прежние данные.',
  errTimeout: 'Время ожидания ответа истекло.',
  errNetwork: 'Ошибка сети: сервис данных недоступен.',
  errInvalid: 'Сервис данных вернул нечитаемый ответ.',
  errHttp: 'Сервис данных вернул HTTP {status}.',
  errSymbol: 'Тикер не принят: {detail}',
  loadFailed: 'Не удалось загрузить данные',
  sourceIssues: 'Проблемы источников',
  asOf: 'на {time}',
  rangeChange: 'За период',
  high: 'Макс. закрытие',
  low: 'Мин. закрытие',
  volume: 'Посл. объём',
  eventsStat: 'Событий',
  priceTitle: 'Цена и события',
  range1mo: '1М',
  range3mo: '3М',
  range1y: '1Г',
  noPrices: 'Нет ценовых данных за этот период.',
  close: 'Закр.',
  day: 'День',
  fromStart: 'Период',
  vol: 'Объём',
  moreItems: 'ещё {n}',
  offChart: 'Событий раньше периода графика: {n}',
  chartAria: 'Цена закрытия {symbol} с отметками событий',
  reputation: 'Оценка репутации',
  repExplain:
    'Автоматическая оценка по тональности заголовков за 90 дней; 50 — нейтрально. Свежие новости весят больше, срок полураспада зависит от типа события; руководство, скандалы и регулирование учитываются сильнее.',
  repSample: 'Заголовков учтено',
  repTrend: 'к 7 дням назад',
  repNone: 'Нет данных: нечего оценивать.',
  drivers: 'Главные факторы',
  noDrivers: 'Отдельные факторы не указаны.',
  driverGone: 'Заголовка нет в текущем списке',
  leadership: 'Кадровые изменения',
  noLeadership: 'Нет заголовков о руководстве в текущей выборке.',
  allInTimeline: 'Все {n} в хронологии',
  movesTitle: 'Что двигало цену',
  movesNote:
    '5 крупнейших дневных изменений цены закрытия за период и новости, вышедшие с предыдущей сессии по этот день. Совпадение по времени не доказывает причину.',
  noMatchingNews: 'подходящих новостей нет',
  noMoves: 'Недостаточно истории цен.',
  timeline: 'Хронология событий',
  noEvents: 'События по компании не найдены.',
  noEventsFiltered: 'Нет событий выбранных типов.',
  colTime: 'Время',
  colType: 'Тип',
  colHeadline: 'Заголовок',
  colSent: 'Тон',
  colMove: 'Движ.',
  colAbn: 'Аном.',
  colSentHint: 'Тональность заголовка, от −1 до +1',
  colMoveHint: 'От закрытия до новости к первому закрытию после неё',
  colAbnHint: 'То же изменение за вычетом изменения индекса-ориентира',
  newSince: 'Новых с открытия: {n}',
  showMore: 'Показать ещё {n}',
  radar: 'Радар кадровых изменений',
  radarEmpty: 'Сейчас нет заголовков о руководстве по отслеживаемым компаниям.',
  latest: 'Последние события по компаниям',
  fromWire: 'Открыто из ленты',
  wireEmpty: 'Сейчас в ленте нет событий.',
  movers: 'Лидеры движения',
  gainers: 'Рост',
  losers: 'Падение',
  moversEmpty: 'Котировки недоступны.',
  colCompany: 'Компания',
  colDay: 'День',
  source: 'Исходный код',
  basedOn: 'На основе',
  disclaimer: 'Автоматический анализ заголовков. Не является инвестиционной рекомендацией.',
  t_leadership: 'Руководство',
  t_politics: 'Политика',
  t_regulation: 'Регулир.',
  t_earnings: 'Отчётность',
  t_deal: 'Сделки',
  t_scandal: 'Скандал',
  t_product: 'Продукт',
  t_other: 'Прочее',
};

const initial = (): UiLang => {
  const param = new URLSearchParams(location.search).get('lang');
  const value = param ?? safeStorageGet(STORAGE_KEY);
  // Интерфейс по умолчанию русский; английский только по явному выбору (?lang=en или сохранённый).
  return value === 'en' ? 'en' : 'ru';
};

let current: UiLang = initial();

export const uiLang = (): UiLang => current;
export const locale = (): string => (current === 'ru' ? 'ru-RU' : 'en-US');

export function setUiLang(lang: UiLang): void {
  current = lang;
  safeStorageSet(STORAGE_KEY, lang);
}

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  const text = (current === 'ru' ? RU : EN)[key];
  return text.replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match));
}

const RU_LABELS: Record<string, string> = {
  Positive: 'Позитивная',
  'Leaning positive': 'Скорее позитивная',
  Neutral: 'Нейтральная',
  'Leaning negative': 'Скорее негативная',
  Negative: 'Негативная',
};
/** Score labels come from the API in English; unknown ones are shown as sent. */
export const scoreLabel = (label: string): string => (current === 'ru' ? (RU_LABELS[label] ?? label) : label);

export const typeName = (type: EventType): string => t(`t_${type}`);
export const rangeName = (range: Range): string => t(`range${range}`);
export function regionName(region: string): string {
  return region === 'us' || region === 'china' || region === 'europe' || region === 'israel' || region === 'korea'
    ? t(region)
    : t('other');
}
