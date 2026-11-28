// Static SVG charts, drawn at the real container width so text never scales.
// Every chart has a data table next to it; colour is never the only cue.
import { h, s, shape } from '../dom';
import { EVENT_TYPES } from '../types';
import type { EventType } from '../types';
import type { Bar, Ev } from './data';
import { histogram, mean, present } from './stats';
import type { Bucket, Unit } from './stats';
import { table, value } from './ui';
import type { Ui } from './ui';

let sequence = 0;

/** A box that redraws its chart whenever its width changes. */
export function responsive(draw: (width: number) => SVGElement): HTMLElement {
  const box = h('div', { class: 'evx-chart' });
  let drawn = 0;
  const render = (width: number) => {
    const next = Math.max(240, Math.floor(width));
    if (next === drawn) return;
    drawn = next;
    box.replaceChildren(draw(next));
  };
  render(288);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) render(width);
    }).observe(box);
  }
  return box;
}

function frame(width: number, height: number, label: string): SVGSVGElement {
  return s('svg', {
    class: 'evx-svg',
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': label,
  });
}

const text = (x: number, y: number, body: string, anchor = 'start', className = 'evx-axis') =>
  s('text', { x, y, class: className, 'text-anchor': anchor }, body);

const gridLine = (x1: number, x2: number, y: number, className = 'evx-grid') =>
  s('line', { x1, x2, y1: y, y2: y, class: className });

/** A "nice" axis top and step for counts. */
function niceStep(max: number, ticks = 4): number {
  const raw = max / ticks;
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 5, 10].map((m) => m * power).find((candidate) => candidate >= raw) ?? raw;
  return Math.max(1, step);
}

// Each type has a fill pattern as well as a colour.
const PATTERNS: Record<EventType, string> = {
  leadership: '',
  politics: 'M0 6L6 0',
  regulation: 'M0 3H6',
  earnings: 'M3 0V6',
  deal: 'M0 0L6 6',
  scandal: 'M0 0L6 6M6 0L0 6',
  product: 'M0 3H6M3 0V6',
  other: 'M2 3h2',
};

function patternDefs(prefix: string, types: readonly EventType[]): SVGElement {
  return s(
    'defs',
    {},
    ...types.map((type) =>
      s(
        'pattern',
        { id: `${prefix}-${type}`, width: 6, height: 6, patternUnits: 'userSpaceOnUse' },
        s('rect', { width: 6, height: 6, class: `evx-fill-${type}` }),
        PATTERNS[type] ? s('path', { d: PATTERNS[type], class: 'evx-hatch' }) : null,
      ),
    ),
  );
}

