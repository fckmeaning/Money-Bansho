import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvent, dedupeEvents, priceReaction, reputationScore } from './analyze.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** [lang, title, expected people] */
const LEADERSHIP = [
  ['en', 'Apple names John Ternus as new CEO', ['John Ternus']],
  ['en', 'Apple CEO Tim Cook to step down', ['Tim Cook']],
  ['en', "Apple's Tim Cook to step down as chief executive", ['Tim Cook']],
  ['en', 'Boeing Chief Executive Dave Calhoun To Step Down Amid Safety Crisis', ['Dave Calhoun']],
  ['en', 'Intel CEO Pat Gelsinger ousted by board', ['Pat Gelsinger']],
  ['en', 'Nissan Chairman Carlos Ghosn arrested in Tokyo', ['Carlos Ghosn']],
  ['en', 'Jane Fraser appointed chief executive of Citigroup', ['Jane Fraser']],
  ['en', 'Acme fires CEO over misconduct', []],
  ['en', 'Chipmaker CFO abruptly resigns', []],
  ['en', 'Founder of crypto exchange arrested', []],
  ['en', 'Goldman Sachs names new chief financial officer', []],
  ['en', "CEO's sudden resignation rattles investors", []],
  ['en', 'Bumble Founder Whitney Wolfe Herd Returns As CEO', ['Whitney Wolfe Herd']],
  ['zh', '阿里巴巴CEO张勇卸任，吴泳铭接任', ['张勇', '吴泳铭']],
  ['zh', '恒大董事长许家印被带走', ['许家印']],
  ['zh', '公司董事长辞职', []],
  ['zh', '騰訊任命王明為首席財務官', ['王明']],
  ['he', 'מנכ"ל טבע התפטר מתפקידו', []],
  ['he', 'בנק לאומי: חנן פרידמן פורש מתפקיד המנכ״ל', ['חנן פרידמן']],
  ['he', 'טבע מינתה את יוסי כהן למנכ"ל', ['יוסי כהן']],
  ['de', 'SAP-Chef Christian Klein tritt zurück', ['Christian Klein']],
  ['de', 'Oliver Blume wird neuer Vorstandschef bei Volkswagen', ['Oliver Blume']],
  ['de', 'Wirecard-Chef Markus Braun festgenommen', ['Markus Braun']],
  ['fr', 'Le PDG de Danone Emmanuel Faber quitte ses fonctions', []],
  ['fr', 'Renault : le patron Luca de Meo démissionne', ['Luca de Meo']],
  ['ko', '삼성전자 이재용 회장 구속', ['이재용']],
  ['ko', '카카오 신임 대표에 정신아 내정', ['정신아']],
  ['ko', '네이버 대표이사 사임', []],
];

test('detects leadership changes in six languages and extracts names conservatively', () => {
  for (const [lang, title, people] of LEADERSHIP) {
    const result = classifyEvent({ title, lang });
    assert.equal(result.type, 'leadership', title);
    assert.deepEqual(result.people, people, title);
  }
});

test('does not report a leadership change without one', () => {
  const titles = [
    ['en', 'Apple CEO Tim Cook says iPhone demand is strong'],
    ['en', 'Tesla CEO denies he will step down'],
    ['en', 'Investors call for Boeing CEO to resign'],
    ['en', 'Company fired 500 workers, CEO says'],
    ['en', 'IKEA recalls chair over safety risk'],
    ['en', 'Police chief arrested after protest'],
    ['en', 'Airline chief says it will retire older jets'],
    ['en', 'Amazon hires 1000 seasonal staff'],
    ['en', "Acme CEO's plan to retire old plants"],
    ['en', 'Nvidia chief technology officer unveils chip'],
    ['en', 'Apple removes apps in China after CEO visit'],
    ['en', 'Apple names new campus in honor of founder'],
    ['en', 'Meta hires Apple AI chief'],
    ['fr', 'Le président Macron quitte le sommet'],
    ['ko', '롯데 신동빈 회장 해임안 부결'],
    ['zh', '阿里巴巴CEO张勇否认辞职'],
    ['zh', '董事长称公司业绩增长'],
    ['he', 'מנכ"ל טבע: לא אתפטר, הדוחות טובים'],
    ['de', 'SAP-Chef sieht starkes Wachstum'],
    ['fr', 'Le PDG de Renault dévoile un nouveau modèle'],
    ['ko', '삼성전자 회장 "반도체 투자 확대"'],
    ['ko', '네이버 대표 사임설 사실무근'],
  ];
  for (const [lang, title] of titles) {
    const result = classifyEvent({ title, lang });
    assert.notEqual(result.type, 'leadership', title);
    assert.deepEqual(result.people, [], title);
  }
});

