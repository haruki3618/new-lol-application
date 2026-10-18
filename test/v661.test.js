import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ejs from 'ejs';
import axios from 'axios';
import { fileURLToPath } from 'node:url';
import { safeStatus, responseStatus, userMessage } from '../src/utils/httpError.js';
import { createNegativeCache } from '../src/utils/negativeCache.js';
import { readCookie } from '../src/middleware/region.js';
import { freshSeeds, IDLE_WAIT_MS } from '../src/services/crawler.js';
import { ipTag } from '../src/routes/watch.js';
import { accountByRiotId, _resetAccountNotFound } from '../src/services/names.js';
import { config } from '../src/config/index.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const views = path.join(root, 'src', 'views');

// ---- エラー処理 ----
test('safeStatus: 400〜599 の整数だけ通し、それ以外は既定値（res.status が例外にならない）', () => {
  assert.equal(safeStatus({ status: 404 }), 404);
  assert.equal(safeStatus({ status: 'ECONNRESET' }), 500);
  assert.equal(safeStatus({ status: 99 }), 500);
  assert.equal(safeStatus({ status: 700 }), 500);
  assert.equal(safeStatus({ status: 404.5 }), 500);
  assert.equal(safeStatus(null), 500);
  assert.equal(safeStatus({}, 0), 0);
});

test('responseStatus: Riot の 401/403 はサイト側の問題なので 503、上流の 5xx は 502、404/429 はそのまま', () => {
  assert.equal(responseStatus({ status: 401 }), 503);
  assert.equal(responseStatus({ status: 403 }), 503);
  assert.equal(responseStatus({ status: 502 }), 502);
  assert.equal(responseStatus({ status: 503 }), 502);
  assert.equal(responseStatus({ status: 404 }), 404);
  assert.equal(responseStatus({ status: 429 }), 429);
  assert.equal(responseStatus(new Error('boom')), 500);
});

test('userMessage: 想定外のエラーの内部文言（DB の例外など）を利用者に見せない', () => {
  const leak = Object.assign(new Error('E11000 duplicate key mongodb://user:pass@host/db'), { status: 500 });
  assert.ok(!userMessage(leak).includes('mongodb'));
  assert.ok(!userMessage(new Error('secret path /srv/app/.env')).includes('.env'));
  assert.match(userMessage({ status: 404 }), /見つかりません/);
  assert.match(userMessage({ status: 429 }), /集中/);
  assert.match(userMessage({ status: 401 }), /API キー/);
  assert.equal(userMessage(new Error('x'), '代わりの文'), '代わりの文');
});

test('ルート: 画面・JSON にエラー本文（err.message）をそのまま出さない', () => {
  for (const f of ['extra.js', 'info.js', 'champions.js', 'insights.js', 'live.js']) {
    const src = read('src', 'routes', f);
    assert.ok(!/message:\s*err\.message/.test(src), `${f} が err.message をそのまま画面へ出している`);
    assert.ok(!/error:\s*err\.message/.test(src), `${f} が err.message をそのまま JSON へ出している`);
    assert.ok(!/res\.status\(err\.status \|\| 500\)/.test(src), `${f} が err.status を検証せず使っている`);
  }
  assert.ok(!/res\.status\(err\.status \|\| 500\)/.test(read('src', 'routes', 'profile.js')));
});

// ---- Cookie ----
test('readCookie: 壊れた %xx を含む Cookie でも例外にならず null（以前は全ページが 500 になった）', () => {
  assert.equal(readCookie({ headers: { cookie: 'region=%E0%A4%A' } }), null);
  assert.equal(readCookie({ headers: { cookie: 'a=1; region=%ZZ; b=2' } }), null);
  assert.equal(readCookie({ headers: { cookie: 'a=1; region=kr' } }), 'kr');
  assert.equal(readCookie({ headers: { cookie: 'region=%E3%83%86' } }), 'テ');
  assert.equal(readCookie({ headers: {} }), null);
});

