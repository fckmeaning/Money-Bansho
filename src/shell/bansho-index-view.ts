// One country of the Money Bansho instability index: value, components, history and the
// proof block. Shared by the country panel and the ranking section of the dashboard.
import {
  componentLabel, confidenceName, countryName, formatNumber, instrumentName, loadCountryIndex,
  scoreBand, INDEX_POLL_MS,
} from '@/services/bansho-country-index';
import type { IndexCountry, IndexInstrument, IndexLang, IndexPayload } from '@/services/bansho-country-index';
import { el, table } from './bansho-index-dom';
import { renderIndexProof } from './bansho-index-proof';
import './bansho-index.css';

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number>, text = ''): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text) node.textContent = text;
  return node;
}

export function lineChart(
  points: [string, number][],
  lang: IndexLang,
  options: { label: string; min?: number; max?: number; midline?: number },
): HTMLElement {
  const box = el('div', 'bx-chart');
  if (points.length < 2) {
    box.append(el('p', 'bx-note', `${options.label}: ${formatNumber(null, lang)}`));
    return box;
  }
  const W = 760;
  const H = 260;
  const left = 38;
  const bottom = 22;
  const values = points.map((p) => p[1]);
  const min = options.min ?? Math.min(...values);
  const max = options.max ?? Math.max(...values);
  const x = (i: number) => left + (i / (points.length - 1)) * (W - left - 6);
  const y = (v: number) => 8 + (1 - (v - min) / (max - min || 1)) * (H - bottom - 8);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': options.label });
  for (let i = 0; i <= 4; i += 1) {
    const v = min + ((max - min) * i) / 4;
    root.append(
      svg('line', { x1: left, x2: W - 6, y1: y(v), y2: y(v), class: 'bx-grid' }),
      svg('text', { x: left - 5, y: y(v) + 3, class: 'bx-axis', 'text-anchor': 'end' }, formatNumber(v, lang, max - min < 5 ? 2 : 0)),
    );
  }
  if (options.midline !== undefined) {
    root.append(svg('line', { x1: left, x2: W - 6, y1: y(options.midline), y2: y(options.midline), class: 'bx-midline' }));
  }
  for (const i of [0, Math.floor((points.length - 1) / 2), points.length - 1]) {
    const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
    root.append(svg('text', { x: x(i), y: H - 6, class: 'bx-axis', 'text-anchor': anchor }, points[i]![0]));
  }
  root.append(svg('polyline', { points: points.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' '), class: 'bx-line' }));
  const cursor = svg('line', { y1: 8, y2: H - bottom, class: 'bx-cursor', visibility: 'hidden' });
  root.append(cursor);
  const last = points[points.length - 1]!;
  const readout = el('div', 'bx-readout', `${last[0]}: ${formatNumber(last[1], lang)}`);
  root.addEventListener('pointermove', (event) => {
    const rect = root.getBoundingClientRect();
    const position = ((event as PointerEvent).clientX - rect.left) * (W / rect.width);
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((position - left) / (W - left - 6)) * (points.length - 1))));
    cursor.setAttribute('x1', String(x(i)));
    cursor.setAttribute('x2', String(x(i)));
    cursor.setAttribute('visibility', 'visible');
    readout.textContent = `${points[i]![0]}: ${formatNumber(points[i]![1], lang)}`;
  });
  box.append(el('div', 'bx-note', options.label), readout, root);
  return box;
}

function observation(country: IndexCountry, id: string, lang: IndexLang): string {
  const part = country.components.find((c) => c.id === id)!;
  const input = country.proof.inputs[id];
  const n = (value: number | null | undefined, digits = 2) => formatNumber(value, lang, digits);
  const ru = lang === 'ru';
  if (input?.kind === 'volume') {
    return ru
      ? `свежесть ${n(input.observed / input.expected)}× ожидаемой; за 24 ч ${input.recent} из ${input.mentions}`
      : `recency ${n(input.observed / input.expected)}× expected; ${input.recent} of ${input.mentions} within 24 h`;
  }
  if (input?.kind === 'tone') {
    return ru
      ? `${n(input.share * 100)} % негативных (с весом свежести), заголовков: ${input.mentions}`
      : `${n(input.share * 100)}% negative (recency-weighted), headlines: ${input.mentions}`;
  }
  if (!part.raw) return formatNumber(null, lang);
  const value = part.raw.value;
  // A negative fall is a rise, a negative depreciation is an appreciation.
  if (id === 'eqShock' || id === 'fxDep') {
    const words: [string, string] = id === 'eqShock'
      ? value >= 0 ? ['падения за 5 дней', 'fall over 5 days'] : ['роста за 5 дней', 'rise over 5 days']
      : value >= 0 ? ['ослабления за 21 день', 'depreciation over 21 days'] : ['укрепления за 21 день', 'appreciation over 21 days'];
    return `${n(Math.abs(value))} % ${words[ru ? 0 : 1]}`;
  }
  const units: Record<string, [string, string]> = {
    eqVol: ['% годовых', '% annualised'],
    fxVol: ['% годовых', '% annualised'],
    eqDrawdown: ['% ниже максимума за 126 дней', '% below the 126-day high'],
  };
  return `${n(value)} ${units[id]?.[ru ? 0 : 1] ?? ''}`;
}

