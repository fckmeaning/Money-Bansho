// Dashboard side of the navigation menu's section jumps: either an in-page
// BANSHO_SECTION_EVENT or a `?section=` link from another page.
import { BANSHO_SECTION_EVENT, type BanshoSection } from '@/shell/bansho-menu';

const SECTION_PANELS: Record<BanshoSection, string> = {
  map: 'map',
  markets: 'markets',
  news: 'politics',
  corporate: 'corporate-leadership',
  china: 'china-media',
  europe: 'europe-business',
  israel: 'israel',
  'north-korea': 'north-korea',
};

const WAIT_STEP_MS = 150;
const WAIT_STEPS = 60;
// Panels above the target keep mounting for a moment and push it away.
const SETTLE_SCROLLS_MS = [600, 1500, 3000];

const isSection = (value: unknown): value is BanshoSection =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SECTION_PANELS, value);

function readSectionParam(): BanshoSection | null {
  if (typeof window === 'undefined' || !window.location?.search) return null;
  const value = new URLSearchParams(window.location.search).get('section');
  return isSection(value) ? value : null;
}

// Read at import time: the dashboard rewrites its URL from map state at boot.
let pendingSection = readSectionParam();

export interface BanshoSectionDeps {
  /** Enables a panel the user disabled; false when it cannot be shown. */
  enablePanel(panelId: string): boolean;
}

export function installBanshoSectionJumps(deps: BanshoSectionDeps): () => void {
  const listeners = new AbortController();
  const timers = new Set<number>();
  let jumpListeners: AbortController | null = null;

  const later = (run: () => void, delay: number): void => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      run();
    }, delay);
    timers.add(id);
  };

  const cancelJump = (): void => {
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    jumpListeners?.abort();
    jumpListeners = null;
  };

  const findTarget = (panelId: string): HTMLElement | null =>
    panelId === 'map'
      ? document.getElementById('mapSection')
      : document.querySelector<HTMLElement>(`.main-content [data-panel="${panelId}"]`);

  const present = (element: HTMLElement): void => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  };

  const jump = (section: BanshoSection): void => {
    cancelJump();
    const panelId = SECTION_PANELS[section];
    // A fullscreen map covers the panel grid.
    if (panelId !== 'map' && document.getElementById('mapSection')?.classList.contains('live-news-fullscreen')) {
      document.getElementById('mapFullscreenBtn')?.click();
    }
    if (!deps.enablePanel(panelId)) return;
    if (panelId === 'map' && document.getElementById('mapSection')?.classList.contains('collapsed')) {
      document.querySelector<HTMLButtonElement>('.map-collapse-btn')?.click();
    }
    // Lift a mobile category filter that excludes the panel.
    window.dispatchEvent(new CustomEvent('wm:reveal-panel', { detail: { panelId } }));

    // Stop re-scrolling as soon as the reader takes over.
    jumpListeners = new AbortController();
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      window.addEventListener(type, cancelJump, { capture: true, passive: true, signal: jumpListeners.signal });
    }

    let steps = 0;
    const wait = (): void => {
      const target = findTarget(panelId);
      if (target) present(target);
      if (target && !target.hasAttribute('data-deferred-panel')) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
        for (const delay of SETTLE_SCROLLS_MS) {
          later(() => {
            const settled = findTarget(panelId);
            if (settled) present(settled);
          }, delay);
        }
        return;
      }
      if (++steps < WAIT_STEPS) later(wait, WAIT_STEP_MS);
    };
    wait();
  };

  window.addEventListener(BANSHO_SECTION_EVENT, (event) => {
    const section = (event as CustomEvent<{ section?: unknown }>).detail?.section;
    if (!isSection(section)) return;
    event.preventDefault();
    jump(section);
  }, { signal: listeners.signal });

  if (pendingSection) {
    const section = pendingSection;
    pendingSection = null;
    const url = new URL(window.location.href);
    url.searchParams.delete('section');
    window.history.replaceState(window.history.state, '', url);
    later(() => jump(section), 0);
  }

  return () => {
    cancelJump();
    listeners.abort();
  };
}
