import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cached, cacheStats, staleAgeMs, isTransientError, _resetCache, STALE_1H } from '../src/utils/cache.js';
import { backoffMs } from '../src/utils/async.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const err = (status) => Object.assign(new Error('x'), status === undefined ? {} : { status });

// ---- stale-if-error ----
test('isTransientError: 通信エラー・429・5xx だけが「古い値で凌いでよい失敗」', () => {
  assert.equal(isTransientError(err()), true); // ステータス無し（タイムアウト等）
  assert.equal(isTransientError(err(429)), true);
  assert.equal(isTransientError(err(500)), true);
  assert.equal(isTransientError(err(503)), true);
  for (const s of [400, 401, 403, 404]) assert.equal(isTransientError(err(s)), false, String(s));
  assert.equal(isTransientError(null), true);
});

test('cached: staleMs が無ければ従来どおり（失敗は投げ、期限切れの値は返さない）', async () => {
  _resetCache();
  await cached('k1', 1, async () => 'old');
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(cached('k1', 1, async () => { throw err(503); }), /x/);
});

test('cached: 一時的な失敗なら、期限切れでも staleMs 以内の古い値を返し、印が付く', async () => {
  _resetCache();
  await cached('k2', 1, async () => 'old', { staleMs: STALE_1H });
  await new Promise((r) => setTimeout(r, 5));
  let calls = 0;
  const v = await cached('k2', 1, async () => { calls++; throw err(429); }, { staleMs: STALE_1H });
  assert.equal(v, 'old');
  assert.equal(calls, 1);
  assert.ok(staleAgeMs('k2') >= 0);
  assert.equal(cacheStats().stale, 1);
  // 直後は短い間だけ古い値を再利用し、障害中に loader（API）を叩き続けない
  const again = await cached('k2', 1, async () => { calls++; throw err(429); }, { staleMs: STALE_1H });
  assert.equal(again, 'old');
  assert.equal(calls, 1);
});

test('cached: 404 など一時的でない失敗は、古い値があっても投げる', async () => {
  _resetCache();
  await cached('k3', 1, async () => 'old', { staleMs: STALE_1H });
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(cached('k3', 1, async () => { throw err(404); }, { staleMs: STALE_1H }), /x/);
});

test('cached: staleMs を過ぎた古い値は返さない', async () => {
  _resetCache();
  await cached('k4', 1, async () => 'old', { staleMs: 5 });
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(cached('k4', 1, async () => { throw err(503); }, { staleMs: 5 }), /x/);
});

test('cached: 成功すれば印は消え、force でも失敗時は古い値で凌げる', async () => {
  _resetCache();
  await cached('k5', 1000, async () => 'a', { staleMs: STALE_1H });
  const v = await cached('k5', 1000, async () => { throw err(502); }, { force: true, staleMs: STALE_1H });
  assert.equal(v, 'a');
  assert.notEqual(staleAgeMs('k5'), null);
  await cached('k5', 1000, async () => 'b', { force: true, staleMs: STALE_1H });
  assert.equal(staleAgeMs('k5'), null);
  assert.equal(await cached('k5', 1000, async () => 'c'), 'b');
});

test('cacheStats: ヒット率と、同時リクエストの共有を数える', async () => {
  _resetCache();
  await cached('s1', 1000, async () => 1); // miss
  await cached('s1', 1000, async () => 1); // hit
  await Promise.all([cached('s2', 1000, async () => { await new Promise((r) => setTimeout(r, 5)); return 2; }), cached('s2', 1000, async () => 2)]); // miss + shared
  const s = cacheStats();
  assert.equal(s.hit, 1);
  assert.equal(s.miss, 2);
  assert.equal(s.shared, 1);
  assert.equal(s.hitRate, 50);
  assert.equal(staleAgeMs('nothing'), null);
});

