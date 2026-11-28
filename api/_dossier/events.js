import { classifyEvent, priceReaction } from './analyze.js';
import { eventStudy } from './quant.js';
import { sourceTier } from './sources.js';

function hash(value) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/**
 * Turn a raw news or filing item into a classified dossier event. With the company the
 * item was collected for, a headline about another firm's boss is not a leadership change.
 */
export function toEvent(item, company) {
  // Array.prototype.map passes an index here; only a company object counts.
  const found = classifyEvent({ title: item.title, lang: item.lang, company: typeof company === 'object' ? company : undefined });
  const filing = item.source === 'SEC EDGAR';
  return {
    id: hash(item.url),
    time: item.time,
    title: item.title,
    url: item.url,
    source: item.source,
    lang: item.lang,
    region: item.region,
    // A filing's type follows its 8-K item (5.02 is leadership by definition); it carries no tone.
    type: filing ? item.type ?? 'leadership' : found.type,
    sentiment: filing ? 0 : found.sentiment,
    people: filing ? [] : found.people,
    tier: item.tier ?? sourceTier(item.source),
    ...(item.outlets > 1 ? { outlets: item.outlets } : {}),
    ...(item.cluster ? { cluster: { ...item.cluster, sources: item.cluster.sources.slice(0, 5), credibility: item.cluster.credibility.slice(0, 5) } } : {}),
    ...(item.mention ? { mention: item.mention } : {}),
    via: item.via ?? (filing ? 'edgar' : 'gnews'),
    priceMovePct: null,
    abnormalMovePct: null,
    impact: null,
  };
}

export function withReaction(event, history, benchmarkHistory) {
  if (!history?.length) return event;
  const { priceMovePct, abnormalMovePct } = priceReaction(history, benchmarkHistory ?? [], event.time);
  const impact = eventStudy(history, benchmarkHistory ?? [], event.time);
  return { ...event, priceMovePct, abnormalMovePct, impact };
}

// Retail offers mention a company without saying anything about it as a business.
const SHOPPING = new RegExp(
  [
    '\\b(black friday|cyber monday|prime day)\\b.*\\b(deals?|sales?|price|offers?|discounts?)\\b',
    '\\b(deals?|discounts?|offers?)\\b.*\\b(black friday|cyber monday|prime day)\\b',
    '\\b(save|get|now|just|only|under)\\s+(up to\\s+)?[$€£]\\s?\\d',
    '[$€£]\\s?\\d[\\d,.]*\\s+off\\b',
    '\\b\\d{1,2}%\\s+off\\b',
    '\\b(record[- ]low|lowest)[- ]price\\b',
    '\\bpromo code\\b|\\bcoupon\\b|\\bbest deals\\b',
    '\\brefurbished\\b.*[$€£]\\s?\\d',
    '[$€£]\\s?\\d[\\d,]*(\\.\\d{2})?\\s+with\\b.*\\bincluded\\b',
  ].join('|'),
  'i',
);

export const isShoppingNoise = (event) => event.source !== 'SEC EDGAR' && SHOPPING.test(event.title);

/**
 * Newest-first selection that keeps leadership changes visible: they get up to
 * `leadershipCap` places before everything else fills the rest of `cap`.
 */
export function selectEvents(events, cap, leadershipCap) {
  const sorted = events.filter((e) => !isShoppingNoise(e)).sort((a, b) => b.time - a.time);
  // Official filings take their places first so press repeats cannot crowd them out.
  const isFiling = (e) => e.source === 'SEC EDGAR';
  const changes = sorted.filter((e) => e.type === 'leadership');
  const leadership = [...changes.filter(isFiling), ...changes.filter((e) => !isFiling(e))].slice(0, leadershipCap);
  const kept = new Set(leadership);
  const rest = sorted.filter((e) => !kept.has(e) && e.type !== 'leadership').slice(0, cap - leadership.length);
  return [...leadership, ...rest].sort((a, b) => b.time - a.time);
}
