// «Мир»: the most important events of the last 72 hours and what they touch.
// Data comes from /api/dossier?view=world. Every field is validated; a bad or
// missing value is shown as «нет данных», never replaced with an invented one.
// The page is static: it is redrawn only when the data really changed, and it
// is polled no more often than once a minute.
import './world.css';
import { consequencesBlock } from './consequences';
import { fixed, h, link, signed, stamp, s as svg } from './dom';
import { panel, sourceIssues } from './panels';
import { isObj, list, num, str } from './quant-parse';
import type { Obj } from './quant-parse';
import type { SourceError } from './types';
import { localizeHeadlines } from './translate';

const ENDPOINT = '/api/dossier?view=world';
const POLL_MS = 60_000;
const TIMEOUT_MS = 28_000;
const NO_DATA = 'нет данных';

interface Observed {
  from: number;
  sessions: number;
  change: number;
  unit: 'pct' | 'bp';
  z: number;
}
interface Asset {
  symbol: string;
  name: string;
  observed: Observed | null;
  reason: string;
}
interface Company {
  symbol: string;
  name: string;
  country: string;
  basis: string;
}
interface Source {
  name: string;
  tier: number;
  url: string;
  time: number;
  title: string;
}
interface WorldEvent {
  id: string;
  title: string;
  url: string;
  type: string;
  typeLabel: string;
  regions: string[];
  primaryRegion: string;
  tone: number | null;
  score: number;
  parts: Record<string, number>;
  contrib: Record<string, number>;
  articles: number;
  sourceCount: number;
  independent: number | null;
  firstAt: number;
  lastAt: number;
  sources: Source[];
  assets: Asset[];
  companies: Company[];
  consequences: unknown;
}
interface RegionRow {
  id: string;
  label: string;
  events: number;
  tone: number | null;
  significance: number;
}
interface MarketRow {
  symbol: string;
  name: string;
  price: number | null;
  change1d: number | null;
  change5d: number | null;
  z1d: number | null;
  unit: 'pct' | 'bp';
  asOf: number | null;
  stale: boolean;
}
interface Point {
  t: number;
  value: number | null;
}
interface Timeline {
  source: string;
  volume: Point[] | null;
  tone: Point[] | null;
}
interface Coverage {
  feedsAsked: number;
  feedsOk: number;
  feedItems: number;
  gdeltAsked: number;
  gdeltOk: number;
  gdeltArticles: number;
  marketsAsked: number;
  marketsOk: number;
  clusters: number;
  failed: string[];
}
interface World {
  updatedAt: number;
  windowHours: number;
  weights: Record<string, number>;
  events: WorldEvent[];
  regions: RegionRow[];
  markets: MarketRow[];
  timeline: Timeline | null;
  timelineNote: string;
  coverage: Coverage;
  errors: SourceError[];
}

const FACTORS: [string, string][] = [
  ['src', 'Независимые источники'],
  ['tier', 'Надёжность источников'],
  ['rec', 'Свежесть'],
  ['tone', 'Тон заголовков'],
  ['type', 'Тип события'],
  ['mkt', 'Сюрприз рынка'],
];

// ---- parsing -----------------------------------------------------------------

const numbers = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (num(x) !== null) out[k] = x as number;
  return out;
};
const unit = (v: unknown): 'pct' | 'bp' => (v === 'bp' ? 'bp' : 'pct');

function parseAsset(v: unknown): Asset | null {
  if (!isObj(v) || !str(v.symbol)) return null;
  let observed: Observed | null = null;
  if (isObj(v.observed)) {
    const o = v.observed;
    const [from, sessions, change, z] = [num(o.from), num(o.sessions), num(o.change), num(o.z)];
    if (from !== null && sessions !== null && change !== null && z !== null) observed = { from, sessions, change, unit: unit(o.unit), z };
  }
  return { symbol: str(v.symbol), name: str(v.name) || str(v.symbol), observed, reason: str(v.reason) };
}

