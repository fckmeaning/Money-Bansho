// SEC EDGAR 8-K filings: material items (leadership changes, results, agreements, delisting, auditor, cyber).
import { cached, fetchText } from './util.js';

const YEAR_MS = 366 * 86400_000;

// 8-K item -> [event type, description]. Checked in this order: the first item a filing lists wins.
const ITEMS = [
  ['5.02', 'leadership', 'director or officer departure, appointment or compensation change'],
  ['4.02', 'scandal', 'non-reliance on previously issued financial statements'],
  ['1.05', 'scandal', 'material cybersecurity incident'],
  ['1.03', 'scandal', 'bankruptcy or receivership'],
  ['3.01', 'regulation', 'notice of delisting or failure to satisfy a listing rule'],
  ['4.01', 'regulation', 'change of certifying accountant'],
  ['1.01', 'deal', 'entry into a material definitive agreement'],
  ['1.02', 'deal', 'termination of a material definitive agreement'],
  ['2.01', 'deal', 'completion of acquisition or disposition of assets'],
  ['5.01', 'deal', 'changes in control of the registrant'],
  ['2.05', 'deal', 'costs associated with exit or disposal activities'],
  ['2.02', 'earnings', 'results of operations and financial condition'],
];

export function parseFilings(body, cik, name, nowMs = Date.now()) {
  const recent = body?.filings?.recent;
  if (!recent?.form) throw new Error('No filings data');
  const events = [];
  recent.form.forEach((form, i) => {
    if (!/^8-K(?:\/A)?$/.test(form)) return;
    const items = String(recent.items?.[i] ?? '').split(',');
    const hit = ITEMS.find(([item]) => items.includes(item));
    if (!hit) return;
    const time = Date.parse(recent.acceptanceDateTime?.[i] || recent.filingDate?.[i]);
    if (!Number.isFinite(time) || nowMs - time > YEAR_MS) return;
    const folder = String(recent.accessionNumber[i]).replaceAll('-', '');
    events.push({
      title: `${name} ${form} Item ${hit[0]}: ${hit[2]} (filed ${recent.filingDate[i]})`,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${folder}/${encodeURIComponent(recent.primaryDocument[i])}`,
      source: 'SEC EDGAR',
      type: hit[1],
      time,
      lang: 'en',
      region: 'us',
    });
  });
  return events;
}

export function loadFilings(cik, name) {
  if (!/^\d{10}$/.test(cik)) return Promise.reject(new Error('Invalid CIK'));
  return cached(`sec:${cik}`, 10 * 60_000, async () => parseFilings(
    JSON.parse(await fetchText(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      timeoutMs: 7000,
      headers: { 'User-Agent': 'MoneyBansho/1.0 (dossier research tool)', Accept: 'application/json' },
    })),
    cik,
    name,
  ), 60 * 60_000);
}
