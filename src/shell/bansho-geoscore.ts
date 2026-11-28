// Geopolitical score: ranked list under the map, the block inside a map popup and the hover
// line of a map tooltip. Data: /api/dossier?view=geoscore. Formulas: docs/math/geoscore.md
import './bansho-geoscore.css';

interface Component {
  id: string;
  label: string;
  value: number | null;
  sd: number | null;
  weight: number | null;
  points: number | null;
  note: string | null;
  reason: string | null;
}
interface Scored {
  score: number | null;
  low: number | null;
  high: number | null;
  raw: number | null;
  shrinkage: number | null;
  priorPart: number | null;
  coverage: number;
  explain: string;
  components: Component[];
}
interface Point extends Scored { key: string; layer: string; name: string; rank: number | null }
interface WorldEvent extends Scored { id: string; title: string; titleRu?: string; url: string; type: string }
interface Payload {
  updatedAt: number;
  counts: { points: number; scored: number };
  points: Point[];
  events: WorldEvent[];
  index: Record<string, [number, number, number]>;
  sources: { feeds: number; feedsOk: number; instability: boolean; world: boolean };
  method: { headlines: number; prior: { mean: number; betweenSd: number; n: number } | null };
}

const API = '/api/dossier?view=geoscore';
const POLL_MS = 5 * 60_000;
const NO_DATA = 'нет данных';
const LAYERS: Record<string, string> = {
  hotspot: 'Горячие точки', conflict: 'Зоны конфликта', base: 'Военные базы', nuclear: 'Ядерные объекты', waterway: 'Проливы',
};
// Popup types that describe a fixed point worth scoring.
const POPUP_TYPES = new Set([...Object.keys(LAYERS), 'economic', 'irradiator', 'spaceport', 'mineral', 'port', 'datacenter', 'outage', 'natEvent', 'earthquake']);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const num = (value: number | null | undefined, digits = 4) => (
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits).replace('.', ',') : NO_DATA
);
const range = (s: Scored) => (s.low === null || s.high === null ? NO_DATA : `${num(s.low)} – ${num(s.high)}`);
const percent = (value: number) => `${num(value * 100, 0)}%`;

