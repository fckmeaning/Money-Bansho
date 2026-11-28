// Tab "forecast": what is forecast, the corridor, what it rests on, how often it held, and what a
// headline changes. Reads the raw `forecast` block (api/_dossier/math/forecast.js).
import './forecast.css';
import { h, s } from './dom';
import { equation, frac, paren, row, sqrt, sub, sup } from './mathml';

export interface Corridor {
  h: number; low80Pct: number; high80Pct: number; lowPrice: number; highPrice: number;
  thresholdPct: number; scenarios: { adverse: number; base: number; favourable: number };
  exceed: { k: number; pct: number; prob: number }[]; annualPct: number; vsUsual: number; multiplier?: number;
}
export interface Fan { h: number; q025: number; q10: number; q25: number; q75: number; q90: number; q975: number }
/** The side the price is expected to take, with how often that call was right on past windows. */
export interface Direction {
  h: number; side: 'up' | 'down'; movePct: number; price: number; probUp: number;
  record: { n: number; hit: number; upShare: number } | null;
}
interface Realized { h: number; actualPct: number; low80Pct: number; high80Pct: number; inside: boolean }
interface Analogue {
  h: number; n: number; sameType: number | null;
  low80Pct: number | null; medianPct: number | null; high80Pct: number | null; upShare: number | null;
}
export interface Item {
  eventId: string; title: string; type: string; fresh: boolean;
  adjustment: { kind: 'filing' | 'headline' | 'none'; scale: number[] };
  horizons: Corridor[]; fan: Fan[] | null; realized: Realized[] | null; analogues: Analogue[];
  reputation: { now: number; confirmed: number | null; denied: number | null; quietWeek: number };
}
interface Linked {
  symbol: string; name: string; beta: number; corr: number; pairs: number;
  moves?: { h: number; downPct: number; upPct: number }[];
}
interface Held {
  n: number; cover80: number; previousCover80: number; cover95?: number; previousCover95?: number;
  skill: number; skillLow: number; skillHigh: number;
  brier?: number; previousBrier?: number; climatologyBrier?: number; tailSkill?: number; widthChange?: number;
}
type ByHorizon = Record<string, Held>;
export interface Evidence {
  period: [string, string]; companies: number; range: ByHorizon; close: ByHorizon;
  events: { filing?: ByHorizon; headline?: ByHorizon };
  extremeRatio?: number; extreme?: Record<string, { n: number; cover80: number }>;
  links?: { corrBefore: number; corrAfter: number };
}
export interface Forecast {
  asOf: number; lastClose: number;
  model: {
    kind: 'range' | 'close' | 'simple'; marketUsed: boolean; sessions: number;
    usualAnnualPct: number; recentAnnualPct: number; seasonQuarters: number[] | null;
  };
  horizons: Corridor[]; fan: Fan[];
  /** Missing in answers saved before it was added. */
  direction?: Direction[];
  drivers: { h: number; parts: { id: string; share: number; annualPct: number }[] }[] | null;
  record: {
    h: number; n: number; independent: number; cover80: number; cover95: number;
    previousCover80: number; previousCover95: number; skill: number;
  }[];
  evidence: Evidence | null;
  links: { threshold: number; checked: number; linked: Linked[]; nearest: Linked[] } | null;
  events: Item[];
}

