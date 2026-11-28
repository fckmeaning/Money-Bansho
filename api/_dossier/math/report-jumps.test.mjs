import test from 'node:test';
import assert from 'node:assert/strict';
import { reportJumps } from './report.js';
import { normalSample, seededRandom } from './stats.js';

const gaussian = (n, seed, sd = 0.015) => {
  const random = seededRandom(seed);
  return Array.from({ length: n }, () => sd * normalSample(random));
};

test('reportJumps: false jumps on Gaussian noise stay near the stated 1% of series', () => {
  let flagged = 0;
  for (let seed = 1; seed <= 300; seed += 1) if (reportJumps(gaussian(500, 900 + seed)).length) flagged += 1;
  assert.ok(flagged / 300 <= 0.03, `${flagged} of 300 series flagged`);
});

test('reportJumps: a 7-sigma move is still found, short series use the short window', () => {
  const long = gaussian(500, 5);
  long[300] = -0.105;
  assert.ok(reportJumps(long).some((j) => j.index === 300));
  const short = gaussian(100, 6);
  short[70] = 0.2;
  assert.ok(reportJumps(short).some((j) => j.index === 70));
});
