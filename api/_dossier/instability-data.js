// Loader of the country instability index: daily Yahoo series (equity index, currency)
// and headlines of the curated public RSS feeds. Keyless sources only; a source that
// fails or is stale leaves its component missing, with the reason. Math: ./math/instability.js
import {
  bootstrapSigma,
  composite,
  COMPONENTS,
  crossCountryPrior,
  despike,
  dispersion,
  explainAggregate,
  isPegged,
  logit,
  marketFeatures,
  PARAMS,
  pooledCorrelation,
  posterior,
  recencySurprise,
  referenceAt,
  robustLocationScale,
  scoreFromZ,
  shrinkageIntensity,
  shrunkShare,
  soften,
  zSeries,
  robustZ,
} from './math/instability.js';
import { cached, errorMessage, fetchText, pool } from './util.js';
import { FEEDS, headlineTone, parseFeed, parseGdeltTimeline } from './world.js';
import { loadChart, localDate } from './yahoo.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const NEWS_WINDOW_HOURS = 168;
export const NEWS_RECENT_HOURS = 24;
const VOLUME_HALF_LIFE_HOURS = 24;
const TONE_HALF_LIFE_HOURS = 72;
const STALE_MARKET_DAYS = 10;
const HISTORY_POINTS = 260;
const BUILD_TTL_MS = 5 * 60_000;

const country = (code, name, region, equity, fx, terms, query, extra = {}) => ({
  code, name, region, equity, fx, re: new RegExp(`\\b(?:${terms})\\b`), query, ...extra,
});
const eq = (symbol, name) => ({ symbol, name });
const fx = (symbol, name, sign = 1) => ({ symbol, name, sign });
const EUR = fx('EUR=X', 'EUR за USD');
// A missing value always carries its reason, in Russian and in English.
const why = (reason, reasonEn) => ({ reason, reasonEn });
const none = (reason, reasonEn) => ({ missing: reason, missingEn: reasonEn });

