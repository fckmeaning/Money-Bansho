// Overview signal plate: the headline model outputs, each labelled for what it is.
import { fixed, h, pct, share, signed, tone } from './dom';
import { scoreLabel, t } from './i18n';
import { SIGNAL_PARTS } from './types';
import type { Dossier, ImpactLevel, SignalPart, Signals } from './types';

/** Thresholds of the event study, as documented in docs/bansho-math.md. */
export function zLevel(z: number | null): ImpactLevel | null {
  if (z === null) return null;
  const size = Math.abs(z);
  return size >= 1.96 ? 'significant' : size >= 1 ? 'notable' : 'noise';
}

const percentWidth = (node: HTMLElement, from: number, to: number) => {
  node.style.left = `${Math.max(0, Math.min(100, from))}%`;
  node.style.width = `${Math.max(0, Math.min(100, to) - Math.max(0, from))}%`;
};

function tile(id: string, title: string, ...body: (Node | null)[]): HTMLElement {
  return h('section', { class: `tile tile-${id}`, 'aria-label': title }, h('h3', {}, title), ...body);
}

const figure = (value: string, unit: string | null, cls = ''): HTMLElement =>
  h(
    'p',
    { class: 'figure mono' },
    h('b', { class: cls }, value),
    unit ? h('span', {}, unit) : null,
  );

const missing = () => h('p', { class: 'figure none' }, t('noData'));
const word = (text: string | null) => (text ? h('p', { class: 'verdict' }, text) : null);
const detail = (...parts: (string | null)[]): HTMLElement | null => {
  const text = parts.filter(Boolean).join(' · ');
  return text ? h('p', { class: 'detail' }, text) : null;
};

/** A symmetric scale from −limit to +limit with the ±1.96 thresholds marked. */
function zScale(z: number | null, limit = 4): HTMLElement | null {
  if (z === null) return null;
  const at = (value: number) => ((Math.max(-limit, Math.min(limit, value)) + limit) / (2 * limit)) * 100;
  const mark = (value: number, cls: string) => {
    const node = h('i', { class: cls });
    node.style.left = `${at(value)}%`;
    return node;
  };
  return h(
    'div',
    { class: 'scale', 'aria-hidden': 'true' },
    mark(-1.96, 'limit'),
    mark(0, 'zero'),
    mark(1.96, 'limit'),
    mark(z, 'now'),
  );
}

/** A missing input reads "no data", not "z no data". */
function partValue(signals: Signals, key: SignalPart): string {
  const some = (value: number | null | undefined, format: (v: number) => string) =>
    value === null || value === undefined ? t('noData') : format(value);
  switch (key) {
    case 'price':
      return some(signals.price?.z, (v) => `z ${signed(v)}`);
    case 'news':
      return some(signals.news?.z, (v) => `z ${signed(v)}`);
    case 'volume':
      return some(signals.volumeRatio, (v) => `×${fixed(v)}`);
    case 'volatility':
      return some(signals.volatility?.ratio, (v) => `ρ ${fixed(v)}`);
  }
}

function attentionTile(signals: Signals | null): HTMLElement {
  const attention = signals?.attention ?? null;
  if (!signals || !attention || attention.score === null) return tile('attention', t('attention'), missing());
  const score = Math.round(attention.score);
  const fill = h('i', {});
  fill.style.width = `${score}%`;
  const parts = SIGNAL_PARTS.map((key) => {
    const part = attention.parts.find((p) => p.key === key);
    const bar = h('i', {});
    bar.style.width = `${(part?.share ?? 0) * 100}%`;
    return h(
      'tr',
      {},
      h('th', { scope: 'row' }, t(`part_${key}`)),
      h('td', { class: 'mono' }, partValue(signals, key)),
      h('td', { class: 'bar-cell', 'aria-hidden': 'true' }, h('span', { class: 'bar' }, bar)),
      h('td', { class: 'mono num' }, share(part?.share)),
    );
  });
  return tile(
    'attention',
    t('attention'),
    h(
      'div',
      { class: 'attention-body' },
      h(
        'div',
        { class: 'attention-main' },
        figure(String(score), '/100'),
        h(
          'div',
          {
            class: 'meter',
            role: 'meter',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': score,
            'aria-label': t('attention'),
          },
          fill,
        ),
        word(attention.label ? t(`att_${attention.label}`) : null),
        detail(attention.coverage === null ? null : t('attCoverage', { pct: share(attention.coverage) })),
      ),
      attention.parts.length
        ? h(
            'table',
            { class: 'parts' },
            h('caption', {}, t('attParts')),
            h('thead', { class: 'sr-only' }, h('tr', {}, h('td', {}), h('td', {}), h('td', {}), h('th', {}, t('share')))),
            h('tbody', {}, ...parts),
          )
        : null,
    ),
  );
}