// ---- 再試行のばらつき ----
test('backoffMs: 指数的に増え、上限で止まり、ばらつきの範囲に収まる', () => {
  const lo = (a) => backoffMs(a, { rand: () => 0 });
  const hi = (a) => backoffMs(a, { rand: () => 1 });
  assert.equal(lo(0), 250);
  assert.equal(hi(0), 500);
  assert.equal(lo(1), 500);
  assert.equal(hi(1), 1000);
  assert.equal(hi(3), 4000);
  assert.equal(hi(10), 8000); // 上限
  assert.equal(lo(10), 4000);
  for (let a = 0; a < 6; a++) {
    const v = backoffMs(a);
    assert.ok(v >= lo(a) && v <= hi(a));
  }
  assert.equal(backoffMs(-1, { rand: () => 1 }), 500); // 負の回数でも壊れない
});

test('riotApi: 5xx の再試行は backoffMs（ジッター付き）を使う', () => {
  const s = read('src', 'services', 'riotApi.js');
  assert.match(s, /import \{ sleep, backoffMs \}/);
  assert.match(s, /sleep\(backoffMs\(attempt\)\)/);
  assert.doesNotMatch(s, /sleep\(500 \* 2 \*\* attempt\)/);
});

// ---- 適用先 ----
test('古い値で凌ぐ: ランキング・サモナー・マスタリー・ステータスに適用し、リーグ（LP の記録元）には適用しない', () => {
  assert.match(read('src', 'routes', 'extra.js'), /staleMs: STALE_1H/);
  assert.match(read('src', 'routes', 'info.js'), /staleMs: STALE_1H/);
  const p = read('src', 'routes', 'profile.js');
  assert.match(p, /summoner:\$\{region\}:\$\{puuid\}`, 2 \* MIN[^\n]*staleMs: STALE_1H/);
  assert.match(p, /mastery:\$\{region\}:\$\{puuid\}`, 10 \* MIN[^\n]*staleMs: STALE_1H/);
  // ランクは古い値を LP の履歴に新しい時刻で記録してしまうので使わない
  const league = p.split('\n').find((l) => l.includes('const getLeague =') || (l.includes('league:${region}:${puuid}') && l.includes('cached(')));
  assert.ok(league && !league.includes('staleMs'));
  assert.match(read('src', 'views', 'ranking.ejs'), /locals\.staleMin/);
});

test('healthz: キャッシュの統計を返す', () => {
  const s = read('src', 'routes', 'sync.js');
  assert.match(s, /cache: cacheStats\(\)/);
});

// ---- エラー文の漏れ（v6.6.1 で直し切れていなかった所） ----
test('sync / timeline のルートは、err.message を利用者に返さない', () => {
  for (const f of ['sync.js', 'timeline.js']) {
    const s = read('src', 'routes', f);
    assert.doesNotMatch(s, /error: err\.message/, f);
    assert.doesNotMatch(s, /\$\{err\.message\}/, f);
    assert.doesNotMatch(s, /err\.status \|\| 500/, f);
    assert.match(s, /responseStatus\(err\)/, f);
    assert.match(s, /userMessage\(err/, f);
  }
});

// ---- インデックス ----
test('Match: チャンピオン別ページとパッチ一覧のためのインデックスがある', () => {
  const s = read('src', 'models', 'Match.js');
  assert.match(s, /index\(\{ 'participants\.championName': 1, gameCreation: -1 \}\)/);
  assert.match(s, /index\(\{ gameVersion: 1 \}\)/);
  // 既存のインデックスを消していない
  assert.match(s, /index\(\{ participantPuuids: 1, queueId: 1, gameCreation: -1 \}\)/);
  assert.match(s, /index\(\{ gameCreation: 1 \}\)/);
});

// ---- JSDoc ----
test('JSDoc: 計算ロジックの公開関数すべてに型注釈がある', () => {
  const files = ['reportMath', 'duoMath', 'watchMath', 'aggMath', 'insightsMath', 'scoreBaseline'];
  const missing = [];
  for (const f of files) {
    const lines = read('src', 'services', `${f}.js`).split('\n');
    lines.forEach((line, i) => {
      if (!/^export (function|const aggKey)/.test(line)) return;
      // 直前の行が JSDoc の終わり（*/）であること
      if (!(lines[i - 1] || '').trim().endsWith('*/')) missing.push(`${f}.js:${i + 1} ${line.slice(0, 50)}`);
    });
  }
  assert.deepEqual(missing, []);
});

test('JSDoc: 参照している型が src/types.js にある', () => {
  const types = read('src', 'types.js');
  const defined = new Set([...types.matchAll(/@typedef \{[^}]*\} (\w+)/g)].map((m) => m[1]));
  const used = new Set();
  for (const f of ['reportMath', 'duoMath', 'watchMath', 'aggMath', 'insightsMath', 'scoreBaseline']) {
    for (const m of read('src', 'services', `${f}.js`).matchAll(/import\('\.\.\/types\.js'\)\.(\w+)/g)) used.add(m[1]);
  }
  assert.ok(used.size > 0);
  for (const u of used) assert.ok(defined.has(u), `型 ${u} が types.js に無い`);
  assert.doesNotThrow(() => JSON.parse(read('jsconfig.json')));
});