export const COUNTRIES = [
  country('US', 'США', 'Америка', eq('^GSPC', 'S&P 500'), fx('DX-Y.NYB', 'Индекс доллара DXY', -1), 'U\\.S\\.|US|USA|United States|Americans?|Washington|White House|Pentagon', 'United States'),
  country('CA', 'Канада', 'Америка', eq('^GSPTSE', 'S&P/TSX'), fx('CAD=X', 'CAD за USD'), 'Canada|Canadians?|Ottawa', 'Canada'),
  country('MX', 'Мексика', 'Америка', eq('^MXX', 'IPC'), fx('MXN=X', 'MXN за USD'), 'Mexico|Mexicans?', 'Mexico'),
  country('BR', 'Бразилия', 'Америка', eq('^BVSP', 'Bovespa'), fx('BRL=X', 'BRL за USD'), 'Brazil|Brazilians?|Brasilia', 'Brazil'),
  country('AR', 'Аргентина', 'Америка', eq('^MERV', 'Merval'), fx('ARS=X', 'ARS за USD'), 'Argentina|Argentines?|Argentinian|Buenos Aires|Milei', 'Argentina'),
  country('GB', 'Великобритания', 'Европа', eq('^FTSE', 'FTSE 100'), fx('GBP=X', 'GBP за USD'), 'Britain|British|UK|U\\.K\\.|United Kingdom|England|London|Starmer', '"United Kingdom"'),
  country('DE', 'Германия', 'Европа', eq('^GDAXI', 'DAX'), EUR, 'Germany|Germans?|Berlin|Merz', 'Germany'),
  country('FR', 'Франция', 'Европа', eq('^FCHI', 'CAC 40'), EUR, 'France|French|Paris|Macron', 'France'),
  country('IT', 'Италия', 'Европа', eq('FTSEMIB.MI', 'FTSE MIB'), EUR, 'Italy|Italians?|Rome|Meloni', 'Italy'),
  country('ES', 'Испания', 'Европа', eq('^IBEX', 'IBEX 35'), EUR, 'Spain|Spanish|Madrid', 'Spain'),
  country('NL', 'Нидерланды', 'Европа', eq('^AEX', 'AEX'), EUR, 'Netherlands|Dutch|Amsterdam|The Hague', 'Netherlands'),
  country('CH', 'Швейцария', 'Европа', eq('^SSMI', 'SMI'), fx('CHF=X', 'CHF за USD'), 'Switzerland|Swiss', 'Switzerland'),
  country('SE', 'Швеция', 'Европа', eq('^OMX', 'OMXS30'), fx('SEK=X', 'SEK за USD'), 'Sweden|Swedish|Swedes?|Stockholm', 'Sweden'),
  country('PL', 'Польша', 'Европа', eq('ETFBW20TR.WA', 'ETF на WIG20TR (прокси)'), fx('PLN=X', 'PLN за USD'), 'Poland|Polish|Poles|Warsaw', 'Poland'),
  country('UA', 'Украина', 'Восточная Европа', none('на Yahoo Finance нет индекса акций Украины', 'Yahoo Finance has no Ukrainian equity index'), fx('UAH=X', 'UAH за USD'), 'Ukraine|Ukrainians?|Kyiv|Kiev|Zelensk(?:y|iy|yy)', 'Ukraine'),
  country('RU', 'Россия', 'Восточная Европа', none('на Yahoo Finance нет котировок индекса Московской биржи', 'Yahoo Finance does not quote the Moscow Exchange index'), fx('RUB=X', 'RUB за USD'), 'Russia|Russians?|Moscow|Kremlin|Putin', 'Russia'),
  country('TR', 'Турция', 'Ближний Восток', eq('XU100.IS', 'BIST 100'), fx('TRY=X', 'TRY за USD'), 'Turkey|Turkish|T[uü]rkiye|Ankara|Istanbul|Erdogan', 'Turkey'),
  country('IL', 'Израиль', 'Ближний Восток', eq('^TA125.TA', 'TA-125'), fx('ILS=X', 'ILS за USD'), 'Israel|Israelis?|Tel Aviv|Jerusalem|Netanyahu|IDF', 'Israel'),
  country('IR', 'Иран', 'Ближний Восток', none('на Yahoo Finance нет индекса акций Ирана', 'Yahoo Finance has no Iranian equity index'), none('котировка IRR=X отражает официальный, а не рыночный курс', 'IRR=X is the official rate, not a market rate'), 'Iran|Iranians?|Tehran', 'Iran'),
  country('SA', 'Саудовская Аравия', 'Ближний Восток', eq('KSA', 'ETF iShares MSCI Saudi Arabia, USD (прокси)'), none('риал привязан к доллару; колебания SAR=X на Yahoo — шум котировок', 'the riyal is pegged to the dollar; SAR=X moves on Yahoo are quote noise'), 'Saudi|Saudis|Riyadh', '"Saudi Arabia"'),
  country('EG', 'Египет', 'Африка', eq('^CASE30', 'EGX 30'), fx('EGP=X', 'EGP за USD'), 'Egypt|Egyptians?|Cairo', 'Egypt'),
  country('ZA', 'ЮАР', 'Африка', eq('^J203.JO', 'JSE All Share'), fx('ZAR=X', 'ZAR за USD'), 'South Africa|South Africans?|Johannesburg|Pretoria', '"South Africa"'),
  country('CN', 'Китай', 'Азия', eq('000001.SS', 'Shanghai Composite'), fx('CNY=X', 'CNY за USD'), 'China|Chinese|Beijing|Xi Jinping|Shanghai', 'China'),
  country('TW', 'Тайвань', 'Азия', eq('^TWII', 'TAIEX'), fx('TWD=X', 'TWD за USD'), 'Taiwan|Taiwanese|Taipei', 'Taiwan'),
  country('JP', 'Япония', 'Азия', eq('^N225', 'Nikkei 225'), fx('JPY=X', 'JPY за USD'), 'Japan|Japanese|Tokyo', 'Japan'),
  country('KR', 'Южная Корея', 'Азия', eq('^KS11', 'KOSPI'), fx('KRW=X', 'KRW за USD'), 'South Korea|South Koreans?|Seoul', '"South Korea"'),
  country('KP', 'КНДР', 'Азия', none('в КНДР нет публичного фондового рынка', 'North Korea has no public stock market'), none('нет рыночной котировки валюты КНДР', 'there is no market quote of the North Korean currency'), 'North Korea|North Koreans?|Pyongyang|Kim Jong[ -]?[Uu]n|DPRK', '"North Korea"'),
  country('IN', 'Индия', 'Азия', eq('^BSESN', 'Sensex'), fx('INR=X', 'INR за USD'), 'India|Indians?|New Delhi|Mumbai|Modi', 'India'),
  country('ID', 'Индонезия', 'Азия', eq('^JKSE', 'IDX Composite'), fx('IDR=X', 'IDR за USD'), 'Indonesia|Indonesians?|Jakarta', 'Indonesia'),
  country('AU', 'Австралия', 'Океания', eq('^AXJO', 'ASX 200'), fx('AUD=X', 'AUD за USD'), 'Australia|Australians?|Canberra|Sydney', 'Australia'),
];