function reputationTile(data: Dossier): HTMLElement {
  const rep = data.reputation;
  if (!rep || rep.sample <= 0) return tile('reputation', t('repShort'), missing(), detail(t('repNone')));
  const score = Math.max(0, Math.min(100, rep.score));
  const low = rep.margin === null ? null : Math.max(0, rep.score - rep.margin);
  const high = rep.margin === null ? null : Math.min(100, rep.score + rep.margin);
  const interval = h('i', { class: 'span' });
  if (low !== null && high !== null) percentWidth(interval, low, high);
  const point = h('i', { class: 'now' });
  point.style.left = `${score}%`;
  return tile(
    'reputation',
    t('repShort'),
    figure(String(Math.round(score)), rep.margin === null ? '/100' : `± ${fixed(rep.margin, rep.margin < 10 ? 1 : 0)}  /100`),
    h('div', { class: 'scale interval', 'aria-hidden': 'true' }, low === null ? null : interval, point),
    word(rep.label ? scoreLabel(rep.label) : null),
    detail(
      low === null || high === null
        ? `${t('repInterval', { low: '', high: '' }).replace(/\s*[–-]\s*$/, '')}: ${t('noData')}`
        : t('repInterval', { low: fixed(low, 0), high: fixed(high, 0) }),
      t('repConfidence', { pct: share(rep.confidence) }),
    ),
    detail(`${t('repSample')}: ${rep.sample}`),
  );
}

function abnormalTile(signals: Signals | null): HTMLElement {
  const p = signals?.price ?? null;
  if (!p || (p.z === null && p.abnormalPct === null)) return tile('abnormal', t('abnTitle'), missing());
  const level = zLevel(p.z);
  return tile(
    'abnormal',
    t('abnTitle'),
    p.z === null ? missing() : figure(signed(p.z), 'z', tone(p.z)),
    zScale(p.z),
    word(level ? t(`read_${level}`) : null),
    detail(
      `${t('abnReturn')} ${p.abnormalPct === null ? t('noData') : pct(p.abnormalPct)}`,
      p.beta === null ? null : `β ${fixed(p.beta)}`,
    ),
    detail(p.model ? t(`model_${p.model}`) : null, p.sample === null ? null : t('obs', { n: p.sample })),
  );
}

function volatilityTile(signals: Signals | null): HTMLElement {
  const v = signals?.volatility ?? null;
  if (!v || (!v.label && v.ratio === null && v.annualPct === null)) return tile('volatility', t('volRegime'), missing());
  return tile(
    'volatility',
    t('volRegime'),
    v.label
      ? h('p', { class: `figure word vol-${v.label}` }, h('b', {}, t(`vol_${v.label}`)))
      : missing(),
    detail(`${t('volRatio')}: ${fixed(v.ratio)}`),
    detail(v.annualPct === null ? null : t('annualised', { value: fixed(v.annualPct, 1, '%') })),
  );
}

function newsTile(signals: Signals | null): HTMLElement {
  const n = signals?.news ?? null;
  if (!n || (n.z === null && n.today === null)) return tile('news', t('newsSurprise'), missing());
  const reading =
    n.z === null ? null : n.z >= 1.96 ? t('newsHigh') : n.z >= 1 ? t('newsSome') : n.z > -1 ? t('newsUsual') : t('newsLow');
  return tile(
    'news',
    t('newsSurprise'),
    n.z === null ? missing() : figure(signed(n.z), 'z'),
    zScale(n.z),
    word(reading),
    detail(
      t('newsCounts', {
        today: n.today === null ? t('noData') : fixed(n.today, 0),
        expected: n.expected === null ? t('noData') : fixed(n.expected, 1),
      }),
    ),
  );
}

export function signalPlate(data: Dossier, onModel: () => void): HTMLElement {
  return h(
    'section',
    { class: 'panel plate', 'data-anchor': 'plate' },
    h(
      'header',
      { class: 'panel-head' },
      h('h2', {}, t('plateTitle')),
      h('button', { type: 'button', class: 'more flat-button', 'data-key': 'to-model', onclick: onModel }, t('toModel')),
    ),
    h(
      'div',
      { class: 'tiles' },
      attentionTile(data.signals),
      reputationTile(data),
      abnormalTile(data.signals),
      volatilityTile(data.signals),
      newsTile(data.signals),
    ),
    h('p', { class: 'plate-note' }, t('notAdvice')),
  );
}