export const TEXT = {
  en: {
    title: 'Forecast: price corridor', none: 'No data: not enough price history.',
    what: 'The range of the price change from the last close over 1, 5 and 20 sessions. About 8 outcomes in 10 should fall inside. The corridor is centred on zero; the violet line is a separate and weak estimate of direction.',
    note: 'A statistical estimate, not a price promise and not investment advice.',
    extreme: 'Expected volatility is far above usual (×{x} or more). In the held-out test the 80% corridor in such states held {c1} / {c5} / {c20} of the time at 1 / 5 / 20 sessions.',
    last: 'Last close', asOf: 'as of', sessions: 'Sessions', range: '80% corridor', price: 'Price range',
    annual: 'Expected volatility, a year', versus: 'Against usual', usual: 'usual', recent: 'last 60 sessions',
    sizes: 'Chance of a move at least this large, either way', size: 'Move',
    fan: 'Corridor by horizon', fanNote: 'Inner band 50%, middle band 80%, dashed lines 95%. Between 1, 5 and 20 sessions the values are interpolated.',
    fanEvent: 'Solid outline: the 80% corridor with the factor of the selected item.',
    basis: 'What it rests on', input: 'Input', own: 'Its value, a year', share: 'Share of the variance',
    models: {
      range: 'Model with daily ranges (open, high, low, close), quarterly repetition and market volatility.',
      close: 'Model on closing prices only: this history has no usable daily ranges or is shorter than 250 sessions.',
      simple: 'Too little history for the model: plain 60-session deviation, normal distribution. Not checked here.',
    },
    market: 'Market index volatility is used.', noMarket: 'No index history: the market input is neutral.',
    season: 'Quarters found for the repetition input (1 / 5 / 20 sessions)', history: 'Sessions of history',
    f_long: 'Long-run level (up to 2 years)', f_rangeDay: 'Range of the last session', f_rangeWeek: 'Ranges, 5 sessions',
    f_rangeMonth: 'Ranges, 22 sessions', f_rangeQuarter: 'Ranges, 66 sessions', f_season: 'Same weeks in past quarters',
    f_day: 'Last session', f_week: '5 sessions', f_month: '22 sessions', f_quarter: '66 sessions',
    f_marketWeek: 'Market index, 5 sessions', f_marketMonth: 'Market index, 22 sessions',
    hits: 'How often it held', here: 'This company: the corridor rebuilt on each past day from the data known then',
    tests: 'Tests', free: 'independent', in80: 'Inside 80% (stated 80)', in95: 'Inside 95% (stated 95)', error: 'Quantile error vs previous',
    was: 'previous', less: 'smaller', more: 'larger', noRecord: 'No data: history is too short for a self-check.',
    pooled: 'Held-out test, {companies} companies, {from} to {to} (constants fitted before 2025)', points: 'Points',
    gain: 'Distribution error (CRPS) removed, 95% interval', brier: 'Brier score: model / previous / frequency (lower is better)',
    caveat: '"Previous" is the earlier version of this tab: normal distribution with the 60-session deviation. The gain is small. At 5 and 20 sessions the 80% corridor held slightly less often than stated (the previous one was closer to 80 there). Against a GARCH model with Student tails this model is ahead at 1 session and indistinguishable at 5 and 20.',
    news: 'What a headline changes', pick: 'Headline or filing', noNews: 'No classified headlines or filings for this company right now.',
    ordinary: 'Ordinary corridor', adjusted: 'If this type of item precedes the next session', factor: 'Factor',
    kinds: {
      filing: 'SEC filing on results: after such filings outcomes were much wider. The factor was measured on 8-K filings of 10 US companies.',
      headline: 'The factor for this headline type was measured on English headlines about 19 US companies. It is small.',
      none: 'No factor: nothing measurable was found for this type of item, the corridor stays ordinary.',
    },
    isFresh: 'No session has closed since this item: the right-hand corridor is the one in force.',
    isOld: 'Sessions have closed since this item: its reaction is already in the price, the ordinary corridor is in force.',
    tested: 'Held-out events', covered: 'Inside 80%: previous → now',
    after: 'What happened after it', then: 'Corridor at the time', actual: 'Actual', inside: 'Inside', yes: 'yes', no: 'no',
    pending: 'No finished window yet.',
    alike: 'What followed similar earlier headlines (description only)', cases: 'Cases', sameType: 'Same type',
    observed: '80% of observed', median: 'Median', rose: 'Rose',
    alikeNote: 'Not part of the corridor: on held-out events these cases added no accuracy beyond the type factor. Small samples.',
    rep: 'If → then: reputation score', now: 'Now', confirmed: 'Confirmed by more outlets', denied: 'Denied by a major outlet', quiet: 'A quiet week',
    links: 'Linked companies', company: 'Company', move: 'Beta and correlation', ifDown: 'If at the lower edge', ifUp: 'If at the upper edge',
    linksNote: 'Not a forecast of the other company: if this one moves to an edge of its 80% corridor, the linked one moved on average beta times as much. Chosen by correlation of daily returns over a year (from {min}). On the following quarter the correlation fell on average from {before} to {after}.',
    linksNone: 'No listed company has a correlation of {min} or more. Closest ones, without an estimate:',
    linksNoData: 'No data: no price history of other companies.',
    formulas: 'Formulas',
    f1: 'Daily variance for h sessions is a weighted sum of the inputs above (heterogeneous autoregression); the weights are constants fitted on 2017–2024.',
    f2: 'The log change of the price follows a Student distribution with heavy tails; k is the event factor (1 without one).',
    f3: 'Range-based variance of one day: overnight gap plus the Garman–Klass intraday estimate.',
  },
  ru: {
    title: 'Прогноз: коридор цены', none: 'Нет данных: мало истории цен.',
    what: 'Диапазон изменения цены от последнего закрытия за 1, 5 и 20 сессий. Внутрь должны попадать примерно 8 исходов из 10. Коридор центрирован на нуле; фиолетовая линия — отдельная и слабая оценка направления.',
    note: 'Статистическая оценка, а не обещание цены и не инвестиционный совет.',
    extreme: 'Ожидаемая волатильность намного выше обычной (от ×{x}). На отложенной проверке в таких состояниях коридор 80% накрывал {c1} / {c5} / {c20} исходов на 1 / 5 / 20 сессий.',
    last: 'Последнее закрытие', asOf: 'на', sessions: 'Сессий', range: 'Коридор 80%', price: 'Коридор цены',
    annual: 'Ожидаемая волатильность, годовая', versus: 'К обычной', usual: 'обычная', recent: 'за 60 сессий',
    sizes: 'Вероятность движения не меньше указанного, в любую сторону', size: 'Движение',
    fan: 'Коридор по горизонтам', fanNote: 'Внутренняя полоса 50%, средняя 80%, пунктир 95%. Между 1, 5 и 20 сессиями значения интерполированы.',
    fanEvent: 'Сплошной контур: коридор 80% с поправкой выбранного сообщения.',
    basis: 'На чём основан', input: 'Вход модели', own: 'Его значение, годовых', share: 'Доля дисперсии',
    models: {
      range: 'Модель с дневными диапазонами (открытие, максимум, минимум, закрытие), квартальной повторяемостью и волатильностью рынка.',
      close: 'Модель только по ценам закрытия: в этой истории нет пригодных дневных диапазонов или она короче 250 сессий.',
      simple: 'Истории мало для модели: обычное отклонение за 60 сессий, нормальное распределение. Здесь не проверялось.',
    },
    market: 'Волатильность рыночного индекса учтена.', noMarket: 'Истории индекса нет: рыночный вход нейтрален.',
    season: 'Найдено кварталов для входа повторяемости (1 / 5 / 20 сессий)', history: 'Сессий истории',
    f_long: 'Долгий уровень (до 2 лет)', f_rangeDay: 'Диапазон последней сессии', f_rangeWeek: 'Диапазоны, 5 сессий',
    f_rangeMonth: 'Диапазоны, 22 сессии', f_rangeQuarter: 'Диапазоны, 66 сессий', f_season: 'Те же недели прошлых кварталов',
    f_day: 'Последняя сессия', f_week: '5 сессий', f_month: '22 сессии', f_quarter: '66 сессий',
    f_marketWeek: 'Индекс рынка, 5 сессий', f_marketMonth: 'Индекс рынка, 22 сессии',
    hits: 'Как часто попадал', here: 'Эта компания: в каждый прошлый день коридор построен заново по данным, известным тогда',
    tests: 'Проверок', free: 'независимых', in80: 'Внутри 80% (заявлено 80)', in95: 'Внутри 95% (заявлено 95)', error: 'Ошибка квантилей к прежней',
    was: 'прежняя', less: 'меньше', more: 'больше', noRecord: 'Нет данных: история коротка для самопроверки.',
    pooled: 'Отложенная проверка: {companies} компаний, {from} — {to} (константы подобраны до 2025 года)', points: 'Точек',
    gain: 'Убрано ошибки распределения (CRPS), интервал 95%', brier: 'Оценка Брайера: модель / прежняя / частоты (меньше лучше)',
    caveat: '«Прежняя» — предыдущая версия этой вкладки: нормальное распределение с отклонением за 60 сессий. Выигрыш небольшой. На 5 и 20 сессиях коридор 80% накрывал чуть реже заявленного (прежний там был ближе к 80). Против модели GARCH с хвостами Стьюдента эта модель впереди на 1 сессии и неотличима на 5 и 20.',
    news: 'Что меняет новость', pick: 'Новость или отчётность', noNews: 'Сейчас нет классифицированных новостей и отчётностей по компании.',
    ordinary: 'Обычный коридор', adjusted: 'Если такое сообщение выйдет перед следующей сессией', factor: 'Множитель',
    kinds: {
      filing: 'Отчётность в SEC: после таких документов разброс исходов был заметно шире. Множитель измерен на формах 8-K 10 компаний США.',
      headline: 'Множитель для этого типа новостей измерен на английских заголовках о 19 компаниях США. Он небольшой.',
      none: 'Поправки нет: для такого типа сообщений измеримого эффекта не найдено, коридор остаётся обычным.',
    },
    isFresh: 'После сообщения ещё не было закрытых сессий: действует правый коридор.',
    isOld: 'После сообщения уже были торги: реакция учтена в цене, действует обычный коридор.',
    tested: 'Отложенных событий', covered: 'Внутри 80%: было → стало',
    after: 'Что было после него', then: 'Коридор на тот момент', actual: 'Факт', inside: 'Внутри', yes: 'да', no: 'нет',
    pending: 'Законченных окон ещё нет.',
    alike: 'Что следовало за похожими прошлыми новостями (только описание)', cases: 'Случаев', sameType: 'Того же типа',
    observed: '80% наблюдавшихся', median: 'Медиана', rose: 'С ростом',
    alikeNote: 'В коридор не входит: на отложенных событиях эти случаи не добавили точности сверх множителя по типу. Выборки малы.',
    rep: 'Если → то: оценка репутации', now: 'Сейчас', confirmed: 'Подтвердят другие издания', denied: 'Опровергнет крупная редакция', quiet: 'Неделя тишины',
    links: 'Связанные компании', company: 'Компания', move: 'Бета и корреляция', ifDown: 'Если у нижней границы', ifUp: 'Если у верхней границы',
    linksNote: 'Это не прогноз по другой компании: если эта дойдёт до края своего коридора 80%, связанная в среднем смещалась в бета раз. Отбор по корреляции дневных доходностей за год (от {min}). В следующем квартале корреляция в среднем снижалась с {before} до {after}.',
    linksNone: 'Нет компаний списка с корреляцией {min} и выше. Ближайшие, без оценки:',
    linksNoData: 'Нет данных: нет истории цен других компаний.',
    formulas: 'Формулы',
    f1: 'Дневная дисперсия на h сессий — взвешенная сумма входов из таблицы выше (гетерогенная авторегрессия); веса — константы, подобранные на 2017–2024 годах.',
    f2: 'Логарифмическое изменение цены имеет распределение Стьюдента с тяжёлыми хвостами; k — множитель события (1, если его нет).',
    f3: 'Дисперсия одного дня по диапазону: ночной разрыв плюс внутридневная оценка Гармана–Класса.',
  },
};
export type Words = (typeof TEXT)['en'];

