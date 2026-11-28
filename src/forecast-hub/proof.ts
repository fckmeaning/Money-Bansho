// Pages about trust: accuracy tables, the method with a worked calculation, and limitations.
import { companies } from '../dossier/companies';
import { h } from '../dossier/dom';
import { TEXT as FC, note, panelOf, recordPanel, sentence, table } from '../dossier/forecast';
import type { Evidence, Forecast } from '../dossier/forecast';
import { typeName, uiLang } from '../dossier/i18n';
import { equation, frac, paren, row, sqrt, sub, sup } from '../dossier/mathml';
import { money } from './chart';
import { HORIZONS, board, company } from './data';
import { LIMITS } from './text';
import { dec, go, horizonSwitch, later, local, missing, picker, share, signed, state, words } from './ui';

type ByHorizon = Evidence['range'];
type Held = ByHorizon[string];

const nameOf = (symbol: string) => companies.find((c) => c.symbol === symbol)?.name ?? symbol;
const interval = (e: Held) => `${share(e.skill, 2)} [${dec(e.skillLow * 100, 2)}; ${dec(e.skillHigh * 100, 2)}]`;
const arrow = (a?: number, b?: number) => (a === undefined || b === undefined ? words().none : `${share(a)} → ${share(b)}`);
const title = (head: string, lead: string) => h('div', { class: 'fh-title' }, h('h1', {}, head), h('p', {}, lead));

export function accuracyPage(): Node[] {
  const w = words();
  return [
    later(board(), ({ evidence }) => (evidence ? tables(evidence) : [missing()]), w.loading),
    h('h2', { class: 'fh-heading' }, w.own),
    h('details', { class: 'fh-pick' }, h('summary', {}, `${w.pickTitle}: ${state.symbol} · ${nameOf(state.symbol)}`), picker(state.symbol, (next) => go('#/accuracy', next))),
    later(company(state.symbol), (data) => (data.forecast ? [recordPanel(data.forecast, FC[uiLang()])] : [missing()]), w.loadingCompany),
  ];
}

function tables(E: Evidence): (Node | null)[] {
  const w = words();
  const full = (label: string, set: ByHorizon) => panelOf(
    `${w.beforeAfter}: ${label}`,
    table(
      [w.horizon, dossierPoints(), w.cover80, w.cover95, w.crps, w.tail, w.brier, w.widthCh],
      HORIZONS.map((n) => {
        const e = set[String(n)] as Held;
        return [
          String(n), String(e.n), arrow(e.previousCover80, e.cover80), arrow(e.previousCover95, e.cover95), interval(e),
          e.tailSkill === undefined ? w.none : share(e.tailSkill, 2),
          `${e.brier?.toFixed(4)} / ${e.previousBrier?.toFixed(4)} / ${e.climatologyBrier?.toFixed(4)}`,
          e.widthChange === undefined ? w.none : `${signed(e.widthChange * 100, 1)}%`,
        ];
      }),
    ),
  );
  const events = (label: string, set: ByHorizon) => [
    h('h3', { class: 'fc-sub' }, label),
    table(
      [w.horizon, w.evN, w.evCover, w.crps],
      HORIZONS.map((n) => {
        const e = set[String(n)] as Held;
        return [String(n), String(e.n), arrow(e.previousCover80, e.cover80), interval(e)];
      }),
    ),
  ];
  return [
    title(w.accTitle, `${w.accSub.replace('{companies}', String(E.companies)).replace('{from}', E.period[0]).replace('{to}', E.period[1])}. ${w.smallGain}`),
    h('div', { class: 'fh-figures panel' }, ...HORIZONS.map((n) => h(
      'div',
      { class: 'fh-figure lead' },
      h('span', {}, `${w.in80} · ${w[`h${n}`]}`),
      h('b', { class: 'mono' }, share((E.range[String(n)] as Held).cover80)),
      h('small', {}, w.stated),
    ))),
    full(w.range, E.range),
    full(w.close, E.close),
    note(FC[uiLang()].caveat),
    panelOf(
      w.baselines,
      table(
        [w.horizon, w.base, w.ewma, w.garchN, w.garchT, w.ours, w.diff],
        // docs/math/forecast.md, 6.2.
        [
          ['1', '0.04%', '0.30%', '0.49%', '0.74%', '1.05%', '0.31 [0.12; 0.52]'],
          ['5', '0.20%', '0.06%', '0.43%', '0.50%', '0.57%', '0.07 [−0.10; 0.26]'],
          ['20', '0.40%', '−0.18%', '0.49%', '0.50%', '0.65%', '0.15 [−0.10; 0.42]'],
        ].map((cells) => cells.map(local)),
      ),
      note(`${w.garchNote}. ${w.baseSource}`),
    ),
    panelOf(w.events, ...events(w.filing, E.events.filing ?? {}), ...events(w.headline, E.events.headline ?? {})),
    panelOf(
      w.extreme,
      sentence(w.extremeText.replace('{x}', String(E.extremeRatio ?? w.none))),
      table(
        [w.horizon, w.evN, w.evCover],
        HORIZONS.map((n) => {
          const e = E.extreme?.[String(n)] as Held | undefined;
          return [String(n), String(e?.n ?? w.none), arrow(e?.previousCover80, e?.cover80)];
        }),
      ),
      E.links ? note(w.linksCheck.replace('{a}', String(E.links.corrBefore)).replace('{b}', String(E.links.corrAfter)).replace('{n}', String((E.links as { pairQuarters?: number }).pairQuarters ?? w.none))) : null,
    ),
  ];
}

