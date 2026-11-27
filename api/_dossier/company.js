// Single-company dossier.
import companies from './companies.js';
import { dedupeEvents, reputationScore } from './analyze.js';
import { isShoppingNoise, selectEvents, toEvent, withReaction } from './events.js';
import { editionsFor, LEADERSHIP_TERMS, mentionIndex, primaryCompany, searchNews, searchTerm } from './news.js';
import { computeForecasts } from './math/forecast.js';
import { computeMetrics } from './math/metrics.js';
import { quantReport, withSignificance } from './math/report.js';
import { companySignals } from './quant.js';
import { loadFilings } from './sec.js';
import { errorMessage } from './util.js';
import { loadChart, quoteFrom } from './yahoo.js';

export const RANGE_DAYS = { '1mo': 31, '3mo': 93, '1y': 366 };

// Yahoo exchange suffix -> [country, region, benchmark], for unlisted symbols.
const SUFFIXES = {
  '': ['US', 'us', '^GSPC'],
  HK: ['HK', 'china', '^HSI'],
  SS: ['CN', 'china', '000001.SS'],
  SZ: ['CN', 'china', '399001.SZ'],
  TA: ['IL', 'israel', '^TA125.TA'],
  KS: ['KR', 'korea', '^KS11'],
  KQ: ['KR', 'korea', '^KQ11'],
  DE: ['DE', 'europe', '^GDAXI'],
  F: ['DE', 'europe', '^GDAXI'],
  PA: ['FR', 'europe', '^FCHI'],
  AS: ['NL', 'europe', '^STOXX'],
  BR: ['BE', 'europe', '^STOXX'],
  MI: ['IT', 'europe', '^STOXX'],
  MC: ['ES', 'europe', '^STOXX'],
  CO: ['DK', 'europe', '^STOXX'],
  ST: ['SE', 'europe', '^STOXX'],
  HE: ['FI', 'europe', '^STOXX'],
  OL: ['NO', 'europe', '^STOXX'],
  SW: ['CH', 'europe', '^SSMI'],
  L: ['GB', 'europe', '^FTSE'],
  T: ['JP', 'other', '^N225'],
  TW: ['TW', 'other', '^TWII'],
  TO: ['CA', 'other', '^GSPTSE'],
  AX: ['AU', 'other', '^AXJO'],
  NS: ['IN', 'other', '^NSEI'],
  BO: ['IN', 'other', '^BSESN'],
};

function unlistedCompany(symbol, meta) {
  const suffix = symbol.includes('.') ? symbol.slice(symbol.lastIndexOf('.') + 1) : '';
  // Indices, futures and currency pairs have no home exchange to infer.
  const [country, region, benchmark] = /[\^=]/.test(symbol)
    ? ['', 'other', '^GSPC']
    : SUFFIXES[suffix] ?? ['', 'other', '^GSPC'];
  const name = String(meta.longName || meta.shortName || symbol).slice(0, 100);
  const short = name
    .replace(/(,?\s+(Incorporated|Inc\.?|Corporation|Corp\.?|Company|Co\.,?|Ltd\.?|Limited|PLC|plc|AG|SE|S\.A\.|SA|N\.V\.|NV|A\/S|ASA|AB|Oyj|Holdings?|Group))+\.?$/g, '')
    .trim() || name;
  return { symbol, name, aliases: [...new Set([short, name])], searchName: short, country, region, benchmark };
}

/** One line of the pipeline report: what a source returned and how long it took. */
function traceLine(trace, source, kind, startedAt, items, message = null) {
  trace.push({
    source,
    kind,
    ok: items !== null,
    stale: items !== null && message !== null,
    items,
    ms: Date.now() - startedAt,
    message,
  });
}

async function collectNews(company, errors, trace) {
  const raw = [];
  const tasks = [];
  for (const edition of editionsFor(company)) {
    const term = searchTerm(company.searchName ? { ...company, name: company.searchName } : company, edition);
    const queries = [
      ['news', `${term} when:30d`],
      ['leadership', `${term} ${LEADERSHIP_TERMS[edition]} when:1y`],
    ];
    for (const [kind, query] of queries) {
      const source = `google-news:${edition}:${kind}`;
      const startedAt = Date.now();
      tasks.push(searchNews(query, edition).then(({ value, staleError }) => {
        if (staleError) errors.push({ source, message: staleError });
        // Search results are loose; keep only titles that name the company.
        const matched = value.filter((item) => mentionIndex(item.title, company) >= 0);
        raw.push(...matched);
        traceLine(trace, source, kind, startedAt, matched.length, staleError || null);
      }).catch((error) => {
        errors.push({ source, message: errorMessage(error) });
        traceLine(trace, source, kind, startedAt, null, errorMessage(error));
      }));
    }
  }
  // A company that re-registered keeps its older filings under formerCik.
  for (const cik of [company.cik, company.formerCik].filter(Boolean)) {
    const startedAt = Date.now();
    tasks.push(loadFilings(cik, company.name).then(({ value, staleError }) => {
      if (staleError) errors.push({ source: 'sec-edgar', message: staleError });
      raw.push(...value);
      traceLine(trace, 'sec-edgar', 'filing', startedAt, value.length, staleError || null);
    }).catch((error) => {
      errors.push({ source: 'sec-edgar', message: errorMessage(error) });
      traceLine(trace, 'sec-edgar', 'filing', startedAt, null, errorMessage(error));
    }));
  }
  await Promise.all(tasks);
  return [...new Map(raw.map((item) => [item.url, item])).values()];
}

