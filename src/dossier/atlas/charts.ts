// Charts section: clustered correlation heat map, risk against return, return
// distributions, regional indices and rankings. Plain SVG with d3 scales.
import { line as d3line, scaleLinear } from 'd3';
import { formatValue, fullDate, num, pct } from '../analytics/format';
import { pick } from '../analytics/parse';
import { empty, note, observeWidth, panel, picker, segmented, track } from '../analytics/ui';
import { h, s } from '../dom';
import { columnOf, markerPath, median, present, regionClass, regionKey, regionName, regionsOf, tooltip } from './common';
import type { Context, Section } from './common';
import type { Company, Frequency, Nullable } from './data';

const DAY = 86_400_000;

const memory = {
  frequency: 'daily' as Frequency,
  order: 'cluster' as 'cluster' | 'region',
  x: 'vol1y',
  y: 'return1y',
  sample: 'all',
  cross: 'return1y',
  rank: 'return1m',
  hidden: new Set<string>(),
};

type Draw = (width: number) => void;

/** A chart host that redraws on width changes and on demand. */
function plot(draw: Draw, disposers: (() => void)[], className = ''): { host: HTMLElement; redraw: () => void } {
  const host = h('div', { class: `mbx-plot atl-plot ${className}`.trim() });
  let width = 0;
  disposers.push(
    observeWidth(host, (w) => {
      width = w;
      draw(w);
    }),
  );
  return {
    host,
    redraw: () => {
      if (width) draw(width);
    },
  };
}

