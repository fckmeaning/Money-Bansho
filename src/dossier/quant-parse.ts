// Field-by-field validation of the model outputs (signals, event impact, quant).
// A value of the wrong type or outside its mathematical domain becomes null.
import { IMPACT_LEVELS, SIGNAL_PARTS } from './types';
import type {
  Garch,
  Impact,
  Quant,
  QuantBeta,
  QuantChangepoint,
  QuantNewsflow,
  QuantRegime,
  QuantRisk,
  QuantTesting,
  QuantVolatility,
  ReturnModel,
  Signals,
} from './types';

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A finite number inside [min, max]; anything else is "no data". */
export function within(v: unknown, min: number, max = Infinity): number | null {
  const n = num(v);
  return n === null || n < min || n > max ? null : n;
}
const nonNegative = (v: unknown) => within(v, 0);
const probability = (v: unknown) => within(v, 0, 1);
const count = (v: unknown): number | null => {
  const n = nonNegative(v);
  return n !== null && Number.isInteger(n) ? n : null;
};
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
function oneOf<T extends string>(v: unknown, options: readonly T[]): T | null {
  return options.includes(v as T) ? (v as T) : null;
}
const returnModel = (v: unknown) => oneOf<ReturnModel>(v, ['market', 'naive']);

/** An object parsed by `build`, or null when the value is not an object. */
function section<T>(v: unknown, build: (o: Obj) => T): T | null {
  return isObj(v) ? build(v) : null;
}

/** True when at least one field carries information. */
function informative(o: object): boolean {
  return Object.values(o).some((v) => (Array.isArray(v) ? v.some((x) => x !== null) : v !== null));
}

function nonEmpty<T extends object>(v: T | null): T | null {
  return v && informative(v) ? v : null;
}

/** Time series: points without a valid time and value are dropped, oldest first. */
function points<T extends { time: number }>(v: unknown, build: (o: Obj, time: number) => T | null): T[] {
  const out: T[] = [];
  for (const raw of list(v)) {
    if (!isObj(raw)) continue;
    const time = nonNegative(raw.time);
    if (time === null) continue;
    const point = build(raw, time);
    if (point) out.push(point);
  }
  return out.sort((a, b) => a.time - b.time);
}

export function impactOf(v: unknown): Impact | null {
  const impact = section(v, (o): Impact => ({
    carPct: num(o.carPct),
    z: num(o.z),
    level: oneOf(o.level, IMPACT_LEVELS),
    sessions: count(o.sessions),
    preCarPct: num(o.preCarPct),
    preZ: num(o.preZ),
    volumeRatio: nonNegative(o.volumeRatio),
    beta: num(o.beta),
    sample: count(o.sample),
    model: returnModel(o.model),
    p: probability(o.p),
    q: probability(o.q),
  }));
  // Without the effect itself there is nothing to report.
  return impact && (impact.carPct !== null || impact.z !== null) ? impact : null;
}

export function signalsOf(v: unknown): Signals | null {
  if (!isObj(v)) return null;
  const parts: NonNullable<Signals['attention']>['parts'] = [];
  const rawAttention = isObj(v.attention) ? v.attention : null;
  for (const raw of list(rawAttention?.parts)) {
    if (!isObj(raw)) continue;
    const key = oneOf(raw.key, SIGNAL_PARTS);
    const share = probability(raw.share);
    if (key && share !== null && !parts.some((p) => p.key === key)) parts.push({ key, share });
  }
  return {
    price: nonEmpty(
      section(v.price, (o) => ({
        abnormalPct: num(o.abnormalPct),
        z: num(o.z),
        beta: num(o.beta),
        sample: count(o.sample),
        model: returnModel(o.model),
      })),
    ),
    volumeRatio: nonNegative(v.volumeRatio),
    volatility: nonEmpty(
      section(v.volatility, (o) => ({
        ratio: nonNegative(o.ratio),
        annualPct: nonNegative(o.annualPct),
        label: oneOf(o.label, ['calm', 'normal', 'elevated'] as const),
      })),
    ),
    news: nonEmpty(
      section(v.news, (o) => ({
        today: nonNegative(o.today),
        expected: nonNegative(o.expected),
        z: num(o.z),
      })),
    ),
    attention: nonEmpty(
      section(v.attention, (o) => ({
        score: within(o.score, 0, 100),
        label: oneOf(o.label, ['ordinary', 'elevated', 'unusual'] as const),
        coverage: probability(o.coverage),
        parts,
      })),
    ),
  };
}

