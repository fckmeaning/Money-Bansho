// Scatter plot of two screener metrics. Region is encoded by shape and colour.
import { h, s } from '../dom';
import { formatValue, num } from './format';
import type { Lang } from './format';
import { pick } from './parse';
import type { Column, Row } from './parse';
import { linear, padded, regression, ticks } from './scale';
import { fill, nameOf, strings } from './strings';
import { disclosure, empty, note, observeWidth, scroller, table, uid } from './ui';

const SHAPES = 6;

/** Marker for a region index: circle, square, triangle, diamond, inverted triangle, cross. */
export function marker(index: number, x: number, y: number, r = 4): SVGElement {
  const kind = index % SHAPES;
  const poly = (points: [number, number][]) =>
    s('polygon', { points: points.map(([a, b]) => `${x + a * r},${y + b * r}`).join(' ') });
  let node: SVGElement;
  if (kind === 0) node = s('circle', { cx: x, cy: y, r: r * 0.95 });
  else if (kind === 1) node = poly([[-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85]]);
  else if (kind === 2) node = poly([[0, -1.15], [1.1, 0.85], [-1.1, 0.85]]);
  else if (kind === 3) node = poly([[0, -1.3], [1.3, 0], [0, 1.3], [-1.3, 0]]);
  else if (kind === 4) node = poly([[0, 1.15], [1.1, -0.85], [-1.1, -0.85]]);
  else {
    node = poly([[-0.4, -1.15], [0.4, -1.15], [0.4, -0.4], [1.15, -0.4], [1.15, 0.4], [0.4, 0.4], [0.4, 1.15], [-0.4, 1.15], [-0.4, 0.4], [-1.15, 0.4], [-1.15, -0.4], [-0.4, -0.4]]);
  }
  node.classList.add('mbx-marker', `r${index % 7}`);
  return node;
}

export interface ScatterInput {
  rows: Row[];
  x: Column;
  y: Column;
  /** All regions in the universe, so a region keeps its marker under filtering. */
  regions: string[];
}

export interface Scatter { el: HTMLElement; update(input: ScatterInput | null): void; dispose(): void }

