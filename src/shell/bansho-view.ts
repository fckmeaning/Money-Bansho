// View switches of the navigation menu: colour theme and page scale. Both are
// stored per browser and applied as attributes on <html>.
import { getCurrentTheme, setThemePreference } from '../utils/theme-manager';

export type BanshoTheme = 'dark' | 'light';
export type BanshoScale = 'small' | 'normal' | 'large';

const THEME_KEY = 'worldmonitor-theme';
const SCALE_KEY = 'bansho-scale';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function currentScale(): BanshoScale {
  const value = document.documentElement.dataset.scale;
  return value === 'small' || value === 'large' ? value : 'normal';
}

export const currentTheme = (): BanshoTheme => getCurrentTheme();

export function setBanshoTheme(theme: BanshoTheme): void {
  setThemePreference(theme);
}

export function setBanshoScale(scale: BanshoScale): void {
  document.documentElement.dataset.scale = scale;
  try {
    window.localStorage.setItem(SCALE_KEY, scale);
  } catch {
    // Storage blocked: the choice lasts until the page is closed.
  }
}

/** Applies the stored choices; safe to call on every page mount. */
export function applyStoredView(): void {
  const theme = read(THEME_KEY);
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  const scale = read(SCALE_KEY);
  if (scale === 'small' || scale === 'large') document.documentElement.dataset.scale = scale;
}