const signedPct = (x: number, digits = 2) => `${x > 0 ? '+' : ''}${x.toFixed(digits)}%`;
const share = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;
const between = (low: number, high: number) => `${signedPct(low)} … ${signedPct(high)}`;
const money = (x: number) => x.toFixed(Math.abs(x) < 1 ? 4 : 2);
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? '—'));

export const panelOf = (title: string, ...body: (Node | null)[]) =>
  h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', {}, title)),
    h('div', { class: 'fc-body' }, ...body));
export const note = (text: string) => h('p', { class: 'muted fc-note' }, text);
export const sentence = (text: string) => h('p', {}, text);

/** The first column is text, the rest are figures. */
export function table(head: string[], rows: (string | Node)[][]): HTMLElement {
  return h(
    'div',
    { class: 'fc-scroll' },
    h(
      'table',
      { class: 'fc-table mono' },
      h('tr', {}, ...head.map((c) => h('th', {}, c))),
      ...rows.map((cells) => h('tr', {}, ...cells.map((c) => h('td', {}, c)))),
    ),
  );
}

const FAN_W = 640;
const FAN_H = 230;

export function fanChart(fan: Fan[], overlay: Fan[] | null, last: number, direction: Direction[] = []): SVGElement {
  const rows: Fan[] = [{ h: 0, q025: 0, q10: 0, q25: 0, q75: 0, q90: 0, q975: 0 }, ...fan];
  const extra = overlay ?? [];
  const low = Math.min(...[...rows, ...extra].map((r) => Math.min(r.q025, r.q10)));
  const high = Math.max(...[...rows, ...extra].map((r) => Math.max(r.q975, r.q90)));
  const x = (d: number) => 8 + (d / 20) * (FAN_W - 150);
  const y = (v: number) => 10 + (1 - (v - low) / (high - low || 1)) * (FAN_H - 36);
  const path = (list: Fan[], key: keyof Fan) => list.map((r, i) => `${i ? 'L' : 'M'}${x(r.h)} ${y(r[key])}`).join('');
  const band = (lowKey: keyof Fan, highKey: keyof Fan, cls: string) =>
    s('path', { class: cls, d: `${path(rows, highKey)}${[...rows].reverse().map((r) => `L${x(r.h)} ${y(r[lowKey])}`).join('')}Z` });
  const end = rows[rows.length - 1] as Fan;
  const mark = (value: number) =>
    s('text', { x: FAN_W - 134, y: y(value) + 4 }, `${money(last * (1 + value / 100))}  ${signedPct(value, 1)}`);
  const outline = overlay ? [{ ...(rows[0] as Fan) }, ...overlay] : null;
  return s(
    'svg',
    { class: 'fc-fan', viewBox: `0 0 ${FAN_W} ${FAN_H}`, role: 'img', 'aria-label': `${signedPct(end.q10)} … ${signedPct(end.q90)}` },
    band('q10', 'q90', 'fc-band'),
    band('q25', 'q75', 'fc-band'),
    s('path', { class: 'fc-outer', d: path(rows, 'q975') }),
    s('path', { class: 'fc-outer', d: path(rows, 'q025') }),
    s('line', { class: 'fc-mid', x1: x(0), x2: x(20), y1: y(0), y2: y(0) }),
    ...(outline ? [s('path', { class: 'fc-event', d: path(outline, 'q90') }), s('path', { class: 'fc-event', d: path(outline, 'q10') })] : []),
    ...(direction.length ? directionMarks(direction, x, y) : []),
    mark(end.q90),
    mark(0),
    mark(end.q10),
    ...[0, 1, 5, 12, 20].map((d) => s('text', { x: x(d), y: FAN_H - 6, 'text-anchor': d ? 'middle' : 'start' }, String(d))),
  );
}

