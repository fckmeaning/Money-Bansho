// The large chart of the section: past closes and the corridor ahead, drawn at the real pixel width so
// the labels stay readable on a phone. All points come from the server (history and forecast.fan).
import { h, s } from '../dossier/dom';
import type { Fan, Forecast } from '../dossier/forecast';
import { locale } from '../dossier/i18n';
import type { Bar } from './data';

const SESSIONS_AHEAD = 20;

export const money = (x: number): string =>
  x.toLocaleString(locale(), { minimumFractionDigits: Math.abs(x) < 1 ? 4 : 2, maximumFractionDigits: Math.abs(x) < 1 ? 4 : 2 });

/** The date `n` trading sessions after `from`: weekends are skipped, exchange holidays are not known. */
export function sessionDate(from: number, n: number): number {
  const day = new Date(from);
  for (let left = n; left > 0;) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getUTCDay() % 6) left -= 1;
  }
  return day.getTime();
}

export const shortDate = (t: number): string =>
  new Date(t).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', timeZone: 'UTC' });

export interface ChartLabels { ahead: string; up: string; down: string; until: string }

export function bigFan(data: Forecast, bars: Bar[], horizon: number, labels: ChartLabels, overlay: Fan[] | null = null): HTMLElement {
  const host = h('div', { class: 'fh-chart' });
  const draw = (width: number) => {
    const narrow = width < 560;
    const height = narrow ? 260 : 400;
    const right = narrow ? 58 : 78;
    const past = bars.filter((b) => b.t <= data.asOf).slice(narrow ? -40 : -90);
    const price = (pct: number) => data.lastClose * (1 + pct / 100);
    const zero: Fan = { h: 0, q025: 0, q10: 0, q25: 0, q75: 0, q90: 0, q975: 0 };
    const fan = [zero, ...data.fan];
    const all = [
      ...past.map((b) => b.c), data.lastClose,
      ...[...fan, ...(overlay ?? [])].flatMap((r) => [price(r.q025), price(r.q975), price(r.q10), price(r.q90)]),
    ];
    const low = Math.min(...all);
    const high = Math.max(...all);
    const plot = width - right - 6;
    // The part ahead gets more room than its share of sessions: it is what the page is about.
    const split = past.length > 1 ? plot * (narrow ? 0.45 : 0.55) : 0;
    const xPast = (i: number) => 6 + (i / Math.max(1, past.length - 1)) * split;
    const x = (d: number) => 6 + split + (d / SESSIONS_AHEAD) * (plot - split);
    // The top strip holds the name of the forecast period.
    const y = (v: number) => 30 + (1 - (v - low) / (high - low || 1)) * (height - 56);
    const until = `${labels.until} ≈${shortDate(sessionDate(data.asOf, horizon))}`;
    const line = (rows: Fan[], key: Exclude<keyof Fan, 'h'>) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.h)} ${y(price(r[key]))}`).join('');
    const band = (lo: Exclude<keyof Fan, 'h'>, hi: Exclude<keyof Fan, 'h'>) =>
      s('path', { class: 'fc-band', d: `${line(fan, hi)}${[...fan].reverse().map((r) => `L${x(r.h)} ${y(price(r[lo]))}`).join('')}Z` });
    const at = data.fan.find((r) => r.h === horizon);
    // The labels use the server's prices, the same figures as in the panel above the chart.
    const exact = data.horizons.find((p) => p.h === horizon);
    const grid = [0, 1, 2, 3, 4].map((i) => low + ((high - low) * i) / 4);
    const direction = data.direction ?? [];
    const called = direction.find((r) => r.h === horizon);
    // The violet line of the expected side; its label sits at the chosen horizon.
    const callMarks = called
      ? [
        s('path', { class: 'fc-dir', d: `M${x(0)} ${y(data.lastClose)}${direction.map((r) => `L${x(r.h)} ${y(r.price)}`).join('')}` }),
        ...direction.filter((r) => [1, 5, SESSIONS_AHEAD].includes(r.h)).map((r) => s('circle', { class: 'fc-dir-dot', cx: x(r.h), cy: y(r.price), r: 3 })),
        s('circle', { class: 'fc-dir-dot', cx: x(horizon), cy: y(called.price), r: 5.5 }),
        s('text', {
          class: 'fc-dir-text', x: x(horizon) + (horizon > 8 ? -6 : 8), y: y(called.price) + (called.side === 'up' ? -10 : 20),
          'text-anchor': horizon > 8 ? 'end' : 'start',
        }, `${called.side === 'up' ? `▲ ${labels.up}` : `▼ ${labels.down}`} ${money(called.price)}`),
      ]
      : [];
    const tag = (value: number, cls: string, label = money(value)) =>
      s('text', { x: x(horizon) + (horizon > 14 ? -4 : 5), y: y(value) + (cls === 'up' ? -6 : 14), class: 'fh-edge', 'text-anchor': horizon > 14 ? 'end' : 'start' }, label);
    host.replaceChildren(
      s(
        'svg',
        {
          class: 'fh-fan', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img',
          'aria-label': at ? `${money(price(at.q10))} … ${money(price(at.q90))}` : '',
        },
        s('rect', { class: 'fh-period', x: x(0), y: 8, width: Math.max(2, x(horizon) - x(0)), height: height - 34 }),
        s('text', { class: 'fh-period-text', x: width - right, y: 20, 'text-anchor': 'end' }, `${labels.ahead.replace('{n}', String(horizon))} · ${until}`),
        ...grid.flatMap((v) => [
          s('line', { class: 'fh-grid', x1: 6, x2: width - right, y1: y(v), y2: y(v) }),
          s('text', { x: width - right + 6, y: y(v) + 4 }, money(v)),
        ]),
        band('q10', 'q90'),
        band('q25', 'q75'),
        s('path', { class: 'fc-outer', d: line(fan, 'q975') }),
        s('path', { class: 'fc-outer', d: line(fan, 'q025') }),
        s('line', { class: 'fc-mid', x1: x(0), x2: x(SESSIONS_AHEAD), y1: y(data.lastClose), y2: y(data.lastClose) }),
        past.length > 1
          ? s('path', { class: 'fh-past', d: past.map((b, i) => `${i ? 'L' : 'M'}${xPast(i)} ${y(b.c)}`).join('') })
          : null,
        s('line', { class: 'fh-now', x1: x(0), x2: x(0), y1: 8, y2: height - 26 }),
        ...(overlay ? [s('path', { class: 'fc-event', d: line([zero, ...overlay], 'q90') }), s('path', { class: 'fc-event', d: line([zero, ...overlay], 'q10') })] : []),
        ...(at
          ? [
            s('line', { class: 'fh-mark', x1: x(horizon), x2: x(horizon), y1: y(price(at.q90)), y2: y(price(at.q10)) }),
            s('circle', { class: 'fh-dot', cx: x(horizon), cy: y(price(at.q90)), r: 3.5 }),
            s('circle', { class: 'fh-dot', cx: x(horizon), cy: y(price(at.q10)), r: 3.5 }),
            tag(price(at.q90), 'up', exact && money(exact.highPrice)),
            tag(price(at.q10), 'down', exact && money(exact.lowPrice)),
          ]
          : []),
        ...callMarks,
        past[0] ? s('text', { x: 6, y: height - 8 }, shortDate(past[0].t)) : null,
        s('text', { x: x(0), y: height - 8, 'text-anchor': 'middle' }, shortDate(data.asOf)),
        ...(narrow ? [SESSIONS_AHEAD] : [5, 10, 15, SESSIONS_AHEAD]).map((d) => s(
          'text', { x: x(d), y: height - 8, 'text-anchor': d === SESSIONS_AHEAD ? 'end' : 'middle' }, `≈${shortDate(sessionDate(data.asOf, d))}`,
        )),
      ),
    );
  };
  let drawn = 0;
  // A background tab gets no resize notifications: draw once from the layout width as well.
  window.setTimeout(() => {
    const width = host.clientWidth;
    if (!drawn && width > 0) {
      drawn = width;
      draw(width);
    }
  }, 60);
  new ResizeObserver((entries) => {
    const width = Math.floor(entries[0]?.contentRect.width ?? 0);
    if (width > 0 && width !== drawn) {
      drawn = width;
      draw(width);
    }
  }).observe(host);
  return host;
}

/** One corridor on a shared percentage scale: thin line 95%, band 80%, dark band 50%, tick at zero. */
export function rangeBar(limit: number, outer: [number, number] | null, wide: [number, number], inner: [number, number] | null): HTMLElement {
  const place = (cls: string, [low, high]: [number, number]) => {
    const node = h('i', { class: cls });
    node.style.left = `${50 + (low / limit) * 50}%`;
    node.style.width = `${((high - low) / limit) * 50}%`;
    return node;
  };
  return h(
    'span',
    { class: 'fh-range', 'aria-hidden': 'true' },
    outer ? place('r95', outer) : null,
    place('r80', wide),
    inner ? place('r50', inner) : null,
    h('b', {}),
  );
}