/** Feeds usable for a share-of-news statistic: search feeds select by topic, and the tone list is English. */
export const NEWS_FEEDS = FEEDS.filter((f) => !f.url.includes('news.google.com') && f.lang !== 'zh');

const withDeadline = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out')), Math.max(0, ms)); }),
  ]).finally(() => clearTimeout(timer));
};

async function loadNews(nowMs, errors) {
  const items = [];
  let ok = 0;
  const deadline = Date.now() + 13_000;
  await pool(NEWS_FEEDS, 14, async (feed) => {
    try {
      const left = deadline - Date.now();
      if (left < 800) throw new Error('Пропущено: бюджет времени исчерпан');
      const { value } = await cached(`instfeed:${feed.id}`, BUILD_TTL_MS, async () => parseFeed(
        await fetchText(feed.url, { timeoutMs: Math.min(7000, left), headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } }),
        Date.now(),
      ), 60 * 60_000);
      ok += 1;
      const seen = new Set();
      for (const item of value) {
        const key = item.title.toLowerCase();
        if (nowMs - item.time > NEWS_WINDOW_HOURS * HOUR || seen.has(key)) continue;
        seen.add(key);
        items.push({ title: item.title, url: item.url, source: item.source || feed.name, time: item.time, feed: feed.id });
      }
    } catch (error) {
      errors.push({ source: `feed:${feed.name}`, message: errorMessage(error) });
    }
  });
  return { items, ok };
}

async function loadMarkets(errors) {
  const symbols = [...new Set(COUNTRIES.flatMap((c) => [c.equity.symbol, c.fx.symbol]).filter(Boolean))];
  const charts = new Map();
  const deadline = Date.now() + 17_000;
  await pool(symbols, 10, async (symbol) => {
    try {
      const { value, staleError } = await withDeadline(loadChart(symbol, BUILD_TTL_MS), deadline - Date.now());
      charts.set(symbol, value);
      if (staleError) errors.push({ source: `yahoo:${symbol}`, message: staleError });
    } catch (error) {
      errors.push({ source: `yahoo:${symbol}`, message: errorMessage(error) });
      charts.set(symbol, { error: errorMessage(error) });
    }
  });
  return charts;
}

