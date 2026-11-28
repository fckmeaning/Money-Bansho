import * as d3 from 'd3';
import { Panel } from './Panel';
import { fetchServerInsights, getServerInsights, type ServerInsights } from '@/services/insights-loader';
import { escapeHtml, sanitizeUrl, unsafeRawHtml } from '@/utils/sanitize';
import type { ClusteredEvent } from '@/types';
import { uiRussian } from '@/utils/ui-russian';
import { getNewsStream, subscribeNewsStream, type NewsStreamRow } from '@/services/news-stream';
import {
  THREAT_LEVELS,
  THREAT_LEVEL_LABELS,
  buildThreatTimelineState,
  buildThreatTimelineStateFromHistory,
  countHighSeverityDays,
  describeThreatTimelineTrend,
  normalizeClusterStories,
  normalizeServerInsightStories,
  type ThreatTimelineDay,
  type ThreatTimelineGroup,
  type ThreatTimelineItem,
  type ThreatTimelineState,
  type TimelineThreatLevel,
  normalizeThreatLevel,
} from './threat-timeline-utils';

// Info is the classifier's no-threat default, not a severity: it moves with
// news volume rather than threat, and at ~45% of stories it flattened the
// levels that matter. The chart and legend show threat levels only.
const CHART_LEVELS = THREAT_LEVELS.filter(level => level !== 'info');
const STACK_LEVELS = [...CHART_LEVELS].reverse() as TimelineThreatLevel[];

interface StackRow {
  key: string;
  label: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

// Muted theme colours; red and yellow only for the two upper levels.
const LEVEL_COLORS: Record<TimelineThreatLevel, string> = {
  critical: 'var(--red, #b4534b)',
  high: 'var(--yellow, #b08d3c)',
  medium: 'var(--accent, #4c82c4)',
  low: 'var(--text-dim, #6b7787)',
  info: 'var(--border-strong, #4a5361)',
};

const isRu = (): boolean => uiRussian();
const tr = (en: string, ru: string): string => (isRu() ? ru : en);

const LEVEL_RU: Record<TimelineThreatLevel, string> = {
  critical: 'Критический',
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
  info: 'Без уровня',
};
const levelLabel = (level: TimelineThreatLevel): string => (isRu() ? LEVEL_RU[level] : THREAT_LEVEL_LABELS[level]);
const TREND_RU: Record<string, string> = { Building: 'Накопление', Quiet: 'Спокойно', Worsening: 'Ухудшение', Easing: 'Смягчение', Noisy: 'Колебания' };
const MONTH_RU: Record<string, string> = { Jan: 'янв', Feb: 'фев', Mar: 'мар', Apr: 'апр', May: 'мая', Jun: 'июн', Jul: 'июл', Aug: 'авг', Sep: 'сен', Oct: 'окт', Nov: 'ноя', Dec: 'дек' };

function trendCopy(copy: string): string {
  if (!isRu()) return copy;
  return copy
    .replace('No critical/high days', 'Нет дней с высоким уровнем')
    .replace(/(\d+) recent vs (\d+) earlier/, 'недавно $1, ранее $2')
    .replace(/(\d+) of (\d+) days fully recorded/, 'полных дней: $1 из $2');
}

/** Rows listed per level when the whole stream is shown. */
const STREAM_ITEMS_PER_LEVEL = 60;

function streamItem(row: NewsStreamRow, index: number): ThreatTimelineItem {
  return {
    id: `stream-${index}`,
    title: row.t,
    source: row.s,
    sourceUrl: row.u,
    category: row.c,
    threatLevel: normalizeThreatLevel(row.l),
    rawThreatLevel: row.l,
    timestampMs: row.p,
    isAlert: row.a,
    sourceCount: 1,
    provenance: row.s,
  };
}

export class ThreatTimelinePanel extends Panel {
  private lastClusters: ClusteredEvent[] = [];
  private unsubscribeStream: (() => void) | null = null;

  constructor() {
    super({
      id: 'threat-timeline',
      title: tr('Threat Timeline', 'Хронология угроз'),
      showCount: false,
      infoTooltip: tr(
        'Stories per day by threat level (critical to low) over the last seven days, each counted once. Unclassified (info) stories are not charted. Levels are assigned by headline keywords or the classifier.',
        'Записи по дням и уровням угроз за семь дней, каждая считается один раз. Записи без уровня на график не выносятся. Уровень присваивается по ключевым словам заголовка или классификатором.',
      ),
      defaultRowSpan: 2,
    });

    this.renderEmpty(tr('Waiting for news data.', 'Ожидаем ленту новостей.'));
    this.unsubscribeStream = subscribeNewsStream(rows => this.updateFromStream(rows));
    const rows = getNewsStream();
    if (rows.length > 0) this.updateFromStream(rows);
  }

