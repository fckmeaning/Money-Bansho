// Market overview: the forecast corridor of every listed company, computed by the server from the
// closes the screener already loads (api/_dossier/math/outlook-board.js). Nothing is estimated here;
// a company without a year of prices shows "no data".
import './forecast.css';
import type { ScreenerLite } from './bigcharts';
import { h } from './dom';
import { regionName, uiLang } from './i18n';
import { isObj, list, num } from './quant-parse';
import { REGIONS } from './types';

interface Range { low: number; high: number; width: number }
interface Line {
  symbol: string; name: string; region: string; asOf: number | null;
  ranges: (Range | null)[]; annual: number | null; versus: number | null; realised: number | null;
  /** Expected volatility now divided by the same expectation five sessions ago. */
  change: number | null;
}
type Sort = 'standout' | 'width' | 'versus' | 'change' | 'symbol';

const HORIZONS = [1, 5, 20];
const SHOWN = 14;
/** Expected volatility this far from the usual level of the year counts as unusual. */
const HIGH = 1.2;
const LOW = 0.8;

const TEXT = {
  en: {
    title: 'Market forecast: 80% corridor for every company', loading: 'Computing from one year of prices…', none: 'no data',
    lead: 'The range of the price change from the last close: about 8 outcomes in 10 should fall inside. This table does not show direction (see a company page). "Usual" is the company\'s own volatility over the past year. Multipliers (×) describe the width of swings, not a change of the price.',
    companies: 'With a forecast', width: 'Median corridor width, 5 sessions', high: 'Expected volatility above usual (×1.2 and more)', low: 'Expected volatility below usual (×0.8 and less)', change: 'Expected volatility against a week ago, median',
    level: 'Expected volatility to usual, median', happened: 'actual over 22 sessions: ×{v}',
    standout: 'Standing out', widest: 'Widest', versus: 'Volatility to usual', moved: 'Volatility changed most', symbol: 'Ticker',
    all: 'All regions', company: 'Company', s1: '1 session', s5: '5 sessions', s20: '20 sessions', bar: 'Width, 5 sessions',
    annual: 'Volatility, a year', ratio: 'To usual', delta: 'Vol. vs week ago', open: 'Open the forecast', more: 'Show all ({n})', less: 'Show fewer',
    sort: 'Order', region: 'Region', median: 'Region medians: width at 5 sessions, to usual',
    proof: 'Held-out test {from} to {to}, {companies} companies: the 80% corridor held {c1} / {c5} / {c20} of the time at 1 / 5 / 20 sessions (previous method {p1} / {p5} / {p20}); distribution error lower by {s1} / {s5} / {s20}.',
    method: 'From closing prices only, so the figures differ a little from the company tab, which also uses daily ranges and quarterly repetition.',
  },
  ru: {
    title: 'Прогноз по рынку: коридор 80% для каждой компании', loading: 'Расчёт по ценам за год…', none: 'нет данных',
    lead: 'Диапазон изменения цены от последнего закрытия: внутрь должны попадать примерно 8 исходов из 10. Направление в этой таблице не показано (оно на странице компании). «Обычная» — волатильность самой компании за прошедший год. Множители (×) описывают размах колебаний, а не изменение цены.',
    companies: 'С прогнозом', width: 'Медианная ширина коридора, 5 сессий', high: 'Ожидаемая волатильность выше обычной (от ×1,2)', low: 'Ожидаемая волатильность ниже обычной (до ×0,8)', change: 'Ожидаемая волатильность к неделе назад, медиана',
    level: 'Ожидаемая волатильность к обычной, медиана', happened: 'факт за 22 сессии: ×{v}',
    standout: 'Выделяются', widest: 'Самые широкие', versus: 'Волатильность к обычной', moved: 'Волатильность изменилась сильнее', symbol: 'Тикер',
    all: 'Все регионы', company: 'Компания', s1: '1 сессия', s5: '5 сессий', s20: '20 сессий', bar: 'Ширина, 5 сессий',
    annual: 'Волатильность, годовая', ratio: 'К обычной', delta: 'Волат. к неделе назад', open: 'Открыть прогноз', more: 'Показать все ({n})', less: 'Свернуть',
    sort: 'Порядок', region: 'Регион', median: 'Медианы регионов: ширина на 5 сессий, к обычной',
    proof: 'Отложенная проверка {from} — {to}, {companies} компаний: коридор 80% накрыл {c1} / {c5} / {c20} исходов на 1 / 5 / 20 сессий (прежний способ {p1} / {p5} / {p20}); ошибка распределения меньше на {s1} / {s5} / {s20}.',
    method: 'Только по ценам закрытия, поэтому числа немного отличаются от вкладки компании, где учтены ещё дневные диапазоны и квартальная повторяемость.',
  },
};

