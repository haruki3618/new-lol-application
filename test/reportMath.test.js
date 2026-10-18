import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, lpChange } from '../src/services/reportMath.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
let n = 0;
const game = (daysAgo, win, over = {}) => ({
  matchId: `M${++n}`, gameCreation: NOW - daysAgo * DAY, gameDuration: 1800,
  participants: [{ puuid: 'me', win, championName: 'Ahri', kills: 6, deaths: 3, assists: 9, totalMinionsKilled: 180, neutralMinionsKilled: 0, visionScore: 30, ...over }]
});

test('buildReport: 期間内だけを数え、直前の同じ長さの期間と比較する', () => {
  const ms = [
    game(1, true), game(2, true), game(3, false), game(6.5, true), // 今週 4戦3勝
    game(8, false), game(10, false), game(12, true), // 先週 3戦1勝
    game(30, true) // 範囲外
  ];
  const r = buildReport(ms, 'me', { now: NOW, period: 'week' });
  assert.equal(r.current.games, 4);
  assert.equal(r.current.wins, 3);
  assert.equal(r.current.winRate, 75);
  assert.equal(r.previous.games, 3);
  assert.equal(r.previous.winRate, 33);
  assert.equal(r.delta.winRate, 42);
  assert.equal(r.current.csPerMin, 6);
  assert.equal(r.current.kda, '5.00');
  assert.equal(r.daily.length, 7);
  assert.equal(r.daily.reduce((s, d) => s + d.games, 0), 4);
});

test('buildReport: 月間は30日、他人の試合・参加していない試合は無視、空でも落ちない', () => {
  const other = { matchId: 'X', gameCreation: NOW - DAY, gameDuration: 1800, participants: [{ puuid: 'other', win: true, championName: 'Lux' }] };
  const r = buildReport([game(20, true), other], 'me', { now: NOW, period: 'month' });
  assert.equal(r.days, 30);
  assert.equal(r.current.games, 1);
  const e = buildReport([], 'me', { now: NOW, period: 'bogus' });
  assert.equal(e.period, 'week', '不明な期間は週間にする');
  assert.equal(e.current.games, 0);
  assert.equal(e.delta, null);
  assert.equal(e.best, null);
});

test('buildReport: 得意・不得意は3戦以上のチャンピオンだけ。デス0は Perfect', () => {
  const ms = [
    ...[true, true, true].map((w, i) => game(1 + i * 0.1, w, { championName: 'Ahri' })),
    ...[false, false, true].map((w, i) => game(2 + i * 0.1, w, { championName: 'Zed' })),
    game(3, true, { championName: 'Lux', deaths: 0 })
  ];
  const r = buildReport(ms, 'me', { now: NOW });
  assert.equal(r.best.championName, 'Ahri');
  assert.equal(r.worst.championName, 'Zed');
  assert.equal(r.champions.find((c) => c.championName === 'Lux').kda, 'Perfect');

  const single = buildReport([game(1, true), game(1.1, true), game(1.2, true)], 'me', { now: NOW });
  assert.equal(single.worst, null, '1種類だけなら不得意は出さない');
});

test('lpChange: 期間内の最初と最後の差。記録が2件未満なら null', () => {
  const snaps = [{ at: NOW - 10 * DAY, value: 1000 }, { at: NOW - 5 * DAY, value: 1100 }, { at: NOW - 1 * DAY, value: 1060 }];
  assert.deepEqual(lpChange(snaps, NOW - 7 * DAY, NOW + 1), { start: 1100, end: 1060, diff: -40, points: 2 });
  assert.equal(lpChange(snaps, NOW - 2 * DAY, NOW + 1), null);
  assert.equal(lpChange(null, 0, 1), null);
});
