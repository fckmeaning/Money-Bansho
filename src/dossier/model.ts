// The Model view: each estimate with a plain reading, a chart where a series
// exists, and the equation with its fitted values. Nothing here is computed from
// scratch; missing estimates are shown as "no data".
import { barDate, fixed, h, pct, pValue, precise, share, signed, stamp, tone } from './dom';
import { t } from './i18n';
import type { Key } from './i18n';
import { consequencesOf } from './panels';
import {
  equation,
  fn,
  frac,
  gap,
  mn,
  mo,
  mtext,
  over,
  paren,
  row,
  sqrt,
  sub,
  subsup,
  sup,
  under,
  underover,
} from './mathml';
import type { Term } from './mathml';
import { barChart, lineChart } from './spark';
import type { Dossier, DossierEvent, Quant } from './types';

/** Cards whose formula block the reader has opened; survives re-renders. */
const openFormulas = new Set<string>();

type Params = [label: string, value: string][];

interface Card {
  id: string;
  title: Key;
  headline: string;
  caption: string;
  reading: string;
  cautions?: string[];
  figures?: (Node | null)[];
  facts: Params;
  extra?: Node | null;
  equations: HTMLElement[];
  params: Params;
  symbols: Key;
}

const present = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;
const percent = (value: number | null | undefined, digits = 1) => fixed(value, digits, '%');
const days = (value: number | null | undefined) =>
  present(value) ? t('daysShort', { n: fixed(value, 1) }) : t('noData');

/** A fitted value inside an equation. */
function val(value: number | null | undefined, digits = 3): MathMLElement {
  return present(value) ? mn(fixed(value, digits)) : mtext(t('noData'));
}

function sciVal(value: number | null | undefined): Term {
  if (!present(value)) return val(value);
  if (value === 0 || Math.abs(value) >= 0.001) return val(value, 4);
  const [mantissa = '0', exponent = '0'] = value.toExponential(2).split('e');
  return row(val(Number(mantissa), 2), '·', sup('10', mn(String(Number(exponent)).replace('-', '−'))));
}

function facts(items: Params): HTMLElement {
  return h(
    'dl',
    { class: 'facts' },
    ...items.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', { class: 'mono' }, value))),
  );
}

function card(c: Card): HTMLElement {
  const formula = h(
    'details',
    { class: 'formula', open: openFormulas.has(c.id) },
    h('summary', { 'data-key': `formula-${c.id}` }, t('formula')),
    h(
      'div',
      { class: 'formula-body' },
      ...c.equations,
      h('h4', {}, t('parameters')),
      facts(c.params),
      h('h4', {}, t('symbols')),
      h('p', { class: 'symbols' }, t(c.symbols)),
    ),
  );
  formula.addEventListener('toggle', () => {
    if (formula.open) openFormulas.add(c.id);
    else openFormulas.delete(c.id);
  });
  return h(
    'article',
    { class: 'panel card-model', id: `model-${c.id}`, 'data-anchor': `model-${c.id}` },
    h('header', { class: 'panel-head' }, h('h2', {}, t(c.title))),
    h(
      'div',
      { class: 'card-body' },
      h(
        'p',
        { class: 'headline-figure' },
        h('b', { class: `mono${c.headline === t('noData') ? ' none' : ''}` }, c.headline),
        h('span', {}, c.caption),
      ),
      h('p', { class: 'reading' }, c.reading),
      ...(c.cautions ?? []).map((text) => h('p', { class: 'caution' }, text)),
      ...(c.figures ?? []),
      facts(c.facts),
      c.extra ?? null,
    ),
    formula,
  );
}

