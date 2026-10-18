import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('CSS: url / password の入力欄にも、ほかの入力欄と同じスタイルが当たる', () => {
  const css = read('src', 'public', 'css', 'app.css');
  assert.match(css, /input\[type=url\], input\[type=password\]/);
  assert.match(css, /form\.panel > input\[type=url\]/);
  // お気に入りで使っている型は、すべてスタイルの対象になっている
  const v = read('src', 'views', 'watch.ejs');
  for (const t of new Set([...v.matchAll(/<input type="([a-z]+)"/g)].map((m) => m[1]))) {
    if (t === 'hidden') continue;
    assert.ok(css.includes(`input[type=${t}]`), `type=${t} のスタイルがある`);
  }
});

test('ランキング: 勝敗の内訳はスマホで隠せる（.hide-sp）', () => {
  assert.match(read('src', 'views', 'ranking.ejs'), /class="xs hide-sp"/);
  assert.match(read('src', 'public', 'css', 'app.css'), /\.hide-sp \{ display: none; \}/);
});

test('版数: 6.10.2 以降で、CHANGELOG に v6.10.2 の節がある', () => {
  const [a, b, c] = JSON.parse(read('package.json')).version.split('.').map(Number);
  assert.ok(a > 6 || b > 10 || (b === 10 && c >= 2));
  assert.match(read('CHANGELOG.md'), /## v6\.10\.2/);
});