function parseEvent(v: unknown): WorldEvent | null {
  if (!isObj(v)) return null;
  const [score, firstAt, lastAt] = [num(v.score), num(v.firstAt), num(v.lastAt)];
  const title = str(v.title).trim();
  if (score === null || firstAt === null || lastAt === null || !title) return null;
  return {
    id: str(v.id) || `${firstAt}:${title}`,
    title,
    url: str(v.url),
    type: str(v.type),
    typeLabel: str(v.typeLabel) || 'Прочее',
    regions: list(v.regions).map(str).filter(Boolean),
    primaryRegion: str(v.primaryRegion),
    tone: num(v.tone),
    score,
    parts: numbers(v.parts),
    contrib: numbers(v.contrib),
    articles: num(v.articles) ?? 0,
    sourceCount: num(v.sourceCount) ?? 0,
    independent: num(v.independent),
    firstAt,
    lastAt,
    sources: list(v.sources).filter(isObj).map((x) => ({
      name: str(x.name),
      tier: num(x.tier) ?? 3,
      url: str(x.url),
      time: num(x.time) ?? 0,
      title: str(x.title),
    })),
    assets: list(v.assets).map(parseAsset).filter((a): a is Asset => a !== null),
    companies: list(v.companies).filter(isObj).filter((c) => str(c.symbol)).map((c) => ({
      symbol: str(c.symbol),
      name: str(c.name),
      country: str(c.country),
      basis: str(c.basis),
    })),
    consequences: v.consequences,
  };
}

function parsePoints(v: unknown): Point[] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const out = v.filter(isObj).map((p) => ({ t: num(p.t) ?? Number.NaN, value: num(p.value) })).filter((p) => Number.isFinite(p.t));
  return out.length > 1 ? out : null;
}

function parseTimeline(body: Obj): { timeline: Timeline | null; note: string } {
  const root = isObj(body.timeline) ? body.timeline : null;
  if (!root) return { timeline: null, note: '' };
  for (const key of ['gdelt', 'feeds'] as const) {
    const part = root[key];
    if (!isObj(part)) continue;
    const timeline = { source: key, volume: parsePoints(part.volume), tone: parsePoints(part.tone) };
    if (!timeline.volume && !timeline.tone) continue;
    const note = key === 'gdelt'
      ? 'GDELT DOC 2.0: число статей по запросу о мировых темах и средний тон (шкала GDELT от −10 до +10)'
      : 'GDELT недоступен: показано число заголовков в опрошенных лентах и средний тон по словарю (от −1 до +1)';
    return { timeline, note };
  }
  return { timeline: null, note: '' };
}

export function parseWorld(body: Obj): World {
  if (!Array.isArray(body.events)) throw new Error('invalid-response');
  const cov = isObj(body.coverage) ? body.coverage : {};
  const feeds = isObj(cov.feeds) ? cov.feeds : {};
  const gdelt = isObj(cov.gdelt) ? cov.gdelt : {};
  const markets = isObj(cov.markets) ? cov.markets : {};
  const { timeline, note } = parseTimeline(body);
  return {
    updatedAt: num(body.updatedAt) ?? Date.now(),
    windowHours: num(body.windowHours) ?? 72,
    weights: numbers(body.weights),
    events: body.events.map(parseEvent).filter((e): e is WorldEvent => e !== null),
    regions: list(body.regions).filter(isObj).map((r) => ({
      id: str(r.id),
      label: str(r.label) || str(r.id),
      events: num(r.events) ?? 0,
      tone: num(r.tone),
      significance: num(r.significance) ?? 0,
    })),
    markets: list(body.markets).filter(isObj).filter((m) => str(m.symbol)).map((m) => ({
      symbol: str(m.symbol),
      name: str(m.name) || str(m.symbol),
      price: num(m.price),
      change1d: num(m.change1d),
      change5d: num(m.change5d),
      z1d: num(m.z1d),
      unit: unit(m.unit),
      asOf: num(m.asOf),
      stale: m.stale === true,
    })),
    timeline,
    timelineNote: note,
    coverage: {
      feedsAsked: num(feeds.asked) ?? 0,
      feedsOk: num(feeds.ok) ?? 0,
      feedItems: num(feeds.items) ?? 0,
      gdeltAsked: num(gdelt.asked) ?? 0,
      gdeltOk: num(gdelt.ok) ?? 0,
      gdeltArticles: num(gdelt.articles) ?? 0,
      marketsAsked: num(markets.asked) ?? 0,
      marketsOk: num(markets.ok) ?? 0,
      clusters: num(cov.clusters) ?? 0,
      failed: list(cov.failed).map(str).filter(Boolean),
    },
    errors: list(body.errors).filter(isObj).map((e) => ({ source: str(e.source), message: str(e.message) })),
  };
}

