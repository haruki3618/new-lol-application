import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('CSS: ナビは var(--bg) に追従し、試合カードはコンテナクエリで切り替わる', () => {
  const css = read('src', 'public', 'css', 'app.css');
  assert.doesNotMatch(css, /\.nav \{[^}]*rgba\(11,18,32/, 'ナビの背景色を固定しない（ライトテーマで読めなくなる）');
  assert.match(css, /\.match \{ container: match \/ inline-size; \}/);
  assert.match(css, /@container match \(max-width: 659px\)/);
  assert.match(css, /--on-gold/);
  assert.doesNotMatch(css, /font-size: *1[01]px/, '補足の文字は 12px 未満にしない');
});

test('試合カード: 列の名前（m-res / m-champ / m-kda / m-sc / m-items / m-cs）が付いている', () => {
  const v = read('src', 'views', '_match.ejs');
  for (const k of ['m-res', 'm-champ', 'm-kda', 'm-sc', 'm-items', 'm-cs', 'm-mini']) assert.ok(v.includes(k), k);
});

test('トップ: 検索欄は 1 つの部品で、ナビの検索欄は出さない。最近の検索の置き場がある', () => {
  const idx = read('src', 'views', 'index.ejs');
  assert.match(idx, /hideNavSearch: true/);
  assert.match(idx, /data-recent/);
  assert.match(read('src', 'views', '_head.ejs'), /hideNavSearch/);
});

test('app.js: 最近の検索は textContent で組み立て、innerHTML を使わない。構文が正しい', () => {
  const file = path.join(root, 'src', 'public', 'js', 'app.js');
  execFileSync(process.execPath, ['--check', file]);
  const js = read('src', 'public', 'js', 'app.js');
  const block = js.slice(js.indexOf('最近の検索（v6.10.0）'), js.indexOf('429 の画面'));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /innerHTML/);
  assert.match(block, /recentSearches/);
});

test('版数: 6.10.0 以降で、CHANGELOG に v6.10.0 の節がある', () => {
  const [a, b] = JSON.parse(read('package.json')).version.split('.').map(Number);
  assert.ok(a > 6 || b >= 10);
  assert.match(read('CHANGELOG.md'), /## v6\.10\.0（画面の見直し）/);
});
