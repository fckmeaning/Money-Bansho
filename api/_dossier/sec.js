// SEC EDGAR 8-K item 5.02 filings (director and officer changes).
import { cached, fetchText } from './util.js';

const YEAR_MS = 366 * 86400_000;

export function parseFilings(body, cik, name, nowMs = Date.now()) {
  const recent = body?.filings?.recent;
  if (!recent?.form) throw new Error('No filings data');
  const events = [];
  recent.form.forEach((form, i) => {
    if (!/^8-K(\/A)?$/.test(form) || !String(recent.items?.[i] ?? '').split(',').includes('5.02')) return;
    const time = Date.parse(recent.acceptanceDateTime?.[i] || recent.filingDate?.[i]);
    if (!Number.isFinite(time) || nowMs - time > YEAR_MS) return;
    const folder = String(recent.accessionNumber[i]).replaceAll('-', '');
    events.push({
      title: `${name} ${form} Item 5.02: director or officer departure, appointment or compensation change (filed ${recent.filingDate[i]})`,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${folder}/${encodeURIComponent(recent.primaryDocument[i])}`,
      source: 'SEC EDGAR',
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
