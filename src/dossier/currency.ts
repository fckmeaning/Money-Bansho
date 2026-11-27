// Yahoo quotes a few exchanges in a minor unit: Tel Aviv in agorot (ILA), London
// in pence (GBp, GBX), Johannesburg in cents (ZAc). The numbers are exact; only
// the unit is easy to misread as the major currency, so it is spelled out.
const MINOR_UNITS = new Map<string, { major: string; ru: string; en: string }>([
  ['ILA', { major: 'ILS', ru: 'агорот', en: 'agorot' }],
  ['GBp', { major: 'GBP', ru: 'пенсы', en: 'pence' }],
  ['GBX', { major: 'GBP', ru: 'пенсы', en: 'pence' }],
  ['ZAc', { major: 'ZAR', ru: 'центы', en: 'cents' }],
]);

export function currencyLabel(code: string, lang: 'en' | 'ru'): string {
  const unit = MINOR_UNITS.get(code);
  return unit ? `${code} (${unit[lang]}, 1/100 ${unit.major})` : code;
}
