// Проверка весов и полураспадов досье на реальной истории (walk-forward, без заглядывания вперёд).
// Данные: docs/handoff/backtest-data (скачать: node scripts/backtest-fetch.mjs).
// Запуск: node scripts/backtest-real.mjs [--quick]   (офлайн, детерминированно: seed фиксирован)
// Это отчёт, а не ворота: код выхода всегда 0. Ничего не выдумывается: нет данных, значит строка пропускается.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ATTENTION_WEIGHTS, alignedReturns, attentionIndex, companySignals, fitMarketModel } from '../api/_dossier/quant.js';
import { computeForecasts } from '../api/_dossier/math/forecast.js';
import { benjaminiHochberg } from '../api/_dossier/math/inference.js';
import { detectJumps, valueAtRisk } from '../api/_dossier/math/risk.js';
import { reportJumps } from '../api/_dossier/math/report.js';
import { normalCdf } from '../api/_dossier/math/special.js';
import { mean, ranks, seededRandom, stdev } from '../api/_dossier/math/stats.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'docs', 'handoff', 'backtest-data');
const DAY = 86_400_000;
const QUICK = process.argv.includes('--quick');
const B = QUICK ? 80 : 400; // повторы бутстрэпа и перестановок
const BLOCK = 30; // длина блока бутстрэпа, календарных дней
const FDR = 0.1;
const out = (line = '') => process.stdout.write(`${line}\n`);
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'нет данных');
const pct = (x, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : 'нет данных');
const results = { generated: new Date().toISOString().slice(0, 10), B, blockDays: BLOCK, fdr: FDR };

// ---------------------------------------------------------------------------
// Данные
// ---------------------------------------------------------------------------

const companies = JSON.parse(readFileSync(join(ROOT, 'shared', 'dossier-companies.json'), 'utf8'));
const meta = new Map(companies.map((c) => [c.symbol, c]));
if (!existsSync(join(DATA, 'index-prices.json'))) {
  out('нет данных: сначала node scripts/backtest-fetch.mjs');
  process.exit(0);
}
const priceIndex = JSON.parse(readFileSync(join(DATA, 'index-prices.json'), 'utf8'));
const barsCache = new Map();
function loadBars(symbol) {
  if (barsCache.has(symbol)) return barsCache.get(symbol);
  const file = priceIndex.files[symbol];
  let bars = null;
  if (file && existsSync(join(DATA, file))) {
    const j = JSON.parse(gunzipSync(readFileSync(join(DATA, file))));
    bars = j.t.map((t, i) => ({ t: t * 1000, c: j.c[i], v: j.v[i] }));
  }
  barsCache.set(symbol, bars);
  return bars;
}
const symbols = Object.keys(priceIndex.files).filter((s) => meta.has(s) && loadBars(s) && loadBars(meta.get(s).benchmark));
const sec = existsSync(join(DATA, 'sec-8k.json')) ? JSON.parse(readFileSync(join(DATA, 'sec-8k.json'), 'utf8')).filings : {};
const gdelt = {};
for (const name of readdirSync(DATA)) {
  if (/^gdelt-daily.*.json$/.test(name)) Object.assign(gdelt, JSON.parse(readFileSync(join(DATA, name), 'utf8')).series);
}
const dayNum = (yyyymmdd) => Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) / DAY;
function gdeltDaily(symbol, mode) {
  const rows = gdelt[`${symbol}|${mode}`];
  if (!rows?.length) return null;
  return new Map(rows.map(([d, value]) => [dayNum(d), value]));
}

/** Первый индекс бара с t > limit (бинарный поиск) */
function upper(bars, limit) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= limit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Дневные признаки: ровно то, что видел бы код досье в день i (только прошлое)
// ---------------------------------------------------------------------------

const KEYS = ['price', 'news', 'volume', 'volatility'];
const CAP = 4;
const OLD_W = [0.4, 0.3, 0.2, 0.1]; // веса до этой проверки
const CURRENT_W = [ATTENTION_WEIGHTS.price, ATTENTION_WEIGHTS.news, ATTENTION_WEIGHTS.volume, ATTENTION_WEIGHTS.volatility]; // веса в коде сейчас

function newsZ(counts, day) {
  // Вчерашний (полностью опубликованный) день против среднего за 14 дней до него, формула newsSurprise (Анском).
  if (!counts) return null;
  const today = counts.get(day - 1) ?? 0;
  let before = 0;
  for (let k = 2; k <= 15; k += 1) before += counts.get(day - k) ?? 0;
  if (before < 10) return null;
  return 2 * (Math.sqrt(today + 0.375) - Math.sqrt(before / 14 + 0.375));
}

function buildFeatures(symbol) {
  const hist = loadBars(symbol);
  const bench = loadBars(meta.get(symbol).benchmark);
  const rows = alignedReturns(hist, bench);
  const counts = gdeltDaily(symbol, 'timelinevolraw');
  const tones = gdeltDaily(symbol, 'timelinetone');
  const list = [];
  for (let i = 140; i < rows.length - 21; i += 1) {
    const nowMs = rows[i].closeAt;
    const h = hist.slice(Math.max(0, i - 300), i + 1);
    const bh = bench.slice(Math.max(0, upper(bench, hist[i].t + 0.6 * DAY) - 310), upper(bench, hist[i].t + 0.6 * DAY));
    const sig = companySignals({ history: h, benchmarkHistory: bh, eventTimes: [] }, nowMs);
    const raw = {
      price: Number.isFinite(sig.price?.z) ? Math.abs(sig.price.z) : null,
      news: newsZ(counts, rows[i].day) === null ? null : Math.max(0, newsZ(counts, rows[i].day)),
      volume: sig.volumeRatio > 0 ? Math.max(0, Math.log2(sig.volumeRatio)) : null,
      volatility: sig.volatility?.ratio > 0 ? Math.max(0, Math.log(sig.volatility.ratio) / Math.log(1.5)) : null,
    };
    const ret = (j) => rows[j].s;
    let a5 = 0;
    let a20 = 0;
    let ok = true;
    let y5 = 0;
    let y20 = 0;
    for (let j = 1; j <= 20; j += 1) {
      const r = ret(i + j);
      const ar = r - rows[i + j].m;
      if (!Number.isFinite(r) || !Number.isFinite(ar)) { ok = false; break; }
      y20 += Math.abs(r);
      a20 += ar;
      if (j <= 5) { y5 += Math.abs(r); a5 += ar; }
    }
    if (!ok) continue;
    const a1 = ret(i + 1) - rows[i + 1].m;
    list.push({
      cal: rows[i].day,
      raw,
      absr: Math.abs(ret(i)),
      rv20: stdev(rows.slice(i - 19, i + 1).map((r) => r.s)),
      tone: tones ? (tones.get(rows[i].day - 1) ?? null) : null,
      y1: Math.abs(ret(i + 1)),
      y5: y5 / 5,
      y20: y20 / 20,
      a1,
      a5,
      a20,
      // для проверки копии формулы индекса внимания
      check: { priceZ: sig.price?.z, volumeRatio: sig.volumeRatio, volatilityRatio: sig.volatility?.ratio, score: sig.attention?.score },
    });
  }
  return list;
}

