import test from 'node:test';
import assert from 'node:assert/strict';
import { runWatchCycle } from '../src/services/watchRunner.js';

const row = (o = {}) => ({
  puuid: 'p1', summonerName: 'a', tagLine: 'JP1', discordWebhookUrl: 'https://discord.com/api/webhooks/1/x',
  initialized: true, lastTier: 'GOLD', lastRank: 'II', lastLp: 50, lastWins: 10, lastLosses: 10, consecutiveLosses: 0,
  saved: 0, async save() { this.saved += 1; }, ...o
});
const solo = (o = {}) => ({ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 50, wins: 10, losses: 10, ...o });

test('runWatchCycle: 状態を保存してから通知し、同じプレイヤーの API は1回だけ呼ぶ', async () => {
  const rows = [row(), row({ discordWebhookUrl: 'https://discord.com/api/webhooks/2/y' })];
  const calls = [];
  const sent = [];
  const s = await runWatchCycle({
    list: async () => rows,
    fetchEntries: async (puuid) => { calls.push(puuid); return [solo({ losses: 13 })]; },
    notify: async (url, msg) => sent.push({ url, msg }),
    recordLp: async () => {}
  });
  assert.deepEqual(calls, ['p1'], '同じ puuid は1回だけ取得');
  assert.equal(s.checked, 2);
  assert.equal(s.notified, 2);
  assert.equal(sent.length, 2);
  assert.match(sent[0].msg, /3連敗/);
  assert.equal(rows[0].saved, 1);
  assert.equal(rows[0].lastLosses, 13);
  assert.equal(rows[0].consecutiveLosses, 3);

  // 2周目は同じ状態なので通知されない（重複通知なし）
  sent.length = 0;
  await runWatchCycle({ list: async () => rows, fetchEntries: async () => [solo({ losses: 13 })], notify: async (u, m) => sent.push(m), recordLp: async () => {} });
  assert.equal(sent.length, 0);
});

test('runWatchCycle: 1人の失敗が他に影響しない・保存に失敗したら通知しない', async () => {
  const bad = row({ puuid: 'bad' });
  const brokenSave = row({ puuid: 'p2', async save() { throw new Error('db down'); } });
  const ok = row({ puuid: 'ok' });
  const sent = [];
  const s = await runWatchCycle({
    list: async () => [bad, brokenSave, ok],
    fetchEntries: async (puuid) => {
      if (puuid === 'bad') throw new Error('429');
      return [solo({ losses: 13 })];
    },
    notify: async (u, m) => sent.push(m),
    recordLp: async () => {}
  });
  assert.equal(s.failed, 2);
  assert.equal(s.checked, 1);
  assert.equal(sent.length, 1, '保存に失敗した人には通知しない');
});
