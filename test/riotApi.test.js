import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { config } from '../src/config/index.js';
import { getSummonerByPUUID, RiotApiError } from '../src/services/riotApi.js';
import { keyStatus } from '../src/services/keyStatus.js';
import { limiter } from '../src/services/riotLimiter.js';

// axios.get を差し替えて、Riot API の応答を再現する（実際には通信しない）
const realGet = axios.get;
const httpError = (status, headers = {}, message = 'err') => Object.assign(new Error(message), { response: { status, headers, data: { status: { message } } } });
test.afterEach(() => { axios.get = realGet; });
test.before(() => { config.riotApiKey = 'RGAPI-old'; });

test('成功: データを返し、キーを有効と記録し、上限をヘッダーから学習する', async () => {
  axios.get = async () => ({ data: { ok: 1 }, headers: { 'x-app-rate-limit': '500:10,30000:600' } });
  const data = await getSummonerByPUUID('p1');
  assert.deepEqual(data, { ok: 1 });
  assert.equal(keyStatus.state, 'valid');
  assert.deepEqual(limiter.windows, [{ max: 500, windowMs: 10000 }, { max: 30000, windowMs: 600000 }]);
  limiter.learn({ 'x-app-rate-limit': '20:1,100:120' }); // 元に戻す
});

test('429（アプリ全体）: Retry-After の間だけ止まって、やり直して成功する', async () => {
  let calls = 0;
  axios.get = async () => {
    calls += 1;
    if (calls === 1) throw httpError(429, { 'retry-after': '1', 'x-rate-limit-type': 'application' });
    return { data: { ok: 2 }, headers: {} };
  };
  const start = Date.now();
  const data = await getSummonerByPUUID('p2');
  assert.deepEqual(data, { ok: 2 });
  assert.equal(calls, 2);
  assert.ok(Date.now() - start >= 1000, '1秒以上待ってからやり直す');
});

test('404 は再試行せずそのまま投げる', async () => {
  let calls = 0;
  axios.get = async () => { calls += 1; throw httpError(404, {}, 'not found'); };
  await assert.rejects(() => getSummonerByPUUID('p3'), (e) => e instanceof RiotApiError && e.status === 404);
  assert.equal(calls, 1);
});

test('401: .env に新しいキーがあれば、再起動なしで切り替えて成功する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-env-'));
  fs.writeFileSync(path.join(dir, '.env'), 'RIOT_API_KEY=RGAPI-new\n');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const used = [];
    axios.get = async (url, opts) => {
      used.push(opts.headers['X-Riot-Token']);
      if (opts.headers['X-Riot-Token'] === 'RGAPI-old') throw httpError(401, {}, 'Unauthorized');
      return { data: { ok: 3 }, headers: {} };
    };
    const data = await getSummonerByPUUID('p4');
    assert.deepEqual(data, { ok: 3 });
    assert.deepEqual(used, ['RGAPI-old', 'RGAPI-new']);
    assert.equal(config.riotApiKey, 'RGAPI-new');
    assert.equal(keyStatus.state, 'valid');
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('403 でも、軽い API が通るならキー失効とは見なさない（そのAPIだけ権限なし）', async () => {
  config.riotApiKey = 'RGAPI-new';
  keyStatus.markValid();
  axios.get = async (url) => {
    if (String(url).includes('status/v4')) return { data: {}, headers: {} };
    throw httpError(403, {}, 'Forbidden');
  };
  await assert.rejects(() => getSummonerByPUUID('p5'), (e) => e.status === 403);
  assert.equal(keyStatus.invalid, false);
});
