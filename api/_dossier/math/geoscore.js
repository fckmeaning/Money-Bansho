// Geopolitical score of map points and world events: pure mathematics, no I/O, deterministic.
// A component that cannot be measured is reported with a reason; nothing is defaulted.
// Formulas and limitations: docs/math/geoscore.md
import { normalCdf } from './special.js';

/** Expert base weights, not fitted on history. They sum to 1. `dynamic` = current evidence. */
export const COMPONENTS = [
  { id: 'surprise', label: 'Всплеск новостей к норме', weight: 0.18, dynamic: true },
  { id: 'sources', label: 'Подтверждение источниками', weight: 0.14, dynamic: true },
  { id: 'severity', label: 'Тяжесть и негативный тон', weight: 0.16, dynamic: true },
  { id: 'instability', label: 'Нестабильность страны', weight: 0.2, dynamic: true },
  { id: 'conflict', label: 'Близость к зонам конфликта', weight: 0.18, dynamic: false },
  { id: 'exposure', label: 'Проливы и ядерные объекты рядом', weight: 0.06, dynamic: false },
  { id: 'market', label: 'Реакция рынков', weight: 0.08, dynamic: true },
];

export const PARAMS = {
  power: 2,
  halfLifeHours: 36,
  recentHours: 24,
  corroborationScale: 4,
  countryWeight: 0.25, // a country-level headline counts this much of a place-level one
  countryCap: 2, // and adds at most this many effective outlets
  surprisePrior: 5, // pseudo-mentions shrinking the surprise z to zero
  minSurpriseMentions: 3,
  tonePrior: 3,
  conflictSigmaKm: 500,
  chokepointSigmaKm: 600,
  nuclearSigmaKm: 300,
  sigmaSpread: 0.25, // relative uncertainty of every distance kernel width
  geoSdFloor: 0.02,
  nuclearWeight: 0.5,
  marketScale: 2.5,
  instabilitySdDefault: 0.1, // used only when the index comes without an interval
  minCoverage: 0.25,
  minBetweenSd: 0.05,
  level: 0.9,
};

export const INTENSITY = { high: 1, medium: 0.66, low: 0.33 };
const Z90 = 1.6448536269514722;
const HOUR = 3_600_000;

export const decay = (ageHours) => 2 ** (-Math.max(0, ageHours) / PARAMS.halfLifeHours);

export function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const gaussianKernel = (km, sigma) => Math.exp(-0.5 * (km / sigma) ** 2);

/** Ray casting on [lon, lat] vertices. Zones crossing the antimeridian are not supported. */
export function insidePolygon({ lat, lon }, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 0 inside the zone, otherwise the distance to its nearest vertex or centre. */
export function zoneDistanceKm(point, zone) {
  const ring = zone.coords ?? [];
  if (ring.length > 2 && insidePolygon(point, ring)) return 0;
  const targets = ring.map(([lon, lat]) => ({ lat, lon }));
  if (zone.center) targets.push({ lon: zone.center[0], lat: zone.center[1] });
  return Math.min(...targets.map((t) => haversineKm(point, t)));
}

/** Delta between the kernel widths sigma(1 +- spread), read as a 90% range. */
function kernelUncertainty(at) {
  const spread = Math.abs(at(1 + PARAMS.sigmaSpread) - at(1 - PARAMS.sigmaSpread)) / (2 * Z90);
  return Math.hypot(spread, PARAMS.geoSdFloor);
}

/** Noisy-OR of intensity-weighted Gaussian kernels over the conflict zones. */
export function conflictProximity(point, zones) {
  if (!zones.length) return { reason: 'нет списка зон конфликта' };
  const rows = zones.map((zone) => ({ zone, km: zoneDistanceKm(point, zone), a: INTENSITY[zone.intensity] ?? INTENSITY.medium }));
  const at = (k) => 1 - rows.reduce((q, r) => q * (1 - r.a * gaussianKernel(r.km, PARAMS.conflictSigmaKm * k)), 1);
  const nearest = rows.reduce((best, r) => (r.km < best.km ? r : best));
  return {
    value: at(1),
    sd: kernelUncertainty(at),
    note: nearest.km === 0 ? `внутри зоны «${nearest.zone.name}»` : `до зоны «${nearest.zone.name}» ${Math.round(nearest.km)} км`,
  };
}

export function strategicExposure(point, waterways, nuclear) {
  if (!waterways.length && !nuclear.length) return { reason: 'нет слоёв проливов и ядерных объектов' };
  const closest = (list) => list.reduce((best, item) => {
    const km = haversineKm(point, item);
    return km < best.km ? { km, item } : best;
  }, { km: Number.POSITIVE_INFINITY, item: null });
  const w = closest(waterways);
  const n = closest(nuclear);
  const at = (k) => 1
    - (1 - gaussianKernel(w.km, PARAMS.chokepointSigmaKm * k))
    * (1 - PARAMS.nuclearWeight * gaussianKernel(n.km, PARAMS.nuclearSigmaKm * k));
  const notes = [w.item && `${w.item.name}: ${Math.round(w.km)} км`, n.item && `${n.item.name}: ${Math.round(n.km)} км`];
  return { value: at(1), sd: kernelUncertainty(at), note: notes.filter(Boolean).join('; ') };
}

const SEVERE = /\b(?:kill\w*|dead|deaths?|massacre\w*|air ?strikes?|strikes?|missiles?|drones?|shelling|bomb\w*|attack\w*|war|invasion|offensive|clash\w*|hostages?|explosion\w*|blockade\w*|casualt\w*|troops|coup)\b/gi;

/** Severity of one headline in [0, 1): half violent vocabulary, half negative tone. */
export function headlineSeverity(title, tone) {
  const hits = (title.match(SEVERE) ?? []).length;
  return 0.5 * (1 - Math.exp(-hits / 1.5)) + 0.5 * Math.min(1, Math.max(0, -tone));
}

/** Unique headlines with recency weight and severity; `toneOf` is the project word-list tone. */
export function prepareNews(items, toneOf, nowMs, windowHours = 168) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const age = (nowMs - item.time) / HOUR;
    const key = `${item.feed}|${item.title.toLowerCase()}`;
    if (!(age <= windowHours) || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, age, d: decay(age), h: headlineSeverity(item.title, toneOf(item.title)) });
  }
  return out;
}

