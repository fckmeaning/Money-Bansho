const TIMEOUT_MS = 45_000;
const REUSE_MS = 20_000;

// Only these snapshots are shared by the panels and the findings badge.
const SNAPSHOT_FIELDS: ReadonlyMap<string, string> = new Map([
  ['view=economy&tl=ru', 'rows'],
  ['view=economy&cl=en', 'rows'],
  ['view=instability&tl=ru', 'countries'],
]);

interface PendingSnapshot {
  controller: AbortController;
  result: Promise<unknown>;
  readers: number;
}

const pending = new Map<string, PendingSnapshot>();
const recent = new Map<string, { body: unknown; expiresAt: number }>();

async function fetchSnapshot(query: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/dossier?${query}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function startSharedSnapshot(query: string, field: string): PendingSnapshot {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const result = fetchSnapshot(query, signal)
    .then((body) => {
      if (body && typeof body === 'object' && !signal.aborted) {
        const snapshot = body as Record<string, unknown>;
        const rows = snapshot[field];
        if (snapshot.degraded !== true && Array.isArray(rows) && rows.length > 0) {
          recent.set(query, { body, expiresAt: Date.now() + REUSE_MS });
        }
      }
      return body;
    })
    .finally(() => {
      if (pending.get(query)?.controller === controller) pending.delete(query);
    });
  const snapshot = { controller, result, readers: 0 };
  pending.set(query, snapshot);
  return snapshot;
}

/** Share the base snapshots without coupling the callers' cancellation. */
export async function fetchBanshoDashboardData<T>(query: string, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const field = SNAPSHOT_FIELDS.get(query);
  if (!field) {
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    return await fetchSnapshot(query, signal ? AbortSignal.any([signal, deadline]) : deadline) as T;
  }

  const cached = recent.get(query);
  if (cached && cached.expiresAt > Date.now()) return cached.body as T;
  recent.delete(query);

  const snapshot = pending.get(query) ?? startSharedSnapshot(query, field);
  snapshot.readers++;
  let stopListening: (() => void) | undefined;
  try {
    const body = await (signal ? new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      stopListening = () => signal.removeEventListener('abort', abort);
      void snapshot.result.then(resolve, reject);
    }) : snapshot.result);
    signal?.throwIfAborted();
    return body as T;
  } finally {
    stopListening?.();
    if (--snapshot.readers === 0 && pending.get(query) === snapshot) {
      pending.delete(query);
      snapshot.controller.abort();
    }
  }
}