// ---- formatting --------------------------------------------------------------

const tone2 = (v: number | null) => (v === null ? NO_DATA : signed(v, 2));
const move = (v: number | null, u: 'pct' | 'bp') => (v === null ? NO_DATA : signed(v, u === 'bp' ? 1 : 2, u === 'bp' ? ' б.п.' : '%'));
/** Green is reserved for a price rising; a falling price is red; nothing else is coloured. */
const moveClass = (v: number | null) => (v === null || v === 0 ? 'flat' : v > 0 ? 'up' : 'down');
const hoursAgo = (t: number, now: number) => {
  const hrs = Math.max(0, (now - t) / 3600_000);
  return hrs < 1 ? `${Math.max(1, Math.round(hrs * 60))} мин назад` : hrs < 48 ? `${Math.round(hrs)} ч назад` : `${Math.round(hrs / 24)} д назад`;
};

const cell = (text: string | Node, cls = '', label = '') => h('td', { class: cls, 'data-label': label || null }, text);

function table(headers: [string, string][], rows: HTMLElement[]): HTMLElement {
  return h(
    'table',
    { class: 'wd-table' },
    h('thead', {}, h('tr', {}, ...headers.map(([text, cls]) => h('th', { class: cls, scope: 'col' }, text)))),
    h('tbody', {}, ...rows),
  );
}

// ---- panels ------------------------------------------------------------------

function companyLink(c: Company, onSelect: (symbol: string) => void): HTMLElement {
  return h(
    'a',
    {
      class: 'chip wd-company',
      href: `/dossier.html?symbol=${encodeURIComponent(c.symbol)}`,
      title: `${c.basis} (связь по упоминанию, стране или сектору, не оценка влияния)`,
      onclick: (event: MouseEvent) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onSelect(c.symbol);
      },
    },
    `${c.symbol} · ${c.name}`,
  );
}

function breakdown(event: WorldEvent, weights: Record<string, number>): HTMLElement {
  const rows = FACTORS.map(([key, label]) => {
    const value = event.parts[key];
    const weight = weights[key];
    const points = event.contrib[key];
    return h(
      'tr',
      {},
      cell(label),
      cell(value === undefined ? NO_DATA : fixed(value, 2), 'num', 'значение'),
      cell(weight === undefined ? NO_DATA : fixed(weight, 2), 'num', 'вес'),
      cell(points === undefined ? NO_DATA : fixed(points, 1), 'num', 'баллы'),
    );
  });
  return table(
    [
      ['Фактор', ''],
      ['Значение 0–1', 'num'],
      ['Вес', 'num'],
      ['Баллы', 'num'],
    ],
    [
      ...rows,
      h('tr', { class: 'wd-total' }, cell('Итого (из 100)'), cell(''), cell(''), cell(fixed(event.score, 1), 'num', 'баллы')),
    ],
  );
}