/** Corpus totals per feed and the pooled severity prior; computed once per build. */
export function corpusStats(news) {
  const feeds = new Map();
  for (const item of news) {
    const row = feeds.get(item.feed) ?? { N: 0, R: 0 };
    row.N += 1;
    if (item.age <= PARAMS.recentHours) row.R += 1;
    feeds.set(item.feed, row);
  }
  const mean = news.length ? news.reduce((t, i) => t + i.h, 0) / news.length : 0;
  const variance = news.length ? news.reduce((t, i) => t + (i.h - mean) ** 2, 0) / news.length : 0;
  return { feeds, mean, variance, total: news.length };
}

/**
 * Cochran-Mantel-Haenszel surprise: are the headlines about a place unusually recent compared
 * with everything the same feeds carry? One stratum per feed, so feed mix and depth cancel.
 */
export function volumeSurprise(matched, corpus) {
  const by = new Map();
  for (const item of matched) {
    const row = by.get(item.feed) ?? { m: 0, x: 0 };
    row.m += 1;
    if (item.age <= PARAMS.recentHours) row.x += 1;
    by.set(item.feed, row);
  }
  let observed = 0;
  let expected = 0;
  let variance = 0;
  let n = 0;
  for (const [feed, { m, x }] of by) {
    const { N, R } = corpus.feeds.get(feed) ?? { N: 0, R: 0 };
    if (N < 2 || R <= 0 || R >= N) continue;
    const p = R / N;
    observed += x;
    expected += m * p;
    variance += (m * p * (1 - p) * (N - m)) / (N - 1);
    n += m;
  }
  if (n < PARAMS.minSurpriseMentions || !(variance > 0)) return null;
  return { z: (observed - expected) / Math.sqrt(variance), observed, expected, n };
}

/** Over-dispersion of the surprise z across places (robust sd, never below 1). */
export function dispersion(zs) {
  const sorted = zs.filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  if (sorted.length < 8) return 1;
  return Math.max(1, 1.4826 * sorted[Math.floor(sorted.length / 2)]);
}

export function surpriseComponent(surprise, phi, basis = '') {
  if (!surprise) return { reason: 'мало упоминаний в лентах для сравнения с нормой' };
  const shrink = surprise.n / (surprise.n + PARAMS.surprisePrior);
  const z = (surprise.z / phi) * shrink;
  const density = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  return {
    value: normalCdf(z),
    sd: density * shrink,
    note: `${surprise.observed} за 24 ч при норме ${surprise.expected.toFixed(1).replace('.', ',')}${basis}`,
  };
}