export function typeGlyph(type: EventType): SVGSVGElement {
  return s(
    'svg',
    { class: 'evx-glyph', width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true' },
    shape(type, 5, 5, 3.5),
  );
}

function legend(ui: Ui, types: EventType[]): HTMLElement {
  const prefix = `evx-l${++sequence}`;
  return h(
    'ul',
    { class: 'evx-legend' },
    ...types.map((type) =>
      h(
        'li',
        {},
        s(
          'svg',
          { width: 14, height: 10, 'aria-hidden': 'true' },
          patternDefs(`${prefix}-${type}`, [type]),
          s('rect', { width: 14, height: 10, fill: `url(#${prefix}-${type}-${type})` }),
        ),
        typeGlyph(type),
        ui.t(`t_${type}`),
      ),
    ),
  );
}

export function bucketLabel(ui: Ui, start: number, unit: Unit): string {
  return unit === 'month' ? ui.month(start) : ui.shortDate(start);
}

/** Pointer read-out under a chart; the same numbers are in the data table. */
function readout(ui: Ui): HTMLElement {
  return h('p', { class: 'evx-readout', 'aria-hidden': 'true' }, ui.t('chartHover'));
}

function hit(
  x: number,
  y: number,
  width: number,
  height: number,
  summary: string,
  out: HTMLElement,
  ...marks: SVGElement[]
): SVGElement {
  const show = () => {
    out.textContent = summary;
  };
  return s(
    'g',
    { class: 'evx-hit', onpointerenter: show, onpointerdown: show },
    s('title', {}, summary),
    s('rect', { x, y, width, height, class: 'evx-hit-area' }),
    ...marks,
  );
}

function dataDetails(ui: Ui, ...children: Node[]): HTMLElement {
  return h('details', { class: 'evx-data' }, h('summary', {}, ui.t('showTable')), ...children);
}

/** Positions for x labels that do not collide. */
const labelEvery = (count: number, slot: number) => Math.max(1, Math.ceil(52 / Math.max(slot, 0.1)), Math.ceil(count / 12));

export function stackedByType(ui: Ui, list: Bucket[], unit: Unit, title: string): HTMLElement {
  const types = EVENT_TYPES.filter((type) => list.some((b) => b.events.some((e) => e.type === type)));
  const counts = list.map((b) => types.map((type) => b.events.filter((e) => e.type === type).length));
  const max = Math.max(1, ...list.map((b) => b.events.length));
  const out = readout(ui);
  const describe = (i: number) => {
    const bucket = list[i] as Bucket;
    const parts = types
      .map((type, j) => (counts[i]?.[j] ? `${ui.t(`t_${type}`)} ${counts[i]?.[j]}` : ''))
      .filter(Boolean);
    return `${bucketLabel(ui, bucket.start, unit)}: ${bucket.events.length}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  };
  const chart = responsive((width) => {
    const height = 170;
    const left = 30;
    const top = 8;
    const bottom = height - 18;
    const step = niceStep(max);
    const ceiling = Math.ceil(max / step) * step;
    const y = (n: number) => bottom - (n / ceiling) * (bottom - top);
    const slot = (width - left - 4) / list.length;
    const bar = Math.max(1, Math.min(28, slot - (slot > 5 ? 2 : 0.5)));
    const prefix = `evx-p${++sequence}`;
    const svg = frame(width, height, `${title}. ${ui.t('showTable')}.`);
    svg.append(patternDefs(prefix, types));
    for (let n = 0; n <= ceiling; n += step) {
      svg.append(gridLine(left, width, y(n)), text(left - 5, y(n) + 3, ui.int(n), 'end'));
    }
    const every = labelEvery(list.length, slot);
    list.forEach((bucket, i) => {
      const x = left + i * slot + (slot - bar) / 2;
      let sum = 0;
      const marks: SVGElement[] = [];
      types.forEach((type, j) => {
        const n = counts[i]?.[j] ?? 0;
        if (!n) return;
        const y1 = y(sum + n);
        marks.push(
          s('rect', {
            x,
            y: y1,
            width: bar,
            height: Math.max(0.5, y(sum) - y1 - (bar > 4 ? 1 : 0)),
            fill: `url(#${prefix}-${type})`,
          }),
        );
        sum += n;
      });
      svg.append(hit(left + i * slot, top, slot, bottom - top, describe(i), out, ...marks));
      if (i % every === 0 && left + i * slot + 40 <= width) {
        svg.append(text(left + i * slot, height - 5, bucketLabel(ui, bucket.start, unit)));
      }
    });
    return svg;
  });
  const rows = list
    .filter((b) => b.events.length)
    .reverse()
    .map((b) => [
      bucketLabel(ui, b.start, unit),
      ui.int(b.events.length),
      ...types.map((type) => ui.int(b.events.filter((e) => e.type === type).length)),
    ]);
  return h(
    'figure',
    { class: 'evx-figure' },
    h('figcaption', {}, title),
    legend(ui, types),
    chart,
    out,
    dataDetails(
      ui,
      table(
        title,
        [
          { label: ui.t('period') },
          { label: ui.t('m_total'), numeric: true },
          ...types.map((type) => ({ label: ui.t(`t_${type}`), numeric: true })),
        ],
        rows,
      ),
    ),
  );
}

