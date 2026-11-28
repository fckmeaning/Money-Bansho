export function hasLiveSeed(key: string): boolean;
export function readLiveSeed(key: string): Promise<unknown | undefined>;
export function readLiveSeedBatch(keys: string[], deadlineMs?: number): Promise<Map<string, unknown>>;
