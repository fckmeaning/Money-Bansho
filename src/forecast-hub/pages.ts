// Pages about companies: home, one company, comparison, regions and news scenarios.
import { companies } from '../dossier/companies';
import { h, safeUrl } from '../dossier/dom';
import {
  TEXT as FC, basisPanel, corridorPanel, linksPanel, newsDetails, note, panelOf, recordPanel, sentence, table, unusual,
} from '../dossier/forecast';
import type { Corridor, Evidence, Forecast, Item } from '../dossier/forecast';
import { regionName, typeName, uiLang } from '../dossier/i18n';
import { REGIONS } from '../dossier/types';
import { bigFan, money, rangeBar } from './chart';
import { HORIZONS, board, company, median } from './data';
import type { BoardLine, CompanyData } from './data';
import { companyHref, dec, go, horizonSwitch, later, local, missing, pctText, picker, share, signed, state, words } from './ui';

const dossierHref = (symbol: string) => `/dossier.html?symbol=${encodeURIComponent(symbol)}&view=forecast`;
const nameOf = (symbol: string) => companies.find((c) => c.symbol === symbol)?.name ?? symbol;
const button = (href: string, label: string, main = false) => h('a', { class: main ? 'fh-button main' : 'fh-button', href }, label);
const figure = (label: string, value: string, sub = '') =>
  h('div', { class: 'fh-figure' }, h('span', {}, label), h('b', { class: 'mono' }, value), sub ? h('small', {}, sub) : null);
const savedNote = (data: CompanyData) =>
  data.savedAt === null ? null : h('p', { class: 'muted fc-note' }, words().saved.replace('{t}', new Date(data.savedAt).toLocaleString(uiLang() === 'ru' ? 'ru-RU' : 'en-US')));

/** Big figures of the chosen horizon and the chart. */
function headline(data: CompanyData, forecast: Forecast): Node[] {
  const w = words();
  const p = forecast.horizons.find((x) => x.h === state.horizon) as Corridor;
  return [
    h(
      'div',
      { class: 'fh-figures' },
      h(
        'div',
        { class: 'fh-figure lead' },
        h('span', {}, `${w.corridor} · ${w[`h${state.horizon}`]}`),
        h('b', { class: 'mono' }, `${signed(p.low80Pct, 1)} … ${signed(p.high80Pct, 1)}%`),
        h('small', { class: 'mono' }, `${money(p.lowPrice)} … ${money(p.highPrice)} ${data.currency}`),
      ),
      figure(w.lastClose, money(forecast.lastClose), new Date(forecast.asOf).toLocaleDateString(uiLang() === 'ru' ? 'ru-RU' : 'en-US', { timeZone: 'UTC' })),
      figure(w.annual, `${dec(p.annualPct, 1)}%`),
      figure(w.versus, `×${dec(p.vsUsual, 2)}`),
    ),
    bigFan(forecast, data.bars, state.horizon, { today: w.today, ahead: w.ahead }),
    note(w.chartNote),
  ].concat(unusual(forecast, FC[uiLang()]) ?? []);
}

function boardList(title: string, lines: BoardLine[], value: (x: BoardLine) => string): HTMLElement {
  const w = words();
  const limit = Math.max(1, ...lines.flatMap((x) => {
    const r = x.ranges[state.horizon];
    return r ? [Math.abs(r.low), Math.abs(r.high)] : [];
  }));
  return panelOf(
    title,
    h('ul', { class: 'fh-rows' }, ...lines.map((x) => {
      const r = x.ranges[state.horizon];
      return h(
        'li',
        {},
        h(
          'a',
          { href: companyHref(x.symbol), class: 'fh-row' },
          h('b', { class: 'mono' }, x.symbol),
          h('span', { class: 'clamp1' }, x.name),
          r ? rangeBar(limit, null, [r.low, r.high], null) : h('span', {}, w.none),
          h('span', { class: 'mono num' }, value(x)),
        ),
      );
    })),
  );
}

function accuracyHero(): HTMLElement {
  return later(board(), ({ evidence }) => [evidence ? accuracyTable(evidence) : missing()], words().loading);
}

