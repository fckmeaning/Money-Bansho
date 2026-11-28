// Cross-company wire. News is queried for several companies at once and the
// batches are refreshed in rotation to stay inside edge time limits.
import companies from './companies.js';
import { dedupeEvents } from './analyze.js';
import { selectEvents, toEvent, withReaction } from './events.js';
import { editionsFor, LEADERSHIP_TERMS, newsCacheKey, primaryCompany, searchNews, searchTerm } from './news.js';
import { cacheAge, cachePeek, errorMessage, pool } from './util.js';
import { loadBoard, loadChart } from './yahoo.js';

const TTL_MS = 60_000;
const KEEP_MS = 15 * 60_000;
const WARM_REFRESH = 12;
const BATCH_SIZE = 6;
const EVENT_CAP = 60;
const MAX_AGE_MS = 8 * 86400_000;

function buildBatches() {
  const batches = [];
  const add = (kind, edition, members) => {
    for (let i = 0; i < members.length; i += BATCH_SIZE) {
      const group = members.slice(i, i + BATCH_SIZE);
      const names = `(${group.map((c) => searchTerm(c, edition)).join(' OR ')})`;
      const query = kind === 'leadership'
        ? `${names} ${LEADERSHIP_TERMS[edition]} when:7d`
        : `${names} when:1d`;
      batches.push({ id: `${edition}:${kind}:${i / BATCH_SIZE + 1}`, kind, edition, query, members: group });
    }
  };
  add('leadership', 'en', companies);
  for (const edition of ['zh', 'zh-TW', 'he', 'de', 'fr', 'ko']) {
    // Home-market companies only, so the batch count stays small.
    add('leadership', edition, companies.filter((c) => c.region !== 'us' && editionsFor(c).includes(edition)));
  }
  add('news', 'en', companies);
  return batches;
}

const BATCHES = buildBatches();

async function refreshBatches(errors) {
  const keyOf = (b) => newsCacheKey(b.query, b.edition);
  const due = BATCHES.filter((b) => cacheAge(keyOf(b)) >= TTL_MS);
  // Fill every empty slot first, then rotate through the oldest ones.
  const missing = due.filter((b) => cacheAge(keyOf(b)) > KEEP_MS);
  const aged = due
    .filter((b) => cacheAge(keyOf(b)) <= KEEP_MS)
    .sort((a, b) => cacheAge(keyOf(b)) - cacheAge(keyOf(a)))
    .slice(0, Math.max(0, WARM_REFRESH - missing.length));
  const deadline = Date.now() + 14_000;
  await pool([...missing, ...aged], 10, async (batch) => {
    const source = `google-news:wire:${batch.id}`;
    const left = deadline - Date.now();
    if (left < 1000) {
      errors.push({ source, message: 'Skipped: time budget reached' });
      return;
    }
    try {
      const { staleError } = await searchNews(batch.query, batch.edition, TTL_MS, Math.min(6000, left));
      if (staleError) errors.push({ source, message: staleError });
    } catch (error) {
      errors.push({ source, message: errorMessage(error) });
    }
  });
  return BATCHES.map((batch) => ({ batch, items: cachePeek(keyOf(batch), KEEP_MS) ?? [] }));
}

/** Raw headlines of the wire searches (refreshed in rotation) for other views. */
export async function wireHeadlines(errors = []) {
  return (await refreshBatches(errors)).flatMap((result) => result.items);
}

/** Attribute each headline to the listed company it names first. */
function groupByCompany(results, nowMs) {
  const groups = new Map();
  const seen = new Set();
  for (const { items } of results) {
    for (const item of items) {
      if (seen.has(item.url) || nowMs - item.time > MAX_AGE_MS) continue;
      seen.add(item.url);
      const match = primaryCompany(item.title, companies);
      if (!match) continue;
      if (!groups.has(match)) groups.set(match, []);
      groups.get(match).push(item);
    }
  }
  return groups;
}

async function addReactions(events) {
  const wanted = [...new Set(events.filter((e) => e.type === 'leadership').map((e) => e.symbol))].slice(0, 12);
  const histories = new Map();
  const symbols = [...new Set(wanted.flatMap((s) => [s, companies.find((c) => c.symbol === s).benchmark]))];
  await pool(symbols, 8, async (symbol) => {
    try {
      histories.set(symbol, (await loadChart(symbol, 5 * 60_000)).value.history);
    } catch {
      // Reaction fields stay null for this company.
    }
  });
  return events.map((event) => {
    if (event.type !== 'leadership' || !histories.has(event.symbol)) return event;
    const { benchmark } = companies.find((c) => c.symbol === event.symbol);
    return withReaction(event, histories.get(event.symbol), histories.get(benchmark));
  });
}

export async function buildWire(nowMs = Date.now()) {
  const errors = [];
  const [results, board] = await Promise.all([
    refreshBatches(errors),
    loadBoard(companies.map((c) => c.symbol)),
  ]);
  errors.push(...board.errors);
  const changes = new Map(board.quotes.map((q) => [q.symbol, q.changePct]));

  const all = [];
  for (const [company, items] of groupByCompany(results, nowMs)) {
    // Dedupe within one company, then stop a single story from flooding the wire.
    const events = selectEvents(dedupeEvents(items.map((item) => toEvent(item, company))), 8, 5);
    for (const event of events) {
      all.push({ ...event, symbol: company.symbol, name: company.name, changePct: changes.get(company.symbol) ?? null });
    }
  }
  // Unclassified headlines (shopping deals, passing mentions) only fill spare room.
  const typed = selectEvents(all.filter((e) => e.type !== 'other'), EVENT_CAP, 40);
  const spare = selectEvents(all.filter((e) => e.type === 'other'), EVENT_CAP - typed.length, 0);
  const picked = [...typed, ...spare].sort((a, b) => b.time - a.time);
  // Price reactions are optional: do not hold the wire back for slow charts.
  let timer;
  const events = await Promise.race([
    addReactions(picked),
    new Promise((resolve) => { timer = setTimeout(resolve, 3500, picked); }),
  ]);
  clearTimeout(timer);
  return { events, updatedAt: Date.now(), errors };
}
