// Entry of /forecast.html: the forecast section. Pages are hash routes; data comes from /api/dossier.
import '../dossier/styles.css';
import '../dossier/forecast.css';
import './hub.css';
import { companies } from '../dossier/companies';
import { h } from '../dossier/dom';
import { setUiLang, uiLang } from '../dossier/i18n';
import { REGIONS } from '../dossier/types';
import { mountBanshoMenu } from '../shell/bansho-menu';
import { applyStoredView } from '../shell/bansho-view';
import { comparePage, companyPage, homePage, regionPage, regionsPage, scenariosPage } from './pages';
import { accuracyPage, limitsPage, methodPage } from './proof';
import { app, selectSymbol, state, words } from './ui';

const DEFAULT_COMPARE = ['NVDA', '0700.HK', 'TEVA.TA'];

const header = h('header', { class: 'topbar fh-top' });
const tabs = h('nav', { class: 'fh-tabs' });
const main = h('main', { class: 'fh-page' });
const footer = h('footer', { class: 'footer' });
let menu: { lang: string; node: HTMLElement } | null = null;

const listed = (value: string | undefined): string | null => {
  const symbol = decodeURIComponent(value ?? '').toUpperCase();
  return companies.some((c) => c.symbol === symbol) ? symbol : null;
};

interface Route { page: string; arg: string }

function route(): Route {
  const [, page = '', arg = ''] = window.location.hash.split('/');
  return { page, arg };
}

function content({ page, arg }: Route): Node[] {
  const symbol = listed(arg);
  if (symbol && (page === 'company' || page === 'scenarios' || page === 'method')) selectSymbol(symbol);
  switch (page) {
    case 'company':
      return companyPage(state.symbol);
    case 'compare': {
      const picked = [...new Set(arg.split(',').map(listed).filter((x): x is string => x !== null))].slice(0, 4);
      // Fewer than two asked: companies of the default set join up to three.
      if (picked.length < 2) picked.push(...DEFAULT_COMPARE.filter((x) => !picked.includes(x)).slice(0, 3 - picked.length));
      return comparePage(picked);
    }
    case 'regions':
      return regionsPage();
    case 'region':
      return (REGIONS as readonly string[]).includes(arg) ? regionPage(arg) : regionsPage();
    case 'scenarios':
      return scenariosPage(state.symbol);
    case 'accuracy':
      return accuracyPage();
    case 'method':
      return methodPage(state.symbol);
    case 'limits':
      return limitsPage();
    default:
      return homePage();
  }
}

function chrome(page: string): void {
  const w = words();
  const lang = uiLang();
  document.documentElement.lang = lang;
  if (menu?.lang !== lang) menu = { lang, node: mountBanshoMenu({ active: 'forecast', lang }) };
  header.replaceChildren(
    menu.node,
    h('a', { class: 'brand', href: '#/' }, 'Money Bansho'),
    h('span', { class: 'subtitle' }, w.brand),
    h(
      'nav',
      {},
      h('a', { href: `/dossier.html?symbol=${encodeURIComponent(state.symbol)}` }, w.dossier),
      h(
        'div',
        { class: 'segment', role: 'group', 'aria-label': 'Language' },
        ...(['en', 'ru'] as const).map((next) => h(
          'button',
          {
            type: 'button', 'aria-pressed': String(lang === next),
            onclick: () => {
              setUiLang(next);
              app.redraw();
            },
          },
          next.toUpperCase(),
        )),
      ),
    ),
  );
  const items: [string, string, string][] = [
    ['', '#/', w.home],
    ['company', `#/company/${encodeURIComponent(state.symbol)}`, w.companyTab],
    ['compare', '#/compare', w.compare],
    ['regions', '#/regions', w.regions],
    ['scenarios', '#/scenarios', w.scenarios],
    ['accuracy', '#/accuracy', w.accuracy],
    ['method', '#/method', w.method],
    ['limits', '#/limits', w.limits],
  ];
  const active = page === 'region' ? 'regions' : items.some(([id]) => id === page) ? page : '';
  tabs.setAttribute('aria-label', w.brand);
  tabs.replaceChildren(...items.map(([id, href, label]) => h('a', { href, 'aria-current': id === active ? 'page' : null }, label)));
  const current = tabs.querySelector<HTMLElement>('[aria-current]');
  if (current) tabs.scrollLeft = Math.max(0, current.offsetLeft - 40);
  document.title = `${items.find(([id]) => id === active)?.[2] ?? w.home} · ${w.brand} · Money Bansho`;
  footer.replaceChildren(
    h('span', {}, w.disclaimer),
    h('span', { lang: 'en' }, 'Based on ', h('a', { href: 'https://github.com/koala73/worldmonitor', target: '_blank', rel: 'noopener noreferrer' }, 'World Monitor'), ', © 2026 Elie Habib. AGPL-3.0. ', h('a', { href: 'https://github.com/fckmeaning/Money-Bansho', target: '_blank', rel: 'noopener noreferrer' }, 'Source code')),
  );
}

function render(): void {
  const current = route();
  // The route may select a company, so the page is built before the header that names it.
  const nodes = content(current);
  chrome(current.page);
  main.replaceChildren(...nodes);
}

applyStoredView();
document.getElementById('app')?.replaceChildren(header, tabs, main, footer);
// A redraw keeps the reading position; a new route starts at the top.
app.redraw = () => {
  const y = window.scrollY;
  const key = (document.activeElement as HTMLElement | null)?.dataset.key;
  const height = main.offsetHeight;
  main.style.minHeight = `${height}px`;
  render();
  window.scrollTo({ top: y });
  if (key) main.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus({ preventScroll: true });
  window.setTimeout(() => {
    main.style.minHeight = '';
  }, 400);
};
window.addEventListener('hashchange', () => {
  main.style.minHeight = '';
  render();
  window.scrollTo({ top: 0 });
});
render();
