import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipLimiter } from '../src/middleware/ipLimiter.js';
import { CSP } from '../src/middleware/security.js';
import { escapeHtml } from '../src/utils/escape.js';
import { webhookHash, encryptWebhook, revealWebhook, isEncrypted, migrateWatchlistWebhooks } from '../src/services/webhookVault.js';
import { keyOk } from '../src/routes/watch.js';
import { runWatchCycle } from '../src/services/watchRunner.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const URL1 = 'https://discord.com/api/webhooks/123/abc-DEF_ghi';

// ---- IP 制限: スライディングウィンドウ ----
const callWith = (limiter, ip = 'a') => {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() {}, statusCode: 200 };
  let passed = false;
  limiter({ ip, headers: {}, url: '/x' }, res, () => { passed = true; });
  return { passed, res };
};

test('ipLimiter: ウィンドウの境目で上限の 2 倍が通らない', () => {
  let t = 0;
  const lim = ipLimiter({ windowMs: 1000, max: 3, now: () => t });
  t = 900; for (let i = 0; i < 3; i++) assert.equal(callWith(lim).passed, true);
  t = 1100; // 固定ウィンドウならここで解除されるが、直近 1 秒には 3 件ある
  assert.equal(callWith(lim).passed, false);
  t = 1901; // 900 の記録が 1 秒を過ぎた
  assert.equal(callWith(lim).passed, true);
});

test('ipLimiter: 拒否された要求は数えず、Retry-After は最も古い記録が消えるまで', () => {
  let t = 0;
  const lim = ipLimiter({ windowMs: 10000, max: 1, now: () => t });
  assert.equal(callWith(lim).passed, true);
  t = 4000;
  const r = callWith(lim);
  assert.equal(r.passed, false);
  assert.equal(r.res.headers['Retry-After'], '6');
  t = 4500; callWith(lim); callWith(lim); // 何度叩いても解除時刻は延びない
  t = 10001;
  assert.equal(callWith(lim).passed, true);
});

test('ipLimiter: skip が真なら数えない', () => {
  const lim = ipLimiter({ windowMs: 1000, max: 1, skip: (req) => req.method !== 'POST' });
  const get = () => { let p = false; lim({ ip: 'a', method: 'GET', headers: {} }, { setHeader() {} }, () => { p = true; }); return p; };
  assert.equal(get(), true); assert.equal(get(), true); assert.equal(get(), true);
});

// ---- CSP / テンプレート ----
test("CSP: script-src に 'unsafe-inline' が無い", () => {
  const script = CSP.split('; ').find((d) => d.startsWith('script-src'));
  assert.equal(script, "script-src 'self'");
});

test('ビューにインラインのイベント属性・実行されるインライン script が残っていない', () => {
  const dir = path.join(root, 'views');
  for (const f of fs.readdirSync(dir)) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(s, /\son(error|click|change|submit|input|load)\s*=/i, `${f} にインラインのイベント属性がある`);
    assert.doesNotMatch(s, /javascript:/i, `${f} に javascript: がある`);
    for (const m of s.matchAll(/<script\b([^>]*)>/gi)) {
      const attrs = m[1];
      assert.ok(/\bsrc=/.test(attrs) || /type="application\/json"/.test(attrs), `${f} に実行されるインライン script がある: <script${attrs}>`);
    }
  }
});

// ---- escapeHtml ----
test('escapeHtml: 5 種類の記号を変換し、null でも落ちない', () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

// ---- Webhook の保管 ----
test('webhookVault: 暗号化 → 復号で元に戻り、毎回違う文字列になる', () => {
  const a = encryptWebhook(URL1, 'secret-1');
  const b = encryptWebhook(URL1, 'secret-1');
  assert.ok(isEncrypted(a));
  assert.notEqual(a, b);
  assert.ok(!a.includes('discord.com'));
  assert.equal(revealWebhook(a, 'secret-1'), URL1);
  assert.throws(() => revealWebhook(a, 'other'));
  assert.throws(() => revealWebhook(a, ''), /WEBHOOK_SECRET/);
});

test('webhookVault: 秘密が無ければ平文のまま、平文は復号しなくても読める', () => {
  assert.equal(encryptWebhook(URL1, ''), URL1);
  assert.equal(revealWebhook(URL1, 'secret-1'), URL1);
});

test('webhookVault: ハッシュは同じ入力で同じ・違う URL / 秘密で違い、元の URL を含まない', () => {
  const h = webhookHash(URL1, 's');
  assert.equal(h, webhookHash(URL1, 's'));
  assert.notEqual(h, webhookHash(URL1 + 'x', 's'));
  assert.notEqual(h, webhookHash(URL1, 't'));
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('migrateWatchlistWebhooks: 旧データにハッシュと暗号化を付け、2 回目は何もしない', async () => {
  const rows = [
    { _id: 1, discordWebhookUrl: URL1 },
    { _id: 2, discordWebhookUrl: encryptWebhook('https://discord.com/api/webhooks/9/z', 'k'), webhookHash: webhookHash('https://discord.com/api/webhooks/9/z', 'k') }
  ];
  const Fake = {
    find: () => ({ select: () => ({ lean: async () => rows.map((r) => ({ ...r })) }) }),
    updateOne: async ({ _id }, { $set }) => Object.assign(rows.find((r) => r._id === _id), $set)
  };
  assert.equal(await migrateWatchlistWebhooks(Fake, 'k'), 1);
  assert.ok(isEncrypted(rows[0].discordWebhookUrl));
  assert.equal(rows[0].webhookHash, webhookHash(URL1, 'k'));
  assert.equal(revealWebhook(rows[0].discordWebhookUrl, 'k'), URL1);
  assert.equal(await migrateWatchlistWebhooks(Fake, 'k'), 0);
});

test('runWatchCycle: 暗号化された Webhook は復号して通知先に渡す', async () => {
  const { config } = await import('../src/config/index.js');
  const prev = config.webhookSecret;
  config.webhookSecret = 'k';
  try {
    const w = {
      puuid: 'p', summonerName: 'a', tagLine: 'JP1', region: 'jp', initialized: true,
      lastTier: 'GOLD', lastRank: 'IV', lastLp: 10, lastWins: 10, lastLosses: 10, consecutiveLosses: 0,
      discordWebhookUrl: encryptWebhook(URL1, 'k'), save: async () => {}
    };
    const sent = [];
    await runWatchCycle({
      list: async () => [w],
      fetchEntries: async () => [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'III', leaguePoints: 5, wins: 11, losses: 10 }],
      notify: async (url) => { sent.push(url); },
      recordLp: async () => {}
    });
    assert.deepEqual(sent, [URL1]);
  } finally { config.webhookSecret = prev; }
});

// ---- 登録キー ----
test('keyOk: キー未設定なら常に通り、設定時は一致したときだけ通る', () => {
  assert.equal(keyOk('', ''), true);
  assert.equal(keyOk(undefined, ''), true);
  assert.equal(keyOk('abc', 'abc'), true);
  assert.equal(keyOk('abd', 'abc'), false);
  assert.equal(keyOk('', 'abc'), false);
  assert.equal(keyOk(undefined, 'abc'), false);
});
