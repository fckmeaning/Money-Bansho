// Assembles the heavy models into the `quant` block of the dossier response.
import { alignedReturns, ESTIMATION_SESSIONS, fitMarketModel } from '../quant.js';
import { detectChangepoints } from './changepoint.js';
import { fitHawkes } from './hawkes.js';
import { fitRegimes } from './hmm.js';
import { benjaminiHochberg, sourceDiversity } from './inference.js';
import { kalmanMarketModel } from './kalman.js';
import { detectJumps, maxDrawdown, valueAtRisk } from './risk.js';
import { studentTTwoSided } from './special.js';
import { round } from './stats.js';
import { ewmaVolatility, fitGarch, garchForecast } from './volatility.js';

const MAX_SESSIONS = 500;
const SERIES_POINTS = 260;
const FDR_LEVEL = 0.1;
const annual = (daily) => (Number.isFinite(daily) ? round(daily * Math.sqrt(252) * 100, 2) : null);
const percent = (fraction) => (Number.isFinite(fraction) ? round(fraction * 100, 3) : null);

/** A model that fails must not take the whole dossier down with it. */
function attempt(name, errors, build) {
  try {
    return build();
  } catch (error) {
    errors.push({ source: `model:${name}`, message: String(error?.message || error).slice(0, 200) });
    return null;
  }
}

const tail = (times, values, make) => values
  .map((value, i) => make(times[i], value, i))
  .slice(-SERIES_POINTS);

function volatility(returns, times) {
  const ewma = ewmaVolatility(returns);
  const fit = fitGarch(returns);
  if (!ewma && !fit) return null;
  return {
    garch: fit ? {
      omega: fit.omega,
      alpha: round(fit.alpha, 4),
      beta: round(fit.beta, 4),
      nu: round(fit.nu, 2),
      persistence: round(fit.persistence, 4),
      halfLifeDays: round(fit.halfLifeDays, 1),
      longRunAnnualPct: annual(fit.longRunSigma),
      nextAnnualPct: annual(fit.sigmaNext),
      termAnnualPct: garchForecast(fit, 20).map(annual),
      series: tail(times, fit.sigmaSeries, (time, sigma) => ({ time, annualPct: annual(sigma) })),
    } : null,
    ewmaAnnualPct: annual(ewma?.sigma),
  };
}

function risk(returns, times, history, sigmaNext, nu) {
  const level = 0.99;
  const value = valueAtRisk(returns, { level, sigma: sigmaNext, nu });
  if (!value) return null;
  const drawdown = maxDrawdown(history.map((bar) => bar.c));
  return {
    level,
    varHistoricalPct: percent(value.historical),
    varTPct: percent(value.parametricT),
    varCornishFisherPct: percent(value.cornishFisher),
    expectedShortfallPct: percent(value.expectedShortfall),
    maxDrawdownPct: percent(drawdown?.depth),
    jumps: detectJumps(returns).slice(-12).map((j) => ({
      time: times[j.index],
      returnPct: percent(Math.expm1(j.return)),
      statistic: round(j.statistic, 2),
    })),
  };
}

function timeVaryingBeta(rows) {
  const paired = rows.filter((r) => Number.isFinite(r.s) && Number.isFinite(r.m));
  const fit = kalmanMarketModel(paired.map((r) => r.s), paired.map((r) => r.m));
  if (!fit) return null;
  const band = (beta, std) => ({ low: round(beta - 1.96 * std, 3), high: round(beta + 1.96 * std, 3) });
  return {
    latest: round(fit.latestBeta, 3),
    ...band(fit.latestBeta, fit.latestStd),
    constant: round(fitMarketModel(paired.slice(-ESTIMATION_SESSIONS)).beta, 3),
    series: tail(paired.map((r) => r.closeAt), fit.beta, (time, beta, i) => ({
      time, beta: round(beta, 3), ...band(beta, fit.betaStd[i]),
    })),
  };
}

