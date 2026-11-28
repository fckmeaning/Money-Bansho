// Russian headlines. The API adds `titleRu` when asked with ?tl=ru; here it takes
// the place of `title`, and the source's own wording stays in `originalTitle`.
import { uiLang } from './i18n';

export const translationQuery = (): Record<string, string> => (uiLang() === 'ru' ? { tl: 'ru' } : {});

export function localizeHeadlines(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    if (typeof item.titleRu === 'string' && typeof item.title === 'string' && item.originalTitle === undefined) {
      item.originalTitle = item.title;
      item.title = item.titleRu;
    }
  }
  for (const child of Object.values(value)) localizeHeadlines(child);
}