/** One instrument: its features and z-series, or the reason it cannot be used. */
export function analyseSeries(chart, instrument, kind, nowMs) {
  if (instrument.missing) return why(instrument.missing, instrument.missingEn);
  const info = { symbol: instrument.symbol, name: instrument.name };
  if (!chart?.history?.length) {
    return { ...info, ...why(`котировки ${instrument.symbol} не получены`, `no quotes received for ${instrument.symbol}`) };
  }
  const { bars, removed } = despike(chart.history);
  const last = bars.at(-1);
  const date = (bar) => localDate(bar.t, chart.meta?.gmtoffset);
  info.asOf = date(last);
  info.bars = bars.length;
  info.spikesRemoved = removed;
  if (nowMs - last.t > STALE_MARKET_DAYS * DAY) {
    return { ...info, ...why(`ряд ${instrument.symbol} не обновляется с ${info.asOf}`, `${instrument.symbol} has not updated since ${info.asOf}`) };
  }
  if (bars.length <= PARAMS.referenceMin + 30) {
    return { ...info, ...why(`история ${instrument.symbol} слишком коротка (${bars.length} дней)`, `${instrument.symbol} history is too short (${bars.length} days)`) };
  }
  if (kind === 'fx' && isPegged(bars)) {
    return { ...info, ...why(`курс ${instrument.symbol} фактически фиксирован`, `${instrument.symbol} is effectively pegged`) };
  }
  const { features, display, model } = marketFeatures(bars, kind, instrument.sign ?? 1);
  const parts = {};
  for (const [id, values] of Object.entries(features)) {
    const z = zSeries(values);
    const i = values.length - 1;
    const shown = display[id][i];
    // Observations that form the reference of the last value.
    const used = values.flatMap((value, k) => (value !== null && k >= i - PARAMS.referenceWindow && k < i ? [k] : []));
    parts[id] = {
      z,
      latest: z[i],
      x: values[i],
      reference: referenceAt(values, i),
      referenceDates: used.length ? [date(bars[used[0]]), date(bars[used.at(-1)])] : null,
      raw: shown === null ? null : { value: shown, unit: UNITS[id] },
      ...(z[i] === null
        ? why('недостаточно наблюдений или ряд без изменений', 'too few observations or a flat series')
        : why(null, null)),
    };
  }
  return { ...info, model, parts, days: bars.map((bar) => bar.day), dates: bars.map(date) };
}

const UNITS = {
  eqVol: '% годовых',
  fxVol: '% годовых',
  eqDrawdown: '% от максимума',
  eqShock: '% падения за 5 дней',
  fxDep: '% ослабления за 21 день',
};
const MARKET = COMPONENTS.filter((c) => c.group !== 'news');

/**
 * Market z-scores of one country on the equity calendar (currency calendar when there is no
 * equity index); values of the other series are carried for at most 7 days.
 */
export function alignMarket(series) {
  const used = series.filter((s) => s.parts).flatMap((s) => Object.entries(s.parts)
    .filter(([, part]) => part.latest !== null)
    .map(([id, part]) => ({ id, part, owner: s })));
  if (!used.length) return { ids: [], rows: [] };
  const calendar = used[0].owner;
  const cursor = used.map(() => -1);
  const rows = calendar.days.map((day, i) => {
    const zs = {};
    used.forEach(({ id, part, owner }, k) => {
      while (cursor[k] + 1 < owner.days.length && owner.days[cursor[k] + 1] <= day) cursor[k] += 1;
      const at = cursor[k];
      if (at >= 0 && day - owner.days[at] <= 7 && part.z[at] !== null) zs[id] = part.z[at];
    });
    return { date: calendar.dates[i], zs };
  });
  return { ids: used.map((u) => u.id), rows };
}

/** History of the market part: no news, no shrinkage; every point uses today's components. */
export function marketHistory({ ids, rows }, correlation = null) {
  return rows
    .filter((row) => ids.length && ids.every((id) => id in row.zs))
    .slice(-HISTORY_POINTS)
    .flatMap((row) => {
      // Coverage is judged inside the market block here.
      const { index } = composite(row.zs, { components: MARKET, correlation, shapley: false });
      return index === null ? [] : [[row.date, round(index)]];
    });
}

/**
 * Block-diagonal 7x7 correlation of the component z-scores: market pairs pooled over the
 * daily histories, the news pair across countries; market-news pairs are set to zero (there
 * is no news history to estimate them). Each block is shrunk towards the identity.
 */
