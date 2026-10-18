import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWatch, rankValue, formatMessage, isDiscordWebhook, LOSS_STREAK_ALERT } from '../src/services/watchMath.js';

const entry = (o = {}) => ({ tier: 'GOLD', rank: 'II', leaguePoints: 50, wins: 10, losses: 10, ...o });
const prev = (o = {}) => ({ initialized: true, lastTier: 'GOLD', lastRank: 'II', lastLp: 50, lastWins: 10, lastLosses: 10, consecutiveLosses: 0, ...o });

test('rankValue: ティア・ディビジョンの順序（IV < I、GOLD < PLATINUM、不明は -1）', () => {
  assert.ok(rankValue('GOLD', 'I') > rankValue('GOLD', 'IV'));
  assert.ok(rankValue('PLATINUM', 'IV') > rankValue('GOLD', 'I'));
  assert.ok(rankValue('MASTER', 'I') > rankValue('DIAMOND', 'I'));
  assert.equal(rankValue('NONE', ''), -1);
});

test('evaluateWatch: 初回は基準を記録するだけで通知しない', () => {
  const r = evaluateWatch({ initialized: false, consecutiveLosses: 5 }, entry());
  assert.deepEqual(r.events, []);
  assert.equal(r.next.initialized, true);
  assert.equal(r.next.consecutiveLosses, 0);
  assert.equal(r.next.lastLp, 50);
});

test('evaluateWatch: 変化なしなら通知なし・ランク情報なしなら状態を保つ', () => {
  assert.deepEqual(evaluateWatch(prev(), entry()).events, []);
  const none = evaluateWatch(prev({ consecutiveLosses: 2 }), null);
  assert.deepEqual(none.events, []);
  assert.equal(none.next.consecutiveLosses, 2);
});

test('evaluateWatch: 連敗は閾値に達した回だけ通知（その後は繰り返さない）、勝てばリセット', () => {
  let state = prev();
  const fired = [];
  for (let i = 1; i <= LOSS_STREAK_ALERT + 2; i++) {
    const r = evaluateWatch(state, entry({ losses: 10 + i, leaguePoints: 50 }));
    fired.push(r.events.filter((e) => e.type === 'LOSS_STREAK').length);
    state = r.next;
  }
  assert.deepEqual(fired, [0, 0, 1, 0, 0]);
  assert.equal(state.consecutiveLosses, LOSS_STREAK_ALERT + 2);

  const won = evaluateWatch(state, entry({ losses: state.lastLosses, wins: 11 }));
  assert.equal(won.next.consecutiveLosses, 0);
});

test('evaluateWatch: 巻き込み取得（1回で3敗増）でも連敗通知、勝ちが混じる増分は保守的にリセット', () => {
  const r = evaluateWatch(prev(), entry({ losses: 13 }));
  assert.equal(r.events[0].type, 'LOSS_STREAK');
  assert.equal(r.events[0].streak, 3);
  const mixed = evaluateWatch(prev({ consecutiveLosses: 2 }), entry({ wins: 11, losses: 12 }));
  assert.equal(mixed.next.consecutiveLosses, 0);
  assert.equal(mixed.events.length, 0);
});

test('evaluateWatch: 昇格・降格・LP の大きな変動', () => {
  assert.equal(evaluateWatch(prev(), entry({ rank: 'I', wins: 11 })).events[0].type, 'PROMOTED');
  assert.equal(evaluateWatch(prev(), entry({ tier: 'SILVER', rank: 'I', losses: 11 })).events[0].type, 'DEMOTED');
  const swing = evaluateWatch(prev(), entry({ leaguePoints: 85, wins: 12 }));
  assert.equal(swing.events[0].type, 'LP_SWING');
  assert.equal(swing.events[0].diff, 35);
  assert.equal(evaluateWatch(prev(), entry({ leaguePoints: 60, wins: 11 })).events.length, 0, '小さな変動は通知しない');
});

test('evaluateWatch: 戦績が巻き戻ったとき（シーズン切替）は差分を見ず連敗を初期化', () => {
  const r = evaluateWatch(prev({ consecutiveLosses: 2 }), entry({ wins: 0, losses: 0, tier: 'SILVER', rank: 'IV', leaguePoints: 0 }));
  assert.deepEqual(r.events, []);
  assert.equal(r.next.consecutiveLosses, 0);
});

test('formatMessage / isDiscordWebhook', () => {
  const msg = formatMessage('a#JP1', [{ text: 'テスト' }], entry());
  assert.match(msg, /a#JP1/);
  assert.match(msg, /GOLD II 50LP/);
  assert.equal(isDiscordWebhook('https://discord.com/api/webhooks/123456/abc_DEF-1'), true);
  assert.equal(isDiscordWebhook('http://discord.com/api/webhooks/123456/abc'), false);
  assert.equal(isDiscordWebhook('https://evil.example.com/api/webhooks/123456/abc'), false);
  assert.equal(isDiscordWebhook('https://discord.com.evil.com/api/webhooks/1/a'), false);
  assert.equal(isDiscordWebhook('http://169.254.169.254/'), false);
  assert.equal(isDiscordWebhook(''), false);
});
