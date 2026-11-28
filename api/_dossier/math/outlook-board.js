// Market-wide forecast for the overview: one corridor per listed company from the closes the screener
// has already loaded (no extra request). The close-only model of volmodel.js; docs/math/forecast.md.
import { distribution, prepareSeries, stateAt } from './volmodel.js';
import { round } from './stats.js';

const HORIZONS = [1, 5, 20];
const REFERENCE = 5; // horizon of the "expected volatility" columns
const LOOK_BACK = 5; // sessions: how much the expectation has changed in about a week

const pct = (log) => round((Math.exp(log) - 1) * 100, 2);

/** Expected daily volatility (standard deviation of the predictive distribution) per session. */
function daily(state, h) {
  return distribution(state.forecast(h)).stdev / Math.sqrt(h);
}

/**
 * {asOf, horizons, annualPct, usualAnnualPct, vsUsual, change5Pct} for one company, or null when one
 * year of closes is not there. `history` and `benchmarkHistory` are raw daily bars.
 */
export function companyOutlook(history, benchmarkHistory, nowMs = Date.now()) {
  const series = prepareSeries(history, benchmarkHistory, nowMs);
  const t = series.rows.length - 1;
  // The same model for every company, so that the table compares like with like.
  const state = t >= 0 ? stateAt(series, t, t >= 200 ? 'close' : null) : null;
  if (!state || state.kind !== 'close') return null;
  const horizons = HORIZONS.map((h) => {
    const d = distribution(state.forecast(h));
    const low = d.quantile(0.1);
    const high = d.quantile(0.9);
    return { h, low80Pct: pct(low), high80Pct: pct(high), widthPct: round(pct(high) - pct(low), 2) };
  });
  const now = daily(state, REFERENCE);
  const month = series.squared.slice(-22);
  const realised = Math.sqrt(month.reduce((a, b) => a + b, 0) / month.length);
  const earlier = t - LOOK_BACK >= 200 ? stateAt(series, t - LOOK_BACK, 'close') : null;
  return {
    asOf: series.rows[t].closeAt,
    horizons,
    annualPct: round(now * Math.sqrt(252) * 100, 1),
    usualAnnualPct: round(state.usual * Math.sqrt(252) * 100, 1),
    vsUsual: round(now / state.usual, 2),
    // What already happened, on the same scale: a check that "usual" is not set too low.
    realisedVsUsual: round(realised / state.usual, 2),
    change5Pct: earlier ? round((now / daily(earlier, REFERENCE) - 1) * 100, 1) : null,
  };
}