function modelText(item: IndexInstrument, lang: IndexLang): string {
  const m = item.model;
  if (!m) return '';
  const n = (value: number | undefined) => formatNumber(value, lang);
  const head = lang === 'ru' ? 'волатильность' : 'volatility';
  if (m.alpha === undefined) return `; ${head} ${m.type}, λ = ${n(m.lambda)}`;
  return `; ${head} ${m.type}: α = ${n(m.alpha)}, β = ${n(m.beta)}, ν = ${n(m.nu)}`;
}

function sourceLine(kind: string, item: IndexInstrument, lang: IndexLang): string {
  if (item.reason) return `${kind}: ${formatNumber(null, lang)} (${lang === 'ru' ? item.reason : item.reasonEn ?? item.reason})`;
  const at = lang === 'ru' ? 'на' : 'as of';
  return `${kind}: ${instrumentName(item.name ?? '', lang)} (${item.symbol}, Yahoo Finance), ${at} ${item.asOf}${modelText(item, lang)}`;
}

export const formatTime = (time: number, lang: IndexLang) => new Date(time).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB');

/**
 * Value, interval, components, sources, history and proof of one country. `open` keeps the
 * proof block's state across re-renders.
 */
export function renderCountryDetail(
  country: IndexCountry,
  data: IndexPayload,
  lang: IndexLang,
  open: Set<string>,
): HTMLElement {
  const ru = lang === 'ru';
  const n = (value: number | null, digits = 4) => formatNumber(value, lang, digits);
  const signed = (value: number) => `${value >= 0.00005 ? '+' : ''}${n(value)}`;
  const box = el('div', 'bx-detail');

  const head = el('div', 'bx-head');
  const value = el('span', `bx-value bx-${scoreBand(country.index)}`, n(country.index));
  head.append(value);
  if (country.index !== null) head.append(el('span', 'bx-note', ru ? 'из 100' : 'of 100'));
  box.append(head);

  if (country.index === null) {
    const reason = ru ? country.reason : country.reasonEn;
    box.append(el('p', 'bx-note', `${ru ? 'Итоговое число не публикуется' : 'No total is published'}: ${reason ?? n(null)}.`));
  } else {
    const facts = el('dl', 'bx-facts');
    const fact = (term: string, text: string) => {
      const item = el('div');
      item.append(el('dt', '', term), el('dd', '', text));
      facts.append(item);
    };
    fact(ru ? '90 % интервал' : '90% interval', `${n(country.low, 2)} – ${n(country.high, 2)}`);
    fact(ru ? 'Покрытие весов' : 'Weight coverage', `${n(country.coverage * 100, 0)} %`);
    fact(ru ? 'Достоверность' : 'Confidence', confidenceName(country.confidence ?? '', lang));
    fact(ru ? 'Место' : 'Rank', country.rank === null ? (ru ? 'вне рейтинга' : 'unranked') : String(country.rank));
    box.append(facts);
    const sum = country.components.reduce((total, c) => total + (c.contribution ?? 0), 0);
    box.append(el('p', 'bx-sum', `${ru ? 'Из чего складывается' : 'How it adds up'}: 50 ${sum < 0 ? '−' : '+'} ${n(Math.abs(sum))} (${ru ? 'вклады компонентов' : 'component contributions'}) ${signed(country.shrinkage ?? 0)} (${ru ? 'сжатие к среднему по странам' : 'shrinkage to the cross-country mean'}) = ${n(country.index)}`));
  }
  box.append(el('p', 'bx-note', ru
    ? 'Отклонение рынков и новостей страны от нормы в сторону риска, а не вероятность кризиса. 50 — агрегат, у которого все компоненты на уровне нормы.'
    : 'How far a country\'s markets and news are from their norm towards risk, not a crisis probability. 50 is the aggregate with every component at its norm.'));

  const rows = data.components.map((definition) => {
    const part = country.components.find((c) => c.id === definition.id)!;
    const label = componentLabel(definition, lang);
    if (part.score === null) {
      const reason = ru ? part.reason : part.reasonEn;
      return [label, { text: `${n(null)}: ${reason ?? ''}`, cls: 'bx-missing', span: 5 }];
    }
    return [
      label,
      observation(country, definition.id, lang),
      n(part.z),
      { text: n(part.score), cls: `bx-${scoreBand(part.score)}` },
      part.weight === null ? '—' : `${n(part.weight * 100, 2)} %`,
      part.contribution === null ? '—' : signed(part.contribution),
    ];
  });
  box.append(table(ru
    ? ['Компонент', 'Наблюдение', 'z', 'Балл', 'Вес', 'Вклад']
    : ['Component', 'Observation', 'z', 'Score', 'Weight', 'Contribution'], rows));

  box.append(
    el('p', 'bx-note', sourceLine(ru ? 'Акции' : 'Equities', country.equity, lang)),
    el('p', 'bx-note', sourceLine(ru ? 'Валюта' : 'Currency', country.fx, lang)),
    el('p', 'bx-note', `${ru ? 'Новости: публичные RSS-ленты за 7 суток' : 'News: public RSS feeds, last 7 days'} (${data.sources.feedsOk}/${data.sources.feeds}), ${ru ? 'заголовков о стране' : 'headlines about the country'}: ${country.news.mentions}${country.newsDates ? `, ${formatTime(country.newsDates[0], lang)} – ${formatTime(country.newsDates[1], lang)}` : ''}. ${ru ? 'Расчёт' : 'Computed'}: ${formatTime(data.updatedAt, lang)}.${data.degraded ? ` ${ru ? 'Большинство источников не ответило: картина неполная.' : 'Most sources did not answer: the picture is incomplete.'}` : ''}`),
  );
  box.append(renderIndexProof(country, data, lang, open));
  box.append(lineChart(country.history, lang, {
    label: ru ? 'История рыночной части индекса (без новостей и без сжатия)' : 'History of the market part (no news, no shrinkage)',
    min: 0, max: 100, midline: 50,
  }));
  return box;
}