function frame(width: number, height: number, label: string): SVGSVGElement {
  return s('svg', { class: 'mbx-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label });
}

const axisText = (x: number, y: number, body: string, anchor = 'middle') =>
  s('text', { x, y, class: 'mbx-axis', 'text-anchor': anchor }, body);

// ---- heat map ---------------------------------------------------------------

/** Negative links use a greyed red, so that red stays rare on the screen. */
export const NEGATIVE = 'color-mix(in srgb, var(--down) 50%, var(--muted))';

/** Diverging fill: blue for positive, greyed red for negative, strength by |rho|. */
export function heatFill(rho: Nullable): string {
  if (rho === null) return 'fill:var(--raise)';
  const share = Math.round(Math.min(1, Math.abs(rho) / 0.75) * 100);
  return `fill:color-mix(in srgb, ${rho >= 0 ? 'var(--gold)' : NEGATIVE} ${share}%, var(--bg))`;
}

function heatMap(context: Context, disposers: (() => void)[]): HTMLElement {
  const { atlas, lang, t, open } = context;
  const readout = h('p', { class: 'mbx-matrix-readout', 'aria-live': 'polite' }, t('heatHint'));
  const regions = regionsOf(atlas);

  const sequence = (): number[] =>
    memory.order === 'cluster'
      ? atlas.clusters[memory.frequency].order
      : [...atlas.rows]
          .sort((a, b) => regions.indexOf(a.region) - regions.indexOf(b.region) || a.symbol.localeCompare(b.symbol))
          .map((r) => r.index);

  const draw: Draw = (width) => {
    const order = sequence();
    const n = order.length;
    if (!n) {
      view.host.replaceChildren(empty(lang));
      return;
    }
    const gutter = 66;
    const cell = Math.max(10, Math.min(15, Math.floor((width - gutter - 4) / n)));
    const side = cell * n;
    const tree = memory.order === 'cluster' ? 70 : 0;
    const top = tree + gutter;
    const matrix = atlas.correlation[memory.frequency];
    const overlap = memory.frequency === 'daily' ? atlas.correlation.overlap : atlas.correlation.overlapWeekly;
    const svg = frame(gutter + side + 4, top + side + 2, t('heatAria', { n }));
    svg.classList.add('atl-heat');

    if (tree) {
      const { merges } = atlas.clusters[memory.frequency];
      const at = new Map<number, [number, number]>(order.map((id, k) => [id, [gutter + k * cell + cell / 2, 0]]));
      const highest = Math.max(...merges.map((m) => m.height), 1e-9);
      const lowest = Math.min(...merges.map((m) => m.height));
      const y = scaleLinear([lowest * 0.85, highest], [tree - 3, 3]);
      const paths: string[] = [];
      merges.forEach((m, k) => {
        const a = at.get(m.a);
        const b = at.get(m.b);
        if (!a || !b) return;
        const level = y(m.height);
        const ya = a[1] || tree - 1;
        const yb = b[1] || tree - 1;
        paths.push(`M${a[0]},${ya}V${level}H${b[0]}V${yb}`);
        at.set(n + k, [(a[0] + b[0]) / 2, level]);
      });
      svg.append(s('path', { d: paths.join(''), class: 'atl-tree' }));
    }

    const cells = s('g', {});
    order.forEach((i, r) => {
      order.forEach((j, c) => {
        const rho = i === j ? 1 : (matrix[i]?.[j] ?? null);
        cells.append(
          s('rect', {
            x: gutter + c * cell,
            y: top + r * cell,
            width: cell - 0.5,
            height: cell - 0.5,
            style: i === j ? 'fill:var(--muted)' : heatFill(rho),
            'data-i': i,
            'data-j': j,
          }),
        );
      });
    });
    svg.append(cells);

    order.forEach((i, k) => {
      const company = atlas.rows[i] as Company;
      const label = (props: Record<string, string | number>) =>
        s(
          'text',
          { ...props, class: 'atl-heatlabel', onclick: () => open(company.symbol) },
          company.symbol,
          s('title', {}, company.name),
        );
      const middle = k * cell + cell / 2;
      svg.append(
        label({ x: gutter - 4, y: top + middle + 3, 'text-anchor': 'end' }),
        label({ transform: `translate(${gutter + middle + 3},${top - 4}) rotate(-90)` }),
      );
    });

    const mark = s('rect', { class: 'atl-heatmark', width: cell, height: cell, visibility: 'hidden' });
    svg.append(mark);
    const read = (event: Event) => {
      const target = event.target as SVGElement;
      const i = target.getAttribute('data-i');
      const j = target.getAttribute('data-j');
      if (i === null || j === null) return;
      const a = atlas.rows[Number(i)] as Company;
      const b = atlas.rows[Number(j)] as Company;
      const rho = matrix[Number(i)]?.[Number(j)] ?? null;
      readout.textContent = t('pairRead', {
        a: `${a.symbol} ${a.name}`,
        b: `${b.symbol} ${b.name}`,
        rho: rho === null ? t('noData') : formatValue(rho, 'ratio', lang, true),
        n: overlap[Number(i)]?.[Number(j)] ?? t('noData'),
      });
      mark.setAttribute('x', target.getAttribute('x') ?? '0');
      mark.setAttribute('y', target.getAttribute('y') ?? '0');
      mark.setAttribute('visibility', 'visible');
    };
    cells.addEventListener('pointerover', read);
    cells.addEventListener('click', read);
    view.host.replaceChildren(svg);
  };

  const view = plot(draw, disposers, 'atl-heat-scroll');
  const key = h(
    'div',
    { class: 'atl-scalekey', 'aria-hidden': 'true' },
    ...[-0.5, -0.25, 0, 0.25, 0.5, 0.75].map((v) =>
      h('span', {}, s('svg', { width: 22, height: 10 }, s('rect', { width: 22, height: 10, style: heatFill(v) })), num(v, lang, 0, 2)),
    ),
  );
  return panel(
    t('heatTitle'),
    h(
      'div',
      { class: 'mbx-toolbar' },
      segmented<Frequency>(t('frequency'), [['daily', t('daily')], ['weekly', t('weekly')]], memory.frequency, (v) => {
        memory.frequency = v;
        view.redraw();
      }),
      segmented(t('orderLabel'), [['cluster', t('orderCluster')], ['region', t('orderRegion')]] as const, memory.order, (v) => {
        memory.order = v;
        view.redraw();
      }),
      key,
    ),
    readout,
    view.host,
    note(t('heatNote')),
  );
}

// ---- scatter ----------------------------------------------------------------

function scatter(context: Context, disposers: (() => void)[]): HTMLElement {
  const { atlas, lang, t, open } = context;
  const options = atlas.columns.filter((c) => c.unit !== 'price').map((c) => [c.id, pick(c.label, lang)] as const);

  const draw: Draw = (width) => {
    const cx = columnOf(atlas, memory.x);
    const cy = columnOf(atlas, memory.y);
    const points = atlas.rows.flatMap((row) => {
      const x = row.values[memory.x];
      const y = row.values[memory.y];
      return typeof x === 'number' && typeof y === 'number' ? [{ row, x, y }] : [];
    });
    if (!cx || !cy || points.length < 2) {
      view.host.replaceChildren(empty(lang));
      return;
    }
    const height = width < 520 ? 320 : 420;
    const m = { left: 52, right: 12, top: 18, bottom: 34 };
    const span = (values: number[]): [number, number] => {
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      const pad = (hi - lo) * 0.05 || 1;
      return [lo - pad, hi + pad];
    };
    const x = scaleLinear(span(points.map((p) => p.x)), [m.left, width - m.right]).nice();
    const y = scaleLinear(span(points.map((p) => p.y)), [height - m.bottom, m.top]).nice();
    const svg = frame(width, height, `${pick(cy.label, lang)} / ${pick(cx.label, lang)}`);
    for (const v of x.ticks(width < 520 ? 4 : 8)) {
      svg.append(
        s('line', { x1: x(v), x2: x(v), y1: m.top, y2: height - m.bottom, class: v === 0 ? 'mbx-zeroline' : 'mbx-grid' }),
        axisText(x(v), height - m.bottom + 13, formatValue(v, cx.unit === 'money' ? 'money' : 'num', lang)),
      );
    }
    for (const v of y.ticks(6)) {
      svg.append(
        s('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: v === 0 ? 'mbx-zeroline' : 'mbx-grid' }),
        axisText(m.left - 5, y(v) + 3, formatValue(v, cy.unit === 'money' ? 'money' : 'num', lang), 'end'),
      );
    }
    const mx = median(points.map((p) => p.x)) as number;
    const my = median(points.map((p) => p.y)) as number;
    svg.append(
      s('line', { x1: x(mx), x2: x(mx), y1: m.top, y2: height - m.bottom, class: 'mbx-ref' }),
      s('line', { x1: m.left, x2: width - m.right, y1: y(my), y2: y(my), class: 'mbx-ref' }),
      s('text', { x: width - m.right, y: height - 5, class: 'mbx-axis mbx-axisname', 'text-anchor': 'end' }, pick(cx.label, lang)),
      s('text', { x: 4, y: 11, class: 'mbx-axis mbx-axisname' }, pick(cy.label, lang)),
    );
    // Label only the points far from the middle, and only where there is room.
    const reach = (p: (typeof points)[number]) =>
      Math.hypot((x(p.x) - x(mx)) / width, (y(p.y) - y(my)) / height);
    const taken: [number, number][] = [];
    const labelled = new Set<string>();
    for (const p of [...points].sort((a, b) => reach(b) - reach(a))) {
      const at: [number, number] = [x(p.x), y(p.y)];
      if (taken.some(([a, b]) => Math.abs(a - at[0]) < 52 && Math.abs(b - at[1]) < 14)) continue;
      taken.push(at);
      labelled.add(p.row.symbol);
      if (labelled.size >= (width < 520 ? 8 : 22)) break;
    }
    for (const p of points) {
      const say = () =>
        tip.show(
          x(p.x),
          y(p.y),
          `${p.row.symbol} · ${p.row.name}`,
          `${pick(cx.label, lang)}: ${formatValue(p.x, cx.unit, lang)}`,
          `${pick(cy.label, lang)}: ${formatValue(p.y, cy.unit, lang)}`,
        );
      svg.append(
        s(
          'g',
          {
            class: 'atl-point',
            tabindex: 0,
            role: 'button',
            'aria-label': `${p.row.symbol} ${p.row.name}`,
            onclick: () => open(p.row.symbol),
            onkeydown: (event: KeyboardEvent) => {
              if (event.key === 'Enter') open(p.row.symbol);
            },
            onpointerenter: say,
            onfocus: say,
            onpointerleave: () => tip.hide(),
            onblur: () => tip.hide(),
          },
          s('path', { d: markerPath(p.row.region, 4.5), transform: `translate(${x(p.x)},${y(p.y)})`, class: `atl-mark ${regionClass(p.row.region)}` }),
          labelled.has(p.row.symbol)
            ? s('text', { x: x(p.x) + (x(p.x) > width - 70 ? -7 : 7), y: y(p.y) + 3, class: 'mbx-pointlabel', 'text-anchor': x(p.x) > width - 70 ? 'end' : 'start' }, p.row.symbol)
            : null,
        ),
      );
    }
    const tip = tooltip(view.host);
    view.host.replaceChildren(svg, tip.el);
  };

  const view = plot(draw, disposers);
  const px = picker(t('xAxis'), (v) => {
    memory.x = v;
    view.redraw();
  });
  const py = picker(t('yAxis'), (v) => {
    memory.y = v;
    view.redraw();
  });
  px.set(options, memory.x);
  py.set(options, memory.y);
  return panel(
    t('scatterTitle'),
    h('div', { class: 'mbx-toolbar' }, px.el, py.el),
    h('div', { class: 'mbx-legend atl-legend' }, ...regionsOf(atlas).map((r) => regionKey(r, lang))),
    view.host,
    note(t('scatterNote')),
  );
}

// ---- distribution -------------------------------------------------------------

function returnsHistogram(context: Context, disposers: (() => void)[]): HTMLElement {
  const { atlas, lang, t } = context;
  const stats = h('p', { class: 'mbx-matrix-readout' });
  const edges = atlas.distribution.edges;
  const chosen = () =>
    atlas.distribution.groups[memory.sample] ?? atlas.rows.find((r) => r.symbol === memory.sample)?.distribution;

  const draw: Draw = (width) => {
    const d = chosen();
    if (!d?.counts || d.mean === null || d.sd === null || !(d.sd > 0) || edges.length < 2) {
      stats.textContent = t('noData');
      view.host.replaceChildren(empty(lang));
      return;
    }
    stats.textContent = t('distStats', {
      n: num(d.n, lang),
      mean: pct(d.mean, lang),
      sd: pct(d.sd, lang, false),
      tail: d.beyond3 === null ? t('noData') : pct(d.beyond3, lang, false),
    });
    const height = 240;
    const m = { left: 44, right: 8, top: 10, bottom: 22 };
    const x = scaleLinear([edges[0] as number, edges[edges.length - 1] as number], [m.left, width - m.right]);
    const shares = d.counts.map((c) => (c / d.n) * 100);
    const bin = (edges[1] as number) - (edges[0] as number);
    const density = (v: number) =>
      (Math.exp(-0.5 * ((v - (d.mean as number)) / (d.sd as number)) ** 2) / ((d.sd as number) * Math.sqrt(2 * Math.PI))) * bin * 100;
    const y = scaleLinear([0, Math.max(...shares, density(d.mean)) * 1.05], [height - m.bottom, m.top]).nice();
    const svg = frame(width, height, t('distTitle'));
    for (const v of y.ticks(4)) {
      svg.append(
        s('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: 'mbx-grid' }),
        axisText(m.left - 5, y(v) + 3, `${num(v, lang)}%`, 'end'),
      );
    }
    for (const v of x.ticks(width < 520 ? 5 : 10)) svg.append(axisText(x(v), height - 7, `${num(v, lang)}%`));
    const tip = tooltip(view.host);
    shares.forEach((share, i) => {
      const from = edges[i] as number;
      const to = edges[i + 1] as number;
      const say = () =>
        tip.show(x(from), y(share), t('distBin', { from: pct(from, lang), to: pct(to, lang), share: pct(share, lang, false) }));
      svg.append(
        s('rect', {
          x: x(from) + 0.5,
          y: y(share),
          width: Math.max(1, x(to) - x(from) - 1),
          height: Math.max(0, height - m.bottom - y(share)),
          class: 'atl-bar',
          onpointerenter: say,
          onpointerleave: () => tip.hide(),
        }),
      );
    });
    const curve = d3line<number>().x((v) => x(v)).y((v) => y(density(v)));
    const samples = Array.from({ length: 201 }, (_, i) => (edges[0] as number) + (i / 200) * 20);
    svg.append(s('path', { d: curve(samples) ?? '', class: 'atl-normal' }));
    view.host.replaceChildren(svg, tip.el);
  };

  const view = plot(draw, disposers);
  const choose = picker(t('group'), (v) => {
    memory.sample = v;
    view.redraw();
  });
  const options: [string, string][] = [
    ['all', t('allCompanies')],
    ...regionsOf(atlas).map((r) => [r, regionName(r, lang)] as [string, string]),
    ...[...atlas.rows].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((r) => [r.symbol, `${r.symbol} · ${r.name}`] as [string, string]),
  ];
  if (!options.some(([v]) => v === memory.sample)) memory.sample = 'all';
  choose.set(options, memory.sample);
  return panel(t('distTitle'), h('div', { class: 'mbx-toolbar' }, choose.el), stats, view.host, note(t('distNote')));
}

function crossHistogram(context: Context, disposers: (() => void)[]): HTMLElement {
  const { atlas, lang, t } = context;
  const readout = h('p', { class: 'mbx-matrix-readout' });

  const draw: Draw = (width) => {
    const column = columnOf(atlas, memory.cross);
    const items = atlas.rows.flatMap((r) => {
      const v = r.values[memory.cross];
      return typeof v === 'number' ? [{ v, symbol: r.symbol }] : [];
    });
    if (!column || items.length < 2) {
      view.host.replaceChildren(empty(lang));
      return;
    }
    const height = 240;
    const m = { left: 30, right: 8, top: 14, bottom: 22 };
    const lo = Math.min(...items.map((i) => i.v));
    const hi = Math.max(...items.map((i) => i.v));
    const steps = scaleLinear([lo, hi === lo ? lo + 1 : hi], [0, 1]).nice(14).ticks(14);
    const step = (steps[1] ?? lo + 1) - (steps[0] ?? lo);
    const first = Math.floor(lo / step) * step;
    const count = Math.max(1, Math.floor((hi - first) / step) + 1);
    const bins: string[][] = Array.from({ length: count }, () => []);
    for (const item of items) bins[Math.min(count - 1, Math.floor((item.v - first) / step))]?.push(item.symbol);
    const x = scaleLinear([first, first + count * step], [m.left, width - m.right]);
    const y = scaleLinear([0, Math.max(...bins.map((b) => b.length))], [height - m.bottom, m.top]);
    const label = (v: number) => formatValue(Number(v.toPrecision(12)), column.unit, lang);
    const svg = frame(width, height, pick(column.label, lang));
    for (const v of y.ticks(4).filter(Number.isInteger)) {
      svg.append(
        s('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: 'mbx-grid' }),
        axisText(m.left - 5, y(v) + 3, String(v), 'end'),
      );
    }
    for (const v of x.ticks(width < 520 ? 4 : 8)) {
      svg.append(axisText(x(v), height - 7, formatValue(v, column.unit === 'money' ? 'money' : 'num', lang)));
    }
    bins.forEach((symbols, i) => {
      const from = first + i * step;
      const say = () => {
        readout.textContent = `${t('crossBin', { from: label(from), to: label(from + step), n: symbols.length })}${symbols.length ? ` · ${symbols.join(', ')}` : ''}`;
      };
      svg.append(
        s('rect', {
          x: x(from) + 1,
          y: y(symbols.length),
          width: Math.max(1, x(from + step) - x(from) - 2),
          height: height - m.bottom - y(symbols.length),
          class: 'atl-bar',
          tabindex: 0,
          onpointerenter: say,
          onfocus: say,
          onclick: say,
        }),
      );
      if (symbols.length) svg.append(axisText(x(from + step / 2), y(symbols.length) - 3, String(symbols.length)));
    });
    view.host.replaceChildren(svg);
  };

  const view = plot(draw, disposers);
  const choose = picker(t('metric'), (v) => {
    memory.cross = v;
    readout.textContent = '';
    view.redraw();
  });
  choose.set(atlas.columns.filter((c) => c.unit !== 'price').map((c) => [c.id, pick(c.label, lang)] as const), memory.cross);
  return panel(t('crossTitle'), h('div', { class: 'mbx-toolbar' }, choose.el), readout, view.host);
}

// ---- regional indices -----------------------------------------------------------

function regionLines(context: Context, disposers: (() => void)[]): HTMLElement {
  const { atlas, lang, t } = context;
  const { days, series, excluded } = atlas.regionIndex;
  const ids = regionsOf(atlas).filter((r) => series[r]);
  const legend = h('div', { class: 'mbx-legend atl-legend', role: 'group', 'aria-label': t('region') });
  const readout = h('p', { class: 'mbx-matrix-readout', 'aria-live': 'polite' });

  const values = (at: number) =>
    ids
      .filter((r) => !memory.hidden.has(r))
      .map((r) => {
        const v = series[r]?.[at];
        return `${regionName(r, lang)} ${typeof v === 'number' ? num(v, lang, 1, 1) : t('noData')}`;
      })
      .join(' · ');
  const say = (at: number) => {
    readout.textContent = `${fullDate((days[at] ?? 0) * DAY + DAY / 2, lang)}: ${values(at)}`;
  };

  const draw: Draw = (width) => {
    const shown = ids.filter((r) => !memory.hidden.has(r));
    const all = shown.flatMap((r) => present(series[r] ?? []));
    if (days.length < 2 || !all.length) {
      view.host.replaceChildren(empty(lang));
      readout.textContent = '';
      return;
    }
    const height = width < 520 ? 260 : 320;
    const m = { left: 40, right: width < 520 ? 8 : 84, top: 10, bottom: 22 };
    const x = scaleLinear([days[0] as number, days[days.length - 1] as number], [m.left, width - m.right]);
    const y = scaleLinear([Math.min(...all, 100), Math.max(...all, 100)], [height - m.bottom, m.top]).nice();
    const svg = frame(width, height, t('regionsTitle'));
    for (const v of y.ticks(5)) {
      svg.append(
        s('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: v === 100 ? 'mbx-zeroline' : 'mbx-grid' }),
        axisText(m.left - 5, y(v) + 3, num(v, lang), 'end'),
      );
    }
    const labels = Math.max(2, Math.min(6, Math.floor((width - m.left - m.right) / 110)));
    for (let k = 0; k <= labels; k += 1) {
      const day = days[Math.round((k / labels) * (days.length - 1))] as number;
      const date = new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(day * DAY);
      svg.append(axisText(x(day), height - 7, date, k === 0 ? 'start' : k === labels ? 'end' : 'middle'));
    }
    const ends: { region: string; y: number }[] = [];
    for (const region of shown) {
      const path = d3line<Nullable>()
        .defined((v) => v !== null)
        .x((_, i) => x(days[i] as number))
        .y((v) => y(v as number));
      svg.append(s('path', { d: path(series[region] ?? []) ?? '', class: `atl-line ${regionClass(region)}` }));
      const last = series[region]?.[days.length - 1];
      if (typeof last === 'number') ends.push({ region, y: y(last) });
    }
    if (width >= 520) {
      let floor = m.top;
      for (const end of ends.sort((a, b) => a.y - b.y)) {
        const at = Math.max(end.y, floor);
        floor = at + 12;
        svg.append(s('text', { x: width - m.right + 6, y: at + 3, class: 'mbx-axis atl-endlabel' }, regionName(end.region, lang)));
      }
    }
    const cursor = s('line', { y1: m.top, y2: height - m.bottom, class: 'mbx-cross', visibility: 'hidden' });
    svg.append(cursor);
    svg.addEventListener('pointermove', (event) => {
      const px = event.clientX - svg.getBoundingClientRect().left;
      const scale = svg.getBoundingClientRect().width / width || 1;
      const day = x.invert(px / scale);
      let at = days.findIndex((d) => d >= day);
      if (at < 0) at = days.length - 1;
      cursor.setAttribute('x1', String(x(days[at] as number)));
      cursor.setAttribute('x2', String(x(days[at] as number)));
      cursor.setAttribute('visibility', 'visible');
      say(at);
    });
    say(days.length - 1);
    view.host.replaceChildren(svg);
  };

  const view = plot(draw, disposers);
  legend.replaceChildren(
    ...ids.map((region) =>
      h(
        'button',
        {
          type: 'button',
          class: 'atl-toggle',
          'aria-pressed': String(!memory.hidden.has(region)),
          onclick: (event: Event) => {
            if (!memory.hidden.delete(region)) memory.hidden.add(region);
            (event.currentTarget as HTMLElement).setAttribute('aria-pressed', String(!memory.hidden.has(region)));
            view.redraw();
          },
        },
        s('svg', { width: 22, height: 8, 'aria-hidden': 'true' }, s('line', { x1: 0, x2: 22, y1: 4, y2: 4, class: `atl-line ${regionClass(region)}` })),
        regionName(region, lang),
      ),
    ),
  );
  return panel(
    t('regionsTitle'),
    h('div', { class: 'mbx-toolbar' }, legend),
    readout,
    view.host,
    note(`${t('regionsNote')}${excluded.length ? ` ${t('excluded', { list: excluded.join(', ') })}` : ''}`),
  );
}

// ---- rankings -------------------------------------------------------------------

function rankings(context: Context): HTMLElement {
  const { atlas, lang, t, open } = context;
  const body = h('div', { class: 'mbx-grid2' });

  const draw = () => {
    const column = columnOf(atlas, memory.rank);
    const sorted = atlas.rows
      .flatMap((r) => {
        const v = r.values[memory.rank];
        return typeof v === 'number' ? [{ r, v }] : [];
      })
      .sort((a, b) => b.v - a.v);
    if (!column || !sorted.length) {
      body.replaceChildren(empty(lang));
      return;
    }
    const lo = Math.min(...sorted.map((i) => i.v));
    const hi = Math.max(...sorted.map((i) => i.v));
    const list = (title: string, items: typeof sorted) =>
      h(
        'div',
        { class: 'mbx-sub' },
        h('h4', {}, title),
        h(
          'div',
          { class: 'mbx-bars' },
          ...items.map(({ r, v }) =>
            h(
              'button',
              { type: 'button', class: 'mbx-barrow atl-rank', title: r.name, onclick: () => open(r.symbol) },
              h('span', { class: 'mbx-barlabel' }, `${r.symbol} ${r.name}`),
              track(v, lo, hi, 'a'),
              h('span', { class: 'mbx-barvalue' }, formatValue(v, column.unit, lang)),
            ),
          ),
        ),
      );
    body.replaceChildren(list(t('highest'), sorted.slice(0, 12)), list(t('lowest'), sorted.slice(-12).reverse()));
  };

  const choose = picker(t('metric'), (v) => {
    memory.rank = v;
    draw();
  });
  choose.set(atlas.columns.filter((c) => c.unit !== 'price').map((c) => [c.id, pick(c.label, lang)] as const), memory.rank);
  draw();
  return panel(t('rankTitle'), h('div', { class: 'mbx-toolbar' }, choose.el), body);
}

export function chartsSection(context: Context): Section {
  const disposers: (() => void)[] = [];
  const el = h(
    'div',
    { class: 'mbx-stack' },
    heatMap(context, disposers),
    h('div', { class: 'mbx-grid2' }, scatter(context, disposers), regionLines(context, disposers)),
    h('div', { class: 'mbx-grid2' }, returnsHistogram(context, disposers), crossHistogram(context, disposers)),
    rankings(context),
  );
  return { el, dispose: () => disposers.forEach((d) => d()) };
}
