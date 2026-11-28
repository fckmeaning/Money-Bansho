// Calibration check of the dossier models. Run: node api/_dossier/math/backtest.mjs [--quick] [--live AAPL,MSFT]
//
// There are no stored market fixtures in the repository, so by default every check runs on
// SIMULATED series with a KNOWN data-generating process (seeded, reproducible). This tests whether
// the code delivers the coverage it states (VaR level, 80 % corridor, jump level, Hawkes
// half-life), NOT whether the models describe a real market. `--live` adds the same VaR and
// jump checks on two years of real Yahoo closes (network needed); a failed download prints
// "нет данных" and is skipped, nothing is invented.
// Exit code is always 0: this is a report, not a gate.
import { computeForecasts } from './forecast.js';
import { fitHawkes } from './hawkes.js';
import { reportJumps } from './report.js';
import { detectJumps, valueAtRisk } from './risk.js';
import { normalSample, seededRandom } from './stats.js';

const QUICK = process.argv.includes('--quick');
const DAY = 86_400_000;
const pct = (x, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : 'нет данных');

// ---------------------------------------------------------------------------
// Simulators
// ---------------------------------------------------------------------------

function studentT(random, nu) {
  // t_nu scaled to unit variance: z / sqrt(chi2_nu / nu) * sqrt((nu-2)/nu)
  let chi = 0;
  for (let i = 0; i < nu; i += 1) chi += normalSample(random) ** 2;
  return (normalSample(random) / Math.sqrt(chi / nu)) * Math.sqrt((nu - 2) / nu);
}

/** GARCH(1,1) with Student-t innovations, daily sigma about 1.5 %. */
function garchSeries(n, seed, { alpha = 0.08, beta = 0.9, nu = 6, sigma = 0.015 } = {}) {
  const random = seededRandom(seed);
  const omega = sigma ** 2 * (1 - alpha - beta);
  let h = sigma ** 2;
  const out = [];
  for (let t = 0; t < n + 200; t += 1) {
    const e = Math.sqrt(h) * studentT(random, nu);
    if (t >= 200) out.push(e);
    h = omega + alpha * e * e + beta * h;
  }
  return out;
}

const gaussianSeries = (n, seed, sd = 0.015) => {
  const random = seededRandom(seed);
  return Array.from({ length: n }, () => sd * normalSample(random));
};

/** Ogata thinning for an exponential-kernel Hawkes process on [0, T] days. */
function hawkesTimes(mu, branching, halfLife, T, seed) {
  const random = seededRandom(seed);
  const beta = Math.LN2 / halfLife;
  const times = [];
  let t = 0;
  let excess = 0; // sum n*beta*exp(-beta(t - t_i))
  while (t < T) {
    const bound = mu + excess;
    const wait = -Math.log(1 - random()) / bound;
    excess *= Math.exp(-beta * wait);
    t += wait;
    if (t >= T) break;
    if (random() * bound <= mu + excess) {
      times.push(t);
      excess += branching * beta;
    }
  }
  return times;
}

