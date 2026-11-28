// Formulas of the analytics screen, in native MathML. They describe exactly what
// api/_dossier/math/atlas.js, network.js and comentions.js compute.
import type { Lang } from '../analytics/format';
import { h } from '../dom';
import { equation, frac, over, paren, row, sqrt, sub, subsup, sup, under, underover } from '../mathml';
import type { Term } from '../mathml';
import { texts } from './strings';

interface Block { ru: string; en: string; math: () => HTMLElement[] }

const total = (index: Term) => under('∑', index);

const TABLE: Block[] = [
  {
    ru: 'VaR — квантиль уровня 1 − α дневных доходностей за год (в долях потерь), ES — средняя потеря за этим квантилем.',
    en: 'VaR is the 1 − α quantile of one year of daily returns (as a loss), ES the mean loss beyond it.',
    math: () => [
      equation(sub('VaR', 'α'), '=', '−', sub('Q', row('1', '−', 'α')), paren('r')),
      equation(sub('ES', 'α'), '=', '−', 'E', '[', 'r', '∣', 'r', '≤', '−', sub('VaR', 'α'), ']'),
    ],
  },
  {
    ru: 'Шарп без безрисковой ставки, бета и альфа — регрессия на индекс своей биржи по дневным доходностям.',
    en: 'Sharpe without a risk-free rate; beta and alpha from a daily regression on the home index.',
    math: () => [
      equation('S', '=', frac(over('r', '¯'), 's'), '·', sqrt('252')),
      equation(sub('r', 't'), '=', 'α', '+', 'β', '·', sub('m', 't'), '+', sub('ε', 't')),
    ],
  },
  {
    ru: 'Кальмар — годовой темп роста, делённый на модуль максимальной просадки. Амихуд — среднее движение цены в процентах на миллиард долларов оборота (V), 60 сессий.',
    en: 'Calmar is yearly growth over the absolute maximum drawdown. Amihud is the mean price move in percent per $1bn traded (V), 60 sessions.',
    math: () => [
      equation('Calmar', '=', frac('g', row('|', 'MDD', '|'))),
      equation('A', '=', frac('1', 'T'), total('t'), frac(row('|', sub('r', 't'), '|'), row(sub('V', 't'), '/', sup('10', '9')))),
    ],
  },
];

