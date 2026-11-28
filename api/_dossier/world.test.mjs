import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FEEDS,
  MARKETS,
  WEIGHTS,
  assembleWorld,
  classifyTexts,
  clusterItems,
  dailyChanges,
  detectRegions,
  effectiveSources,
  headlineTone,
  jaccard,
  moveSince,
  parseFeed,
  parseGdeltArticles,
  parseGdeltTime,
  parseGdeltTimeline,
  referenceIndex,
  shingles,
  significance,
  sourceTier,
  stdev,
} from './world.js';

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const HOUR = 3600_000;
const item = (title, source, hoursAgo = 2, extra = {}) => ({
  title,
  url: `https://example.com/${source}/${encodeURIComponent(title).slice(0, 40)}`,
  source,
  tier: 2,
  time: NOW - hoursAgo * HOUR,
  lang: 'en',
  region: 'world',
  feed: source,
  ...extra,
});

describe('clustering', () => {
  it('merges paraphrased headlines about one event and keeps other stories apart', () => {
    const items = [
      item('Two Italians killed in drone attack on Kuwait', 'ANSA'),
      item('Iran denies responsibility for Kuwait drone strike that killed two Italians', 'Euronews'),
      item('Two Italians killed in strike in Kuwait, as Iran denies responsibility', 'BBC'),
      item('Fed holds rates steady as inflation cools', 'CNBC'),
      item('Federal Reserve holds interest rates steady, inflation cools', 'Reuters'),
      item('Norse Atlantic files for bankruptcy and halts flights', 'DW'),
    ];
    const clusters = clusterItems(items).map((c) => c.map((i) => i.source).sort());
    assert.equal(clusters.length, 3);
    assert.ok(clusters.some((c) => c.join() === 'ANSA,BBC,Euronews'));
    assert.ok(clusters.some((c) => c.join() === 'CNBC,Reuters'));
    assert.ok(clusters.some((c) => c.join() === 'DW'));
  });

  it('does not chain unrelated headlines that share one or two words', () => {
    const items = [
      item('Iran talks resume in Geneva', 'A'),
      item('Iran oil exports rise sharply', 'B'),
      item('Geneva motor show opens with electric cars', 'C'),
    ];
    assert.equal(clusterItems(items).length, 3);
  });

  it('shingles are symmetric in Jaccard and handle Han text', () => {
    const a = shingles('Israeli strikes kill 20 in Gaza');
    const b = shingles('Israel strikes Gaza, killing 20 people');
    assert.equal(jaccard(a, b), jaccard(b, a));
    assert.ok(jaccard(a, b) > 0.3);
    assert.ok(shingles('央行宣布降息以支持经济').size > 0);
    assert.equal(jaccard(new Set(), a), 0);
  });

  it('counts syndicated copies of one headline as a quarter of a source', () => {
    const same = ['A', 'B', 'C', 'D'].map((s) => item('Republicans rethink tariffs, giving Democrats an opening', s));
    assert.equal(effectiveSources(same), 1.75);
    const distinct = [
      item('Two Italians killed in drone attack on Kuwait', 'A'),
      item('Iran denies responsibility for Kuwait drone strike', 'B'),
    ];
    assert.equal(effectiveSources(distinct), 2);
  });
});