async function chartOrNull(symbol, ttlMs, errors, trace) {
  const startedAt = Date.now();
  try {
    const { value, staleError } = await loadChart(symbol, ttlMs);
    if (staleError) errors.push({ source: `yahoo:${symbol}`, message: staleError });
    traceLine(trace, `yahoo:${symbol}`, 'price', startedAt, value.history.length, staleError || null);
    return value;
  } catch (error) {
    errors.push({ source: `yahoo:${symbol}`, message: errorMessage(error) });
    traceLine(trace, `yahoo:${symbol}`, 'price', startedAt, null, errorMessage(error));
    return error.status === 404 ? 'unknown' : null;
  }
}

/**
 * A headline that names another listed company first is usually about that
 * company's management, so it must not count as a leadership change here.
 */
function demoteForeignChange(event, symbol) {
  if (event.type !== 'leadership' || event.source === 'SEC EDGAR') return event;
  const first = primaryCompany(event.title, companies);
  return !first || first.symbol === symbol ? event : { ...event, type: 'other', people: [] };
}

/** Returns null when the symbol is neither listed nor known to Yahoo. */
export async function buildDossier(symbol, range, nowMs = Date.now()) {
  const errors = [];
  const trace = [];
  const startedAt = Date.now();
  const listed = companies.find((c) => c.symbol === symbol);
  const chartPromise = chartOrNull(symbol, 15_000, errors, trace);
  let company = listed;
  if (!company) {
    const chart = await chartPromise;
    if (chart === 'unknown') return null;
    company = chart ? unlistedCompany(symbol, chart.meta) : null;
  }

  const [chartResult, benchmarkResult, items] = await Promise.all([
    chartPromise,
    company ? chartOrNull(company.benchmark, 60_000, errors, trace) : null,
    company ? collectNews(company, errors, trace) : [],
  ]);
  const chart = chartResult === 'unknown' ? null : chartResult;
  const benchmark = benchmarkResult === 'unknown' ? null : benchmarkResult;
  const history = chart?.history ?? [];

  const relevant = items.map(toEvent).filter((e) => !isShoppingNoise(e));
  const priced = dedupeEvents(relevant)
    .map((event) => demoteForeignChange(event, symbol))
    .map((event) => withReaction(event, history, benchmark?.history));
  const { events, summary: multipleTesting } = withSignificance(priced);
  const cutoff = nowMs - RANGE_DAYS[range] * 86400_000;
  const reputation = reputationScore(events, nowMs);
  // Every headline that moves the score must be visible, even past the list cap.
  const selected = selectEvents(events, 120, 50);
  const shown = new Set(selected.map((e) => e.id));
  const driverIds = new Set(reputation.drivers.map((d) => d.eventId));
  const missing = events.filter((e) => driverIds.has(e.id) && !shown.has(e.id));

  const collected = trace.reduce((total, line) => total + (line.kind === 'price' ? 0 : line.items ?? 0), 0);
  const pipeline = {
    startedAt,
    durationMs: Date.now() - startedAt,
    stages: [
      ['collected', collected],
      ['unique', items.length],
      ['relevant', relevant.length],
      ['deduped', events.length],
      ['classified', events.filter((e) => e.type !== 'other').length],
      ['priced', events.filter((e) => e.impact).length],
    ].map(([id, count]) => ({ id, count })),
    sources: [...trace].sort((a, b) => a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind)),
  };

  const inputs = { history, benchmarkHistory: benchmark?.history, events, currency: chart?.meta.currency ?? null };
  const quant = chart ? quantReport(inputs, multipleTesting, errors, nowMs) : null;
  let metrics = null;
  try {
    metrics = chart ? computeMetrics(inputs, nowMs) : null;
  } catch (error) {
    errors.push({ source: 'model:metrics', message: errorMessage(error) });
  }

  let forecast = null;
  try {
    forecast = chart ? computeForecasts(inputs, nowMs) : null;
  } catch (error) {
    errors.push({ source: 'model:forecast', message: errorMessage(error) });
  }

  return {
    symbol,
    forecast,
    quant,
    metrics,
    pipeline,
    name: company?.name ?? symbol,
    exchange: chart?.meta.fullExchangeName ?? chart?.meta.exchangeName ?? null,
    currency: chart?.meta.currency ?? null,
    region: company?.region ?? 'other',
    country: company?.country ?? '',
    quote: chart ? quoteFrom(chart.meta, history, nowMs) : null,
    history: history.filter((bar) => bar.t >= cutoff),
    events: [...selected, ...missing].sort((x, y) => y.time - x.time),
    reputation,
    signals: chart
      ? companySignals({ history, benchmarkHistory: benchmark?.history, eventTimes: events.map((e) => e.time) }, nowMs)
      : null,
    updatedAt: Date.now(),
    errors,
  };
}