// ---------------------------------------------------------------------------
// Статистика: средний по бумагам ранговый коэффициент Спирмена, блочный бутстрэп по календарю
// (одни и те же блоки дней для всех бумаг: учитывает общерыночную зависимость) и перестановки циклическим сдвигом
// ---------------------------------------------------------------------------

function energy(raw, w) {
  let cov = 0;
  let total = 0;
  let e = 0;
  for (let k = 0; k < 4; k += 1) {
    total += w[k];
    const x = raw[KEYS[k]];
    if (w[k] > 0 && x !== null) {
      cov += w[k];
      e += w[k] * Math.min(CAP, x);
    }
  }
  return cov / total >= 0.5 ? e / cov : null;
}

function corr(x, y, w, shift = 0) {
  const n = x.length;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const wi = w ? w[i] : 1;
    if (!wi) continue;
    const a = x[i];
    const b = y[(i + shift) % n];
    sw += wi;
    sx += wi * a;
    sy += wi * b;
    sxx += wi * a * a;
    syy += wi * b * b;
    sxy += wi * a * b;
  }
  const vx = sxx - (sx * sx) / sw;
  const vy = syy - (sy * sy) / sw;
  return vx > 0 && vy > 0 ? (sxy - (sx * sy) / sw) / Math.sqrt(vx * vy) : 0;
}

/** panel: [{ symbol, cal: Int32Array, rank: { name: Float64Array } }] */
function makePanel(perSymbol, columns) {
  return perSymbol.map(({ symbol, rows }) => ({
    symbol,
    cal: Int32Array.from(rows.map((r) => r.cal)),
    rank: Object.fromEntries(Object.entries(columns).map(([name, get]) => [name, Float64Array.from(ranks(rows.map(get)))])),
  })).filter((p) => p.cal.length >= 150);
}

function makeEngine(panel, seed = 7) {
  const random = seededRandom(seed);
  const all = panel.flatMap((p) => [...p.cal]);
  const minDay = Math.min(...all);
  const span = Math.max(...all) - minDay + 1;
  const boots = [];
  const shifts = [];
  for (let b = 0; b < B; b += 1) {
    const cnt = new Float32Array(span);
    for (let k = 0; k < Math.ceil(span / BLOCK); k += 1) {
      const start = Math.floor(random() * span);
      for (let d = 0; d < BLOCK; d += 1) cnt[(start + d) % span] += 1;
    }
    boots.push(panel.map((p) => Float32Array.from(p.cal, (c) => cnt[c - minDay])));
    shifts.push(0.1 + 0.8 * random());
  }
  const avg = (fn) => mean(panel.map(fn));
  return {
    rho: (s, t) => avg((p) => corr(p.rank[s], p.rank[t], null)),
    boot: (s, t) => boots.map((w) => avg((p) => corr(p.rank[s], p.rank[t], w[panel.indexOf(p)]))),
    perm: (s, t) => shifts.map((fr) => avg((p) => corr(p.rank[s], p.rank[t], null, Math.floor(fr * p.cal.length)))),
  };
}

const quant = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]; };

/** rho, 95% доверительный интервал блочного бутстрэпа, p перестановок (двусторонний) */
function testRho(engine, s, t) {
  const rho = engine.rho(s, t);
  const bs = engine.boot(s, t);
  const ps = engine.perm(s, t);
  const exceed = ps.filter((x) => Math.abs(x) >= Math.abs(rho)).length;
  return { rho, lo: quant(bs, 0.025), hi: quant(bs, 0.975), p: (1 + exceed) / (B + 1) };
}

/** разность rho двух сигналов; p по бутстрэпу */
function testDiff(engine, a, b, t) {
  const ba = engine.boot(a, t);
  const bb = engine.boot(b, t);
  const d = ba.map((x, i) => x - bb[i]);
  const le = d.filter((x) => x <= 0).length;
  const ge = d.filter((x) => x >= 0).length;
  return { diff: engine.rho(a, t) - engine.rho(b, t), lo: quant(d, 0.025), hi: quant(d, 0.975), p: Math.min(1, (2 * Math.min(le, ge) + 1) / (B + 1)) };
}

const table = (rows) => rows.forEach((r) => out(`   ${r}`));
const fmtTest = (t) => `rho ${f(t.rho)} [${f(t.lo)}; ${f(t.hi)}] p=${t.p.toFixed(3)}`;
function withFdr(tests) {
  const bh = benjaminiHochberg(tests.map((t) => t.p), FDR);
  tests.forEach((t, i) => { t.q = bh.qValues[i]; t.sig = bh.rejected[i]; });
  return bh;
}

// ---------------------------------------------------------------------------
// 0. Данные
// ---------------------------------------------------------------------------

