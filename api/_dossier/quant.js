// Bansho Signal Model: pure functions over daily bars and classified events.
// Formulas and constants are explained in docs/bansho-math.md.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const MAX_GAP = 10 * DAY;
export const ESTIMATION_SESSIONS = 120;
export const MIN_ESTIMATION = 30;
export const EVENT_GAP = 5; // sessions kept out of the estimation window before the event
export const PRE_SESSIONS = 5;
export const POST_SESSIONS = 2; // day 0 and day +1
export const Z_NOTABLE = 1;
export const Z_SIGNIFICANT = 1.96;

const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
const pct = (logReturn) => round((Math.exp(logReturn) - 1) * 100);

function stdev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

/** Regular session length, inferred from the UTC hour at which the daily bar opens. */
function sessionLength(timeOfDay) {
  const hour = timeOfDay / HOUR;
  if (hour >= 6 && hour < 11) return 8.5 * HOUR; // Europe, Israel
  return 6.5 * HOUR; // Americas, East Asia
}

/**
 * Daily bars are stamped with the session OPEN, so each close happens later than `t`.
 * The newest bar of a running session may instead be stamped with the last trade time;
 * it then takes the usual time of day of the previous bar.
 */
export function withCloseTimes(history) {
  const bars = (history || [])
    .filter((b) => b && Number.isFinite(b.t) && Number.isFinite(b.c) && b.c > 0)
    .sort((a, b) => a.t - b.t);
  return bars.map((bar, i) => {
    const day = Number.isInteger(bar.day) ? bar.day : Math.floor(bar.t / DAY);
    let open = bar.t;
    if (i === bars.length - 1 && i > 0) {
      const previous = bars[i - 1];
      const previousDay = Number.isInteger(previous.day) ? previous.day : Math.floor(previous.t / DAY);
      const usualOpen = previous.t + (day - previousDay) * DAY;
      // More than DST (1 h) away from the usual open: not an opening timestamp.
      if (Math.abs(open - usualOpen) > 1.5 * HOUR) open = usualOpen;
    }
    const openUtc = open - Math.floor(open / DAY) * DAY;
    const closeAt = Math.max(open + sessionLength(openUtc), bar.t);
    return { day, c: bar.c, v: Number.isFinite(bar.v) ? bar.v : null, closeAt };
  });
}

/**
 * Completed sessions with log returns of the stock and, on the same two dates,
 * of the benchmark. `s`/`m` are null where a return cannot be computed.
 */