async function load<T>(query: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API}${query}`, { signal: signal ?? AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

/** Score, interval, explanation and the additive decomposition. */
function breakdown(s: Scored): HTMLElement {
  const box = el('div', 'bg-breakdown');
  box.append(el('p', 'bg-explain', s.explain));
  const table = el('table');
  const head = el('tr');
  head.append(el('th', '', 'Фактор (значение 0–1 ± σ)'), el('th', 'bg-num', 'Баллы'));
  table.append(head);
  for (const c of s.components) {
    const row = el('tr');
    const name = el('td');
    name.append(el('span', '', c.label));
    name.append(el('small', '', c.value === null
      ? `${NO_DATA}: ${c.reason ?? ''}`
      : `${num(c.value)} ± ${num(c.sd)}${c.weight === null ? '' : `, вес ${num(c.weight)}`}${c.note ? ` · ${c.note}` : ''}`));
    if (c.points !== null) {
      const track = el('i', 'bg-track');
      const fill = el('b');
      fill.style.width = `${Math.min(100, Math.max(0, (c.value ?? 0) * 100))}%`;
      track.append(fill);
      name.append(track);
    }
    row.append(name, el('td', 'bg-num', c.points === null ? '—' : num(c.points)));
    table.append(row);
  }
  if (s.priorPart !== null) {
    const row = el('tr');
    const name = el('td');
    name.append(el('span', '', 'Априорный уровень (усадка)'), el('small', '', `доверие к собственным данным λ = ${num(s.shrinkage)}; сырой балл ${num(s.raw)}`));
    row.append(name, el('td', 'bg-num', num(s.priorPart)));
    table.append(row);
  }
  box.append(table);
  return box;
}

function headline(s: Scored): HTMLElement {
  const line = el('div', 'bg-headline');
  line.append(el('strong', '', s.score === null ? NO_DATA : num(s.score)));
  line.append(el('span', '', s.score === null
    ? `покрытие весов ${percent(s.coverage)}`
    : `из 100 · 90% интервал ${range(s)} · покрытие ${percent(s.coverage)}`));
  return line;
}

// Marker kinds of the 3D globe that name the same layers.
const ALIASES: Record<string, string> = { milbase: 'base', nuclearSite: 'nuclear', conflictZone: 'conflict' };

/** Add the score block to an open map popup (or a globe marker card). */
export function attachGeoScore(popup: HTMLElement, kind: string, data: unknown, onLayout: () => void): void {
  const type = ALIASES[kind] ?? kind;
  if (!POPUP_TYPES.has(type) || !data || typeof data !== 'object') return;
  const d = data as { id?: unknown; name?: unknown; lat?: unknown; lon?: unknown; center?: unknown; country?: unknown; title?: unknown; _lat?: unknown; _lng?: unknown };
  const center = Array.isArray(d.center) ? d.center : null;
  const lat = Number(d.lat ?? d._lat ?? center?.[1] ?? Number.NaN);
  const lon = Number(d.lon ?? d._lng ?? center?.[0] ?? Number.NaN);
  const query = new URLSearchParams();
  if (LAYERS[type] && typeof d.id === 'string') query.set('point', `${type}:${d.id}`);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    query.set('lat', String(lat));
    query.set('lon', String(lon));
    query.set('name', String(d.name ?? d.title ?? '').slice(0, 120));
    if (typeof d.country === 'string') query.set('country', d.country.slice(0, 60));
  }
  if (!query.size) return;
  const box = el('div', 'bansho-geoscore bg-popup');
  box.append(el('h4', '', 'Геополитическая оценка'));
  const status = el('p', 'bg-muted', 'Расчёт по лентам, индексу стран и слоям карты…');
  box.append(status);
  const header = popup.querySelector('.popup-header');
  if (header) header.after(box);
  else popup.append(box);
  onLayout();
  load<{ point: Point | null }>(`&${query}`).then(({ point }) => {
    if (!box.isConnected) return;
    if (!point) {
      status.textContent = `Оценка: ${NO_DATA}.`;
      return;
    }
    const details = el('details');
    details.open = true;
    details.append(el('summary', '', 'Разложение по факторам'), breakdown(point));
    details.addEventListener('toggle', onLayout);
    status.replaceWith(headline(point), details);
    onLayout();
  }).catch((error: unknown) => {
    status.textContent = `Оценка недоступна: ${error instanceof Error ? error.message : String(error)}`;
  });
}

let hoverIndex: Payload['index'] | null = null;
let hoverLoadedAt = 0;

/** HTML line for a map tooltip; empty until the index has arrived or for unscored markers. */
export function geoScoreHover(layerId: string, object: unknown): string {
  const layer = Object.keys(LAYERS).find((name) => layerId.includes(name));
  const o = object as { id?: unknown; properties?: { id?: unknown } } | null;
  const id = o?.properties?.id ?? o?.id;
  if (!layer || typeof id !== 'string') return '';
  if (Date.now() - hoverLoadedAt > POLL_MS) {
    hoverLoadedAt = Date.now();
    load<Payload>('&limit=1').then((body) => { hoverIndex = body.index; }).catch(() => { hoverLoadedAt = Date.now() - POLL_MS + 30_000; });
  }
  const hit = hoverIndex?.[`${layer}:${id}`];
  return hit ? `<div class="bg-hover">Геооценка ${num(hit[0])} <span>[${num(hit[1])} – ${num(hit[2])}]</span></div>` : '';
}

export function mountBanshoGeoscore(container: HTMLElement): () => void {
  const root = el('div', 'bansho-geoscore bg-panel');
  const title = el('h3', '', 'Геополитическая оценка точек');
  const status = el('p', 'bg-muted', 'Расчёт: ленты новостей, индекс стран, слои карты, котировки…');
  const body = el('div');
  root.append(title, status, body);
  container.append(root);

  const abort = new AbortController();
  let timer = 0;
  let layer = 'all';
  let selected: string | null = null;
  let data: Payload | null = null;

  const item = (key: string, label: HTMLElement, s: Scored, meta: string) => {
    const wrap = el('div', 'bg-item');
    const button = el('button', 'bg-row');
    button.type = 'button';
    button.setAttribute('aria-expanded', String(selected === key));
    const name = el('span', 'bg-name');
    name.append(label, el('small', '', meta));
    const value = el('span', 'bg-num');
    value.append(el('strong', '', num(s.score)), el('small', '', range(s)));
    button.append(name, value);
    button.addEventListener('click', () => {
      selected = selected === key ? null : key;
      render();
    });
    wrap.append(button);
    if (selected === key) wrap.append(breakdown(s));
    return wrap;
  };

  const render = () => {
    if (!data) return;
    const filters = el('div', 'bg-filters');
    for (const [id, label] of [['all', 'Все слои'], ...Object.entries(LAYERS)] as [string, string][]) {
      const button = el('button', id === layer ? 'bg-on' : '', label);
      button.type = 'button';
      button.addEventListener('click', () => { layer = id; render(); });
      filters.append(button);
    }
    const points = el('div', 'bg-list');
    const shown = data.points.filter((p) => layer === 'all' || p.layer === layer).slice(0, 25);
    shown.forEach((p, i) => points.append(item(p.key, el('span', '', `${i + 1}. ${p.name}`), p, `${LAYERS[p.layer] ?? p.layer} · покрытие ${percent(p.coverage)}`)));
    if (!shown.length) points.append(el('p', 'bg-muted', NO_DATA));

    const events = el('div', 'bg-list');
    for (const event of data.events.filter((e) => e.score !== null).slice(0, 15)) {
      const label = el('span', '', event.titleRu || event.title);
      const entry = item(`event:${event.id}`, label, event, `${event.type} · покрытие ${percent(event.coverage)}`);
      if (selected === `event:${event.id}` && /^https?:\/\//.test(event.url)) {
        const link = el('a', 'bg-link', 'Открыть источник');
        link.href = event.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        entry.append(link);
      }
      events.append(entry);
    }
    if (!events.childElementCount) events.append(el('p', 'bg-muted', `События: ${NO_DATA}`));

    const columns = el('div', 'bg-columns');
    const left = el('section');
    left.append(el('h4', '', 'Точки карты'), filters, points);
    const right = el('section');
    right.append(el('h4', '', 'События'), events);
    columns.append(left, right);
    const prior = data.method.prior;
    const method = el('p', 'bg-muted bg-method',
      `Балл = 100 · [λ·M + (1 − λ)·μ], M = (Σ wᵢxᵢ² / Σ wᵢ)^½ по измеренным факторам; λ = τ² / (τ² + σ²); интервал 90% = балл ± 1,6449·100·√(λσ²). ${
        prior ? `μ = ${num(prior.mean)}, τ = ${num(prior.betweenSd)} по ${prior.n} точкам. ` : ''}Веса экспертные, не откалиброваны на истории. Метод: docs/math/geoscore.md.`);
    body.replaceChildren(columns, method);
  };

  const refresh = async () => {
    try {
      data = await load<Payload>('&limit=1000&tl=ru', AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]));
      hoverIndex = data.index;
      hoverLoadedAt = Date.now();
      const missing = [!data.sources.instability && 'индекс нестабильности', !data.sources.world && 'мировые события'].filter(Boolean);
      status.textContent = `Оценено ${data.counts.scored} из ${data.counts.points} точек · заголовков ${data.method.headlines} · лент ${data.sources.feedsOk} из ${data.sources.feeds} · ${
        new Date(data.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}${missing.length ? ` · ${NO_DATA}: ${missing.join(', ')}` : ''}`;
      render();
    } catch (error) {
      if (abort.signal.aborted) return;
      status.textContent = `${data ? 'Не удалось обновить' : 'Оценка недоступна'}: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!abort.signal.aborted) timer = window.setTimeout(refresh, data?.sources.instability && data.sources.world ? POLL_MS : 60_000);
  };
  void refresh();

  return () => {
    abort.abort();
    window.clearTimeout(timer);
    root.remove();
  };
}
