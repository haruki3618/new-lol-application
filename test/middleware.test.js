import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { compression } from '../src/middleware/compression.js';
import { ipLimiter } from '../src/middleware/ipLimiter.js';
import { securityHeaders, CSP } from '../src/middleware/security.js';

// Express なしで middleware を試すための小さなサーバー
function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
function get(port, headers = {}, path = '/') {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const BIG = '<p>こんにちは LoL Analytics</p>'.repeat(300);

test('compression: gzip を受け付けるクライアントには圧縮して返す', async () => {
  const { server, port } = await serve((req, res) =>
    compression()(req, res, () => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(BIG));
      res.end(BIG);
    }));
  const { res, body } = await get(port, { 'Accept-Encoding': 'gzip' });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.headers['content-length'], undefined);
  assert.match(res.headers.vary, /Accept-Encoding/);
  assert.equal(zlib.gunzipSync(body).toString(), BIG);
  server.close();
});

test('compression: write を分割しても壊れない', async () => {
  const { server, port } = await serve((req, res) =>
    compression()(req, res, () => {
      res.setHeader('Content-Type', 'application/json');
      res.write(BIG.slice(0, 1000));
      res.write(BIG.slice(1000));
      res.end();
    }));
  const { res, body } = await get(port, { 'Accept-Encoding': 'gzip, deflate' });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(body).toString(), BIG);
  server.close();
});

test('compression: gzip 非対応・画像・小さい応答はそのまま返す', async () => {
  const { server, port } = await serve((req, res) =>
    compression()(req, res, () => {
      if (req.url === '/img') { res.setHeader('Content-Type', 'image/png'); return res.end(Buffer.alloc(5000)); }
      if (req.url === '/small') { res.setHeader('Content-Type', 'text/plain'); res.setHeader('Content-Length', 5); return res.end('hello'); }
      res.setHeader('Content-Type', 'text/html');
      res.end(BIG);
    }));
  const plain = await get(port, {});
  assert.equal(plain.res.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), BIG);
  const img = await get(port, { 'Accept-Encoding': 'gzip' }, '/img');
  assert.equal(img.res.headers['content-encoding'], undefined);
  const small = await get(port, { 'Accept-Encoding': 'gzip' }, '/small');
  assert.equal(small.res.headers['content-encoding'], undefined);
  assert.equal(small.body.toString(), 'hello');
  server.close();
});

test('ipLimiter: 上限を超えたら 429 と Retry-After を返す', async () => {
  const limiter = ipLimiter({ windowMs: 60000, max: 3, message: 'too many' });
  const { server, port } = await serve((req, res) => {
    req.ip = '1.2.3.4';
    limiter(req, res, () => res.end('ok'));
  });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await get(port)).res.statusCode);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const last = await get(port);
  assert.ok(Number(last.res.headers['retry-after']) >= 1);
  assert.equal(last.body.toString(), 'too many');
  server.close();
});

test('ipLimiter: IP ごとに数え、時間が経てば解除される', async () => {
  let t = 0;
  const limiter = ipLimiter({ windowMs: 1000, max: 1, now: () => t });
  const call = (ip) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() { this.ended = true; }, statusCode: 200 };
    let passed = false;
    limiter({ ip, headers: {}, url: '/' }, res, () => { passed = true; });
    return passed;
  };
  assert.equal(call('a'), true);
  assert.equal(call('a'), false);
  assert.equal(call('b'), true);
  t = 1500;
  assert.equal(call('a'), true);
});

test('securityHeaders: 主要なヘッダーが付く。HSTS は HTTPS のときだけ', () => {
  const run = (secure) => {
    const headers = {};
    securityHeaders()({ secure }, { setHeader: (k, v) => { headers[k] = v; } }, () => {});
    return headers;
  };
  const h = run(false);
  assert.equal(h['Content-Security-Policy'], CSP);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['Strict-Transport-Security'], undefined);
  assert.ok(run(true)['Strict-Transport-Security']);
  assert.match(CSP, /ddragon\.leagueoflegends\.com/);
  assert.doesNotMatch(CSP, /cdn\.jsdelivr\.net/, 'Chart.js は自前配信なので CDN は許可しない');
});