export function correlationMatrix(aligned, newsPairs) {
  const n = COMPONENTS.length;
  const matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  const block = (pairs) => {
    const estimates = pairs.flatMap(({ i, j, groups, perEffective }) => {
      const found = pooledCorrelation(groups);
      return found ? [{ i, j, r: found.r, nEff: found.n / perEffective }] : [];
    });
    if (!estimates.length) return null;
    const lambda = shrinkageIntensity(estimates);
    for (const { i, j, r } of estimates) matrix[i][j] = matrix[j][i] = (1 - lambda) * r;
    return lambda;
  };
  const market = [];
  for (let i = 0; i < MARKET.length; i += 1) {
    for (let j = i + 1; j < MARKET.length; j += 1) {
      const a = MARKET[i].id;
      const b = MARKET[j].id;
      const groups = aligned.map(({ rows }) => rows.flatMap(({ zs }) => (
        a in zs && b in zs ? [[soften(zs[a]), soften(zs[b])]] : []
      )));
      // Daily observations are serially dependent: one block counts as one observation.
      market.push({ i, j, groups, perEffective: PARAMS.block });
    }
  }
  const marketShrinkage = block(market);
  const newsShrinkage = block([{ i: MARKET.length, j: MARKET.length + 1, groups: [newsPairs], perEffective: 1 }]);
  return { matrix, marketShrinkage, newsShrinkage };
}

/** Per-country news statistics from the pooled feeds, with exponential recency weights. */
export function newsStats(items, nowMs) {
  const unique = [...new Map(items.map((item) => [item.title.toLowerCase(), item])).values()];
  const negative = new Map(unique.map((item) => [item, headlineTone(item.title) < 0]));
  const decay = (item, halfLife) => 2 ** (-Math.max(0, nowMs - item.time) / (halfLife * HOUR));
  // Recency-weighted negative share and Kish effective sample size.
  const toneOf = (list) => {
    let total = 0;
    let squares = 0;
    let bad = 0;
    for (const item of list) {
      const w = decay(item, TONE_HALF_LIFE_HOURS);
      total += w;
      squares += w * w;
      if (negative.get(item)) bad += w;
    }
    return total > 0 ? { share: bad / total, effective: (total * total) / squares } : null;
  };
  const pooled = toneOf(unique)?.share ?? null;
  const feeds = new Map();
  for (const item of items) {
    if (!feeds.has(item.feed)) feeds.set(item.feed, []);
    feeds.get(item.feed).push(item);
  }
  const byCountry = new Map(COUNTRIES.map((c) => {
    const strata = [...feeds.values()].map((list) => {
      const stratum = { N: list.length, sum: 0, squares: 0, m: 0, x: 0 };
      for (const item of list) {
        const a = decay(item, VOLUME_HALF_LIFE_HOURS);
        stratum.sum += a;
        stratum.squares += a * a;
        if (c.re.test(item.title)) {
          stratum.m += 1;
          stratum.x += a;
        }
      }
      return stratum;
    });
    const matched = unique.filter((item) => c.re.test(item.title));
    return [c.code, {
      matched,
      negative,
      mentions: matched.length,
      negativeCount: matched.filter((item) => negative.get(item)).length,
      recent: matched.filter((item) => nowMs - item.time <= NEWS_RECENT_HOURS * HOUR).length,
      tone: toneOf(matched),
      surprise: recencySurprise(strata),
      strataMentions: strata.reduce((t, s) => t + (s.m < s.N ? s.m : 0), 0),
    }];
  }));
  return { byCountry, pooled, total: unique.length };
}