function regime(returns, times) {
  const fit = fitRegimes(returns);
  if (!fit) return null;
  return {
    probabilityTurbulent: round(fit.probabilityTurbulent, 4),
    calmAnnualPct: annual(fit.states[0].sigma),
    turbulentAnnualPct: annual(fit.states[1].sigma),
    calmDays: round(fit.expectedDurationDays[0], 1),
    turbulentDays: round(fit.expectedDurationDays[1], 1),
    series: tail(times, fit.series, (time, p) => ({ time, p: round(p, 4) })),
  };
}

function changepoint(returns, times) {
  const found = detectChangepoints(returns);
  if (!found) return null;
  return {
    recentProbability: round(found.recentProbability, 4),
    runLengthDays: found.runLengthDays,
    breaks: found.breaks.map((i) => times[i]).filter(Number.isFinite),
  };
}

function newsflow(events, nowMs) {
  const fit = fitHawkes(events.map((e) => e.time), nowMs);
  if (!fit) return null;
  const diversity = sourceDiversity(events.map((e) => e.source));
  return {
    events: fit.events,
    branching: fit.branching,
    halfLifeHours: fit.halfLifeHours,
    intensityPerDay: fit.intensityNow,
    baselinePerDay: fit.baselinePerDay,
    selfExciting: fit.selfExciting,
    fitPValue: fit.fitPValue,
    windowStartCovered: fit.windowStartCovered,
    diversity: diversity
      ? { effectiveSources: round(diversity.effectiveSources, 1), normalized: round(diversity.normalized, 3) }
      : null,
  };
}

/**
 * Adds two-sided p-values and Benjamini-Hochberg q-values to event impacts.
 * Headlines sharing one price window are a single test, not many.
 */
export function withSignificance(events) {
  const keyOf = (impact) => `${impact.carPct}|${impact.z}|${impact.sample}`;
  const windows = new Map();
  for (const { impact } of events) {
    if (!impact || !Number.isFinite(impact.z) || windows.has(keyOf(impact))) continue;
    windows.set(keyOf(impact), studentTTwoSided(impact.z, Math.max(1, impact.sample - 2)));
  }
  const keys = [...windows.keys()];
  const corrected = benjaminiHochberg(keys.map((k) => windows.get(k)), FDR_LEVEL);
  const q = new Map(keys.map((k, i) => [k, corrected.qValues[i]]));
  return {
    events: events.map((event) => {
      if (!event.impact || !windows.has(keyOf(event.impact))) return event;
      const key = keyOf(event.impact);
      return { ...event, impact: { ...event.impact, p: round(windows.get(key), 5), q: round(q.get(key), 5) } };
    }),
    summary: keys.length ? {
      tested: corrected.tested,
      nominal: [...windows.values()].filter((p) => p < 0.05).length,
      discoveries: corrected.discoveries,
      level: FDR_LEVEL,
    } : null,
  };
}

export function quantReport({ history, benchmarkHistory, events }, multipleTesting, errors, nowMs = Date.now()) {
  const rows = alignedReturns(history, benchmarkHistory, nowMs).slice(-MAX_SESSIONS);
  const priced = rows.filter((r) => Number.isFinite(r.s));
  if (!priced.length) return null;
  const returns = priced.map((r) => r.s);
  const times = priced.map((r) => r.closeAt);
  const vol = attempt('volatility', errors, () => volatility(returns, times));
  const garch = vol?.garch;
  return {
    asOf: times[times.length - 1],
    sample: returns.length,
    volatility: vol,
    risk: attempt('risk', errors, () => risk(
      returns, times, history,
      garch ? garch.nextAnnualPct / 100 / Math.sqrt(252) : undefined, garch?.nu,
    )),
    beta: attempt('beta', errors, () => timeVaryingBeta(rows)),
    regime: attempt('regime', errors, () => regime(returns, times)),
    changepoint: attempt('changepoint', errors, () => changepoint(returns, times)),
    newsflow: attempt('newsflow', errors, () => newsflow(events, nowMs)),
    multipleTesting,
  };
}
