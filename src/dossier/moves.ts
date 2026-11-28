// Pairs the largest daily moves with headlines published around them. This is a
// timing match only; it makes no claim about cause.
import type { Bar, DossierEvent } from './types';

const DAY = 86_400_000;

export interface Move {
  t: number;
  movePct: number;
  events: DossierEvent[];
}

export function largestMoves(history: Bar[], events: DossierEvent[], limit = 5): Move[] {
  const moves: Move[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1] as Bar;
    const bar = history[i] as Bar;
    if (prev.c <= 0) continue;
    // Window: start of the previous session up to one day after this session's
    // bar timestamp (so it also covers weekends and after-hours news).
    const from = prev.t;
    const to = bar.t + DAY;
    moves.push({
      t: bar.t,
      movePct: (bar.c / prev.c - 1) * 100,
      events: events.filter((e) => e.time >= from && e.time < to),
    });
  }
  return moves
    .filter((m) => m.movePct !== 0)
    .sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct))
    .slice(0, limit);
}
