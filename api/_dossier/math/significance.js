// Event significance S in 0..100 with an interval and a factor breakdown.
// Formulas: docs/math/significance.md. Pure functions, no network.
//
//   eta_ex = logit(p0[type]) + b_c ln(c/0.5) + b_n ln(n_eff) + b_t (|s| - 0.3) + b_s (sal - 0.6) + b_v (nov - 0.7)
//   p_cal  = p_ex + sum_j K_ij (y_j - p_j) / (M + sum_j K_ij)        kernel regression on analog events
//   eta    = logit(p_cal) + b_z (-ln p_t - 1) + b_v2 log2(volume ratio)   realised price reaction
//   S      = 100 sigmoid(eta);  current = S * exp(-age^2 / (2 tau_type^2))
import { sourceCredibility, shingles, jaccard } from '../sources.js';
import { normalCdf, studentTTwoSided } from './special.js';

const DAY = 86_400_000;

/** Prior probability that an event of this type moves the stock by |z| >= 1 (set by judgement, not fitted). */
export const TYPE_PRIOR = { leadership: 0.5, scandal: 0.55, regulation: 0.5, earnings: 0.6, deal: 0.45, politics: 0.4, product: 0.4, other: 0.35 };
/** Gaussian-kernel time constants of relevance, in days. */
export const TAU_DAYS = { leadership: 25, scandal: 35, regulation: 25, earnings: 15, deal: 18, politics: 10, product: 8, other: 5 };
/** Log-odds weights of the factors (judgement; the kernel step below calibrates the sum on the company's own history). */
export const BETA = { cred: 0.8, conf: 0.7, tone: 1.2, sal: 1.0, nov: 0.8, z: 0.45, vol: 0.3 };
export const CONFIRM_CORRELATION = 0.3; // intra-class correlation of outlets repeating one story
export const CAL_PRIOR = 6; // pseudo-observations that keep the feature model's answer
export const BANDWIDTH = { p: 0.15, tone: 0.5, timeDays: 180 };
export const OTHER_TYPE_KERNEL = 0.25;
export const NOVELTY_DAYS = 10;
export const Z_MATERIAL = 1;
const Z80 = 1.2815515655;
const LABELS = {
  prior: 'Тип события (априор)', credibility: 'Надёжность источника', confirmation: 'Независимые подтверждения',
  tone: 'Сила тона', salience: 'Заметность компании в заголовке', novelty: 'Новизна', calibration: 'Калибровка по аналогам',
  surprise: 'Реакция цены (z, хвосты Стьюдента)', volume: 'Объём торгов',
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const gauss = (u) => Math.exp(-0.5 * u * u);
const round = (x, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);
const typeOf = (e) => (Object.hasOwn(TYPE_PRIOR, e.type) ? e.type : 'other');

/** Smooth 0..1 version of "the reaction was material": a Gaussian step centred at |z| = 1. */
export const materiality = (z) => normalCdf((Math.abs(z) - Z_MATERIAL) / 0.5);

/** Effective independent confirmations of a story carried by k outlets (Kish design effect). */
export const effectiveOutlets = (k) => {
  const n = Number.isFinite(k) && k > 1 ? k : 1;
  return n / (1 + (n - 1) * CONFIRM_CORRELATION);
};

/** How prominently the headline names the company: 1 at the very start, 0.25 when only the summary does. */
export function salience(event) {
  const m = event.mention;
  if (!m) return 0.5;
  return m.inTitle ? 0.65 + 0.35 * (1 - clamp(m.pos ?? 0, 0, 1)) : 0.25;
}

function credibility(event) {
  const list = event.cluster?.credibility;
  const best = Array.isArray(list) && list.length ? Math.max(...list) : null;
  return clamp(best ?? sourceCredibility(event.source, event.tier), 0.1, 1);
}

/** Gaussian kernel density of earlier, similar stories: how much of this is already known. */
function novelty(event, earlier, sets) {
  const time = event.time;
  let story = 0;
  let fatigue = 0;
  const mine = sets.get(event);
  for (const other of earlier) {
    const age = (time - other.time) / DAY;
    if (!(age > 0)) continue;
    const kt = gauss(age / NOVELTY_DAYS);
    if (typeOf(other) === typeOf(event)) fatigue += kt;
    story += kt * gauss((1 - jaccard(mine, sets.get(other))) / 0.35) * (typeOf(other) === typeOf(event) ? 1 : 0.3);
  }
  return Math.exp(-(story + 0.15 * fatigue));
}

/** Ex-ante part: everything known when the headline appears. */
function exAnte(event, earlier, sets) {
  const type = typeOf(event);
  const cred = credibility(event);
  const k = event.outlets ?? event.cluster?.outlets ?? 1;
  const nEff = effectiveOutlets(k);
  const tone = Math.abs(Number(event.sentiment) || 0);
  const sal = salience(event);
  const nov = novelty(event, earlier, sets);
  const parts = {
    prior: { value: logit(TYPE_PRIOR[type]), raw: TYPE_PRIOR[type], detail: `p0=${TYPE_PRIOR[type]}` },
    credibility: { value: BETA.cred * Math.log(cred / 0.5), raw: cred, detail: `c=${round(cred)}` },
    confirmation: { value: BETA.conf * Math.log(nEff), raw: nEff, detail: `k=${k}, n_eff=${round(nEff)}` },
    tone: { value: BETA.tone * (tone - 0.3), raw: tone, detail: `|s|=${round(tone)}` },
    salience: { value: BETA.sal * (sal - 0.6), raw: sal, detail: `sal=${round(sal)}` },
    novelty: { value: BETA.nov * (nov - 0.7), raw: nov, detail: `nov=${round(nov)}` },
  };
  const eta = Object.values(parts).reduce((sum, p) => sum + p.value, 0);
  return { parts, eta: clamp(eta, -6, 6), p: sigmoid(clamp(eta, -6, 6)) };
}

/** Ex-ante significance (0..100) of one event given earlier events; used by the forecast as a similarity axis. */
export function exAnteScore(event, earlier = []) {
  const sets = new Map([event, ...earlier].map((e) => [e, shingles(e.title ?? '', e.source)]));
  return Math.round(100 * exAnte(event, earlier.filter((e) => e.time < event.time), sets).p);
}

function surprise(impact) {
  const z = impact?.z;
  if (!Number.isFinite(z)) return null;
  const nu = Math.max(1, (impact.sample ?? 30) - 2);
  const p = clamp(studentTTwoSided(Math.abs(z), nu), 1e-6, 1);
  const u = Math.min(-Math.log(p), 6);
  return { z, p, value: BETA.z * (u - 1), detail: `z=${round(z)}, p=${p < 0.001 ? p.toExponential(1) : round(p, 3)}, ν=${nu}` };
}

/**
 * Scores every event. Events must carry type, sentiment, time, title, source and, when known,
 * tier, outlets, cluster, mention, impact. Returns the events with a `significance` block and a summary.
 */
export function scoreEvents(events, nowMs = Date.now()) {
  const list = (events || []).filter((e) => Number.isFinite(e.time));
  const sorted = [...list].sort((a, b) => a.time - b.time);
  const sets = new Map(sorted.map((e) => [e, shingles(e.title ?? '', e.source)]));
  const base = new Map();
  sorted.forEach((event, i) => {
    base.set(event, exAnte(event, sorted.slice(Math.max(0, i - 200), i), sets));
  });
  // Analogue outcomes: only events whose price reaction is known.
  const analogues = sorted
    .filter((e) => Number.isFinite(e.impact?.z))
    .map((e) => ({ event: e, y: materiality(e.impact.z), p: base.get(e).p }));

  const scored = new Map();
  for (const event of sorted) {
    const mine = base.get(event);
    let mass = 0;
    let residual = 0;
    for (const a of analogues) {
      if (a.event === event) continue;
      const days = (event.time - a.event.time) / DAY;
      const k = (typeOf(a.event) === typeOf(event) ? 1 : OTHER_TYPE_KERNEL)
        * gauss((mine.p - a.p) / BANDWIDTH.p)
        * gauss(((Number(event.sentiment) || 0) - (Number(a.event.sentiment) || 0)) / BANDWIDTH.tone)
        * gauss(days / BANDWIDTH.timeDays);
      mass += k;
      residual += k * (a.y - a.p);
    }
    const calibrated = clamp(mine.p + residual / (CAL_PRIOR + mass), 0.01, 0.99);
    const react = surprise(event.impact);
    const volumeRatio = event.impact?.volumeRatio;
    const volume = volumeRatio > 0 ? BETA.vol * clamp(Math.log2(volumeRatio), -1, 3) : null;
    const shift = (react?.value ?? 0) + (volume ?? 0);
    const etaCal = logit(calibrated);
    const eta = etaCal + shift;
    const nTotal = CAL_PRIOR + mass;
    const se = 1 / Math.sqrt(nTotal * calibrated * (1 - calibrated));
    const type = typeOf(event);
    const age = (nowMs - event.time) / DAY;
    const decay = age <= 0 ? 1 : gauss(age / TAU_DAYS[type]);
    const score = 100 * sigmoid(eta);
    const factors = [
      ...Object.entries(mine.parts).map(([key, p]) => ({ key, label: LABELS[key], value: round(p.value, 3), detail: p.detail })),
      { key: 'calibration', label: LABELS.calibration, value: round(etaCal - mine.eta, 3), detail: `K=${round(mass)}` },
      ...(react ? [{ key: 'surprise', label: LABELS.surprise, value: round(react.value, 3), detail: react.detail }] : []),
      ...(volume !== null ? [{ key: 'volume', label: LABELS.volume, value: round(volume, 3), detail: `×${round(volumeRatio)}` }] : []),
    ];
    scored.set(event, {
      score: Math.round(score),
      low: Math.round(100 * sigmoid(eta - Z80 * se)),
      high: Math.round(100 * sigmoid(eta + Z80 * se)),
      ex: Math.round(100 * mine.p),
      priced: Boolean(react),
      decay: round(decay, 3),
      current: Math.round(score * decay),
      kernelMass: round(mass, 2),
      factors,
    });
  }

  const out = list.map((e) => ({ ...e, significance: scored.get(e) }));
  return { events: out, summary: summarize(out, nowMs) };
}

function summarize(events, nowMs) {
  const scores = events.map((e) => e.significance.score);
  if (!scores.length) return null;
  const bins = Array.from({ length: 10 }, () => 0);
  for (const s of scores) bins[Math.min(9, Math.floor(s / 10))] += 1;
  const byType = {};
  for (const e of events) (byType[typeOf(e)] ??= []).push(e.significance.score);
  const H = 3; // days, bandwidth of the Gaussian kernel density of significance over time
  const timeline = [];
  for (let d = 89; d >= 0; d -= 1) {
    const t = nowMs - d * DAY;
    let v = 0;
    for (const e of events) v += e.significance.score * gauss((t - e.time) / DAY / H);
    timeline.push({ t, v: round(v / (H * Math.sqrt(2 * Math.PI)), 2) });
  }
  return {
    n: scores.length,
    priced: events.filter((e) => e.significance.priced).length,
    mean: round(scores.reduce((s, x) => s + x, 0) / scores.length, 1),
    high: scores.filter((s) => s >= 60).length,
    bins,
    byType: Object.entries(byType)
      .map(([type, v]) => ({ type, n: v.length, mean: round(v.reduce((s, x) => s + x, 0) / v.length, 1) }))
      .sort((a, b) => b.n - a.n),
    timeline,
    note: 'Вероятность (в %), что реакция цены окажется заметной (|z| >= 1). Не прогноз цены.',
  };
}
