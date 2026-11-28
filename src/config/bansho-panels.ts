// Money Bansho runs without keys: only panels with a working keyless source are
// shown. Everything else is switched off, including in layouts saved earlier.
// Stored keys and the user's panel order stay as they are.
const WORKING_PANELS = new Set([
  'map', 'live-news', 'live-webcams',
  'markets', 'finance', 'commodities',
  'insights', 'threat-timeline',
  'politics', 'us', 'europe', 'middleeast', 'africa', 'latam', 'asia',
  'china-media', 'europe-business', 'israel', 'north-korea', 'corporate-leadership',
  'energy', 'gov', 'thinktanks', 'tech', 'ai', 'layoffs',
  'monitors', 'world-clock',
  // Fed by api/_live-seeds.js from public no-key sources.
  'crypto', 'disease-outbreaks', 'security-advisories',
]);

export function isBanshoPanelAvailable(key: string): boolean {
  return WORKING_PANELS.has(key);
}

// Layouts saved while a panel was switched off keep `enabled: false`; switch
// restored panels back on once, then respect the viewer's own choice.
const RESTORED = [
  ['live-webcams', 'bansho-webcams-restored'],
  ['insights', 'bansho-insights-restored'],
  ['threat-timeline', 'bansho-threat-timeline-restored'],
  ['crypto', 'bansho-crypto-restored'],
  ['disease-outbreaks', 'bansho-disease-outbreaks-restored'],
  ['security-advisories', 'bansho-security-advisories-restored'],
] as const;

function restoreOnce(settings: Record<string, { enabled: boolean }>): void {
  for (const [key, marker] of RESTORED) {
    const panel = settings[key];
    if (!panel) continue;
    try {
      if (localStorage.getItem(marker)) continue;
      localStorage.setItem(marker, '1');
    } catch {
      return;
    }
    panel.enabled = true;
  }
}

export function disableBanshoUnavailablePanels(settings: Record<string, { enabled: boolean }>): void {
  restoreOnce(settings);
  for (const [key, config] of Object.entries(settings)) {
    if (!isBanshoPanelAvailable(key)) config.enabled = false;
  }
}
