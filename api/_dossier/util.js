// Fetch with timeout and a small per-isolate TTL cache. Edge-safe.

export async function fetchText(url, { headers = {}, timeoutMs = 7000, maxBytes = 6_000_000 } = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MoneyBansho/1.0)', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const text = await response.text();
  if (text.length > maxBytes) throw new Error('Response exceeds size limit');
  return text;
}

const MAX_ENTRIES = 600;
const store = new Map();
const inFlight = new Map();

/** Age in ms of a cached entry, or Infinity when absent. */
export function cacheAge(key) {
  const entry = store.get(key);
  return entry ? Date.now() - entry.at : Number.POSITIVE_INFINITY;
}

export function cachePeek(key, maxAgeMs) {
  return cacheAge(key) <= maxAgeMs ? store.get(key).value : undefined;
}

/**
 * Resolve to { value, staleError }. Only successful loads are cached. When a
 * reload fails and an entry younger than staleMs exists, it is returned with
 * the failure message so the caller can report it.
 */
export async function cached(key, ttlMs, loader, staleMs = 10 * 60_000) {
  if (cacheAge(key) < ttlMs) return { value: store.get(key).value, staleError: null };
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const value = await loader();
      store.delete(key);
      store.set(key, { at: Date.now(), value });
      if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
      return value;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  try {
    return { value: await pending, staleError: null };
  } catch (error) {
    const old = cachePeek(key, staleMs);
    if (old === undefined) throw error;
    return { value: old, staleError: `${errorMessage(error)} (serving cached data)` };
  }
}

export function errorMessage(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'Timed out';
  return String(error?.message || error).slice(0, 200);
}

/** Run tasks with bounded concurrency; tasks must handle their own errors. */
export async function pool(items, limit, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  });
  await Promise.all(workers);
}