test('assigns the other event types', () => {
  const cases = [
    ['en', 'Bank hit by massive accounting fraud scandal', 'scandal'],
    ['en', 'EU antitrust regulators fine Google', 'regulation'],
    ['en', 'Microsoft quarterly revenue beats estimates', 'earnings'],
    ['en', 'Pfizer to acquire biotech in $10 billion deal', 'deal'],
    ['en', 'New tariffs threaten chip exports', 'politics'],
    ['en', 'Sony unveils new headset', 'product'],
    ['en', 'A walk around the campus', 'other'],
    ['zh', '公司发布第三季度财报', 'earnings'],
    ['he', 'טבע: קנס ענק מרשות התחרות', 'regulation'],
    ['de', 'Siemens übernimmt Softwarefirma', 'deal'],
    ['fr', 'Airbus : résultats trimestriels en hausse', 'earnings'],
    ['ko', '현대차 신차 출시', 'product'],
  ];
  for (const [lang, title, type] of cases) assert.equal(classifyEvent({ title, lang }).type, type, title);
});

test('scores sentiment with negation handling', () => {
  const s = (title, lang) => classifyEvent({ title, lang }).sentiment;
  assert.ok(s('Shares surge to record high', 'en') > 0.5);
  assert.ok(s('Shares plunge amid fraud scandal', 'en') < -0.5);
  assert.ok(s('Audit finds no fraud', 'en') > 0);
  assert.ok(s("Results don't disappoint as profit does not fall", 'en') >= 0);
  assert.ok(s('股价暴跌', 'zh') < 0);
  assert.ok(s('公司不存在造假', 'zh') > 0);
  assert.ok(s('המניה מזנקת לשיא', 'iw') > 0);
  assert.ok(s('Aktie stürzt ab nach Bilanzskandal', 'de') < 0);
  assert.ok(s('Kein Betrug bei Konzern', 'de') > 0);
  assert.ok(s("L'action chute après un scandale", 'fr') < 0);
  assert.ok(s('주가 급등', 'ko') > 0);
  assert.ok(s('횡령 의혹 사실무근, 횡령 없었다', 'ko') > 0);
  assert.equal(s('Company holds annual meeting', 'en'), 0);
  assert.deepEqual(classifyEvent({ title: '', lang: 'en' }), { type: 'other', sentiment: 0, people: [] });
});

test('removes near duplicates and keeps the earliest report', () => {
  const t = Date.UTC(2026, 10, 20, 12);
  const events = [
    { id: 'b', time: t + HOUR, title: 'Intel CEO Pat Gelsinger ousted by board - CNBC', source: 'CNBC', url: 'u2' },
    { id: 'a', time: t, title: 'Intel CEO Pat Gelsinger ousted by board - Reuters', source: 'Reuters', url: 'u1' },
    { id: 'c', time: t, title: 'Intel shares rise after quarterly results', url: 'u3', sentiment: 0.3 },
    { id: 'd', time: t, title: 'Intel shares fall after quarterly results', url: 'u4', sentiment: -0.3 },
    { id: 'e', time: t + 10 * DAY, title: 'Intel CEO Pat Gelsinger ousted by board', url: 'u5' },
    { id: 'f', time: t, title: '阿里巴巴宣布张勇卸任首席执行官', url: 'u6' },
    { id: 'g', time: t + HOUR, title: '阿里巴巴宣布张勇卸任首席执行官_新浪财经', url: 'u7' },
    { id: 'h', time: t, title: 'Acme Q1 profit rises 5% on cloud demand', url: 'u8' },
    { id: 'i', time: t, title: 'Acme Q2 profit rises 9% on cloud demand', url: 'u9' },
  ];
  assert.deepEqual(dedupeEvents(events).map((e) => e.id), ['a', 'c', 'd', 'e', 'f', 'h', 'i']);
  assert.deepEqual(dedupeEvents([]), []);
});

