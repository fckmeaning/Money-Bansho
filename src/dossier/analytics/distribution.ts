// Return histogram with the normal expectation, and a normal QQ plot.
import { h, s } from '../dom';
import { num } from './format';
import type { Lang } from './format';
import type { Histogram, QQ } from './parse';
import { linear, padded, quantile, ticks } from './scale';
import { strings } from './strings';
import { disclosure, note, observeWidth, scroller, table, uid } from './ui';

const HEIGHT = 240;
const M = { left: 46, right: 10, top: 8, bottom: 32 };

function frame(title: string, legend: Node[], keys: string) {
  const readout = h('div', { class: 'mbx-legend' });
  const host = h('div', { class: 'mbx-plot', style: `min-height:${HEIGHT}px` });
  const live = h('span', { class: 'mbx-sr', 'aria-live': 'polite' });
  const helpId = uid('help');
  const el = h(
    'figure',
    { class: 'mbx-chart' },
    h('div', { class: 'mbx-chart-head' }, h('h4', {}, title)),
    h('div', { class: 'mbx-legend' }, ...legend),
    readout,
    host,
    h('span', { class: 'mbx-sr', id: helpId }, keys),
    live,
  );
  return { el, host, readout, live, helpId };
}

const key = (className: string, label: string) =>
  h('span', { class: 'mbx-key' }, h('i', { class: className }), h('em', {}, label));

const cell = (label: string, value: string) => h('span', { class: 'mbx-key' }, h('em', {}, label), h('b', {}, value));

function arrows(event: KeyboardEvent, current: number, last: number): number | null {
  const step = event.shiftKey ? 5 : 1;
  let next = current;
  if (event.key === 'ArrowLeft') next -= step;
  else if (event.key === 'ArrowRight') next += step;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = last;
  else return null;
  event.preventDefault();
  return Math.max(0, Math.min(last, next));
}

