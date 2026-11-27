// Tab "news -> conditional scenario". Reads the raw `forecast` block.
import { h } from './dom';

interface Check { n: number; hitRate: number; baseRate: number; coverage80: number }
interface Horizon {
  h: number; rule: 'type+tone' | 'type' | 'tone' | 'baseline'; n: number; weight: number;
  expectedPct: number; low80Pct: number; high80Pct: number;
  lowPrice: number; midPrice: number; highPrice: number; probUp: number; thresholdPct: number;
  scenarios: { adverse: number; base: number; favourable: number };
  check: Check | null;
  peers: Peer[] | null;
}
interface Peer {
  symbol: string; name: string; beta: number; corr: number; pairs: number;
  betaPct: number; analoguePct: number | null; cases: number;
}
interface Item {
  eventId: string; title: string; type: string; tone: number; horizons: Horizon[];
  reputation: { now: number; confirmed: number | null; denied: number | null; quietWeek: number };
}
interface Forecast { lastClose: number; dailySigmaPct: number; events: Item[] }

const TEXT = {
  en: {
    title: 'News → conditional scenario', pick: 'Headline', none: 'No data: not enough price history or headlines.',
    note: 'A statistical scenario, not a price promise and not investment advice. It does not show that the news causes a move.',
    horizon: 'Sessions', expected: 'Expected', range: '80% range', price: 'Price range', up: 'P(up)', cases: 'Analogues',
    fan: 'Price corridor (80%)', scen: 'Scenarios', adverse: 'Adverse', base: 'Base', favourable: 'Favourable',
    rep: 'If → then: reputation score', now: 'Now', confirmed: 'Confirmed by more outlets', denied: 'Denied by a major outlet', quiet: 'A quiet week',
    check: 'Self-check on past cases', noCheck: 'too few cases to test',
    chance: 'No better than always guessing the common direction.', better: 'Above the naive guess on this small sample.',
    hit: 'direction hit rate', naive: 'naive guess', cover: '80% range covered',
    rules: { 'type+tone': 'same type and tone', type: 'same type', tone: 'any type, same tone', baseline: 'too few: normal volatility only' },
    formula: 'Expected = n/(n+10) × mean of analogues. Variance = (1−w)·σ²·h + w·variance of analogues. Scenarios split at ±0.5·σ·√h.',
    peers: 'Related companies (same country): estimate', peersNone: 'No data: no peer with enough history and correlation.',
    peer: 'Company', byBeta: 'By beta', byCases: 'By own analogue windows', peersNote: 'Estimate, not a forecast: beta × expected move, and the peer’s mean return over the same windows (shrunk). Peers are chosen by country; the data has no sector field.',
  },
  ru: {
    title: 'Новость → условный сценарий', pick: 'Новость', none: 'Нет данных: мало истории цен или заголовков.',
    note: 'Статистический сценарий, а не обещание цены и не инвестиционный совет. Он не доказывает, что новость вызывает движение.',
    horizon: 'Сессий', expected: 'Ожидание', range: 'Интервал 80%', price: 'Коридор цены', up: 'P(рост)', cases: 'Похожие случаи',
    fan: 'Коридор цены (80%)', scen: 'Сценарии', adverse: 'Неблагоприятный', base: 'Базовый', favourable: 'Благоприятный',
    rep: 'Если → то: оценка репутации', now: 'Сейчас', confirmed: 'Подтвердят другие издания', denied: 'Опровергнет крупная редакция', quiet: 'Неделя тишины',
    check: 'Самопроверка на прошлых случаях', noCheck: 'мало случаев для проверки',
    chance: 'Не лучше, чем всегда называть частое направление.', better: 'Выше наивной догадки на этой малой выборке.',
    hit: 'угадано направление', naive: 'наивная догадка', cover: 'интервал 80% накрыл',
    rules: { 'type+tone': 'тот же тип и тон', type: 'тот же тип', tone: 'любой тип, тот же тон', baseline: 'мало: только обычная волатильность' },
    formula: 'Ожидание = n/(n+10) × среднее похожих случаев. Дисперсия = (1−w)·σ²·h + w·дисперсия похожих. Границы сценариев ±0.5·σ·√h.',
    peers: 'Связанные компании (та же страна): оценка', peersNone: 'Нет данных: нет компаний с достаточной историей и корреляцией.',
    peer: 'Компания', byBeta: 'По бете', byCases: 'По своим окнам аналогов', peersNote: 'Оценка, а не прогноз: бета × ожидаемое движение и средняя доходность компании на тех же окнах (со сжатием). Пары выбраны по стране: в данных нет поля отрасли.',
  },
};
type Words = (typeof TEXT)['en'];

