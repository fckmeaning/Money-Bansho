// Correlation matrix on a canvas, with a text readout, keyboard cursor, pair
// lists and a per-company table as alternatives.
import { h } from '../dom';
import { formatValue } from './format';
import type { Lang } from './format';
import type { Correlation, Nullable, Row } from './parse';
import { fill, strings } from './strings';
import { disclosure, empty, note, observeWidth, picker, scroller, segmented, table, track, uid } from './ui';

type Order = 'cluster' | 'region' | 'average' | 'source';

const GUTTER = 58;
const MIN_CELL = 9;
const MAX_CELL = 38;

type Rgb = [number, number, number];

function colour(root: Element, name: string, fallback: Rgb): Rgb {
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw)?.[1];
  if (!hex) return fallback;
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const mix = (a: Rgb, b: Rgb, share: number): string =>
  `rgb(${a.map((v, i) => Math.round(v + ((b[i] as number) - v) * share)).join(',')})`;

export interface CorrelationInput { data: Correlation; rows: Row[] }
export interface CorrelationView { el: HTMLElement; update(input: CorrelationInput | null): void; dispose(): void }

/** Greedy nearest-neighbour chain: each next company is the one most correlated with the previous. */
function chain(indices: number[], matrix: Nullable[][], mean: Map<number, number>): number[] {
  const rest = new Set(indices);
  const out: number[] = [];
  let current = [...indices].sort((a, b) => (mean.get(b) ?? 0) - (mean.get(a) ?? 0))[0];
  while (current !== undefined) {
    out.push(current);
    rest.delete(current);
    let next: number | undefined;
    let best = -Infinity;
    for (const j of rest) {
      const v = matrix[current]?.[j] ?? -2;
      if (v > best) {
        best = v;
        next = j;
      }
    }
    current = next;
  }
  return out;
}

