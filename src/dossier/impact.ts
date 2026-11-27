// How event-study results are shown wherever a headline appears.
import { fixed, h, pValue, pct, signed, tone } from './dom';
import { t } from './i18n';
import { IMPACT_LEVELS } from './types';
import type { Impact, ImpactLevel } from './types';

/** Each level has its own shape, so it reads without colour. */
export const levelMark = (level: ImpactLevel | null): HTMLElement =>
  h('i', { class: `sig-mark sig-${level ?? 'unknown'}`, 'aria-hidden': 'true' });

export const levelName = (level: ImpactLevel | null): string => (level ? t(`level_${level}`) : t('levelUnknown'));

/** "z −2.82 · q 0.040", with only the parts that exist. */
export function impactStats(impact: Impact): string {
  const parts: string[] = [];
  if (impact.z !== null) parts.push(`z ${signed(impact.z)}`);
  if (impact.q !== null) parts.push(`q ${pValue(impact.q)}`);
  return parts.join(' · ');
}

export function impactText(impact: Impact): string {
  const car = impact.carPct === null ? '' : `CAR ${pct(impact.carPct)}`;
  return [car, impactStats(impact), levelName(impact.level)].filter(Boolean).join(' · ');
}

export function impactTag(impact: Impact | null, inline = false): HTMLElement {
  if (!impact) return h('span', { class: `sig sig-none${inline ? ' inline' : ''}` }, t('noData'));
  const text = impactText(impact);
  return h(
    'span',
    { class: `sig sig-is-${impact.level ?? 'unknown'}${inline ? ' inline' : ''}`, title: text },
    h('span', { class: 'sr-only' }, t('impactAria', { text: levelName(impact.level) })),
    h(
      'span',
      { class: 'sig-car mono' },
      levelMark(impact.level),
      'CAR ',
      h('b', { class: tone(impact.carPct) }, impact.carPct === null ? fixed(null) : pct(impact.carPct)),
    ),
    h('span', { class: 'sig-stats mono' }, impactStats(impact)),
  );
}

export function impactLegend(): HTMLElement {
  return h(
    'div',
    { class: 'legend', role: 'note', 'aria-label': t('legendTitle') },
    h(
      'ul',
      {},
      ...[...IMPACT_LEVELS].reverse().map((level) => h('li', {}, levelMark(level), t(`legend_${level}`))),
    ),
    h('p', {}, `${t('legendTerms')} ${t('legendCause')}`),
  );
}