  public override destroy(): void {
    this.unsubscribeStream?.();
    super.destroy();
  }

  private updateFromStream(rows: NewsStreamRow[]): void {
    const state = buildThreatTimelineState(rows.map(streamItem), { itemsPerGroup: STREAM_ITEMS_PER_LEVEL });
    this.renderState(state, tr('news stream', 'весь поток лент'), rows);
  }

  public async refresh(fallbackClusters?: ClusteredEvent[]): Promise<void> {
    if (fallbackClusters) {
      this.lastClusters = fallbackClusters;
    }

    const rows = getNewsStream();
    if (rows.length > 0) {
      this.updateFromStream(rows);
      return;
    }

    try {
      const serverInsights = getServerInsights() ?? await fetchServerInsights();
      if (serverInsights) {
        this.updateFromServerInsights(serverInsights);
        return;
      }
    } catch (err) {
      console.warn('[ThreatTimeline] insight refresh failed, falling back to clusters:', err);
    }

    // Keyless build: levels come from keywords in the live headlines.
    this.updateFromClusters(this.lastClusters, 'degraded', 'Уровни угроз определены по ключевым словам в заголовках');
  }

  public updateFromServerInsights(insights: ServerInsights): void {
    const items = normalizeServerInsightStories(insights);
    const options = {
      status: insights.status,
      statusMessage: insights.status === 'degraded' ? 'Server insight snapshot degraded' : '',
    };
    // Payloads seeded before the history existed fall back to binning the
    // top stories, which only ever fills the current day.
    const state = buildThreatTimelineStateFromHistory(insights.threatTimeline, items, options)
      ?? buildThreatTimelineState(items, options);
    this.renderState(state, 'Insights snapshot');
  }

  public updateFromClusters(
    clusters: ClusteredEvent[],
    status: 'ok' | 'degraded' = 'ok',
    statusMessage = '',
  ): void {
    this.lastClusters = clusters;
    const items = normalizeClusterStories(clusters);
    const state = buildThreatTimelineState(items, { status, statusMessage });
    this.renderState(state, status === 'ok' ? 'Live clusters' : 'Cluster fallback');
  }

  private renderState(state: ThreatTimelineState, sourceLabel: string, stream?: NewsStreamRow[]): void {
    this.setCount(state.items.length);
    if (!state.hasData) {
      const message = state.status === 'degraded'
        ? tr('No recent threat metadata available from the intelligence snapshot.', 'Нет данных об уровнях угроз.')
        : tr('No recent threat metadata in the last 7 days.', 'За 7 дней нет записей.');
      this.renderEmpty(message, state.degradedReasons);
      return;
    }

    const highSeverityCount = state.totals.critical + state.totals.high;
    const highSeverityDays = countHighSeverityDays(state);
    const trend = describeThreatTimelineTrend(state.days);
    const total = state.items.length;
    const chart = this.renderChart(state.days);
    const groups = this.renderGroups(state.groups);
    const degradation = state.degradedReasons.length > 0
      ? `<div class="threat-timeline-note">${escapeHtml(state.degradedReasons.join(' | '))}</div>`
      : '';

    this.setDataBadge(state.status === 'ok' ? 'live' : 'cached', state.status === 'ok' ? sourceLabel : tr('headlines', 'по заголовкам'));
    const publishers = stream ? new Set(stream.map(row => row.s)).size : 0;
    this.setSafeContent(unsafeRawHtml(`
      <div class="threat-timeline-panel">
        <div class="threat-timeline-summary">
          <div class="threat-timeline-stat">
            <span class="threat-timeline-stat-value">${highSeverityCount}</span>
            <span class="threat-timeline-stat-label">${tr('Critical / high', 'Крит. и высокие')}</span>
          </div>
          <div class="threat-timeline-stat">
            <span class="threat-timeline-stat-value">${highSeverityDays}</span>
            <span class="threat-timeline-stat-label">${tr('Active days', 'Дней с ними')}</span>
          </div>
          ${stream ? `<div class="threat-timeline-trend">
            <span class="threat-timeline-trend-label">${tr('Records', 'Записей')}: ${total}</span>
            <span class="threat-timeline-trend-copy">${tr('Feeds', 'Лент')}: ${publishers}</span>
          </div>` : `<div class="threat-timeline-trend ${trend.className}">
            <span class="threat-timeline-trend-label">${escapeHtml(isRu() ? TREND_RU[trend.label] ?? trend.label : trend.label)}</span>
            <span class="threat-timeline-trend-copy">${escapeHtml(trendCopy(trend.copy))}</span>
          </div>`}
        </div>
        ${chart}
        <div class="threat-timeline-legend">${(stream ? THREAT_LEVELS : CHART_LEVELS).map(level => `
          <span class="threat-timeline-legend-item">
            <span class="threat-timeline-swatch" style="background:${LEVEL_COLORS[level]}"></span>
            ${levelLabel(level)} <strong>${state.totals[level]}</strong>
          </span>
        `).join('')}</div>
        ${state.historyStoryCount !== undefined ? `<div class="threat-timeline-groups-title">${tr('Top stories now', 'Главное сейчас')}</div>` : ''}
        <div class="threat-timeline-groups" aria-label="${tr('Stories grouped by threat level', 'Записи по уровням угроз')}">
          ${groups}
        </div>
        <div class="threat-timeline-footer">${escapeHtml(this.footerCopy(state, total, sourceLabel))}</div>
        ${degradation}
      </div>
      ${this.renderStyles()}
    `, 'legacy Panel.setContent() migration'));
  }