export function correlationView(lang: Lang, onSelect: (symbol: string) => void): CorrelationView {
  const t = strings(lang);
  const canvas = h('canvas', { class: 'mbx-matrix', tabindex: 0, role: 'application' });
  const rowMark = h('i', { class: 'mbx-matrix-mark', hidden: true });
  const colMark = h('i', { class: 'mbx-matrix-mark', hidden: true });
  const stage = h('div', { class: 'mbx-matrix-stage' }, canvas, rowMark, colMark);
  const host = h('div', { class: 'mbx-matrix-scroll' }, stage);
  const readout = h('p', { class: 'mbx-matrix-readout mono', 'aria-live': 'polite' });
  const legend = h('div', { class: 'mbx-legend' });
  const lists = h('div', { class: 'mbx-grid2' });
  const message = h('div', {});
  const helpId = uid('help');
  canvas.setAttribute('aria-describedby', helpId);

  let input: CorrelationInput | null = null;
  let order: Order = 'cluster';
  let sequence: number[] = [];
  let width = 0;
  let cell = MIN_CELL;
  let cursor: [number, number] | null = null;
  let focusSymbol = '';

  const symbolAt = (k: number): string => input?.data.symbols[sequence[k] ?? -1] ?? '';
  const valueAt = (r: number, c: number): Nullable => input?.data.matrix[sequence[r] ?? -1]?.[sequence[c] ?? -1] ?? null;
  const fmt = (v: Nullable) => (v === null ? t.noData : formatValue(v, 'ratio', lang, true));

  const resort = () => {
    if (!input) return;
    const { data, rows } = input;
    // Only companies that pass the table filters, in matrix order.
    const allowed = new Set(rows.map((r) => r.symbol));
    const indices = data.symbols.map((_, i) => i).filter((i) => allowed.has(data.symbols[i] as string));
    const mean = new Map(
      indices.map((i) => {
        const values = indices.filter((j) => j !== i).map((j) => data.matrix[i]?.[j]).filter((v): v is number => typeof v === 'number');
        return [i, values.length ? values.reduce((a, b) => a + b, 0) / values.length : -2] as const;
      }),
    );
    if (order === 'source') sequence = indices;
    else if (order === 'average') sequence = [...indices].sort((a, b) => (mean.get(b) ?? 0) - (mean.get(a) ?? 0));
    else if (order === 'cluster') sequence = chain(indices, data.matrix, mean);
    else {
      const region = new Map(rows.map((r) => [r.symbol, r.region]));
      sequence = [...indices].sort((a, b) =>
        (region.get(data.symbols[a] as string) ?? '').localeCompare(region.get(data.symbols[b] as string) ?? ''),
      );
    }
  };

  const draw = () => {
    const n = sequence.length;
    if (!input || n < 2 || width < 40) return;
    cell = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor((width - GUTTER - 2) / n)));
    const size = GUTTER + n * cell + 1;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * ratio);
    canvas.height = Math.round(size * ratio);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const neutral = colour(host, '--raise', [26, 30, 37]);
    const positive = colour(host, '--mbx-pos', [107, 140, 174]);
    const negative = colour(host, '--mbx-neg', [201, 123, 69]);
    const ink = colour(host, '--text', [216, 213, 204]);
    const muted = colour(host, '--muted', [138, 135, 126]);
    const dark = colour(host, '--bg', [13, 15, 18]);
    const rgb = (c: Rgb) => `rgb(${c.join(',')})`;
    const mono = getComputedStyle(host).getPropertyValue('--mbx-mono').trim() || 'monospace';

    const labelSize = Math.max(7, Math.min(11, cell - 1));
    ctx.font = `${labelSize}px ${mono}`;
    ctx.fillStyle = rgb(muted);
    ctx.textBaseline = 'middle';
    for (let k = 0; k < n; k++) {
      const middle = GUTTER + k * cell + cell / 2;
      ctx.textAlign = 'right';
      ctx.fillText(symbolAt(k), GUTTER - 4, middle, GUTTER - 6);
      ctx.save();
      ctx.translate(middle, GUTTER - 4);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'left';
      ctx.fillText(symbolAt(k), 0, 0, GUTTER - 6);
      ctx.restore();
    }

    ctx.textAlign = 'center';
    const gap = cell >= 14 ? 1 : 0.5;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const v = valueAt(r, c);
        const px = GUTTER + c * cell;
        const py = GUTTER + r * cell;
        const strength = v === null || r === c ? 0 : Math.abs(v);
        ctx.fillStyle = v === null || r === c ? rgb(neutral) : mix(neutral, v < 0 ? negative : positive, strength);
        ctx.fillRect(px, py, cell - gap, cell - gap);
        const cx = px + (cell - gap) / 2;
        const cy = py + (cell - gap) / 2;
        if (r === c) {
          ctx.fillStyle = rgb(muted);
          ctx.fillRect(cx - 1, cy - 1, 2, 2);
        } else if (v === null) {
          ctx.strokeStyle = rgb(muted);
          ctx.lineWidth = 1;
          const arm = Math.max(1.5, cell / 6);
          ctx.beginPath();
          ctx.moveTo(cx - arm, cy - arm);
          ctx.lineTo(cx + arm, cy + arm);
          ctx.moveTo(cx + arm, cy - arm);
          ctx.lineTo(cx - arm, cy + arm);
          ctx.stroke();
        } else if (cell >= 22) {
          // Whole hundredths in small cells ("62" is 0.62); the readout gives the decimal.
          const label = cell >= 32 ? formatValue(v, 'ratio', lang) : `${v < 0 ? '−' : ''}${Math.round(Math.abs(v) * 100)}`;
          ctx.font = `${cell >= 32 ? 10 : 9}px ${mono}`;
          ctx.fillStyle = strength > 0.65 ? rgb(dark) : rgb(ink);
          ctx.fillText(label, cx, cy + 0.5, cell - 2);
        } else if (v < 0) {
          ctx.fillStyle = strength > 0.65 ? rgb(dark) : rgb(ink);
          ctx.fillRect(cx - cell * 0.28, cy - 0.75, cell * 0.56, 1.5);
        }
      }
    }
    paint();
  };

  const paint = () => {
    const n = sequence.length;
    if (!cursor || cursor[0] >= n || cursor[1] >= n) {
      rowMark.hidden = true;
      colMark.hidden = true;
      return;
    }
    const [r, c] = cursor;
    rowMark.hidden = false;
    colMark.hidden = false;
    rowMark.style.cssText = `left:0;top:${GUTTER + r * cell - 1}px;width:${GUTTER + (c + 1) * cell}px;height:${cell + 1}px`;
    colMark.style.cssText = `top:0;left:${GUTTER + c * cell - 1}px;height:${GUTTER + (r + 1) * cell}px;width:${cell + 1}px`;
    readout.textContent = `${symbolAt(r)} × ${symbolAt(c)}: ${fmt(valueAt(r, c))}`;
  };

  const locate = (event: MouseEvent): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return [
      Math.floor((event.clientY - box.top - GUTTER) / cell),
      Math.floor((event.clientX - box.left - GUTTER) / cell),
    ];
  };
  canvas.addEventListener('pointermove', (event) => {
    const [r, c] = locate(event);
    const n = sequence.length;
    const inside = r >= 0 && c >= 0 && r < n && c < n;
    // Over a label gutter the pointer opens that company.
    canvas.style.cursor = (r < 0 && c >= 0 && c < n) || (c < 0 && r >= 0 && r < n) ? 'pointer' : 'crosshair';
    if (inside) {
      cursor = [r, c];
      paint();
    }
  });
  canvas.addEventListener('pointerdown', (event) => {
    const [r, c] = locate(event);
    const n = sequence.length;
    if (r >= 0 && c >= 0 && r < n && c < n) {
      cursor = [r, c];
      paint();
    }
  });
  canvas.addEventListener('click', (event) => {
    const [r, c] = locate(event);
    const n = sequence.length;
    if (c < 0 && r >= 0 && r < n) onSelect(symbolAt(r));
    else if (r < 0 && c >= 0 && c < n) onSelect(symbolAt(c));
  });
  canvas.addEventListener('keydown', (event) => {
    const n = sequence.length;
    if (n < 2) return;
    let [r, c] = cursor ?? [0, 0];
    if (event.key === 'ArrowUp') r -= 1;
    else if (event.key === 'ArrowDown') r += 1;
    else if (event.key === 'ArrowLeft') c -= 1;
    else if (event.key === 'ArrowRight') c += 1;
    else if (event.key === 'Home') c = 0;
    else if (event.key === 'End') c = n - 1;
    else if (event.key === 'Enter') {
      if (cursor) onSelect(symbolAt(r));
      return;
    } else return;
    event.preventDefault();
    cursor = [Math.max(0, Math.min(n - 1, r)), Math.max(0, Math.min(n - 1, c))];
    paint();
    // Keep the cursor cell inside the scroll box.
    const px = GUTTER + cursor[1] * cell;
    const py = GUTTER + cursor[0] * cell;
    if (px < host.scrollLeft + GUTTER) host.scrollLeft = px - GUTTER;
    else if (px + cell > host.scrollLeft + host.clientWidth) host.scrollLeft = px + cell - host.clientWidth;
    if (py < host.scrollTop + GUTTER) host.scrollTop = py - GUTTER;
    else if (py + cell > host.scrollTop + host.clientHeight) host.scrollTop = py + cell - host.clientHeight;
  });

  const symbolButton = (symbol: string) =>
    h('button', { type: 'button', class: 'mbx-link', onclick: () => onSelect(symbol) }, symbol);

  const pairList = (title: string, pairs: { a: string; b: string; v: number }[]) =>
    h(
      'div',
      { class: 'mbx-sub' },
      h('h4', {}, title),
      scroller(
        table(
          title,
          [{ text: t.pair }, { text: '' }, { text: t.corr, numeric: true }],
          pairs.map((p) =>
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, symbolButton(p.a), ' × ', symbolButton(p.b)),
              h('td', { class: 'mbx-trackcell' }, track(p.v, -1, 1)),
              h('td', { class: 'num' }, fmt(p.v)),
            ),
          ),
          'mbx-barstable',
        ),
        title,
      ),
    );

  const single = disclosure(t.perSymbol, () => {
    const symbols = sequence.map((_, k) => symbolAt(k)).sort();
    if (!symbols.includes(focusSymbol)) focusSymbol = symbols[0] ?? '';
    const body = h('div', {});
    const render = () => {
      const k = sequence.findIndex((_, i) => symbolAt(i) === focusSymbol);
      const others = sequence
        .map((_, i) => ({ symbol: symbolAt(i), v: valueAt(k, i), i }))
        .filter((o) => o.i !== k)
        .sort((a, b) => (b.v ?? -2) - (a.v ?? -2));
      body.replaceChildren(
        scroller(
          table(
            t.perSymbol,
            [{ text: t.against }, { text: t.corr, numeric: true }],
            others.map((o) => h('tr', {}, h('th', { scope: 'row' }, symbolButton(o.symbol)), h('td', { class: 'num' }, fmt(o.v)))),
          ),
          t.perSymbol,
          'mbx-short',
        ),
      );
    };
    const choose = picker(t.symbol, (value) => {
      focusSymbol = value;
      render();
    });
    choose.set(symbols.map((v) => [v, v] as const), focusSymbol);
    render();
    return h('div', {}, choose.el, body);
  });

  const steps = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
  legend.append(
    h('span', { class: 'mbx-unit' }, t.corrScale),
    ...steps.map((v) =>
      h(
        'span',
        { class: 'mbx-key' },
        h('i', {
          class: 'mbx-swatch-box',
          style: `background:color-mix(in srgb, var(--mbx-${v < 0 ? 'neg' : 'pos'}) ${Math.abs(v) * 100}%, var(--raise, #1a1e25))`,
        }),
        h('em', {}, formatValue(v, 'ratio', lang, true)),
      ),
    ),
  );

  const controls = h(
    'div',
    { class: 'mbx-toolbar' },
    h('span', { class: 'mbx-unit' }, t.order),
    segmented<Order>(
      t.order,
      [
        ['cluster', t.oCluster],
        ['region', t.oRegion],
        ['average', t.oAverage],
        ['source', t.oSource],
      ],
      order,
      (value) => {
        order = value;
        cursor = null;
        resort();
        draw();
        readout.textContent = t.corrHint;
      },
    ),
  );

  const body = h('div', { class: 'mbx-stack' }, controls, legend, readout, host, h('span', { class: 'mbx-sr', id: helpId }, t.corrHint), note(t.corrMarks), lists, single.el);

  const stop = observeWidth(host, (w) => {
    width = w;
    draw();
  });

  return {
    el: h('div', {}, message, body),
    update(next) {
      const keep = cursor ? [symbolAt(cursor[0]), symbolAt(cursor[1])] : null;
      input = next;
      sequence = [];
      resort();
      const usable = input !== null && sequence.length >= 2;
      body.hidden = !usable;
      message.replaceChildren(...(usable ? [] : [empty(lang, input ? t.corrFew : undefined)]));
      if (!usable) return;
      const find = (symbol: string) => sequence.findIndex((_, i) => symbolAt(i) === symbol);
      const r = keep ? find(keep[0] as string) : -1;
      const c = keep ? find(keep[1] as string) : -1;
      cursor = r >= 0 && c >= 0 ? [r, c] : null;
      readout.textContent = t.corrHint;
      canvas.setAttribute('aria-label', fill(t.corrAria, { n: sequence.length }));

      const pairs: { a: string; b: string; v: number }[] = [];
      for (let i = 0; i < sequence.length; i++) {
        for (let j = i + 1; j < sequence.length; j++) {
          const v = valueAt(i, j);
          if (v !== null) pairs.push({ a: symbolAt(i), b: symbolAt(j), v });
        }
      }
      pairs.sort((a, b) => b.v - a.v);
      const top = Math.min(8, Math.ceil(pairs.length / 2));
      const bottom = Math.min(8, pairs.length - top);
      lists.replaceChildren(
        pairList(t.pairsHigh, pairs.slice(0, top)),
        pairList(t.pairsLow, bottom ? pairs.slice(-bottom).reverse() : []),
      );
      width ||= Math.floor(host.clientWidth);
      draw();
      single.refresh();
    },
    dispose: stop,
  };
}
