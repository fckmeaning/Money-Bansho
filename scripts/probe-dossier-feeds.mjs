// Probes the non-Google-News feeds of api/_dossier/feeds.js once and writes
// docs/handoff/sources/dossier-feeds-probe.json (status, latency, newest item, which User-Agent works).
// build-dossier-feeds.mjs uses it to drop dead feeds and to order the rest fastest-first.
// Run: node scripts/probe-dossier-feeds.mjs [concurrency]
import { writeFileSync } from 'node:fs';
import { FEEDS } from '../api/_dossier/feeds.js';
import { parseFeed } from '../api/_dossier/sources.js';

const CONCURRENCY = Number(process.argv[2] || 32);
const UAS = {
  browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  curl: 'curl/8.5.0',
};
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8';

async function head(url, ua, timeoutMs) {
  const response = await fetch(url, { headers: { 'User-Agent': UAS[ua], Accept: ACCEPT }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < 420_000) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

async function probe(feed) {
  const started = Date.now();
  let ua = 'browser';
  let lastError = null;
  for (const [attempt, timeout] of [[ua, 8000], ['again', 10000]]) {
    try {
      if (attempt !== 'again') ua = attempt;
      let xml;
      try {
        xml = await head(feed.u, ua, timeout);
      } catch (error) {
        if (error.status === 403 || error.status === 406) {
          ua = 'curl';
          xml = await head(feed.u, ua, timeout);
        } else throw error;
      }
      const items = parseFeed(xml);
      const newest = items.length ? Math.max(...items.map((i) => i.time)) : null;
      return { u: feed.u, ok: items.length > 0, ms: Date.now() - started, ua, items: items.length, newest: newest ? new Date(newest).toISOString().slice(0, 10) : null, error: items.length ? null : 'no dated items' };
    } catch (error) {
      lastError = error;
      const text = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : String(error?.message || error).slice(0, 80);
      if (!/timeout|fetch failed|ECONN|ENOTFOUND|socket/i.test(text)) return { u: feed.u, ok: false, ms: Date.now() - started, error: text };
    }
  }
  const text = lastError?.name === 'TimeoutError' ? 'timeout' : String(lastError?.message || lastError).slice(0, 80);
  return { u: feed.u, ok: false, ms: Date.now() - started, error: text };
}

const list = FEEDS.filter((f) => !f.gn);
const results = [];
let next = 0;
const began = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < list.length) {
    const feed = list[next++];
    results.push(await probe(feed));
    if (results.length % 100 === 0) console.log(results.length, '/', list.length, Math.round((Date.now() - began) / 1000), 's');
  }
}));
writeFileSync('docs/handoff/sources/dossier-feeds-probe.json', JSON.stringify({ at: new Date().toISOString(), feeds: results }));
const ok = results.filter((r) => r.ok).length;
console.log('probed', results.length, 'ok', ok, 'curl-ua', results.filter((r) => r.ua === 'curl').length, 'seconds', Math.round((Date.now() - began) / 1000));