function directionMarks(direction: Direction[], x: (d: number) => number, y: (v: number) => number): SVGElement[] {
  const end = direction[direction.length - 1] as Direction;
  const d = `M${x(0)} ${y(0)}${direction.map((p) => `L${x(p.h)} ${y(p.movePct)}`).join('')}`;
  return [
    s('path', { class: 'fc-dir', d }),
    s('circle', { class: 'fc-dir-dot', cx: x(end.h), cy: y(end.movePct), r: 4 }),
    s('text', { class: 'fc-dir-text', x: x(end.h) - 6, y: y(end.movePct) + (end.side === 'up' ? -8 : 16), 'text-anchor': 'end' },
      `${end.side === 'up' ? '▲' : '▼'} ${signedPct(end.movePct)}`),
  ];
}

/** A warning when the expected volatility is far above usual: such corridors proved wider than stated. */
export function unusual(data: Forecast, w: Words): HTMLElement | null {
  const { evidence } = data;
  const limit = evidence?.extremeRatio;
  if (data.model.kind !== 'range' || !limit || !data.horizons.some((p) => p.vsUsual >= limit)) return null;
  const held = (horizon: string) => {
    const cell = evidence?.extreme?.[horizon];
    return cell ? share(cell.cover80) : '—';
  };
  return h('p', { class: 'caution' }, fill(w.extreme, { x: limit, c1: held('1'), c5: held('5'), c20: held('20') }));
}