function assetLine(a: Asset): HTMLElement {
  if (!a.observed) return h('li', {}, h('b', {}, a.name), ` ${a.reason || NO_DATA}`);
  const o = a.observed;
  return h(
    'li',
    {},
    h('b', {}, a.name),
    ' ',
    h('span', { class: `mono ${moveClass(o.change)}` }, move(o.change, o.unit)),
    h('span', { class: 'muted' }, ` · z ${signed(o.z, 1)} · сессий ${o.sessions}`),
  );
}

function eventCard(
  event: WorldEvent,
  rank: number,
  world: World,
  onSelect: (symbol: string) => void,
): HTMLElement {
  const now = world.updatedAt;
  const regionLabels = new Map(world.regions.map((r) => [r.id, r.label]));
  const bar = h('span', { class: 'wd-bar', role: 'img', 'aria-label': `Значимость ${fixed(event.score, 1)} из 100` }, h('i', {}));
  (bar.firstElementChild as HTMLElement).style.width = `${Math.max(0, Math.min(100, event.score))}%`;
  const independent = event.independent === null ? '' : ` (независимых ≈ ${fixed(event.independent, 1)})`;
  return h(
    'article',
    { class: 'wd-event' },
    h(
      'div',
      { class: 'wd-event-head' },
      h('span', { class: 'wd-rank mono' }, `#${rank}`),
      h('span', { class: 'wd-score mono' }, fixed(event.score, 1)),
      bar,
      h('span', { class: 'tag' }, event.typeLabel),
      ...event.regions.slice(0, 3).map((id) => h('span', { class: 'badge' }, regionLabels.get(id) ?? id)),
      h('span', { class: 'time' }, hoursAgo(event.lastAt, now)),
    ),
    h('h3', { class: 'wd-title' }, link(event.url, event.title)),
    h(
      'p',
      { class: 'wd-meta muted' },
      `Источников: ${event.sourceCount}${independent} · публикаций: ${event.articles} · тон заголовков (словарь): ${tone2(event.tone)} · первое сообщение ${stamp(event.firstAt)}`,
    ),
    event.companies.length
      ? h(
          'div',
          { class: 'wd-companies' },
          h('span', { class: 'muted' }, 'Досье компаний: '),
          ...event.companies.map((c) => companyLink(c, onSelect)),
        )
      : null,
    // The world page is Russian-only.
    consequencesBlock(event.consequences, `world-${event.id}`, 'ru'),
    h(
      'details',
      { class: 'wd-details', open: rank === 1 },
      h('summary', {}, 'Разбор балла, источники и наблюдаемые движения'),
      h('div', { class: 'wd-detail-grid' },
        h('div', {}, h('h4', {}, 'Из чего сложен балл'), breakdown(event, world.weights)),
        h(
          'div',
          {},
          h('h4', {}, 'Источники'),
          h(
            'ul',
            { class: 'wd-list' },
            ...event.sources.map((src) =>
              h('li', {}, link(src.url, src.name || 'источник'), h('span', { class: 'muted' }, ` · ранг ${src.tier} · ${stamp(src.time)}`)),
            ),
          ),
          h('h4', {}, 'Рынок с закрытия перед датой события'),
          event.assets.length ? h('ul', { class: 'wd-list' }, ...event.assets.map(assetLine)) : h('p', { class: 'muted' }, NO_DATA),
          h('p', { class: 'muted wd-note' }, 'Совпадение во времени, не причинность.'),
        ),
      ),
    ),
  );
}

function regionPanel(world: World): HTMLElement {
  const max = Math.max(1, ...world.regions.map((r) => r.significance));
  const rows = world.regions.map((r) => {
    const bar = h('span', { class: 'wd-bar' }, h('i', {}));
    (bar.firstElementChild as HTMLElement).style.width = `${(100 * r.significance) / max}%`;
    return h('tr', {}, cell(r.label), cell(String(r.events), 'num', 'событий'), cell(tone2(r.tone), 'num', 'тон'), cell(fixed(r.significance, 0), 'num', 'Σ значимости'), cell(bar, 'wd-barcell'));
  });
  return panel(
    'Регионы',
    '40 крупнейших событий',
    world.regions.length
      ? table(
          [
            ['Регион', ''],
            ['События', 'num'],
            ['Тон', 'num'],
            ['Σ значимости', 'num'],
            ['', 'wd-barcell'],
          ],
          rows,
        )
      : h('div', { class: 'empty' }, NO_DATA),
  );
}