// ---- UI ----
test('トースト: app.js が用意し、history / live が使い、CSS と「動きを減らす」設定がある', () => {
  const app = read('src', 'public', 'js', 'app.js');
  assert.match(app, /window\.lolToast = lolToast/);
  assert.match(app, /addEventListener\('offline'/);
  assert.match(app, /addEventListener\('online'/);
  assert.match(app, /aria-live/);
  assert.match(app, /aria-busy/);
  assert.match(read('src', 'public', 'js', 'history.js'), /window\.lolToast/);
  assert.match(read('src', 'public', 'js', 'live.js'), /window\.lolToast/);
  const css = read('src', 'public', 'css', 'app.css');
  assert.match(css, /\.toasts \{/);
  assert.match(css, /prefers-reduced-motion/);
  // CSP のため、トーストは style 属性を使わない
  const toastBlock = app.slice(app.indexOf('トースト通知'), app.indexOf('通信の切断・復帰'));
  assert.doesNotMatch(toastBlock, /\.style\.|setAttribute\('style'/);
  assert.doesNotMatch(toastBlock, /innerHTML/); // メッセージは textContent で入れる（XSS を避ける）
});

// ---- ドキュメント・版 ----
test('運用ドキュメントがそろい、実在する設定名・パスを指している', () => {
  for (const f of ['OPERATIONS.md', 'UX_SCENARIOS.md', 'MOBILE_CHECK.md', 'RELEASE_CHECKLIST.md']) {
    assert.ok(read('docs', f).length > 500, f);
  }
  const ops = read('docs', 'OPERATIONS.md');
  for (const name of ['RIOT_API_KEY', 'MONGODB_URI', 'WEBHOOK_SECRET', '/healthz']) assert.ok(ops.includes(name), name);
  const render = read('render.yaml');
  for (const name of ['RIOT_API_KEY', 'MONGODB_URI', 'WEBHOOK_SECRET', 'WATCH_REGISTER_KEY', 'SITE_PASSWORD']) assert.ok(render.includes(name), name);
  const readme = read('README.md');
  for (const f of ['OPERATIONS.md', 'RELEASE_CHECKLIST.md']) assert.ok(readme.includes(f), `README に ${f}`);
});

test('版: package.json / package-lock.json / CHANGELOG の版がそろっている（6.7.0 以降）', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const [a, b] = pkg.version.split('.').map(Number);
  assert.ok(a > 6 || (a === 6 && b >= 7));
  const log = read('CHANGELOG.md');
  assert.ok(log.startsWith(`# 変更履歴\n\n## v${pkg.version}`));
  assert.match(log, /## v6\.7\.0（障害に強く/);
});