export function assembleInstability({ charts, items, nowMs }) {
  const news = newsStats(items, nowMs);
  const stats = [...news.byCountry.values()];
  const phi = dispersion(stats.filter((s) => s.strataMentions >= 5).map((s) => s.surprise?.z));
  const toneShare = (stat) => shrunkShare(stat.tone.share * stat.tone.effective, stat.tone.effective, news.pooled);
  const shares = stats.filter((s) => s.mentions >= 5).map(toneShare);
  const spread = shares.length >= 5 ? robustLocationScale(shares) : null;
  // Centred on the pooled share (the shrinkage target), scaled by the spread between countries.
  const tone = shares.length >= 5 ? { centre: news.pooled, scale: Math.max(spread?.scale ?? 0, 0.05) } : null;

  const memo = new Map();
  const analyse = (instrument, kind) => {
    if (instrument.missing) return analyseSeries(null, instrument, kind, nowMs);
    const key = `${instrument.symbol}:${instrument.sign ?? 1}`;
    if (!memo.has(key)) memo.set(key, analyseSeries(charts.get(instrument.symbol), instrument, kind, nowMs));
    return memo.get(key);
  };

  // First pass: component z-scores of every country.
  const drafts = COUNTRIES.map((c) => {
    const equity = analyse(c.equity, 'equity');
    const currency = analyse(c.fx, 'fx');
    const stat = news.byCountry.get(c.code);
    const values = {};
    const inputs = {};
    // What each z was computed from: shown with the proof of the number.
    const trace = {};
    for (const { id, group } of COMPONENTS) {
      if (group !== 'news') {
        const source = group === 'equity' ? equity : currency;
        const part = source.parts?.[id];
        if (part && part.latest !== null) {
          values[id] = { z: part.latest, raw: part.raw };
          inputs[id] = { x: part.x, reference: part.reference };
          const fit = robustLocationScale(part.reference);
          trace[id] = {
            kind: 'market',
            x: part.x,
            median: fit.centre,
            scale: fit.scale,
            meanDeviation: fit.meanDeviation,
            observations: part.reference.length,
            from: part.referenceDates[0],
            to: part.referenceDates[1],
            symbol: source.symbol,
            asOf: source.asOf,
          };
        } else {
          const { reason, reasonEn } = part ?? source;
          values[id] = { reason, reasonEn };
        }
      } else if (id === 'newsVolume') {
        if (stat.surprise && stat.strataMentions >= 5) {
          const z = stat.surprise.z / phi;
          values[id] = {
            z,
            raw: { value: stat.surprise.observed / stat.surprise.expected, unit: `× к ожидаемой свежести; за 24 ч ${stat.recent} из ${stat.mentions}` },
          };
          inputs[id] = { z };
          trace[id] = {
            kind: 'volume',
            observed: stat.surprise.observed,
            expected: stat.surprise.expected,
            variance: stat.surprise.variance,
            zRaw: stat.surprise.z,
            phi,
            mentions: stat.mentions,
            comparable: stat.strataMentions,
            recent: stat.recent,
          };
        } else {
          values[id] = why(
            `мало упоминаний в лентах для сравнения (${stat.mentions})`,
            `too few mentions in comparable feeds (${stat.mentions})`,
          );
        }
      } else if (tone && stat.mentions >= 5) {
        const shrunk = toneShare(stat);
        values[id] = {
          z: (shrunk - tone.centre) / tone.scale,
          raw: { value: stat.tone.share * 100, unit: `% негативных (с весом свежести), заголовков: ${stat.mentions}` },
        };
        inputs[id] = { share: stat.tone.share, n: stat.tone.effective, pooled: news.pooled, ...tone };
        trace[id] = {
          kind: 'tone',
          share: stat.tone.share,
          effective: stat.tone.effective,
          pooled: news.pooled,
          strength: PARAMS.toneStrength,
          shrunk,
          centre: tone.centre,
          scale: tone.scale,
          mentions: stat.mentions,
          negative: stat.negativeCount,
        };
      } else {
        values[id] = stat.mentions < 5
          ? why(`меньше 5 заголовков (${stat.mentions})`, `fewer than 5 headlines (${stat.mentions})`)
          : why('меньше 5 стран с 5 заголовками: сравнивать не с чем', 'fewer than 5 countries have 5 headlines: nothing to compare with');
      }
    }
    const zs = Object.fromEntries(Object.entries(values).flatMap(([id, v]) => (v.z === undefined ? [] : [[id, v.z]])));
    return { c, equity, currency, stat, values, inputs, trace, zs, aligned: alignMarket([equity, currency]) };
  });

  const correlation = correlationMatrix(
    drafts.map((d) => d.aligned),
    drafts.flatMap(({ zs }) => ('newsVolume' in zs && 'newsTone' in zs ? [[soften(zs.newsVolume), soften(zs.newsTone)]] : [])),
  );

  // Second pass: aggregate and its sampling error; then shrinkage towards the cross-country prior.
  drafts.forEach((draft, order) => {
    draft.result = composite(draft.zs, { correlation: correlation.matrix });
    if (draft.result.index === null) return;
    const sigma = bootstrapSigma(draft.inputs, { seed: 1000 + order, correlation: correlation.matrix });
    if (sigma !== null) draft.estimate = { theta: logit(draft.result.index / 100), sigma, coverage: draft.result.coverage };
  });
  const prior = crossCountryPrior(drafts.flatMap((d) => (d.estimate && d.estimate.coverage >= 0.5 ? [d.estimate] : [])));

  const countries = drafts.map(({ c, equity, currency, stat, values, trace, zs, estimate, result, aligned }) => {
    const final = estimate ? posterior(estimate, prior) : null;
    const times = stat.matched.map((item) => item.time);
    let absence = why(null, null);
    if (!final) {
      absence = result.index === null
        ? why('доступно меньше 25 % веса компонентов', 'less than 25% of the component weight is available')
        : why('ошибка выборки по этим данным не оценивается', 'the sampling error cannot be estimated from these data');
    }
    // Full precision: the interface recomputes the index from these numbers.
    const proof = {
      inputs: trace,
      aggregate: explainAggregate(zs, { correlation: correlation.matrix }),
      posterior: final ? {
        theta: estimate.theta,
        sigma: estimate.sigma,
        draws: PARAMS.draws,
        coverage: estimate.coverage,
        prior,
        variance: final.variance,
        reliability: final.reliability,
        mean: final.mean,
        half: final.half,
        index: final.index,
        low: final.low,
        high: final.high,
      } : null,
    };
    const history = marketHistory(aligned, correlation.matrix);
    const coverage = result.coverage;
    const confidence = !final ? null
      : coverage >= 0.85 && stat.mentions >= 20 ? 'высокая' : coverage >= 0.5 ? 'средняя' : 'низкая';
    return {
      code: c.code,
      name: c.name,
      region: c.region,
      index: round(final?.index),
      low: round(final?.low),
      high: round(final?.high),
      aggregate: final ? round(result.index) : null,
      shrinkage: final ? round(final.index - result.index) : null,
      reliability: round(final?.reliability),
      powerMean: round(result.powerMean),
      stress: round(result.stress),
      coverage: round(coverage),
      confidence,
      ...absence,
      proof,
      newsDates: times.length ? [Math.min(...times), Math.max(...times)] : null,
      marketChange5: history.length > 5 ? round(history.at(-1)[1] - history.at(-6)[1]) : null,
      components: COMPONENTS.map(({ id }) => ({
        id,
        score: round(scoreFromZ(values[id].z)),
        z: round(values[id].z),
        raw: values[id].raw ? { value: round(values[id].raw.value), unit: values[id].raw.unit } : null,
        weight: final ? round(result.weights[id]) : null,
        contribution: final ? round(result.contributions[id]) : null,
        reason: values[id].reason ?? null,
        reasonEn: values[id].reasonEn ?? null,
      })),
      equity: instrumentInfo(equity),
      fx: instrumentInfo(currency),
      news: { mentions: stat.mentions, recent: stat.recent, negative: stat.negativeCount },
      headlines: [...stat.matched].sort((a, b) => b.time - a.time).slice(0, 5)
        .map((item) => ({ title: item.title, url: item.url, source: item.source, time: item.time, negative: stat.negative.get(item) })),
      history,
    };
  });

  // Countries covered by less than half of the weight are not comparable: listed after the rest.
  const tier = (c) => (c.index === null ? 2 : c.coverage >= 0.5 ? 0 : 1);
  countries.sort((a, b) => tier(a) - tier(b) || (b.index ?? 0) - (a.index ?? 0));
  countries.forEach((c, i) => { c.rank = tier(c) === 0 ? i + 1 : null; });

  const regions = [...new Set(COUNTRIES.map((c) => c.region))].map((name) => {
    const members = countries.filter((c) => c.region === name && c.index !== null && c.coverage >= 0.5);
    return {
      name,
      index: members.length ? round(members.reduce((t, c) => t + c.index, 0) / members.length) : null,
      countries: members.map((c) => c.code),
    };
  });

  return {
    countries,
    regions,
    components: COMPONENTS,
    method: {
      params: PARAMS,
      newsWindowHours: NEWS_WINDOW_HOURS,
      newsHeadlines: news.total,
      pooledNegativeShare: news.pooled,
      volumeDispersion: phi,
      toneReference: tone,
      prior,
      correlation,
      doc: 'docs/math/instability.md',
    },
  };
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null);
const instrumentInfo = ({ symbol = null, name = null, asOf = null, reason = null, reasonEn = null, spikesRemoved = 0, model = null }) => ({ symbol, name, asOf, reason, reasonEn, spikesRemoved, model });