function accuracyTable(ev: Evidence): HTMLElement {
  const w = words();
  const held = (n: number) => ev.range[String(n)] as Evidence['range'][string];
  const garch: [string, string][] = [['0.31', '[0.12; 0.52]'], ['0.07', '[−0.10; 0.26]'], ['0.15', '[−0.10; 0.42]']];
  const group = (title: string, cells: HTMLElement[], foot: string) =>
    h('div', { class: 'fh-proof' }, h('h3', {}, title), h('div', { class: 'fh-trio' }, ...cells), h('p', { class: 'muted' }, foot));
  const cell = (horizon: number, value: string, sub: string) =>
    figure(w.sessionsN.replace('{h}', String(horizon)), value, sub);
  return panelOf(
    w.accTitle,
    note(w.accSub.replace('{companies}', String(ev.companies)).replace('{from}', ev.period[0]).replace('{to}', ev.period[1])),
    h(
      'div',
      { class: 'fh-proofs' },
      group(w.in80, HORIZONS.map((n) => cell(n, share(held(n).cover80, 1), w.points.replace('{n}', String(held(n).n)))), w.stated),
      group(w.gainPrev, HORIZONS.map((n) => cell(n, share(held(n).skill, 2), `[${dec(held(n).skillLow * 100, 2)}; ${dec(held(n).skillHigh * 100, 2)}]`)), w.smallGain),
      group(w.gainGarch, HORIZONS.map((n, i) => cell(n, `${dec(Number(garch[i]?.[0]), 2)}%`, local(garch[i]?.[1] ?? ''))), w.garchNote),
    ),
    h('div', { class: 'fh-actions' }, button('#/accuracy', w.allTables), button('#/method', w.howItWorks), button('#/limits', w.limits)),
  );
}

export function homePage(): Node[] {
  const w = words();
  const symbol = state.symbol;
  return [
    h(
      'section',
      { class: 'fh-hero' },
      h('h1', {}, w.heroTitle),
      h('p', {}, w.heroLead),
      h('div', { class: 'fh-three' }, ...([[w.p1t, w.p1], [w.p2t, w.p2], [w.p3t, w.p3]] as const).map(([title, text]) => h('div', {}, h('h2', {}, title), h('p', {}, text)))),
    ),
    h(
      'div',
      { class: 'fh-main' },
      h(
        'section',
        { class: 'panel' },
        h('header', { class: 'panel-head' }, h('h2', {}, `${symbol} · ${nameOf(symbol)}`), horizonSwitch()),
        later(company(symbol), (data) => (data.forecast
          ? [
            savedNote(data),
            ...headline(data, data.forecast),
            h('div', { class: 'fh-actions' }, button(companyHref(symbol), w.open, true), button(`#/scenarios/${symbol}`, w.openNews), button(`#/method/${symbol}`, w.openMethod), button(dossierHref(symbol), w.openDossier)),
          ]
          : [missing()]), words().loadingCompany, 'fc-body'),
      ),
      panelOf(w.pickTitle, picker(symbol, (next) => go(`#/`, next))),
    ),
    accuracyHero(),
    later(board(), ({ lines }) => {
      const ready = lines.filter((x) => x.ranges[state.horizon]);
      if (!ready.length) return [missing()];
      const widest = [...ready].sort((a, b) => (b.ranges[state.horizon]?.width ?? 0) - (a.ranges[state.horizon]?.width ?? 0)).slice(0, 8);
      const moved = ready.filter((x) => x.change).sort((a, b) => Math.abs(Math.log(b.change as number)) - Math.abs(Math.log(a.change as number))).slice(0, 8);
      return [
        h(
          'div',
          { class: 'fh-two' },
          boardList(`${w.widest} · ${w[`h${state.horizon}`]}`, widest, (x) => {
            const r = x.ranges[state.horizon];
            return r ? `${signed(r.low, 1)} … ${signed(r.high, 1)}%` : w.none;
          }),
          boardList(w.moved, moved, (x) => `×${dec(x.change as number, 2)}`),
        ),
        note(`${w.ratioWeek}: ×. ${w.boardNote}`),
      ];
    }, words().loading),
  ];
}