export function scatterPlot(lang: Lang, onSelect: (symbol: string) => void): Scatter {
  const t = strings(lang);
  const legend = h('div', { class: 'mbx-legend' });
  const host = h('div', { class: 'mbx-plot mbx-scatter' });
  const tip = h('div', { class: 'mbx-tip', hidden: true });
  const live = h('span', { class: 'mbx-sr', 'aria-live': 'polite' });
  const info = h('p', { class: 'mbx-note' });
  const helpId = uid('help');
  let input: ScatterInput | null = null;
  let width = 0;

  const data = disclosure(t.dataTable, () => {
    if (!input) return empty(lang);
    const { x, y, rows } = input;
    const cell = (row: Row, column: Column) => {
      const v = row.values.get(column.id);
      return v === undefined ? t.noData : formatValue(v, column.unit, lang);
    };
    return scroller(
      table(
        t.scatterTitle,
        [{ text: t.symbol }, { text: pick(x.label, lang), numeric: true }, { text: pick(y.label, lang), numeric: true }],
        rows.map((row) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, h('button', { type: 'button', class: 'mbx-link', onclick: () => onSelect(row.symbol) }, row.symbol)),
            h('td', { class: 'num' }, cell(row, x)),
            h('td', { class: 'num' }, cell(row, y)),
          ),
        ),
      ),
      t.scatterTitle,
      'mbx-short',
    );
  });

  const draw = () => {
    tip.hidden = true;
    if (!input || width < 40) return;
    const { rows, x: cx, y: cy, regions } = input;
    const points = rows
      .flatMap((row) => {
        const a = row.values.get(cx.id);
        const b = row.values.get(cy.id);
        return a === undefined || b === undefined ? [] : [{ row, a, b }];
      })
      .sort((p, q) => p.a - q.a);
    const present = regions.filter((r) => points.some((p) => p.row.region === r));
    legend.replaceChildren(
      ...present.map((region) =>
        h(
          'span',
          { class: 'mbx-key' },
          s('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' }, marker(regions.indexOf(region), 6, 6)),
          h('em', {}, nameOf(region, lang) || t.noData),
        ),
      ),
    );
    if (points.length === 0) {
      host.replaceChildren(empty(lang));
      info.textContent = '';
      return;
    }
    const height = Math.round(Math.max(260, Math.min(460, width * 0.62)));
    const M = { left: 56, right: 12, top: 18, bottom: 34 };
    const plotW = width - M.left - M.right;
    const plotH = height - M.top - M.bottom;
    const xs = points.map((p) => p.a);
    const ys = points.map((p) => p.b);
    const xd = padded([Math.min(...xs), Math.max(...xs)], false);
    const yd = padded([Math.min(...ys), Math.max(...ys)], false);
    const x = linear(xd[0], xd[1], M.left, M.left + plotW);
    const y = linear(yd[0], yd[1], M.top + plotH, M.top);
    const xName = pick(cx.label, lang);
    const yName = pick(cy.label, lang);
    const short = (v: number, column: Column) =>
      column.unit === 'money' || Math.abs(v) >= 100_000
        ? formatValue(v, 'money', lang)
        : `${num(v, lang, 0, 2)}${column.unit === 'pct' ? '%' : ''}`;

    const svg = s('svg', {
      class: 'mbx-svg',
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      tabindex: 0,
      role: 'group',
      'aria-label': `${t.scatterTitle}: ${yName} / ${xName}`,
      'aria-describedby': helpId,
    });
    for (const v of ticks(yd[0], yd[1], 6)) {
      svg.append(
        s('line', { class: 'mbx-grid', x1: M.left, x2: M.left + plotW, y1: y(v), y2: y(v) }),
        s('text', { class: 'mbx-axis', x: M.left - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, short(v, cy)),
      );
    }
    for (const v of ticks(xd[0], xd[1], Math.max(3, Math.floor(plotW / 74)))) {
      svg.append(
        s('line', { class: 'mbx-grid', x1: x(v), x2: x(v), y1: M.top, y2: M.top + plotH }),
        s('text', { class: 'mbx-axis', x: x(v), y: height - 19, 'text-anchor': 'middle' }, short(v, cx)),
      );
    }
    if (xd[0] < 0 && xd[1] > 0) svg.append(s('line', { class: 'mbx-zeroline', x1: x(0), x2: x(0), y1: M.top, y2: M.top + plotH }));
    if (yd[0] < 0 && yd[1] > 0) svg.append(s('line', { class: 'mbx-zeroline', x1: M.left, x2: M.left + plotW, y1: y(0), y2: y(0) }));
    svg.append(
      s('text', { class: 'mbx-axis mbx-axisname', x: M.left + plotW / 2, y: height - 4, 'text-anchor': 'middle' }, xName),
      s('text', { class: 'mbx-axis mbx-axisname', x: 4, y: 10 }, yName),
    );

    const fit = regression(points.map((p) => [p.a, p.b]));
    if (fit) {
      let a = Math.min(...xs);
      let b = Math.max(...xs);
      if (fit.slope !== 0) {
        const p = (yd[0] - fit.intercept) / fit.slope;
        const q = (yd[1] - fit.intercept) / fit.slope;
        a = Math.max(a, Math.min(p, q));
        b = Math.min(b, Math.max(p, q));
      }
      svg.append(
        s('line', { class: 'mbx-fit', x1: x(a), x2: x(b), y1: y(fit.intercept + fit.slope * a), y2: y(fit.intercept + fit.slope * b) }),
      );
    }
    const notes = [
      fit
        ? `${fill(t.fit, { n: points.length, r: num(fit.r, lang, 2, 2) })}.`
        : fill(t.noFit, { n: points.length }),
    ];
    if (points.length < rows.length) notes.push(fill(t.missing, { n: rows.length - points.length }));
    info.textContent = notes.join(' ');

    // Greedy symbol labels: a label is drawn only where it does not collide.
    const boxes: [number, number, number, number][] = points.map((p) => [x(p.a) - 4, y(p.b) - 4, 8, 8]);
    const free = (bx: number, by: number, bw: number) =>
      bx >= M.left &&
      bx + bw <= M.left + plotW &&
      by >= 0 &&
      by + 10 <= M.top + plotH &&
      boxes.every(([ox, oy, ow, oh]) => bx + bw <= ox || bx >= ox + ow || by + 10 <= oy || by >= oy + oh);

    const ring = s('circle', { class: 'mbx-ring', r: 7, visibility: 'hidden' });
    for (const p of points) {
      const px = x(p.a);
      const py = y(p.b);
      const w = p.row.symbol.length * 5.8;
      const spot = ([[px + 6, py - 5], [px - 6 - w, py - 5], [px - w / 2, py - 16], [px - w / 2, py + 6]] as const).find(([bx, by]) =>
        free(bx, by, w),
      );
      if (spot) {
        boxes.push([spot[0], spot[1], w, 10]);
        svg.append(s('text', { class: 'mbx-pointlabel', x: spot[0], y: spot[1] + 8.5 }, p.row.symbol));
      }
      svg.append(marker(regions.indexOf(p.row.region), px, py));
    }
    svg.append(ring);

    let current = -1;
    const show = (i: number) => {
      const p = points[i];
      current = p ? i : -1;
      ring.setAttribute('visibility', p ? 'visible' : 'hidden');
      tip.hidden = !p;
      if (!p) return;
      ring.setAttribute('cx', String(x(p.a)));
      ring.setAttribute('cy', String(y(p.b)));
      tip.replaceChildren(
        h('b', {}, p.row.symbol),
        h('span', {}, p.row.name),
        h('span', {}, `${xName}: ${formatValue(p.a, cx.unit, lang)}`),
        h('span', {}, `${yName}: ${formatValue(p.b, cy.unit, lang)}`),
      );
      const left = x(p.a) + 12 + tip.offsetWidth > width ? x(p.a) - 12 - tip.offsetWidth : x(p.a) + 12;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, Math.min(height - tip.offsetHeight, y(p.b) - 12))}px`;
    };
    const closest = (event: MouseEvent): number => {
      const box = svg.getBoundingClientRect();
      const px = ((event.clientX - box.left) / (box.width || width)) * width;
      const py = ((event.clientY - box.top) / (box.height || height)) * height;
      let best = -1;
      let distance = 18 ** 2;
      points.forEach((p, i) => {
        const d = (x(p.a) - px) ** 2 + (y(p.b) - py) ** 2;
        if (d < distance) {
          distance = d;
          best = i;
        }
      });
      return best;
    };
    svg.addEventListener('pointermove', (event) => {
      const i = closest(event);
      show(i);
      svg.classList.toggle('pointing', i >= 0);
    });
    svg.addEventListener('pointerleave', () => show(-1));
    svg.addEventListener('click', (event) => {
      const p = points[closest(event)];
      if (p) onSelect(p.row.symbol);
    });
    svg.addEventListener('blur', () => show(-1));
    svg.addEventListener('keydown', (event) => {
      let next = current;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current < 0 ? points.length - 1 : current - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = points.length - 1;
      else if (event.key === 'Enter') {
        const p = points[current];
        if (p) onSelect(p.row.symbol);
        return;
      } else return;
      event.preventDefault();
      show(Math.max(0, Math.min(points.length - 1, next)));
      live.textContent = tip.textContent;
    });

    const hadFocus = host.contains(document.activeElement);
    host.replaceChildren(svg, tip);
    if (hadFocus) svg.focus({ preventScroll: true });
  };

  const stop = observeWidth(host, (w) => {
    width = w;
    draw();
  });

  return {
    el: h('figure', { class: 'mbx-chart' }, legend, host, h('span', { class: 'mbx-sr', id: helpId }, t.scatterKeys), live, info, note(t.scatterKeys), data.el),
    update(next) {
      input = next;
      if (!next) {
        host.replaceChildren(empty(lang));
        legend.replaceChildren();
        info.textContent = '';
      } else draw();
      data.refresh();
    },
    dispose: stop,
  };
}