function weekdayBars(returns, start = Date.UTC(2023, 0, 2, 14, 30)) {
  const bars = [];
  let price = 100;
  let t = start;
  for (const r of returns) {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += DAY;
    price *= Math.exp(r);
    bars.push({ t, c: price, v: 1000 });
    t += DAY;
  }
  return bars;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Kupiec unconditional-coverage likelihood ratio; p-value from chi-square(1). */
function kupiec(hits, n, p) {
  if (!n) return null;
  const x = hits;
  const ll = (q) => (x ? x * Math.log(q) : 0) + (n - x ? (n - x) * Math.log(1 - q) : 0);
  const phat = Math.min(Math.max(x / n, 1e-9), 1 - 1e-9);
  const lr = -2 * (ll(p) - ll(phat));
  // chi2(1) survival = erfc(sqrt(lr/2))
  const z = Math.sqrt(Math.max(lr, 0) / 2);
  const t = 1 / (1 + 0.3275911 * z);
  const erfc = t * Math.exp(-z * z) * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return erfc;
}

function jumpCheck(label, make, runs, detect = detectJumps) {
  let seriesWithJump = 0;
  let flagged = 0;
  let tested = 0;
  for (let k = 0; k < runs; k += 1) {
    const r = make(k);
    const jumps = detect(r);
    if (jumps.length) seriesWithJump += 1;
    flagged += jumps.length;
    tested += r.length - 20;
  }
  return { label, runs, familywise: seriesWithJump / runs, perReturn: flagged / tested };
}

function varCheck(label, make, runs, window = 250) {
  const methods = ['historical', 'parametricT', 'cornishFisher'];
  const hits = Object.fromEntries(methods.map((m) => [m, 0]));
  let n = 0;
  for (let k = 0; k < runs; k += 1) {
    const r = make(k);
    for (let t = window; t < r.length; t += 5) { // step 5 sessions: keeps the run fast
      const v = valueAtRisk(r.slice(t - window, t), { level: 0.99 });
      if (!v) continue;
      n += 1;
      for (const m of methods) if (v[m] !== null && -Math.expm1(r[t]) > v[m] && r[t] < 0) hits[m] += 1;
    }
  }
  return { label, n, rows: methods.map((m) => ({ m, rate: hits[m] / n, p: kupiec(hits[m], n, 0.01) })) };
}

/** 80 % corridor coverage of computeForecasts, with and without random "events" in the history. */
function corridorCheck(runs) {
  const rows = { baseline: { 1: [0, 0], 5: [0, 0], 20: [0, 0] }, analogue: { 1: [0, 0], 5: [0, 0], 20: [0, 0] } };
  const types = ['leadership', 'lawsuit', 'product', 'regulatory'];
  for (let k = 0; k < runs; k += 1) {
    const returns = garchSeries(700, 1000 + k);
    const bars = weekdayBars(returns);
    const random = seededRandom(5000 + k);
    // Events with NO real effect, every ~6 sessions.
    const events = [];
    for (let i = 30; i < bars.length - 25; i += 3 + Math.floor(random() * 6)) {
      events.push({
        id: `e${i}`, time: bars[i].t + 3_600_000, type: types[Math.floor(random() * types.length)],
        sentiment: random() < 0.5 ? -0.5 : 0.5, title: 'x', source: 'x', outlets: 1,
      });
    }
    for (let probe = 0; probe < 4; probe += 1) {
      const i = 350 + probe * 80;
      const cut = bars.slice(0, i + 1);
      const nowMs = bars[i].t + DAY - 1; // the session i has closed, i + 1 has not
      const target = { id: 'target', time: nowMs - 600_000, type: 'leadership', sentiment: -0.5, title: 't', source: 'x', outlets: 1 };
      const variants = {
        baseline: [target],
        analogue: [...events.filter((e) => e.time < bars[i].t), target],
      };
      for (const [name, evs] of Object.entries(variants)) {
        const out = computeForecasts({ history: cut, events: evs }, nowMs);
        const item = out?.events.find((e) => e.eventId === 'target');
        if (!item) continue;
        for (const h of item.horizons) {
          const end = bars[i + h.h]?.c;
          if (!end) continue;
          const cell = rows[name][h.h];
          cell[1] += 1;
          if (end >= h.lowPrice && end <= h.highPrice) cell[0] += 1;
        }
      }
    }
  }
  return rows;
}

function hawkesCheck(runs, truth) {
  const ests = [];
  let flagged = 0;
  let poissonFlagged = 0;
  for (let k = 0; k < runs; k += 1) {
    const fit = fitHawkes(hawkesTimes(truth.mu, truth.branching, truth.halfLife, truth.T, 77 + k).map((d) => d * DAY), truth.T * DAY);
    if (fit?.selfExciting) {
      flagged += 1;
      ests.push({ n: fit.branching, hl: fit.halfLifeHours / 24 });
    }
    const flat = hawkesTimes(truth.mu * 2, 0, 1, truth.T, 9000 + k).map((d) => d * DAY);
    if (fitHawkes(flat, truth.T * DAY)?.selfExciting) poissonFlagged += 1;
  }
  const med = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  return { truth, runs, detection: flagged / runs, falseAlarm: poissonFlagged / runs, nMedian: med(ests.map((e) => e.n)), hlMedian: med(ests.map((e) => e.hl)) };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const out = (line = '') => process.stdout.write(`${line}\n`);
const runs = QUICK ? 40 : 200;

out('Калибровка моделей досье (симуляция с известным процессом; не доказывает пригодность на реальном рынке)');
out('');

out(`1. Детектор скачков Ли-Майкленда, ${runs} рядов по 500 дней`);
out('   "по ряду" = доля рядов хотя бы с одним ложным скачком (заявлено: около 1 % при гауссовом шуме)');
const makers = [
  ['гаусс, iid        ', (k) => gaussianSeries(500, 100 + k)],
  ['Стьюдент nu=6, iid', (k) => { const rnd = seededRandom(200 + k); return Array.from({ length: 500 }, () => 0.015 * studentT(rnd, 6)); }],
  ['GARCH-t           ', (k) => garchSeries(500, 300 + k)],
];
for (const [name, detect] of [['окно 20, уровень 0.99 (умолчание risk.js)', detectJumps], ['окно 60, уровень 0.997 (то, что идёт в досье)', reportJumps]]) {
  out(`   ${name}`);
  for (const [label, make] of makers) {
    const row = jumpCheck(label, make, runs, detect);
    out(`     ${row.label}: по ряду ${pct(row.familywise)}, на один день ${pct(row.perReturn, 3)}`);
  }
}
out('   Для тяжёлых хвостов и GARCH флаги не ложные тревоги в строгом смысле: тест предполагает гауссов диффузионный шум,');
out('   поэтому «скачок» читать как «аномально большое движение по локальной шкале», а не как доказанный разрыв цены.');
out('');

out('2. VaR 99 % вне выборки: окно 250 дней, пробой = убыток больше VaR (заявлено 1 %)');
const v = varCheck('GARCH-t', (k) => garchSeries(1000, 400 + k), QUICK ? 10 : 40);
out(`   ${v.label}, проверок: ${v.n}`);
for (const row of v.rows) out(`   ${row.m.padEnd(14)} частота пробоев ${pct(row.rate, 2)}, p Купьеца ${row.p === null ? 'нет данных' : row.p.toFixed(3)}`);
out('');

out('3. Коридор 80 % прогноза (computeForecasts), доля случаев внутри; GARCH-t; события без реального эффекта');
const c = corridorCheck(QUICK ? 15 : 60);
for (const [name, cells] of Object.entries(c)) {
  out(`   ${name.padEnd(9)} ${Object.entries(cells).map(([h, [ok, n]]) => `h=${h}: ${n ? pct(ok / n) : 'нет данных'} (n=${n})`).join(', ')}`);
}
out('');

for (const branching of [0.5, 0.8]) {
  const hk = hawkesCheck(QUICK ? 20 : 60, { mu: 2, branching, halfLife: 0.5, T: 30 });
  out(`4. Хокс: истина mu=2/день, ветвление ${branching}, полураспад 12 ч, окно 30 дней, ${hk.runs} прогонов`);
  out(`   обнаружено самовозбуждение ${pct(hk.detection)} (мощность); ложная тревога на пуассоне ${pct(hk.falseAlarm)}`);
  out(`   медианы среди обнаруженных (смещены вверх отбором): ветвление ${hk.nMedian?.toFixed(2) ?? 'нет данных'}, полураспад ${hk.hlMedian !== null ? `${(hk.hlMedian * 24).toFixed(1)} ч` : 'нет данных'}`);
}
out('');

// Optional real data.
const liveArg = process.argv.indexOf('--live');
if (liveArg > 0) {
  const { loadChart } = await import('../yahoo.js');
  out('5. Реальные цены (Yahoo, 2 года): скачки и VaR 99 %');
  for (const symbol of (process.argv[liveArg + 1] || 'AAPL').split(',')) {
    try {
      const { value } = await loadChart(symbol, 60_000);
      const closes = value.history.map((b) => b.c).filter((x) => x > 0);
      const r = closes.slice(1).map((x, i) => Math.log(x / closes[i]));
      if (r.length < 300) throw new Error('мало данных');
      const jumps = detectJumps(r);
      const vr = varCheck(symbol, () => r, 1);
      out(`   ${symbol}: ${r.length} дней, скачков ${jumps.length} (${pct(jumps.length / (r.length - 20), 2)} дней); VaR99 пробои: ${vr.rows.map((x) => `${x.m} ${pct(x.rate, 2)}`).join(', ')}`);
    } catch (error) {
      out(`   ${symbol}: нет данных (${error.message})`);
    }
  }
}
