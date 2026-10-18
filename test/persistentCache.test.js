import test from 'node:test';
import assert from 'node:assert/strict';
import { cached } from '../src/utils/cache.js';
import { cachedPersistent } from '../src/utils/persistentCache.js';

// MongoDB に繋がっていなくても、通常のメモリキャッシュとして動くこと
test('cachedPersistent: DB なしでもキャッシュされ、同時リクエストは1回にまとまる', async () => {
  let calls = 0;
  const loader = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return { n: calls }; };
  const [a, b] = await Promise.all([
    cachedPersistent('t:persist-1', 60000, loader),
    cachedPersistent('t:persist-1', 60000, loader)
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  await cachedPersistent('t:persist-1', 60000, loader);
  assert.equal(calls, 1, '2回目はキャッシュから');
  await cachedPersistent('t:persist-1', 60000, loader, { force: true });
  assert.equal(calls, 2, 'force で取り直す');
});

test('cached: 失敗した結果はキャッシュされない', async () => {
  let calls = 0;
  const loader = async () => { calls += 1; if (calls === 1) throw new Error('boom'); return 'ok'; };
  await assert.rejects(() => cached('t:fail', 60000, loader));
  assert.equal(await cached('t:fail', 60000, loader), 'ok');
});
