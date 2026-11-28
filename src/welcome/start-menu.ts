// Game-like main menu over the start page: a triangular play button that opens the map, settings and
// a way to the project overview. Arrows move between buttons, Escape goes back.
import { currentScale, currentTheme, setBanshoScale, setBanshoTheme } from '../shell/bansho-view';
import { playClick, playHover, playStart, saveSound, sound, stopMusic, syncMusic } from './sound';
import './start-menu.css';

type Lang = 'en' | 'ru';

export interface StartMenuOptions {
  lang: Lang;
  onLanguage: (lang: Lang) => void;
  upstreamUrl: string;
  sourceUrl: string;
}

const MAP_URL = '/dashboard';
const START_DELAY_MS = 900;

const TEXT = {
  ru: {
    kicker: 'Симуляция мировых рынков и геополитики', play: 'Старт симуляции', starting: 'Запуск симуляции…',
    settings: 'Настройки', forecast: 'Прогноз', overview: 'Обзор проекта', back: 'Назад', menu: 'Главное меню',
    soundOn: 'Звук включён', soundOff: 'Звук выключен', effects: 'Звуки меню', music: 'Фоновая музыка', volume: 'Громкость',
    theme: 'Тема', dark: 'Тёмная', light: 'Светлая', scale: 'Масштаб', small: 'Мелкий', normal: 'Обычный', large: 'Крупный',
    language: 'Язык', on: 'Вкл', off: 'Выкл', hint: 'Стрелки — выбор, Enter — подтвердить, Esc — назад', about: 'О проекте',
  },
  en: {
    kicker: 'World markets and geopolitics simulation', play: 'Start simulation', starting: 'Starting the simulation…',
    settings: 'Settings', forecast: 'Forecast', overview: 'Project overview', back: 'Back', menu: 'Main menu',
    soundOn: 'Sound on', soundOff: 'Sound off', effects: 'Menu sounds', music: 'Background music', volume: 'Volume',
    theme: 'Theme', dark: 'Dark', light: 'Light', scale: 'Scale', small: 'Small', normal: 'Normal', large: 'Large',
    language: 'Language', on: 'On', off: 'Off', hint: 'Arrows to choose, Enter to confirm, Esc to go back', about: 'About',
  },
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function button(label: string, className: string, onPress: () => void, ...children: Node[]): HTMLButtonElement {
  const node = el('button', { type: 'button', class: className }, ...children, el('span', {}, label));
  node.addEventListener('click', () => {
    playClick();
    syncMusic();
    onPress();
  });
  node.addEventListener('pointerenter', playHover);
  return node;
}

function triangle(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M22 10L90 50L22 90Z');
  svg.append(path);
  return svg;
}

/** Opens the menu over the page; calling it again redraws it, for example in another language. */
export function openStartMenu(options: StartMenuOptions, screen: 'main' | 'settings' = 'main', focus = 0): void {
  document.querySelector('.sm')?.remove();
  const t = TEXT[options.lang];
  const app = document.getElementById('app');
  const root = el('div', { class: 'sm', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.menu });

  const close = () => {
    root.remove();
    app?.removeAttribute('inert');
    document.documentElement.classList.remove('sm-open');
    stopMusic();
  };
  const redraw = (next: 'main' | 'settings') => {
    const index = [...root.querySelectorAll('button, input')].indexOf(document.activeElement as Element);
    openStartMenu(options, next, next === screen ? index : 0);
  };

  const start = () => {
    playStart();
    root.classList.add('sm-starting');
    root.replaceChildren(el('div', { class: 'sm-loading', role: 'status' }, triangle(), el('b', {}, t.starting), el('i', {})));
    window.setTimeout(() => window.location.assign(MAP_URL), START_DELAY_MS);
  };

  const choice = <V extends string>(label: string, value: V, items: Array<[V, string]>, pick: (next: V) => void) =>
    el(
      'div',
      { class: 'sm-row', role: 'group', 'aria-label': label },
      el('span', {}, label),
      el('div', {}, ...items.map(([id, name]) => {
        const node = button(name, 'sm-option', () => {
          pick(id);
          redraw('settings');
        });
        node.setAttribute('aria-pressed', String(id === value));
        return node;
      })),
    );
  const toggle = (label: string, value: boolean, pick: (next: boolean) => void) =>
    choice(label, value ? 'on' : 'off', [['on', t.on], ['off', t.off]], (next) => pick(next === 'on'));

  const volume = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(sound.volume), 'aria-label': t.volume });
  volume.addEventListener('input', () => saveSound({ volume: Number(volume.value) }));
  volume.addEventListener('change', playClick);

  const muted = !sound.effects && !sound.music;
  const soundButton = button(muted ? t.soundOff : t.soundOn, 'sm-item', () => {
    saveSound({ effects: muted, music: muted });
    syncMusic();
    redraw(screen);
  });

  const body = screen === 'main'
    ? [
      button(t.play, 'sm-play', start, el('i', {}, triangle())),
      el(
        'div',
        { class: 'sm-items' },
        button(t.settings, 'sm-item', () => redraw('settings')),
        soundButton,
        button(t.forecast, 'sm-item', () => window.location.assign('/forecast.html')),
        button(t.overview, 'sm-item', close),
      ),
    ]
    : [
      el(
        'div',
        { class: 'sm-panel' },
        el('h2', {}, t.settings),
        toggle(t.effects, sound.effects, (effects) => saveSound({ effects })),
        toggle(t.music, sound.music, (music) => {
          saveSound({ music });
          syncMusic();
        }),
        el('label', { class: 'sm-row' }, el('span', {}, t.volume), volume),
        choice(t.theme, currentTheme(), [['dark', t.dark], ['light', t.light]], setBanshoTheme),
        choice(t.scale, currentScale(), [['small', t.small], ['normal', t.normal], ['large', t.large]], setBanshoScale),
        choice<Lang>(t.language, options.lang, [['ru', 'RU'], ['en', 'EN']], (lang) => {
          options.lang = lang;
          options.onLanguage(lang);
        }),
        button(t.back, 'sm-item', () => redraw('main')),
      ),
    ];

  const external = (href: string, text: string) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  root.append(
    el('div', { class: 'sm-title' }, el('p', {}, t.kicker), el('h1', {}, 'Money Bansho')),
    ...body,
    el('p', { class: 'sm-hint' }, t.hint),
    el(
      'details',
      { class: 'sm-about' },
      el('summary', {}, t.about),
      el(
        'p',
        { lang: 'en' },
        'Money Bansho is based on ',
        external(options.upstreamUrl, 'World Monitor'),
        ', © 2026 Elie Habib. Licensed under AGPL-3.0, without any warranty. ',
        external(options.sourceUrl, 'Source code'),
      ),
    ),
  );

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && screen === 'settings') redraw('main');
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...root.querySelectorAll<HTMLElement>('button')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
    playHover();
    event.preventDefault();
  });

  document.body.append(root);
  app?.setAttribute('inert', '');
  document.documentElement.classList.add('sm-open');
  root.querySelectorAll<HTMLElement>('button, input')[Math.max(0, focus)]?.focus({ preventScroll: true });
}