  private footerCopy(state: ThreatTimelineState, total: number, sourceLabel: string): string {
    const items = isRu()
      ? `Записей: ${total} · ${sourceLabel}`
      : `${total} top stor${total === 1 ? 'y' : 'ies'} from ${sourceLabel}`;
    if (state.historyStoryCount === undefined) return items;
    const stories = state.historyStoryCount;
    if (isRu()) return `Записей об угрозах за 7 дней: ${stories} · ${items}`;
    return `${stories} threat stor${stories === 1 ? 'y' : 'ies'} over 7 days · ${items}`;
  }

  private renderEmpty(message: string, reasons: string[] = []): void {
    this.setCount(0);
    this.setDataBadge('unavailable');
    const reasonHtml = reasons.length > 0
      ? `<div class="threat-timeline-note">${escapeHtml(reasons.join(' | '))}</div>`
      : '';
    this.setSafeContent(unsafeRawHtml(`
      <div class="threat-timeline-panel">
        <div class="threat-timeline-empty">
          <div class="threat-timeline-empty-title">${escapeHtml(message)}</div>
        </div>
        ${reasonHtml}
      </div>
      ${this.renderStyles()}
    `, 'legacy Panel.setContent() migration'));
  }

  private renderChart(days: ThreatTimelineDay[]): string {
    const width = 360;
    const height = 150;
    const margin = { top: 12, right: 10, bottom: 28, left: 24 };
    const rows: StackRow[] = days.map(day => ({
      key: day.key,
      label: day.label,
      critical: day.counts.critical,
      high: day.counts.high,
      medium: day.counts.medium,
      low: day.counts.low,
      info: day.counts.info,
    }));
    const maxTotal = Math.max(1, d3.max(days, day => CHART_LEVELS.reduce((sum, level) => sum + day.counts[level], 0)) ?? 1);
    const x = d3.scaleBand<string>()
      .domain(days.map(day => day.key))
      .range([margin.left, width - margin.right])
      .padding(0.24);
    const y = d3.scaleLinear()
      .domain([0, maxTotal])
      .nice()
      .range([height - margin.bottom, margin.top]);
    const layers = d3.stack<StackRow, TimelineThreatLevel>()
      .keys(STACK_LEVELS)(rows);
    const gridY = y(maxTotal);

    const bars = layers.map(layer => {
      const level = layer.key as TimelineThreatLevel;
      return layer.map((segment, index) => {
        const day = days[index];
        if (!day) return '';
        const xPos = x(day.key);
        if (xPos === undefined) return '';
        const yTop = y(segment[1]);
        const yBottom = y(segment[0]);
        const barHeight = Math.max(0, yBottom - yTop);
        if (barHeight <= 0) return '';
        const partialAttrs = day.partial ? ' opacity="0.45"' : '';
        const partialNote = day.partial ? tr(' (partial day)', ' (неполный день)') : '';
        return `<rect x="${xPos.toFixed(1)}" y="${yTop.toFixed(1)}" width="${x.bandwidth().toFixed(1)}" height="${barHeight.toFixed(1)}" style="fill:${LEVEL_COLORS[level]}"${partialAttrs}>
          <title>${escapeHtml(day.label)} ${levelLabel(level)}: ${day.counts[level]}${partialNote}</title>
        </rect>`;
      }).join('');
    }).join('');

    const labels = days.map(day => {
      const xPos = x(day.key);
      if (xPos === undefined) return '';
      const centerX = (xPos + x.bandwidth() / 2).toFixed(1);
      const [month = '', dayNumber = ''] = day.label.split(' ');
      return `<text x="${centerX}" y="${height - 16}" text-anchor="middle">
        <tspan x="${centerX}" dy="0">${escapeHtml(isRu() ? MONTH_RU[month] ?? month : month)}</tspan>
        <tspan x="${centerX}" dy="10">${escapeHtml(dayNumber)}</tspan>
      </text>`;
    }).join('');

    return `
      <div class="threat-timeline-chart-wrap">
        <svg class="threat-timeline-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${tr('Seven-day threat level distribution', 'Уровни угроз за семь дней')}">
          <line x1="${margin.left}" x2="${width - margin.right}" y1="${gridY.toFixed(1)}" y2="${gridY.toFixed(1)}" class="threat-timeline-grid" />
          <line x1="${margin.left}" x2="${width - margin.right}" y1="${(height - margin.bottom).toFixed(1)}" y2="${(height - margin.bottom).toFixed(1)}" class="threat-timeline-axis" />
          ${bars}
          <g class="threat-timeline-labels">${labels}</g>
        </svg>
      </div>
    `;
  }