export function corridorPanel(data: Forecast, w: Words, lang: string): HTMLElement {
  const date = new Date(data.asOf).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US', { timeZone: 'UTC' });
  const sizes = data.horizons.map((p) => [
    String(p.h),
    ...p.exceed.map((e) => `±${e.pct.toFixed(1)}% — ${share(e.prob)}`),
  ]);
  return panelOf(
    w.title,
    sentence(w.what),
    unusual(data, w),
    h('p', { class: 'fc-note mono' }, `${w.last}: ${money(data.lastClose)} (${w.asOf} ${date}) · ${w.usual} ${data.model.usualAnnualPct}% · ${w.recent} ${data.model.recentAnnualPct}%`),
    table(
      [w.sessions, w.range, w.price, w.annual, w.versus],
      data.horizons.map((p) => [
        String(p.h), between(p.low80Pct, p.high80Pct), `${money(p.lowPrice)} … ${money(p.highPrice)}`,
        `${p.annualPct}%`, `×${p.vsUsual.toFixed(2)}`,
      ]),
    ),
    h('h3', { class: 'fc-sub' }, w.sizes),
    table([w.sessions, `${w.size} 1`, `${w.size} 2`, `${w.size} 3`], sizes),
    h('p', { class: 'caution' }, w.note),
  );
}