// ---- 入口の確認 ----
test('/api/live-fill と /api/tab: 検索を通った PUUID だけ受け付ける。エラー文はエスケープする', () => {
  const live = read('src', 'routes', 'live.js');
  assert.match(live, /isKnownPuuid\(puuid\)/);
  assert.match(live, /status\(403\)/);
  const info = read('src', 'routes', 'info.js');
  assert.match(info, /isKnownPuuid\(puuid\)/);
  assert.match(info, /escapeHtml\(/);
  assert.ok(!/err\.message\s*\+/.test(info), '/api/tab が err.message を HTML に連結している');
  // ライブ画面を開いたとき、参加者の PUUID を覚える（そうしないと「データ不足を取得」が 403 になる）
  assert.match(read('src', 'routes', 'profile.js'), /rememberPuuid\(p\.puuid\)/);
});

test('/search: riotId が配列などで来ても落ちない', () => {
  const src = read('src', 'routes', 'profile.js');
  assert.match(src, /String\(req\.body\?\.riotId \?\? ''\)/);
  assert.ok(!/req\.body\.riotId\.trim\(\)/.test(src));
  assert.match(src, /renderHome\(res, null, req\.region\)\.catch\(next\)/);
});

// ---- 存在しない Riot ID ----
test('negativeCache: 期限まで覚え、期限が過ぎたら忘れる。上限を超えたら古いものから捨てる', () => {
  let t = 1000;
  const c = createNegativeCache({ ttlMs: 60_000, max: 2, now: () => t });
  assert.equal(c.has('a'), false);
  c.add('a');
  assert.equal(c.has('a'), true);
  t += 59_999;
  assert.equal(c.has('a'), true);
  t += 2;
  assert.equal(c.has('a'), false);
  c.add('x'); c.add('y'); c.add('z');
  assert.equal(c.size, 2);
  assert.equal(c.has('x'), false);
  assert.equal(c.has('z'), true);
});

test('accountByRiotId: 404 は 60 秒だけ覚えて API を使わない。再取得（force）と 429 は覚えない', async () => {
  const realGet = axios.get;
  config.riotApiKey = 'RGAPI-test';
  let calls = 0;
  const httpErr = (status) => Object.assign(new Error('err'), { response: { status, headers: {}, data: { status: { message: 'err' } } } });
  try {
    _resetAccountNotFound();
    axios.get = async () => { calls += 1; throw httpErr(404); };
    const id = { gameName: 'ない人', tagLine: 'JP1' };
    await assert.rejects(() => accountByRiotId(id, false, 'jp'), (e) => e.status === 404);
    await assert.rejects(() => accountByRiotId(id, false, 'jp'), (e) => e.status === 404);
    assert.equal(calls, 1, '2 回目は API を呼ばない');
    await assert.rejects(() => accountByRiotId(id, true, 'jp'), (e) => e.status === 404);
    assert.equal(calls, 2, 'force=true はもう一度確かめる');

    // 見つかったら、覚えた「見つからない」は使わない
    _resetAccountNotFound();
    calls = 0;
    axios.get = async () => { calls += 1; return { data: { puuid: 'p'.repeat(40), gameName: 'いる人', tagLine: 'JP1' }, headers: {} }; };
    const ok = await accountByRiotId({ gameName: 'いる人', tagLine: 'JP1' }, false, 'jp');
    assert.equal(ok.gameName, 'いる人');
  } finally {
    axios.get = realGet;
    _resetAccountNotFound();
  }
});

// ---- クローラー ----
test('freshSeeds: 確認済みの起点を除く。待ち時間は分単位（10 秒おきの空回りをしない）', () => {
  const visited = new Set(['a', 'b']);
  assert.deepEqual(freshSeeds([{ puuid: 'a' }, { puuid: 'c' }, { puuid: 'b' }], visited), [{ puuid: 'c' }]);
  assert.deepEqual(freshSeeds([{ puuid: 'a' }], visited), []);
  assert.ok(IDLE_WAIT_MS >= 60_000);
  const src = read('src', 'services', 'crawler.js');
  assert.ok(!/queue = await seedAll\(\);\s*\n\s*await sleep\(10000\)/.test(src), '起点を使い切ったとき 10 秒おきに取り直す処理が残っている');
});

// ---- お気に入り追跡 ----
test('ipTag: 鍵があれば HMAC（鍵なしのハッシュと一致しない＝総当たりで IP に戻せない）。同じ IP・鍵なら同じ値', () => {
  const req = { ip: '203.0.113.7' };
  const plain = crypto.createHash('sha256').update('watch:203.0.113.7').digest('hex').slice(0, 16);
  assert.equal(ipTag(req, ''), plain);
  const keyed = ipTag(req, 'secret-A');
  assert.notEqual(keyed, plain);
  assert.equal(keyed, ipTag(req, 'secret-A'));
  assert.notEqual(keyed, ipTag(req, 'secret-B'));
  assert.equal(keyed.length, 16);
});

test('Discord 通知: リダイレクト先へ POST しない', () => {
  assert.match(read('src', 'services', 'notify.js'), /redirect:\s*'error'/);
});

// ---- 事前集計の作り直し ----
test('agg:rebuild: 削除済みの試合ぶんの集計が失われるときは --yes が必要', () => {
  const src = read('scripts', 'rebuildAgg.js');
  assert.match(src, /--yes/);
  assert.match(src, /aggregated > stored/);
});

// ---- テンプレート ----
test('すべてのテンプレートが構文として正しい（描画しなくても、閉じ忘れ・括弧の不一致を検出する）', () => {
  const files = fs.readdirSync(views).filter((f) => f.endsWith('.ejs'));
  assert.ok(files.length >= 25);
  for (const f of files) {
    const file = path.join(views, f);
    assert.doesNotThrow(() => ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file, views: [views] }), `${f} をコンパイルできない`);
  }
});

test('静的ファイルの URL に ?v=（アプリのバージョン）が付く。バージョンが無いときは付けない', async () => {
  assert.match(config.appVersion, /^\d+\.\d+\.\d+/);
  const withV = await ejs.renderFile(path.join(views, '_foot.ejs'), { assetV: '9.9.9' }, { views: [views] });
  assert.ok(withV.includes('/static/js/app.js?v=9.9.9'));
  assert.ok(withV.includes('/static/js/suggest.js?v=9.9.9'));
  const without = await ejs.renderFile(path.join(views, '_foot.ejs'), {}, { views: [views] });
  assert.ok(without.includes('"/static/js/app.js"'));
  const head = await ejs.renderFile(path.join(views, '_head.ejs'), { title: 'T', active: '', assetV: '9.9.9' }, { views: [views] });
  assert.ok(head.includes('/static/css/app.css?v=9.9.9'));
  assert.match(read('src', 'app.js'), /res\.locals\.assetV = config\.appVersion/);
});

test('エラー画面: 再試行できる場合だけ「もう一度試す」を出す。title が null でも描画できる', async () => {
  const base = { title: null, backUrl: '/', message: '取得できませんでした。' };
  const retry = await ejs.renderFile(path.join(views, 'error.ejs'), { ...base, retryable: true }, { views: [views] });
  assert.ok(retry.includes('data-reload'));
  const plain = await ejs.renderFile(path.join(views, 'error.ejs'), base, { views: [views] });
  assert.ok(!plain.includes('data-reload'));
});