export function companyPage(symbol: string): Node[] {
  const w = words();
  const f = FC[uiLang()];
  return [
    h(
      'div',
      { class: 'fh-title' },
      h('h1', {}, h('span', { class: 'mono' }, symbol), ` ${nameOf(symbol)}`),
      h('div', { class: 'fh-actions' }, button(dossierHref(symbol), w.openDossier, true), button(`#/scenarios/${symbol}`, w.openNews), button(`#/compare/${symbol}`, w.openCompare), button(`#/method/${symbol}`, w.openMethod)),
    ),
    h('details', { class: 'fh-pick' }, h('summary', {}, w.pickTitle), picker(symbol, (next) => go(companyHref(next), next))),
    later(company(symbol), (data) => {
      const forecast = data.forecast;
      if (!forecast) return [missing()];
      return [
        savedNote(data),
        h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', {}, `${w.corridor} · ${data.name}`), horizonSwitch()), h('div', { class: 'fc-body' }, ...headline(data, forecast))),
        h(
          'div',
          { class: 'fc' },
          corridorPanel(forecast, f, uiLang()),
          basisPanel(forecast, f),
          newsBlock(forecast),
          linksPanel(forecast, f),
          recordPanel(forecast, f),
        ),
      ];
    }, w.loadingCompany),
  ];
}

const scaled = (item: Item) => item.adjustment.scale.some((k) => k > 1);
const weight = (e: Item) => (e.fresh ? 2 : 0) + (e.adjustment.kind === 'filing' ? 1.5 : e.adjustment.kind === 'headline' ? 1 : 0);

/** List of headlines and the conditional corridor of the chosen one. */
function newsBlock(forecast: Forecast): HTMLElement {
  const w = words();
  const f = FC[uiLang()];
  if (!forecast.events.length) return panelOf(w.scTitle, note(w.noNews));
  const body = h('div', { class: 'fc-body' });
  const list = h('div', { class: 'fh-news', role: 'group', 'aria-label': w.scList });
  let selected = [...forecast.events].sort((a, b) => weight(b) - weight(a))[0] as Item;
  const show = () => {
    for (const node of list.children) node.setAttribute('aria-pressed', String((node as HTMLElement).dataset.id === selected.eventId));
    const extra = selected as Item & { url?: string };
    const url = extra.url ? safeUrl(extra.url) : null;
    const limit = Math.max(...selected.horizons.flatMap((p) => [Math.abs(p.low80Pct), Math.abs(p.high80Pct)]), 1);
    const compare = h(
      'div',
      { class: 'fh-compare-events' },
      ...selected.horizons.flatMap((p, i) => {
        const base = forecast.horizons[i] as Corridor;
        const line = (label: string, c: Corridor, cls: string) => h(
          'div',
          { class: `fh-bar-line ${cls}` },
          h('span', {}, label),
          rangeBar(limit, null, [c.low80Pct, c.high80Pct], null),
          h('span', { class: 'mono num' }, `${signed(c.low80Pct, 1)} … ${signed(c.high80Pct, 1)}%`),
        );
        return [h('h3', {}, w[`h${p.h as 1 | 5 | 20}`]), line(w.ordinary, base, 'base'), line(`${w.conditional} (×${dec(p.multiplier ?? 1, 2)})`, p, 'cond')];
      }),
    );
    const chances = table(
      [w.horizon, 'X', w.ordinary, w.conditional],
      selected.horizons.map((p, i) => {
        const base = forecast.horizons[i] as Corridor;
        const a = base.exceed[1];
        const b = p.exceed[1];
        return [String(p.h), a ? `±${dec(a.pct, 1)}%` : w.none, a ? share(a.prob, 0) : w.none, b ? share(b.prob, 0) : w.none];
      }),
    );
    body.replaceChildren(
      h('h3', { class: 'fh-headline', dir: 'auto' }, selected.title),
      ...(url ? [h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'fh-source' }, w.source)] : []),
      compare,
      h('h3', { class: 'fc-sub' }, w.chance.replace('±{x}%', 'X')),
      chances,
      ...newsDetails(selected, forecast, f),
    );
  };
  list.append(
    ...forecast.events.map((e) => h(
      'button',
      {
        type: 'button', 'data-id': e.eventId,
        onclick: () => {
          selected = e;
          show();
        },
      },
      h('span', { dir: 'auto' }, e.title),
      h('small', { class: scaled(e) ? 'gold mono' : 'muted mono' }, `${typeName(e.type as Parameters<typeof typeName>[0])} · ${scaled(e) ? `${w.factor} ×${dec(Math.max(...e.adjustment.scale), 2)}` : w.noFactor}`),
    )),
  );
  show();
  return h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', {}, w.scTitle)), h('div', { class: 'fh-scenario' }, list, body));
}

