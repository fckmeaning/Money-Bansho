// The regional news panels Money Bansho adds. Their sources are curated per
// panel and do not spend the free-tier source cap, so the cap never hides them.
export const EXPANSION_FEED_CATEGORIES = [
  'china-media',
  'europe-business',
  'israel',
  'north-korea',
  'corporate-leadership',
] as const;

export function isExpansionFeedCategory(category: string): boolean {
  return (EXPANSION_FEED_CATEGORIES as readonly string[]).includes(category);
}
