// Overview of the Money Bansho instability index: regional means and the highest countries.
// The inherited composite "strategic risk" score is not computed or shown.
import { Panel } from './Panel';
import {
  countryName, formatNumber, indexLang, loadCountryIndex, regionName, scoreBand,
} from '@/services/bansho-country-index';
import type { IndexPayload } from '@/services/bansho-country-index';
import { getCurrentLanguage, t } from '@/services/i18n';
import { el, table } from '@/shell/bansho-index-dom';
import '@/shell/bansho-index.css';

const TOP = 10;

export class StrategicRiskPanel extends Panel {
  private onLocationClick?: (lat: number, lon: number) => void;
  private lastUpdated = 0;

  constructor() {
    super({ id: 'strategic-risk', title: t('panels.strategicRisk'), showCount: false, trackActivity: true });
    this.showLoading();
    void this.refresh();
  }

  /** True when the figures changed since the previous render. */
  public async refresh(): Promise<boolean> {
    let data: IndexPayload;
    try {
      data = await loadCountryIndex(this.signal);
    } catch {
      if (!this.element?.isConnected) return false;
      this.setDataBadge('unavailable');
      this.showError(t('common.failedRiskOverview'), () => void this.refresh());
      return false;
    }
    if (!this.element?.isConnected) return false;
    const lang = indexLang(getCurrentLanguage());
    const ru = lang === 'ru';
    const body = el('div', 'bx-detail');
    body.append(el('p', 'bx-note', ru
      ? 'Индекс нестабильности Money Bansho: среднее по регионам и страны с наибольшими значениями. Расчёт и доказательства открываются в сводке по стране.'
      : 'Money Bansho instability index: regional means and the highest countries. The calculation and proofs are in the country brief.'));
    body.append(table(ru ? ['Регион', 'Индекс'] : ['Region', 'Index'], data.regions.map((region) => [
      regionName(region.name, lang),
      { text: formatNumber(region.index, lang, 1), cls: `bx-${scoreBand(region.index)}` },
    ])));
    const ranked = data.countries.filter((c) => c.rank !== null).slice(0, TOP);
    body.append(table(ru ? ['Страна', 'Индекс', '90 % интервал'] : ['Country', 'Index', '90% interval'], ranked.map((country) => [
      countryName(country, lang),
      { text: formatNumber(country.index, lang, 1), cls: `bx-${scoreBand(country.index)}` },
      `${formatNumber(country.low, lang, 1)} – ${formatNumber(country.high, lang, 1)}`,
    ])));
    body.append(el('p', 'bx-note', `${ru ? 'Расчёт' : 'Computed'}: ${new Date(data.updatedAt).toLocaleString(ru ? 'ru-RU' : 'en-GB')}`));
    this.setDataBadge('cached');
    this.setContentNodes(body);
    const changed = data.updatedAt !== this.lastUpdated;
    this.lastUpdated = data.updatedAt;
    return changed;
  }

  /** Kept for the dashboard wiring; this overview has no map locations. */
  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }

  public hasLocationHandler(): boolean {
    return this.onLocationClick !== undefined;
  }
}
