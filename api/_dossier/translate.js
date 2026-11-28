// Russian translation of headlines for display. Analysis always runs on the original
// text; translations are added to the finished response as `titleRu`.
// Free, keyless upstreams. Only public headlines are sent. Any failure leaves the
// original headline in place.
import { pool } from './util.js';

const CACHE_LIMIT = 4000;
const QUERY_CHARS = 5000;
const BATCH_LINES = 24;
const MAX_TITLES = 220;
const BUDGET_MS = 3500;
const COOLDOWN_MS = 5 * 60_000;

const cache = new Map();
const blocked = new Map();

/** Already Russian (or nothing to translate): mostly Cyrillic letters, or no letters. */
export function needsTranslation(title) {
  const letters = title.match(/\p{L}/gu);
  if (!letters) return false;
  const cyrillic = title.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  return cyrillic / letters.length < 0.5;
}

/** Objects in a response that carry a headline, in document order. */
export function headlineHolders(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) headlineHolders(item, out);
  } else if (value && typeof value === 'object') {
    if (typeof value.title === 'string' && typeof value.url === 'string') out.push(value);
    for (const item of Object.values(value)) {
      if (item && typeof item === 'object') headlineHolders(item, out);
    }
  }
  return out;
}

/** Groups texts so that each request URL stays short enough. */
export function batches(texts, maxChars = QUERY_CHARS, maxLines = BATCH_LINES) {
  const out = [];
  let batch = [];
  let size = 0;
  for (const text of texts) {
    const length = encodeURIComponent(text).length + 3;
    if (batch.length && (size + length > maxChars || batch.length >= maxLines)) {
      out.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(text);
    size += length;
  }
  if (batch.length) out.push(batch);
  return out;
}

// Both endpoints accept repeated `q` and answer one entry per text:
// either "translation" or ["translation", "detected-language"].
const PROVIDERS = [
  'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=ru',
  'https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=ru',
];

async function ask(base, texts, timeoutMs) {
  const url = base + texts.map((text) => `&q=${encodeURIComponent(text)}`).join('');
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  const body = await response.json();
  if (!Array.isArray(body) || body.length !== texts.length) throw new Error('Unexpected translation response');
  return body.map((entry) => (Array.isArray(entry) ? entry[0] : entry));
}

async function translateBatch(texts, deadline) {
  for (const base of PROVIDERS) {
    const left = deadline - Date.now();
    if (left < 300) return;
    if ((blocked.get(base) ?? 0) > Date.now()) continue;
    try {
      const result = await ask(base, texts, left);
      result.forEach((value, i) => {
        if (typeof value !== 'string' || !value.trim()) return;
        cache.set(texts[i], value.trim());
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      });
      return;
    } catch (error) {
      // A refusal means "stop asking for a while"; a timeout does not.
      if (error.status === 429 || error.status === 403) blocked.set(base, Date.now() + COOLDOWN_MS);
    }
  }
}

/**
 * Returns a copy of `body` whose headlines carry `titleRu` where a translation is
 * available. Never mutates `body`, which may be shared with an upstream cache.
 */
export async function withTranslations(body, { budgetMs = BUDGET_MS } = {}) {
  const copy = structuredClone(body);
  const holders = headlineHolders(copy).filter((item) => needsTranslation(item.title));
  const missing = [...new Set(holders.map((item) => item.title))].filter((title) => !cache.has(title)).slice(0, MAX_TITLES);
  const deadline = Date.now() + budgetMs;
  await pool(batches(missing), 4, (batch) => translateBatch(batch, deadline));
  for (const item of holders) {
    const translated = cache.get(item.title);
    if (translated && translated !== item.title) item.titleRu = translated;
  }
  return copy;
}

export function resetTranslationState() {
  cache.clear();
  blocked.clear();
}