out('Проверка весов и полураспадов на реальной истории (Yahoo 5 лет, SEC EDGAR, GDELT)');
out('');
const features = [];
const t0 = Date.now();
for (const symbol of symbols) {
  const rows = buildFeatures(symbol);
  if (rows.length >= 300) features.push({ symbol, rows });
}
const nObs = features.reduce((s, x) => s + x.rows.length, 0);
const first = Math.min(...features.map((x) => x.rows[0].cal));
const last = Math.max(...features.map((x) => x.rows.at(-1).cal));
const iso = (d) => new Date(d * DAY).toISOString().slice(0, 10);
out(`0. Данные: ${features.length} бумаг из ${symbols.length}, ${nObs} бумаго-дней сигнала, ${iso(first)} .. ${iso(last)} (признаки считались ${((Date.now() - t0) / 1000).toFixed(0)} с)`);
results.data = { symbols: features.map((x) => x.symbol), obs: nObs, from: iso(first), to: iso(last) };

// Копия формулы индекса внимания против quant.attentionIndex
{
  let n = 0;
  let same = 0;
  for (const { rows } of features) {
    for (let i = 0; i < rows.length; i += 7) {
      const c = rows[i].check;
      if (!Number.isFinite(c.score)) continue;
      const e = energy({ ...rows[i].raw, news: null }, CURRENT_W);
      const mine = Math.round(100 * (1 - Math.exp(-e)));
      n += 1;
      if (mine === c.score) same += 1;
    }
  }
  out(`   проверка копии формулы индекса (без новостей) против attentionIndex: совпало ${same} из ${n}`);
  results.replicaCheck = { attention: [same, n] };
}
{
  const demo = attentionIndex({ priceZ: 2, volumeRatio: 2, volatilityRatio: 1.5 });
  void demo; // импорт нужен для проверки выше; сам вызов гарантирует, что экспорт существует
}

// ---------------------------------------------------------------------------
// 1. Веса индекса внимания
// ---------------------------------------------------------------------------

out('');
out('1. Веса индекса внимания: прежние цена 0.4 / новости 0.3 / объём 0.2 / волатильность 0.1; сейчас в коде 0.23 / 0.3 / 0.23 / 0.23');
out('   Сигнал в конце сессии i (только прошлое), цель: |доходность| на i+1 (y1), средний |r| за 5 (y5) и 20 (y20) сессий.');
out('   Контроль направления: знаковая избыточная доходность за 5/20 сессий (a5, a20): индекс не должен быть направленным.');
out('   Показатель: средний по бумагам rho Спирмена; [95% блочный бутстрэп по календарю]; p перестановок; q по BH (FDR 10%).');

const W3 = {
  'прежние 0.4/0.2/0.1 (без новостей)': [0.4, 0, 0.2, 0.1],
  'равные 1/3 (сейчас в коде)': [1, 0, 1, 1],
  'только цена': [1, 0, 0, 0],
  'только объём': [0, 0, 1, 0],
  'только волатильность': [0, 0, 0, 1],
  'цена+объём (0.5/0.5)': [1, 0, 1, 0],
};
const W4 = {
  'прежние 0.4/0.3/0.2/0.1': OLD_W,
  'сейчас в коде 0.23/0.3/0.23/0.23': CURRENT_W,
  'равные 0.25': [1, 1, 1, 1],
  'без новостей (равные 1/3)': [1, 0, 1, 1],
  'только новости': [0, 1, 0, 0],
  'только цена ': [1, 0, 0, 0],
};
const TARGETS = ['y1', 'y5', 'y20'];
const SIGNED = ['a5', 'a20'];

function weightsBlock(title, variants, rowFilter, extraCols = {}) {
  const per = features.map(({ symbol, rows }) => ({ symbol, rows: rows.filter(rowFilter) })).filter((x) => x.rows.length >= 150);
  const cols = { y1: (r) => r.y1, y5: (r) => r.y5, y20: (r) => r.y20, a5: (r) => r.a5, a20: (r) => r.a20, absr: (r) => r.absr, rv20: (r) => r.rv20, ...extraCols };
  for (const [name, w] of Object.entries(variants)) cols[name] = (r) => energy(r.raw, w) ?? -1;
  const panel = makePanel(per, cols);
  const engine = makeEngine(panel);
  out('');
  out(`   ${title}: ${panel.length} бумаг, ${panel.reduce((s, p) => s + p.cal.length, 0)} наблюдений`);
  const all = [];
  const names = [...Object.keys(variants), 'вчерашний |r| (база)', 'rv20 (база)'];
  const colOf = { 'вчерашний |r| (база)': 'absr', 'rv20 (база)': 'rv20' };
  for (const name of names) {
    for (const t of [...TARGETS, ...SIGNED]) {
      const test = testRho(engine, colOf[name] ?? name, t);
      all.push({ name, t, ...test });
    }
  }
  withFdr(all);
  for (const name of names) {
    const cells = [...TARGETS, ...SIGNED].map((t) => {
      const x = all.find((a) => a.name === name && a.t === t);
      return `${t}: ${f(x.rho)}${x.sig ? '*' : ''}`;
    });
    out(`   ${name.padEnd(42)} ${cells.join('  ')}`);
  }
  out('   * значимо после BH (FDR 10%) против rho = 0');
  // Разности с прежними весами
  const base = Object.keys(variants)[0];
  const diffs = [];
  for (const name of [...Object.keys(variants).slice(1), 'вчерашний |r| (база)', 'rv20 (база)']) {
    for (const t of TARGETS) diffs.push({ name, t, ...testDiff(engine, base, colOf[name] ?? name, t) });
  }
  withFdr(diffs);
  out(`   Разность rho: «${base}» минус вариант (положительная: прежние лучше), q по BH на ${diffs.length} сравнений`);
  for (const d of diffs) out(`     ${d.name.padEnd(42)} ${d.t}: ${f(d.diff)} [${f(d.lo)}; ${f(d.hi)}] q=${f(d.q)}${d.sig ? ' *' : ''}`);
  return { panel, engine, all, diffs, base };
}