const percent = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(2)}%`;
const share = (x: number) => `${Math.round(x * 100)}%`;
const panelOf = (title: string, ...body: Node[]) =>
  h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', {}, title)), h('div', { class: 'fc-body' }, ...body));

function corridor(item: Item, last: number): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const el = (name: string, attrs: Record<string, string | number>) => {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };
  const points = [{ h: 0, lowPrice: last, midPrice: last, highPrice: last }, ...item.horizons];
  const low = Math.min(...points.map((p) => p.lowPrice));
  const high = Math.max(...points.map((p) => p.highPrice));
  const x = (d: number) => 10 + (d / 20) * 520;
  const y = (v: number) => 12 + (1 - (v - low) / (high - low || 1)) * 156;
  const line = (key: 'lowPrice' | 'midPrice' | 'highPrice', list = points) =>
    list.map((p, i) => `${i ? 'L' : 'M'}${x(p.h)} ${y(p[key])}`).join('');
  const svg = el('svg', { viewBox: '0 0 600 190', class: 'fc-fan', role: 'img' });
  const back = [...points].reverse().map((p) => `L${x(p.h)} ${y(p.lowPrice)}`).join('');
  svg.append(el('path', { d: `${line('highPrice')}${back}Z`, class: 'fc-band' }), el('path', { d: line('midPrice'), class: 'fc-mid' }));
  for (const [value, label] of [[high, high], [last, last], [low, low]] as const) {
    const text = el('text', { x: 538, y: y(value) + 4 });
    text.textContent = label.toFixed(2);
    svg.append(text);
  }
  for (const p of points) {
    const text = el('text', { x: x(p.h), y: 186, 'text-anchor': p.h ? 'middle' : 'start' });
    text.textContent = String(p.h);
    svg.append(text);
  }
  return svg;
}

function details(item: Item, data: Forecast, w: Words): Node[] {
  const row = (cells: string[], head = false) => h('tr', {}, ...cells.map((c) => h(head ? 'th' : 'td', {}, c)));
  const table = h(
    'div',
    { class: 'fc-scroll' },
    h(
      'table',
      { class: 'fc-table' },
      row([w.horizon, w.expected, w.range, w.price, w.up, w.cases], true),
      ...item.horizons.map((p) =>
        row([
          String(p.h), percent(p.expectedPct), `${percent(p.low80Pct)} … ${percent(p.high80Pct)}`,
          `${p.lowPrice.toFixed(2)} … ${p.highPrice.toFixed(2)}`, share(p.probUp), `${p.n} · ${w.rules[p.rule]}`,
        ]),
      ),
    ),
  );
  const scenarios = h(
    'div',
    { class: 'fc-scroll' },
    h(
      'table',
      { class: 'fc-table' },
      row([w.horizon, w.adverse, w.base, w.favourable], true),
      ...item.horizons.map((p) =>
        row([`${p.h} (±${p.thresholdPct.toFixed(1)}%)`, share(p.scenarios.adverse), share(p.scenarios.base), share(p.scenarios.favourable)]),
      ),
    ),
  );
  const peerRows = item.horizons.flatMap((p) =>
    (p.peers ?? []).map((q) =>
      row([
        `${q.symbol} · ${p.h}`, `β ${q.beta.toFixed(2)}, ρ ${q.corr.toFixed(2)} (n=${q.pairs})`, percent(q.betaPct),
        q.analoguePct === null ? '—' : `${percent(q.analoguePct)} (n=${q.cases})`,
      ]),
    ),
  );
  const peers = peerRows.length
    ? h('div', { class: 'fc-scroll' }, h('table', { class: 'fc-table' }, row([w.peer, 'β, ρ', w.byBeta, w.byCases], true), ...peerRows), h('p', { class: 'muted mono' }, w.peersNote))
    : h('p', { class: 'muted' }, w.peersNone);
  const rep = item.reputation;
  const branches = h(
    'dl',
    { class: 'fc-branches' },
    ...([[w.now, rep.now], [w.confirmed, rep.confirmed], [w.denied, rep.denied], [w.quiet, rep.quietWeek]] as const).map(
      ([label, value]) => h('div', {}, h('dt', {}, label), h('dd', { class: 'mono' }, value === null ? '—' : String(value))),
    ),
  );
  const checks = item.horizons.map((p) => {
    const c = p.check;
    return h(
      'p',
      {},
      c
        ? `${p.h}: ${w.hit} ${share(c.hitRate)}, ${w.naive} ${share(c.baseRate)}, ${w.cover} ${share(c.coverage80)} (n=${c.n}). ${c.hitRate > c.baseRate ? w.better : w.chance}`
        : `${p.h}: ${w.noCheck}`,
    );
  });
  return [
    panelOf(w.expected, table),
    panelOf(w.fan, corridor(item, data.lastClose)),
    panelOf(w.scen, scenarios),
    panelOf(w.peers, peers),
    panelOf(w.rep, branches),
    panelOf(w.check, ...checks, h('p', { class: 'muted mono' }, w.formula)),
  ];
}

export function forecastView(
  raw: unknown,
  options: { lang: 'en' | 'ru'; selectedId: string | null; onSelect: (id: string) => void },
): HTMLElement {
  const w: Words = TEXT[options.lang];
  const data = (raw as { forecast?: Forecast | null } | null)?.forecast;
  if (!data || !Array.isArray(data.events) || !data.events.length) {
    return panelOf(w.title, h('p', { class: 'muted' }, w.none));
  }
  const body = h('div', { class: 'fc' });
  const select = h(
    'select',
    { class: 'fc-select', 'aria-label': w.pick },
    ...data.events.map((e) => h('option', { value: e.eventId }, e.title)),
  ) as HTMLSelectElement;
  const show = () => {
    const item = data.events.find((e) => e.eventId === select.value) ?? (data.events[0] as Item);
    body.replaceChildren(...details(item, data, w));
  };
  // Open on the headline with the most to show: a tone and some analogues.
  const richness = (e: Item) => e.horizons.reduce((total, p) => total + p.n, 0) + (e.tone ? 0.5 : 0);
  const richest = [...data.events].sort((a, b) => richness(b) - richness(a))[0] as Item;
  select.value = data.events.some((e) => e.eventId === options.selectedId) ? (options.selectedId as string) : richest.eventId;
  select.addEventListener('change', () => {
    options.onSelect(select.value);
    show();
  });
  show();
  return h('div', { class: 'fc' }, panelOf(w.title, select, h('p', { class: 'caution' }, w.note)), body);
}
