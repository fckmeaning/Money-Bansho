import assert from 'node:assert/strict';
import test from 'node:test';

import { batches, headlineHolders, needsTranslation, resetTranslationState, withTranslations } from './translate.js';

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    return handler(new URL(url));
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const answer = (url) => Response.json(url.searchParams.getAll('q').map((q) => [`RU:${q}`, 'en']));

test('only non-Russian headlines need translation', () => {
  assert.equal(needsTranslation('Nvidia shares jump'), true);
  assert.equal(needsTranslation('阿里巴巴高管'), true);
  assert.equal(needsTranslation('Акции Nvidia резко выросли'), false);
  assert.equal(needsTranslation('2026 — 15%'), false);
});

test('finds headlines anywhere in a response and keeps batches short', () => {
  const body = { events: [{ title: 'A', url: 'u' }], forecast: { analogs: [{ title: 'B', url: '' }] }, panel: { title: 'label' } };
  assert.deepEqual(headlineHolders(body).map((x) => x.title), ['A', 'B']);
  const groups = batches(['中'.repeat(300), '文'.repeat(300), 'x'], 3000);
  assert.deepEqual(groups.map((g) => g.length), [1, 2]);
});

test('adds titleRu to a copy and asks for each headline once', async () => {
  resetTranslationState();
  const stub = stubFetch(answer);
  const body = { events: [{ title: 'Same', url: 'a' }, { title: 'Same', url: 'b' }, { title: 'Уже по-русски', url: 'c' }] };
  try {
    const first = await withTranslations(body);
    assert.deepEqual(first.events.map((e) => e.titleRu), ['RU:Same', 'RU:Same', undefined]);
    assert.equal(first.events[0].title, 'Same');
    assert.equal(body.events[0].titleRu, undefined);
    await withTranslations(body);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('a refused provider falls back, and total failure keeps the original', async () => {
  resetTranslationState();
  let stub = stubFetch((url) => (url.hostname === 'clients5.google.com' ? new Response('', { status: 429 }) : answer(url)));
  try {
    const result = await withTranslations({ events: [{ title: 'One', url: 'a' }] });
    assert.equal(result.events[0].titleRu, 'RU:One');
    await withTranslations({ events: [{ title: 'Two', url: 'b' }] });
    assert.equal(stub.calls.filter((u) => u.hostname === 'clients5.google.com').length, 1, 'cooled down');
  } finally {
    stub.restore();
  }
  resetTranslationState();
  stub = stubFetch(() => new Response('<html>Sorry</html>', { status: 200 }));
  try {
    const result = await withTranslations({ events: [{ title: 'Three', url: 'c' }] });
    assert.equal(result.events[0].titleRu, undefined);
    assert.equal(result.events[0].title, 'Three');
  } finally {
    stub.restore();
  }
});