const noNews = weightsBlock('Панель A (без новостей, все бумаги)', W3, (r) => r.raw.price !== null && r.raw.volume !== null && r.raw.volatility !== null);
results.weightsNoNews = { n: noNews.panel.reduce((s, p) => s + p.cal.length, 0), tests: noNews.all.map(({ name, t, rho, lo, hi, p, q }) => ({ name, t, rho, lo, hi, p, q })), diffs: noNews.diffs.map(({ name, t, diff, lo, hi, p, q }) => ({ name, t, diff, lo, hi, p, q })) };

const newsSymbols = features.filter((x) => x.rows.some((r) => r.raw.news !== null)).length;
let withNews = null;
if (newsSymbols >= 5) {
  withNews = weightsBlock(`Панель B (с новостями GDELT за вчера, ${newsSymbols} бумаг)`, W4, (r) => r.raw.price !== null && r.raw.volume !== null && r.raw.volatility !== null && r.raw.news !== null);
  results.weightsNews = { symbols: newsSymbols, tests: withNews.all.map(({ name, t, rho, lo, hi, p, q }) => ({ name, t, rho, lo, hi, p, q })), diffs: withNews.diffs.map(({ name, t, diff, lo, hi, p, q }) => ({ name, t, diff, lo, hi, p, q })) };
} else {
  out('');
  out(`   Панель B (с новостями): нет данных (GDELT скачан для ${newsSymbols} бумаг, нужно не меньше 5)`);
}

// Walk-forward подбор весов: обучение на первых 60% календаря, проверка на последних 40%
{
  const cut = first + 0.6 * (last - first);
  const grid = [];
  for (let a = 0; a <= 10; a += 1) for (let b = 0; a + b <= 10; b += 1) grid.push([a / 10, 0, b / 10, (10 - a - b) / 10]);
  const rowsOk = (r) => r.raw.price !== null && r.raw.volume !== null && r.raw.volatility !== null;
  const split = (test) => features.map(({ symbol, rows }) => ({ symbol, rows: rows.filter((r) => rowsOk(r) && (test ? r.cal > cut : r.cal <= cut)) })).filter((x) => x.rows.length >= 120);
  const trainPer = split(false);
  const testPer = split(true);
  const score = (per, w, target) => mean(per.map(({ rows }) => {
    const x = ranks(rows.map((r) => energy(r.raw, w) ?? -1));
    const y = ranks(rows.map((r) => r[target]));
    return corr(Float64Array.from(x), Float64Array.from(y), null);
  }));
  const fit = grid.map((w) => ({ w, s: score(trainPer, w, 'y5') })).sort((a, b) => b.s - a.s);
  const best = fit[0].w;
  const dflt = [0.4, 0, 0.2, 0.1]; // прежние
  const normalised = (w) => { const t = w[0] + w[2] + w[3]; return w.map((x) => x / t); };
  out('');
  out(`   Walk-forward подбор (сетка шаг 0.1 по цена/объём/волатильность, цель y5): обучение до ${iso(cut)}, проверка после`);
  out(`   лучшие веса на обучении (цена/объём/волат.): ${normalised(best).filter((_, i) => i !== 1).map((x) => x.toFixed(2)).join('/')}, rho на обучении ${f(fit[0].s)}; прежние на обучении ${f(score(trainPer, dflt, 'y5'))}`);
  const testPanel = makePanel(testPer, { y1: (r) => r.y1, y5: (r) => r.y5, y20: (r) => r.y20, fit: (r) => energy(r.raw, best) ?? -1, dflt: (r) => energy(r.raw, dflt) ?? -1, eq: (r) => energy(r.raw, [1, 0, 1, 1]) ?? -1 });
  const engine = makeEngine(testPanel, 11);
  const rowsOut = [];
  for (const t of TARGETS) {
    const d = testDiff(engine, 'fit', 'dflt', t);
    const e = testDiff(engine, 'dflt', 'eq', t);
    rowsOut.push({ t, fit: engine.rho('fit', t), dflt: engine.rho('dflt', t), eq: engine.rho('eq', t), d, e });
    out(`   проверка ${t}: подобранные ${f(engine.rho('fit', t))}, прежние ${f(engine.rho('dflt', t))}, равные ${f(engine.rho('eq', t))}; подобранные минус прежние ${f(d.diff)} [${f(d.lo)}; ${f(d.hi)}] p=${d.p.toFixed(3)}; прежние минус равные ${f(e.diff)} [${f(e.lo)}; ${f(e.hi)}] p=${e.p.toFixed(3)}`);
  }
  results.walkForwardWeights = { cut: iso(cut), best: normalised(best), trainBest: fit[0].s, rows: rowsOut.map((r) => ({ t: r.t, fit: r.fit, dflt: r.dflt, eq: r.eq, fitMinusDflt: r.d, dfltMinusEq: r.e })) };
}

// ---------------------------------------------------------------------------
// 2. Полураспады
// ---------------------------------------------------------------------------

const HL = [1, 2, 3, 5, 7, 10, 14, 20, 30, 45];

