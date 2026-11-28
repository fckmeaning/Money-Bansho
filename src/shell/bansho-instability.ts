// Country instability section: ranked table and the selected country with its calculation.
// Self-contained; mount with mountBanshoInstability(container). Data: /api/dossier?view=instability
import { fetchBanshoDashboardData } from '@/services/bansho-dashboard-data';
import {
  componentLabel, countryName, formatNumber, indexLang, regionName, rememberCountryIndex, scoreBand,
  INDEX_POLL_MS, INDEX_QUERY,
} from '@/services/bansho-country-index';
import type { GdeltContext, IndexCountry, IndexDefinition, IndexLang, IndexPayload } from '@/services/bansho-country-index';
import { getCurrentLanguage } from '@/services/i18n';
import { el } from './bansho-index-dom';
import { lineChart, renderCountryDetail } from './bansho-index-view';
import './bansho-instability.css';

function bars(country: IndexCountry, definitions: IndexDefinition[], lang: IndexLang): HTMLElement {
  const wrap = el('span', 'bi-bars');
  for (const definition of definitions) {
    const part = country.components.find((c) => c.id === definition.id);
    const score = part?.score ?? null;
    const reason = lang === 'ru' ? part?.reason : part?.reasonEn;
    const bar = el('span', `bi-bar bx-${scoreBand(score)}`);
    bar.title = `${componentLabel(definition, lang)}: ${formatNumber(score, lang)}${score === null && reason ? ` (${reason})` : ''}`;
    if (score !== null) {
      const fill = el('i');
      fill.style.height = `${Math.max(4, score)}%`;
      bar.append(fill);
    }
    wrap.append(bar);
  }
  return wrap;
}

function detail(country: IndexCountry, data: IndexPayload, gdelt: GdeltContext | null, lang: IndexLang, open: Set<string>): HTMLElement {
  const ru = lang === 'ru';
  const box = el('section', 'bi-detail');
  box.append(el('h3', '', countryName(country, lang)), renderCountryDetail(country, data, lang, open));

  if (gdelt?.code === country.code) {
    const label = ru
      ? 'GDELT, доля мировых новостей о стране, % (справочно, не входит в индекс)'
      : 'GDELT, share of world news about the country, % (context, not part of the index)';
    const z = gdelt.z === null ? '' : `; z ${ru ? 'за 3 дня' : 'over 3 days'} ${formatNumber(gdelt.z, lang, 2)}`;
    box.append(gdelt.reason
      ? el('p', 'bi-note', ru
        ? `${gdelt.reason}. Это справочный ряд, на индекс он не влияет.`
        : 'GDELT is unavailable. It is a context series and does not affect the index.')
      : lineChart(gdelt.series, lang, { label: `${label}${z}` }));
  }

  box.append(el('h4', '', ru
    ? `Заголовки за 7 дней: ${country.news.mentions}, негативных ${country.news.negative}`
    : `Headlines over 7 days: ${country.news.mentions}, negative ${country.news.negative}`));
  if (!country.headlines.length) box.append(el('p', 'bi-note', formatNumber(null, lang)));
  for (const item of country.headlines) {
    const link = el('a', 'bi-headline', ru ? item.titleRu ?? item.title : item.title);
    link.href = /^https?:\/\//.test(item.url) ? item.url : '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = item.title;
    const line = el('p');
    line.append(link, el('span', 'bi-note', ` ${item.source}${item.negative ? (ru ? ', негативный тон' : ', negative tone') : ''}`));
    box.append(line);
  }
  return box;
}