export function scenariosPage(symbol: string): Node[] {
  const w = words();
  return [
    h('div', { class: 'fh-title' }, h('h1', {}, w.scTitle), h('p', {}, w.scLead)),
    h('details', { class: 'fh-pick' }, h('summary', {}, `${w.pickTitle}: ${symbol} · ${nameOf(symbol)}`), picker(symbol, (next) => go(`#/scenarios/${next}`, next))),
    later(company(symbol), (data) => (data.forecast ? [savedNote(data), newsBlock(data.forecast)] : [missing()]), w.loadingCompany),
  ];
}

export function comparePage(symbols: string[]): Node[] {
  const w = words();
  const goTo = (list: string[]) => go(`#/compare/${list.map(encodeURIComponent).join(',')}`);
  const add = h(
    'select',
    { class: 'fc-select fh-add', 'aria-label': w.add },
    h('option', { value: '' }, `+ ${w.add}`),
    ...companies.filter((c) => !symbols.includes(c.symbol)).map((c) => h('option', { value: c.symbol }, `${c.symbol} · ${c.name}`)),
  );
  add.addEventListener('change', () => add.value && goTo([...symbols, add.value]));
  const chips = h(
    'div',
    { class: 'fh-chips' },
    ...symbols.map((symbol) => h(
      'span',
      { class: 'fh-chip mono' },
      h('a', { href: companyHref(symbol) }, symbol),
      symbols.length > 2
        ? h('button', { type: 'button', 'aria-label': `${w.remove} ${symbol}`, onclick: () => goTo(symbols.filter((s) => s !== symbol)) }, '×')
        : null,
    )),
    symbols.length < 4 ? add : null,
  );
  const all = Promise.all(symbols.map((symbol) => company(symbol).catch(() => null)));
  return [
    h('div', { class: 'fh-title' }, h('h1', {}, w.compareTitle), h('p', {}, w.compareNote)),
    chips,
    h('div', { class: 'fh-tools' }, horizonSwitch()),
    later(all, (list) => {
      const rows = symbols.map((symbol, i) => ({ symbol, data: list[i] ?? null, forecast: list[i]?.forecast ?? null }));
      const picked = rows.map((r) => r.forecast?.horizons.find((x) => x.h === state.horizon) ?? null);
      const fanAt = (f: Forecast) => f.fan.find((x) => x.h === state.horizon);
      const wide = Math.max(1, ...rows.flatMap((r) => {
        const q = r.forecast && fanAt(r.forecast);
        return q ? [Math.abs(q.q025), Math.abs(q.q975)] : [];
      }));
      const bars = h('div', { class: 'fh-bars' }, ...rows.map((r, i) => {
        const p = picked[i];
        const q = r.forecast ? fanAt(r.forecast) : undefined;
        return h(
          'div',
          { class: 'fh-bar-line' },
          h('span', {}, h('b', { class: 'mono' }, r.symbol), ` ${nameOf(r.symbol)}`),
          p && q ? rangeBar(wide, [q.q025, q.q975], [q.q10, q.q90], [q.q25, q.q75]) : h('span', { class: 'muted' }, w.none),
          h('span', { class: 'mono num' }, p ? `${signed(p.low80Pct, 1)} … ${signed(p.high80Pct, 1)}%` : w.none),
        );
      }));
      const cell = (pick: (p: Corridor, f: Forecast) => string) => rows.map((r, i) => {
        const p = picked[i];
        return p && r.forecast ? pick(p, r.forecast) : w.none;
      });
      const metrics: [string, string[]][] = [
        [w.lastClose, cell((_, f) => money(f.lastClose))],
        [w.prices, cell((p) => `${money(p.lowPrice)} … ${money(p.highPrice)}`)],
        [w.width, cell((p) => `${dec(p.high80Pct - p.low80Pct, 1)}%`)],
        [w.annual, cell((p) => `${dec(p.annualPct, 1)}%`)],
        [w.versus, cell((p) => `×${dec(p.vsUsual, 2)}`)],
        [w.record, cell((_, f) => {
          const record = f.record.find((x) => x.h === state.horizon);
          return record ? share(record.cover80, 0) : w.none;
        })],
        [w.headlines, cell((_, f) => String(f.events.filter(scaled).length))],
      ];
      return [
        panelOf(`${w.corridor} · ${w[`h${state.horizon}`]}`, bars, note(w.chartNote.split('. ').slice(1).join('. '))),
        panelOf(w.compare, table(['', ...symbols], metrics.map(([label, values]) => [label, ...values]))),
        panelOf(w.byHorizon, table(
          [w.horizon, ...symbols],
          [1, 2, 3, 5, 8, 12, 20].map((n) => [String(n), ...rows.map((r) => {
            const q = r.forecast?.fan.find((x) => x.h === n);
            return q ? `${signed(q.q10, 1)} … ${signed(q.q90, 1)}%` : w.none;
          })]),
        )),
        h('div', { class: 'fh-multi' }, ...rows.map((r) => panelOf(
          `${r.symbol} · ${nameOf(r.symbol)}`,
          r.data && r.forecast ? bigFan(r.forecast, r.data.bars, state.horizon, { today: w.today, ahead: w.ahead }) : sentence(w.failed),
        ))),
      ];
    }, w.loadingCompany),
  ];
}