out('');
out('2a. Затухание «необычности» дня: EMA индекса внимания (без новостей, веса в коде сейчас) с полураспадом H календарных дней');
out('    против |r| на i+1, средний |r| за 5 и 20 сессий. H=0: только сегодняшнее значение (как в коде досье).');
{
  const per = features.map(({ symbol, rows }) => {
    const e = rows.map((r) => energy(r.raw, [CURRENT_W[0], 0, CURRENT_W[2], CURRENT_W[3]]));
    const out2 = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (e[i] === null || i < 60) continue;
      const row = { ...rows[i], e0: e[i] };
      for (const h of HL) {
        let num = 0;
        let den = 0;
        for (let j = Math.max(0, i - 120); j <= i; j += 1) {
          if (e[j] === null) continue;
          const wgt = 0.5 ** ((rows[i].cal - rows[j].cal) / h);
          num += wgt * e[j];
          den += wgt;
        }
        row[`h${h}`] = den ? num / den : null;
      }
      out2.push(row);
    }
    return { symbol, rows: out2.filter((r) => HL.every((h) => r[`h${h}`] !== null)) };
  });
  const cols = { y1: (r) => r.y1, y5: (r) => r.y5, y20: (r) => r.y20, e0: (r) => r.e0 };
  for (const h of HL) cols[`h${h}`] = (r) => r[`h${h}`];
  const panel = makePanel(per, cols);
  const engine = makeEngine(panel, 21);
  const grid = [];
  for (const name of ['e0', ...HL.map((h) => `h${h}`)]) for (const t of TARGETS) grid.push({ name, t, ...testRho(engine, name, t) });
  withFdr(grid);
  for (const name of ['e0', ...HL.map((h) => `h${h}`)]) {
    const label = name === 'e0' ? 'H=0 (сегодня)' : `H=${name.slice(1)}`.padEnd(13);
    out(`   ${label.padEnd(14)} ${TARGETS.map((t) => { const x = grid.find((g) => g.name === name && g.t === t); return `${t}: ${f(x.rho)}${x.sig ? '*' : ''}`; }).join('  ')}`);
  }
  const bestOf = (t) => grid.filter((g) => g.t === t).sort((a, b) => b.rho - a.rho)[0];
  const decayDiffs = TARGETS.map((t) => { const b = bestOf(t); return { t, best: b.name, ...(b.name === 'e0' ? {} : testDiff(engine, b.name, 'e0', t)) }; });
  decayDiffs.forEach((d) => out(`   лучший по ${d.t}: ${d.best}${d.diff !== undefined ? `, выигрыш против «сегодня» ${f(d.diff)} [${f(d.lo)}; ${f(d.hi)}] p=${d.p.toFixed(3)}` : ''}`));
  results.attentionDecay = { grid: grid.map(({ name, t, rho, p, q }) => ({ name, t, rho, p, q })), best: decayDiffs };
}

out('');
out('2b. Затухание тона новостей (репутация): R_H = sum(w*s) / (sum(w)+3), w = 0.5^(возраст/H), s = тон GDELT/10 за день (до вчера включительно)');
out('    против знаковой избыточной доходности (бумага минус индекс) за 1/5/20 сессий вперёд.');
{
  const toneSymbols = features.filter((x) => x.rows.some((r) => r.tone !== null)).length;
  if (toneSymbols < 5) {
    out(`    нет данных: тон GDELT скачан для ${toneSymbols} бумаг (нужно не меньше 5)`);
    results.toneDecay = null;
  } else {
    const per = features.map(({ symbol, rows }) => {
      const rowsT = rows.filter((r) => r.tone !== null);
      const res = [];
      for (let i = 30; i < rowsT.length; i += 1) {
        const row = { ...rowsT[i] };
        for (const h of HL) {
          let num = 0;
          let den = 0;
          for (let j = Math.max(0, i - 120); j <= i; j += 1) {
            const age = rowsT[i].cal - rowsT[j].cal;
            const wgt = 0.5 ** (age / h);
            num += wgt * Math.max(-1, Math.min(1, rowsT[j].tone / 10));
            den += wgt;
          }
          row[`r${h}`] = num / (den + 3);
        }
        res.push(row);
      }
      return { symbol, rows: res };
    });
    const cols = { a1: (r) => r.a1, a5: (r) => r.a5, a20: (r) => r.a20 };
    for (const h of HL) cols[`r${h}`] = (r) => r[`r${h}`];
    const panel = makePanel(per, cols);
    const engine = makeEngine(panel, 31);
    const tg = ['a1', 'a5', 'a20'];
    const grid = [];
    for (const h of HL) for (const t of tg) grid.push({ h, t, ...testRho(engine, `r${h}`, t) });
    withFdr(grid);
    out(`    ${panel.length} бумаг, ${panel.reduce((s, p) => s + p.cal.length, 0)} наблюдений`);
    for (const h of HL) out(`    H=${String(h).padEnd(3)} ${tg.map((t) => { const x = grid.find((g) => g.h === h && g.t === t); return `${t}: ${f(x.rho)} [${f(x.lo)}; ${f(x.hi)}] p=${x.p.toFixed(2)}${x.sig ? '*' : ''}`; }).join('   ')}`);
    out(`    значимых после BH (FDR 10%) из ${grid.length}: ${grid.filter((g) => g.sig).length}`);
    results.toneDecay = { symbols: panel.length, grid: grid.map(({ h, t, rho, lo, hi, p, q }) => ({ h, t, rho, lo, hi, p, q })) };
  }
}