  private renderGroups(groups: ThreatTimelineGroup[]): string {
    if (groups.length === 0) {
      return `<div class="threat-timeline-empty-inline">${tr('No grouped alerts in the current window.', 'Нет записей в окне.')}</div>`;
    }
    return groups.map(group => `
      <section class="threat-timeline-group threat-${group.level}">
        <div class="threat-timeline-group-header">
          <span class="threat-timeline-group-name">${escapeHtml(levelLabel(group.level))}</span>
          <span class="threat-timeline-group-count">${group.count}</span>
        </div>
        ${group.items.map(item => this.renderItem(item)).join('')}
      </section>
    `).join('');
  }

  private renderItem(item: ThreatTimelineItem): string {
    const titleCodePoints = Array.from(item.title);
    const title = escapeHtml(titleCodePoints.length > 94 ? `${titleCodePoints.slice(0, 91).join('')}...` : item.title);
    const href = sanitizeUrl(item.sourceUrl);
    const titleHtml = href
      ? `<a href="${href}" target="_blank" rel="noopener" class="threat-timeline-item-title">${title}</a>`
      : `<span class="threat-timeline-item-title">${title}</span>`;
    const source = escapeHtml(item.provenance || item.source || 'News Digest');
    const age = this.formatAge(item.timestampMs);
    const sourceCount = item.sourceCount > 1 ? `<span class="threat-timeline-source-count">${item.sourceCount} ${tr('sources', 'источн.')}</span>` : '';
    return `
      <article class="threat-timeline-item">
        ${titleHtml}
        <div class="threat-timeline-item-meta">
          <span class="threat-timeline-source">${source}</span>
          ${sourceCount}
          <span>${escapeHtml(age)}</span>
        </div>
      </article>
    `;
  }

  private formatAge(timestampMs: number): string {
    const diffMs = Math.max(0, Date.now() - timestampMs);
    const minutes = Math.floor(diffMs / (60 * 1000));
    if (minutes < 1) return tr('just now', 'только что');
    if (minutes < 60) return tr(`${minutes}m ago`, `${minutes} мин назад`);
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return tr(`${hours}h ago`, `${hours} ч назад`);
    const days = Math.floor(hours / 24);
    return tr(`${days}d ago`, `${days} дн назад`);
  }

