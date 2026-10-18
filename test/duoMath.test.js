import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDuo, splitCommonMatches, MIN_GAMES } from '../src/services/duoMath.js';

const p = (puuid, teamId, win, over = {}) => ({ puuid, teamId, win, championName: 'Ahri', teamPosition: 'MIDDLE', kills: 5, deaths: 2, assists: 7, ...over });
let n = 0;
const match = (parts) => ({ matchId: `JP1_${++n}`, gameCreation: 1700000000000 + n * 1000, participants: parts });

test('splitCommonMatches: 同じチームはデュオ、別チームは対戦、片方しかいない試合は除外', () => {
  const ms = [
    match([p('A', 100, true), p('B', 100, true)]),
    match([p('A', 100, true), p('B', 200, false)]),
    match([p('A', 100, true), p('C', 100, true)])
  ];
  const r = splitCommonMatches(ms, 'A', 'B');
  assert.equal(r.duo.length, 1);
  assert.equal(r.versus.length, 1);
  assert.equal(splitCommonMatches(ms, 'A', 'A').duo.length, 0, '同一人物は比較しない');
  assert.deepEqual(splitCommonMatches(null, 'A', 'B'), { duo: [], versus: [] });
});

test('analyzeDuo: デュオ勝率・対戦成績・ロール組み合わせ・チャンピオンの組み合わせ', () => {
  const ms = [];
  for (let i = 0; i < 6; i++) {
    ms.push(match([
      p('A', 100, i < 4, { championName: 'Jinx', teamPosition: 'BOTTOM' }),
      p('B', 100, i < 4, { championName: 'Lux', teamPosition: 'UTILITY' })
    ]));
  }
  ms.push(match([p('A', 100, true), p('B', 200, false)])); // 対戦: A の勝ち
  ms.push(match([p('A', 100, false), p('B', 200, true)])); // 対戦: A の負け
  ms.push(match([p('A', 100, true), p('B', 200, false)]));

  const r = analyzeDuo(ms, 'A', 'B');
  assert.equal(r.totalCommon, 9);
  assert.equal(r.duo.games, 6);
  assert.equal(r.duo.wins, 4);
  assert.equal(r.duo.winRate, 67);
  assert.equal(r.verdict.level, 'good');
  assert.equal(r.versus.games, 3);
  assert.equal(r.versus.wins, 2);
  assert.equal(r.versus.b.wins, 1, 'B から見た対戦成績は A の逆');
  assert.deepEqual(r.duo.roles[0], { roleA: 'BOTTOM', roleB: 'UTILITY', games: 6, wins: 4, losses: 2, winRate: 67 });
  assert.equal(r.duo.pairs[0].champA, 'Jinx');
  assert.equal(r.duo.pairs[0].champB, 'Lux');
  assert.equal(r.duo.a.kda, '6.00');
  assert.equal(r.recent.length, 6);
  assert.ok(r.recent[0].gameCreation >= r.recent[1].gameCreation, '新しい順');
});

test('analyzeDuo: 共通の試合が少ないときは判定しない・低勝率は bad・空でも落ちない', () => {
  const few = analyzeDuo([match([p('A', 100, true), p('B', 100, true)])], 'A', 'B');
  assert.equal(few.verdict.level, 'insufficient');
  assert.ok(MIN_GAMES > 1);

  const bad = [];
  for (let i = 0; i < 6; i++) bad.push(match([p('A', 100, i < 2), p('B', 100, i < 2)]));
  assert.equal(analyzeDuo(bad, 'A', 'B').verdict.level, 'bad');

  const empty = analyzeDuo([], 'A', 'B');
  assert.equal(empty.totalCommon, 0);
  assert.equal(empty.duo.winRate, 0);
  assert.equal(empty.duo.a.kda, 'Perfect');
});