export function toneOverTime(ui: Ui, list: Bucket[], unit: Unit, title: string): HTMLElement {
  const stats = list.map((b) => {
    const tones = present(b.events.map((e) => e.sentiment));
    return {
      mean: mean(tones),
      pos: tones.filter((v) => v > 0.005).length,
      neg: tones.filter((v) => v < -0.005).length,
      neu: tones.filter((v) => Math.abs(v) <= 0.005).length,
    };
  });
  const extent = Math.min(1, Math.max(0.2, ...stats.map((x) => Math.abs(x.mean ?? 0))) * 1.15);
  const out = readout(ui);
  const describe = (i: number) => {
    const st = stats[i];
    const label = bucketLabel(ui, (list[i] as Bucket).start, unit);
    if (!st || st.mean === null) return `${label}: ${ui.t('noData')}`;
    return `${label}: ${ui.t('meanTone').toLowerCase()} ${ui.signed(st.mean)}; ${ui.t('tone_pos')} ${st.pos}, ${ui.t('tone_neu')} ${st.neu}, ${ui.t('tone_neg')} ${st.neg}`;
  };
  const chart = responsive((width) => {
    const height = 170;
    const left = 38;
    const top = 10;
    const bottom = height - 20;
    const zero = (top + bottom) / 2;
    const y = (v: number) => zero - (v / extent) * ((bottom - top) / 2);
    const slot = (width - left - 4) / list.length;
    const r = Math.max(1.5, Math.min(5, slot / 2.4));
    const svg = frame(width, height, `${title}. ${ui.t('showTable')}.`);
    for (const v of [extent, extent / 2, -extent / 2, -extent]) {
      svg.append(gridLine(left, width, y(v)), text(left - 5, y(v) + 3, ui.signed(v, 1), 'end'));
    }
    svg.append(gridLine(left, width, zero, 'evx-zero'), text(left - 5, zero + 3, ui.num(0, 0), 'end'));
    const every = labelEvery(list.length, slot);
    list.forEach((bucket, i) => {
      const cx = left + i * slot + slot / 2;
      const m = stats[i]?.mean ?? null;
      const marks: SVGElement[] = [];
      if (m !== null) {
        const cy = y(m);
        const kind = m > 0.005 ? 'pos' : m < -0.005 ? 'neg' : 'neu';
        marks.push(s('line', { x1: cx, x2: cx, y1: zero, y2: cy, class: `evx-stem evx-${kind}` }));
        marks.push(
          kind === 'neu'
            ? s('rect', { x: cx - r * 0.7, y: cy - r * 0.7, width: r * 1.4, height: r * 1.4, class: 'evx-point evx-neu' })
            : s('polygon', {
                points:
                  kind === 'pos'
                    ? `${cx},${cy - r} ${cx + r},${cy + r * 0.7} ${cx - r},${cy + r * 0.7}`
                    : `${cx},${cy + r} ${cx + r},${cy - r * 0.7} ${cx - r},${cy - r * 0.7}`,
                class: `evx-point evx-${kind}`,
              }),
        );
      }
      svg.append(hit(left + i * slot, top, slot, bottom - top, describe(i), out, ...marks));
      if (i % every === 0 && left + i * slot + 40 <= width) {
        svg.append(text(left + i * slot, height - 5, bucketLabel(ui, bucket.start, unit)));
      }
    });
    return svg;
  });
  const rows = list
    .map((b, i) => [b, stats[i]] as const)
    .filter(([b]) => b.events.length)
    .reverse()
    .map(([b, st]) => [
      bucketLabel(ui, b.start, unit),
      value(ui, ui.signed(st?.mean ?? null)),
      ui.int(st?.pos ?? 0),
      ui.int(st?.neu ?? 0),
      ui.int(st?.neg ?? 0),
    ]);
  return h(
    'figure',
    { class: 'evx-figure' },
    h('figcaption', {}, title),
    h('p', { class: 'evx-note' }, ui.t('toneNote')),
    chart,
    out,
    dataDetails(
      ui,
      table(
        title,
        [
          { label: ui.t('period') },
          { label: ui.t('meanTone'), numeric: true },
          { label: ui.t('b_pos'), numeric: true },
          { label: ui.t('tone_neu'), numeric: true },
          { label: ui.t('b_neg'), numeric: true },
        ],
        rows,
      ),
    ),
  );
}

