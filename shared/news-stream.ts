/**
 * Compact list of every record the digest build reviewed (before the
 * per-category display cap). Analytics panels count these real records.
 */
export interface NewsStreamRow {
  /** headline */
  t: string;
  /** feed name */
  s: string;
  /** article link ('' when the publisher gate removed it) */
  u: string;
  /** publication time, ms */
  p: number;
  /** keyword or classifier threat level */
  l: string;
  /** digest category */
  c: string;
  /** alert flag */
  a: boolean;
}

export const NEWS_STREAM_MAX_ROWS = 2500;

interface StreamSourceItem {
  title: string;
  source: string;
  link: string;
  publishedAt: number;
  level: string;
  isAlert: boolean;
}

/** One row per distinct article (same link or headline counts once), newest first. */
export function buildNewsStream(
  groups: Iterable<[string, StreamSourceItem[]]>,
  excludedLinks: ReadonlySet<string> = new Set(),
): NewsStreamRow[] {
  const seen = new Set<string>();
  const rows: NewsStreamRow[] = [];
  for (const [category, items] of groups) {
    for (const item of items) {
      if (item.link && excludedLinks.has(item.link)) continue;
      const key = item.link || item.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push({
        t: item.title,
        s: item.source,
        u: item.link,
        p: item.publishedAt,
        l: String(item.level),
        c: category,
        a: Boolean(item.isAlert),
      });
    }
  }
  return rows.sort((a, b) => b.p - a.p).slice(0, NEWS_STREAM_MAX_ROWS);
}
