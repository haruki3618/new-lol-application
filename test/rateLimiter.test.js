import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, parseLimitHeader, RateLimitBusyError } from '../src/services/rateLimiter.js';
import { createMemoryStore } from '../src/services/rateStore.js';

// 時計と sleep を差し替えて、待ち時間を実際には待たずに検証する
function setup(overrides = {}) {
  const clock = { t: 1_000_000 };
  const store = overrides.store || createMemoryStore();
  const make = (extra = {}) =>
    createRateLimiter({
      store,
      windows: [{ max: 20, windowMs: 1000 }, { max: 100, windowMs: 120000 }],
      now: () => clock.t,
      sleep: async (ms) => { clock.t += ms; },
      jitter: () => 5,
      log: { log() {}, warn() {} },
      ...extra
    });
  return { clock, store, make };
}

test('parseLimitHeader: 上限ヘッダーを読む', () => {
  assert.deepEqual(parseLimitHeader('20:1,100:120'), [{ max: 20, windowMs: 1000 }, { max: 100, windowMs: 120000 }]);
  assert.equal(parseLimitHeader('abc'), null);
  assert.equal(parseLimitHeader(undefined), null);
});

test('ユーザー操作は上限の95%まで。超える分は次の窓まで待つ', async () => {
  const { clock, make } = setup();
  const limiter = make();
  const start = clock.t;
  for (let i = 0; i < 19; i++) await limiter.acquire('high');
  assert.equal(clock.t, start, '19回（20×0.95）までは待たない');
  await limiter.acquire('high');
  assert.ok(clock.t - start >= 1000, '20回目は1秒窓が空くまで待つ');
});

test('クローラー（low）は上限の70%までしか使わない', async () => {
  const { clock, make } = setup();
  const limiter = make();
  const start = clock.t;
  for (let i = 0; i < 14; i++) await limiter.acquire('low');
  assert.equal(clock.t, start);
  await limiter.acquire('low');
  assert.ok(clock.t > start);
});

test('2つのリミッターが同じ store を共有すると、合計で上限を超えない', async () => {
  const { clock, store, make } = setup();
  const server = make();
  const crawler = make();
  // サーバーとクローラーを同時に動かすのと同じ状況
  await Promise.all([
    ...Array.from({ length: 30 }, () => server.acquire('high')),
    ...Array.from({ length: 30 }, () => crawler.acquire('low'))
  ]);
  const stamps = await store.list(0);
  assert.equal(stamps.length, 60);
  for (const s of stamps) {
    const in1s = stamps.filter((x) => x >= s && x < s + 1000).length;
    assert.ok(in1s <= 19, `1秒窓の使用回数 ${in1s} が上限（19）を超えた`);
  }
  for (const s of stamps) {
    const in120 = stamps.filter((x) => x >= s && x < s + 120000).length;
    assert.ok(in120 <= 95, `120秒窓の使用回数 ${in120} が上限（95）を超えた`);
  }
  assert.ok(clock.t >= 1_000_000);
});

test('learn: ヘッダーから上限を学習し、別プロセスにも共有される', async () => {
  const { make } = setup();
  const a = make();
  const b = make();
  assert.equal(a.learn({ 'x-app-rate-limit': '500:10,30000:600' }), true);
  assert.equal(a.learn({ 'x-app-rate-limit': '500:10,30000:600' }), false, '同じ値なら変更なし');
  await new Promise((r) => setImmediate(r));
  await b.acquire('high'); // 共有された状態を取り込む
  assert.deepEqual(b.windows, [{ max: 500, windowMs: 10000 }, { max: 30000, windowMs: 600000 }]);
});

test('penalize: 429 のあとは全員が指定時間止まる', async () => {
  const { clock, make } = setup();
  const a = make();
  const b = make();
  await a.penalize({ retryAfterSec: 3, type: 'application' });
  const start = clock.t;
  await b.acquire('low');
  assert.ok(clock.t - start >= 3000);
});

test('penalize: メソッド単位の 429 は全体を止めない', async () => {
  const { clock, make } = setup();
  const a = make();
  assert.equal(await a.penalize({ retryAfterSec: 30, type: 'method' }), false);
  const start = clock.t;
  await a.acquire('high');
  assert.equal(clock.t, start);
});

test('ユーザー操作は待てる時間を超えたら「混雑」エラーで返す', async () => {
  const { make } = setup();
  const limiter = make({ maxWaitMs: { high: 5000, low: Infinity } });
  await limiter.penalize({ retryAfterSec: 60, type: 'application' });
  await assert.rejects(() => limiter.acquire('high'), RateLimitBusyError);
});

test('stats: 現在の使用状況を返す', async () => {
  const { make } = setup();
  const limiter = make();
  for (let i = 0; i < 3; i++) await limiter.acquire('high');
  const s = await limiter.stats();
  assert.equal(s.windows[0].used, 3);
  assert.equal(s.windows[1].max, 100);
});
