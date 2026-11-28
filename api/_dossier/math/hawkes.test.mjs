import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitHawkes } from './hawkes.js';
import { seededRandom } from './stats.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27, 12);
const WINDOW = 30;
const toMs = (days, windowDays = WINDOW) => NOW - (windowDays - days) * DAY;
const exponential = (random, rate) => -Math.log(1 - random()) / rate;

/** Ogata thinning: between events the intensity only decays, so it bounds itself. */
function simulateHawkes({ mu, branching, halfLifeHours, seed, horizon = WINDOW }) {
  const random = seededRandom(seed);
  const beta = Math.LN2 / (halfLifeHours / 24);
  const times = [];
  let now = 0;
  let excitation = 0;
  for (;;) {
    const bound = mu + excitation;
    const wait = exponential(random, bound);
    now += wait;
    if (now > horizon) break;
    excitation *= Math.exp(-beta * wait);
    if (random() * bound <= mu + excitation) {
      times.push(now);
      excitation += branching * beta;
    }
  }
  return times.map((t) => toMs(t, horizon));
}

function simulatePoisson(rate, seed, horizon = WINDOW) {
  const random = seededRandom(seed);
  const times = [];
  for (let t = exponential(random, rate); t <= horizon; t += exponential(random, rate)) times.push(toMs(t, horizon));
  return times;
}

/** O(N^2) reference likelihood straight from the definition. */
function bruteLogLik(timesMs, mu, n, beta, horizon = WINDOW) {
  const t = timesMs.map((ms) => horizon - (NOW - ms) / DAY).sort((a, b) => a - b);
  let total = -mu * horizon;
  t.forEach((ti, i) => {
    let lambda = mu;
    for (let j = 0; j < i; j += 1) lambda += n * beta * Math.exp(-beta * (ti - t[j]));
    total += Math.log(lambda) - n * (1 - Math.exp(-beta * (horizon - ti)));
  });
  return total;
}

const average = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

test('likelihood matches the definition and is a maximum', () => {
  const times = simulateHawkes({ mu: 3, branching: 0.5, halfLifeHours: 4, seed: 11 });
  const fit = fitHawkes(times, NOW);
  const beta = Math.LN2 / (fit.halfLifeHours / 24);
  const top = bruteLogLik(times, fit.mu, fit.branching, beta);
  assert.ok(Math.abs(top - fit.logLik) < 1e-3, `${top} vs ${fit.logLik}`);
  for (const factor of [0.9, 1.1]) {
    assert.ok(bruteLogLik(times, fit.mu * factor, fit.branching, beta) < top);
    assert.ok(bruteLogLik(times, fit.mu, fit.branching * factor, beta) < top);
    assert.ok(bruteLogLik(times, fit.mu, fit.branching, beta * factor) < top);
  }
  assert.ok(Math.abs(fit.aic - (6 - 2 * fit.logLik)) < 1e-4);
  const n = times.length;
  assert.ok(Math.abs(fit.poissonAic - (2 - 2 * (n * Math.log(n / WINDOW) - n))) < 1e-4);
  const now = fit.mu + times.reduce((s, ms) => s + fit.branching * beta * Math.exp((-beta * (NOW - ms)) / DAY), 0);
  assert.ok(Math.abs(now - fit.intensityNow) < 1e-2 * Math.max(1, now));
  assert.equal(fit.events, n);
  assert.ok(Math.abs(fit.baselinePerDay - n / WINDOW) < 1e-5);
});

test('recovers branching ratio and half-life of simulated Hawkes data', () => {
  // minDetected reflects statistical power: weak, slow excitation is often
  // indistinguishable from Poisson at this sample size, so no floor there.
  for (const { minDetected, ...truth } of [
    { mu: 3, branching: 0.6, halfLifeHours: 2, minDetected: 38 },
    // The detector must also beat trend and step explanations, which costs power
    // on weak excitation: about half of such samples are detected.
    { mu: 3, branching: 0.35, halfLifeHours: 2, minDetected: 16 },
    { mu: 5, branching: 0.35, halfLifeHours: 6, minDetected: 0 },
  ]) {
    const fits = [];
    for (let seed = 1; seed <= 40; seed += 1) fits.push(fitHawkes(simulateHawkes({ ...truth, seed }), NOW));
    assert.ok(fits.every(Boolean));
    const branching = average(fits.map((f) => f.branching));
    assert.ok(Math.abs(branching - truth.branching) < 0.07, `mean branching ${branching}`);
    const halfLives = fits.map((f) => f.halfLifeHours).filter((h) => h !== null).sort((a, b) => a - b);
    const middle = halfLives[Math.floor(halfLives.length / 2)];
    assert.ok(middle > truth.halfLifeHours / 1.6 && middle < truth.halfLifeHours * 1.6, `median half-life ${middle}`);
    const mu = average(fits.map((f) => f.mu));
    assert.ok(Math.abs(mu - truth.mu) < 0.2 * truth.mu, `mean mu ${mu}`);
    const detected = fits.filter((f) => f.selfExciting).length;
    console.log(`n=${truth.branching} hl=${truth.halfLifeHours}h: mean n ${branching.toFixed(3)}, median hl ${middle.toFixed(2)}h, detected ${detected}/40`);
    assert.ok(detected >= minDetected, `detected ${detected}/40`);
    // The true model family must usually pass the goodness-of-fit test.
    assert.ok(fits.filter((f) => f.fitPValue > 0.05).length >= 36);
  }
});

