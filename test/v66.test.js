import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSP } from '../src/middleware/security.js';
import { ipLimiter } from '../src/middleware/ipLimiter.js';
import { makeHelpers } from '../src/utils/ddHelpers.js';
import { createRateLimiter } from '../src/services/rateLimiter.js';
import { runWatchCycle } from '../src/services/watchRunner.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// ---- CSP・外部フォント ----
test("CSP: style-src / font-src は自サイトだけ（'unsafe-inline' も外部フォントも無い）", () => {
  const dirs = Object.fromEntries(CSP.split('; ').map((d) => [d.split(' ')[0], d]));
  assert.equal(dirs['style-src'], "style-src 'self'");
  assert.equal(dirs['font-src'], "font-src 'self'");
  assert.doesNotMatch(CSP, /googleapis|gstatic|unsafe-inline/);
});

test('ビューに style="" 属性と外部フォントの読み込みが残っていない（動的な値は data-style）', () => {
  const dir = path.join(root, 'views');
  for (const f of fs.readdirSync(dir)) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(s, /(?<![-\w])style="/, `${f} に style 属性がある`);
    assert.doesNotMatch(s, /fonts\.(googleapis|gstatic)\.com/, `${f} が外部フォントを読み込んでいる`);
  }
});

test('CSS: ライトテーマ・横スクロールのぼかし・キーボードのフォーカス表示がある', () => {
  const css = read('public', 'css', 'app.css');
  assert.match(css, /prefers-color-scheme: light/);
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /\.tabs\.can-right/);
  assert.match(css, /\[role="button"\]:focus-visible/);
  assert.doesNotMatch(css, /font-size: *1[01]px/, '補足の文字は 12px 未満にしない');
});

test('ヘッダー: description・OGP・favicon がある', () => {
  const head = read('views', '_head.ejs');
  for (const k of ['name="description"', 'og:title', 'og:description', 'rel="icon"']) assert.ok(head.includes(k), k);
  assert.ok(fs.existsSync(path.join(root, 'public', 'favicon.svg')));
});

// ---- 画像の alt ----
test('ddHelpers: スペル・ルーン・アイテムの alt を返し、属性を壊す記号は取り除く', () => {
  const h = makeHelpers({ version: '15.1.1', spellNames: { 4: 'フラッシュ' }, runeNames: { 8112: 'Electrocute' }, items: { 3031: { name: 'Infinity "Edge"<b>' } } });
  assert.equal(h.spellAlt(4), 'フラッシュ');
  assert.equal(h.runeAlt(8112), 'Electrocute');
  assert.equal(h.itemAlt(3031), 'Infinity Edgeb');
  assert.equal(h.itemAlt(1), '');
});

test('ビュー: スペル・ルーン・アイテム画像の alt が空のままではない', () => {
  const dir = path.join(root, 'views');
  for (const f of fs.readdirSync(dir)) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(s, /<img[^>]*src="<%= h\.(spell|rune|item)Img\([^"]*alt=""/, `${f} に alt が空の画像がある`);
  }
});

// ---- アクセス制限 ----
test('ipLimiter: 429 の画面に待ち時間（秒）を渡す', () => {
  const lim = ipLimiter({ windowMs: 60000, max: 1 });
  const req = { ip: 'a', method: 'GET', originalUrl: '/summoner', headers: {} };
  const mk = () => { const r = { headers: {}, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, render(v, d) { r.view = v; r.data = d; } }; return r; };
  lim(req, mk(), () => {});
  const res = mk();
  lim(req, res, () => assert.fail('通らないはず'));
  assert.equal(res.code, 429);
  assert.equal(res.view, 'error');
  assert.ok(res.data.retryAfterSec >= 1 && res.data.retryAfterSec <= 60);
});

test('app.js(サーバー): 同期は開始と確認で枠を分け、履歴は 1 日の上限もある', () => {
  const src = read('app.js');
  assert.match(src, /'\/api\/sync\/start'/);
  assert.match(src, /'\/api\/sync\/status'/);
  assert.match(src, /history-day/);
  assert.match(src, /favicon\.ico/);
  assert.match(src, /TRUST_PROXY/);
});

test('同期・履歴の開始は、検索を通った PUUID だけ受け付ける', () => {
  const src = read('routes', 'sync.js');
  assert.equal((src.match(/isKnownPuuid\(puuid\)/g) || []).length, 2);
  assert.match(src, /status\(403\)/);
});