export function regionsPage(): Node[] {
  const w = words();
  return [
    h('div', { class: 'fh-title' }, h('h1', {}, w.regionTitle), h('p', {}, w.boardNote)),
    h('div', { class: 'fh-tools' }, horizonSwitch()),
    later(board(), ({ lines }) => [h('div', { class: 'fh-regions' }, ...REGIONS.map((region) => {
      const members = lines.filter((x) => x.region === region && x.ranges[state.horizon]);
      const width = median(members.map((x) => x.ranges[state.horizon]?.width));
      const versus = median(members.map((x) => x.versus));
      const change = median(members.map((x) => x.change));
      return h(
        'a',
        { class: 'panel fh-region', href: `#/region/${region}` },
        h('header', { class: 'panel-head' }, h('h2', {}, regionName(region))),
        h(
          'div',
          { class: 'fh-figures' },
          h('div', { class: 'fh-figure lead' }, h('span', {}, `${w.medianWidth} · ${w[`h${state.horizon}`]}`), h('b', { class: 'mono' }, width === null ? w.none : `${dec(width, 1)}%`)),
          figure(w.companiesN, String(members.length)),
          figure(w.medianRatio, versus === null ? w.none : `×${dec(versus, 2)}`),
          figure(w.medianWeek, change === null ? w.none : `×${dec(change, 2)}`),
        ),
        h('span', { class: 'fh-more' }, w.openRegion),
      );
    }))], w.loading),
  ];
}

export function regionPage(region: string): Node[] {
  const w = words();
  return [
    h('div', { class: 'fh-title' }, h('h1', {}, regionName(region)), h('p', {}, `${w.sortedBy} ${w.boardNote}`)),
    h(
      'div',
      { class: 'fh-tools' },
      h('div', { class: 'fh-actions' }, ...REGIONS.map((r) => button(`#/region/${r}`, regionName(r), r === region))),
      horizonSwitch(),
    ),
    later(board(), ({ lines }) => {
      const members = lines.filter((x) => x.region === region).sort((a, b) => (b.ranges[state.horizon]?.width ?? -1) - (a.ranges[state.horizon]?.width ?? -1));
      if (!members.length) return [missing()];
      return [
        boardList(`${w.corridor} · ${w[`h${state.horizon}`]}`, members, (x) => {
          const r = x.ranges[state.horizon];
          return r ? `${signed(r.low, 1)} … ${signed(r.high, 1)}%` : w.none;
        }),
        panelOf(w.versus, table(
          ['', w.annual, w.versus, w.ratioWeek],
          members.map((x) => [
            h('a', { href: companyHref(x.symbol) }, x.symbol),
            x.annual === null ? w.none : pctText(x.annual),
            x.versus === null ? w.none : `×${dec(x.versus, 2)}`,
            x.change === null ? w.none : `×${dec(x.change, 2)}`,
          ]),
        )),
      ];
    }, w.loading),
  ];
}