/**
 * Self-loading card of one country for the country panel. It refreshes every five minutes
 * until `signal` aborts. A failed load says "no data" and offers a retry.
 */
export function mountCountryIndex(code: string, lang: IndexLang, signal: AbortSignal): HTMLElement {
  const ru = lang === 'ru';
  const root = el('div', 'bansho-index');
  const heading = el('h3', 'bx-title', ru ? 'Индекс нестабильности Money Bansho' : 'Money Bansho instability index');
  const body = el('div', 'bx-body');
  body.setAttribute('aria-live', 'polite');
  const status = el('p', 'bx-note', ru ? 'Расчёт индекса, до минуты…' : 'Computing the index, up to a minute…');
  body.append(status);
  root.append(heading, body);
  const open = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const load = async (): Promise<void> => {
    clearTimeout(timer);
    try {
      const data = await loadCountryIndex(signal);
      if (signal.aborted) return;
      const country = data.countries.find((c) => c.code === code.toUpperCase());
      if (country) {
        body.replaceChildren(renderCountryDetail(country, data, lang, open));
        root.dataset.state = country.index === null ? 'unavailable' : 'ready';
      } else {
        const names = data.countries.map((c) => countryName(c, lang)).sort((a, b) => a.localeCompare(b, lang));
        body.replaceChildren(el('p', 'bx-value bx-none', formatNumber(null, lang)), el('p', 'bx-note', ru
          ? `Эта страна не входит в расчёт. Индекс считается для ${names.length} стран: ${names.join(', ')}.`
          : `This country is not covered. The index is computed for ${names.length} countries: ${names.join(', ')}.`));
        root.dataset.state = 'unavailable';
      }
    } catch {
      if (signal.aborted) return;
      // Earlier figures stay on screen; without them the card says "no data".
      if (!body.querySelector('.bx-detail')) {
        const retry = el('button', 'bx-button', ru ? 'Повторить' : 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', () => {
          body.replaceChildren(status);
          void load();
        });
        body.replaceChildren(el('p', 'bx-value bx-none', formatNumber(null, lang)),
          el('p', 'bx-note', ru ? 'Источник индекса не ответил.' : 'The index source did not answer.'), retry);
        root.dataset.state = 'unavailable';
      }
    }
    // A card that has left the page stops polling.
    if (!signal.aborted && root.isConnected) timer = setTimeout(() => void load(), INDEX_POLL_MS);
    // Outside a browser (tests) a pending poll must not keep the process alive.
    (timer as unknown as { unref?: () => void } | undefined)?.unref?.();
  };
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  void load();
  return root;
}