/** 1 - exp(-n/tau), n = recency-weighted independent outlets (best weight per outlet). */
export function corroboration(place, country = []) {
  const outlets = (list, skip) => {
    const best = new Map();
    for (const item of list) {
      const key = item.source.toLowerCase();
      if (skip?.has(key)) continue;
      best.set(key, Math.max(best.get(key) ?? 0, item.d));
    }
    return best;
  };
  const p = outlets(place);
  const c = outlets(country, p);
  if (!p.size && !c.size) return { reason: 'нет сообщений за 7 дней' };
  const total = (map) => [...map.values()].reduce((t, v) => t + v, 0);
  const squares = (map) => [...map.values()].reduce((t, v) => t + v * v, 0);
  const countryPart = PARAMS.countryWeight * total(c);
  const n = total(p) + Math.min(countryPart, PARAMS.countryCap);
  const variance = squares(p) + (countryPart < PARAMS.countryCap ? PARAMS.countryWeight ** 2 * squares(c) : 0);
  const tau = PARAMS.corroborationScale;
  return {
    value: 1 - Math.exp(-n / tau),
    sd: (Math.exp(-n / tau) / tau) * Math.sqrt(variance),
    note: `изданий о месте: ${p.size}, о стране: ${c.size}; эффективно ${n.toFixed(2).replace('.', ',')}`,
  };
}

/** Recency-weighted mean severity shrunk to the corpus mean (conjugate-style prior). */
export function severity(place, country, corpus) {
  const rows = [...place.map((i) => [i.h, i.d]), ...country.map((i) => [i.h, i.d * PARAMS.countryWeight])];
  const weight = rows.reduce((t, [, w]) => t + w, 0);
  if (!(weight > 0)) return { reason: 'нет сообщений за 7 дней' };
  const k = PARAMS.tonePrior;
  const value = (rows.reduce((t, [h, w]) => t + w * h, 0) + k * corpus.mean) / (weight + k);
  const spread = (rows.reduce((t, [h, w]) => t + w * (h - value) ** 2, 0) + k * corpus.variance) / (weight + k);
  return { value, sd: Math.sqrt(spread / (weight + k)), note: `по ${rows.length} заголовкам` };
}

/** Mean of the published country index over the countries of the point. */
export function instabilityComponent(codes, index) {
  if (!codes.length) return { reason: 'страна точки не определена' };
  if (!index?.size) return { reason: 'индекс нестабильности не получен' };
  const rows = codes.map((code) => index.get(code)).filter((r) => r && Number.isFinite(r.index)
    && !(r.coverage < PARAMS.minCoverage));
  if (!rows.length) return { reason: `индекс по стране (${codes.join(', ')}) не рассчитан` };
  const sd = rows.map((r) => (Number.isFinite(r.low) && Number.isFinite(r.high)
    ? (r.high - r.low) / (2 * Z90 * 100) : PARAMS.instabilitySdDefault));
  return {
    value: rows.reduce((t, r) => t + r.index, 0) / rows.length / 100,
    // Country errors are treated as fully correlated: no averaging gain.
    sd: sd.reduce((t, v) => t + v, 0) / sd.length,
    note: rows.map((r) => `${r.name ?? r.code}: ${r.index.toFixed(1).replace('.', ',')}`).join('; '),
  };
}

/** tanh(|z| / 2.5) of measured moves after matching events, recency weighted; z error sd 1. */
export function marketComponent(events, nowMs) {
  const rows = events.flatMap((event) => {
    const zs = (event.assets ?? []).map((a) => Math.abs(a.observed?.z)).filter(Number.isFinite);
    return zs.length ? [{ z: Math.max(...zs), d: decay((nowMs - event.lastAt) / HOUR) }] : [];
  });
  const weight = rows.reduce((t, r) => t + r.d, 0);
  if (!(weight > 0)) return { reason: 'нет измеренной реакции рынка на связанные события' };
  const s = PARAMS.marketScale;
  const value = rows.reduce((t, r) => t + r.d * Math.tanh(r.z / s), 0) / weight;
  // Events share the same assets, so their errors are treated as correlated.
  const sd = rows.reduce((t, r) => t + (r.d * (1 - Math.tanh(r.z / s) ** 2)) / s, 0) / weight;
  return { value, sd, note: `связанных событий с котировками: ${rows.length}` };
}

const present = (c) => c && Number.isFinite(c.value);

