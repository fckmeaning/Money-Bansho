import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvent } from './analyze.js';
import companies from './companies.js';

const company = (symbol) => companies.find((c) => c.symbol === symbol);
const isChange = (lang, title, symbol) =>
  classifyEvent({ title, lang, company: symbol ? company(symbol) : undefined }).type === 'leadership';

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

// "retire" or "leave" with a thing as its object is not a person leaving a post.
const INANIMATE_OBJECT = [
  'Tim Cook to retire old models',
  'Apple CEO Tim Cook to retire old iPhone models',
  'Apple CEO to retire the iPhone 14 line',
  'Boeing CEO Kelly Ortberg will retire the 747 fleet',
  'Delta CEO to leave the door open to a merger',
  'Intel CEO leaves hospital after surgery',
  'Meta CEO to leave a legacy of smart glasses',
];

const RETIRES_FROM_THE_POST = [
  'Apple CEO to retire at year end',
  'Apple CEO to retire, successor named',
  'Apple CEO to retire in March',
  'Apple CEO Tim Cook to retire January 1',
  'Apple CEO retires abruptly',
  'Apple CEO to retire effective immediately',
  'Starbucks CEO leaves the company',
  'CEO to leave the company after 12 years',
];

test('retire or leave with an inanimate object is not a leadership change', () => {
  for (const title of INANIMATE_OBJECT) assert.equal(isChange('en', title), false, title);
});

test('retire or leave from the post still is one', () => {
  for (const title of RETIRES_FROM_THE_POST) assert.equal(isChange('en', title), true, title);
});

test('the boss of a rival or an unnamed other firm is not this company\'s change', () => {
  for (const title of [
    'CEO of rival firm resigns',
    "Competitor's CEO steps down",
    'CEO of a competitor resigns, Toyota shares rise',
    'Former Intel CEO Pat Gelsinger resigns from the board of Acme',
  ]) {
    assert.equal(isChange('en', title), false, title);
  }
  // A former holder only counts as the predecessor of a new one.
  assert.equal(isChange('en', 'Apple names Ternus to succeed former CEO Tim Cook'), true);
});

test('with the company known, only its own boss counts', () => {
  const foreign = [
    ['7203.T', 'Mazda CEO resigns, Toyota shares rise'],
    ['7203.T', "Mazda's CEO resignation rattles Toyota"],
    ['7203.T', 'Toyota rival Mazda names new CEO'],
    ['7203.T', 'Mazda names new CEO, Toyota shares rise'],
    ['INTC', 'Mazda names Hiroshi Tanaka CEO, Intel shares rise'],
    ['BAC', 'Citigroup CEO Jane Fraser to step down, Bank of America shares rise'],
    ['AAPL', 'Samsung CEO to step down, Apple supplier says'],
    ['INTC', 'Boeing Chief Executive Dave Calhoun To Step Down; Intel Rises'],
  ];
  const own = [
    ['7203.T', 'Toyota CEO resigns'],
    ['7203.T', 'Toyota Motor chairman Akio Toyoda steps down'],
    ['7203.T', 'Akio Toyoda to step down as CEO of Toyota'],
    ['7203.T', 'Toyota names new CEO'],
    ['BAC', 'Bank of America CEO Brian Moynihan to retire'],
    ['INTC', 'Intel names Lip-Bu Tan CEO'],
    ['DIS', "Disney names Josh D'Amaro CEO"],
    ['AAPL', 'Apple Names John Ternus As New CEO'],
    ['AAPL', 'Exclusive: Apple CEO steps down'],
    ['AAPL', "Apple's new CEO takes over"],
    ['BA', 'Boeing Chief Executive Dave Calhoun To Step Down Amid Safety Crisis'],
    ['TEVA.TA', 'Teva Pharmaceutical Industries CEO Richard Francis to step down'],
    ['META', 'Facebook CEO Mark Zuckerberg steps down as Meta chief'],
    ['XOM', 'Exxon Mobil CEO Darren Woods to retire'],
  ];
  for (const [symbol, title] of foreign) assert.equal(isChange('en', title, symbol), false, `${symbol}: ${title}`);
  for (const [symbol, title] of own) assert.equal(isChange('en', title, symbol), true, `${symbol}: ${title}`);
});
