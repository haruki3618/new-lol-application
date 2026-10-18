import test from 'node:test';
import assert from 'node:assert/strict';
import CacheEntry from '../src/models/CacheEntry.js';
import RateStamp from '../src/models/RateStamp.js';
import LpSnapshot from '../src/models/LpSnapshot.js';

// 使う側のコードが書く項目が、モデルに存在することを確認する（DB 不要）
test('CacheEntry: persistentCache.js が使う _id（文字列）・v・expiresAt を持つ', () => {
  assert.equal(CacheEntry.schema.path('_id').instance, 'String');
  assert.ok(CacheEntry.schema.path('v'));
  assert.equal(CacheEntry.schema.path('expiresAt').instance, 'Date');
  const doc = new CacheEntry({ _id: 'rate:state', v: { a: 1 }, expiresAt: new Date() });
  assert.equal(doc.validateSync(), undefined, '文字列キーでも検証を通る');
});

test('RateStamp: rateStore.js が使う t（数値）・expireAt を持ち、key は不要', () => {
  assert.equal(RateStamp.schema.path('t').instance, 'Number');
  assert.equal(RateStamp.schema.path('expireAt').instance, 'Date');
  assert.equal(new RateStamp({ t: Date.now(), expireAt: new Date() }).validateSync(), undefined);
});

test('LpSnapshot: lpHistory.js が使う項目をすべて持つ', () => {
  for (const f of ['puuid', 'queueType', 'tier', 'rank', 'lp', 'wins', 'losses', 'at']) {
    assert.ok(LpSnapshot.schema.path(f), `${f} がある`);
  }
});