function marketPanel(world: World): HTMLElement {
  const rows = world.markets.map((m) =>
    h(
      'tr',
      {},
      cell(h('span', {}, m.name, m.stale ? h('span', { class: 'badge wd-stale' }, 'давно') : null)),
      cell(m.price === null ? NO_DATA : fixed(m.price, Math.abs(m.price) < 20 ? 4 : 2), 'num', 'уровень'),
      cell(move(m.change1d, m.unit), `num ${moveClass(m.change1d)}`, '1 д'),
      cell(move(m.change5d, m.unit), `num ${moveClass(m.change5d)}`, '5 д'),
      cell(m.z1d === null ? NO_DATA : signed(m.z1d, 1), 'num', 'z (1 д)'),
    ),
  );
  return panel(
    'Рынки: контекст',
    'Yahoo Finance, дневные закрытия',
    world.markets.length
      ? table(
          [
            ['Инструмент', ''],
            ['Уровень', 'num'],
            ['1 д', 'num'],
            ['5 д', 'num'],
            ['z (1 д)', 'num'],
          ],
          rows,
        )
      : h('div', { class: 'empty' }, NO_DATA),
  );
}

function impactPanel(world: World): HTMLElement {
  const rows: HTMLElement[] = [];
  for (const [i, event] of world.events.entries()) {
    for (const a of event.assets) {
      const o = a.observed;
      rows.push(
        h(
          'tr',
          {},
          cell(`#${i + 1}`, 'mono', 'событие'),
          cell(h('span', { class: 'clamp' }, event.title), 'wd-event-cell'),
          cell(a.name, '', 'инструмент'),
          cell(o ? move(o.change, o.unit) : (a.reason || NO_DATA), `num ${o ? moveClass(o.change) : 'muted'}`, 'изменение'),
          cell(o ? signed(o.z, 1) : NO_DATA, 'num', 'z'),
          cell(o ? String(o.sessions) : NO_DATA, 'num', 'сессий'),
        ),
      );
    }
  }
  return panel(
    'События и рынки',
    'с закрытия сессии перед датой события; z к 60-дневной волатильности',
    rows.length
      ? table(
          [
            ['#', ''],
            ['Событие', ''],
            ['Инструмент', ''],
            ['Изменение', 'num'],
            ['z', 'num'],
            ['Сессий', 'num'],
          ],
          rows,
        )
      : h('div', { class: 'empty' }, NO_DATA),
    h('p', { class: 'wd-note muted' }, 'Совпадение во времени, не причинность: |z| около 2 и выше означает, что движение необычно для последних 60 сессий, но не доказывает связь с событием.'),
  );
}

