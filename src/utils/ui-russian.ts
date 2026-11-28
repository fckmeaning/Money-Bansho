/** Interface language as set on the document; safe where the i18n module is stubbed. */
export function uiRussian(): boolean {
  return typeof document !== 'undefined' && String(document.documentElement?.lang ?? '').startsWith('ru');
}
