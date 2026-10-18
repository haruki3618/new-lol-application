import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const views = fs.readdirSync(path.join(root, 'src', 'views')).filter((f) => f.endsWith('.ejs'));

test('CSS: タッチ端末では入力欄が 16px（iOS の自動ズーム防止）で、ボタン・メニュー・タブが 44px 以上', () => {
  const css = read('src', 'public', 'css', 'app.css');
  const block = css.split('/* ---------- v6.9.1')[1];
  assert.ok(block, 'v6.9.1 のブロックがある');
  assert.match(block, /@media \(pointer: coarse\)/);
  assert.match(block, /\.nav-search select[^{]*\{\s*font-size: 16px/);
  assert.match(block, /\.nav-links a, \.btn, \.btn\.sm, \.tab, \.theme-btn \{[^}]*min-height: 44px/);
  // PC の見た目を変えない: 44px の指定は pointer: coarse のブロックの中だけ
  assert.equal(css.split('min-height: 44px').length - 1, css.slice(css.indexOf('@media (pointer: coarse)')).split('min-height: 44px').length - 1);
});

test('トップ: autofocus を HTML に持たず、PC（hover + fine）だけ JS でフォーカスする', () => {
  assert.doesNotMatch(read('src', 'views', 'index.ejs'), /autofocus/);
  const js = read('src', 'public', 'js', 'app.js');
  assert.match(js, /\(hover: hover\) and \(pointer: fine\)/);
  assert.match(js, /\.searchbox \[data-riotid\]/);
});

test('表: thead の見出しはすべて scope="col"（見出し行の <th> に scope が無いものが無い）', () => {
  let total = 0;
  for (const f of views) {
    for (const line of read('src', 'views', f).split('\n')) {
      if (!line.includes('<thead>')) continue;
      assert.doesNotMatch(line, /<th>/, `${f}: scope の無い <th>`);
      total += (line.match(/<th scope="col">/g) || []).length;
    }
  }
  assert.ok(total >= 60, `scope 付きの見出しが ${total} 個しかない`);
});

test('_head: twitter:card は 1 か所だけ', () => {
  const head = read('src', 'views', '_head.ejs');
  assert.equal(head.split('twitter:card').length - 1, 1);
  assert.match(head, /og:image/);
});

test('Node: engines は 22 以上、CI は Node 22 / 24 で、Node 18 / 20 を使わない', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.engines.node, '>=22');
  assert.equal(lock.packages[''].engines.node, '>=22');
  const ci = read('.github', 'workflows', 'test.yml');
  assert.match(ci, /node: \[22, 24\]/);
  for (const f of fs.readdirSync(path.join(root, '.github', 'workflows'))) {
    assert.doesNotMatch(read('.github', 'workflows', f), /node-version: (18|20)\b/, f);
  }
});

test('Data Dragon: 固定の版は「年−10 . パッチ . 1」の形で、2026 年のもの', () => {
  const src = read('src', 'services', 'ddragon.js');
  const m = /const FALLBACK_VERSION = '(\d+)\.(\d+)\.(\d+)'/.exec(src);
  assert.ok(m, 'FALLBACK_VERSION が読めない');
  assert.ok(Number(m[1]) >= 16, `古い固定値: ${m[0]}`);
  assert.match(read('docs', 'RELEASE_CHECKLIST.md'), /FALLBACK_VERSION/);
});

test('版・文書: 6.9.1 以降で、CHANGELOG に実装しなかったものと確認できていないことがある', () => {
  const pkg = JSON.parse(read('package.json'));
  const [a, b, c] = pkg.version.split('.').map(Number);
  assert.ok(a > 6 || b > 9 || (b === 9 && c >= 1));
  const log = read('CHANGELOG.md');
  const section = log.split('## v6.9.0')[0];
  assert.match(section, /実装しなかったもの/);
  assert.match(section, /確認できていないこと/);
  assert.match(read('README.md'), /## v6\.9\.1 の変更/);
});