// 2c. Затухание аномальной волатильности после событий по типам (8-K): подгонка полураспада
out('');
out('2c. Сколько держится всплеск |AR|/сигма после реальных событий SEC (8-K) по типам; подгонка A*0.5^(tau/H) на tau=1..30 сессий');
const ITEM_TYPE = (items) => {
  const set = new Set(items.split(',').map((s) => s.trim()));
  if (set.has('5.02')) return 'leadership';
  if (set.has('2.02')) return 'earnings';
  if (['1.01', '2.01', '1.02', '2.03', '2.05'].some((x) => set.has(x))) return 'deal';
  if (['4.02', '1.05', '2.06'].some((x) => set.has(x))) return 'scandal';
  return 'other';
};
const secEvents = new Map();
for (const [symbol, list] of Object.entries(sec)) {
  secEvents.set(symbol, list.map(([time, items]) => ({ id: `${symbol}${time}`, time: Date.parse(time), type: ITEM_TYPE(items), sentiment: 0, title: `8-K ${items}`, source: 'SEC EDGAR', outlets: 1 })));
}
function eventProfiles(types) {
  const prof = Object.fromEntries(types.map((t) => [t, []]));
  for (const symbol of secEvents.keys()) {
    const hist = loadBars(symbol);
    const bench = loadBars(meta.get(symbol)?.benchmark);
    if (!hist || !bench) continue;
    const rows = alignedReturns(hist, bench);
    for (const ev of secEvents.get(symbol)) {
      if (!types.includes(ev.type)) continue;
      const d0 = rows.findIndex((r) => r.closeAt > ev.time);
      if (d0 < 150 || d0 + 31 >= rows.length) continue;
      const end = d0 - 5;
      const fit = fitMarketModel(rows.slice(Math.max(0, end - 120), end));
      if (!(fit.sigma > 1e-9)) continue;
      const z = [];
      for (let tau = -25; tau <= 30; tau += 1) {
        const r = rows[d0 + tau];
        z.push(Number.isFinite(r.s) && Number.isFinite(r.m) ? Math.abs(r.s - fit.alpha - fit.beta * r.m) / fit.sigma : null);
      }
      if (z.some((x) => x === null)) continue;
      prof[ev.type].push(z);
    }
  }
  return prof;
}
function fitDecay(excess) {
  // excess[k] для tau = 1..30; сетка H, амплитуда по МНК
  let best = null;
  for (let h = 0.5; h <= 60; h += 0.5) {
    let sxy = 0;
    let sxx = 0;
    for (let k = 0; k < excess.length; k += 1) { const g = 0.5 ** ((k + 1) / h); sxy += g * excess[k]; sxx += g * g; }
    const a = Math.max(0, sxy / sxx);
    let sse = 0;
    for (let k = 0; k < excess.length; k += 1) sse += (excess[k] - a * 0.5 ** ((k + 1) / h)) ** 2;
    if (!best || sse < best.sse) best = { h, a, sse };
  }
  return best;
}
{
  const types = ['earnings', 'leadership', 'deal', 'other'];
  const prof = eventProfiles(types);
  const random = seededRandom(41);
  const decay = {};
  for (const type of types) {
    const evs = prof[type];
    if (evs.length < 20) { out(`   ${type.padEnd(11)} событий ${evs.length}: нет данных (нужно не меньше 20)`); continue; }
    const baseOf = (sample) => mean(sample.map((z) => mean(z.slice(0, 20)))); // tau=-25..-6
    const excessOf = (sample) => { const b = baseOf(sample); return Array.from({ length: 56 }, (_, k) => mean(sample.map((z) => z[k])) - b); };
    const ex = excessOf(evs);
    const at = (tau) => ex[tau + 25];
    const fit = fitDecay(ex.slice(26, 56));
    const hs = [];
    const amps = [];
    for (let b = 0; b < (QUICK ? 80 : 300); b += 1) {
      const sample = Array.from({ length: evs.length }, () => evs[Math.floor(random() * evs.length)]);
      const fb = fitDecay(excessOf(sample).slice(26, 56));
      hs.push(fb.h);
      amps.push(fb.a);
    }
    const ampLo = quant(amps, 0.025);
    const hLo = quant(hs, 0.025);
    const hHi = quant(hs, 0.975);
    const calendar = (h) => h * 7 / 5;
    const prod = { earnings: 21, leadership: 30, deal: 21, other: 7 }[type];
    const real = ampLo > 0.02;
    out(`   ${type.padEnd(11)} событий ${String(evs.length).padStart(3)}; избыток |AR|/сигма: день0 ${f(at(0), 2)}, +1 ${f(at(1), 2)}, +2 ${f(at(2), 2)}, +5 ${f(at(5), 2)}, +10 ${f(at(10), 2)}, +20 ${f(at(20), 2)}`);
    out(`   ${' '.repeat(11)} подгонка на tau>=1: A=${f(fit.a, 3)} [нижн. 2.5%: ${f(ampLo, 3)}], H=${f(fit.h, 1)} сессий (~${f(calendar(fit.h), 1)} кал. дн.) [${f(calendar(hLo), 1)}; ${f(calendar(hHi), 1)}]; в коде досье ${prod} дн.; ${real ? 'эффект на tau>=1 отличим от нуля' : 'эффект на tau>=1 неотличим от нуля: полураспад не определён'}`);
    decay[type] = { n: evs.length, day0: at(0), day1: at(1), day5: at(5), A: fit.a, ALo: ampLo, hSessions: fit.h, hCalendar: calendar(fit.h), hCalendarCI: [calendar(hLo), calendar(hHi)], codeDays: prod, distinguishable: real };
  }
  results.eventDecay = decay;
}

// ---------------------------------------------------------------------------
// 3. Прогноз: сжатие PRIOR и коридор 80% на реальных событиях и ценах
// ---------------------------------------------------------------------------

