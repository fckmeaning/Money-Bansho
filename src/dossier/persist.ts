// The previous answer of a view, kept in the browser so a repeat visit shows it
// at once (labelled with its time) while fresh data loads. Failures are silent:
// the page then waits for the network as before.

const STORE = 'bansho-dossier-v1';
const MAX_ENTRIES = 12;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const address = (key: string): string => `${location.origin}/__saved/${encodeURIComponent(key)}`;

export async function saveAnswer(key: string, body: unknown): Promise<void> {
  try {
    const store = await caches.open(STORE);
    await store.delete(address(key));
    await store.put(address(key), new Response(JSON.stringify({ at: Date.now(), body })));
    const keys = await store.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await store.delete(old);
  } catch {
    /* storage unavailable or full */
  }
}

export async function loadAnswer(key: string): Promise<{ at: number; body: unknown } | null> {
  try {
    const store = await caches.open(STORE);
    const hit = await store.match(address(key));
    if (!hit) return null;
    const saved = (await hit.json()) as { at?: unknown; body?: unknown };
    if (typeof saved.at !== 'number' || Date.now() - saved.at > MAX_AGE_MS || !saved.body) return null;
    return { at: saved.at, body: saved.body };
  } catch {
    return null;
  }
}