export function carHistogram(ui: Ui, values: number[], windows: number): HTMLElement {
  const title = ui.t('carHist');
  if (!values.length) {
    return h(
      'figure',
      { class: 'evx-figure' },
      h('figcaption', {}, title),
      h('p', { class: 'evx-empty' }, ui.t('noData')),
    );
  }
  const bins = histogram(values);
  const digits = bins[0] && Math.abs(bins[0].to - bins[0].from) < 1 ? 2 : 1;
  const tidy = (v: number) => ui.signed(v, Number.isInteger(v) ? 0 : digits);
  const range = (i: number) => `${tidy(bins[i]?.from ?? 0)} … ${tidy(bins[i]?.to ?? 0)}`;
  const max = Math.max(1, ...bins.map((b) => b.count));
  const out = readout(ui);
  const chart = responsive((width) => {
    const height = 180;
    const left = 30;
    const top = 16;
    const bottom = height - 20;
    const step = niceStep(max);
    const ceiling = Math.ceil(max / step) * step;
    const y = (n: number) => bottom - (n / ceiling) * (bottom - top);
    const slot = (width - left - 14) / bins.length;
    const prefix = `evx-h${++sequence}`;
    const svg = frame(width, height, `${title}. ${ui.t('showTable')}.`);
    svg.append(
      s(
        'defs',
        {},
        s(
          'pattern',
          { id: prefix, width: 5, height: 5, patternUnits: 'userSpaceOnUse' },
          s('rect', { width: 5, height: 5, class: 'evx-fill-neg-soft' }),
          s('path', { d: 'M0 5L5 0', class: 'evx-hatch-neg' }),
        ),
      ),
    );
    for (let n = 0; n <= ceiling; n += step) {
      svg.append(gridLine(left, width, y(n)), text(left - 5, y(n) + 3, ui.int(n), 'end'));
    }
    const every = labelEvery(bins.length, slot);
    bins.forEach((bin, i) => {
      const x = left + i * slot;
      const negative = bin.to <= 0;
      const marks: SVGElement[] = [];
      if (bin.count) {
        marks.push(
          s('rect', {
            x: x + 1,
            y: y(bin.count),
            width: Math.max(1, slot - 2),
            height: bottom - y(bin.count),
            class: negative ? 'evx-bar-neg' : 'evx-bar-pos',
            fill: negative ? `url(#${prefix})` : null,
          }),
        );
        if (slot >= 18) marks.push(text(x + slot / 2, y(bin.count) - 3, ui.int(bin.count), 'middle', 'evx-value'));
      }
      svg.append(hit(x, top, slot, bottom - top, `${range(i)} %: ${bin.count}`, out, ...marks));
    });
    // Edge labels; zero always sits between the two halves.
    const half = bins.length / 2;
    for (let i = 0; i <= bins.length; i++) {
      if ((i - half) % every !== 0) continue;
      const edge = i < bins.length ? (bins[i]?.from ?? 0) : (bins[i - 1]?.to ?? 0);
      svg.append(text(left + i * slot, height - 5, tidy(edge), 'middle'));
    }
    svg.append(s('line', { x1: left + half * slot, x2: left + half * slot, y1: top - 6, y2: bottom, class: 'evx-zero' }));
    return svg;
  });
  return h(
    'figure',
    { class: 'evx-figure' },
    h('figcaption', {}, title),
    h('p', { class: 'evx-note' }, ui.t('carHistNote', { n: values.length, w: windows })),
    chart,
    out,
    dataDetails(
      ui,
      table(
        title,
        [{ label: ui.t('bin') }, { label: ui.t('count'), numeric: true }],
        bins.map((bin, i) => [range(i), ui.int(bin.count)]),
      ),
    ),
  );
}

const BEFORE = 15;
const AFTER = 10;