describe('significance', () => {
  const base = { sources: [2], ageHours: 0, tone: 0, prior: 0.5, zAbs: null };

  it('weights sum to one', () => {
    assert.ok(Math.abs(Object.values(WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  });

  it('matches the documented formula', () => {
    const { score, parts } = significance({ sources: [1, 2, 3], ageHours: 24, tone: -0.25, prior: 0.9, zAbs: 2.5 });
    assert.ok(Math.abs(parts.src - (1 - Math.exp(-1))) < 1e-12);
    assert.ok(Math.abs(parts.tier - (1 + 0.8 + 0.55) / 3) < 1e-12);
    assert.ok(Math.abs(parts.rec - Math.exp(-0.5)) < 1e-12);
    assert.ok(Math.abs(parts.tone - 0.5) < 1e-12);
    assert.ok(Math.abs(parts.mkt - Math.tanh(1)) < 1e-12);
    const expected = 100 * (0.34 * parts.src + 0.12 * parts.tier + 0.18 * parts.rec + 0.1 * parts.tone + 0.14 * 0.9 + 0.12 * parts.mkt);
    assert.ok(Math.abs(score - expected) < 1e-9);
  });

  it('rises with independent sources, with diminishing returns', () => {
    const at = (n) => significance({ ...base, sources: Array(n).fill(2) }).parts.src;
    assert.ok(at(2) > at(1) && at(4) > at(2) && at(8) > at(4));
    assert.ok(at(2) - at(1) > at(8) - at(7));
  });

  it('decays with age as a Gaussian kernel and never rewards a missing market read', () => {
    const fresh = significance(base).score;
    const day = significance({ ...base, ageHours: 24 }).score;
    const three = significance({ ...base, ageHours: 72 }).score;
    assert.ok(fresh > day && day > three);
    assert.equal(significance(base).parts.mkt, 0);
    assert.ok(significance({ ...base, zAbs: 3 }).score > fresh);
  });

  it('values wires and official bodies above unknown outlets', () => {
    assert.equal(sourceTier('Reuters'), 1);
    assert.equal(sourceTier('Federal Reserve'), 1);
    assert.equal(sourceTier('BBC Middle East'), 2);
    assert.equal(sourceTier('Star Beacon'), 3);
    assert.ok(significance({ ...base, sources: [1] }).score > significance({ ...base, sources: [3] }).score);
  });
});

describe('classification', () => {
  it('types, regions and tone', () => {
    assert.equal(classifyTexts(['Drone attack kills two in Kuwait', 'Missile strike near border']).id, 'conflict');
    assert.equal(classifyTexts(['New tariffs and sanctions announced']).id, 'sanctions');
    assert.equal(classifyTexts(['ECB cuts interest rates as inflation falls']).id, 'central_bank');
    assert.equal(classifyTexts(['A quiet day at the zoo']).id, 'other');
    assert.deepEqual(detectRegions(['Israel strikes Hezbollah in Lebanon']), ['israel']);
    assert.equal(detectRegions(['Markets wobble'], ['china'])[0], 'china');
    assert.equal(detectRegions(['Markets wobble'], ['finance'])[0], 'world');
    assert.ok(headlineTone('Markets plunge as war fears grow') < 0);
    assert.ok(headlineTone('Ceasefire deal boosts stocks, rally continues') > 0);
  });
});

describe('feed and GDELT parsing', () => {
  it('reads RSS 2.0, RDF and Atom, strips the Google News publisher suffix and skips undated items', () => {
    const rss = `<rss><channel><item><title><![CDATA[Oil jumps &amp; gold climbs - Reuters]]></title><link>https://a.example/1</link><pubDate>Fri, 27 Nov 2026 10:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
      <item><title>No date</title><link>https://a.example/2</link></item></channel></rss>`;
    const parsed = parseFeed(rss, NOW);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].title, 'Oil jumps & gold climbs');
    assert.equal(parsed[0].source, 'Reuters');
    const rdf = '<rdf:RDF><item><title>RDF headline</title><link>https://b.example/1</link><dc:date>2026-11-27T09:00:00Z</dc:date></item></rdf:RDF>';
    assert.equal(parseFeed(rdf, NOW)[0].time, Date.UTC(2026, 10, 27, 9));
    const atom = '<feed><entry><title>Atom headline</title><link rel="alternate" href="https://c.example/1"/><updated>2026-11-27T08:00:00Z</updated></entry></feed>';
    assert.equal(parseFeed(atom, NOW)[0].url, 'https://c.example/1');
    assert.throws(() => parseFeed('<html></html>', NOW), /Not a feed/);
  });

  it('refuses items dated in the future', () => {
    const rss = '<rss><item><title>From tomorrow</title><link>https://a.example/f</link><pubDate>Sat, 28 Nov 2026 12:00:00 GMT</pubDate></item></rss>';
    assert.equal(parseFeed(rss, NOW).length, 0);
  });

  it('parses GDELT timestamps, articles and timelines', () => {
    assert.equal(parseGdeltTime('20261127T101500Z'), Date.UTC(2026, 10, 27, 10, 15));
    assert.ok(Number.isNaN(parseGdeltTime('yesterday')));
    const articles = parseGdeltArticles({ articles: [{ url: 'https://www.bbc.com/x', title: 'Ceasefire holds', seendate: '20261127T100000Z', domain: 'www.bbc.com' }, { url: 'http://insecure.example/y', title: 'x', seendate: '20261127T100000Z' }] }, NOW);
    assert.equal(articles.length, 1);
    assert.equal(articles[0].source, 'bbc.com');
    const line = parseGdeltTimeline({ timeline: [{ data: [{ date: '20261127T090000Z', value: -1.5 }, { date: 'bad', value: 1 }] }] });
    assert.deepEqual(line, [{ t: Date.UTC(2026, 10, 27, 9), value: -1.5 }]);
    assert.deepEqual(parseGdeltTimeline({}), []);
  });

  it('every curated feed has a unique id and an https url', () => {
    assert.equal(new Set(FEEDS.map((f) => f.id)).size, FEEDS.length);
    for (const f of FEEDS) assert.match(f.url, /^https:\/\//);
  });
});

describe('market moves', () => {
  // 90 closes with exactly known daily log-returns alternating +1% and -1% (sigma known).
  const alternating = (n, start = 100) => {
    const out = [start];
    for (let i = 1; i < n; i += 1) out.push(out[i - 1] * Math.exp(i % 2 ? 0.01 : -0.01));
    return out;
  };

  it('z-score compares the move with the volatility before it', () => {
    const closes = alternating(80);
    const sigma = stdev(dailyChanges(closes.slice(0, 70)).slice(-60));
    const jumped = [...closes.slice(0, 70), closes[69] * Math.exp(0.06)];
    const move = moveSince(jumped, 69);
    assert.equal(move.sessions, 1);
    assert.ok(Math.abs(move.z - 0.06 / sigma) < 1e-9);
    assert.ok(Math.abs(move.change - (Math.exp(0.06) - 1)) < 1e-12);
  });

  it('scales the horizon by the square root of the sessions and refuses thin history', () => {
    const closes = alternating(80);
    const one = moveSince([...closes.slice(0, 70), closes[69] * Math.exp(0.02)], 69);
    const four = moveSince([...closes.slice(0, 70), closes[69], closes[69], closes[69], closes[69] * Math.exp(0.02)], 69);
    assert.ok(Math.abs(one.z / four.z - 2) < 1e-9);
    assert.equal(moveSince(alternating(20), 18), null);
    assert.equal(moveSince(closes, closes.length - 1), null);
  });

  it('uses plain differences for yields', () => {
    const yields = Array.from({ length: 80 }, (_, i) => 4 + (i % 2 ? 0.02 : -0.02));
    const move = moveSince([...yields, 4.2], 79, true);
    assert.ok(Math.abs(move.change - (4.2 - yields[79])) < 1e-12);
  });

  it('takes the close before the UTC day of the event as reference', () => {
    const day = 86400_000;
    const t0 = Date.UTC(2026, 10, 24, 14, 30);
    const times = [0, 1, 2, 3].map((i) => t0 + i * day);
    assert.equal(referenceIndex(times, Date.UTC(2026, 10, 26, 9)), 1);
    assert.equal(referenceIndex(times, Date.UTC(2026, 10, 20)), -1);
  });
});

describe('world assembly', () => {
  const bars = (days, drift) => {
    const out = [];
    let c = 100;
    for (let i = 0; i < days; i += 1) {
      c *= Math.exp((i % 2 ? 0.004 : -0.004) + (i === days - 1 ? drift : 0));
      out.push({ t: Date.UTC(2026, 10, 27, 14, 30) - (days - 1 - i) * 86400_000, c });
    }
    return out;
  };
  const charts = new Map(MARKETS.map((m) => [m.symbol, { meta: { regularMarketTime: NOW / 1000 }, history: bars(90, m.symbol === 'CL=F' ? 0.05 : 0) }]));

  const items = [
    item('Israel strikes Hezbollah targets in Lebanon, oil climbs', 'Reuters', 3, { tier: 1 }),
    item('Israeli air force strikes Hezbollah targets across Lebanon', 'Times of Israel', 2),
    item('IDF strikes Hezbollah targets in southern Lebanon', 'Jerusalem Post', 4),
    item('Elbit Systems wins new defence contract', 'Globes', 5),
    item('Old story about a regional football match', 'Local', 70),
  ];
  const world = assembleWorld({
    items,
    charts,
    gdelt: { asked: 3, ok: 0, articles: [], tone: [], volume: [] },
    feedStatus: [{ id: 'a', name: 'A', items: 4 }, { id: 'b', name: 'B', items: null }],
    nowMs: NOW,
    errors: [],
  });

  it('ranks the corroborated event first and ties it to regions, assets and companies', () => {
    const top = world.events[0];
    assert.equal(top.sourceCount, 3);
    assert.equal(top.type, 'conflict');
    assert.equal(top.primaryRegion, 'israel');
    assert.ok(world.events.every((e, i) => i === 0 || world.events[i - 1].score >= e.score));
    const oil = top.assets.find((a) => a.symbol === 'CL=F');
    assert.ok(oil.observed && oil.observed.change > 4 && oil.observed.z > 2);
    assert.ok(top.assets.some((a) => a.symbol === '^TA125.TA'));
    assert.ok(top.companies.some((c) => c.symbol === 'ESLT.TA'));
    assert.ok(Math.abs(Object.values(top.contrib).reduce((a, b) => a + b, 0) - top.score) < 0.2);
  });

  it('reports coverage honestly and aggregates regions', () => {
    assert.deepEqual(world.coverage.feeds, { asked: 2, ok: 1, items: 5 });
    assert.deepEqual(world.coverage.gdelt, { asked: 3, ok: 0, articles: 0 });
    assert.equal(world.coverage.markets.ok, MARKETS.length);
    assert.deepEqual(world.coverage.failed, ['B']);
    assert.equal(world.regions[0].id, 'israel');
    assert.equal(world.timeline.gdelt, null);
    assert.equal(world.timeline.feeds.volume.length, 24);
    assert.equal(world.timeline.feeds.volume.reduce((a, p) => a + p.value, 0), 4);
  });

  it('says nothing about moves when the market data is missing', () => {
    const empty = assembleWorld({ items, charts: new Map(), gdelt: { asked: 3, ok: 0, articles: [], tone: [], volume: [] }, feedStatus: [], nowMs: NOW, errors: [] });
    assert.ok(empty.events[0].assets.every((a) => a.observed === null));
    assert.equal(empty.events[0].parts.mkt, 0);
    assert.equal(empty.markets.length, 0);
  });
});
