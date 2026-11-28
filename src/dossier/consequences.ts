// "Economic consequences" of one event: a one-line summary that expands into the full block.
// The data is the `consequences` field of /api/dossier (api/_dossier/math/consequences.js).
// Shared by the dossier and the dashboard, so it depends on neither's helpers or i18n.
import './consequences.css';

type Lang = 'ru' | 'en';
type Obj = Record<string, unknown>;

const TEXT = {
  ru: {
    title: 'Экономические последствия', none: 'нет данных', direction: 'Направление и неопределённость', observed: 'Что наблюдалось',
    magnitude: 'Масштаб и интервал', horizon: 'Горизонт', evidence: 'Значимость и подтверждение',
    channels: 'Каналы передачи', typical: 'типичные для такого вида событий, не измеренные факты',
    exposed: 'Затрагиваемые инструменты', confidence: 'Надёжность оценки', watch: 'Что отслеживать, чтобы подтвердить или опровергнуть',
    sessions: 'Сессий', corridor: '80% исходов', widening: 'Поправка на тип', analogues: 'Похожих',
    plain: 'От последнего закрытия, центр на нуле: направление не прогнозируется. ×1 — обычная волатильность акции.',
    kinds: { company: 'компания', peer: 'другая компания', index: 'индекс', fx: 'валюта', commodity: 'сырьё', yield: 'доходность', crypto: 'криптовалюта', stock: 'акция', market: 'рынок' },
  },
  en: {
    title: 'Economic consequences', none: 'no data', direction: 'Direction and uncertainty', observed: 'What was observed',
    magnitude: 'Size and interval', horizon: 'Horizon', evidence: 'Significance and corroboration',
    channels: 'Transmission channels', typical: 'typical for this kind of event, not measured facts',
    exposed: 'Exposed instruments', confidence: 'Confidence', watch: 'What to watch to confirm or refute',
    sessions: 'Sessions', corridor: '80% of outcomes', widening: 'Type factor', analogues: 'Similar',
    plain: 'From the last close, centred on zero: direction is not forecast. ×1 is the ordinary volatility of the stock.',
    kinds: { company: 'company', peer: 'other company', index: 'index', fx: 'currency', commodity: 'commodity', yield: 'yield', crypto: 'crypto', stock: 'stock', market: 'market' },
  },
} as const;

/** Lists are redrawn on every poll; this keeps what the visitor opened or closed. */
const opened = new Map<string, boolean>();

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function body(data: Obj, lang: Lang): HTMLElement {
  const t = TEXT[lang];
  const signed = (v: number) => `${v > 0 ? '+' : ''}${v.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const section = (title: string, ...children: Node[]) => el('section', '', el('h5', '', title), ...children);
  const paragraph = (text: string) => el('p', '', text || t.none);
  const bullets = (items: unknown) => {
    const texts = list(items).map(str).filter(Boolean);
    return texts.length ? el('ul', '', ...texts.map((x) => el('li', '', x))) : paragraph('');
  };

  const magnitude = isObj(data.magnitude) ? data.magnitude : {};
  const horizons = list(magnitude.horizons).filter(isObj);
  const table = el('table');
  if (horizons.length) {
    table.append(el('tr', '', ...[t.sessions, t.corridor, t.widening, t.analogues].map((x) => el('th', '', x))));
    for (const row of horizons) {
      const h = num(row.h);
      const low = num(row.low80Pct);
      const high = num(row.high80Pct);
      const factor = num(row.multiplier);
      const n = num(row.n);
      const cells = [
        h === null ? t.none : String(h),
        low === null || high === null ? t.none : `${signed(low)} … ${signed(high)}`,
        factor === null ? t.none : `×${factor}`,
        n === null ? t.none : String(n),
      ];
      table.append(el('tr', '', ...cells.map((x) => el('td', '', x))));
    }
  }

  const channels = list(data.channels).filter(isObj);
  const exposed = list(data.exposed).filter(isObj);
  const confidence = isObj(data.confidence) ? data.confidence : {};
  const direction = isObj(data.direction) ? data.direction : {};

  return el(
    'div',
    'cq-body',
    el('p', 'cq-summary', str(data.summary)),
    section(t.direction, paragraph(str(direction.text))),
    section(t.observed, bullets(data.observed)),
    section(
      t.magnitude,
      paragraph(str(magnitude.text)),
      ...(horizons.length ? [el('div', 'cq-scroll', table)] : []),
      ...(horizons.length ? [el('p', 'cq-note', t.plain)] : []),
    ),
    section(t.horizon, paragraph(str(data.horizon))),
    section(t.evidence, bullets(data.evidence)),
    section(
      t.channels,
      el('p', 'cq-note', t.typical),
      channels.length ? el('dl', '', ...channels.flatMap((x) => [el('dt', '', str(x.label)), el('dd', '', str(x.text))])) : paragraph(''),
    ),
    section(
      t.exposed,
      exposed.length
        ? el('ul', 'cq-exposed', ...exposed.map((x) => {
          const kind = (t.kinds as Record<string, string>)[str(x.kind)] ?? '';
          const symbol = str(x.symbol);
          const name = str(x.name);
          return el(
            'li',
            '',
            el('b', '', name && name !== symbol ? `${name} (${symbol})` : symbol || name),
            el('span', '', ` — ${[kind, str(x.note)].filter(Boolean).join('; ')}`),
          );
        }))
        : paragraph(''),
    ),
    section(t.confidence, paragraph(str(confidence.label)), bullets(confidence.reasons)),
    section(t.watch, bullets(data.watch)),
    el('p', 'cq-note', str(data.caveat)),
  );
}

/**
 * The block for one event. `key` identifies the event within its list. Clicks stay inside the block,
 * so rows and cards around it neither navigate nor change selection.
 */
export function consequencesBlock(data: unknown, key: string, lang: Lang): HTMLElement {
  const t = TEXT[lang];
  if (!isObj(data) || !str(data.summary)) return el('div', 'cq cq-empty', `${t.title}: ${t.none}`);
  const summary = el('summary', '', el('span', 'cq-name', t.title), el('span', 'cq-line', str(data.summary)));
  summary.setAttribute('data-key', `cq-${key}`);
  summary.title = str(data.summary);
  const node = el('details', 'cq', summary);
  node.addEventListener('click', (event) => event.stopPropagation());
  // Built on first opening: a list holds up to a couple of hundred events.
  const fill = () => {
    if (node.open && node.childElementCount === 1) node.append(body(data, lang));
  };
  node.addEventListener('toggle', () => {
    opened.set(key, node.open);
    fill();
  });
  node.open = opened.get(key) ?? false;
  fill();
  return node;
}