out('');
out('3. Прогноз «новость → сценарий»: веса сжатия PRIOR и покрытие коридора 80% на реальных событиях (8-K)');
const HORIZONS = [1, 5, 20];
const Z80 = 1.2815515655;
const MIN_ANALOGUES = 5;
// Копия estimate() из forecast.js; priorVar позволяет сжимать среднее и дисперсию по-разному (в коде досье они равны).
function replicaEstimate(values, sigma, h, prior, priorVar = prior) {
  const n = values.length;
  const wMu = Number.isFinite(prior) ? n / (n + prior) : 0;
  const wVar = Number.isFinite(priorVar) ? n / (n + priorVar) : 0;
  const mu = n ? wMu * mean(values) : 0;
  const base = sigma ** 2 * h;
  const spread = n > 1 ? (1 - wVar) * base + wVar * (values.reduce((s, v) => s + (v - mean(values)) ** 2, 0) / (n - 1)) : base;
  return { mu, sd: Math.sqrt(spread), n };
}
// [подпись, PRIOR среднего, PRIOR дисперсии]; (10, 10) = прежнее значение в коде, (30, 5) = текущее; (inf, inf) = нулевая модель mu=0, sigma*sqrt(h)
const PRIORS = [['0/0', 0, 0], ['2/2', 2, 2], ['5/5', 5, 5], ['10/10 (прежнее)', 10, 10], ['20/20', 20, 20], ['50/50', 50, 50], ['mu=0, var 0', Infinity, 0], ['mu=0, var 2', Infinity, 2], ['mu=0, var 5', Infinity, 5], ['mu=0, var 10', Infinity, 10], ['mu 30, var 5 (сейчас)', 30, 5], ['mu 50, var 5', 50, 5], ['нулевая', Infinity, Infinity]];
const forecastRows = []; // { symbol, type, h, x, byPrior: {prior: {mu, sd}}, n }
{
  let replicaMax = 0;
  let replicaN = 0;
  for (const symbol of secEvents.keys()) {
    const hist = loadBars(symbol);
    if (!hist) continue;
    const rows = alignedReturns(hist, []);
    const closes = rows.map((r) => r.c);
    const list = secEvents.get(symbol)
      .map((ev) => ({ ev, day0: rows.findIndex((r) => r.closeAt > ev.time) }))
      .filter((c) => c.day0 > 0)
      .sort((a, b) => a.ev.time - b.ev.time);
    for (let k = 0; k < list.length; k += 1) {
      const { ev, day0 } = list[k];
      if (ev.type === 'other' || day0 < 130 || day0 + 20 >= closes.length) continue;
      const rets = rows.slice(1, day0).map((r) => r.s);
      if (rets.length < 60) continue;
      const sigma = stdev(rets.slice(-60));
      const before = day0; // события на момент выхода: сессий после него ещё нет
      const earlier = list.filter((c) => c.day0 > 0 && c.day0 < before && c.ev.type === ev.type && c.ev.time < ev.time);
      for (const h of HORIZONS) {
        const sample = [];
        let free = 0;
        for (const c of earlier) {
          const end = c.day0 + h - 1;
          if (c.day0 < free || end >= before) continue;
          sample.push(Math.log(closes[end] / closes[c.day0 - 1]));
          free = c.day0 + h;
        }
        if (sample.length < MIN_ANALOGUES) continue;
        const x = Math.log(closes[day0 - 1 + h] / closes[day0 - 1]);
        const byPrior = Object.fromEntries(PRIORS.map(([label, pm, pv]) => [label, replicaEstimate(sample, sigma, h, pm, pv)]));
        forecastRows.push({ symbol, type: ev.type, h, x, byPrior, n: sample.length, sigma });
        // сверка копии с computeForecasts на части событий
        if (h === 5 && replicaN < 30 && k % 3 === 0) {
          const cut = hist.slice(0, day0);
          const evs = list.filter((c) => c.ev.time <= ev.time).map((c) => c.ev);
          const target = { ...ev, id: 'target' };
          const outp = computeForecasts({ history: cut, events: [...evs.filter((e) => e.id !== ev.id), target] }, ev.time + 1000);
          const item = outp?.events.find((e) => e.eventId === 'target')?.horizons.find((q) => q.h === 5);
          if (item && item.rule === 'type+tone') {
            const mine = byPrior['mu 30, var 5 (сейчас)'];
            const mid = Math.log(item.midPrice / outp.lastClose);
            replicaMax = Math.max(replicaMax, Math.abs(mid - mine.mu));
            replicaN += 1;
          }
        }
      }
    }
  }
  out(`   сверка копии оценщика с computeForecasts (h=5, текущий код: mu 30, var 5): ${replicaN} событий, максимальное расхождение mu ${replicaMax.toExponential(2)}`);
  const logScore = (x, mu, sd) => -0.5 * Math.log(2 * Math.PI) - Math.log(sd) - 0.5 * ((x - mu) / sd) ** 2;
  const bootMean = (vals) => {
    const rnd = seededRandom(51);
    const bs = [];
    for (let b = 0; b < (QUICK ? 150 : 600); b += 1) {
      let s = 0;
      for (let i = 0; i < vals.length; i += 1) s += vals[Math.floor(rnd() * vals.length)];
      bs.push(s / vals.length);
    }
    return [quant(bs, 0.025), quant(bs, 0.975)];
  };
  const forecastOut = {};
  for (const h of HORIZONS) {
    const rows = forecastRows.filter((r) => r.h === h);
    if (rows.length < 30) { out(`   h=${h}: событий с n>=5 аналогов ${rows.length}: нет данных`); continue; }
    const byType = ['earnings', 'leadership', 'deal'].map((t) => `${t} ${rows.filter((r) => r.type === t).length}`).join(', ');
    out(`   h=${h} сессий, событий ${rows.length} (${byType}; бумаги ${new Set(rows.map((r) => r.symbol)).size}; средний размер выборки аналогов ${f(mean(rows.map((r) => r.n)), 1)}):`);
    const base = rows.map((r) => logScore(r.x, r.byPrior['нулевая'].mu, r.byPrior['нулевая'].sd));
    const dflt = rows.map((r) => logScore(r.x, r.byPrior['10/10 (прежнее)'].mu, r.byPrior['10/10 (прежнее)'].sd));
    forecastOut[h] = { n: rows.length, priors: {} };
    for (const [label] of PRIORS) {
      const ls = rows.map((r) => logScore(r.x, r.byPrior[label].mu, r.byPrior[label].sd));
      const diff = ls.map((v, i) => v - base[i]);
      const vsDefault = ls.map((v, i) => v - dflt[i]);
      const [lo, hi] = bootMean(diff);
      const [dlo, dhi] = bootMean(vsDefault);
      const cover = mean(rows.map((r) => (Math.abs(r.x - r.byPrior[label].mu) <= Z80 * r.byPrior[label].sd ? 1 : 0)));
      const mse = mean(rows.map((r) => (r.x - r.byPrior[label].mu) ** 2));
      const mseBase = mean(rows.map((r) => r.x ** 2));
      const upHit = mean(rows.map((r) => ((r.byPrior[label].mu >= 0) === (r.x >= 0) ? 1 : 0)));
      out(`     ${label.padEnd(15)} логскор против нулевой ${f(mean(diff), 3)} [${f(lo, 3)}; ${f(hi, 3)}], против прежнего ${f(mean(vsDefault), 3)} [${f(dlo, 3)}; ${f(dhi, 3)}], покрытие 80%: ${pct(cover)}, MSE/MSE(0): ${f(mse / mseBase, 3)}, знак: ${pct(upHit)}`);
      forecastOut[h].priors[label] = { dLogScore: mean(diff), lo, hi, vsDefault: mean(vsDefault), vsDefaultCI: [dlo, dhi], coverage80: cover, mseRatio: mse / mseBase, signHit: upHit };
    }
  }
  results.forecastPrior = forecastOut;

  // Покрытие базового коридора (без событий) на всех днях реальных цен: sigma из 60 последних доходностей, как в forecast.js
  out('   Покрытие базового коридора 80% (mu=0, sigma60*sqrt(h)) на всех днях реальных цен, шаг 5 сессий:');
  const cov = { 1: [0, 0], 5: [0, 0], 20: [0, 0] };
  const covRegion = {};
  for (const symbol of symbols) {
    const hist = loadBars(symbol);
    const rows = alignedReturns(hist, []);
    const closes = rows.map((r) => r.c);
    for (let i = 130; i < rows.length - 20; i += 5) {
      const sigma = stdev(rows.slice(i - 59, i + 1).map((r) => r.s));
      for (const h of HORIZONS) {
        const x = Math.log(closes[i + h] / closes[i]);
        const hit = Math.abs(x) <= Z80 * sigma * Math.sqrt(h);
        cov[h][0] += hit ? 1 : 0;
        cov[h][1] += 1;
        const region = meta.get(symbol).region;
        covRegion[region] ??= { 1: [0, 0], 5: [0, 0], 20: [0, 0] };
        covRegion[region][h][0] += hit ? 1 : 0;
        covRegion[region][h][1] += 1;
      }
    }
  }
  out(`     все бумаги: ${HORIZONS.map((h) => `h=${h}: ${pct(cov[h][0] / cov[h][1])} (n=${cov[h][1]})`).join(', ')}`);
  for (const [region, c] of Object.entries(covRegion)) out(`     ${region.padEnd(7)}: ${HORIZONS.map((h) => `h=${h}: ${pct(c[h][0] / c[h][1])}`).join(', ')}`);
  results.corridorBaseline = { all: Object.fromEntries(HORIZONS.map((h) => [h, cov[h][0] / cov[h][1]])), byRegion: Object.fromEntries(Object.entries(covRegion).map(([r, c]) => [r, Object.fromEntries(HORIZONS.map((h) => [h, c[h][0] / c[h][1]]))])) };
}

