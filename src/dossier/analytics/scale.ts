// Scales, ticks, decimation and the few statistics the charts need.
import type { Nullable } from './parse';

export type Scale = (value: number) => number;

export function linear(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

export function ticks(min: number, max: number, count: number): number[] {
  const raw = (max - min) / Math.max(1, count);
  if (!(raw > 0) || !Number.isFinite(raw)) return [min];
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  const out: number[] = [];
  const start = Math.ceil(min / step - 1e-9);
  for (let k = start; k * step <= max + step * 1e-9 && out.length < 50; k++) {
    out.push(Number((k * step).toPrecision(12)));
  }
  return out;
}

export function extent(lists: Nullable[][], from: number, to: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const values of lists) {
    for (let i = from; i <= to; i++) {
      const v = values[i];
      if (v === null || v === undefined) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Pads a domain; an edge pinned at zero stays at zero. */
export function padded([lo, hi]: [number, number], includeZero: boolean): [number, number] {
  const low = includeZero ? Math.min(0, lo) : lo;
  const high = includeZero ? Math.max(0, hi) : hi;
  const pad = (high - low) * 0.06 || Math.abs(high) * 0.05 || 1;
  return [includeZero && low === 0 ? 0 : low - pad, includeZero && high === 0 ? 0 : high + pad];
}

/**
 * Indices to draw for a line. When there are more points than pixels, each pixel
 * bucket keeps its minimum and maximum, so spikes survive. A null marks a gap.
 */
export function decimate(values: Nullable[], from: number, to: number, pixels: number): (number | null)[] {
  const count = to - from + 1;
  const out: (number | null)[] = [];
  if (count <= pixels * 1.5) {
    for (let i = from; i <= to; i++) out.push(values[i] === null || values[i] === undefined ? null : i);
    return out;
  }
  const buckets = Math.max(1, Math.floor(pixels));
  for (let b = 0; b < buckets; b++) {
    const start = from + Math.floor((b * count) / buckets);
    const end = from + Math.floor(((b + 1) * count) / buckets) - 1;
    let lo = -1;
    let hi = -1;
    for (let i = start; i <= end; i++) {
      const v = values[i];
      if (v === null || v === undefined) continue;
      if (lo < 0 || v < (values[lo] as number)) lo = i;
      if (hi < 0 || v > (values[hi] as number)) hi = i;
    }
    if (lo < 0) {
      out.push(null);
      continue;
    }
    const keep = new Set<number>([lo, hi]);
    if (b === 0 && values[from] !== null) keep.add(from);
    if (b === buckets - 1 && values[to] !== null) keep.add(to);
    out.push(...[...keep].sort((a, c) => a - c));
  }
  return out;
}

export function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const a = sorted[base] ?? 0;
  const b = sorted[base + 1] ?? a;
  return a + (b - a) * (position - base);
}

export function regression(points: [number, number][]): { slope: number; intercept: number; r: number } | null {
  const n = points.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (const [x, y] of points) {
    mx += x / n;
    my += y / n;
  }
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  if (sxx <= 0 || syy <= 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: sxy / Math.sqrt(sxx * syy) };
}