test('large sample gives a tight branching estimate', () => {
  const times = simulateHawkes({ mu: 5, branching: 0.7, halfLifeHours: 1, seed: 5 });
  const fit = fitHawkes(times, NOW);
  assert.ok(times.length > 350);
  assert.ok(Math.abs(fit.branching - 0.7) < 0.1, `branching ${fit.branching}`);
  assert.equal(fit.selfExciting, true);
  assert.equal(fit.windowStartCovered, true);
});

test('Poisson data is not reported as self-exciting', () => {
  const single = fitHawkes(simulatePoisson(5, 42), NOW);
  assert.equal(single.selfExciting, false);
  assert.ok(single.branching < 0.2, `branching ${single.branching}`);
  for (const rate of [1.2, 4, 12]) {
    let flagged = 0;
    let fitted = 0;
    for (let seed = 100; seed < 300; seed += 1) {
      const fit = fitHawkes(simulatePoisson(rate, seed), NOW);
      if (!fit) continue;
      fitted += 1;
      if (fit.selfExciting) flagged += 1;
    }
    assert.ok(fitted > 150);
    assert.ok(flagged / fitted <= 0.03, `rate ${rate}: ${flagged}/${fitted} false positives`);
  }
});

test('goodness of fit rejects clockwork arrivals', () => {
  const times = Array.from({ length: 120 }, (_, i) => toMs((i + 0.5) * 0.25));
  const fit = fitHawkes(times, NOW);
  assert.equal(fit.selfExciting, false);
  assert.ok(fit.branching < 0.05);
  assert.ok(fit.fitPValue < 0.001, `p ${fit.fitPValue}`);
  if (fit.branching === 0) assert.equal(fit.halfLifeHours, null);
});

test('recency-truncated feed is flagged and never called self-exciting', () => {
  const random = seededRandom(3);
  const times = Array.from({ length: 100 }, () => toMs(26 + 4 * random()));
  const fit = fitHawkes(times, NOW);
  assert.equal(fit.windowStartCovered, false);
  assert.equal(fit.selfExciting, false);
});

test('a few old items before a dense capped block are not called self-exciting', () => {
  let flagged = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = seededRandom(seed);
    const times = [
      ...Array.from({ length: 20 }, () => toMs(26 * random())),
      ...Array.from({ length: 100 }, () => toMs(26 + 4 * random())),
    ];
    if (fitHawkes(times, NOW).selfExciting) flagged += 1;
  }
  console.log(`capped mix: ${flagged}/200 flagged self-exciting`);
  assert.ok(flagged <= 10, `${flagged}/200`);
});

test('step likelihood matches a brute-force change-point search', () => {
  const random = seededRandom(31);
  const times = [
    ...Array.from({ length: 30 }, () => toMs(20 * random())),
    ...Array.from({ length: 60 }, () => toMs(20 + 10 * random())),
  ];
  const t = times.map((ms) => WINDOW - (NOW - ms) / DAY);
  let best = -Infinity;
  for (let change = 1; change <= WINDOW - 1; change += 0.0005) {
    const head = t.filter((x) => x < change).length;
    const part = (k, length) => (k ? k * Math.log(k / length) : 0);
    best = Math.max(best, part(head, change) + part(t.length - head, WINDOW - change) - t.length);
  }
  const reported = (6 - fitHawkes(times, NOW).stepAic) / 2;
  assert.ok(reported >= best - 1e-6 && reported - best < 0.05, `${reported} vs ${best}`);
});

test('a rising rate without clustering is not called self-exciting', () => {
  // Density grows towards now, like a recency-weighted search. The stationary
  // Hawkes model explains this with a large branching ratio; the flag must not.
  for (const power of [2, 3, 4]) {
    const even = fitHawkes(Array.from({ length: 200 }, (_, i) => toMs(30 * ((i + 0.5) / 200) ** (1 / power))), NOW);
    assert.ok(even.branching > 0.9, 'the trap this guard exists for');
    assert.ok(even.trendAic < even.poissonAic);
    assert.equal(even.selfExciting, false);
    let flagged = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = seededRandom(seed);
      const fit = fitHawkes(Array.from({ length: 150 }, () => toMs(30 * random() ** (1 / power))), NOW);
      if (fit.selfExciting) flagged += 1;
    }
    console.log(`trend t^${power - 1}: ${flagged}/200 flagged self-exciting`);
    assert.ok(flagged <= 10, `power ${power}: ${flagged}/200`);
  }
});

