import type { NewsStreamRow } from '../../shared/news-stream';

export type { NewsStreamRow };

type Listener = (rows: NewsStreamRow[]) => void;

let current: NewsStreamRow[] = [];
const listeners = new Set<Listener>();

function isRow(value: unknown): value is NewsStreamRow {
  const row = value as Partial<NewsStreamRow> | null;
  return !!row && typeof row.t === 'string' && typeof row.s === 'string' && typeof row.p === 'number';
}

/** Takes the `stream` field of a digest response. A digest without it keeps the previous rows. */
export function publishNewsStream(digest: unknown): void {
  const raw = (digest as { stream?: unknown } | null | undefined)?.stream;
  if (!Array.isArray(raw)) return;
  const rows = raw.filter(isRow);
  if (rows.length === 0) return;
  current = rows;
  for (const listener of listeners) listener(current);
}

export function getNewsStream(): NewsStreamRow[] {
  return current;
}

export function subscribeNewsStream(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
