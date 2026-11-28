// Money Bansho has no variant switcher. A variant stored by an earlier visit
// (for example Good News, which turns the dashboard and map light and green)
// would otherwise be permanent. Import this before anything that reads
// SITE_VARIANT. Variant builds, upstream hostnames and desktop are left alone.
import { isDesktopRuntime } from '@/config/desktop-runtime';

const VARIANT_KEY = 'worldmonitor-variant';

try {
  const buildVariant = import.meta.env.VITE_VARIANT || 'full';
  if (
    buildVariant === 'full'
    && !isDesktopRuntime()
    && !/(^|\.)worldmonitor\.app$/.test(window.location.hostname)
  ) {
    const stored = window.localStorage.getItem(VARIANT_KEY);
    if (stored && stored !== buildVariant) {
      window.localStorage.setItem(VARIANT_KEY, buildVariant);
      // The prepaint script in index.html already applied the stored variant.
      delete document.documentElement.dataset.variant;
      const theme = window.localStorage.getItem('worldmonitor-theme');
      if (theme !== 'light' && theme !== 'auto') document.documentElement.dataset.theme = 'dark';
    }
  }
} catch {
  // Storage blocked: nothing was stored, so the build variant applies anyway.
}
