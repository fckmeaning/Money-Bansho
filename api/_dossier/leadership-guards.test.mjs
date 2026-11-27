import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvent } from './analyze.js';

const isChange = (lang, title) => classifyEvent({ title, lang }).type === 'leadership';

// Headlines that name a role next to a word of change, but report none.
const NOT_CHANGES = [
  ['en', 'Tesla CEO Elon Musk fired back at critics on X'],
  ['en', 'Tesla CEO Elon Musk firing back at the SEC'],
  ['en', 'Apple CEO Tim Cook to leave for China trip next week'],
  ['en', 'Nvidia CEO to depart for Taipei on Monday'],
  ['en', 'Microsoft CEO Satya Nadella named to Time 100 list'],
  ['en', 'Amazon CEO Andy Jassy named CEO of the Year by Fortune'],
  ['en', 'Will Apple CEO Tim Cook step down next year?'],
  ['en', 'Is Intel CEO Lip-Bu Tan stepping down? Here is what we know'],
  ['de', 'Siemens-Chef Busch sieht keinen Rücktritt'],
  ['de', 'Allianz-Chef Bäte: keine Rücktrittspläne'],
];

// The guards must not swallow real changes.
const CHANGES = [
  ['en', 'Apple CEO Tim Cook to leave at the end of the year'],
  ['en', 'Nokia CEO to depart after nine years'],
  ['en', 'Tesla CEO fired by the board'],
  ['en', 'Why did Nvidia CFO resign?'],
  ['en', 'Disney names Josh Dmaro as next CEO'],
  ['de', 'SAP-Chef Christian Klein tritt zurück'],
];

test('role plus an idiom or a question is not a leadership change', () => {
  for (const [lang, title] of NOT_CHANGES) {
    assert.equal(isChange(lang, title), false, title);
  }
});

test('real leadership changes are still detected next to the guards', () => {
  for (const [lang, title] of CHANGES) {
    assert.equal(isChange(lang, title), true, title);
  }
});
