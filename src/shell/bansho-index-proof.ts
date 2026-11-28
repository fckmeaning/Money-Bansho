// The proof block of the instability index: the whole calculation of one country with its
// own numbers, a recomputation in the browser and the proven properties. Every statement
// here is checked by api/_dossier/math/instability-proofs.test.mjs and repeated in
// docs/math/instability.md.
import { equation, frac, gap, mn, mo, mtext, over, paren, row, sqrt, sub, subsup, sup, under } from '@/dossier/mathml';
import type { Term } from '@/dossier/mathml';
import { componentLabel, formatNumber } from '@/services/bansho-country-index';
import type { AggregateProof, IndexCountry, IndexLang, IndexPayload, PosteriorProof } from '@/services/bansho-country-index';
import { el, table } from './bansho-index-dom';

const Z90 = 1.6448536269514722;

// ---- independent recomputation -------------------------------------------------------
// Written from the formulas, not shared with the server: it starts from the z-scores, base
// weights, R, R^-1 and the minimiser y, and must arrive at the published numbers.

const logistic = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));
const clamp = (p: number) => Math.min(1 - 1e-12, Math.max(1e-12, p));
const dot = (a: number[], b: number[]) => a.reduce((t, x, i) => t + x * b[i]!, 0);

export interface Recomputed {
  powerMean: number;
  q: number;
  index: number | null;
  low: number | null;
  high: number | null;
  /** Largest violation of y >= z', P y >= 0 and (P y)(y - z') = 0. */
  kkt: number;
  /** Largest entry of |R P - identity|; null when the identity replaced R. */
  inverse: number | null;
}

export function recomputeIndex(a: AggregateProof, post: PosteriorProof | null, params: { softLimit: number; beta: number; power: number }): Recomputed {
  const c = params.softLimit;
  const soft = a.z.map((z) => c * Math.asinh(z / c));
  const t4 = (t: number) => {
    const q = 1 + (t * t) / 4;
    return 0.5 + 0.375 * (t / Math.sqrt(q)) * (1 - (t * t) / (12 * q));
  };
  const scores = soft.map((t) => 100 * t4(t));
  const raw = a.base.map((w, i) => w / a.R[i]!.reduce((t, r) => t + Math.max(r, 0), 0));
  const total = raw.reduce((x, y) => x + y, 0);
  const powerMean = raw.reduce((t, w, i) => t + (w / total) * scores[i]! ** params.power, 0) ** (1 / params.power);
  const gradient = a.precision.map((line) => dot(line, a.point));
  const stress = Math.sqrt(Math.max(dot(a.point, gradient), 0) / a.ids.length);
  const q = 100 * clamp(logistic(logit(clamp(powerMean / 100)) + params.beta * stress));
  const kkt = Math.max(0, ...gradient.map((g, i) => Math.max(
    soft[i]! - a.point[i]!,
    -g,
    Math.abs(g * (a.point[i]! - soft[i]!)),
  )));
  const inverse = a.identityFallback ? null : Math.max(...a.R.map((line, i) => Math.max(...a.precision.map((_, j) => (
    Math.abs(line.reduce((t, r, m) => t + r * a.precision[m]![j]!, 0) - (i === j ? 1 : 0))
  )))));
  if (!post) return { powerMean, q, index: null, low: null, high: null, kkt, inverse };
  const theta = logit(q / 100);
  const prior = post.prior;
  const v = post.sigma ** 2 + (prior ? (prior.tau2 * (1 - post.coverage)) / post.coverage : 0);
  const B = prior ? prior.tau2 / (prior.tau2 + v) : 1;
  const mean = prior ? prior.mean + B * (theta - prior.mean) : theta;
  const half = Z90 * Math.sqrt(B * v);
  return {
    powerMean,
    q,
    index: 100 * logistic(mean),
    low: 100 * logistic(mean - half),
    high: 100 * logistic(mean + half),
    kkt,
    inverse,
  };
}

// ---- rendering ------------------------------------------------------------------------

export function renderIndexProof(country: IndexCountry, data: IndexPayload, lang: IndexLang, open: Set<string>): HTMLElement {
  const box = el('details', 'bx-proof');
  const summary = el('summary', '', lang === 'ru'
    ? 'Расчёт по шагам и математические доказательства'
    : 'Step-by-step calculation and mathematical proofs');
  box.append(summary);
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    box.append(body(country, data, lang));
  };
  box.addEventListener('toggle', () => {
    if (box.open) {
      open.add(country.code);
      build();
    } else open.delete(country.code);
  });
  if (open.has(country.code)) {
    box.open = true;
    build();
  }
  return box;
}