// ---- Riot API の枠の管理 ----
test('rateLimiter: 記録後の検証だけ最新の一覧を読む（fresh）', async () => {
  const calls = [];
  const stamps = [];
  const store = {
    async add(t) { stamps.push(t); return stamps.length; },
    async remove() {},
    async list(since, opts) { calls.push(opts?.fresh === true); return stamps.filter((t) => t > since); },
    async getState() { return {}; },
    async patchState() {}
  };
  const lim = createRateLimiter({ store, windows: [{ max: 10, windowMs: 1000 }], log: {} });
  await lim.acquire('high');
  assert.deepEqual(calls, [false, true]);
});

// ---- 追跡 ----
test('runWatchCycle: 別の巡回が処理中（claim が null）の登録は飛ばして通知しない', async () => {
  const row = { puuid: 'p', summonerName: 'a', tagLine: 'JP1', discordWebhookUrl: 'https://discord.com/api/webhooks/1/x', initialized: true, lastTier: 'GOLD', lastRank: 'II', lastLp: 50, lastWins: 10, lastLosses: 10, consecutiveLosses: 0, saved: 0, async save() { this.saved += 1; } };
  let sent = 0;
  const s = await runWatchCycle({
    list: async () => [row],
    claim: async () => null,
    fetchEntries: async () => [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 50, wins: 10, losses: 13 }],
    notify: async () => { sent += 1; },
    recordLp: async () => {}
  });
  assert.equal(s.skipped, 1);
  assert.equal(s.checked, 0);
  assert.equal(sent, 0);
  assert.equal(row.saved, 0);
});

test('runWatchCycle: 処理したら印（lockedUntil）を外して保存する', async () => {
  const row = { puuid: 'p', summonerName: 'a', tagLine: 'JP1', discordWebhookUrl: 'https://discord.com/api/webhooks/1/x', initialized: true, lastTier: 'GOLD', lastRank: 'II', lastLp: 50, lastWins: 10, lastLosses: 10, consecutiveLosses: 0, lockedUntil: new Date(Date.now() + 1000), saved: 0, async save() { this.saved += 1; } };
  const s = await runWatchCycle({
    list: async () => [row],
    claim: async (w) => w,
    fetchEntries: async () => [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 50, wins: 10, losses: 10 }],
    notify: async () => {},
    recordLp: async () => {}
  });
  assert.equal(s.checked, 1);
  assert.equal(row.lockedUntil, null);
});

// ---- ランク・マスタリーの取得失敗 ----
test('プロフィール/ライブ: ランクの失敗を「未ランク」と見せず、失敗をキャッシュしない', () => {
  const src = read('routes', 'profile.js');
  assert.match(src, /leagueFailed/);
  assert.match(src, /rankFailed/);
  assert.doesNotMatch(src, /getLeagueEntriesByPUUID\(puuid, \{ region \}\)\.catch/);
  const live = read('services', 'liveData.js');
  assert.match(live, /throw err;/);
  assert.match(read('views', '_rank.ejs'), /取得できません/);
});

// ---- 画面のスクリプト ----
test('app.js(画面): 失敗時の再試行・タブの URL 保存・キーボード操作・差し替え・テーマ', () => {
  const src = read('public', 'js', 'app.js');
  for (const k of ['httpError', 'r.ok', 'history.replaceState', 'aria-expanded', 'refreshProfile', 'data-style', 'Retry-After', 'data-theme-toggle', 'ArrowRight', 'can-right']) {
    assert.ok(src.includes(k), `${k} が app.js に無い`);
  }
});

test('試合カードのヘッダーはキーボードで操作できる（role / tabindex / aria）', () => {
  const m = read('views', '_match.ejs');
  assert.match(m, /data-collapse="m<%= i %>" role="button" tabindex="0" aria-expanded="false"/);
});

test('プロフィールのタブに role="tab" / tabpanel が付いている', () => {
  const p = read('views', 'profile.ejs');
  assert.equal((p.match(/role="tab"/g) || []).length, 5);
  assert.match(p, /role="tablist"/);
  assert.match(p, /data-more/);
});

test('プロセス全体の未処理の例外・Promise 拒否を記録して続行する', () => {
  const s = read('server.js');
  assert.match(s, /unhandledRejection/);
  assert.match(s, /uncaughtException/);
});
