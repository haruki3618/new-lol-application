import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { validateEnv, assertEnv, isProduction } from '../src/config/validate.js';
import { redact, formatError, describeEndpoint, requestContext, logRequestError } from '../src/utils/logger.js';
import { safeRouter, wrapHandler } from '../src/utils/asyncRoutes.js';
import { installProcessGuards } from '../src/utils/processGuard.js';
import { requestId } from '../src/middleware/requestId.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const goodCfg = { riotApiKey: 'RGAPI-aaaa-bbbb', mongoUri: 'mongodb+srv://u:p@c.mongodb.net/db', mongoUriSet: true };
const check = (env = {}, cfg = goodCfg, opts = {}) => validateEnv(env, cfg, opts);

// ---- 環境変数チェック ----
test('validateEnv: 正しい設定ならエラーも警告も無い', () => {
  const r = check({ PORT: '3000', DEFAULT_REGION: 'JP', MAX_DB_MB: '400', RATE_HIGH_RATIO: '0.85' }, goodCfg, { production: true });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test('validateEnv: 本番ではキーと接続先が必須。開発では警告だけ（保存済みデータは見られるため）', () => {
  const none = { riotApiKey: '', mongoUri: 'mongodb://127.0.0.1:27017/x', mongoUriSet: false };
  const prod = check({}, none, { production: true });
  assert.equal(prod.errors.length, 2);
  assert.match(prod.errors.join(), /RIOT_API_KEY/);
  assert.match(prod.errors.join(), /MONGODB_URI/);
  const dev = check({}, none, { production: false });
  assert.deepEqual(dev.errors, []);
  assert.equal(dev.warnings.length, 1);
  assert.match(dev.warnings[0], /RIOT_API_KEY/);
  // クローラーなどはキーが無いと何もできないので、開発でも必須
  assert.equal(check({}, none, { needKey: true }).errors.length, 1);
});

test('validateEnv: 旧名のキーだけ設定されているときは、直し方を案内する', () => {
  const r = check({ RIOT_KEY: 'RGAPI-x', STRICT_ENV: '1' }, { ...goodCfg, riotApiKey: '' }, { production: true });
  assert.match(r.errors[0], /RIOT_KEY/);
  assert.match(r.errors[0], /STRICT_ENV/);
});

test('validateEnv: 前後の引用符・空白、仮の文字、スキームの間違い', () => {
  assert.match(check({}, { ...goodCfg, riotApiKey: '"RGAPI-abc"' }).errors[0], /引用符/);
  assert.match(check({}, { ...goodCfg, riotApiKey: 'RGAPI-abc ' }).errors[0], /引用符/);
  assert.match(check({}, { ...goodCfg, riotApiKey: 'abc-def' }).warnings[0], /RGAPI-/);
  assert.match(check({}, { ...goodCfg, mongoUri: ' mongodb://x/y' }).errors[0], /MONGODB_URI/);
  assert.match(check({}, { ...goodCfg, mongoUri: 'postgres://x/y' }).errors[0], /mongodb:\/\//);
  assert.match(check({}, { ...goodCfg, mongoUri: 'mongodb+srv://u:<db_password>@c.net/db' }).errors[0], /<…>/);
});

test('validateEnv: 地域・数値の書き間違いは、既定値に黙って戻る前に止める', () => {
  assert.match(check({ DEFAULT_REGION: 'japan' }).errors[0], /DEFAULT_REGION/);
  assert.match(check({ CRAWLER_REGION: 'xx' }).errors[0], /CRAWLER_REGION/);
  assert.deepEqual(check({ DEFAULT_REGION: ' KR ' }).errors, []); // 大文字小文字・空白は config と同じく許す
  assert.match(check({ PORT: 'abc' }).errors[0], /PORT/);
  assert.match(check({ PORT: '70000' }).errors[0], /範囲外/);
  assert.match(check({ MAX_DB_MB: '-1' }).errors[0], /範囲外/);
  assert.match(check({ DB_TARGET_PERCENT: '0' }).errors[0], /DB_TARGET_PERCENT/);
  assert.match(check({ RATE_HIGH_RATIO: '1.5' }).errors[0], /RATE_HIGH_RATIO/);
  assert.match(check({ MATCH_TTL_DAYS: '30日' }).errors[0], /数値ではありません/);
  assert.deepEqual(check({ MATCH_TTL_DAYS: '', MAX_MATCHES: undefined }).errors, []); // 空は「未設定」
  assert.deepEqual(check({ MAX_MATCHES: '0' }).errors, []); // 0 = 無制限
});

test('validateEnv: 警告（動くが直したほうがよいもの）', () => {
  assert.match(check({ WEBHOOK_SECRET: 'short' }).warnings[0], /WEBHOOK_SECRET/);
  assert.match(check({ SITE_PASSWORD: '1234' }).warnings[0], /SITE_PASSWORD/);
  assert.match(check({ RENDER: 'true' }).warnings[0], /TRUST_PROXY/);
  assert.deepEqual(check({ RENDER: 'true', TRUST_PROXY: '1' }).warnings, []);
  assert.match(check({ RATE_LOW_RATIO: '0.9', RATE_HIGH_RATIO: '0.5' }).warnings[0], /RATE_LOW_RATIO/);
});

test('isProduction: Render / NODE_ENV / GitHub Actions', () => {
  assert.equal(isProduction({}), false);
  assert.equal(isProduction({ RENDER: 'true' }), true);
  assert.equal(isProduction({ NODE_ENV: 'production' }), true);
  assert.equal(isProduction({ GITHUB_ACTIONS: 'true' }), true);
});

test('assertEnv: エラーがあれば一覧を出して終了コード 1、無ければ警告だけで続行', () => {
  const out = { warn: [], error: [], code: null };
  const sinks = { warn: (m) => out.warn.push(m), error: (m) => out.error.push(m), exit: (c) => { out.code = c; } };
  assertEnv({ PORT: 'x', WEBHOOK_SECRET: 'short' }, goodCfg, {}, sinks);
  assert.equal(out.code, 1);
  assert.match(out.error[0], /起動できません/);
  assert.ok(out.error.some((l) => l.includes('PORT')));
  assert.ok(out.warn.some((l) => l.includes('WEBHOOK_SECRET')));
  const ok = { warn: [], error: [], code: null };
  assertEnv({}, goodCfg, {}, { warn: (m) => ok.warn.push(m), error: (m) => ok.error.push(m), exit: (c) => { ok.code = c; } });
  assert.equal(ok.code, null);
  assert.deepEqual(ok.error, []);
});

test('起動の入口が、接続の前に環境変数を確認している', () => {
  const server = read('src', 'server.js');
  assert.ok(server.indexOf('assertEnv(process.env, config)') < server.indexOf('mongoose.connect'));
  assert.match(read('src', 'crawlerMain.js'), /assertEnv\(process\.env, config, \{ needKey: true \}\)/);
  assert.match(read('scripts', 'watchOnce.js'), /assertEnv\(process\.env, config, \{ needKey: true, needMongoUri: true \}\)/);
  assert.match(read('src', 'config', 'index.js'), /mongoUriSet:/);
});

// ---- ログ ----
test('redact: API キー・Webhook URL・MongoDB のパスワードを伏せる', () => {
  const s = redact('key RGAPI-1234-abcd-ef01 hook https://discord.com/api/webhooks/123/AbC-def_x db mongodb+srv://user:pa55@c.mongodb.net/x');
  assert.doesNotMatch(s, /1234-abcd|AbC-def|pa55|user:/);
  assert.match(s, /RGAPI-\*\*\*/);
  assert.match(s, /webhooks\/\*\*\*/);
  assert.match(s, /mongodb\+srv:\/\/\*\*\*@c\.mongodb\.net/);
});

test('describeEndpoint: ホストの先頭とパスだけ。PUUID は先頭だけ・クエリは捨てる', () => {
  const puuid = 'A'.repeat(78);
  assert.equal(describeEndpoint(`https://jp1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}?x=1`), 'jp1:/lol/summoner/v4/summoners/by-puuid/AAAAAAAA…');
  assert.equal(describeEndpoint('https://asia.api.riotgames.com/lol/match/v5/matches/JP1_123'), 'asia:/lol/match/v5/matches/JP1_123');
  assert.equal(describeEndpoint('not a url'), '');
});

test('formatError: 場所・status・呼び出し先・リクエストが 1 行に残り、秘密は出ない', () => {
  const err = Object.assign(new Error('Too Many Requests RGAPI-secret-key'), { status: 429, endpoint: 'jp1:/lol/x', attempts: 3 });
  const req = { id: 'ab12cd34', method: 'GET', path: '/summoner', query: { riotId: 'Name#JP1', region: 'jp', puuid: 'P'.repeat(78), evil: 'x', refresh: '1' } };
  const line = formatError('Route:profile', err, req);
  assert.equal(line.split('\n').length, 1); // 想定内（status あり）はスタックを付けない
  for (const part of ['[Route:profile] 失敗:', 'status=429', 'endpoint=jp1:/lol/x', 'attempts=3', 'req=ab12cd34 GET /summoner', 'riotId="Name#JP1"', 'region="jp"', 'puuid=PPPPPPPP…']) assert.ok(line.includes(part), part);
  assert.doesNotMatch(line, /secret-key|evil|refresh/);
});

test('formatError: 想定外のエラー（status なし）だけスタックを付ける。文字列や null でも落ちない', () => {
  const line = formatError('Server', new TypeError('boom'), null);
  assert.ok(line.split('\n').length > 1);
  assert.match(line, /TypeError/);
  assert.match(formatError('X', 'text'), /text/);
  assert.match(formatError('X', null), /\[X\]/);
  assert.equal(requestContext(null), null);
});

test('logRequestError: 利用者側のエラー（404 / 429）には ID を出さず、サーバー側（500 / 502 / 503）には出す', () => {
  const original = console.error;
  console.error = () => {};
  try {
    const make = () => ({ id: 'deadbeef', method: 'GET', path: '/x', query: {}, res: { locals: {} } });
    for (const [status, expected] of [[404, undefined], [429, undefined], [400, undefined], [500, 'deadbeef'], [502, 'deadbeef'], [403, 'deadbeef']]) {
      const req = make();
      logRequestError('T', Object.assign(new Error('e'), { status }), req);
      assert.equal(req.res.locals.errorId, expected, String(status));
    }
    const req = make();
    logRequestError('T', new Error('no status'), req);
    assert.equal(req.res.locals.errorId, 'deadbeef');
  } finally {
    console.error = original;
  }
});

test('requestId: 安全な X-Request-Id だけ引き継ぎ、無ければ作る。ヘッダーと res.locals にも入れる', () => {
  const run = (header) => {
    const req = { headers: header === undefined ? {} : { 'x-request-id': header } };
    const res = { locals: {}, headers: {}, setHeader(k, v) { this.headers[k] = v; } };
    requestId()(req, res, () => {});
    return { req, res };
  };
  assert.equal(run('abc12345-def').req.id, 'abc12345-def');
  assert.match(run().req.id, /^[0-9a-f]{8}$/);
  for (const bad of ['short', 'x'.repeat(65), 'has space 123456', 'line\nbreak12345', '<script>12345']) assert.match(run(bad).req.id, /^[0-9a-f]{8}$/, bad);
  const { req, res } = run();
  assert.equal(res.locals.requestId, req.id);
  assert.equal(res.headers['X-Request-Id'], req.id);
});

// ---- async の例外 ----
test('wrapHandler: async の reject と同期の throw を、どちらも next(err) へ渡す', async () => {
  const errs = [];
  const next = (e) => errs.push(e);
  wrapHandler(async () => { throw new Error('async'); })({}, {}, next);
  wrapHandler(() => { throw new Error('sync'); })({}, {}, next);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(errs.map((e) => e.message), ['sync', 'async']);
  // 正常なら next を呼ばない / 4 引数のエラー用ミドルウェアはそのまま
  const ok = [];
  wrapHandler(async () => 1)({}, {}, (e) => ok.push(e));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ok, []);
  const errMw = (err, req, res, next) => {};
  assert.equal(wrapHandler(errMw), errMw);
});

test('safeRouter: get / post の関数（複数・配列も）を包み、パスや use は触らない', async () => {
  const seen = [];
  const router = { get: (...a) => seen.push(['get', a]), post: (...a) => seen.push(['post', a]), use: (...a) => seen.push(['use', a]) };
  safeRouter(router);
  const mw = (req, res, next) => next();
  const h = async () => { throw new Error('x'); };
  router.get('/a', mw, h);
  router.post(['/b', '/c'], [mw, h]);
  router.use('/u', h);
  assert.equal(seen[0][1][0], '/a');
  assert.notEqual(seen[0][1][2], h); // 包まれている
  assert.deepEqual(seen[1][1][0], ['/b', '/c']); // パスの配列はそのまま
  assert.equal(seen[1][1][1].length, 2);
  assert.equal(seen[2][1][1], h); // use は触らない
  const errs = [];
  seen[0][1][2]({}, {}, (e) => errs.push(e));
  await new Promise((r) => setImmediate(r));
  assert.equal(errs[0].message, 'x');
});

test('全ルーターが safeRouter で包まれている（包み忘れを防ぐ）', () => {
  const dir = path.join(root, 'src', 'routes');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const s = read('src', 'routes', f);
    if (s.includes('Router()')) assert.match(s, /safeRouter\(Router\(\)\)/, f);
  }
});

// ---- プロセスの最後の砦 ----
test('installProcessGuards: 未処理の拒否はログだけ。例外が短時間に繰り返したら終了する', () => {
  const original = console.error;
  const lines = [];
  console.error = (m) => lines.push(String(m));
  try {
    const proc = new EventEmitter();
    let now = 1000;
    const exits = [];
    installProcessGuards('T', { proc, exit: (c) => exits.push(c), now: () => now, maxUncaught: 3, windowMs: 60000 });
    proc.emit('unhandledRejection', new Error('rej'));
    proc.emit('unhandledRejection', 'plain string');
    assert.deepEqual(exits, []);
    proc.emit('uncaughtException', new Error('a'));
    now += 1000; proc.emit('uncaughtException', new Error('b'));
    assert.deepEqual(exits, []);
    now += 1000; proc.emit('uncaughtException', new Error('c'));
    assert.deepEqual(exits, [1]);
    assert.ok(lines.some((l) => l.includes('[T:Process]') && l.includes('rej')));
    // 窓を過ぎれば数え直し
    exits.length = 0;
    now += 120000; proc.emit('uncaughtException', new Error('d'));
    assert.deepEqual(exits, []);
  } finally {
    console.error = original;
  }
});

// ---- 配線 ----
test('app.js: リクエスト ID と最後のエラー処理（/api は JSON・画面には ID）', () => {
  const s = read('src', 'app.js');
  assert.ok(s.indexOf('requestId()') < s.indexOf('securityHeaders()'));
  assert.match(s, /logRequestError\('Server', err, req\)/);
  assert.match(s, /res\.headersSent\) return next\(err\)/);
  assert.match(s, /req\.path\.startsWith\('\/api\/'\)[^\n]*json\(\{ error: message, requestId: req\.id \}\)/);
  assert.match(s, /responseStatus\(err\)/);
  assert.doesNotMatch(s, /err\.stack \|\| err\.message/);
  assert.match(read('src', 'views', 'error.ejs'), /locals\.errorId/);
  assert.match(read('src', 'utils', 'httpError.js'), /413:/);
});

