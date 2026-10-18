import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('プロフィール: バナーの操作は .banner-actions にまとめ、過去の試合の読み込みは専用の置き場に出る', () => {
  const v = read('src', 'views', 'profile.ejs');
  assert.match(v, /class=\"banner-actions\"/);
  assert.match(v, /data-history-host/);
  assert.equal((v.match(/href=\"\/insights\//g) || []).length, 1, 'プレイ傾向のリンクはテンプレートに 1 つ');
  assert.match(v, /class=\"stat-strip\"/);
});

test('history.js / insights.js: 専用の置き場を使い、プレイ傾向のリンクを二重に足さない', () => {
  for (const f of ['history.js', 'insights.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, 'src', 'public', 'js', f)]);
  }
  assert.match(read('src', 'public', 'js', 'history.js'), /\[data-history-host\]/);
  assert.match(read('src', 'public', 'js', 'insights.js'), /a\[href\^=\"\/insights\/\"\]/);
});

test('CSS: 名前の欄に最低幅があり、スマホではボタンが 2 列になる', () => {
  const css = read('src', 'public', 'css', 'app.css');
  assert.match(css, /\.banner \.in > \.grow \{ flex: 1 1 15em; min-width: min\(100%, 12em\); \}/);
  const mobile = css.slice(css.lastIndexOf('@media (max-width: 640px)'));
  assert.match(mobile, /\.banner-actions \{ display: grid; grid-template-columns: 1fr 1fr;/);
  assert.doesNotMatch(css, /\.banner \.in > \.flex\.wrapf/, '古いセレクターは残さない');
});

test('チャンピオン詳細: 絞り込みのフォームはバナーの外にある', () => {
  const v = read('src', 'views', 'champion.ejs');
  const bannerEnd = v.indexOf('</div>\n</div>\n', v.indexOf('class=\"banner\"'));
  const form = v.indexOf('champ-filter');
  assert.ok(bannerEnd > 0 && form > bannerEnd, 'フォームはバナーの後ろ');
  assert.equal((v.match(/<form /g) || []).length, 1);
});

test('版数: 6.10.1 以降で、CHANGELOG の先頭が v6.x.y', () => {
  const [a, b, c] = JSON.parse(read('package.json')).version.split('.').map(Number);
  assert.ok(a > 6 || b > 10 || (b === 10 && c >= 1));
  assert.match(read('CHANGELOG.md'), /^# 変更履歴\s+## v6\.\d+\.\d+/);
});
