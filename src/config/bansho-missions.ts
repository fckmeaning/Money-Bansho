// Money Bansho shows only panels with a working source (see ./bansho-panels), so
// each task lists its own panels from that set. Map layers, region and time range
// stay those of the task. The map comes first.
export const BANSHO_MISSION_PANELS: Readonly<Record<string, readonly string[]>> = {
  'crisis-desk': ['map', 'live-news', 'threat-timeline', 'insights', 'security-advisories', 'middleeast', 'europe', 'israel', 'north-korea', 'politics', 'gov'],
  'supply-chain-risk': ['map', 'commodities', 'markets', 'energy', 'china-media', 'asia', 'europe-business', 'middleeast', 'threat-timeline'],
  'energy-security': ['map', 'energy', 'commodities', 'markets', 'middleeast', 'europe', 'europe-business', 'threat-timeline'],
  'osint-newsroom': ['map', 'live-news', 'live-webcams', 'politics', 'us', 'europe', 'middleeast', 'africa', 'latam', 'asia', 'china-media', 'israel', 'north-korea', 'security-advisories'],
  'macro-market-watch': ['map', 'markets', 'finance', 'commodities', 'crypto', 'corporate-leadership', 'europe-business', 'energy', 'layoffs', 'insights'],
  'tech-ai-watch': ['map', 'tech', 'ai', 'layoffs', 'corporate-leadership', 'markets', 'insights', 'monitors'],
  'country-watcher': ['map', 'live-news', 'politics', 'gov', 'thinktanks', 'china-media', 'israel', 'north-korea', 'security-advisories', 'disease-outbreaks', 'world-clock', 'monitors'],
};