  private renderStyles(): string {
    return `
      <style>
        .threat-timeline-panel { display: grid; gap: 10px; }
        .threat-timeline-summary { display: grid; grid-template-columns: 76px 76px 1fr; gap: 8px; align-items: stretch; }
        .threat-timeline-stat, .threat-timeline-trend { border: 1px solid var(--border-color); background: var(--bg-secondary); border-radius: 2px; padding: 8px; min-width: 0; }
        .threat-timeline-stat-value { display: block; font-size: calc(20px * var(--wm-panel-effective-scale, 1)); line-height: 1; font-weight: 700; color: var(--text-primary); }
        .threat-timeline-stat-label, .threat-timeline-trend-copy, .threat-timeline-footer, .threat-timeline-note { display: block; font-size: calc(11px * var(--wm-panel-effective-scale, 1)); color: var(--text-secondary); margin-top: 4px; }
        .threat-timeline-groups-title { font-size: calc(11px * var(--wm-panel-effective-scale, 1)); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-secondary); }
        .threat-timeline-trend { border-left: 3px solid var(--accent); }
        .threat-timeline-trend.worsening { border-left-color: var(--red, #b4534b); }
        .threat-timeline-trend.easing { border-left-color: var(--accent, #4c82c4); }
        .threat-timeline-trend-label { display: block; color: var(--text-primary); font-size: calc(13px * var(--wm-panel-effective-scale, 1)); font-weight: 700; }
        .threat-timeline-chart-wrap { border: 1px solid var(--border-color); border-radius: 2px; background: var(--bg-secondary); padding: 6px; }
        .threat-timeline-chart { width: 100%; height: 150px; display: block; overflow: visible; }
        .threat-timeline-grid { stroke: var(--border-color); stroke-dasharray: 3 3; opacity: 0.7; }
        .threat-timeline-axis { stroke: var(--border-color); }
        .threat-timeline-labels text { fill: var(--text-secondary); font-size: calc(9px * var(--wm-panel-effective-scale, 1)); }
        .threat-timeline-legend { display: flex; flex-wrap: wrap; gap: 6px; }
        .threat-timeline-legend-item { display: inline-flex; align-items: center; gap: 4px; font-size: calc(11px * var(--wm-panel-effective-scale, 1)); color: var(--text-secondary); }
        .threat-timeline-swatch { width: 8px; height: 8px; border-radius: 2px; }
        .threat-timeline-groups { display: grid; gap: 8px; }
        .threat-timeline-group { border: 1px solid var(--border-color); border-radius: 2px; overflow: hidden; background: var(--bg-secondary); }
        .threat-timeline-group-header { display: flex; align-items: center; justify-content: space-between; padding: 7px 9px; border-bottom: 1px solid var(--border-color); }
        .threat-timeline-group-name { font-size: calc(12px * var(--wm-panel-effective-scale, 1)); font-weight: 700; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0; }
        .threat-timeline-group-count { font-size: calc(11px * var(--wm-panel-effective-scale, 1)); color: var(--text-secondary); }
        .threat-timeline-item { padding: 8px 9px; display: grid; gap: 4px; }
        .threat-timeline-item + .threat-timeline-item { border-top: 1px solid var(--border-color); }
        .threat-timeline-item-title { color: var(--text-primary); font-size: calc(12px * var(--wm-panel-effective-scale, 1)); line-height: 1.35; text-decoration: none; }
        a.threat-timeline-item-title:hover { color: var(--accent); }
        .threat-timeline-item-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--text-secondary); font-size: calc(10px * var(--wm-panel-effective-scale, 1)); }
        .threat-timeline-source, .threat-timeline-source-count { border: 1px solid var(--border-color); border-radius: 2px; padding: 1px 6px; color: var(--text-secondary); }
        .threat-critical .threat-timeline-group-header { border-left: 3px solid var(--red, #b4534b); }
        .threat-high .threat-timeline-group-header { border-left: 3px solid var(--yellow, #b08d3c); }
        .threat-medium .threat-timeline-group-header { border-left: 3px solid var(--accent, #4c82c4); }
        .threat-low .threat-timeline-group-header { border-left: 3px solid var(--text-dim, #6b7787); }
        .threat-info .threat-timeline-group-header { border-left: 3px solid var(--border-color); }
        .threat-timeline-empty, .threat-timeline-empty-inline { border: 1px dashed var(--border-color); border-radius: 2px; padding: 14px; color: var(--text-secondary); background: var(--bg-secondary); }
        .threat-timeline-empty-title { color: var(--text-primary); font-size: calc(13px * var(--wm-panel-effective-scale, 1)); font-weight: 700; }
        .threat-timeline-empty-copy { margin-top: 5px; font-size: calc(12px * var(--wm-panel-effective-scale, 1)); line-height: 1.4; color: var(--text-secondary); }
        @media (max-width: 520px) {
          .threat-timeline-summary { grid-template-columns: 1fr 1fr; }
          .threat-timeline-trend { grid-column: 1 / -1; }
        }
      </style>
    `;
  }
}