const NETWORK: Block[] = [
  {
    ru: 'Корреляция Пирсона логарифмических доходностей по общим датам (не менее 60 дней или 26 недель) и расстояние Мантеньи. Минимальное остовное дерево соединяет все узлы с наименьшей суммой расстояний.',
    en: 'Pearson correlation of log returns on common dates (at least 60 days or 26 weeks) and the Mantegna distance. The minimum spanning tree joins all nodes with the least total distance.',
    math: () => [
      equation(sub('ρ', 'ij'), '=', frac(row(total('t'), paren(sub('r', 'it'), '−', sub(over('r', '¯'), 'i')), paren(sub('r', 'jt'), '−', sub(over('r', '¯'), 'j'))), row(paren('T', '−', '1'), sub('s', 'i'), sub('s', 'j')))),
      equation(sub('d', 'ij'), '=', sqrt('2', paren('1', '−', sub('ρ', 'ij')))),
      equation('MST', '=', 'arg', 'min', total(row('(', 'i', ',', 'j', ')', '∈', 'T')), sub('d', 'ij')),
    ],
  },
  {
    ru: 'Степень k — число связей, сила s — сумма весов, плотность — доля имеющихся связей из возможных.',
    en: 'Degree k counts links, strength s sums their weights, density is the share of possible links present.',
    math: () => [
      equation(sub('s', 'i'), '=', total('j'), sub('w', 'ij')),
      equation('D', '=', frac(row('2', 'm'), row('n', paren('n', '−', '1')))),
    ],
  },
  {
    ru: 'PageRank: узел важен, если связан с важными (d = 0,85, N — узлы со связями, сумма по всем равна 1). Посредничество — доля кратчайших путей через узел. Близость — гармоническая, по числу шагов.',
    en: 'PageRank: a node matters when its neighbours do (d = 0.85, N = linked nodes, values sum to 1). Betweenness: share of shortest paths through the node. Closeness: harmonic, in hops.',
    math: () => [
      equation(sub('x', 'i'), '=', frac(row('1', '−', 'd'), 'N'), '+', 'd', total('j'), frac(sub('w', 'ij'), sub('s', 'j')), sub('x', 'j')),
      equation(sub('B', 'i'), '=', frac('2', row(paren('n', '−', '1'), paren('n', '−', '2'))), total(row('s', '<', 't')), frac(row(sub('σ', 'st'), paren('i')), sub('σ', 'st'))),
      equation(sub('H', 'i'), '=', frac('1', row('n', '−', '1')), total(row('j', '≠', 'i')), frac('1', sub('h', 'ij'))),
    ],
  },
  {
    ru: 'Кластеризация — доля связанных пар соседей (t — треугольники). Кластеры найдены методом Лувена, который увеличивает модулярность Q.',
    en: 'Clustering is the share of linked neighbour pairs (t = triangles). Clusters come from the Louvain method, which raises the modularity Q.',
    math: () => [
      equation(sub('C', 'i'), '=', frac(row('2', sub('t', 'i')), row(sub('k', 'i'), paren(sub('k', 'i'), '−', '1')))),
      equation('Q', '=', frac('1', row('2', 'W')), total(row('i', ',', 'j')), paren(sub('w', 'ij'), '−', frac(row(sub('s', 'i'), sub('s', 'j')), row('2', 'W'))), 'δ', paren(sub('c', 'i'), ',', sub('c', 'j'))),
    ],
  },
  {
    ru: 'Совместные упоминания: сюжет с k компаниями (от 2 до 8) добавляет паре вес 1/(k − 1). Жаккар — доля общих сюжетов, подъём — во сколько раз чаще, чем при независимости (N — все сюжеты).',
    en: 'Co-mentions: a story with k companies (2 to 8) adds 1/(k − 1) to each pair. Jaccard is the share of joint stories, lift the ratio to independence (N = all stories).',
    math: () => [
      equation(sub('w', 'ab'), '=', total(row('s', '∋', 'a', ',', 'b')), frac('1', row(sub('k', 's'), '−', '1'))),
      equation(sub('J', 'ab'), '=', frac(sub('n', 'ab'), row(sub('n', 'a'), '+', sub('n', 'b'), '−', sub('n', 'ab')))),
      equation(sub('L', 'ab'), '=', frac(row(sub('n', 'ab'), 'N'), row(sub('n', 'a'), sub('n', 'b')))),
    ],
  },
];

const PAIRS: Block[] = [
  {
    ru: 'Доверительный интервал корреляции через преобразование Фишера.',
    en: 'Confidence interval of a correlation through the Fisher transform.',
    math: () => [
      equation('z', '=', 'artanh', 'ρ'),
      equation(sub('ρ', '±'), '=', 'tanh', paren('z', '±', frac('1.96', sqrt('n', '−', '3')))),
    ],
  },
  {
    ru: 'Индекс региона: средний рост цен N компаний от общей начальной даты. Средняя корреляция региона — среднее по всем парам.',
    en: 'Region index: mean price growth of N companies from a common start. Region correlation is the mean over all pairs.',
    math: () => [
      equation(sub('I', 't'), '=', frac('100', 'N'), underover('∑', row('i', '=', '1'), 'N'), frac(sub('P', 'it'), sub('P', 'i0'))),
      equation(sub(over('ρ', '¯'), 'AB'), '=', frac('1', subsup('n', 'AB', '*')), total(row('i', '∈', 'A', ',', 'j', '∈', 'B')), sub('ρ', 'ij')),
    ],
  },
];

const SETS = { table: TABLE, network: NETWORK, pairs: PAIRS };

/** A collapsed block with the formulas of one section, built when first opened. */
export function formulas(set: keyof typeof SETS, lang: Lang): HTMLElement {
  const body = h('div', { class: 'atl-formulas' });
  const el = h('details', { class: 'mbx-details atl-formula-box' }, h('summary', {}, texts(lang)('formulas')), body);
  el.addEventListener('toggle', () => {
    if (!el.open || body.childElementCount) return;
    body.append(...SETS[set].map((block) => h('div', { class: 'atl-formula' }, h('p', { class: 'mbx-note' }, block[lang]), ...block.math())));
  });
  return el;
}