let gdeltPauseUntil = 0;
let gdeltLastCall = 0;

/** 90-day GDELT volume of one country. Context only: not part of the index. */
export async function loadGdeltContext(code) {
  const target = COUNTRIES.find((c) => c.code === code);
  if (!target) return null;
  const missing = (reason) => ({ code, series: [], z: null, reason });
  try {
    const { value } = await cached(`instgdelt:${code}`, 60 * 60_000, async () => {
      if (Date.now() < gdeltPauseUntil || Date.now() - gdeltLastCall < 5500) throw new Error('ограничение частоты запросов, повтор позже');
      gdeltLastCall = Date.now();
      try {
        const query = encodeURIComponent(`${target.query} sourcelang:english`);
        const text = await fetchText(`https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=timelinevol&format=json&timespan=3months`, { timeoutMs: 6000, maxBytes: 3_000_000 });
        const points = parseGdeltTimeline(JSON.parse(text));
        if (!points.length) throw new Error('пустой ответ');
        return points;
      } catch (error) {
        gdeltPauseUntil = Date.now() + 120_000;
        throw error instanceof SyntaxError ? new Error('ответ не JSON (лимит запросов)') : error;
      }
    }, 6 * HOUR);
    const daily = new Map();
    for (const { t, value: v } of value) {
      const day = new Date(t).toISOString().slice(0, 10);
      const entry = daily.get(day) ?? [0, 0];
      daily.set(day, [entry[0] + v, entry[1] + 1]);
    }
    const series = [...daily].map(([day, [total, n]]) => [day, Math.round((total / n) * 1000) / 1000]);
    const recent = series.slice(-3).map((p) => p[1]);
    const base = series.slice(0, -3).map((p) => p[1]);
    const z = base.length >= 30 ? robustZ(recent.reduce((t, v) => t + v, 0) / recent.length, base) : null;
    return { code, series, z, reason: null };
  } catch (error) {
    return missing(`GDELT недоступен: ${errorMessage(error)}`);
  }
}

export async function buildInstability({ country: code = null, nowMs = Date.now() } = {}) {
  const build = cached('instability:v5', BUILD_TTL_MS, async () => {
    const errors = [];
    const [charts, news] = await Promise.all([loadMarkets(errors), loadNews(nowMs, errors)]);
    const body = assembleInstability({ charts, items: news.items, nowMs });
    body.updatedAt = nowMs;
    body.sources = { feeds: NEWS_FEEDS.length, feedsOk: news.ok, symbolsOk: [...charts.values()].filter((c) => c.history).length, symbols: charts.size };
    body.errors = errors;
    // Most sources failing must not be cached as an answer: an earlier complete one is better.
    if (news.ok < NEWS_FEEDS.length / 2 || body.sources.symbolsOk < charts.size / 2) {
      throw Object.assign(new Error('Instability sources unavailable'), { body: { ...body, degraded: true } });
    }
    return body;
  }, 30 * 60_000).then(({ value }) => value, (error) => {
    if (error.body) return error.body;
    throw error;
  });
  const [value, gdelt] = await Promise.all([build, code ? loadGdeltContext(code) : null]);
  return { ...value, gdelt };
}
