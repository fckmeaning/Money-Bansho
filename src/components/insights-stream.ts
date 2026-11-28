import { uiRussian } from '@/utils/ui-russian';
import { getNewsStream, type NewsStreamRow } from '@/services/news-stream';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

const DAY_MS = 24 * 60 * 60 * 1000;
const LATEST_LIMIT = 200;
const TOP_FEEDS = 20;

const CATEGORY_RU: Record<string, string> = {
  politics: 'Мировые новости', us: 'США', europe: 'Европа', middleeast: 'Ближний Восток', africa: 'Африка',
  latam: 'Латинская Америка', asia: 'Азия', 'china-media': 'Китай', 'europe-business': 'Бизнес Европы',
  israel: 'Израиль', 'north-korea': 'КНДР', 'corporate-leadership': 'Руководство компаний', finance: 'Финансы',
  commodities: 'Сырьё', energy: 'Энергетика', tech: 'Технологии', ai: 'ИИ', science: 'Наука', gov: 'Власти',
  thinktanks: 'Аналитические центры', intel: 'Разведка', crisis: 'Кризисы', layoffs: 'Сокращения',
};

/**
 * Counters or lists over every record of the current digest build. Empty string
 * without data. `summary` goes above the picked stories, `latest` below them.
 */
export function renderNewsStreamSection(part: 'summary' | 'latest' | 'all' = 'all'): string {
  const rows = getNewsStream();
  if (rows.length === 0) return '';
  const ru = uiRussian();
  const tr = (en: string, russian: string): string => (ru ? russian : en);
  const dayAgo = Date.now() - DAY_MS;
  const isHigh = (row: NewsStreamRow): boolean => row.l === 'critical' || row.l === 'high';

  const feeds = new Map<string, number>();
  const categories = new Map<string, { total: number; day: number; high: number }>();
  let day = 0;
  let alerts = 0;
  let high = 0;
  for (const row of rows) {
    const fresh = row.p >= dayAgo;
    if (fresh) day++;
    if (row.a) alerts++;
    if (isHigh(row)) high++;
    feeds.set(row.s, (feeds.get(row.s) ?? 0) + 1);
    const bucket = categories.get(row.c) ?? { total: 0, day: 0, high: 0 };
    bucket.total++;
    if (fresh) bucket.day++;
    if (isHigh(row)) bucket.high++;
    categories.set(row.c, bucket);
  }

  const stat = (value: number, label: string): string =>
    `<div class="ins-stream-stat"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`;
  const categoryRows = [...categories.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([key, value]) => `<tr><td>${escapeHtml(ru ? CATEGORY_RU[key] ?? key : key)}</td><td>${value.total}</td><td>${value.day}</td><td>${value.high}</td></tr>`)
    .join('');
  const feedRows = [...feeds.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_FEEDS)
    .map(([name, count]) => `<tr><td>${escapeHtml(name)}</td><td>${count}</td></tr>`)
    .join('');
  const time = new Intl.DateTimeFormat(ru ? 'ru-RU' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const latest = rows.slice(0, LATEST_LIMIT).map((row) => {
    const href = sanitizeUrl(row.u);
    const title = href
      ? `<a href="${href}" target="_blank" rel="noopener">${escapeHtml(row.t)}</a>`
      : `<span>${escapeHtml(row.t)}</span>`;
    const when = Number.isFinite(row.p) && row.p > 0 ? time.format(row.p) : '';
    return `<li>${title}<small>${escapeHtml(when)} · ${escapeHtml(row.s)}</small></li>`;
  }).join('');

  const summaryHtml = `
      <div class="insights-section-title">${tr('Whole news stream', 'Весь поток новостей')}</div>
      <div class="ins-stream-stats">
        ${stat(rows.length, tr('records', 'записей'))}
        ${stat(feeds.size, tr('feeds', 'лент'))}
        ${stat(day, tr('last 24 h', 'за 24 часа'))}
        ${stat(high, tr('critical / high', 'крит. и высокие'))}
        ${stat(alerts, tr('alerts', 'оповещения'))}
        ${stat(categories.size, tr('categories', 'разделов'))}
      </div>
      <table class="ins-stream-table"><thead><tr><th>${tr('Category', 'Раздел')}</th><th>${tr('All', 'Всего')}</th><th>${tr('24 h', '24 ч')}</th><th>${tr('High', 'Высок.')}</th></tr></thead><tbody>${categoryRows}</tbody></table>
      <table class="ins-stream-table"><thead><tr><th>${tr('Feed', 'Лента')}</th><th>${tr('Records', 'Записей')}</th></tr></thead><tbody>${feedRows}</tbody></table>`;
  const latestHtml = `
      <div class="insights-section-title">${tr('Latest', 'Последние')}: ${Math.min(rows.length, LATEST_LIMIT)} ${tr('of', 'из')} ${rows.length}</div>
      <ul class="ins-stream-list">${latest}</ul>`;

  return `
    <div class="insights-section ins-stream">
      ${part === 'latest' ? '' : summaryHtml}
      ${part === 'summary' ? '' : latestHtml}
    </div>
    <style>
      .ins-stream-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; margin-bottom: 8px; }
      .ins-stream-stat { border: 1px solid var(--border); padding: 6px; min-width: 0; }
      .ins-stream-stat strong { display: block; font-size: calc(16px * var(--wm-panel-effective-scale, 1)); color: var(--text); font-variant-numeric: tabular-nums; }
      .ins-stream-stat span { font-size: calc(10px * var(--wm-panel-effective-scale, 1)); color: var(--text-dim); }
      .ins-stream-table { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: calc(11px * var(--wm-panel-effective-scale, 1)); }
      .ins-stream-table th, .ins-stream-table td { border-bottom: 1px solid var(--border); padding: 3px 4px; text-align: right; color: var(--text); font-variant-numeric: tabular-nums; }
      .ins-stream-table th { color: var(--text-dim); font-weight: 600; }
      .ins-stream-table th:first-child, .ins-stream-table td:first-child { text-align: left; }
      .ins-stream-list { list-style: none; margin: 0; padding: 0; }
      .ins-stream-list li { border-bottom: 1px solid var(--border); padding: 5px 0; font-size: calc(12px * var(--wm-panel-effective-scale, 1)); line-height: 1.35; overflow-wrap: anywhere; }
      .ins-stream-list a { color: var(--text); text-decoration: none; }
      .ins-stream-list a:hover { color: var(--accent); }
      .ins-stream-list small { display: block; color: var(--text-dim); font-size: calc(10px * var(--wm-panel-effective-scale, 1)); }
    </style>
  `;
}
