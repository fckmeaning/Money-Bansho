/**
 * Crawlable site surfaces linked from the dashboard chrome (#10461).
 *
 * The dashboard itself is a non-scrolling SPA shell, so these destinations live
 * on marketing/content pages. The compact dashboard footer no longer hosts the
 * full link row; Settings and the mobile More menu do. Keep this list as the
 * single source for both surfaces so desktop and mobile stay in parity.
 */
export const DASHBOARD_REFERENCE_LINKS = [
  { label: 'Countries', path: '/countries/' },
  { label: 'Chokepoints', path: '/chokepoints/' },
  { label: 'Crises', path: '/crises/' },
  { label: 'Tools', path: '/tools/' },
  { label: 'Accuracy', path: '/accuracy/' },
] as const;

/** Absolute origin used when the dashboard runs on a production hostname. */
export const DASHBOARD_SITE_ORIGIN = 'https://www.worldmonitor.app';

/**
 * Absolute www origin for desktop/public hosts; empty for local and self-hosted
 * installs so Countries/Chokepoints/… resolve against the served corpus.
 */
export function resolveDashboardSiteOrigin(options: {
  isDesktopApp: boolean;
  hostname: string;
}): string {
  return options.isDesktopApp || options.hostname.endsWith('.worldmonitor.app')
    ? DASHBOARD_SITE_ORIGIN
    : '';
}

export const DASHBOARD_EXTERNAL_SITE_LINKS = [
  { label: 'Source', href: 'https://github.com/fckmeaning/Money-Bansho' },
  { label: 'World Monitor (upstream)', href: 'https://github.com/koala73/worldmonitor' },
] as const;