export function mountBanshoInstability(container: HTMLElement): () => void {
  const lang = indexLang(getCurrentLanguage());
  const ru = lang === 'ru';
  const root = el('div', 'bansho-instability');
  const status = el('p', 'bi-status', ru ? 'Загрузка данных…' : 'Loading data…');
  const body = el('div', 'bi-body');
  root.append(status, body);
  container.append(root);

  let data: IndexPayload | null = null;
  let selected: string | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;
  let loadedAt = 0;
  let gdelt: GdeltContext | null = null;
  /** Countries whose proof block is open; survives re-renders. */
  const open = new Set<string>();

  function render(): void {
    if (!data) return;
    const current = data.countries.find((c) => c.code === selected) ?? data.countries[0];
    if (!current) return;
    selected = current.code;
    const scrolled = body.querySelector('.bi-list')?.scrollTop ?? 0;
    const list = el('div', 'bi-list');
    const ranking = el('table');
    const header = el('tr');
    const titles = ru
      ? ['№', 'Страна', 'Индекс', '90 % интервал', 'Компоненты', 'Покрытие']
      : ['#', 'Country', 'Index', '90% interval', 'Components', 'Coverage'];
    for (const title of titles) header.append(el('th', '', title));
    ranking.append(header);
    for (const country of data.countries) {
      const row = el('tr', country.code === selected ? 'bi-selected' : '');
      const name = el('td');
      const button = el('button', '', countryName(country, lang));
      button.type = 'button';
      button.setAttribute('aria-pressed', String(country.code === selected));
      name.append(button);
      const components = el('td');
      components.append(bars(country, data.components, lang));
      row.append(
        el('td', 'bi-rank', country.rank === null ? '—' : String(country.rank)),
        name,
        el('td', `bi-value bx-${scoreBand(country.index)}`, formatNumber(country.index, lang)),
        el('td', 'bi-range', country.low === null || country.high === null ? '—' : `${formatNumber(country.low, lang, 2)}–${formatNumber(country.high, lang, 2)}`),
        components,
        el('td', 'bi-range', `${Math.round(country.coverage * 100)} %`),
      );
      row.addEventListener('click', () => {
        if (selected === country.code) return;
        selected = country.code;
        render();
        void loadContext(country.code);
      });
      ranking.append(row);
    }
    list.append(ranking);

    const regions = el('div', 'bi-regions');
    for (const region of data.regions) {
      const item = el('span', '', `${regionName(region.name, lang)} `);
      item.append(el('b', `bx-${scoreBand(region.index)}`, formatNumber(region.index, lang)));
      item.title = region.countries.length
        ? `${ru ? 'Среднее по' : 'Mean over'}: ${region.countries.join(', ')}`
        : formatNumber(null, lang);
      regions.append(item);
    }
    const side = el('div', 'bi-side');
    side.append(detail(current, data, gdelt, lang, open));
    const columns = el('div', 'bi-columns');
    columns.append(list, side);
    body.replaceChildren(regions, columns);
    list.scrollTop = scrolled;
  }

  async function fetchPayload(code: string | null, signal: AbortSignal): Promise<IndexPayload> {
    const query = code ? `&country=${encodeURIComponent(code)}` : '';
    const payload = await fetchBanshoDashboardData<IndexPayload>(`${INDEX_QUERY}${query}`, signal);
    if (!Array.isArray(payload?.countries) || !payload.countries.every((c) => c.proof)) throw new Error('Invalid index response');
    // The country panel reads the same figures without a second request.
    if (!payload.degraded) rememberCountryIndex(payload);
    return payload;
  }

  // GDELT context of a newly selected country; the main data keeps its own 5-minute schedule.
  const contexts = new Map<string, { at: number; value: GdeltContext }>();
  async function loadContext(code: string): Promise<void> {
    const known = contexts.get(code);
    if (known && Date.now() - known.at < INDEX_POLL_MS) {
      gdelt = known.value;
      render();
      return;
    }
    try {
      const payload = await fetchPayload(code, AbortSignal.timeout(30_000));
      if (disposed || !payload.gdelt) return;
      contexts.set(code, { at: Date.now(), value: payload.gdelt });
      if (selected !== code) return;
      gdelt = payload.gdelt;
      render();
    } catch {
      // Context only: the panel stays complete without it.
    }
  }

  async function load(): Promise<void> {
    if (disposed) return;
    clearTimeout(timer);
    if (document.hidden) {
      timer = setTimeout(() => void load(), INDEX_POLL_MS);
      return;
    }
    request = new AbortController();
    loadedAt = Date.now();
    try {
      // One request per cycle: the selected country's context travels with the main data.
      const payload = await fetchPayload(selected, request.signal);
      if (disposed) return;
      data = payload;
      if (payload.gdelt) {
        gdelt = payload.gdelt;
        contexts.set(payload.gdelt.code, { at: Date.now(), value: payload.gdelt });
      }
      const { sources, method, degraded, updatedAt } = payload;
      status.textContent = ru
        ? `Обновлено ${new Date(updatedAt).toLocaleString('ru-RU')}. Ленты: ${sources.feedsOk} из ${sources.feeds}, котировки: ${sources.symbolsOk} из ${sources.symbols}, заголовков: ${method.newsHeadlines}.${degraded ? ' Большинство источников не ответило: картина неполная.' : ''}`
        : `Updated ${new Date(updatedAt).toLocaleString('en-GB')}. Feeds: ${sources.feedsOk} of ${sources.feeds}, quotes: ${sources.symbolsOk} of ${sources.symbols}, headlines: ${method.newsHeadlines}.${degraded ? ' Most sources did not answer: the picture is incomplete.' : ''}`;
      render();
    } catch {
      if (disposed) return;
      if (data) {
        status.textContent = ru
          ? 'Обновление не удалось, показаны прежние данные. Повтор через 5 минут.'
          : 'Update failed, earlier data are shown. Retry in 5 minutes.';
      } else {
        status.textContent = ru
          ? 'Нет данных: источник не ответил. Повтор через 5 минут.'
          : 'No data: the source did not answer. Retry in 5 minutes.';
      }
    } finally {
      if (!disposed) timer = setTimeout(() => void load(), INDEX_POLL_MS);
    }
  }

  const onVisible = () => {
    if (!document.hidden && Date.now() - loadedAt >= INDEX_POLL_MS) void load();
  };
  document.addEventListener('visibilitychange', onVisible);
  void load();

  return () => {
    disposed = true;
    clearTimeout(timer);
    request?.abort();
    document.removeEventListener('visibilitychange', onVisible);
    root.remove();
  };
}
