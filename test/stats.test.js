import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../src/services/analytics.js';
import { scoreParticipants, summarizeRecent } from '../src/services/summarize.js';
import { parseRiotId } from '../src/utils/riotId.js';
import { patchOf, comparePatchDesc } from '../src/utils/patch.js';

const me = 'puuid-me';
const p = (over) => ({ puuid: 'x', teamId: 100, kills: 0, deaths: 0, assists: 0, win: true, championName: 'Ahri', teamPosition: 'MIDDLE', ...over });
const match = (id, version, mine, others = []) => ({ matchId: id, gameVersion: version, participants: [p({ puuid: me, ...mine }), ...others] });

test('computeStats: チャンピオン・ロール・パッチ別に集計する', () => {
  const matches = [
    match('1', '15.3.1', { kills: 10, deaths: 2, assists: 8, win: true }),
    match('2', '15.3.2', { kills: 2, deaths: 4, assists: 2, win: false }),
    match('3', '15.2.9', { kills: 5, deaths: 0, assists: 5, win: true, championName: 'Zed', teamPosition: 'JUNGLE' })
  ];
  const s = computeStats(matches, me);
  assert.equal(s.totalGames, 3);
  assert.equal(s.totalWins, 2);
  assert.equal(s.totalWinRate, 67);
  const ahri = s.champions.find((c) => c.championName === 'Ahri');
  assert.equal(ahri.games, 2);
  assert.equal(ahri.winRate, 50);
  assert.equal(ahri.kda, '3.67'); // (キル 12 + アシスト 10) / デス 6
  assert.equal(s.champions.find((c) => c.championName === 'Zed').kda, 'Perfect');
  assert.equal(s.roles.length, 2);
  assert.deepEqual(s.patches.map((x) => x.patch), ['15.3', '15.2'], '新しいパッチが先頭');
});

test('computeStats: 自分が参加していない試合は無視し、ロールなしはロール集計から除く', () => {
  const noMe = { matchId: '9', gameVersion: '15.3.1', participants: [p({ puuid: 'other' })] };
  const aram = match('8', '15.3.1', { teamPosition: '' });
  const s = computeStats([noMe, aram], me);
  assert.equal(s.totalGames, 1);
  assert.equal(s.roles.length, 0);
});

test('computeStats: 2試合以上同じチームだった人だけ「一緒にプレイした人」に出る', () => {
  const mate = (name) => p({ puuid: 'mate', riotIdGameName: name, riotIdTagline: 'JP1' });
  const matches = [
    match('1', '15.3.1', {}, [mate('Friend')]),
    match('2', '15.3.1', {}, [mate('Friend')]),
    match('3', '15.3.1', {}, [p({ puuid: 'once', riotIdGameName: 'Once', riotIdTagline: 'JP1' })])
  ];
  const s = computeStats(matches, me);
  assert.equal(s.teammates.length, 1);
  assert.equal(s.teammates[0].name, 'Friend#JP1');
  assert.equal(s.teammates[0].games, 2);
});

test('scoreParticipants: 勝利側トップが MVP、敗北側トップが ACE', () => {
  const players = [
    p({ teamId: 100, win: true, kills: 12, deaths: 1, assists: 10, totalDamageDealtToChampions: 30000, goldEarned: 15000, visionScore: 30 }),
    p({ teamId: 100, win: true, kills: 2, deaths: 5, assists: 6, totalDamageDealtToChampions: 12000, goldEarned: 9000, visionScore: 20 }),
    p({ teamId: 200, win: false, kills: 6, deaths: 6, assists: 4, totalDamageDealtToChampions: 22000, goldEarned: 12000, visionScore: 15 }),
    p({ teamId: 200, win: false, kills: 1, deaths: 9, assists: 2, totalDamageDealtToChampions: 8000, goldEarned: 8000, visionScore: 40 })
  ];
  const r = scoreParticipants(players);
  assert.equal(r[0].label, 'MVP');
  assert.equal(r[2].label, 'ACE');
  assert.equal(r[0].rank, 1);
  for (const x of r) assert.ok(x.score >= 0 && x.score <= 10);
});

test('scoreParticipants: 数字が欠けていても落ちない', () => {
  const r = scoreParticipants([{ teamId: 100, win: true }, { teamId: 200, win: false }]);
  assert.equal(r.length, 2);
  assert.ok(r.every((x) => Number.isFinite(x.score)));
});

test('summarizeRecent: 0件でも 0 で返す', () => {
  assert.equal(summarizeRecent([]).games, 0);
  const r = summarizeRecent([{ win: true, kills: 4, deaths: 2, assists: 6, score: 7 }, { win: false, kills: 2, deaths: 2, assists: 2, score: 5 }]);
  assert.equal(r.winRate, 50);
  assert.equal(r.kda, '3.50');
});

test('parseRiotId / patchOf', () => {
  assert.deepEqual(parseRiotId('名前#JP1'), { gameName: '名前', tagLine: 'JP1' });
  assert.deepEqual(parseRiotId('a#b#JP1'), { gameName: 'a#b', tagLine: 'JP1' });
  assert.equal(parseRiotId('名前'), null);
  assert.equal(parseRiotId('#JP1'), null);
  assert.equal(patchOf('15.3.123.4567'), '15.3');
  assert.ok(comparePatchDesc('15.10', '15.9') < 0);
});