function volatilityCard(quant: Quant | null): HTMLElement {
  const v = quant?.volatility ?? null;
  const g = v?.garch ?? null;
  const next = g?.nextAnnualPct ?? null;
  const long = g?.longRunAnnualPct ?? null;
  const ewma = v?.ewmaAnnualPct ?? null;
  let reading = t('explainNone');
  if (present(next) && present(long) && long > 0) {
    const ratio = next / long;
    const key = ratio >= 1.15 ? 'garchUp' : ratio <= 0.87 ? 'garchDown' : 'garchFlat';
    reading = t(key, { next: percent(next), long: percent(long) });
  } else if (present(next)) reading = t('garchOnly', { next: percent(next) });
  else if (present(ewma)) reading = t('ewmaOnly', { ewma: percent(ewma) });

  const term = (g?.termAnnualPct ?? []).flatMap((y, i) => (y === null ? [] : [{ x: i + 1, y }]));
  const axis = (y: number) => fixed(y, 0);

  return card({
    id: 'garch',
    title: 'garchTitle',
    headline: percent(next),
    caption: t('garchHead'),
    reading,
    figures: g
      ? [
          lineChart({
            name: t('garchSeries'),
            points: g.series.map((p) => ({ x: p.time, y: p.annualPct })),
            reference: long,
            format: axis,
          }),
          lineChart({
            name: t('garchTerm'),
            points: term,
            reference: long,
            height: 96,
            format: (y) => fixed(y, 1),
            xLabel: (x) => t('dayAhead', { n: x }),
          }),
        ]
      : [],
    facts: [
      [t('longRun'), percent(long)],
      [t('persistence'), fixed(g?.persistence, 3)],
      [t('halfLife'), days(g?.halfLifeDays)],
      [t('ewma'), percent(ewma)],
      [t('tailNu'), fixed(g?.nu, 1)],
    ],
    equations: [
      equation(sub('r', 't'), '=', 'μ', '+', sub('σ', 't'), sub('z', 't'), ',', gap(), sub('z', 't'), '∼', sub('t', 'ν')),
      equation(
        subsup('σ', 't', '2'),
        '=',
        'ω',
        '+',
        'α',
        sup(paren(sub('r', row('t', '−', '1')), '−', 'μ'), '2'),
        '+',
        'β',
        subsup('σ', row('t', '−', '1'), '2'),
      ),
      equation(
        subsup('σ', 't', '2'),
        '=',
        sciVal(g?.omega),
        '+',
        val(g?.alpha),
        sup(paren(sub('r', row('t', '−', '1')), '−', 'μ'), '2'),
        '+',
        val(g?.beta),
        subsup('σ', row('t', '−', '1'), '2'),
      ),
      equation('ω', '=', paren('1', '−', 'α', '−', 'β'), sup(over('σ', '‾'), '2')),
      equation(
        'E',
        '[',
        subsup('σ', row('t', '+', 'h'), '2'),
        ']',
        '=',
        sup(over('σ', '‾'), '2'),
        '+',
        sup(paren('α', '+', 'β'), row('h', '−', '1')),
        paren(subsup('σ', row('t', '+', '1'), '2'), '−', sup(over('σ', '‾'), '2')),
      ),
      equation(
        sub('h', row('1', '/', '2')),
        '=',
        frac(row(fn('ln'), paren(frac('1', '2'))), row(fn('ln'), paren('α', '+', 'β'))),
        gap(),
        sub('σ', 'ann'),
        '=',
        '100',
        sqrt('252'),
        'σ',
      ),
    ],
    params: [
      ['ω', precise(g?.omega)],
      ['α', fixed(g?.alpha, 4)],
      ['β', fixed(g?.beta, 4)],
      ['ν', fixed(g?.nu, 2)],
      ['α + β', fixed(g?.persistence, 4)],
      [t('halfLife'), days(g?.halfLifeDays)],
      [t('longRun'), percent(long)],
      [t('garchHead'), percent(next)],
    ],
    symbols: 'garchSym',
  });
}

