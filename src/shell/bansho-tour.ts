// Two-minute guided demo: walks through the real pages of the product, scrolls
// each one and explains it in a caption bar. It shows only what the pages show.
// Dossier steps switch in place; moving to or from the dashboard reloads the
// page, so the position is kept in sessionStorage and resumed on mount.
import './bansho-tour.css';

type Lang = 'en' | 'ru';

interface Step {
  url: string;
  seconds: number;
  en: [string, string];
  ru: [string, string];
}

const COMPANY = '/dossier.html?symbol=NVDA';

/** Durations add up to 120 seconds. */
const STEPS: readonly Step[] = [
  {
    url: '/dossier.html',
    seconds: 13,
    en: ['Market overview', 'Map of tracked companies, regional charts, risk against return and the live headlines.'],
    ru: ['Обзор рынка', 'Карта компаний, графики по регионам, риск и доходность, свежие заголовки.'],
  },
  {
    url: '/forecast.html',
    seconds: 14,
    en: ['Forecast: the main feature', 'How far a price can move over 1, 5 and 20 sessions, with accuracy on held-out history. Direction is not forecast.'],
    ru: ['Прогноз — главное', 'Насколько далеко может уйти цена за 1, 5 и 20 сессий и точность на отложенной истории. Направление не прогнозируется.'],
  },
  {
    url: '/forecast.html#/scenarios/NVDA',
    seconds: 12,
    en: ['News scenario', 'A headline type can widen the corridor by a factor measured on past events. The centre does not move.'],
    ru: ['Сценарий новости', 'Тип новости может расширить коридор на множитель, измеренный на прошлых событиях. Центр не сдвигается.'],
  },
  {
    url: COMPANY,
    seconds: 14,
    en: ['Company dossier', 'Price with dated events on the chart and a reputation score with its main factors.'],
    ru: ['Досье компании', 'Цена с датированными событиями на графике и оценка репутации с главными факторами.'],
  },
  {
    url: `${COMPANY}&view=events`,
    seconds: 12,
    en: ['Events', 'Each event has a source, a date, the price move around it and its economic consequences.'],
    ru: ['События', 'У каждого события источник, дата, движение цены вокруг него и экономические последствия.'],
  },
  {
    url: `${COMPANY}&view=metrics`,
    seconds: 10,
    en: ['Metrics', 'Return, risk, liquidity and correlation measures computed from daily prices.'],
    ru: ['Метрики', 'Доходность, риск, ликвидность и корреляции, посчитанные по дневным ценам.'],
  },
  {
    url: `${COMPANY}&view=model`,
    seconds: 11,
    en: ['Mathematics', 'The models with their formulas and the numbers that went into them.'],
    ru: ['Математика', 'Модели с формулами и числами, которые в них подставлены.'],
  },
  {
    url: '/dossier.html?view=screener',
    seconds: 10,
    en: ['Screener', 'All companies compared side by side.'],
    ru: ['Скринер', 'Все компании в сравнении.'],
  },
  {
    url: '/dossier.html?view=world',
    seconds: 10,
    en: ['World events', 'Major events ranked by significance together with the market reaction.'],
    ru: ['Мир', 'Главные события по значимости и реакция рынков.'],
  },
  {
    url: '/dashboard',
    seconds: 14,
    en: ['World map', 'Geopolitical layers, country scores and economic changes on one screen.'],
    ru: ['Карта мира', 'Геополитические слои, оценки стран и изменения в экономике на одном экране.'],
  },
];

const TOTAL = STEPS.reduce((sum, step) => sum + step.seconds, 0);

const LABELS = {
  en: { back: 'Back', next: 'Next', pause: 'Pause', resume: 'Resume', stop: 'Stop', loading: 'Loading data', name: 'Demo tour' },
  ru: { back: 'Назад', next: 'Дальше', pause: 'Пауза', resume: 'Продолжить', stop: 'Стоп', loading: 'Загружаются данные', name: 'Демонстрация' },
};

const KEY = 'bansho-tour';
const TICK_MS = 100;
/** A step starts counting when the page has data, or after this long. */
const MAX_WAIT_MS = 6000;
const LOADING_RE = /Загрузка|Загружается|Loading/;

interface Saved {
  index: number;
  paused: boolean;
}

let stopActive: (() => void) | null = null;

function save(state: Saved | null): void {
  try {
    if (state) window.sessionStorage.setItem(KEY, JSON.stringify(state));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the tour cannot survive a page load.
  }
}

function load(): Saved | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null') as Saved | null;
    if (!value || !Number.isInteger(value.index) || !STEPS[value.index]) return null;
    return { index: value.index, paused: value.paused === true };
  } catch {
    return null;
  }
}

const pageOf = (url: string): string => new URL(url, window.location.origin).pathname.replace(/\.html$/, '');

function isAt(url: string): boolean {
  const target = new URL(url, window.location.origin);
  if (pageOf(url) !== pageOf(window.location.href)) return false;
  // The forecast section routes by the fragment.
  if (pageOf(url) === '/forecast') return target.hash === window.location.hash;
  // The dashboard rewrites its own query string, so only the path matters there.
  if (pageOf(url) === '/dashboard') return true;
  const now = new URLSearchParams(window.location.search);
  return ['symbol', 'view'].every((name) => now.get(name) === target.searchParams.get(name));
}