function body(country: IndexCountry, data: IndexPayload, lang: IndexLang): HTMLElement {
  const L = (ru: string, en: string) => (lang === 'ru' ? ru : en);
  const a = country.proof.aggregate;
  const post = country.proof.posterior;
  const params = data.method.params;
  const root = el('div', 'bx-proof-body');
  const f = (value: number | null | undefined, digits = 4) => formatNumber(value, lang, digits);
  const N = (value: number, digits = 4): Term => mn(f(value, digits));
  /** A number that follows an operator: negative ones go in parentheses. */
  const P = (value: number, digits = 4): Term => (value < 0 ? paren(N(value, digits)) : N(value, digits));
  const h = (text: string) => root.append(el('h4', '', text));
  const p = (text: string, cls = 'bx-note') => root.append(el('p', cls, text));
  const eq = (...terms: Term[]) => root.append(equation(...terms));
  const name = (id: string) => componentLabel(data.components.find((d) => d.id === id)!, lang);
  const number = (id: string) => data.components.findIndex((d) => d.id === id) + 1;
  const labelled = (id: string) => `${number(id)}. ${name(id)}`;

  // Symbols shared by several formulas.
  const zi = () => sub('z', 'i');
  const soft = (index: Term = 'i') => sub(over('z', '~'), index);
  const wi = () => sub('w', 'i');
  const adj = (index: Term = 'i') => sub(over('w', '~'), index);
  const si = () => sub('s', 'i');
  const Lambda = (...terms: Term[]) => row('Λ', paren(...terms));
  const sum = (index: string): Term => under(mo('∑'), mtext(index));

  // 0. Inputs and normalisation.
  h(L('1. Входы и нормировка', '1. Inputs and normalisation'));
  p(L(
    `Рыночные признаки сравниваются с собственными ${params.referenceWindow} наблюдениями строго до последнего дня: m — медиана, s — 1,4826 · медианное абсолютное отклонение.`,
    `Market features are compared with their own ${params.referenceWindow} observations strictly before the last day: m is the median, s is 1.4826 times the median absolute deviation.`,
  ));
  eq(zi(), '=', frac(row(sub('x', 'i'), '−', sub('m', 'i')), sub('s', 'i')));
  for (const definition of data.components) {
    const part = country.components.find((c) => c.id === definition.id)!;
    const input = country.proof.inputs[definition.id];
    if (!input || part.score === null) {
      p(`${labelled(definition.id)}: ${f(null)} — ${(lang === 'ru' ? part.reason : part.reasonEn) ?? ''}. ${L('В расчёт не входит.', 'Not used in the calculation.')}`, 'bx-note bx-input');
      continue;
    }
    const z = a.z[a.ids.indexOf(definition.id)]!;
    const index = mn(String(number(definition.id)));
    if (input.kind === 'market') {
      const isLog = definition.id === 'eqVol' || definition.id === 'fxVol';
      const meaning = {
        eqVol: L('x = ln дневной условной волатильности', 'x = ln of the daily conditional volatility'),
        fxVol: L('x = ln дневной условной волатильности', 'x = ln of the daily conditional volatility'),
        eqDrawdown: L('x = доля падения от максимума за 126 дней', 'x = fraction below the 126-day high'),
        eqShock: L('x = падение за 5 дней в единицах σ, известной до него', 'x = 5-day fall in units of the volatility known before it'),
        fxDep: L('x = ослабление за 21 день в единицах σ, известной до него', 'x = 21-day depreciation in units of the volatility known before it'),
      }[definition.id] ?? 'x';
      p(`${labelled(definition.id)}. ${meaning}. ${L('Источник', 'Source')}: Yahoo Finance, ${input.symbol}, ${L('на', 'as of')} ${input.asOf}. ${L('Эталон', 'Reference')}: ${input.observations} ${L('наблюдений', 'observations')}, ${input.from} – ${input.to}.${input.meanDeviation ? L(' MAD = 0, взято 1,2533 · среднее абсолютное отклонение.', ' MAD = 0, so 1.2533 times the mean absolute deviation is used.') : ''}`, 'bx-note bx-input');
      eq(sub('z', index), '=', frac(row(N(input.x, 6), '−', P(input.median, 6)), N(input.scale, 6)), '=', N(z));
      if (isLog) p(`σ = exp(x) · √252 = ${f(Math.exp(input.x) * Math.sqrt(252) * 100, 2)} % ${L('годовых', 'annualised')}.`);
    } else if (input.kind === 'volume') {
      p(`${labelled(definition.id)}. ${L(
        `Перестановочный тест свежести по лентам: X — суммарная свежесть заголовков о стране, E и V — её ожидание и дисперсия при случайном порядке, φ — поправка на зависимость заголовков. Разных заголовков о стране: ${input.mentions}, за 24 часа ${input.recent}; в тесте участвуют ${input.comparable} (повтор заголовка в другой ленте считается и там).`,
        `Permutation test of recency across feeds: X is the total recency of the country's headlines, E and V its mean and variance under random order, φ the correction for dependent headlines. Distinct headlines about the country: ${input.mentions}, ${input.recent} within 24 hours; the test counts ${input.comparable} (a headline repeated in another feed counts there too).`,
      )}`, 'bx-note bx-input');
      eq(sub('z', index), '=', frac(row('X', '−', 'E'), row(sqrt('V'), '·', 'φ')), '=',
        frac(row(N(input.observed), '−', N(input.expected)), row(sqrt(N(input.variance)), '·', N(input.phi))), '=', N(z));
    } else {
      p(`${labelled(definition.id)}. ${L(
        `q — доля негативных заголовков с весом свежести (${input.negative} из ${input.mentions} негативные), n — эффективное число по Кишу, p₀ — доля по всему корпусу, c и d — центр и разброс между странами.`,
        `q is the recency-weighted share of negative headlines (${input.negative} of ${input.mentions} are negative), n the Kish effective count, p₀ the share over the whole corpus, c and d the cross-country centre and spread.`,
      )}`, 'bx-note bx-input');
      eq(over('p', '~'), '=', frac(row('n', 'q', '+', mn(String(input.strength)), sub('p', mn('0'))), row('n', '+', mn(String(input.strength)))), '=',
        frac(row(N(input.effective, 2), '·', N(input.share), '+', mn(String(input.strength)), '·', N(input.pooled)), row(N(input.effective, 2), '+', mn(String(input.strength)))), '=', N(input.shrunk));
      eq(sub('z', index), '=', frac(row(over('p', '~'), '−', 'c'), 'd'), '=', frac(row(N(input.shrunk), '−', N(input.centre)), N(input.scale)), '=', N(z));
    }
  }

  if (!a.published) {
    h(L('2. Покрытие недостаточно', '2. Coverage is too low'));
    eq('C', '=', sum('i ∈ N'), wi(), '=', N(a.coverage, 2), '<', N(params.minCoverage, 2));
    p(L(
      'Доступные компоненты покрывают меньше четверти базового веса, поэтому ни агрегат, ни индекс не вычисляются. Отсутствующие значения ничем не заменяются.',
      'The available components cover less than a quarter of the base weight, so neither the aggregate nor the index is computed. Missing values are not replaced by anything.',
    ));
    theorems(root, null);
    return root;
  }

  const k = a.ids.length;

  // 2. Component scores.
  h(L('2. Балл компонента', '2. Component score'));
  eq(soft(), '=', mn(String(params.softLimit)), 'asinh', paren(frac(zi(), mn(String(params.softLimit)))), mo(','), si(), '=', mn('100'), sub('T', mn('4')), paren(soft()));
  eq(sub('T', mn('4')), paren('t'), '=', frac(mn('1'), mn('2')), '+', frac(mn('3'), mn('8')), '·',
    frac('t', sqrt(mn('1'), '+', frac(sup('t', mn('2')), mn('4')))),
    paren(mn('1'), '−', frac(sup('t', mn('2')), row(mn('12'), paren(mn('1'), '+', frac(sup('t', mn('2')), mn('4')))))));
  p(L('T₄ — функция распределения Стьюдента с 4 степенями свободы.', 'T₄ is the Student distribution function with 4 degrees of freedom.'));
  root.append(table(
    [L('Компонент', 'Component'), 'z', 'z̃', L('Балл s', 'Score s')],
    a.ids.map((id, i) => [labelled(id), f(a.z[i]), f(a.soft[i]), f(a.scores[i])]),
  ));

  // 3. Weights and the power mean.
  h(L('3. Веса без двойного счёта и среднее степени 2', '3. Redundancy-adjusted weights and the power mean of order 2'));
  eq(sub('r', 'i'), '=', sum('j'), 'max', paren(sub('R', 'ij'), mo(','), mn('0')), mo(','), adj(), '=',
    frac(row(wi(), '/', sub('r', 'i')), row(sum('j'), sub('w', 'j'), '/', sub('r', 'j'))));
  eq('M', '=', sqrt(sum('i'), adj(), subsup('s', 'i', mn('2'))));
  const parts = a.weights.map((w, i) => w * a.scores[i]! ** params.power);
  root.append(table(
    [L('Компонент', 'Component'), 'w', 'r', 'w̃', 'w̃ · s²'],
    [
      ...a.ids.map((id, i) => [labelled(id), f(a.base[i], 2), f(a.rowSums[i]), f(a.weights[i]), f(parts[i], 2)]),
      [L('Сумма', 'Sum'), f(a.coverage, 2), '', f(a.weights.reduce((x, y) => x + y, 0)), f(parts.reduce((x, y) => x + y, 0), 2)],
    ],
  ));
  eq('M', '=', sqrt(N(parts.reduce((x, y) => x + y, 0), 2)), '=', N(a.powerMean));
  p(L('Корреляции R доступных компонентов (после сжатия к единичной матрице):', 'Correlations R of the available components (after shrinkage towards the identity):'));
  const numbers = a.ids.map((id) => String(number(id)));
  root.append(table(['R', ...numbers], a.R.map((line, i) => [numbers[i]!, ...line.map((v) => f(v, 3))])));
  const { marketShrinkage, newsShrinkage } = data.method.correlation;
  p(L(
    `Интенсивность сжатия: рынок λ = ${f(marketShrinkage, 3)}, новости λ = ${f(newsShrinkage, 3)}. Связи «рынок — новости» приняты нулевыми.`,
    `Shrinkage intensity: market λ = ${f(marketShrinkage, 3)}, news λ = ${f(newsShrinkage, 3)}. Market-news correlations are set to zero.`,
  ));

  // 4. One-sided stress.
  h(L('4. Односторонний стресс', '4. One-sided stress'));
  eq(sup('D', mn('2')), '=', under('min', row('y', '≥', over('z', '~'))), sup('y', mtext('T')), 'P', 'y', mo(','), 'P', '=', sup('R', mn('−1')));
  if (a.identityFallback) {
    p(L('Матрица R здесь не положительно определена, поэтому вместо неё взята единичная: P = E.', 'R is not positive definite here, so the identity replaces it: P = E.'));
  }
  const products = a.point.map((y, i) => y * a.gradient[i]!);
  root.append(table(
    [L('Компонент', 'Component'), 'z̃', 'y*', 'g = P y*', 'y* − z̃', 'g · (y* − z̃)'],
    a.ids.map((id, i) => [
      labelled(id), f(a.soft[i]), f(a.point[i]), f(a.gradient[i], 6), f(a.point[i]! - a.soft[i]!, 6),
      f(a.gradient[i]! * (a.point[i]! - a.soft[i]!), 6),
    ]),
  ));
  eq(sup('D', mn('2')), '=', sum('i'), subsup('y', 'i', mo('*')), sub('g', 'i'), '=', N(products.reduce((x, y) => x + y, 0), 6));
  eq(frac('D', sqrt('k')), '=', frac(N(a.distance, 6), sqrt(mn(String(k)))), '=', N(a.stress, 6));

  // 5. Aggregate.
  h(L('5. Агрегат Q', '5. Aggregate Q'));
  eq('Q', '=', mn('100'), Lambda('ln', frac('M', row(mn('100'), '−', 'M')), '+', N(params.beta, 2), '·', frac('D', sqrt('k'))), mo(','), 'Λ', paren('x'), '=', frac(mn('1'), row(mn('1'), '+', sup('e', row(mo('−'), 'x')))));
  const base = logit(clamp(a.powerMean / 100));
  eq('Q', '=', mn('100'), Lambda(N(base, 6), '+', N(params.beta, 2), '·', N(a.stress, 6)), '=', N(a.q));

  // 6. Shrinkage and interval.
  h(L('6. Байесовское сжатие и 90 % интервал', '6. Bayesian shrinkage and the 90% interval'));
  if (!post) {
    p(L('Ошибка выборки по этим данным не оценивается, поэтому индекс и интервал: нет данных.', 'The sampling error cannot be estimated from these data, so the index and interval are: no data.'));
  } else {
    const prior = post.prior;
    p(L(
      `σ — стандартная ошибка θ по ${post.draws} повторам бутстрэпа с фиксированным зерном. ${prior ? `μ и τ² — среднее и разброс θ между ${prior.countries} странами с покрытием не ниже половины.` : 'Стран для априорного распределения меньше пяти: сжатие не применяется, B = 1.'}`,
      `σ is the standard error of θ over ${post.draws} seeded bootstrap draws. ${prior ? `μ and τ² are the mean and spread of θ across ${prior.countries} countries covered by at least half of the weight.` : 'Fewer than five countries are available for a prior: no shrinkage, B = 1.'}`,
    ));
    eq('θ', '=', 'ln', frac('Q', row(mn('100'), '−', 'Q')), '=', N(post.theta, 6), mo(','), 'σ', '=', N(post.sigma, 6), mo(','), 'C', '=', N(post.coverage, 2));
    if (prior) {
      eq('μ', '=', N(prior.mean, 6), mo(','), sup('τ', mn('2')), '=', N(prior.tau2, 6));
      eq('v', '=', sup('σ', mn('2')), '+', sup('τ', mn('2')), frac(row(mn('1'), '−', 'C'), 'C'), '=',
        sup(P(post.sigma, 6), mn('2')), '+', N(prior.tau2, 6), '·', frac(row(mn('1'), '−', N(post.coverage, 2)), N(post.coverage, 2)), '=', N(post.variance, 6));
      eq('B', '=', frac(sup('τ', mn('2')), row(sup('τ', mn('2')), '+', 'v')), '=', frac(N(prior.tau2, 6), row(N(prior.tau2, 6), '+', N(post.variance, 6))), '=', N(post.reliability, 6));
      eq('I', '=', mn('100'), Lambda('μ', '+', 'B', paren('θ', '−', 'μ')), '=', mn('100'),
        Lambda(N(prior.mean, 6), '+', N(post.reliability, 6), paren(N(post.theta, 6), '−', P(prior.mean, 6))), '=', N(post.index));
    } else {
      eq('v', '=', sup('σ', mn('2')), '=', N(post.variance, 6), mo(','), 'B', '=', mn('1'), mo(','), 'I', '=', mn('100'), Lambda('θ'), '=', N(post.index));
    }
    eq(mo('['), sub('I', mtext(L('низ', 'low'))), mo(';'), sub('I', mtext(L('верх', 'high'))), mo(']'), '=', mn('100'),
      Lambda(N(post.mean, 6), '∓', N(Z90, 4), sqrt(N(post.reliability, 4), '·', N(post.variance, 4))), '=',
      mo('['), N(post.low), mo(';'), N(post.high), mo(']'));
  }

  // 7. Recomputation in the browser.
  h(L('7. Проверка: пересчёт в браузере', '7. Check: recomputation in the browser'));
  const again = recomputeIndex(a, post, params);
  const contributions = country.components.reduce((t, c) => t + (c.contribution ?? 0), 0);
  const compare = (label: string, mine: number | null, shown: number | null) => [
    label, f(mine, 6), f(shown, 6), mine === null || shown === null ? f(null) : f(Math.abs(mine - shown), 6),
  ];
  root.append(table(
    [L('Величина', 'Quantity'), L('Пересчитано здесь', 'Recomputed here'), L('Показано', 'Published'), L('Расхождение', 'Difference')],
    [
      compare('M', again.powerMean, a.powerMean),
      compare('Q', again.q, a.q),
      compare(L('50 + Σ вкладов (= Q)', '50 + Σ contributions (= Q)'), country.index === null ? null : 50 + contributions, country.aggregate),
      compare('I', again.index, country.index),
      compare(L('Нижняя граница', 'Lower bound'), again.low, country.low),
      compare(L('Верхняя граница', 'Upper bound'), again.high, country.high),
    ],
  ));
  const small = (value: number) => (lang === 'ru' ? value.toExponential(1).replace('.', ',') : value.toExponential(1));
  p(L(
    `Условия оптимальности D выполнены с отклонением не более ${small(again.kkt)}; ${again.inverse === null ? 'вместо R взята единичная матрица' : `max |R·P − E| = ${small(again.inverse)}`}. Вклады и показанные числа округлены сервером до 6 знаков.`,
    `The optimality conditions of D hold within ${small(again.kkt)}; ${again.inverse === null ? 'the identity replaced R' : `max |R·P − E| = ${small(again.inverse)}`}. The server rounds contributions and published numbers to 6 digits.`,
  ));

  // 8. Contributions.
  h(L('8. Вклады компонентов (значения Шепли)', '8. Component contributions (Shapley values)'));
  eq(sub('φ', 'i'), '=', under(mo('∑'), row('S', '⊆', 'N', '∖', mo('{'), 'i', mo('}'))),
    frac(row(mo('|'), 'S', mo('|'), mo('!'), paren('k', '−', mo('|'), 'S', mo('|'), '−', mn('1')), mo('!')), row('k', mo('!'))),
    mo('['), 'v', paren('S', '∪', mo('{'), 'i', mo('}')), '−', 'v', paren('S'), mo(']'));
  p(L(
    `v(S) — агрегат Q, в котором компоненты вне S поставлены в z = 0 при тех же весах и R. Здесь k = ${k}, подмножеств ${2 ** k}, v(∅) = 50.`,
    `v(S) is the aggregate Q with the components outside S set to z = 0, weights and R unchanged. Here k = ${k}, ${2 ** k} subsets, v(∅) = 50.`,
  ));
  if (country.index === null || country.aggregate === null || country.shrinkage === null) {
    p(L('Индекс не опубликован, вклады не показываются.', 'No index is published, so no contributions are shown.'));
  } else {
    eq(sum('i'), sub('φ', 'i'), '=', N(contributions), mo(','), 'Q', '−', mn('50'), '=', N(country.aggregate - 50));
    eq('I', '=', mn('50'), '+', sum('i'), sub('φ', 'i'), '+', paren('I', '−', 'Q'), '=', mn('50'), '+', P(contributions), '+', P(country.shrinkage), '=', N(country.index));
  }

  // 9. Weight sensitivity.
  h(L('9. Чувствительность к весам', '9. Sensitivity to the weights'));
  const s = a.sensitivity;
  eq(frac(row('∂', 'Q'), row('∂', wi())), '=', frac(row('q', paren(mn('1'), '−', 'q')), row('m', paren(mn('1'), '−', 'm'))), '·',
    frac(row(adj(), paren(subsup('s', 'i', 'p'), '−', sup('M', 'p'))), row('p', wi(), sup('M', row('p', '−', mn('1'))))));
  p(L('q = Q/100, m = M/100, p = 2. Базовые веса экспертные, поэтому показано, насколько от них зависит результат.', 'q = Q/100, m = M/100, p = 2. The base weights are expert choices, so their influence on the result is shown.'));
  root.append(table(
    [L('Компонент', 'Component'), L('Изменение Q при +0,01 к весу', 'Change of Q for +0.01 of weight'), L('Q без компонента', 'Q without it'), L('Разность', 'Difference')],
    a.ids.map((id, i) => {
      const without = s.leaveOneOut[i] ?? null;
      return [
        labelled(id), f(s.derivative[i]! * 0.01),
        without === null ? L('нет данных: остаётся меньше 25 % веса', 'no data: under 25% of weight remains') : f(without),
        without === null ? '—' : f(without - a.q),
      ];
    }),
  ));
  eq(sum('i'), wi(), frac(row('∂', 'Q'), row('∂', wi())), '=', N(s.derivative.reduce((t, d, i) => t + d * a.base[i]!, 0), 6));
  const shrunk = (q: number) => {
    if (!post) return null;
    const theta = logit(clamp(q / 100));
    return 100 * logistic(post.prior ? post.prior.mean + post.reliability * (theta - post.prior.mean) : theta);
  };
  const range = (bounds: [number, number]) => `Q ∈ [${f(bounds[0])}; ${f(bounds[1])}]${post ? `, I ∈ [${f(shrunk(bounds[0]))}; ${f(shrunk(bounds[1]))}]` : ''}`;
  p(L(`Каждый вес изменён не более чем на ${f(s.delta * 100, 0)} % (точные крайние значения): ${range(s.range)}.`, `Every weight moved by at most ${f(s.delta * 100, 0)}% (exact extremes): ${range(s.range)}.`), 'bx-result');
  p(L(`Любые положительные веса: ${range(s.anyWeights)}.`, `Any positive weights: ${range(s.anyWeights)}.`), 'bx-result');
  p(L('Диапазоны I получены при неизменных C, σ, μ и τ².', 'The ranges of I keep C, σ, μ and τ² fixed.'));

  theorems(root, { a, post, contributions, country });
  return root;

  // 10. Proven properties.
  function theorems(
    target: HTMLElement,
    own: { a: AggregateProof; post: PosteriorProof | null; contributions: number; country: IndexCountry } | null,
  ): void {
    target.append(el('h4', '', L('Доказанные свойства', 'Proven properties')));
    const theorem = (title: string, statement: Term[][], proof: string, here: string | null) => {
      const block = el('div', 'bx-theorem');
      block.append(el('h5', '', title));
      for (const line of statement) block.append(equation(...line));
      block.append(el('p', '', `${L('Доказательство', 'Proof')}. ${proof}`));
      if (here) block.append(el('p', 'bx-result', `${L('Для этой страны', 'For this country')}: ${here}`));
      target.append(block);
    };
    const v = own?.a;

    theorem(
      L('Теорема 1. Ограниченность', 'Theorem 1. Boundedness'),
      [
        [mn('0'), '<', si(), '<', mn('100'), mo(','), 'min', si(), '≤', 'M', '≤', 'max', si()],
        [mn('0'), '<', 'M', '≤', 'Q', '<', mn('100'), mo(','), mn('0'), '≤', sub('I', mtext(L('низ', 'low'))), '≤', 'I', '≤', sub('I', mtext(L('верх', 'high'))), '≤', mn('100')],
      ],
      L(
        'T₄ — функция распределения, её значения лежат строго между 0 и 1. Веса положительны (r_i ≥ R_ii = 1) и в сумме дают 1, значит M² — выпуклая комбинация s_i². D ≥ 0, коэффициент при D положителен, Λ возрастает, поэтому Q ≥ M. Значения Λ лежат в (0; 1), полуширина интервала неотрицательна. В коде аргумент logit и Q ограничены отрезком [10⁻¹²; 1 − 10⁻¹²] (в долях), так что M ≤ Q выполняется с точностью 10⁻⁹.',
        'T₄ is a distribution function, strictly between 0 and 1. The weights are positive (r_i ≥ R_ii = 1) and add to 1, so M² is a convex combination of s_i². D ≥ 0, its coefficient is positive and Λ increases, hence Q ≥ M. Λ takes values in (0, 1) and the half-width of the interval is non-negative. The code keeps the logit argument and Q inside [10⁻¹², 1 − 10⁻¹²] (as fractions), so M ≤ Q holds to within 10⁻⁹.',
      ),
      v?.published ? `${f(Math.min(...v.scores))} ≤ M = ${f(v.powerMean)} ≤ ${f(Math.max(...v.scores))}; M ≤ Q = ${f(v.q)}${own?.post ? `; ${f(own.post.low)} ≤ ${f(own.post.index)} ≤ ${f(own.post.high)}` : ''}.` : null,
    );

    theorem(
      L('Теорема 2. Монотонность по каждому компоненту', 'Theorem 2. Monotonicity in every component'),
      [
        [subsup('z', 'i', mo('′')), '>', zi(), '⇒', subsup('s', 'i', mo('′')), '>', si(), mo(','), sup('M', mo('′')), '>', 'M', mo(','), sup('D', mo('′')), '≥', 'D', mo(','), sup('Q', mo('′')), '>', 'Q'],
        [frac(row('∂', 'I'), row('∂', 'θ')), mo('>'), mn('0'), gap(), mtext(L('при неизменных σ, C, μ, τ²', 'with σ, C, μ, τ² fixed'))],
      ],
      L(
        'Условие: набор компонентов, R и веса неизменны. z̃ = 3·asinh(z/3) строго возрастает, производная T₄ — плотность, она положительна: растёт s_i, а с ним M. При z′ ≥ z любое y ≥ z̃′ удовлетворяет и y ≥ z̃: минимум для z берётся по большему множеству, значит D(z) ≤ D(z′). I = 100·Λ(μ + B(θ − μ)), B > 0. Наблюдение входит в z как (x − m)/s с s > 0, поэтому при неизменном эталоне то же верно и по x. Чего это не означает: при пересчёте на новых данных меняются эталон, R, μ, τ² и σ (с ним B), и монотонность индекса тогда не гарантируется. В арифметике с плавающей точкой при огромных |z| строгое неравенство может стать равенством.',
        'Condition: the component set, R and the weights are fixed. z̃ = 3·asinh(z/3) increases strictly and the derivative of T₄ is a positive density, so s_i rises and M with it. If z′ ≥ z, every y ≥ z̃′ also satisfies y ≥ z̃: the minimum for z runs over a larger set, hence D(z) ≤ D(z′). I = 100·Λ(μ + B(θ − μ)) with B > 0. An observation enters as (x − m)/s with s > 0, so the same holds in x for a fixed reference. What this does not claim: when new data arrive the reference, R, μ, τ² and σ (hence B) change, and monotonicity of the index is then not guaranteed. In floating point a strict inequality may become equality for huge |z|.',
      ),
      null,
    );

    theorem(
      L('Теорема 3. Поведение при пропущенных данных', 'Theorem 3. Behaviour with missing data'),
      [
        ['C', '=', sum('i ∈ N'), wi(), mo(','), 'C', '<', N(params.minCoverage, 2), '⇒', mtext(L('нет индекса', 'no index'))],
        ['B', '=', frac(mn('1'), row(mn('1'), '/', 'C', '+', sup('σ', mn('2')), '/', sup('τ', mn('2')))), '≤', 'C', mo(','), mo('|'), sub('θ', 'I'), '−', 'μ', mo('|'), '≤', 'C', mo('|'), 'θ', '−', 'μ', mo('|')],
        [mtext(L('полуширина', 'half-width')), '=', N(Z90, 4), 'τ', sqrt(mn('1'), '−', 'B')],
      ],
      L(
        'Отсутствующий компонент не входит ни в M, ни в D и ничем не заменяется; веса нормируются по доступным. Из v = σ² + τ²(1 − C)/C следует τ² + v = τ²/C + σ², откуда формула для B и B ≤ C: собственные данные страны весят не больше её покрытия. logit(I/100) = θ_I = μ + B(θ − μ). Далее B·v = τ²(1 − B), поэтому чем меньше C, тем меньше B и шире интервал (на шкале logit). Всё это при неизменных θ, σ, μ, τ²; сам индекс при пропаже компонента может и вырасти, и упасть. Без априорного распределения (меньше пяти стран) B = 1 и это свойство не действует.',
        'A missing component enters neither M nor D and is not replaced by anything; the weights are renormalised over the available ones. From v = σ² + τ²(1 − C)/C follows τ² + v = τ²/C + σ², which gives the formula for B and B ≤ C: a country\'s own data weigh at most its coverage. logit(I/100) = θ_I = μ + B(θ − μ). Also B·v = τ²(1 − B), so a smaller C means a smaller B and a wider interval (on the logit scale). All this with θ, σ, μ, τ² fixed; the index itself may rise or fall when a component disappears. Without a prior (fewer than five countries) B = 1 and this property does not apply.',
      ),
      own?.post?.prior
        ? `C = ${f(own.post.coverage, 2)}, B = ${f(own.post.reliability)} ≤ C.`
        : v ? `C = ${f(v.coverage, 2)}.` : null,
    );

    theorem(
      L('Теорема 4. Чувствительность к весам', 'Theorem 4. Sensitivity to the weights'),
      [
        [sum('i'), wi(), frac(row('∂', 'Q'), row('∂', wi())), '=', mn('0')],
        ['Q', paren('min', si()), '≤', 'Q', paren('w'), '≤', 'Q', paren('max', si()), gap(), mtext(L('для любых w > 0', 'for any w > 0'))],
      ],
      L(
        'Здесь Q(s) = 100·Λ(logit(s/100) + 0,25·D/√k). D не зависит от весов, поэтому Q зависит от них только через M^p = Σ(w_i/r_i)·s_i^p / Σ(w_i/r_i). Дифференцирование даёт ∂M^p/∂w_i = (w̃_i/w_i)(s_i^p − M^p); после умножения на w_i и суммирования получается M^p − M^p = 0. При любых положительных весах M^p остаётся выпуклой комбинацией s_i^p. Отношение двух линейных функций с положительным знаменателем монотонно по каждому весу, поэтому крайние значения в коробке ±20 % достигаются в её 2^k вершинах, и все они перебраны. Изменение покрытия C при смене весов здесь не учитывается.',
        'Here Q(s) = 100·Λ(logit(s/100) + 0.25·D/√k). D does not depend on the weights, so Q depends on them only through M^p = Σ(w_i/r_i)·s_i^p / Σ(w_i/r_i). Differentiation gives ∂M^p/∂w_i = (w̃_i/w_i)(s_i^p − M^p); multiplied by w_i and summed it is M^p − M^p = 0. For any positive weights M^p stays a convex combination of s_i^p. A ratio of two linear functions with a positive denominator is monotone in each weight, so the extremes over the ±20% box are attained at its 2^k vertices, all of which are enumerated. The change of coverage C caused by other weights is not included here.',
      ),
      v?.published ? `${f(v.sensitivity.anyWeights[0])} ≤ Q = ${f(v.q)} ≤ ${f(v.sensitivity.anyWeights[1])}.` : null,
    );

    theorem(
      L('Теорема 5. Вклады складываются без остатка', 'Theorem 5. The contributions add up exactly'),
      [
        [sum('i'), sub('φ', 'i'), '=', 'Q', '−', mn('50')],
        [zi(), '=', mn('0'), '⇒', sub('φ', 'i'), '=', mn('0'), mo(','), zi(), sub('φ', 'i'), '≥', mn('0')],
      ],
      L(
        'Для любого порядка добавления компонентов сумма приращений v телескопически равна v(N) − v(∅); φ — их среднее по всем k! порядкам. v(∅) = 50, так как при всех z = 0 имеем s = 50, M = 50, D = 0. Если z_i = 0, добавление компонента ничего не меняет. По теореме 2 приращение v(S ∪ {i}) − v(S) имеет знак z_i или равно нулю.',
        'For any order of adding the components the increments of v telescope to v(N) − v(∅); φ is their average over all k! orders. v(∅) = 50 because with every z = 0 we have s = 50, M = 50, D = 0. If z_i = 0 adding the component changes nothing. By Theorem 2 the increment v(S ∪ {i}) − v(S) has the sign of z_i or is zero.',
      ),
      own && own.country.aggregate !== null ? `Σφ = ${f(own.contributions)}, Q − 50 = ${f(own.country.aggregate - 50)}.` : null,
    );

    theorem(
      L('Теорема 6. Найденный D — настоящий минимум', 'Theorem 6. The computed D is the true minimum'),
      [
        [sup('y', mo('*')), '≥', over('z', '~'), mo(','), 'g', '=', 'P', sup('y', mo('*')), '≥', mn('0'), mo(','), sub('g', 'i'), paren(subsup('y', 'i', mo('*')), '−', soft()), '=', mn('0')],
        ['D', '=', mn('0'), '⇔', mtext(L('все ', 'all ')), zi(), '≤', mn('0')],
      ],
      L(
        'P положительно определена (обратная к R или единичная), f(y) = yᵀPy выпукла: f(y) ≥ f(y*) + 2g·(y − y*). Для допустимого y ≥ z̃ имеем g·(y − y*) = g·(y − z̃) − g·(y* − z̃) = g·(y − z̃) ≥ 0, значит f(y) ≥ f(y*). Если все z ≤ 0, то y = 0 допустимо и D = 0; если D = 0, то y* = 0, а y* ≥ z̃. Числа g и g·(y* − z̃) для проверки даны в таблице шага 4 и равны нулю с точностью решения.',
        'P is positive definite (the inverse of R, or the identity), so f(y) = yᵀPy is convex: f(y) ≥ f(y*) + 2g·(y − y*). For a feasible y ≥ z̃ we have g·(y − y*) = g·(y − z̃) − g·(y* − z̃) = g·(y − z̃) ≥ 0, hence f(y) ≥ f(y*). If all z ≤ 0 then y = 0 is feasible and D = 0; if D = 0 then y* = 0 while y* ≥ z̃. The numbers g and g·(y* − z̃) are in the table of step 4 and vanish to the accuracy of the solver.',
      ),
      v?.published ? `D = ${f(v.distance, 6)}.` : null,
    );

    target.append(el('h4', '', L('Неопределённость и то, что не доказано', 'Uncertainty and what is not proven')));
    const list = el('ul', 'bx-limits');
    for (const text of [
      L('Интервал учитывает перевыборку эталона (блоками по 20 дней), шум объёма новостей, биномиальный разброс тона и разброс весов 20 %. Он не учитывает ошибки поставщиков данных, выбор p и β, неопределённость R, μ, τ², параметров GARCH, поэтому занижает полную неопределённость.', 'The interval covers resampling of the reference (20-day blocks), noise of the news volume, binomial spread of the tone and a 20% spread of the weights. It does not cover data vendor errors, the choice of p and β, or the uncertainty of R, μ, τ² and the GARCH parameters, so it understates the total uncertainty.'),
      L('Базовые веса, степень p = 2 и коэффициент 0,25 экспертные и на истории не подбирались.', 'The base weights, the power p = 2 and the coefficient 0.25 are expert choices, not fitted on history.'),
      L('Доказанные свойства относятся к формуле. Они не говорят, что индекс предсказывает кризисы: это не проверялось.', 'The proven properties concern the formula. They do not show that the index predicts crises: that has not been tested.'),
    ]) list.append(el('li', '', text));
    target.append(list);
  }
}