export function basisPanel(data: Forecast, w: Words): HTMLElement {
  const m = data.model;
  const names = w as unknown as Record<string, string>;
  const drivers = data.drivers;
  const bar = (value: number) => {
    const track = h('span', { class: 'fc-bar' }, h('i', {}));
    (track.firstChild as HTMLElement).style.width = `${Math.min(100, value * 100)}%`;
    return h('span', { class: 'fc-share' }, track, share(value));
  };
  const first = drivers?.[0];
  return panelOf(
    w.basis,
    sentence(`${w.models[m.kind]} ${m.kind === 'simple' ? '' : m.marketUsed ? w.market : w.noMarket}`),
    note(`${w.history}: ${m.sessions}${m.seasonQuarters ? ` · ${w.season}: ${m.seasonQuarters.join(' / ')}` : ''}`),
    drivers && first
      ? table(
        [w.input, w.own, ...drivers.map((d) => `${w.share}, ${d.h}`)],
        first.parts.map((part, i) => [
          names[`f_${part.id}`] ?? part.id,
          `${(drivers[1] ?? first).parts[i]?.annualPct ?? part.annualPct}%`,
          ...drivers.map((d) => bar(d.parts[i]?.share ?? 0)),
        ]),
      )
      : null,
  );
}

export function recordPanel(data: Forecast, w: Words): HTMLElement {
  const pooled = data.evidence && data.model.kind !== 'simple' ? data.evidence[data.model.kind] : null;
  const gain = (x: number) => `${share(Math.abs(x), 1)} ${x >= 0 ? w.less : w.more}`;
  const own = data.record.length
    ? table(
      [w.sessions, w.tests, w.in80, w.in95, w.error],
      data.record.map((r) => [
        String(r.h), `${r.n} (${w.free}: ${r.independent})`,
        `${share(r.cover80)} (${w.was} ${share(r.previousCover80)})`,
        `${share(r.cover95)} (${w.was} ${share(r.previousCover95)})`,
        gain(r.skill),
      ]),
    )
    : note(w.noRecord);
  const held = pooled && data.evidence
    ? [
      h('h3', { class: 'fc-sub' }, fill(w.pooled, { companies: data.evidence.companies, from: data.evidence.period[0], to: data.evidence.period[1] })),
      table(
        [w.sessions, w.points, w.in80, w.in95, w.gain, w.brier],
        Object.entries(pooled).map(([horizon, e]) => [
          horizon, String(e.n),
          `${share(e.cover80, 1)} (${w.was} ${share(e.previousCover80, 1)})`,
          `${share(e.cover95 ?? 0, 1)} (${w.was} ${share(e.previousCover95 ?? 0, 1)})`,
          `${share(e.skill, 2)} [${share(e.skillLow, 2)}; ${share(e.skillHigh, 2)}]`,
          `${e.brier?.toFixed(4)} / ${e.previousBrier?.toFixed(4)} / ${e.climatologyBrier?.toFixed(4)}`,
        ]),
      ),
      note(w.caveat),
    ]
    : [];
  return panelOf(w.hits, h('h3', { class: 'fc-sub' }, w.here), own, ...held);
}