// US-style daily bars stamped at the 14:30 UTC open; Mon 2026-11-16 onwards.
const bar = (day, c, hour = 14.5) => ({ t: Date.UTC(2026, 10, day) + hour * HOUR, c });
const at = (day, hour) => Date.UTC(2026, 10, day) + hour * HOUR;
const HISTORY = [bar(16, 100), bar(17, 110), bar(18, 99), bar(19, 99)];
const BENCH = [bar(16, 1000), bar(17, 1020), bar(18, 1020), bar(19, 1020)];
const NOW = at(25, 0);

test('price reaction uses the close before and the first close after the event', () => {
  // intraday on the 17th: close 16 -> close 17
  assert.deepEqual(priceReaction(HISTORY, BENCH, at(17, 16), NOW), { priceMovePct: 10, abnormalMovePct: 8 });
  // before the open on the 17th: same window
  assert.equal(priceReaction(HISTORY, BENCH, at(17, 8), NOW).priceMovePct, 10);
  // after the close on the 17th: close 17 -> close 18
  assert.deepEqual(priceReaction(HISTORY, BENCH, at(17, 22), NOW), { priceMovePct: -10, abnormalMovePct: -10 });
});

test('price reaction returns null when not yet known', () => {
  const none = { priceMovePct: null, abnormalMovePct: null };
  assert.deepEqual(priceReaction(HISTORY, BENCH, at(19, 22), NOW), none); // no later bar
  assert.deepEqual(priceReaction(HISTORY, BENCH, at(10, 12), NOW), none); // older than history
  assert.deepEqual(priceReaction(HISTORY, BENCH, at(19, 15), at(19, 17)), none); // session running
  // running bar stamped with the last trade time instead of the open
  const live = [...HISTORY.slice(0, 3), bar(19, 105, 18)];
  assert.deepEqual(priceReaction(live, BENCH, at(19, 15), at(19, 18.1)), none);
  assert.equal(priceReaction(live, BENCH, at(19, 15), at(19, 22)).priceMovePct, 6.06);
  assert.deepEqual(priceReaction([], [], at(17, 12), NOW), none);
});

test('abnormal move is null without a matching benchmark', () => {
  assert.deepEqual(priceReaction(HISTORY, [], at(17, 16), NOW), { priceMovePct: 10, abnormalMovePct: null });
  assert.equal(priceReaction(HISTORY, BENCH.slice(0, 1), at(17, 16), NOW).abnormalMovePct, null);
});

test('reputation score is neutral without data', () => {
  assert.deepEqual(reputationScore([], NOW), { score: 50, trend: 0, label: 'No data', drivers: [], sample: 0 });
});

test('reputation score is recency and type weighted with explainable drivers', () => {
  const ev = (id, daysAgo, type, sentiment) => ({ id, time: NOW - daysAgo * DAY, type, sentiment });
  const events = [ev('scandal', 1, 'scandal', -0.8), ev('product', 1, 'product', 0.8), ev('old', 30, 'earnings', 0.5), ev('future', -2, 'scandal', -1), ev('ancient', 200, 'scandal', -1)];
  const result = reputationScore(events, NOW);
  assert.equal(result.sample, 3);
  assert.ok(result.score < 50);
  assert.ok(result.trend < 0);
  assert.equal(result.drivers[0].eventId, 'scandal');
  const total = result.drivers.reduce((sum, d) => sum + d.impact, 50);
  assert.ok(Math.abs(total - result.score) <= 0.6);
  const fresh = reputationScore([ev('x', 0, 'scandal', -1)], NOW).score;
  const stale = reputationScore([ev('x', 40, 'scandal', -1)], NOW).score;
  assert.ok(fresh < stale);
  const many = Array.from({ length: 40 }, (_, i) => ev(`n${i}`, 0, 'scandal', -1));
  const worst = reputationScore(many, NOW);
  assert.ok(worst.score >= 0 && worst.score < 10);
  assert.equal(worst.label, 'Negative');
  assert.equal(worst.drivers.length, 5);
});
