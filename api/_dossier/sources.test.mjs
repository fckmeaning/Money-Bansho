import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterItems, deadFeeds, gatherSources, jaccard, matchTerms, mention, parseFeed, resetFeedState, selectFeeds,
  shingles, sourceCredibility, sourceTier,
} from './sources.js';
import { FEEDS } from './feeds.js';

const ACME = { symbol: 'ACME', name: 'Acme Robotics', aliases: ['Acme Robotics', 'Acme'], country: 'US', region: 'us', benchmark: '^GSPC' };
const NOW = Date.UTC(2026, 10, 27, 12);

const rssItem = (title, minutesAgo = 30, text = '') =>
  `<item><title><![CDATA[${title}]]></title><link>https://example.com/${encodeURIComponent(title).slice(0, 40)}-${minutesAgo}</link>`
  + `<pubDate>${new Date(Date.now() - minutesAgo * 60_000).toUTCString()}</pubDate><description>${text}</description></item>`;
const rss = (...items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items.join('')}</channel></rss>`;

/** Replaces fetch for one test; `handler(url, ua, callIndex)` returns a Response or throws. */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const ua = init?.headers?.['User-Agent'];
    calls.push({ url: String(url), ua });
    return handler(String(url), ua, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const ok = (body) => new Response(body, { status: 200 });
const feedCalls = (calls) => calls.filter((c) => !/gdeltproject|yahoo|news\.google/.test(c.url));
const quick = { budgetMs: 3000, softMs: 3000, background: false };

test('parseFeed reads RSS, Atom and RDF, decodes entities and drops undated or future items', () => {
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A &amp; B beat</title><link rel="alternate" href="https://e.com/a"/><updated>2026-11-26T10:00:00Z</updated><summary>Sum</summary></entry></feed>';
  assert.deepEqual(parseFeed(atom, NOW).map((i) => [i.title, i.url]), [['A & B beat', 'https://e.com/a']]);
  const rdf = '<rdf:RDF><item><title>Old</title><link>https://e.com/o</link><dc:date>2026-11-20T00:00:00Z</dc:date></item></rdf:RDF>';
  assert.equal(parseFeed(rdf, NOW).length, 1);
  const messy = `<rss><channel>${[
    '<item><title>No date</title><link>https://e.com/1</link></item>',
    '<item><title>Future</title><link>https://e.com/2</link><pubDate>Fri, 01 Jan 2100 00:00:00 GMT</pubDate></item>',
    '<item><title>Good</title><link>https://e.com/3</link><pubDate>Thu, 26 Nov 2026 10:00:00 GMT</pubDate></item>',
  ].join('')}</channel></rss>`;
  assert.deepEqual(parseFeed(messy, NOW).map((i) => i.title), ['Good']);
  assert.throws(() => parseFeed('<html>not a feed</html>'), /Not a feed/);
});

test('relevance: the company must be named with word boundaries; a passing summary mention or a tag is not enough', () => {
  const terms = matchTerms(ACME);
  assert.ok(mention({ title: 'Acme Robotics raises guidance', text: '' }, terms)?.inTitle);
  assert.equal(mention({ title: 'Acmeville council votes', text: '' }, terms), null, 'no match inside another word');
  assert.equal(mention({ title: 'Robotics sector rallies', text: 'Acme was named once.' }, terms), null, 'one passing mention in the summary');
  assert.ok(mention({ title: 'Robotics sector rallies', text: 'Acme leads. Analysts say Acme Robotics will grow.' }, terms), 'named twice in the summary');
  const nvda = matchTerms({ symbol: 'NVDA', aliases: ['Nvidia'] });
  assert.ok(mention({ title: 'NVDA jumps after results', text: '' }, nvda), 'ticker in capitals');
  assert.equal(mention({ title: 'AbbVie reports earnings', text: '', related: true, relatedTickers: ['NVDA'] }, nvda), null, 'aggregator tags are ignored');
  const teva = matchTerms({ symbol: 'TEVA.TA', aliases: ['Teva', 'טבע'] });
  assert.equal(mention({ title: 'שמורת טבע חדשה נפתחה בצפון', text: '' }, teva), null, 'Hebrew "nature" is not Teva');
  assert.ok(mention({ title: 'מניית טבע זינקה בתל אביב', text: '' }, teva), 'with a business word it is');
});

test('selection: 100+ feeds, region-aware, Google News and per-host caps, quarantined feeds skipped', () => {
  resetFeedState();
  const china = selectFeeds({ ...ACME, region: 'china', country: 'CN' });
  const us = selectFeeds(ACME);
  assert.ok(china.length >= 100 && us.length >= 100, `${china.length} / ${us.length}`);
  assert.ok(FEEDS.length >= 1000, 'the catalog behind it is large');
  const share = (list, group) => list.filter((f) => f.g === group).length;
  assert.ok(share(china, 'china') > share(us, 'china'), 'a Chinese company draws on the Chinese feeds');
  assert.ok(share(us, 'us') > share(china, 'us'));
  assert.ok(china.filter((f) => f.gn).length <= 24);
  assert.equal(new Set(china.map((f) => f.u)).size, china.length, 'no feed twice');
});

test('gatherSources: matches headlines, remembers answers (second poll makes no feed requests), reports counts', async () => {
  resetFeedState();
  const stub = stubFetch((url) => {
    if (url.includes('gdeltproject')) return ok(JSON.stringify({ articles: [{ title: 'Acme Robotics opens plant', url: 'https://g.example/1', seendate: '20261127T100000Z', domain: 'reuters.com', language: 'English' }, { title: 'Unrelated headline', url: 'https://g.example/2', seendate: '20261127T100000Z', domain: 'x.com', language: 'English' }] }));
    if (url.includes('finance/search')) return ok(JSON.stringify({ news: [{ title: 'AbbVie earnings beat', link: 'https://y.example/1', providerPublishTime: Math.floor(Date.now() / 1000), publisher: 'Motley Fool', relatedTickers: ['ACME'] }] }));
    if (isCompanyQuery(url)) return ok(rss(rssItem('Acme Robotics stock news', 40)));
    return ok(rss(rssItem('Acme Robotics names new chief executive', 30), rssItem('Weather today', 20)));
  });
  try {
    const first = await gatherSources(ACME, quick);
    const s = first.stats;
    assert.ok(s.polled >= 100, `polled ${s.polled}`);
    assert.equal(s.answered, s.polled, 'every stubbed feed answered');
    assert.ok(s.matched >= 100, `matched ${s.matched}`);
    assert.ok(first.items.every((i) => /Acme/.test(i.title)), 'only headlines naming the company');
    assert.ok(!first.items.some((i) => /AbbVie/.test(i.title)), 'related-ticker noise from Yahoo is gone');
    assert.ok(first.items.some((i) => i.via === 'gdelt'));
    assert.equal(s.structured.find((x) => x.id === 'gdelt:articles').ok, true);
    const before = feedCalls(stub.calls).length;
    assert.ok(before >= s.polled);
    const second = await gatherSources(ACME, quick);
    assert.equal(feedCalls(stub.calls).length, before, 'served from memory');
    assert.equal(second.stats.servedFromMemory, second.stats.answered);
    assert.equal(second.stats.answeredLive, 0);
  } finally {
    stub.restore();
  }
});

test('a feed that answers 403 to a browser User-Agent is retried with a plain one', async () => {
  resetFeedState();
  const stub = stubFetch((url, ua) => {
    if (isStructured(url)) return new Response('', { status: 500 });
    if (/Mozilla/.test(ua)) return new Response('', { status: 403 });
    return ok(rss(rssItem('Acme Robotics wins order', 15)));
  });
  try {
    const { stats, items } = await gatherSources(ACME, { ...quick, limit: 10 });
    assert.equal(stats.answered, 10);
    assert.ok(items.length >= 10);
    const uas = stub.calls.filter((c) => /example|\.com|\.org/.test(c.url)).map((c) => c.ua);
    assert.ok(uas.some((u) => u === 'curl/8.5.0'));
    // The next poll starts with the plain UA for the feeds that needed it (after the memory expires).
  } finally {
    stub.restore();
  }
});

test('a timeout is retried once; repeated 404 puts a feed into quarantine and onto the dead list', async () => {
  resetFeedState();
  const [first] = selectFeeds(ACME, { limit: 5 });
  let hits = 0;
  const stub = stubFetch((url) => {
    if (isStructured(url)) return new Response('', { status: 500 });
    if (url === first.u) {
      hits += 1;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }
    if (url.includes('quarantine-me')) return new Response('', { status: 404 });
    return ok(rss(rssItem('Acme Robotics update', 10)));
  });
  try {
    const run = await gatherSources(ACME, { ...quick, limit: 5 });
    assert.equal(hits, 2, 'one retry');
    assert.equal(run.stats.answered, 4);
    assert.equal(run.stats.failures[0].count, 1);
    // Two more rounds of failures reach the quarantine threshold (3 consecutive transient failures).
    await gatherSources(ACME, { ...quick, limit: 5 });
    await gatherSources(ACME, { ...quick, limit: 5 });
    assert.ok(deadFeeds().some((d) => d.url === first.u && d.quarantined));
    assert.ok(!selectFeeds(ACME, { limit: 5 }).some((f) => f.u === first.u), 'quarantined feeds are not polled');
  } finally {
    stub.restore();
  }
});

test('progressive: slow feeds do not block the request; what answered is returned', async () => {
  resetFeedState();
  const slow = new Set(selectFeeds(ACME, { limit: 20 }).slice(10).map((f) => f.u));
  const stub = stubFetch((url) => {
    if (isStructured(url)) return new Response('', { status: 500 });
    if (slow.has(url)) return new Promise(() => {}); // never answers
    return ok(rss(rssItem('Acme Robotics fast feed', 5)));
  });
  try {
    const began = Date.now();
    const { stats } = await gatherSources(ACME, { limit: 20, budgetMs: 700, softMs: 700, background: false });
    assert.ok(Date.now() - began < 3000, 'returned at the budget');
    assert.equal(stats.answered, 10);
    assert.ok(stats.timedOut >= 10);
    assert.ok(stats.feeds.filter((f) => !f.ok).every((f) => /бюджет|время вышло/.test(f.error)));
  } finally {
    stub.restore();
  }
});

test('GDELT failure falls back to a Google News search', async () => {
  resetFeedState();
  const stub = stubFetch((url) => {
    if (url.includes('gdeltproject')) return new Response('', { status: 500 });
    if (url.includes('yahoo')) return new Response('', { status: 500 });
    if (isCompanyQuery(url)) return ok(rss(rssItem('Acme Robotics shares jump', 25)));
    return new Response('', { status: 404 });
  });
  try {
    const { stats, items } = await gatherSources(ACME, { ...quick, limit: 3 });
    assert.equal(stats.structured.find((x) => x.id === 'gdelt:articles').ok, false);
    assert.equal(stats.structured.find((x) => x.id === 'gnews:fallback').ok, true);
    assert.ok(items.some((i) => i.via === 'gnews'));
  } finally {
    stub.restore();
  }
});

test('clusters: the same story from several outlets is one cluster with the confirmation count', () => {
  const t = Date.UTC(2026, 10, 26, 9);
  const items = [
    { title: 'Acme Robotics names Jane Doe as chief executive', url: 'https://a/1', source: 'Reuters', time: t, tier: 1 },
    { title: 'Acme Robotics names Jane Doe chief executive - Bloomberg', url: 'https://b/1', source: 'Bloomberg', time: t + 3600_000 },
    { title: 'Acme Robotics names Jane Doe as chief executive', url: 'https://a/1', source: 'Reuters', time: t },
    { title: 'Acme Robotics posts Q3 revenue of 4.2 billion', url: 'https://c/1', source: 'CNBC', time: t },
    { title: 'Acme Robotics posts Q3 revenue of 5.1 billion', url: 'https://d/1', source: 'FT', time: t },
  ];
  const clusters = clusterItems(items);
  assert.equal(clusters.length, 3, 'the URL duplicate is dropped, different figures are different news');
  const ceo = clusters.find((c) => /chief executive/.test(c.title));
  assert.equal(ceo.outlets, 2);
  assert.equal(ceo.cluster.bestTier, 1);
  assert.ok(jaccard(shingles('Acme names Jane Doe CEO'), shingles('Acme names Jane Doe CEO')) === 1);
});

test('source tiers: wires on top, state media capped', () => {
  assert.equal(sourceTier('Reuters'), 1);
  assert.ok(sourceCredibility('Reuters') > sourceCredibility('Some Blog'));
  assert.ok(sourceCredibility('Xinhua English') <= 0.4);
});