export function linksPanel(data: Forecast, w: Words): HTMLElement {
  const links = data.links;
  if (!links) return panelOf(w.links, note(w.linksNoData));
  const name = (p: Linked) => `${p.symbol} · ${p.name}`;
  const fit = (p: Linked) => `β ${p.beta.toFixed(2)}, ρ ${p.corr.toFixed(2)} (n=${p.pairs})`;
  if (!links.linked.length) {
    return panelOf(
      w.links,
      sentence(fill(w.linksNone, { min: links.threshold })),
      table([w.company, w.move], links.nearest.map((p) => [name(p), fit(p)])),
    );
  }
  const held = data.evidence?.links;
  return panelOf(
    w.links,
    table(
      [w.company, w.move, w.sessions, w.ifDown, w.ifUp],
      links.linked.flatMap((p) => (p.moves ?? []).map((m, i) => [
        i ? '' : name(p), i ? '' : fit(p), String(m.h), signedPct(m.downPct), signedPct(m.upPct),
      ])),
    ),
    note(fill(w.linksNote, { min: links.threshold, before: held?.corrBefore ?? '—', after: held?.corrAfter ?? '—' })),
  );
}

export function newsDetails(item: Item, data: Forecast, w: Words): Node[] {
  const kind = item.adjustment.kind;
  const proof = kind === 'none' ? undefined : data.evidence?.events[kind];
  const conditional = table(
    [w.sessions, w.ordinary, w.adjusted, w.factor, ...(proof ? [w.tested, w.covered] : [])],
    item.horizons.map((p, i) => {
      const base = data.horizons[i] as Corridor;
      const e = proof?.[String(p.h)];
      return [
        String(p.h), between(base.low80Pct, base.high80Pct), between(p.low80Pct, p.high80Pct), `×${p.multiplier ?? 1}`,
        ...(proof ? [e ? String(e.n) : '—', e ? `${share(e.previousCover80, 1)} → ${share(e.cover80, 1)}` : '—'] : []),
      ];
    }),
  );
  const happened = item.realized?.length
    ? table(
      [w.sessions, w.then, w.actual, w.inside],
      item.realized.map((r) => [String(r.h), between(r.low80Pct, r.high80Pct), signedPct(r.actualPct), r.inside ? w.yes : w.no]),
    )
    : note(w.pending);
  const dash = (x: number | null, format: (v: number) => string) => (x === null ? '—' : format(x));
  const alike = table(
    [w.sessions, w.cases, w.sameType, w.observed, w.median, w.rose],
    item.analogues.map((a) => [
      String(a.h), String(a.n), dash(a.sameType, (v) => share(v)),
      a.low80Pct === null || a.high80Pct === null ? '—' : between(a.low80Pct, a.high80Pct),
      dash(a.medianPct, (v) => signedPct(v)), dash(a.upShare, (v) => share(v)),
    ]),
  );
  const rep = item.reputation;
  const branches = h(
    'dl',
    { class: 'fc-branches' },
    ...([[w.now, rep.now], [w.confirmed, rep.confirmed], [w.denied, rep.denied], [w.quiet, rep.quietWeek]] as const).map(
      ([label, value]) => h('div', {}, h('dt', {}, label), h('dd', { class: 'mono' }, value === null ? '—' : String(value))),
    ),
  );
  return [
    sentence(w.kinds[kind]),
    note(item.fresh ? w.isFresh : w.isOld),
    conditional,
    ...(item.fan ? [fanChart(data.fan, item.fan, data.lastClose), note(w.fanEvent)] : []),
    h('h3', { class: 'fc-sub' }, w.after),
    happened,
    h('h3', { class: 'fc-sub' }, w.alike),
    alike,
    note(w.alikeNote),
    h('h3', { class: 'fc-sub' }, w.rep),
    branches,
  ];
}