const TICK = (t: number) => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function chart(timeline: Timeline): SVGSVGElement {
  const [W, H, L, R, T, B] = [640, 190, 38, 40, 10, 24];
  const base = timeline.volume ?? timeline.tone ?? [];
  const n = base.length;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'wd-chart', role: 'img', preserveAspectRatio: 'xMidYMid meet' });
  root.append(svg('title', {}, 'Объём сообщений (столбцы) и тон (линия) за 72 часа'));
  const bw = plotW / n;
  const volume = timeline.volume;
  const maxV = Math.max(1, ...(volume ?? []).map((p) => p.value ?? 0));
  root.append(svg('line', { x1: L, x2: W - R, y1: T + plotH, y2: T + plotH, class: 'wd-axisline' }));
  if (volume) {
    volume.forEach((p, i) => {
      const height = ((p.value ?? 0) / maxV) * plotH;
      root.append(svg('rect', { x: L + i * bw + 0.5, y: T + plotH - height, width: Math.max(1, bw - 1), height, class: 'wd-vol' }));
    });
    root.append(svg('text', { x: L - 4, y: T + 8, class: 'wd-axis', 'text-anchor': 'end' }, fixed(maxV, 0)));
    root.append(svg('text', { x: L - 4, y: T + plotH, class: 'wd-axis', 'text-anchor': 'end' }, '0'));
  }
  const tone = timeline.tone;
  if (tone) {
    const m = Math.max(0.1, ...tone.map((p) => Math.abs(p.value ?? 0)));
    const y = (v: number) => T + plotH / 2 - (v / m) * (plotH / 2);
    let d = '';
    let pen = false;
    tone.forEach((p, i) => {
      if (p.value === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${(L + i * bw + bw / 2).toFixed(1)} ${y(p.value).toFixed(1)} `;
      pen = true;
    });
    root.append(svg('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'wd-zero' }));
    root.append(svg('path', { d: d.trim(), class: 'wd-tone', fill: 'none' }));
    root.append(svg('text', { x: W - R + 4, y: T + 8, class: 'wd-axis' }, signed(m, m < 1 ? 2 : 1)));
    root.append(svg('text', { x: W - R + 4, y: y(0) + 3, class: 'wd-axis' }, '0'));
    root.append(svg('text', { x: W - R + 4, y: T + plotH, class: 'wd-axis' }, signed(-m, m < 1 ? 2 : 1)));
  }
  [0, Math.floor((n - 1) / 2), n - 1].forEach((i, k) => {
    root.append(svg('text', { x: L + i * bw + bw / 2, y: H - 6, class: 'wd-axis', 'text-anchor': k === 0 ? 'start' : k === 2 ? 'end' : 'middle' }, TICK(base[i]?.t ?? 0)));
  });
  return root;
}

function timelinePanel(world: World): HTMLElement {
  const tl = world.timeline;
  return panel(
    'Объём и тон сообщений',
    tl ? (tl.source === 'gdelt' ? 'GDELT' : 'ленты') : null,
    tl
      ? h(
          'div',
          { class: 'wd-chart-wrap' },
          chart(tl),
          h('p', { class: 'wd-legend muted' }, h('span', { class: 'wd-key wd-key-vol' }), 'столбцы: объём ', h('span', { class: 'wd-key wd-key-tone' }), 'линия: тон. ', world.timelineNote),
        )
      : h('div', { class: 'empty' }, NO_DATA),
  );
}

function coveragePanel(world: World): HTMLElement {
  const c = world.coverage;
  const gdelt = c.gdeltAsked === 0 ? NO_DATA : `опрошено ${c.gdeltAsked}, ответило ${c.gdeltOk} (статей ${c.gdeltArticles})`;
  return h(
    'section',
    { class: 'wd-coverage panel' },
    h(
      'p',
      { class: 'wd-coverage-line' },
      h('b', {}, 'Покрытие источников. '),
      `Ленты: опрошено ${c.feedsAsked}, ответило ${c.feedsOk}, заголовков ${c.feedItems}. GDELT: ${gdelt}. Рынки: опрошено ${c.marketsAsked}, ответило ${c.marketsOk}. Событий после объединения дублей: ${c.clusters}.`,
      c.failed.length ? ` Не ответили: ${c.failed.join(', ')}.` : '',
    ),
    sourceIssues(world.errors),
    h(
      'p',
      { class: 'wd-note muted' },
      'Как считается значимость. Балл = 100 × сумма (вес × фактор). Факторы: число независимых источников с убывающей отдачей 1 − exp(−n/3), надёжность трёх лучших источников, свежесть exp(−½(возраст/24 ч)²), модуль тона заголовка, априорный вес типа события и сюрприз движения рынка tanh(max|z|/2,5). Веса экспертные и на истории не подбирались. Тон заголовка оценивается по словарю, это не языковая модель.',
    ),
  );
}

// ---- view --------------------------------------------------------------------

export function worldView(options: { onSelect: (symbol: string) => void }): { el: HTMLElement; dispose: () => void } {
  const el = h('div', { class: 'world' });
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let data: World | null = null;
  let signature = '';
  let failure = '';
  let loading = true;

  const refreshButton = h('button', { type: 'button', class: 'chip', onclick: () => void load() }, 'Обновить');
  const stampEl = h('span', {});
  const stampText = () =>
    data ? `Окно ${data.windowHours} ч. Данные от ${stamp(data.updatedAt)}. Страница обновляется не чаще раза в минуту.` : 'Окно 72 ч.';

  function render(): void {
    stampEl.textContent = stampText();
    const head = h(
      'header',
      { class: 'wd-top' },
      h('h1', {}, 'Мир: главные события и их влияние'),
      h('p', { class: 'muted' }, stampEl, ' ', refreshButton),
    );
    const parts: Node[] = [head];
    if (failure) {
      parts.push(h('div', { class: data ? 'banner' : 'empty error' }, h('span', {}, `${data ? 'Не удалось обновить, показаны прежние данные. ' : ''}${failure}`)));
    }
    if (!data) {
      parts.push(loading && !failure ? h('div', { class: 'empty' }, 'Загрузка…') : h('div', { class: 'empty' }, NO_DATA));
      el.replaceChildren(...parts);
      return;
    }
    const world = data;
    parts.push(
      world.events.length
        ? panel('Главные события', `топ ${world.events.length} по значимости`, h('div', { class: 'wd-events' }, ...world.events.map((e, i) => eventCard(e, i + 1, world, options.onSelect))))
        : panel('Главные события', null, h('div', { class: 'empty' }, NO_DATA)),
      h('div', { class: 'wd-grid' }, regionPanel(world), marketPanel(world)),
      timelinePanel(world),
      impactPanel(world),
      coveragePanel(world),
    );
    el.replaceChildren(...parts);
  }

  function schedule(): void {
    clearTimeout(timer);
    if (!disposed && !document.hidden) timer = setTimeout(() => void load(), POLL_MS);
  }

  async function load(): Promise<void> {
    if (disposed) return;
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const timeout = setTimeout(() => mine.abort(), TIMEOUT_MS);
    try {
      // The page is Russian-only, so it always asks for Russian headlines.
      const res = await fetch(`${ENDPOINT}&tl=ru`, { signal: mine.signal, headers: { Accept: 'application/json' } });
      const body: unknown = await res.json().catch(() => null);
      localizeHeadlines(body);
      if (!res.ok) throw new Error(isObj(body) && str(body.error) ? `Ошибка ${res.status}: ${str(body.error)}` : `Ошибка ${res.status}`);
      if (!isObj(body)) throw new Error('Некорректный ответ сервера');
      const next = parseWorld(body);
      const sig = JSON.stringify({ ...next, updatedAt: 0 });
      const recovered = failure !== '';
      failure = '';
      loading = false;
      if (sig !== signature || !data || recovered) {
        signature = sig;
        data = next;
        render();
      } else {
        // Same content: keep the page exactly as it is, only move the timestamp.
        data = { ...data, updatedAt: next.updatedAt };
        stampEl.textContent = stampText();
      }
    } catch (error) {
      if (mine.signal.aborted && disposed) return;
      loading = false;
      failure = mine.signal.aborted ? 'Сервер не ответил вовремя.' : error instanceof Error ? error.message : 'Сеть недоступна.';
      render();
    } finally {
      clearTimeout(timeout);
      schedule();
    }
  }

  const onVisible = () => {
    if (!document.hidden && !disposed) void load();
  };
  document.addEventListener('visibilitychange', onVisible);
  render();
  void load();

  return {
    el,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
