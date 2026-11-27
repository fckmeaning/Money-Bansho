// Downloads the real data for scripts/backtest-real.mjs into docs/handoff/backtest-data/.
// Free sources, no keys: Yahoo chart (5y daily bars + dividends/splits), SEC EDGAR submissions
// (8-K filing times and item codes, US filers), GDELT DOC 2.0 (daily article counts and mean tone
// per company query). Nothing is invented: a failed download is skipped and reported.
// Run: node scripts/backtest-fetch.mjs [yahoo] [sec] [gdelt]   (no argument = all three)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'handoff', 'backtest-data');
mkdirSync(OUT, { recursive: true });
const companies = JSON.parse(readFileSync(join(ROOT, 'shared', 'dossier-companies.json'), 'utf8'));
const byCompany = new Map(companies.map((c) => [c.symbol, c]));

export const SYMBOLS = [
  'NVDA', 'AAPL', 'MSFT', 'TSLA', 'JPM', 'XOM', 'PFE', 'BA', 'INTC', 'AMD',
  '0700.HK', '9988.HK', '1810.HK', '600519.SS',
  'SAP.DE', 'SIE.DE', 'VOW3.DE', 'MC.PA', 'AIR.PA', 'ASML.AS', 'NESN.SW', 'AZN.L', 'NOVO-B.CO',
  'TEVA.TA', 'NICE.TA', 'ESLT.TA', 'CHKP',
  '005930.KS', '000660.KS', '7203.T', '2330.TW',
];
// Unambiguous English-language names for GDELT (ambiguous ones such as Apple, Meta, AMD, SAP are skipped).
export const GDELT_NAMES = {
  NVDA: 'NVIDIA', TSLA: 'Tesla', MSFT: 'Microsoft', JPM: 'JPMorgan', XOM: 'ExxonMobil', PFE: 'Pfizer', BA: 'Boeing',
  '0700.HK': 'Tencent', '9988.HK': 'Alibaba', '1810.HK': 'Xiaomi', 'VOW3.DE': 'Volkswagen', 'MC.PA': 'LVMH',
  'AIR.PA': 'Airbus', 'ASML.AS': 'ASML', 'NESN.SW': 'Nestle', 'AZN.L': 'AstraZeneca', 'NOVO-B.CO': 'Novo Nordisk',
  'TEVA.TA': 'Teva', CHKP: 'Check Point', '005930.KS': 'Samsung Electronics', '000660.KS': 'SK Hynix',
  '7203.T': 'Toyota', '2330.TW': 'TSMC',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const want = (name) => !args.length || args.includes(name);
const fileOf = (name) => join(OUT, name);
const log = (line) => process.stdout.write(`${line}\n`);

async function getJson(url, { headers = {}, tries = 4, pause = 20_000 } = {}) {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(60_000) });
      const text = await response.text();
      if (response.status === 429 || /^Please limit/i.test(text)) { last = new Error('429'); await sleep(pause * (attempt + 1)); continue; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return JSON.parse(text);
    } catch (error) {
      last = error;
      if (String(error.message).startsWith('HTTP 4') && !String(error.message).includes('429')) break;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw last;
}

/** Compact, lossless enough for daily work: t in epoch seconds of the session open, close, volume in shares. */
function compactChart(body) {
  const r = body?.chart?.result?.[0];
  if (!r?.timestamp) throw new Error('No chart data');
  const q = r.indicators.quote[0];
  const t = [];
  const c = [];
  const v = [];
  r.timestamp.forEach((ts, i) => {
    const close = q.close?.[i];
    if (typeof close !== 'number' || !(close > 0)) return;
    t.push(ts);
    c.push(Number(close.toPrecision(7)));
    v.push(Number.isFinite(q.volume?.[i]) ? q.volume[i] : 0);
  });
  return { symbol: r.meta.symbol, gmtoffset: r.meta.gmtoffset, currency: r.meta.currency, t, c, v, div: Object.keys(r.events?.dividends || {}).length, split: Object.keys(r.events?.splits || {}).length };
}