test('daily and weekly publishing rhythms are mostly not called self-exciting', () => {
  const rhythms = {
    daily: [(t) => 5 * (1 + 0.9 * Math.cos(2 * Math.PI * t)), 9.5],
    weekend: [(t) => (t % 7 >= 5 ? 1.2 : 6), 6],
  };
  for (const [name, [rate, peak]] of Object.entries(rhythms)) {
    let flagged = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = seededRandom(seed + 5000);
      // Thinning of a homogeneous process at the peak rate.
      const times = simulatePoisson(peak, seed).filter((ms) => random() * peak < rate(WINDOW - (NOW - ms) / DAY));
      const fit = fitHawkes(times, NOW);
      if (fit.selfExciting) flagged += 1;
    }
    console.log(`${name} rhythm: ${flagged}/200 flagged self-exciting`);
    assert.ok(flagged <= 10, `${name}: ${flagged}/200`);
  }
});

test('trend likelihood matches a direct log-linear fit', () => {
  const times = simulatePoisson(4, 17);
  const t = times.map((ms) => WINDOW - (NOW - ms) / DAY);
  const direct = (b) => {
    const a = Math.log((t.length * b) / (Math.exp(b * WINDOW) - 1));
    return t.length * a + b * t.reduce((s, x) => s + x, 0) - t.length;
  };
  let best = -Infinity;
  for (let b = -0.2; b <= 0.2; b += 0.00001) if (Math.abs(b) > 1e-9) best = Math.max(best, direct(b));
  assert.ok(Math.abs(fitHawkes(times, NOW).trendAic - (4 - 2 * best)) < 1e-3);
});

test('identical timestamps are handled deterministically', () => {
  const random = seededRandom(8);
  const times = [];
  for (let i = 0; i < 25; i += 1) {
    const stamp = Math.round(toMs(30 * random()));
    times.push(stamp, stamp, stamp);
  }
  times.push(NOW, NOW, NOW - WINDOW * DAY, NOW - WINDOW * DAY);
  const first = fitHawkes(times, NOW);
  const second = fitHawkes([...times].reverse(), NOW);
  assert.deepEqual(first, second);
  assert.equal(first.events, times.length);
  assert.ok(first.branching >= 0 && first.branching < 1);
  for (const key of ['mu', 'logLik', 'aic', 'intensityNow', 'fitPValue', 'halfLifeHours']) {
    assert.ok(Number.isFinite(first[key]), key);
  }
  assert.ok(first.halfLifeHours >= 0.25 - 1e-6);
});

test('extreme clustering respects the stationarity bound', () => {
  const times = [];
  let t = 0;
  // Each gap is longer than the last: an explosive cascade seen in reverse is the worst case.
  for (let i = 0; i < 200; i += 1) {
    t += 0.002 + (i % 50 === 0 ? 3 : 0);
    times.push(toMs(t));
  }
  const fit = fitHawkes(times, NOW);
  assert.ok(fit.branching > 0.8 && fit.branching <= 0.999);
  assert.ok(fit.mu > 0);
});

test('window filtering, order independence and input immutability', () => {
  const times = simulatePoisson(3, 9);
  const noisy = [...times, NOW + 1000, NOW - 31 * DAY, NaN, Infinity].reverse();
  const copy = [...noisy];
  assert.deepEqual(fitHawkes(noisy, NOW), fitHawkes(times, NOW));
  assert.deepEqual(noisy, copy);
});

test('returns null when data is too thin or degenerate', () => {
  const few = simulatePoisson(3, 1).slice(0, 19);
  assert.equal(fitHawkes(few, NOW), null);
  assert.ok(fitHawkes(few, NOW, { minEvents: 10, windowDays: 30 }));
  assert.equal(fitHawkes([], NOW), null);
  assert.equal(fitHawkes(null, NOW), null);
  assert.equal(fitHawkes(simulatePoisson(3, 1), NaN), null);
  assert.equal(fitHawkes(simulatePoisson(3, 1), NOW, { windowDays: 0 }), null);
  assert.equal(fitHawkes(Array(50).fill(NOW - DAY), NOW), null);
  assert.equal(fitHawkes(simulatePoisson(3, 1).map((t) => t - 100 * DAY), NOW), null);
});

test('500 events fit well under 50 ms', () => {
  const times = simulateHawkes({ mu: 8, branching: 0.55, halfLifeHours: 3, seed: 21 }).slice(0, 500);
  while (times.length < 500) times.push(toMs((times.length % 300) / 10));
  fitHawkes(times, NOW);
  const runs = 20;
  const start = performance.now();
  for (let i = 0; i < runs; i += 1) fitHawkes(times, NOW);
  const each = (performance.now() - start) / runs;
  console.log(`fitHawkes, 500 events: ${each.toFixed(2)} ms`);
  assert.ok(each < 50, `${each} ms`);
});