function newsPanel(
  data: Forecast,
  w: Words,
  options: { selectedId: string | null; onSelect: (id: string) => void },
): HTMLElement {
  if (!data.events.length) return panelOf(w.news, note(w.noNews));
  const body = h('div', { class: 'fc-news' });
  const select = h(
    'select',
    { class: 'fc-select', 'aria-label': w.pick },
    ...data.events.map((e) => h('option', { value: e.eventId }, e.title)),
  );
  const show = () => {
    const item = data.events.find((e) => e.eventId === select.value) ?? (data.events[0] as Item);
    body.replaceChildren(...newsDetails(item, data, w));
  };
  // Open on what has the most to show: a fresh item, then one with a factor, then the latest.
  const weight = (e: Item) => (e.fresh ? 2 : 0) + (e.adjustment.kind === 'filing' ? 1.5 : e.adjustment.kind === 'headline' ? 1 : 0);
  const best = [...data.events].sort((a, b) => weight(b) - weight(a))[0] as Item;
  select.value = data.events.some((e) => e.eventId === options.selectedId) ? (options.selectedId as string) : best.eventId;
  select.addEventListener('change', () => {
    options.onSelect(select.value);
    show();
  });
  show();
  return panelOf(w.news, select, body);
}

function formulasPanel(w: Words): HTMLElement {
  return panelOf(
    w.formulas,
    note(w.f1),
    equation(sup(sub('σ', 'h'), '2'), '=', 'h', '·', row(sub('∑', 'i'), sub('w', row('i', ',', 'h')), sub('x', 'i'))),
    note(w.f2),
    equation(
      'ln', frac(sub('C', row('t', '+', 'h')), sub('C', 't')), '=',
      'k', '·', sub('s', 'h'), '·', sub('σ', 'h'), '·', sub('T', sub('ν', 'h')),
    ),
    note(w.f3),
    equation(
      sup('σ', '2'), '=', sup(paren('ln', frac('O', sub('C', row('t', '−', '1')))), '2'), '+',
      frac('1', '2'), sup(paren('ln', frac('H', 'L')), '2'), '−',
      paren('2', 'ln', '2', '−', '1'), sup(paren('ln', frac('C', 'O')), '2'),
    ),
    equation('P', row('(', '|', 'r', '|', '>', 'a', ')'), '=', '2', row('(', '1', '−', sub('F', 'ν'), row('(', frac('a', row('k', sub('s', 'h'), sub('σ', 'h'))), ')'), ')')),
    equation('σ', '=', sqrt(frac(row(sup(sub('σ', 'h'), '2'), sup(sub('s', 'h'), '2'), 'ν'), row('h', '(', 'ν', '−', '2', ')'))), '·', sqrt('252')),
  );
}

/** What the tab shows, for "newer data is available": a new close or a different list of headlines. */
export function forecastVersion(raw: unknown): string {
  const data = (raw as { forecast?: Partial<Forecast> | null } | null)?.forecast;
  return JSON.stringify([data?.asOf, data?.events?.map((e) => [e.eventId, e.fresh])]);
}

export function forecastView(
  raw: unknown,
  options: { lang: 'en' | 'ru'; selectedId: string | null; onSelect: (id: string) => void },
): HTMLElement {
  const w: Words = TEXT[options.lang];
  const data = (raw as { forecast?: Forecast | null } | null)?.forecast;
  if (!data || !Array.isArray(data.horizons) || !data.horizons.length || !Array.isArray(data.events)) {
    return panelOf(w.title, note(w.none));
  }
  return h(
    'div',
    { class: 'fc' },
    corridorPanel(data, w, options.lang),
    panelOf(w.fan, fanChart(data.fan, null, data.lastClose, data.direction), note(w.fanNote)),
    basisPanel(data, w),
    recordPanel(data, w),
    newsPanel(data, w, options),
    linksPanel(data, w),
    formulasPanel(w),
  );
}