const dossierPoints = () => (uiLang() === 'ru' ? 'Точек' : 'Points');

interface Workings {
  lastBar: { o: number; h: number; l: number; c: number; previousClose: number; variance: number } | null;
  constants: { h: number; weights: number[]; scale: number; nu: number; q90: number }[] | null;
  eventScale: Record<string, Record<string, number[]>>;
}

/** The corridor of the chosen horizon recomputed in the browser from the inputs the server returned. */
function steps(f: Forecast): Node[] {
  const w = words();
  const names = FC[uiLang()] as unknown as Record<string, string>;
  const n = state.horizon;
  const i = HORIZONS.indexOf(n);
  const server = f.horizons[i];
  const day = (t: number) => new Date(t).toLocaleDateString(uiLang() === 'ru' ? 'ru-RU' : 'en-US', { timeZone: 'UTC' });
  const exp = (v: number) => v.toExponential(3);
  const work = (f as Forecast & { workings?: Workings }).workings;
  const bar = work?.lastBar ?? null;
  const step = (head: string, ...body: (Node | null)[]) => panelOf(head, ...body);

  const first = [
    step(w.s1, sentence(w.s1t.replace('{n}', String(f.model.sessions)).replace('{date}', day(f.asOf))),
      sentence(names[`f_${f.model.kind}`] ?? (FC[uiLang()].models as Record<string, string>)[f.model.kind] ?? '')),
    step(
      w.s2,
      equation(
        sub('v', 't'), '=', sup('ln', '2'), paren(frac(sub('O', 't'), sub('C', row('t', '−', '1')))), '+', 'max', row('(',
          frac('1', '2'), sup('ln', '2'), paren(frac(sub('H', 't'), sub('L', 't'))), '−', paren('2', 'ln', '2', '−', '1'), sup('ln', '2'), paren(frac(sub('C', 't'), sub('O', 't'))), ',', '0', ')'),
      ),
      bar
        ? h('div', {}, sentence(w.s2t.replace('{date}', day(f.asOf))),
          h('p', { class: 'mono fh-calc' }, `O = ${money(bar.o)}, H = ${money(bar.h)}, L = ${money(bar.l)}, C = ${money(bar.c)}, C(t−1) = ${money(bar.previousClose)}`),
          h('p', { class: 'mono fh-calc' }, `v = ${exp(bar.variance)}  →  √(252·v) = ${dec(Math.sqrt(252 * bar.variance) * 100, 1)}%`))
        : note(w.s2none),
    ),
  ];
  const parts = f.drivers?.[i]?.parts;
  const used = work?.constants?.[i];
  if (!parts || !used || !server) return [...first, panelOf(w.s3, note(w.simpleModel))];
  const { weights, scale, nu, q90: quantile } = used;
  const rows = parts.map((part, j) => {
    const x = (part.annualPct / 100) ** 2 / 252;
    return { part, x, w: weights[j] as number };
  });
  const daily = rows.reduce((total, r) => total + r.w * r.x, 0);
  const sigma = Math.sqrt(daily * n);
  const edge = scale * sigma * quantile;
  const low = (Math.exp(-edge) - 1) * 100;
  const high = (Math.exp(edge) - 1) * 100;
  const scales = work?.eventScale;

  return [
    ...first,
    step(
      w.s3,
      sentence(w.s3t),
      equation(sup(sub('σ', 'd'), '2'), '=', row(sub('∑', 'i'), sub('w', 'i'), sub('x', 'i'))),
      table(
        [w.input, w.annualV, w.dailyV, w.weight, w.product],
        [
          ...rows.map((r) => [names[`f_${r.part.id}`] ?? r.part.id, `${dec(r.part.annualPct, 1)}%`, exp(r.x), r.w.toFixed(4), exp(r.w * r.x)]),
          [h('b', {}, w.total), '', '', '', h('b', {}, exp(daily))],
        ],
      ),
    ),
    step(
      w.s4,
      equation(sub('σ', 'h'), '=', sqrt('h', '·', sup(sub('σ', 'd'), '2'))),
      h('p', { class: 'mono fh-calc' }, `σ(${n}) = √(${n} · ${exp(daily)}) = ${sigma.toFixed(5)}`),
    ),
    step(
      w.s5,
      sentence(w.s5t),
      equation(sub('q', 'p'), '=', 'k', '·', sub('s', 'h'), '·', sub('σ', 'h'), '·', row(sup(sub('t', 'ν'), row('−', '1')), paren('p'))),
      equation(sub('P', 'p'), '=', sub('C', 't'), '·', row('exp', paren(sub('q', 'p')))),
      h('p', { class: 'mono fh-calc' }, `s = ${scale}, ν = ${nu}, t⁻¹(0.9) = ${quantile.toFixed(4)}`),
      h('p', { class: 'mono fh-calc' }, `q = ± ${scale} · ${sigma.toFixed(5)} · ${quantile.toFixed(4)} = ± ${edge.toFixed(5)}`),
      h('p', { class: 'mono fh-calc fh-result' }, `${signed(low, 2)}% … ${signed(high, 2)}%  =  ${money(f.lastClose * Math.exp(-edge))} … ${money(f.lastClose * Math.exp(edge))}`),
      note(w.server.replace('{low}', `${signed(server.low80Pct, 2)}%`).replace('{high}', `${signed(server.high80Pct, 2)}%`)),
    ),
    step(
      w.s6,
      sentence(w.s6t),
      equation(sup('k', '′'), '=', row('exp', paren(frac('n', row('n', '+', '30')), 'ln', 'k'))),
      note(w.s6shrink),
      table(
        [w.headline, ...HORIZONS.map((x) => `k, ${x}`)],
        Object.entries({ ...scales?.headline, '8-K 2.02': scales?.filing?.earnings ?? [] }).map(([type, k]) => [
          type === '8-K 2.02' ? w.filing : typeName(type as Parameters<typeof typeName>[0]),
          ...(k as number[]).map((x) => `×${dec(x, 2)}`),
        ]),
      ),
    ),
    step(
      w.s7,
      sentence(w.s7t),
      equation(sub('L', 'p'), '=', row('max', '(', 'p', paren('y', '−', 'q'), ',', paren('1', '−', 'p'), paren('q', '−', 'y'), ')')),
      h('a', { href: '#/accuracy' }, w.allTables),
    ),
  ];
}

export function methodPage(symbol: string): Node[] {
  const w = words();
  return [
    title(w.mTitle, w.mLead.replace('{name}', `${nameOf(symbol)} (${symbol})`).replace('{h}', w[`h${state.horizon}`])),
    h('div', { class: 'fh-tools' }, h('details', { class: 'fh-pick' }, h('summary', {}, `${w.pickTitle}: ${symbol}`), picker(symbol, (next) => go(`#/method/${next}`, next))), horizonSwitch()),
    later(company(symbol), (data) => (data.forecast ? steps(data.forecast) : [missing()]), w.loadingCompany),
  ];
}

export function limitsPage(): Node[] {
  const w = words();
  return [
    title(w.limTitle, w.disclaimer),
    h('div', { class: 'fh-limits' }, ...LIMITS[uiLang()].map(([head, text]) => h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', {}, head)), h('p', {}, text)))),
  ];
}