/** Weighted power mean of the measured components, renormalised weights; null without evidence. */
export function aggregate(values) {
  const used = COMPONENTS.filter((c) => present(values[c.id]));
  const coverage = used.reduce((t, c) => t + c.weight, 0);
  if (!used.some((c) => c.dynamic)) return { raw: null, coverage, reason: 'нет текущих свидетельств: только статичная география' };
  if (coverage < PARAMS.minCoverage) return { raw: null, coverage, reason: 'измерено меньше четверти веса' };
  const p = PARAMS.power;
  const weights = Object.fromEntries(used.map((c) => [c.id, c.weight / coverage]));
  const sum = used.reduce((t, c) => t + weights[c.id] * values[c.id].value ** p, 0);
  const raw = sum ** (1 / p);
  const shares = {};
  const gradient = {};
  for (const { id } of used) {
    const x = values[id].value;
    shares[id] = sum > 0 ? (weights[id] * x ** p) / sum : weights[id];
    gradient[id] = raw > 0 ? weights[id] * x ** (p - 1) * raw ** (1 - p) : weights[id];
  }
  return { raw, coverage, weights, shares, gradient, reason: null };
}

const meanOf = (xs) => xs.reduce((t, x) => t + x, 0) / xs.length;
const varianceOf = (xs) => {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return xs.reduce((t, x) => t + (x - m) ** 2, 0) / (xs.length - 1);
};

/** Delta-method variance plus the spread a missing component shows across the population. */
function totalVariance(values, agg, spread) {
  return COMPONENTS.reduce((t, c) => (present(values[c.id])
    ? t + (agg.gradient[c.id] * values[c.id].sd) ** 2
    : t + c.weight ** 2 * spread[c.id]), 0);
}

/** Empirical-Bayes prior from the scored population: mean, between-entity variance, spreads. */
export function populationPrior(list) {
  const rows = list.map((values) => ({ values, agg: aggregate(values) })).filter((r) => r.agg.raw !== null);
  if (rows.length < 3) return null;
  const spread = Object.fromEntries(COMPONENTS.map((c) => {
    const xs = rows.map((r) => r.values[c.id]).filter(present).map((v) => v.value);
    // A component never observed gets the variance of a uniform variable on [0, 1].
    return [c.id, xs.length > 1 ? varianceOf(xs) : 1 / 12];
  }));
  const raws = rows.map((r) => r.agg.raw);
  const noise = meanOf(rows.map((r) => totalVariance(r.values, r.agg, spread)));
  return {
    mean: meanOf(raws),
    between: Math.max(varianceOf(raws) - noise, PARAMS.minBetweenSd ** 2),
    spread,
    n: rows.length,
  };
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;
const ru = (x, digits = 4) => x.toFixed(digits).replace('.', ',');

/** Posterior score 0..100, its interval and an additive decomposition. */
export function scoreEntity(values, prior) {
  const agg = aggregate(values);
  const blank = (reason) => ({
    score: null, low: null, high: null, sd: null, raw: null, shrinkage: null, priorPart: null,
    coverage: round4(agg.coverage), reason,
    explain: `Оценки нет: ${reason}.`,
    components: COMPONENTS.map((c) => row(c, values[c.id], null, null)),
  });
  if (agg.raw === null) return blank(agg.reason);
  if (!prior) return blank('слишком мало точек для априорного уровня');
  const variance = totalVariance(values, agg, prior.spread);
  const lambda = prior.between / (prior.between + variance);
  const mean = lambda * agg.raw + (1 - lambda) * prior.mean;
  const sd = Math.sqrt(lambda * variance);
  const components = COMPONENTS.map((c) => (present(values[c.id])
    ? row(c, values[c.id], agg.weights[c.id], 100 * lambda * agg.raw * agg.shares[c.id])
    : row(c, values[c.id], null, null)));
  const top = components.filter((c) => c.points !== null).sort((a, b) => b.points - a.points).slice(0, 2);
  const missing = components.filter((c) => c.value === null).map((c) => c.label.toLowerCase());
  return {
    score: round4(100 * mean),
    low: round4(100 * Math.max(0, mean - Z90 * sd)),
    high: round4(100 * Math.min(1, mean + Z90 * sd)),
    sd: round4(100 * sd),
    raw: round4(100 * agg.raw),
    shrinkage: round4(lambda),
    priorPart: round4(100 * (1 - lambda) * prior.mean),
    coverage: round4(agg.coverage),
    reason: null,
    explain: `Главный вклад: ${top.map((c) => `${c.label.toLowerCase()} (${ru(c.points)})`).join(', ')}${
      missing.length ? `. Нет данных: ${missing.join(', ')}` : ''}.`,
    components,
  };
}

function row(component, value, weight, points) {
  const has = present(value);
  return {
    id: component.id,
    label: component.label,
    value: has ? round4(value.value) : null,
    sd: has ? round4(value.sd) : null,
    weight: weight === null ? null : round4(weight),
    points: points === null ? null : round4(points),
    note: has ? value.note ?? null : null,
    reason: has ? null : value?.reason ?? 'нет данных',
  };
}