test('ルートの console.error をやめ、文脈つきのログへ統一した', () => {
  const dir = path.join(root, 'src', 'routes');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) assert.doesNotMatch(read('src', 'routes', f), /console\.error/, f);
  assert.doesNotMatch(read('src', 'services', 'notify.js'), /console\.error/);
  assert.match(read('src', 'services', 'riotApi.js'), /lastError\.endpoint = endpoint/);
  assert.match(read('src', 'services', 'riotApi.js'), /lastError\.attempts = attempt \+ 1/);
});

test('ドキュメント・版: 6.8.0 以降の版がそろい、運用文書がエラー ID と起動チェックを説明している', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const [a, b] = pkg.version.split('.').map(Number);
  assert.ok(a > 6 || b >= 8);
  assert.ok(read('CHANGELOG.md').startsWith(`# 変更履歴\n\n## v${pkg.version}`));
  assert.match(read('CHANGELOG.md'), /## v6\.8\.0（起動前に止める/);
  assert.match(read('docs', 'OPERATIONS.md'), /エラー ID/);
  assert.match(read('docs', 'OPERATIONS.md'), /起動できません/);
  assert.match(read('docs', 'RELEASE_CHECKLIST.md'), /起動時の環境変数チェック/);
  assert.match(read('.env.example'), /起動時チェック/);
});
