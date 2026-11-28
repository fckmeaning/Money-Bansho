// Fresh headlines for the co-mention graph: the Google News searches of the wire
// plus business, technology and regional publisher feeds from the catalogue.
import companies from './companies.js';
import { FEEDS } from './feeds.js';
import { coMentionGraph } from './math/comentions.js';
import { fetchHead, parseFeed } from './sources.js';
import { cached, errorMessage, pool } from './util.js';
import { wireHeadlines } from './wire.js';

export const WINDOW_DAYS = 8;
export const FEED_COUNT = 96;
const FEED_BUDGET_MS = 14_000;
const FEED_TIMEOUT_MS = 9000;
const FEED_TTL_MS = 5 * 60_000;
const DAY = 86_400_000;
const GROUPS = ['fin', 'corp', 'tech', 'china', 'israel', 'korea', 'us', 'europe', 'asia'];
const LANGS = new Set(['en', 'zh', 'he', 'ko', 'de', 'fr']);

/** Direct publisher feeds, business groups first, taken in turn so that no group crowds out the rest. */
export function mentionFeeds(feeds = FEEDS, limit = FEED_COUNT) {
  const queues = GROUPS.map((group) => feeds
    .filter((f) => f.g === group && !f.gn && LANGS.has((f.l ?? 'en').slice(0, 2)))
    .sort((a, b) => a.t - b.t));
  const share = { fin: 4, corp: 2, tech: 2, china: 2 };
  const out = [];
  const seen = new Set();
  while (out.length < limit && queues.some((q) => q.length)) {
    queues.forEach((queue, i) => {
      for (const feed of queue.splice(0, share[GROUPS[i]] ?? 1)) {
        if (out.length >= limit || seen.has(feed.u)) continue;
        seen.add(feed.u);
        out.push(feed);
      }
    });
  }
  return out;
}

async function feedHeadlines(feeds, stats) {
  const items = [];
  const deadline = Date.now() + FEED_BUDGET_MS;
  const work = pool(feeds, 16, async (feed) => {
    const left = deadline - Date.now();
    if (left < 800) return;
    try {
      const { value } = await cached(`atlas-feed:${feed.u}`, FEED_TTL_MS, async () => parseFeed(
        await fetchHead(feed.u, Math.min(FEED_TIMEOUT_MS, left)),
      ), 60 * 60_000);
      stats.answered += 1;
      for (const { title, url, time } of value) items.push({ title, url, time, source: feed.n });
    } catch {
      // A silent publisher only lowers the sample; the counts are reported.
    }
  });
  let timer;
  await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, FEED_BUDGET_MS); })]);
  clearTimeout(timer);
  return [...items];
}

export async function buildCoMentions(nowMs = Date.now(), list = companies) {
  const errors = [];
  const feeds = mentionFeeds();
  const stats = { asked: feeds.length, answered: 0 };
  const [searched, published] = await Promise.all([
    wireHeadlines(errors).catch((error) => {
      errors.push({ source: 'google-news:wire', message: errorMessage(error) });
      return [];
    }),
    feedHeadlines(feeds, stats),
  ]);
  const inWindow = (item) => item.time <= nowMs + 3_600_000 && nowMs - item.time <= WINDOW_DAYS * DAY;
  const count = (items) => new Set(items.filter(inWindow).map((item) => item.url)).size;
  const fresh = [...searched, ...published].filter(inWindow)
    .map(({ title, url, source, time }) => ({ title, url, source, time }));
  const graph = coMentionGraph(fresh, list);
  const oldest = fresh.reduce((low, item) => Math.min(low, item.time), Number.POSITIVE_INFINITY);
  return {
    updatedAt: Date.now(),
    windowDays: WINDOW_DAYS,
    sample: {
      headlines: new Set(fresh.map((item) => item.url)).size,
      searched: count(searched),
      published: count(published),
      feedsAsked: stats.asked,
      feedsAnswered: stats.answered,
      oldestAt: Number.isFinite(oldest) ? oldest : null,
    },
    ...graph,
    errors: errors.slice(0, 20),
  };
}
