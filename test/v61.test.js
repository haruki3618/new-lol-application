import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePlayer, forecast, LIVE_DEFAULTS } from '../src/services/liveMath.js';

const G = (win, champ = 'Ahri', queueId = 420, extra = {}) => ({ t: 0, dur: 1800, queueId, win, champ, k: 5, d: 2, a: 7, ...extra });
const many = (wins, losses, champ = 'Ahri', queueId = 420) => [
  ...Array.from({ length: wins }, () => G(true, champ, queueId)),
  ...Array.from({ length: losses }, () => G(false, champ, queueId))
];

test('summarizePlayer: 10 試合未満は「データ不足」で strength を作らない', () => {
  const s = summarizePlayer(many(5, 3), 'Ahri', 420);
  assert.equal(s.enough, false);
  assert.equal(s.strength, null);
  assert.equal(s.overall.n, 8);
});

test('summarizePlayer: チャンピオン別の試合数・勝率・少ない注記（大文字小文字は区別しない）', () => {
  const games = [...many(3, 1, 'Ahri'), ...many(6, 6, 'Zed')];
  const s = summarizePlayer(games, 'ahri', 420);
  assert.equal(s.champion.n, 4);
  assert.equal(s.champion.rate, 75);
  assert.equal(s.champion.few, true);
  assert.equal(s.overall.n, 16);
  assert.equal(s.enough, true);
});

test('summarizePlayer: 同じキューが10試合未満なら全キューを基準にする', () => {
  const games = [...many(4, 0, 'Ahri', 450), ...many(6, 3, 'Ahri', 420)];
  const s = summarizePlayer(games, 'Ahri', 420);
  assert.equal(s.overall.scope, 'all');
  assert.equal(s.overall.n, 13);
  const s2 = summarizePlayer([...games, ...many(2, 0, 'Ahri', 420)], 'Ahri', 420);
  assert.equal(s2.overall.scope, 'queue');
  assert.equal(s2.overall.n, 11);
});

test('summarizePlayer: リメイク（5分未満）は除外、直近は新しい順に最大10試合', () => {
  const games = [G(true, 'Ahri', 420, { dur: 120 }), ...many(12, 0)];
  const s = summarizePlayer(games, 'Ahri', 420);
  assert.equal(s.overall.n, 12);
  assert.equal(s.recent.n, LIVE_DEFAULTS.recentN);
  assert.equal(s.recent.kda.ratio, 6);
});

test('縮小推定: 少ない試合数の100%勝率は、そのまま使わず引き寄せる', () => {
  const s = summarizePlayer([...many(2, 0, 'Ahri'), ...many(10, 10, 'Zed')], 'Ahri', 420);
  assert.ok(s.champion.rate === 100);
  assert.ok(s.strength.pChamp < 0.65, `2戦2勝でも ${s.strength.pChamp} に収まる`);
  assert.ok(s.strength.pChamp > 0.5);
});

const team = (teamId, summaries) => ({ teamId, players: summaries.map((summary) => ({ summary })) });
const strong = () => summarizePlayer([...many(18, 2, 'Ahri')], 'Ahri', 420);
const weak = () => summarizePlayer([...many(2, 18, 'Ahri')], 'Ahri', 420);
const none = () => summarizePlayer([], 'Ahri', 420);

test('forecast: データのある人が6人未満なら予想しない', () => {
  const f = forecast([team(100, [strong(), strong(), none(), none(), none()]), team(200, [weak(), weak(), none(), none(), none()])]);
  assert.equal(f.available, false);
  assert.match(f.reason, /4 \/ 10/);
});

test('forecast: 強いチーム側が優勢で、上下限を超えない・合計100', () => {
  const f = forecast([team(100, Array(5).fill(0).map(strong)), team(200, Array(5).fill(0).map(weak))]);
  assert.equal(f.available, true);
  assert.ok(f.probs[100] > f.probs[200]);
  assert.equal(f.probs[100] + f.probs[200], 100);
  assert.ok(f.probs[100] <= 70 && f.probs[200] >= 30);
  assert.equal(f.leaderTeamId, 100);
});

test('forecast: 同じ成績なら互角（leaderTeamId なし）', () => {
  const f = forecast([team(100, Array(5).fill(0).map(strong)), team(200, Array(5).fill(0).map(strong))]);
  assert.equal(f.probs[100], 50);
  assert.equal(f.label, 'ほぼ互角');
  assert.equal(f.leaderTeamId, null);
});

test('forecast: チームが2つでなければ予想しない', () => {
  assert.equal(forecast([team(100, [strong()])]).available, false);
});