export function alignedReturns(history, benchmarkHistory, nowMs = Date.now()) {
  const bench = new Map(
    withCloseTimes(benchmarkHistory).filter((b) => b.closeAt <= nowMs).map((b) => [b.day, b.c]),
  );
  const bars = withCloseTimes(history).filter((b) => b.closeAt <= nowMs);
  return bars.map((bar, i) => {
    const prev = bars[i - 1];
    const m0 = prev && bench.get(prev.day);
    const m1 = bench.get(bar.day);
    return {
      ...bar,
      s: prev ? Math.log(bar.c / prev.c) : null,
      m: m0 && m1 ? Math.log(m1 / m0) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Market model
// ---------------------------------------------------------------------------

/**
 * r = alpha + beta * m + e. Beta is shrunk towards 1 (Blume adjustment).
 * With too few observations the model degrades to r = m, and says so.
 */
export function fitMarketModel(rows) {
  const data = rows.filter((r) => Number.isFinite(r.s) && Number.isFinite(r.m));
  const n = data.length;
  if (n >= MIN_ESTIMATION) {
    const ms = mean(data.map((r) => r.s));
    const mm = mean(data.map((r) => r.m));
    let cov = 0;
    let variance = 0;
    for (const r of data) {
      cov += (r.m - mm) * (r.s - ms);
      variance += (r.m - mm) ** 2;
    }
    if (variance > 0) {
      const beta = 0.67 * (cov / variance) + 0.33;
      const alpha = ms - beta * mm;
      const sse = data.reduce((sum, r) => sum + (r.s - alpha - beta * r.m) ** 2, 0);
      return { alpha, beta, sigma: Math.sqrt(sse / (n - 2)), n, model: 'market' };
    }
  }
  const sigma = n >= 10 ? stdev(data.map((r) => r.s - r.m)) : null;
  return { alpha: 0, beta: 1, sigma, n, model: 'naive' };
}

/** Standardised cumulative abnormal return over `window`. */
function cumulative(window, fit) {
  const usable = window.filter((r) => Number.isFinite(r.s) && Number.isFinite(r.m));
  if (!usable.length) return null;
  const car = usable.reduce((sum, r) => sum + r.s - fit.alpha - fit.beta * r.m, 0);
  const k = usable.length;
  // Forecast error grows with the window length and shrinks with the sample size.
  const se = fit.sigma > 1e-9 ? fit.sigma * Math.sqrt(k * (1 + k / Math.max(fit.n, 1))) : null;
  return { car, z: se ? car / se : null, sessions: k };
}

export function significance(z) {
  if (!Number.isFinite(z)) return null;
  const size = Math.abs(z);
  if (size >= Z_SIGNIFICANT) return 'significant';
  return size >= Z_NOTABLE ? 'notable' : 'noise';
}

function volumeRatioAt(rows, index) {
  const today = rows[index]?.v;
  const past = rows.slice(Math.max(0, index - 20), index).map((r) => r.v).filter((v) => v > 0);
  const base = past.length >= 10 ? median(past) : null;
  return today > 0 && base ? round(today / base) : null;
}

/**
 * Event study around one publication time. Day 0 is the first session that
 * closes after the event. Returns null while day 0 has not closed, when the
 * event lies outside the price history, or without a benchmark.
 */
export function eventStudy(history, benchmarkHistory, eventTimeMs, nowMs = Date.now()) {
  if (!Number.isFinite(eventTimeMs)) return null;
  const rows = alignedReturns(history, benchmarkHistory, nowMs);
  const day0 = rows.findIndex((r) => r.closeAt > eventTimeMs);
  if (day0 <= 0) return null;
  if (eventTimeMs - rows[day0 - 1].closeAt > MAX_GAP || rows[day0].closeAt - eventTimeMs > MAX_GAP) return null;

  const end = Math.max(0, day0 - EVENT_GAP);
  const fit = fitMarketModel(rows.slice(Math.max(0, end - ESTIMATION_SESSIONS), end));
  const post = cumulative(rows.slice(day0, day0 + POST_SESSIONS), fit);
  if (!post) return null;
  const pre = cumulative(rows.slice(Math.max(1, day0 - PRE_SESSIONS), day0), fit);
  return {
    carPct: pct(post.car),
    z: round(post.z),
    level: significance(post.z),
    sessions: post.sessions,
    preCarPct: pre ? pct(pre.car) : null,
    preZ: round(pre?.z),
    volumeRatio: volumeRatioAt(rows, day0),
    beta: round(fit.beta),
    sample: fit.n,
    model: fit.model,
  };
}

/** Realised volatility of the last 20 sessions relative to the last 120. */
export function volatilityRegime(history, nowMs = Date.now()) {
  const returns = alignedReturns(history, [], nowMs).map((r) => r.s).filter(Number.isFinite);
  if (returns.length < 60) return null;
  const short = stdev(returns.slice(-20));
  const long = stdev(returns.slice(-ESTIMATION_SESSIONS));
  if (!long) return null;
  const ratio = short / long;
  return {
    ratio: round(ratio),
    annualPct: round(short * Math.sqrt(252) * 100, 1),
    label: ratio >= 1.25 ? 'elevated' : ratio <= 0.8 ? 'calm' : 'normal',
  };
}

// ---------------------------------------------------------------------------
// News flow
// ---------------------------------------------------------------------------

/**
 * How unusual is the number of headlines in the last 24 hours against the daily
 * average of the 14 days before. The Anscombe transform makes Poisson counts
 * comparable across quiet and busy companies.
 */
export function newsSurprise(times, nowMs = Date.now(), baselineDays = 14, minBaseline = 10) {
  let today = 0;
  let before = 0;
  for (const time of times || []) {
    const age = nowMs - time;
    if (age >= 0 && age < DAY) today += 1;
    else if (age >= DAY && age < (baselineDays + 1) * DAY) before += 1;
  }
  if (before < minBaseline) return null;
  const expected = before / baselineDays;
  const z = 2 * (Math.sqrt(today + 0.375) - Math.sqrt(expected + 0.375));
  return { today, expected: round(expected, 1), z: round(z) };
}

// ---------------------------------------------------------------------------
// Attention index
// ---------------------------------------------------------------------------

// Price, volume and volatility share 0.7 equally: on five years of real prices equal weights predicted the size of
// the following moves better than the former 0.4/0.2/0.1, in and out of sample (docs/math/backtest-real.md, section 1).
// The news weight 0.3 could not be tested without a historical headline archive and is unchanged.
export const ATTENTION_WEIGHTS = { price: 0.7 / 3, news: 0.3, volume: 0.7 / 3, volatility: 0.7 / 3 };
const CAP = 4;

/**
 * 0..100: how far today is from an ordinary day for this company. It measures
 * unusualness, not direction, and is not a forecast.
 */
export function attentionIndex({ priceZ, newsZ, volumeRatio, volatilityRatio } = {}) {
  const raw = {
    price: Number.isFinite(priceZ) ? Math.abs(priceZ) : null,
    news: Number.isFinite(newsZ) ? Math.max(0, newsZ) : null,
    volume: volumeRatio > 0 ? Math.max(0, Math.log2(volumeRatio)) : null,
    volatility: volatilityRatio > 0 ? Math.max(0, Math.log(volatilityRatio) / Math.log(1.5)) : null,
  };
  const keys = Object.keys(ATTENTION_WEIGHTS).filter((k) => raw[k] !== null);
  const coverage = keys.reduce((sum, k) => sum + ATTENTION_WEIGHTS[k], 0);
  // Below half of the evidence a single number would pretend to know too much.
  if (coverage < 0.5) return null;
  const parts = keys.map((k) => ({ key: k, value: (ATTENTION_WEIGHTS[k] * Math.min(CAP, raw[k])) / coverage }));
  const energy = parts.reduce((sum, p) => sum + p.value, 0);
  const score = Math.round(100 * (1 - Math.exp(-energy)));
  return {
    score,
    label: score >= 65 ? 'unusual' : score >= 35 ? 'elevated' : 'ordinary',
    coverage: round(coverage),
    parts: parts.map((p) => ({ key: p.key, share: energy ? round(p.value / energy) : 0 })),
  };
}

/** Today's signals for one company from its bars and headline times. */
export function companySignals({ history, benchmarkHistory, eventTimes }, nowMs = Date.now()) {
  const rows = alignedReturns(history, benchmarkHistory, nowMs);
  const last = rows.length - 1;
  // A series that stopped updating says nothing about today.
  const fresh = last > 0 && nowMs - rows[last].closeAt <= MAX_GAP;
  let price = null;
  if (fresh) {
    const fit = fitMarketModel(rows.slice(Math.max(0, last - ESTIMATION_SESSIONS), last));
    const day = cumulative(rows.slice(last), fit);
    if (day) price = { abnormalPct: pct(day.car), z: round(day.z), beta: round(fit.beta), sample: fit.n, model: fit.model };
  }
  const volumeRatio = fresh ? volumeRatioAt(rows, last) : null;
  const volatility = fresh ? volatilityRegime(history, nowMs) : null;
  const news = newsSurprise(eventTimes, nowMs);
  return {
    price,
    volumeRatio,
    volatility,
    news,
    attention: attentionIndex({
      priceZ: price?.z,
      newsZ: news?.z,
      volumeRatio,
      volatilityRatio: volatility?.ratio,
    }),
  };
}

// ---------------------------------------------------------------------------
// Evidence weights for the reputation score
// ---------------------------------------------------------------------------

// Half-lives were compared with alternatives on real headlines: none was reliably better out of sample, so they
// remain explainable choices, neither confirmed nor refuted (docs/math/backtest-news.md).
export const TYPE_WEIGHT ={ leadership: 2, scandal: 2, regulation: 1.75, earnings: 1.2, deal: 1, politics: 1, product: 0.8, other: 0.5 };
export const HALF_LIFE_DAYS = { leadership: 30, scandal: 45, regulation: 30, earnings: 21, deal: 21, politics: 14, product: 10, other: 7 };
export const PRIOR_WEIGHT = 3; // neutral evidence that keeps thin samples close to 50
export const PRIOR_VARIANCE = 0.25;
const MAJOR_SOURCE = /\b(reuters|associated press|ap news|bloomberg|financial times|wall street journal|wsj|bbc|cnbc|nikkei|the economist|handelsblatt|les echos|caixin|globes|calcalist|yonhap)\b|路透|财新|연합뉴스/i;

/** Official filing 1.0, major newsroom 0.9, anything else 0.65. */
export function sourceWeight(source) {
  const name = String(source || '');
  if (name === 'SEC EDGAR') return 1;
  return MAJOR_SOURCE.test(name) ? 0.9 : 0.65;
}

/** Independent outlets repeating a story raise its weight, with diminishing returns. */
export function corroborationWeight(outlets) {
  const k = Number.isFinite(outlets) && outlets > 1 ? outlets : 1;
  return clamp(1 + 0.35 * Math.log(k), 1, 2);
}

export function evidenceWeight(event, ageMs) {
  const type = Object.hasOwn(TYPE_WEIGHT, event.type) ? event.type : 'other';
  return TYPE_WEIGHT[type]
    * sourceWeight(event.source)
    * corroborationWeight(event.outlets)
    * 0.5 ** (ageMs / (HALF_LIFE_DAYS[type] * DAY));
}

/**
 * Uncertainty of a shrunk weighted mean of tones in -1..1.
 * Returns the 95% half-width in score points and a 0..1 confidence.
 */
export function scoreUncertainty(used) {
  const total = used.reduce((sum, u) => sum + u.weight, 0);
  const squares = used.reduce((sum, u) => sum + u.weight ** 2, 0);
  const effective = squares ? total ** 2 / squares : 0; // Kish effective sample size
  const center = total ? used.reduce((sum, u) => sum + u.weight * u.sentiment, 0) / total : 0;
  const spread = used.reduce((sum, u) => sum + u.weight * (u.sentiment - center) ** 2, 0);
  const variance = (spread + PRIOR_WEIGHT * PRIOR_VARIANCE) / (total + PRIOR_WEIGHT);
  return {
    margin: Math.round(clamp(50 * Z_SIGNIFICANT * Math.sqrt(variance / (effective + PRIOR_WEIGHT)), 0, 50)),
    confidence: round(effective / (effective + PRIOR_WEIGHT)),
  };
}