function garchOf(o: Obj): Garch {
  const term = list(o.termAnnualPct).map(nonNegative);
  return {
    omega: nonNegative(o.omega),
    alpha: nonNegative(o.alpha),
    beta: nonNegative(o.beta),
    // Degrees of freedom of a unit-variance Student t exceed 2.
    nu: within(o.nu, 2),
    persistence: nonNegative(o.persistence),
    halfLifeDays: nonNegative(o.halfLifeDays),
    longRunAnnualPct: nonNegative(o.longRunAnnualPct),
    nextAnnualPct: nonNegative(o.nextAnnualPct),
    termAnnualPct: term.some((x) => x !== null) ? term : [],
    series: points(o.series, (p, time) => {
      const annualPct = nonNegative(p.annualPct);
      return annualPct === null ? null : { time, annualPct };
    }),
  };
}

const volatilityOf = (o: Obj): QuantVolatility => ({
  garch: nonEmpty(section(o.garch, garchOf)),
  ewmaAnnualPct: nonNegative(o.ewmaAnnualPct),
});

const riskOf = (o: Obj): QuantRisk => ({
  // A confidence level, accepted as a fraction (0.99) or a percentage (99).
  level: within(o.level, 0, 100),
  varHistoricalPct: nonNegative(o.varHistoricalPct),
  varTPct: nonNegative(o.varTPct),
  varCornishFisherPct: nonNegative(o.varCornishFisherPct),
  expectedShortfallPct: nonNegative(o.expectedShortfallPct),
  maxDrawdownPct: within(o.maxDrawdownPct, 0, 100),
  jumps: points(o.jumps, (p, time) => ({
    time,
    returnPct: num(p.returnPct),
    statistic: nonNegative(p.statistic),
  })),
});

const betaOf = (o: Obj): QuantBeta => ({
  latest: num(o.latest),
  low: num(o.low),
  high: num(o.high),
  constant: num(o.constant),
  series: points(o.series, (p, time) => {
    const beta = num(p.beta);
    return beta === null ? null : { time, beta, low: num(p.low), high: num(p.high) };
  }),
});

const regimeOf = (o: Obj): QuantRegime => ({
  probabilityTurbulent: probability(o.probabilityTurbulent),
  calmAnnualPct: nonNegative(o.calmAnnualPct),
  turbulentAnnualPct: nonNegative(o.turbulentAnnualPct),
  calmDays: nonNegative(o.calmDays),
  turbulentDays: nonNegative(o.turbulentDays),
  series: points(o.series, (point, time) => {
    const p = probability(point.p);
    return p === null ? null : { time, p };
  }),
});

const changepointOf = (o: Obj): QuantChangepoint => ({
  recentProbability: probability(o.recentProbability),
  runLengthDays: nonNegative(o.runLengthDays),
  breaks: list(o.breaks)
    .map(nonNegative)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b),
});

const newsflowOf = (o: Obj): QuantNewsflow => ({
  events: count(o.events),
  branching: probability(o.branching),
  halfLifeHours: nonNegative(o.halfLifeHours),
  intensityPerDay: nonNegative(o.intensityPerDay),
  baselinePerDay: nonNegative(o.baselinePerDay),
  selfExciting: flag(o.selfExciting),
  fitPValue: probability(o.fitPValue),
  windowStartCovered: flag(o.windowStartCovered),
  diversity: nonEmpty(
    section(o.diversity, (d) => ({
      effectiveSources: nonNegative(d.effectiveSources),
      normalized: probability(d.normalized),
    })),
  ),
});

const testingOf = (o: Obj): QuantTesting => ({
  tested: count(o.tested),
  nominal: count(o.nominal),
  discoveries: count(o.discoveries),
  level: probability(o.level),
});

export function quantOf(v: unknown): Quant | null {
  if (!isObj(v)) return null;
  return nonEmpty<Quant>({
    asOf: nonNegative(v.asOf),
    sample: count(v.sample),
    volatility: nonEmpty(section(v.volatility, volatilityOf)),
    risk: nonEmpty(section(v.risk, riskOf)),
    beta: nonEmpty(section(v.beta, betaOf)),
    regime: nonEmpty(section(v.regime, regimeOf)),
    changepoint: nonEmpty(section(v.changepoint, changepointOf)),
    newsflow: nonEmpty(section(v.newsflow, newsflowOf)),
    multipleTesting: nonEmpty(section(v.multipleTesting, testingOf)),
  });
}
