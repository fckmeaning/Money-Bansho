// Locale-aware formatting for the analytics views. `lang` is passed explicitly so
// a view stays in the language it was built with.
import { exchangeDay } from '../zone';

export type Lang = 'en' | 'ru';
export type Unit = 'pct' | 'ratio' | 'num' | 'price' | 'days' | 'money';

const MINUS = '−';

export const localeOf = (lang: Lang): string => (lang === 'ru' ? 'ru-RU' : 'en-US');

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function formatter(lang: Lang, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${lang}${JSON.stringify(options)}`;
  let cached = numberFormats.get(key);
  if (!cached) {
    cached = new Intl.NumberFormat(localeOf(lang), options);
    numberFormats.set(key, cached);
  }
  return cached;
}

export function num(value: number, lang: Lang, min = 0, max = 2): string {
  const text = formatter(lang, { minimumFractionDigits: min, maximumFractionDigits: max }).format(Math.abs(value));
  const negative = value < 0 && /[1-9]/.test(text);
  return negative ? `${MINUS}${text}` : text;
}

export function compact(value: number, lang: Lang): string {
  const text = formatter(lang, { notation: 'compact', maximumFractionDigits: 2 }).format(Math.abs(value));
  return value < 0 && /[1-9]/.test(text) ? `${MINUS}${text}` : text;
}

function digitsFor(value: number, unit: Unit): [number, number] {
  const size = Math.abs(value);
  switch (unit) {
    case 'pct':
      return size >= 1000 ? [0, 0] : size >= 100 ? [1, 1] : [2, 2];
    case 'ratio':
      return size >= 100 ? [1, 1] : size > 0 && size < 0.01 ? [4, 4] : [2, 2];
    case 'price':
      return size >= 10_000 ? [0, 0] : size > 0 && size < 1 ? [4, 4] : [2, 2];
    case 'days':
      return [0, 1];
    default:
      return size > 0 && size < 0.01 ? [0, 5] : [0, 2];
  }
}

export function formatValue(value: number, unit: Unit, lang: Lang, signed = false): string {
  let body: string;
  if (unit === 'money' || (unit === 'num' && Math.abs(value) >= 100_000)) {
    body = compact(value, lang);
  } else {
    const [min, max] = digitsFor(value, unit);
    body = num(value, lang, min, max);
  }
  if (signed && value > 0 && /[1-9]/.test(body)) body = `+${body}`;
  if (unit === 'pct') return `${body}%`;
  if (unit === 'days') return `${body} ${lang === 'ru' ? 'дн.' : 'd'}`;
  return body;
}

export const pct = (value: number, lang: Lang, signed = true): string => formatValue(value, 'pct', lang, signed);

function dated(lang: Lang, key: string, options: Intl.DateTimeFormatOptions, time: number): string {
  const id = `${lang}${key}`;
  let cached = dateFormats.get(id);
  if (!cached) {
    cached = new Intl.DateTimeFormat(localeOf(lang), options);
    dateFormats.set(id, cached);
  }
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? '—' : cached.format(date);
}

/**
 * Daily bars are labelled by the exchange's calendar date, so it does not shift with the
 * viewer. The formatter stays in UTC: `exchangeDay` moves the stamp onto the local date.
 */
export const dayLabel = (time: number, lang: Lang): string =>
  dated(lang, 'day', { day: 'numeric', month: 'short', timeZone: 'UTC' }, exchangeDay(time));

export const monthYear = (time: number, lang: Lang): string =>
  dated(lang, 'my', { month: 'short', year: '2-digit', timeZone: 'UTC' }, exchangeDay(time));

export const fullDate = (time: number, lang: Lang): string =>
  dated(lang, 'full', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }, exchangeDay(time));

export const dateTime = (time: number, lang: Lang): string =>
  dated(lang, 'dt', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, time);

export function monthName(month: number, lang: Lang): string {
  return dated(lang, 'm', { month: 'short', timeZone: 'UTC' }, Date.UTC(2001, month - 1, 15)).replace('.', '');
}