async function fetchYahoo() {
  const wanted = new Set(SYMBOLS);
  for (const s of SYMBOLS) wanted.add(byCompany.get(s)?.benchmark || '^GSPC');
  const index = {};
  for (const symbol of wanted) {
    const file = `px-${symbol.replace(/[^A-Za-z0-9.-]/g, '_')}.json.gz`;
    if (existsSync(fileOf(file))) { index[symbol] = file; continue; }
    try {
      const body = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d&events=div,split`);
      const chart = compactChart(body);
      writeFileSync(fileOf(file), gzipSync(JSON.stringify(chart)));
      index[symbol] = file;
      log(`yahoo ${symbol}: ${chart.t.length} bars`);
    } catch (error) {
      log(`yahoo ${symbol}: нет данных (${error.message})`);
    }
    await sleep(500);
  }
  writeFileSync(fileOf('index-prices.json'), JSON.stringify({ fetched: new Date().toISOString(), range: '5y 1d', files: index }, null, 1));
}

async function fetchSec() {
  const out = {};
  for (const symbol of SYMBOLS) {
    const cik = byCompany.get(symbol)?.cik;
    if (!cik) continue;
    try {
      const head = await getJson(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, { headers: { 'User-Agent': 'MoneyBansho/1.0 (dossier research tool)' } });
      const rows = [];
      const take = (f) => f.accessionNumber.forEach((_, i) => {
        if (f.form[i] === '8-K') rows.push([f.acceptanceDateTime[i], f.items?.[i] || '']);
      });
      take(head.filings.recent);
      for (const extra of head.filings.files || []) {
        await sleep(300);
        take(await getJson(`https://data.sec.gov/submissions/${extra.name}`, { headers: { 'User-Agent': 'MoneyBansho/1.0 (dossier research tool)' } }));
      }
      out[symbol] = rows.filter(([t]) => t >= '2021-11-01').map(([t, items]) => [t, items]);
      log(`sec ${symbol}: ${out[symbol].length} 8-K`);
    } catch (error) {
      log(`sec ${symbol}: нет данных (${error.message})`);
    }
    await sleep(400);
  }
  writeFileSync(fileOf('sec-8k.json'), JSON.stringify({ fetched: new Date().toISOString(), note: 'acceptanceDateTime (UTC) and 8-K item codes', filings: out }));
}

function gdeltPoints(json) {
  return (json?.timeline?.[0]?.data || []).map((p) => [String(p.date).slice(0, 8), p.value, p.norm ?? null]);
}

async function fetchGdelt() {
  const file = fileOf('gdelt-daily.json');
  const store = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { series: {} };
  const range = (from, to) => `startdatetime=${from}000000&enddatetime=${to}235959`;
  const years = [['20211201', '20221231'], ['20230101', '20231231'], ['20240101', '20241231'], ['20250101', '20251231'], ['20260101', '20261126']];
  for (const [symbol, name] of Object.entries(GDELT_NAMES)) {
    for (const mode of ['timelinevolraw', 'timelinetone']) {
      const key = `${symbol}|${mode}`;
      if (store.series[key]?.length > 1000) continue;
      const rows = [];
      let failed = false;
      for (const [from, to] of years) {
        try {
          await sleep(7000); // GDELT: at most one request every 5 s
          const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${name}" sourcelang:english`)}&mode=${mode}&format=json&${range(from, to)}`;
          rows.push(...gdeltPoints(await getJson(url, { pause: 25_000, tries: 5 })));
        } catch (error) {
          log(`gdelt ${key} ${from}: нет данных (${error.message})`);
          failed = true;
          break;
        }
      }
      if (!failed) { store.series[key] = rows; log(`gdelt ${key}: ${rows.length} дней`); }
      store.fetched = new Date().toISOString();
      writeFileSync(file, JSON.stringify(store));
    }
  }
}

if (want('yahoo')) await fetchYahoo();
if (want('sec')) await fetchSec();
if (want('gdelt')) await fetchGdelt();
log('готово');