// Kept outside the element: the overview is redrawn on every poll.
const view = { sort: 'standout' as Sort, region: '', all: false, scroll: 0 };

function lineOf(row: ScreenerLite['rows'][number]): Line {
  const o = isObj(row.outlook) ? row.outlook : null;
  const horizons = list(o?.horizons).filter(isObj);
  return {
    symbol: row.symbol,
    name: row.name,
    region: row.region,
    asOf: num(o?.asOf),
    ranges: HORIZONS.map((horizon) => {
      const found = horizons.find((x) => x.h === horizon);
      const low = num(found?.low80Pct);
      const high = num(found?.high80Pct);
      return low === null || high === null ? null : { low, high, width: high - low };
    }),
    annual: num(o?.annualPct),
    versus: num(o?.vsUsual),
    realised: num(o?.realisedVsUsual),
    change: num(o?.change5Pct) === null ? null : 1 + (num(o?.change5Pct) as number) / 100,
  };
}

const median = (values: (number | null | undefined)[]): number | null => {
  const sorted = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

const SORTS: Record<Sort, (x: Line) => number> = {
  // How far the expectation is from the usual level, in either direction.
  standout: (x) => (x.versus ? Math.abs(Math.log(x.versus)) : -1),
  width: (x) => x.ranges[1]?.width ?? -1,
  versus: (x) => x.versus ?? -1,
  change: (x) => (x.change ? Math.abs(Math.log(x.change)) : -1),
  symbol: () => 0,
};

export function forecastBoard(data: ScreenerLite | null, failed: boolean, onOpen: (symbol: string) => void): HTMLElement {
  const lang = uiLang();
  const t = TEXT[lang];
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
  const fixed = (v: number, digits = 1) => v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const signed = (v: number, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fixed(Math.abs(v), digits)}`;
  const or = (v: number | null, format: (x: number) => string) => (v === null ? t.none : format(v));
  const root = h('section', { class: 'panel fb' });

  const draw = () => {
    const lines = (data?.rows ?? []).map(lineOf);
    const ready = lines.filter((x) => x.ranges[1]);
    const asOf = Math.max(0, ...ready.map((x) => x.asOf ?? 0));
    const head = h(
      'header',
      { class: 'panel-head' },
      h('h2', {}, t.title),
      h('span', { class: 'panel-aside mono' }, asOf ? new Date(asOf).toLocaleDateString(locale) : ''),
    );
    if (!ready.length) {
      root.replaceChildren(head, h('div', { class: 'empty' }, data || failed ? t.none : t.loading));
      return;
    }
    const figure = (label: string, value: string, sub = '') =>
      h('div', {}, h('span', {}, label), h('b', { class: 'mono' }, value), sub ? h('small', {}, sub) : null);
    const times = (v: number) => `×${fixed(v, 2)}`;
    const happened = median(ready.map((x) => x.realised));
    const figures = h(
      'div',
      { class: 'fb-figures' },
      figure(t.companies, `${ready.length} / ${lines.length}`),
      figure(t.width, or(median(ready.map((x) => x.ranges[1]?.width)), (v) => `${fixed(v)}%`)),
      figure(t.level, or(median(ready.map((x) => x.versus)), times), happened === null ? '' : t.happened.replace('{v}', fixed(happened, 2))),
      figure(t.high, String(ready.filter((x) => (x.versus ?? 0) >= HIGH).length)),
      figure(t.low, String(ready.filter((x) => x.versus !== null && x.versus <= LOW).length)),
      figure(t.change, or(median(ready.map((x) => x.change)), times)),
    );
    const button = (key: string, label: string, pressed: boolean, apply: () => void) =>
      h(
        'button',
        {
          type: 'button',
          class: 'fb-toggle',
          'data-key': key,
          'aria-pressed': String(pressed),
          onclick: () => {
            apply();
            draw();
            root.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus({ preventScroll: true });
          },
        },
        label,
      );
    const orders: [Sort, string][] = [['standout', t.standout], ['width', t.widest], ['versus', t.versus], ['change', t.moved], ['symbol', t.symbol]];
    const controls = h(
      'div',
      { class: 'fb-controls' },
      h('div', { role: 'group', 'aria-label': t.sort }, ...orders.map(([id, label]) => button(`fb-sort-${id}`, label, view.sort === id, () => {
        view.sort = id;
      }))),
      h(
        'div',
        { role: 'group', 'aria-label': t.region },
        ...['', ...REGIONS.filter((r) => ready.some((x) => x.region === r))].map((region) =>
          button(`fb-region-${region}`, region ? regionName(region as (typeof REGIONS)[number]) : t.all, view.region === region, () => {
            view.region = region;
          })),
      ),
    );
    const regions = h(
      'p',
      { class: 'fb-regions mono' },
      h('span', {}, `${t.median}: `),
      ...REGIONS.flatMap((region) => {
        const members = ready.filter((x) => x.region === region);
        if (!members.length) return [];
        return [h('span', {}, `${regionName(region)} ${or(median(members.map((x) => x.ranges[1]?.width)), (v) => `${fixed(v)}%`)}, ×${or(median(members.map((x) => x.versus)), (v) => fixed(v, 2))}`)];
      }),
    );
    const picked = lines
      .filter((x) => !view.region || x.region === view.region)
      .sort((a, b) => (view.sort === 'symbol' ? a.symbol.localeCompare(b.symbol) : SORTS[view.sort](b) - SORTS[view.sort](a)));
    const widest = Math.max(1, ...picked.map((x) => x.ranges[1]?.width ?? 0));
    const range = (r: Range | null | undefined) => (r ? `${signed(r.low)} … ${signed(r.high)}` : t.none);
    const shown = view.all ? picked : picked.slice(0, SHOWN);
    const table = h(
      'div',
      { class: 'fb-scroll' },
      h(
        'table',
        { class: 'fb-table mono' },
        // The classes let narrow panels drop the less important columns (forecast.css).
        h('thead', {}, h('tr', {}, ...([
          [t.symbol, ''], [t.company, 'fb-c-name'], [`${t.s1}, %`, 'fb-c-side'], [`${t.s5}, %`, ''], [`${t.s20}, %`, 'fb-c-side'],
          [t.bar, 'fb-c-bar'], [t.annual, 'fb-c-annual'], [t.ratio, ''], [t.delta, ''],
        ] as const).map(([label, cls]) => h('th', { scope: 'col', class: cls }, label)))),
        h(
          'tbody',
          {},
          ...shown.map((x) => {
            const bar = h('i', {});
            bar.style.width = `${((x.ranges[1]?.width ?? 0) / widest) * 100}%`;
            const flag = x.versus === null ? '' : x.versus >= HIGH ? 'fb-high' : x.versus <= LOW ? 'fb-low' : '';
            return h(
              'tr',
              {},
              h('th', { scope: 'row' }, h('button', { type: 'button', class: 'fb-open', 'data-key': `fb-${x.symbol}`, title: `${t.open}: ${x.name}`, onclick: () => onOpen(x.symbol) }, x.symbol)),
              h('td', { class: 'fb-name fb-c-name', dir: 'auto' }, x.name),
              ...x.ranges.map((r, i) => h('td', { class: i === 1 ? '' : 'fb-c-side' }, range(r))),
              h('td', { class: 'fb-c-bar' }, h('span', { class: 'fb-bar', 'aria-hidden': 'true' }, bar), or(x.ranges[1]?.width ?? null, (v) => ` ${fixed(v)}`)),
              h('td', { class: 'fb-c-annual' }, or(x.annual, (v) => `${fixed(v)}%`)),
              h('td', { class: flag }, or(x.versus, times)),
              h('td', {}, or(x.change, times)),
            );
          }),
        ),
      ),
    );
    const more = picked.length > SHOWN
      ? button('fb-more', view.all ? t.less : t.more.replace('{n}', String(picked.length)), view.all, () => {
        view.all = !view.all;
      })
      : null;
    const evidence = isObj(data?.forecastEvidence) ? data.forecastEvidence : null;
    const held = isObj(evidence?.close) ? evidence.close : null;
    const period = list(evidence?.period);
    const part = (horizon: number, key: string) => {
      const cell = held?.[String(horizon)];
      const v = isObj(cell) ? num(cell[key]) : null;
      return v === null ? t.none : `${fixed(v * 100)}%`;
    };
    const values: Record<string, string> = {
      from: String(period[0] ?? ''), to: String(period[1] ?? ''), companies: String(num(evidence?.companies) ?? ''),
    };
    for (const horizon of HORIZONS) {
      values[`c${horizon}`] = part(horizon, 'cover80');
      values[`p${horizon}`] = part(horizon, 'previousCover80');
      values[`s${horizon}`] = part(horizon, 'skill');
    }
    table.addEventListener('scroll', () => {
      view.scroll = table.scrollLeft;
    });
    requestAnimationFrame(() => {
      table.scrollLeft = view.scroll;
    });
    root.replaceChildren(
      head,
      h('p', { class: 'fb-lead' }, t.lead),
      figures,
      regions,
      controls,
      table,
      ...(more ? [h('div', { class: 'fb-more' }, more)] : []),
      h('p', { class: 'fb-proof muted' }, `${held ? `${t.proof.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')} ` : ''}${t.method}`),
    );
  };

  draw();
  return root;
}
