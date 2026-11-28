// Which listed companies are named together in the same headline. Pure ESM
// (edge safe). A link means only "named in one story": it says nothing about
// ownership, supply or any other relation.
import { mentionIndex } from '../news.js';
import { jaccard, shingles } from '../sources.js';
import { graphMetrics, minimumSpanningTree } from './network.js';
import { round } from './stats.js';

export const MENTION_LEVELS = [1, 2, 3, 5];
export const MAX_COMPANIES = 8; // longer lists are tickers dumps, not stories about a link
export const SAME_STORY = 0.5; // word-set similarity from which two headlines are one story
export const EXAMPLES = 5;

/**
 * Companies a headline names. A Latin alias found in lower case ("intel" for
 * intelligence, "meta", "check point") is an ordinary word, not the company.
 */
export function companiesIn(title, companies) {
  const found = [];
  for (const company of companies) {
    const at = mentionIndex(title, company);
    if (at < 0) continue;
    // Look at the first letter of the match (a Hebrew prefix is not Latin).
    if (/^\p{Ll}/u.test(title.slice(at, at + 1)) && /\p{Script=Latin}/u.test(title.slice(at, at + 1))) continue;
    found.push(company.symbol);
  }
  return found;
}

/** One entry per story: headlines about the same companies with similar words are merged. */
export function stories(items, companies) {
  const groups = new Map();
  const seen = new Set();
  for (const item of [...items].sort((a, b) => a.time - b.time)) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    const symbols = companiesIn(item.title, companies);
    if (!symbols.length) continue;
    const key = [...symbols].sort().join(' ');
    if (!groups.has(key)) groups.set(key, []);
    const group = groups.get(key);
    const words = shingles(item.title, item.source);
    const same = group.find((s) => jaccard(s.words, words) >= SAME_STORY);
    if (same) same.copies += 1;
    else group.push({ symbols: key.split(' '), words, item, copies: 1 });
  }
  return [...groups.values()].flat().map(({ symbols, item, copies }) => ({ symbols, item, copies }));
}

/**
 * Co-mention graph of the companies in `list`. For a pair: `stories` naming both,
 * `weight` = sum of 1 / (k - 1) over those stories with k companies each, `jaccard`
 * = stories with both / stories with either, `lift` = observed / expected under independence.
 */
export function coMentionGraph(items, list) {
  const all = stories(items, list);
  const at = new Map(list.map((c, i) => [c.symbol, i]));
  const mentions = new Array(list.length).fill(0);
  const pairs = new Map();
  let linking = 0;
  for (const story of all) {
    for (const symbol of story.symbols) mentions[at.get(symbol)] += 1;
    const k = story.symbols.length;
    if (k < 2 || k > MAX_COMPANIES) continue;
    linking += 1;
    const ids = story.symbols.map((s) => at.get(s)).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = `${ids[i]}:${ids[j]}`;
        if (!pairs.has(key)) pairs.set(key, { a: ids[i], b: ids[j], count: 0, weight: 0, items: [] });
        const pair = pairs.get(key);
        pair.count += 1;
        pair.weight += 1 / (k - 1);
        pair.items.push({ ...story.item, copies: story.copies, companies: k });
      }
    }
  }
  const edges = [...pairs.values()].sort((x, y) => y.weight - x.weight || y.count - x.count || x.a - y.a || x.b - y.b);
  const graph = (subset) => subset.map((e) => ({ a: e.a, b: e.b, w: e.weight, d: 1 / e.weight }));
  const tree = minimumSpanningTree(list.length, graph(edges));
  return {
    symbols: list.map((c) => c.symbol),
    mentions,
    stories: all.length,
    linkingStories: linking,
    edges: edges.map(({ a, b, count, weight, items: found }) => ({
      a,
      b,
      count,
      weight: round(weight, 3),
      jaccard: round(count / (mentions[a] + mentions[b] - count), 4),
      lift: round((count * all.length) / (mentions[a] * mentions[b]), 2),
      items: found.sort((x, y) => x.companies - y.companies || y.time - x.time).slice(0, EXAMPLES)
        .map(({ title, url, source, time, copies }) => ({ title, url, source, time, copies })),
    })),
    network: {
      mst: { edges: tree.map(({ a, b }) => [a, b]), length: null, metrics: graphMetrics(list.length, tree) },
      levels: MENTION_LEVELS.map((threshold) => ({
        threshold,
        metrics: graphMetrics(list.length, graph(edges.filter((e) => e.count >= threshold))),
      })),
    },
  };
}