/** Switches in place inside the dossier; otherwise loads the page. */
function go(url: string): boolean {
  if (isAt(url)) return true;
  if (pageOf(url) === '/forecast' && pageOf(window.location.href) === '/forecast') {
    window.location.hash = new URL(url, window.location.origin).hash;
    return true;
  }
  if (pageOf(url) === '/dossier' && pageOf(window.location.href) === '/dossier') {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
    return true;
  }
  window.location.assign(url);
  return false;
}

function scroller(): Element {
  const root = document.scrollingElement ?? document.documentElement;
  if (root.scrollHeight - root.clientHeight > 100) return root;
  const inner = [...document.querySelectorAll('#app, main, .main-content')]
    .find((node) => node.scrollHeight - node.clientHeight > 100);
  return inner ?? root;
}

function pageIsLoading(): boolean {
  const app = document.getElementById('app');
  if (!app || app.childElementCount === 0) return true;
  return [...app.querySelectorAll('.empty, .loading')].some((node) => LOADING_RE.test(node.textContent ?? ''));
}

export function startBanshoTour(from: Saved = { index: 0, paused: false }): void {
  stopActive?.();
  const lang: Lang = document.documentElement.lang.toLowerCase().startsWith('ru') ? 'ru' : 'en';
  const labels = LABELS[lang];
  const state: Saved = { ...from };
  let elapsed = 0;
  let waited = 0;
  let timer = 0;

  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };

  const bar = make('section', 'bt-bar');
  bar.setAttribute('aria-label', labels.name);
  const track = make('div', 'bt-track');
  const fill = make('i', 'bt-fill');
  track.append(fill);
  const count = make('span', 'bt-count');
  const title = make('strong', 'bt-title');
  const caption = make('p', 'bt-text');
  const clock = make('span', 'bt-clock');

  const button = (label: string, action: () => void): HTMLButtonElement => {
    const node = make('button', 'bt-button', label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };

  const stop = (): void => {
    window.clearInterval(timer);
    window.removeEventListener('keydown', onKey, true);
    bar.remove();
    save(null);
    stopActive = null;
  };

  const show = (index: number): void => {
    const step = STEPS[index];
    if (!step) {
      stop();
      return;
    }
    state.index = index;
    elapsed = 0;
    waited = 0;
    save(state);
    const [heading, text] = step[lang];
    title.textContent = heading;
    caption.textContent = text;
    count.textContent = `${index + 1} / ${STEPS.length}`;
    if (go(step.url)) scroller().scrollTo({ top: 0 });
  };

  const pauseButton = button(state.paused ? labels.resume : labels.pause, () => {
    state.paused = !state.paused;
    pauseButton.textContent = state.paused ? labels.resume : labels.pause;
    save(state);
  });

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    stop();
  }

  const tick = (): void => {
    const step = STEPS[state.index];
    if (!step || state.paused) return;
    if (elapsed === 0 && waited < MAX_WAIT_MS && pageIsLoading()) {
      waited += TICK_MS;
      clock.textContent = labels.loading;
      return;
    }
    elapsed += TICK_MS;
    const done = STEPS.slice(0, state.index).reduce((sum, item) => sum + item.seconds, 0) + elapsed / 1000;
    fill.style.width = `${Math.min(100, (done / TOTAL) * 100)}%`;
    const left = Math.max(0, Math.ceil(TOTAL - done));
    clock.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    // Hold the top for a quarter of the step, then glide down the page.
    const share = Math.max(0, Math.min(1, (elapsed / (step.seconds * 1000) - 0.25) / 0.7));
    const target = scroller();
    if (share > 0) target.scrollTo({ top: (target.scrollHeight - target.clientHeight) * share * 0.8 });
    if (elapsed >= step.seconds * 1000) show(state.index + 1);
  };

  const controls = make('div', 'bt-controls');
  controls.append(
    button(labels.back, () => show(Math.max(0, state.index - 1))),
    pauseButton,
    button(labels.next, () => show(state.index + 1)),
    button(labels.stop, stop),
  );
  const head = make('div', 'bt-head');
  head.append(count, title, clock);
  bar.append(track, head, caption, controls);
  document.body.append(bar);

  window.addEventListener('keydown', onKey, true);
  timer = window.setInterval(tick, TICK_MS);
  stopActive = stop;
  show(state.index);
  // The dossier loads the company while the first screen is being shown.
  window.dispatchEvent(new CustomEvent('bansho:prefetch', { detail: { symbol: 'NVDA' } }));
}

/** Continues a tour after a page load, or starts one for a `?tour=1` link. */
export function resumeBanshoTour(): void {
  if (stopActive) return;
  if (new URLSearchParams(window.location.search).get('tour') === '1') {
    const url = new URL(window.location.href);
    url.searchParams.delete('tour');
    window.history.replaceState(null, '', url);
    startBanshoTour();
    return;
  }
  const saved = load();
  if (saved) startBanshoTour(saved);
}
