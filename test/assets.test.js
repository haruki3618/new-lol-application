import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import app from '../src/app.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('app.css: テンプレートで使う主要なクラスにスタイルがある', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');
  for (const k of ['nav', 'panel', 'match', 'm-detail', 'tab-pane', 'tbl', 'pill', 'hex', 'banner', 'sync-bar', 'tl-svg', 'skel', 'grid3', 'tier-GOLD']) {
    assert.match(css, new RegExp('[.\\-]' + k + '\\b'), `.${k} のスタイルが無い`);
  }
});

test('app.js: 構文が正しく、タブ・試合の開閉・同期・詳細の呼び出しを含む', () => {
  const file = path.join(root, 'public', 'js', 'app.js');
  execFileSync(process.execPath, ['--check', file]);
  const src = fs.readFileSync(file, 'utf8');
  for (const k of ['data-tabs', 'data-collapse', '/api/sync/start', '/api/timeline', '/api/detail', 'lpChart']) {
    assert.ok(src.includes(k), `${k} が app.js に無い`);
  }
});

test('/api/detail: 不正な入力は 400', async () => {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/detail?matchId=%3Cx%3E&puuid=abc`)).status, 400);
    assert.equal((await fetch(`${base}/api/detail`)).status, 400);
  } finally {
    server.close();
  }
});