function riskCard(quant: Quant | null): HTMLElement {
  const r = quant?.risk ?? null;
  const raw = r?.level ?? null;
  const level = raw === null ? null : raw > 1 ? raw / 100 : raw;
  const asPercent = (x: number | null) =>
    x === null ? t('noData') : percent(x * 100, Number.isInteger(Number((x * 100).toFixed(6))) ? 0 : 1);
  const levelText = asPercent(level);
  const tail = asPercent(level === null ? null : 1 - level);
  const hist = r?.varHistoricalPct ?? null;
  const es = r?.expectedShortfallPct ?? null;
  const vars = { tail, var: percent(hist, 2), es: percent(es, 2) };
  const reading =
    level !== null && hist !== null
      ? t(es === null ? 'riskVar' : 'riskFull', vars)
      : es !== null
        ? t('riskEs', vars)
        : t('explainNone');
  const jumps = r ? r.jumps.slice(-6).reverse() : [];
  const bars: [Key, number | null][] = [
    ['varHist', hist],
    ['varT', r?.varTPct ?? null],
    ['varCf', r?.varCornishFisherPct ?? null],
    ['es', es],
  ];

  return card({
    id: 'risk',
    title: 'riskTitle',
    headline: percent(hist, 2),
    caption: t('riskHead', { level: levelText }),
    reading,
    figures: r ? [barChart(t('riskBars'), bars.map(([key, value]) => ({ label: t(key), value })), (x) => percent(x, 2))] : [],
    facts: [
      [t('drawdown'), percent(r?.maxDrawdownPct, 1)],
      [t('jumps'), r ? String(r.jumps.length) : t('noData')],
    ],
    extra: !r
      ? null
      : jumps.length
        ? h(
            'table',
            { class: 'mini' },
            h('caption', {}, t('jumpsRecent')),
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', { scope: 'col' }, t('date')),
                h('th', { scope: 'col', class: 'num' }, t('ret')),
                h('th', { scope: 'col', class: 'num' }, t('statistic')),
              ),
            ),
            h(
              'tbody',
              {},
              ...jumps.map((j) =>
                h(
                  'tr',
                  {},
                  h('td', { class: 'mono' }, barDate(j.time, true)),
                  h('td', { class: `mono num ${tone(j.returnPct)}` }, pct(j.returnPct)),
                  h('td', { class: 'mono num' }, fixed(j.statistic, 2)),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted' }, t('noJumps')),
    equations: [
      equation('p', '=', '1', '−', 'c', '=', level === null ? val(null) : val(1 - level, 3)),
      equation(
        sub('VaR', 'hist'),
        '=',
        '1',
        '−',
        sup('e', row(sub('Q', 'p'), paren('r'))),
        ',',
        gap(),
        sub('VaR', 't'),
        '=',
        '1',
        '−',
        sup(
          'e',
          row(
            'μ',
            '+',
            sub('σ', row('t', '+', '1')),
            sqrt(frac(row('ν', '−', '2'), 'ν')),
            subsup('t', 'ν', row('−', '1')),
            paren('p'),
          ),
        ),
      ),
      equation(
        sub('z', 'CF'),
        '=',
        'z',
        '+',
        frac(row(paren(sup('z', '2'), '−', '1'), 'S'), '6'),
        '+',
        frac(row(paren(sup('z', '3'), '−', '3', 'z'), 'K'), '24'),
        '−',
        frac(row(paren('2', sup('z', '3'), '−', '5', 'z'), sup('S', '2')), '36'),
      ),
      equation(
        'ES',
        '=',
        'E',
        '[',
        '1',
        '−',
        sup('e', 'r'),
        '∣',
        'r',
        '≤',
        sub('Q', 'p'),
        paren('r'),
        ']',
        ',',
        gap(),
        'MDD',
        '=',
        under('max', 't'),
        paren('1', '−', frac(sub('C', 't'), row(under('max', row('s', '≤', 't')), sub('C', 's')))),
      ),
      equation(
        sub('L', 't'),
        '=',
        frac(row('|', sub('r', 't'), '|'), sub(over('σ', '^'), 't')),
        ',',
        gap(),
        subsup(over('σ', '^'), 't', '2'),
        '=',
        frac('π', row('2', paren('K', '−', '1'))),
        underover('∑', row('j', '=', 't', '−', 'K', '+', '1'), row('t', '−', '1')),
        '|',
        sub('r', 'j'),
        '|',
        '|',
        sub('r', row('j', '−', '1')),
        '|',
      ),
    ],
    params: [
      ['c', levelText],
      [t('varHist'), percent(hist, 2)],
      [t('varT'), percent(r?.varTPct, 2)],
      [t('varCf'), percent(r?.varCornishFisherPct, 2)],
      [t('es'), percent(es, 2)],
      [t('drawdown'), percent(r?.maxDrawdownPct, 2)],
    ],
    symbols: 'riskSym',
  });
}

function betaCard(quant: Quant | null): HTMLElement {
  const b = quant?.beta ?? null;
  const latest = b?.latest ?? null;
  let reading = t('explainNone');
  if (latest !== null) {
    const key = latest < 0 ? 'betaNegative' : latest > 1.15 ? 'betaHigh' : latest < 0.85 ? 'betaLow' : 'betaFlat';
    reading = t(key, { beta: fixed(latest, 2) });
  }
  const interval =
    b && b.low !== null && b.high !== null ? `${fixed(b.low, 2)} … ${fixed(b.high, 2)}` : t('noData');
  return card({
    id: 'beta',
    title: 'betaTitle',
    headline: fixed(latest, 2),
    caption: t('betaHead'),
    reading,
    figures: b
      ? [
          lineChart({
            name: t('betaSeries'),
            points: b.series.map((p) => ({ x: p.time, y: p.beta })),
            band: b.series.flatMap((p) =>
              p.low === null || p.high === null ? [] : [{ x: p.time, low: p.low, high: p.high }],
            ),
            reference: b.constant,
            format: (y) => fixed(y, 2),
          }),
        ]
      : [],
    facts: [
      [t('betaBand'), interval],
      [t('betaConstant'), fixed(b?.constant, 2)],
    ],
    equations: [
      equation(sub('r', 't'), '=', 'α', '+', sub('β', 't'), sub('m', 't'), '+', sub('e', 't'), ',', gap(), sub('e', 't'), '∼', 'N', paren('0', ',', 'R')),
      equation(sub('β', 't'), '=', sub('β', row('t', '−', '1')), '+', sub('w', 't'), ',', gap(), sub('w', 't'), '∼', 'N', paren('0', ',', 'Q')),
      equation(
        sub('K', 't'),
        '=',
        frac(
          row(paren(sub('P', row('t', '−', '1')), '+', 'Q'), sub('m', 't')),
          row(subsup('m', 't', '2'), paren(sub('P', row('t', '−', '1')), '+', 'Q'), '+', 'R'),
        ),
        ',',
        gap(),
        sub('P', 't'),
        '=',
        paren('1', '−', sub('K', 't'), sub('m', 't')),
        paren(sub('P', row('t', '−', '1')), '+', 'Q'),
      ),
      equation(
        sub(over('β', '^'), 't'),
        '=',
        sub(over('β', '^'), row('t', '−', '1')),
        '+',
        sub('K', 't'),
        paren(sub('r', 't'), '−', 'α', '−', sub(over('β', '^'), row('t', '−', '1')), sub('m', 't')),
      ),
      equation(sub(over('β', '^'), 't'), '=', val(latest, 3), ',', gap(), '[', val(b?.low, 3), ',', val(b?.high, 3), ']'),
    ],
    params: [
      [t('betaHead'), fixed(latest, 3)],
      [t('betaBand'), interval],
      [t('betaConstant'), fixed(b?.constant, 3)],
    ],
    symbols: 'betaSym',
  });
}

function regimeCard(quant: Quant | null): HTMLElement {
  const r = quant?.regime ?? null;
  const p = r?.probabilityTurbulent ?? null;
  const reading =
    p === null
      ? t('explainNone')
      : t(p >= 0.7 ? 'regimeHigh' : p <= 0.3 ? 'regimeLow' : 'regimeMid', { p: share(p) });
  // Staying probability implied by the expected spell length d = 1 / (1 − p).
  const stay = (d: number | null | undefined) => (present(d) && d >= 1 ? 1 - 1 / d : null);
  return card({
    id: 'regime',
    title: 'regimeTitle',
    headline: share(p),
    caption: t('regimeHead'),
    reading,
    figures: r
      ? [
          lineChart({
            name: t('regimeSeries'),
            points: r.series.map((point) => ({ x: point.time, y: point.p * 100 })),
            domain: [0, 100],
            reference: 50,
            format: (y) => fixed(y, 0),
          }),
        ]
      : [],
    facts: [
      [t('calmVol'), percent(r?.calmAnnualPct)],
      [t('turbVol'), percent(r?.turbulentAnnualPct)],
      [t('calmDays'), days(r?.calmDays)],
      [t('turbDays'), days(r?.turbulentDays)],
    ],
    equations: [
      equation(sub('r', 't'), '∣', sub('S', 't'), '=', 'k', '∼', 'N', paren(sub('μ', 'k'), ',', subsup('σ', 'k', '2'))),
      equation(
        sub('ξ', 't'),
        paren('j'),
        '∝',
        sub('f', 'j'),
        paren(sub('r', 't')),
        under('∑', 'i'),
        sub('ξ', row('t', '−', '1')),
        paren('i'),
        sub('p', row('i', 'j')),
      ),
      equation(sub('d', 'k'), '=', frac('1', row('1', '−', sub('p', row('k', 'k'))))),
      equation(
        sub('p', '00'),
        '=',
        val(stay(r?.calmDays)),
        ',',
        gap(),
        sub('p', '11'),
        '=',
        val(stay(r?.turbulentDays)),
      ),
    ],
    params: [
      [t('regimeHead'), share(p, 1)],
      ['σ₀', percent(r?.calmAnnualPct)],
      ['σ₁', percent(r?.turbulentAnnualPct)],
      ['d₀', days(r?.calmDays)],
      ['d₁', days(r?.turbulentDays)],
    ],
    symbols: 'regimeSym',
  });
}

function changepointCard(quant: Quant | null, data: Dossier): HTMLElement {
  const c = quant?.changepoint ?? null;
  const p = c?.recentProbability ?? null;
  const reading =
    p === null ? t('explainNone') : t(p >= 0.5 ? 'cpHigh' : p >= 0.2 ? 'cpMid' : 'cpLow', { p: share(p) });
  const latest = c?.breaks[c.breaks.length - 1];
  const start = data.history[0]?.t;
  const earlier = c && start !== undefined ? c.breaks.filter((time) => time < start).length : 0;
  return card({
    id: 'changepoint',
    title: 'cpTitle',
    headline: share(p),
    caption: t('cpHead'),
    reading,
    figures: c
      ? [
          lineChart({
            name: t('cpSeries'),
            points: data.history.map((bar) => ({ x: bar.t, y: bar.c })),
            marks: c.breaks,
            format: (y) => fixed(y, y >= 1000 ? 0 : 1),
          }),
          earlier ? h('p', { class: 'muted' }, t('cpOutside', { n: earlier })) : null,
        ]
      : [],
    facts: [
      [t('runLength'), days(c?.runLengthDays)],
      [t('breaksCount'), c ? String(c.breaks.length) : t('noData')],
      [t('lastBreak'), latest === undefined ? t('noData') : barDate(latest, true)],
    ],
    equations: [
      equation(
        'P',
        paren(sub('ρ', 't'), '=', 'k', '+', '1'),
        '∝',
        'P',
        paren(sub('ρ', row('t', '−', '1')), '=', 'k'),
        sub('π', 'k'),
        paren(sub('x', 't')),
        paren('1', '−', 'H'),
      ),
      equation('P', paren(sub('ρ', 't'), '=', '0'), '=', 'H'),
      equation(
        sub('π', 'k'),
        paren('x'),
        '=',
        sub('t', row('2', sub('α', 'k'))),
        paren(
          'x',
          ';',
          sub('μ', 'k'),
          ',',
          frac(
            row(sub('β', 'k'), paren(sub('κ', 'k'), '+', '1')),
            row(sub('α', 'k'), sub('κ', 'k')),
          ),
        ),
      ),
      equation(
        sub('p', 'recent'),
        '=',
        'P',
        paren(sub('ρ', 't'), '≤', 'w'),
        '=',
        val(p),
        ',',
        gap(),
        sub(over('ρ', '^'), 't'),
        '=',
        val(c?.runLengthDays, 0),
      ),
    ],
    params: [
      [t('cpHead'), share(p, 1)],
      [t('runLength'), days(c?.runLengthDays)],
      [t('breaksCount'), c ? String(c.breaks.length) : t('noData')],
    ],
    symbols: 'cpSym',
  });
}

function newsflowCard(quant: Quant | null): HTMLElement {
  const n = quant?.newsflow ?? null;
  const branching = n?.branching ?? null;
  const halfLife = n?.halfLifeHours ?? null;
  // Decay rate per day implied by the half-life.
  const decay = halfLife !== null && halfLife > 0 ? (Math.LN2 * 24) / halfLife : null;
  let reading = t('explainNone');
  if (n?.selfExciting === false) reading = t('hawkesNo');
  else if (n?.selfExciting && branching !== null) reading = t('hawkesYes', { share: share(branching) });
  const cautions: string[] = [];
  if (n?.windowStartCovered === false) cautions.push(t('hawkesWindow'));
  if (present(n?.fitPValue) && n.fitPValue < 0.05) cautions.push(t('hawkesPoor', { p: pValue(n.fitPValue) }));
  const perDay = (x: number | null | undefined) => (present(x) ? t('perDay', { n: fixed(x, 1) }) : t('noData'));
  const hours = present(halfLife) ? t('hoursShort', { n: fixed(halfLife, 1) }) : t('noData');
  return card({
    id: 'newsflow',
    title: 'hawkesTitle',
    headline: fixed(branching, 2),
    caption: t('hawkesHead'),
    reading,
    cautions,
    figures: n
      ? [
          barChart(
            t('hawkesBars'),
            [
              { label: t('intensity'), value: n.intensityPerDay },
              { label: t('baseline'), value: n.baselinePerDay },
            ],
            (x) => fixed(x, 1),
          ),
        ]
      : [],
    facts: [
      [t('newsEvents'), fixed(n?.events, 0)],
      [t('newsHalfLife'), hours],
      [t('intensity'), perDay(n?.intensityPerDay)],
      [t('baseline'), perDay(n?.baselinePerDay)],
      [t('selfExciting'), present(n?.selfExciting) ? t(n.selfExciting ? 'yes' : 'no') : t('noData')],
      [t('fitP'), present(n?.fitPValue) ? pValue(n.fitPValue) : t('noData')],
      [t('effSources'), fixed(n?.diversity?.effectiveSources, 1)],
      [t('diversity'), fixed(n?.diversity?.normalized, 2)],
    ],
    equations: [
      equation(
        'λ',
        paren('t'),
        '=',
        'μ',
        '+',
        under('∑', row(sub('t', 'i'), '<', 't')),
        'n',
        'β',
        sup('e', row('−', 'β', paren('t', '−', sub('t', 'i')))),
      ),
      equation(
        fn('ln'),
        'L',
        '=',
        under('∑', 'i'),
        fn('ln'),
        'λ',
        paren(sub('t', 'i')),
        '−',
        underover('∫', '0', 'T'),
        'λ',
        paren('s'),
        'd',
        's',
      ),
      equation(
        'n',
        '=',
        val(branching),
        ',',
        gap(),
        'β',
        '=',
        frac(row(fn('ln'), '2'), sub('h', row('1', '/', '2'))),
        '=',
        val(decay, 2),
        sup(mtext('d'), row('−', '1')),
      ),
      equation(
        sub('N', 'eff'),
        '=',
        fn('exp'),
        paren(mo('−'), underover('∑', row('k', '=', '1'), 'K'), sub('s', 'k'), fn('ln'), sub('s', 'k')),
      ),
    ],
    params: [
      ['n', fixed(branching, 3)],
      [t('newsHalfLife'), hours],
      [t('intensity'), perDay(n?.intensityPerDay)],
      [t('baseline'), perDay(n?.baselinePerDay)],
      [t('effSources'), fixed(n?.diversity?.effectiveSources, 2)],
    ],
    symbols: 'hawkesSym',
  });
}

/** One headline per distinct event window, smallest q first. */
function smallestQ(events: DossierEvent[], limit: number): DossierEvent[] {
  const seen = new Set<string>();
  return events
    .filter((e) => e.impact !== null && e.impact.q !== null)
    .sort((a, b) => (a.impact?.q ?? 1) - (b.impact?.q ?? 1) || b.time - a.time)
    .filter((e) => {
      const key = `${e.impact?.carPct}|${e.impact?.z}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function testingCard(quant: Quant | null, data: Dossier, onEvent: (id: string) => void): HTMLElement {
  const m = quant?.multipleTesting ?? null;
  const tested = m?.tested ?? null;
  const found = m?.discoveries ?? null;
  const raw = m?.level ?? null;
  const level = share(raw);
  let reading = t('explainNone');
  if (tested !== null && found === 0) reading = t('testNone', { m: tested });
  else if (tested !== null && found !== null && raw !== null) reading = t('testSome', { d: found, m: tested, level });
  const count = (x: number | null | undefined) => fixed(x, 0);
  const top = smallestQ(data.events, 6);
  return card({
    id: 'testing',
    title: 'testTitle',
    headline: found === null || tested === null ? t('noData') : `${found} / ${tested}`,
    caption: t('testHead'),
    reading,
    figures: m
      ? [
          barChart(
            t('testBars'),
            [
              { label: t('testTested'), value: tested },
              { label: t('testNominal'), value: m.nominal },
              { label: t('testSurvive'), value: found },
            ],
            (x) => fixed(x, 0),
          ),
        ]
      : [],
    facts: [
      [t('testTested'), count(tested)],
      [t('testNominal'), count(m?.nominal)],
      [t('testSurvive'), count(found)],
      [t('testLevel'), level],
    ],
    extra: top.length
      ? h(
          'div',
          { class: 'q-list' },
          h('h3', {}, t('testList')),
          h(
            'ol',
            {},
            ...top.map((event) =>
              h(
                'li',
                {},
                h(
                  'button',
                  { type: 'button', 'data-key': `q-${event.id}`, onclick: () => onEvent(event.id) },
                  h(
                    'span',
                    { class: 'mono q-numbers' },
                    `q ${pValue(event.impact?.q)} · z ${signed(event.impact?.z)} · CAR ${pct(event.impact?.carPct)} · ${stamp(event.time)}`,
                  ),
                  h('span', { class: 'clamp', dir: 'auto' }, event.title),
                ),
                consequencesOf(event, 'model'),
              ),
            ),
          ),
        )
      : null,
    equations: [
      equation(sub('p', 'i'), '∈', '[', '0', ',', '1', ']', ',', gap(), sub('p', paren('1')), '≤', '⋯', '≤', sub('p', paren('m'))),
      equation(
        sub('q', paren('i')),
        '=',
        under('min', row('j', '≥', 'i')),
        fn('min'),
        paren('1', ',', frac(row('m', sub('p', paren('j'))), 'j')),
      ),
      equation(
        'D',
        '=',
        '#',
        '{',
        'i',
        ':',
        sub('q', 'i'),
        '≤',
        'α',
        '}',
        ',',
        gap(),
        'm',
        '=',
        val(tested, 0),
        ',',
        gap(),
        'α',
        '=',
        val(raw, 2),
        ',',
        gap(),
        'D',
        '=',
        val(found, 0),
      ),
    ],
    params: [
      ['m', count(tested)],
      ['α', level],
      ['D', count(found)],
    ],
    symbols: 'testSym',
  });
}

export function modelView(data: Dossier, onEvent: (id: string) => void): HTMLElement {
  const quant = data.quant;
  const meta: string[] = [];
  if (present(quant?.sample)) meta.push(t('modelSample', { n: quant.sample }));
  if (present(quant?.asOf)) meta.push(t('asOf', { time: stamp(quant.asOf) }));
  return h(
    'div',
    { class: 'model' },
    h(
      'section',
      { class: 'panel model-intro', 'data-anchor': 'model-intro' },
      h('header', { class: 'panel-head' }, h('h2', {}, t('modelTitle'))),
      h('p', {}, t('modelIntro')),
      meta.length ? h('p', { class: 'muted mono', 'data-meta': '' }, meta.join(' · ')) : null,
      quant ? null : h('p', { class: 'caution' }, t('modelAbsent')),
    ),
    h(
      'div',
      { class: 'model-grid' },
      volatilityCard(quant),
      riskCard(quant),
      betaCard(quant),
      regimeCard(quant),
      changepointCard(quant, data),
      newsflowCard(quant),
      testingCard(quant, data, onEvent),
    ),
  );
}