export function histogramChart(data: Histogram, lang: Lang): HTMLElement {
  const t = strings(lang);
  const hasNormal = data.expected.some((v) => v !== null);
  const { el, host, readout, live, helpId } = frame(
    t.chHist,
    [key('mbx-swatch-box s1', t.observed), ...(hasNormal ? [key('mbx-swatch-line gold', t.expected)] : [])],
    t.histKeys,
  );
  const n = data.counts.length;
  const binText = (i: number) =>
    `${num(data.edges[i] as number, lang, 2, 2)}% … ${num(data.edges[i + 1] as number, lang, 2, 2)}%`;
  const expectedText = (i: number) => {
    const v = data.expected[i];
    return v === null || v === undefined ? t.noData : num(v, lang, 0, 1);
  };
  let current = data.counts.indexOf(Math.max(...data.counts));
  const show = (i: number) => {
    readout.replaceChildren(
      cell(t.bin, binText(i)),
      cell(t.observed, num(data.counts[i] as number, lang, 0, 0)),
      ...(hasNormal ? [cell(t.expected, expectedText(i))] : []),
    );
  };
  show(current);

  observeWidth(host, (width) => {
    const plotW = width - M.left - M.right;
    const plotH = HEIGHT - M.top - M.bottom;
    const first = data.edges[0] as number;
    const last = data.edges[n] as number;
    const x = linear(first, last, M.left, M.left + plotW);
    const top = Math.max(1, ...data.counts, ...data.expected.map((v) => v ?? 0)) * 1.06;
    const y = linear(0, top, M.top + plotH, M.top);
    const svg = s('svg', {
      class: 'mbx-svg',
      width,
      height: HEIGHT,
      viewBox: `0 0 ${width} ${HEIGHT}`,
      tabindex: 0,
      role: 'group',
      'aria-label': `${t.chHist}. ${t.sessionsCount}: ${num(data.counts.reduce((a, b) => a + b, 0), lang, 0, 0)}`,
      'aria-describedby': helpId,
    });
    for (const v of ticks(0, top, 5)) {
      svg.append(
        s('line', { class: 'mbx-grid', x1: M.left, x2: M.left + plotW, y1: y(v), y2: y(v) }),
        s('text', { class: 'mbx-axis', x: M.left - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, num(v, lang, 0, 1)),
      );
    }
    for (const v of ticks(first, last, Math.max(3, Math.floor(plotW / 60)))) {
      svg.append(
        s('text', { class: 'mbx-axis', x: x(v), y: HEIGHT - 18, 'text-anchor': 'middle' }, num(v, lang, 0, 2)),
      );
    }
    svg.append(
      s('text', { class: 'mbx-axis', x: M.left + plotW / 2, y: HEIGHT - 4, 'text-anchor': 'middle' }, t.returnAxis),
      s('text', { class: 'mbx-axis', x: 10, y: M.top + plotH / 2, 'text-anchor': 'middle', transform: `rotate(-90 10 ${M.top + plotH / 2})` }, t.sessionsCount),
    );
    const bars = data.counts.map((count, i) => {
      const x0 = x(data.edges[i] as number);
      const x1 = x(data.edges[i + 1] as number);
      return s('rect', {
        class: 'mbx-bar s1',
        x: x0 + 0.5,
        y: y(count),
        width: Math.max(0.5, x1 - x0 - 1),
        height: Math.max(0, y(0) - y(count)),
      });
    });
    svg.append(...bars, s('line', { class: 'mbx-zeroline', x1: M.left, x2: M.left + plotW, y1: y(0), y2: y(0) }));
    if (first < 0 && last > 0) {
      svg.append(s('line', { class: 'mbx-ref', x1: x(0), x2: x(0), y1: M.top, y2: y(0) }));
    }
    let d = '';
    let pen = false;
    data.expected.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      const cx = x(((data.edges[i] as number) + (data.edges[i + 1] as number)) / 2);
      d += `${pen ? 'L' : 'M'}${cx.toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    if (d) svg.append(s('path', { class: 'mbx-line gold', d }));
    const mark = (i: number) => {
      current = i;
      bars.forEach((bar, k) => bar.classList.toggle('active', k === i));
      show(i);
    };
    svg.addEventListener('pointermove', (event) => {
      const box = svg.getBoundingClientRect();
      const px = ((event.clientX - box.left) / (box.width || width)) * width;
      const value = first + ((px - M.left) / plotW) * (last - first);
      let i = 0;
      while (i < n - 1 && value >= (data.edges[i + 1] as number)) i += 1;
      mark(i);
    });
    svg.addEventListener('keydown', (event) => {
      const next = arrows(event, current, n - 1);
      if (next === null) return;
      mark(next);
      live.textContent = readout.textContent;
    });
    host.replaceChildren(svg);
  });

  el.append(
    disclosure(t.dataTable, () =>
      scroller(
        table(
          t.chHist,
          [{ text: t.bin }, { text: t.observed, numeric: true }, { text: t.expected, numeric: true }],
          data.counts.map((count, i) =>
            h('tr', {}, h('th', { scope: 'row' }, binText(i)), h('td', { class: 'num' }, num(count, lang, 0, 0)), h('td', { class: 'num' }, expectedText(i))),
          ),
        ),
        t.chHist,
        'mbx-short',
      ),
    ).el,
  );
  return el;
}

export function qqChart(data: QQ, lang: Lang): HTMLElement {
  const t = strings(lang);
  const { el, host, readout, live, helpId } = frame(
    t.chQq,
    [key('mbx-swatch-dot s1', t.sample), key('mbx-swatch-line gold', t.refLine)],
    t.qqKeys,
  );
  const n = data.theoretical.length;
  const fmt = (v: number) => num(v, lang, 2, 2);
  const sorted = [...data.sample].sort((a, b) => a - b);
  const sortedT = [...data.theoretical];
  const tq1 = quantile(sortedT, 0.25);
  const tq3 = quantile(sortedT, 0.75);
  const slope = tq3 === tq1 ? null : (quantile(sorted, 0.75) - quantile(sorted, 0.25)) / (tq3 - tq1);
  const intercept = slope === null ? 0 : quantile(sorted, 0.25) - slope * tq1;
  let current = n - 1;
  const show = (i: number) => {
    readout.replaceChildren(
      cell(t.theoretical, fmt(data.theoretical[i] as number)),
      cell(t.sample, fmt(data.sample[i] as number)),
    );
  };
  show(current);

  observeWidth(host, (width) => {
    const plotW = width - M.left - M.right;
    const plotH = HEIGHT - M.top - M.bottom;
    const xd = padded([sortedT[0] as number, sortedT[n - 1] as number], false);
    const yd = padded([sorted[0] as number, sorted[n - 1] as number], false);
    const x = linear(xd[0], xd[1], M.left, M.left + plotW);
    const y = linear(yd[0], yd[1], M.top + plotH, M.top);
    const svg = s('svg', {
      class: 'mbx-svg',
      width,
      height: HEIGHT,
      viewBox: `0 0 ${width} ${HEIGHT}`,
      tabindex: 0,
      role: 'group',
      'aria-label': t.chQq,
      'aria-describedby': helpId,
    });
    for (const v of ticks(yd[0], yd[1], 5)) {
      svg.append(
        s('line', { class: 'mbx-grid', x1: M.left, x2: M.left + plotW, y1: y(v), y2: y(v) }),
        s('text', { class: 'mbx-axis', x: M.left - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, num(v, lang, 0, 2)),
      );
    }
    for (const v of ticks(xd[0], xd[1], Math.max(3, Math.floor(plotW / 60)))) {
      svg.append(s('text', { class: 'mbx-axis', x: x(v), y: HEIGHT - 18, 'text-anchor': 'middle' }, num(v, lang, 0, 2)));
    }
    svg.append(
      s('text', { class: 'mbx-axis', x: M.left + plotW / 2, y: HEIGHT - 4, 'text-anchor': 'middle' }, t.theoretical),
      s('text', { class: 'mbx-axis', x: 10, y: M.top + plotH / 2, 'text-anchor': 'middle', transform: `rotate(-90 10 ${M.top + plotH / 2})` }, t.sample),
    );
    if (slope !== null) {
      // Clip the reference line to the plotted domain.
      let a = xd[0];
      let b = xd[1];
      if (slope !== 0) {
        const p = (yd[0] - intercept) / slope;
        const q = (yd[1] - intercept) / slope;
        a = Math.max(a, Math.min(p, q));
        b = Math.min(b, Math.max(p, q));
      }
      if (a < b) {
        svg.append(s('line', { class: 'mbx-line gold', x1: x(a), x2: x(b), y1: y(intercept + slope * a), y2: y(intercept + slope * b) }));
      }
    }
    let d = '';
    for (let i = 0; i < n; i++) {
      d += `M${x(data.theoretical[i] as number).toFixed(1)} ${y(data.sample[i] as number).toFixed(1)}h0.01`;
    }
    const ring = s('circle', { class: 'mbx-ring', r: 5 });
    svg.append(s('path', { class: 'mbx-points', d }), ring);
    const mark = (i: number) => {
      current = i;
      ring.setAttribute('cx', String(x(data.theoretical[i] as number)));
      ring.setAttribute('cy', String(y(data.sample[i] as number)));
      show(i);
    };
    mark(current);
    svg.addEventListener('pointermove', (event) => {
      const box = svg.getBoundingClientRect();
      const px = ((event.clientX - box.left) / (box.width || width)) * width;
      const py = ((event.clientY - box.top) / (box.height || HEIGHT)) * HEIGHT;
      let best = 0;
      let distance = Infinity;
      for (let i = 0; i < n; i++) {
        const q = (x(data.theoretical[i] as number) - px) ** 2 + (y(data.sample[i] as number) - py) ** 2;
        if (q < distance) {
          distance = q;
          best = i;
        }
      }
      mark(best);
    });
    svg.addEventListener('keydown', (event) => {
      const next = arrows(event, current, n - 1);
      if (next === null) return;
      mark(next);
      live.textContent = readout.textContent;
    });
    host.replaceChildren(svg);
  });

  el.append(
    note(t.qqNote),
    disclosure(t.dataTable, () =>
      scroller(
        table(
          t.chQq,
          [{ text: t.theoretical, numeric: true }, { text: t.sample, numeric: true }],
          data.theoretical.map((v, i) =>
            h('tr', {}, h('td', { class: 'num' }, fmt(v)), h('td', { class: 'num' }, fmt(data.sample[i] as number))),
          ),
        ),
        t.chQq,
        'mbx-short',
      ),
    ).el,
  );
  return el;
}
