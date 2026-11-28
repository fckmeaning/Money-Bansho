import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directionAt, directionRecord, drift } from './direction.js';

const path = (n, step) => {
  const closes = [100];
  for (let i = 1; i < n; i += 1) closes.push(closes[i - 1] * Math.exp(step(i)));
  return closes;
};
const spread = { cdf: (x) => 0.5 + Math.max(-0.5, Math.min(0.5, x * 5)) };

test('a steady rise is called up and a steady fall down', () => {
  const up = path(300, (i) => 0.004 + (i % 2 ? 0.01 : -0.01));
  const down = path(300, (i) => -0.004 + (i % 2 ? 0.01 : -0.01));
  const a = directionAt(up, 20, spread);
  const b = directionAt(down, 20, spread);
  assert.equal(a.side, 'up');
  assert.ok(a.price > up.at(-1) && a.movePct > 0 && a.probUp > 0.5);
  assert.equal(b.side, 'down');
  assert.ok(b.price < down.at(-1) && b.movePct < 0 && b.probUp < 0.5);
});

test('short history gives no direction', () => {
  assert.equal(directionAt(path(60, () => 0.001), 5, spread), null);
});

test('the drift sees no later closes', () => {
  const closes = path(200, (i) => Math.sin(i) / 100);
  const changed = [...closes.slice(0, 121), ...closes.slice(121).map((c) => c * 3)];
  assert.equal(drift(closes, 120, 5), drift(changed, 120, 5));
});

test('the record counts non-overlapping windows against the always-up baseline', () => {
  const record = directionRecord(path(301, () => 0.002), 20);
  assert.deepEqual(record, { n: 12, hit: 1, upShare: 1 });
});