// ---------------------------------------------------------------------------
// 4. VaR и скачки на 5 годах реальных цен
// ---------------------------------------------------------------------------

out('');
out('4. VaR 99% (окно 250 сессий, шаг 2) и детектор скачков на реальных ценах, 5 лет');
function kupiec(hits, n, p) {
  if (!n) return null;
  const ll = (q) => (hits ? hits * Math.log(q) : 0) + (n - hits ? (n - hits) * Math.log(1 - q) : 0);
  const phat = Math.min(Math.max(hits / n, 1e-9), 1 - 1e-9);
  const lr = -2 * (ll(p) - ll(phat));
  const z = Math.sqrt(Math.max(lr, 0) / 2);
  const t = 1 / (1 + 0.3275911 * z);
  return t * Math.exp(-z * z) * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
}
{
  const methods = ['historical', 'parametricT', 'cornishFisher'];
  const total = Object.fromEntries(methods.map((m) => [m, 0]));
  let n = 0;
  let jumpsDefault = 0;
  let jumpsReport = 0;
  let jumpDays = 0;
  let perSymbolRows = [];
  for (const symbol of symbols) {
    const hist = loadBars(symbol);
    const r = alignedReturns(hist, []).map((x) => x.s).filter(Number.isFinite);
    const hits = Object.fromEntries(methods.map((m) => [m, 0]));
    let m = 0;
    for (let t = 250; t < r.length; t += 2) {
      const v = valueAtRisk(r.slice(t - 250, t), { level: 0.99 });
      if (!v) continue;
      m += 1;
      for (const k of methods) if (v[k] !== null && r[t] < 0 && -Math.expm1(r[t]) > v[k]) hits[k] += 1;
    }
    n += m;
    for (const k of methods) total[k] += hits[k];
    jumpsDefault += detectJumps(r).length;
    jumpsReport += reportJumps(r).length;
    jumpDays += r.length - 20;
    perSymbolRows.push({ symbol, m, rate: hits.historical / m, rateT: hits.parametricT / m, rateCF: hits.cornishFisher / m });
  }
  for (const k of methods) out(`   VaR99 ${k.padEnd(14)} пробоев ${total[k]} из ${n}: ${pct(total[k] / n, 2)} (заявлено 1%), p Купьеца ${f(kupiec(total[k], n, 0.01), 3)} (наблюдения соседних дней зависимы: p ориентировочный)`);
  const worst = [...perSymbolRows].sort((a, b) => b.rateT - a.rateT).slice(0, 3);
  out(`   худшие бумаги для parametricT: ${worst.map((w) => `${w.symbol} ${pct(w.rateT, 1)}`).join(', ')}`);
  out(`   Скачки Ли-Майкленда: окно 20 / 0.99 (умолчание risk.js) флагует ${pct(jumpsDefault / jumpDays, 2)} дней (${jumpsDefault} из ${jumpDays}); окно 60 / 0.997 (идёт в досье, reportJumps): ${pct(jumpsReport / jumpDays, 2)} (${jumpsReport})`);
  out('   Это доля помеченных дней на реальных рядах, где настоящие скачки существуют: верхняя оценка ложных срабатываний, а не их точная частота.');
  results.risk = { var99: Object.fromEntries(methods.map((k) => [k, { hits: total[k], n, rate: total[k] / n, kupiecP: kupiec(total[k], n, 0.01) }])), jumps: { default: jumpsDefault / jumpDays, report: jumpsReport / jumpDays, days: jumpDays } };
}

if (!QUICK) writeFileSync(join(DATA, 'results.json'), JSON.stringify(results));
out('');
out('готово');