/** Closing price around day 0 with the estimation of both event-study windows. */
export function priceWindow(ui: Ui, history: Bar[], day0: number, event: Ev, symbol: string): HTMLElement {
  const start = Math.max(0, day0 - BEFORE);
  const bars = history.slice(start, day0 + AFTER + 1);
  const zero = day0 - start;
  const zeroBar = bars[zero] as Bar;
  const closes = bars.map((b) => b.c);
  const low = Math.min(...closes);
  const high = Math.max(...closes);
  const pad = (high - low) * 0.12 || high * 0.02;
  const volumes = Math.max(0, ...bars.map((b) => b.v ?? 0));
  const chart = responsive((width) => {
    const height = 210;
    const left = 4;
    const right = width - 52;
    const top = 22;
    const bottom = 148;
    const volumeTop = 158;
    const volumeBottom = 188;
    const slot = (right - left) / bars.length;
    const x = (i: number) => left + slot * (i + 0.5);
    const y = (c: number) => bottom - ((c - (low - pad)) / (high - low + 2 * pad)) * (bottom - top);
    const svg = frame(
      width,
      height,
      ui.t('chartAria', { symbol: symbol || event.source, date: ui.barDate(zeroBar.t) }),
    );
    for (const level of [low, (low + high) / 2, high]) {
      svg.append(gridLine(left, right, y(level)), text(right + 5, y(level) + 3, ui.num(level)));
    }
    const band = (from: number, to: number, className: string, label: string) => {
      const a = Math.max(0, from);
      const b = Math.min(bars.length - 1, to);
      if (b < a) return;
      const x1 = left + a * slot;
      const w = (b - a + 1) * slot;
      svg.append(
        s('rect', { x: x1 + 0.5, y: top - 6, width: Math.max(1, w - 1), height: volumeBottom - top + 6, class: className }),
        text(x1 + w / 2, 11, label, 'middle', 'evx-value'),
      );
    };
    band(zero - 5, zero - 1, 'evx-band-pre', ui.t('preWindow'));
    band(zero, zero + 1, 'evx-band-post', ui.t('postWindow'));
    svg.append(s('line', { x1: x(zero), x2: x(zero), y1: top - 6, y2: volumeBottom, class: 'evx-day0' }));
    if (volumes > 0) {
      bars.forEach((bar, i) => {
        if (!bar.v) return;
        const size = (bar.v / volumes) * (volumeBottom - volumeTop);
        svg.append(
          s('rect', {
            x: x(i) - Math.max(1, slot * 0.3),
            y: volumeBottom - size,
            width: Math.max(2, slot * 0.6),
            height: size,
            class: i === zero ? 'evx-volume evx-volume-day0' : 'evx-volume',
          }),
        );
      });
      svg.append(text(right + 5, volumeBottom, ui.t('volume')));
    }
    svg.append(
      s('polyline', { points: bars.map((b, i) => `${x(i)},${y(b.c)}`).join(' '), class: 'evx-price' }),
    );
    bars.forEach((bar, i) => {
      const dot =
        i === zero
          ? s('polygon', {
              points: `${x(i)},${y(bar.c) - 5} ${x(i) + 5},${y(bar.c)} ${x(i)},${y(bar.c) + 5} ${x(i) - 5},${y(bar.c)}`,
              class: 'evx-dot-day0',
            })
          : s('circle', { cx: x(i), cy: y(bar.c), r: 2, class: 'evx-dot' });
      svg.append(
        s(
          'g',
          {},
          s('title', {}, `${ui.barDate(bar.t)}: ${ui.num(bar.c)}, ${ui.t('volume').toLowerCase()} ${ui.compact(bar.v)}`),
          s('rect', { x: left + i * slot, y: top, width: slot, height: bottom - top, class: 'evx-hit-area' }),
          dot,
        ),
      );
    });
    // Day-0 label first; the end labels are skipped when they would collide.
    const zeroX = Math.min(Math.max(x(zero), 46), width - 46);
    svg.append(text(zeroX, height - 5, `${ui.t('day0')} · ${ui.barDate(zeroBar.t, true)}`, 'middle', 'evx-value'));
    if (zeroX > 110) svg.append(text(left, height - 5, ui.barDate((bars[0] as Bar).t, true)));
    if (right - zeroX > 90) {
      svg.append(text(right, height - 5, ui.barDate((bars[bars.length - 1] as Bar).t, true), 'end'));
    }
    return svg;
  });
  return h(
    'figure',
    { class: 'evx-figure' },
    chart,
    h(
      'ul',
      { class: 'evx-legend evx-legend-block' },
      h('li', {}, h('i', { class: 'evx-key evx-key-day0', 'aria-hidden': 'true' }), ui.t('legendDay0')),
      h('li', {}, h('i', { class: 'evx-key evx-key-pre', 'aria-hidden': 'true' }), ui.t('legendPre')),
      h('li', {}, h('i', { class: 'evx-key evx-key-post', 'aria-hidden': 'true' }), ui.t('legendPost')),
    ),
  );
}
