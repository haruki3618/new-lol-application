import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPuuid, isMatchId, isChampId, validPatch, clampInt } from '../src/utils/validate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const routeFiles = () => fs.readdirSync(path.join(root, 'src', 'routes')).filter((n) => n.endsWith('.js'));

const PUUID = 'a'.repeat(30) + '-_' + 'B'.repeat(46); // 78 文字

test('isPuuid: 20〜100 文字の英数字・-・_ だけ。配列・オブジェクト・数値は不正', () => {
  assert.equal(isPuuid(PUUID), true);
  assert.equal(isPuuid('x'.repeat(20)), true);
  assert.equal(isPuuid('x'.repeat(19)), false);
  assert.equal(isPuuid('x'.repeat(101)), false);
  assert.equal(isPuuid('abc'), false);
  assert.equal(isPuuid(`${'x'.repeat(30)}<script>`), false);
  assert.equal(isPuuid(`${'x'.repeat(30)}\n`), false);
  assert.equal(isPuuid([PUUID]), false); // ?puuid=a&puuid=b
  assert.equal(isPuuid({ $ne: 'x' }), false); // ?puuid[$ne]=x
  assert.equal(isPuuid(undefined), false);
  assert.equal(isPuuid(12345678901234567890), false);
});

test('isMatchId: 地域コード_数字。長さに上限がある', () => {
  for (const ok of ['JP1_123456789', 'NA1_5000000000', 'EUW1_1', 'OC1_42', 'KR_7000000000']) assert.equal(isMatchId(ok), true, ok);
  for (const bad of ['', 'JP1', 'JP1_', '_123', 'JP1_12a', 'JP1_' + '1'.repeat(17), 'X'.repeat(9) + '_1', '<x>', 'JP1_1 ', ['JP1_1'], undefined]) assert.equal(isMatchId(bad), false, String(bad));
});

test('isChampId / validPatch', () => {
  for (const ok of ['Ahri', 'MonkeyKing', 'Kaisa', 'Zed']) assert.equal(isChampId(ok), true);
  for (const bad of ['', 'Ahri!', 'A'.repeat(31), 'a b', ['Ahri'], undefined, null]) assert.equal(isChampId(bad), false, String(bad));
  assert.equal(validPatch('14.10'), '14.10');
  for (const bad of ['14', '14.', '14.10.1', 'x.y', '', ['14.10'], undefined]) assert.equal(validPatch(bad), null, String(bad));
});

test('clampInt: 数字でない・0 は fallback にしてから範囲に収める（従来の Math.min/Math.max と同じ結果）', () => {
  const old = (v, min, max, fb) => Math.min(Math.max(parseInt(v, 10) || fb, min), max);
  for (const v of ['5', '10', '25', '50', '99', '0', '-3', 'abc', '', undefined, '12.7', ['30'], '30px']) {
    assert.equal(clampInt(v, 10, 50, 20), old(v, 10, 50, 20), String(v));
    assert.equal(clampInt(v, 1, 200, 1), old(v, 1, 200, 1), String(v));
  }
  assert.equal(clampInt('abc', 10, 50, 20), 20);
  assert.equal(clampInt('999', 10, 50, 20), 50);
  assert.equal(clampInt('3', 10, 50, 20), 10);
});

test('ルート: 入力の形の検証は utils/validate.js を使い、各ルートに正規表現を写していない', () => {
  for (const f of routeFiles()) {
    const s = read('src', 'routes', f);
    assert.doesNotMatch(s, /\{20,100\}/, `${f}: PUUID の正規表現が残っている`);
    assert.doesNotMatch(s, /\[A-Za-z0-9_\]\+\$/, `${f}: 試合 ID の弱い正規表現が残っている`);
    assert.doesNotMatch(s, /Math\.min\(Math\.max\(parseInt/, `${f}: 範囲指定が残っている`);
  }
  const uses = { 'sync.js': ['isPuuid', 'clampInt'], 'live.js': ['isPuuid'], 'insights.js': ['isPuuid'], 'info.js': ['isPuuid'], 'timeline.js': ['isMatchId', 'isPuuid'], 'champions.js': ['isChampId', 'validPatch'], 'profile.js': ['clampInt'], 'extra.js': ['clampInt'] };
  for (const [f, names] of Object.entries(uses)) {
    const s = read('src', 'routes', f);
    assert.match(s, /from '\.\.\/utils\/validate\.js'/, f);
    for (const n of names) assert.ok(new RegExp(`\\b${n}\\(`).test(s), `${f}: ${n} を使っていない`);
  }
  // 同期・履歴・ライブ・タブの PUUID は、形の検証のあとに「検索を通った PUUID か」も確認している（v6.6.1 のまま）
  for (const f of ['sync.js', 'live.js', 'info.js']) assert.match(read('src', 'routes', f), /isKnownPuuid\(puuid\)/, f);
});

test('timeline / detail: 試合 ID と PUUID の両方を、共通の検証で確認している', () => {
  const s = read('src', 'routes', 'timeline.js');
  assert.equal(s.split('!isMatchId(matchId) || !isPuuid(puuid)').length - 1, 2);
});

test('JSDoc: riotApi の公開関数すべてと、追加した計算関数に型注釈がある', () => {
  const targets = { riotApi: /^export function get/, buildMath: /^export (function (rolesOf|verdictOf)|const forRole)/, summarize: /^export function summarizeRecent/ };
  const missing = [];
  let count = 0;
  for (const [f, re] of Object.entries(targets)) {
    const lines = read('src', 'services', `${f}.js`).split('\n');
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      count++;
      if (!(lines[i - 1] || '').trim().endsWith('*/')) missing.push(`${f}.js:${i + 1}`);
    });
  }
  assert.ok(count >= 18, `対象が少なすぎる: ${count}`);
  assert.deepEqual(missing, []);
});

test('JSDoc: riotApi が参照する型が types.js にあり、戻り値の型は Promise', () => {
  const types = read('src', 'types.js');
  const defined = new Set([...types.matchAll(/@typedef \{[^}]*\} (\w+)/g)].map((m) => m[1]));
  for (const n of ['RiotApiOptions', 'RiotAccount', 'RiotSummoner', 'RiotMastery', 'RiotLeagueList', 'RiotMatchDto']) assert.ok(defined.has(n), n);
  const api = read('src', 'services', 'riotApi.js');
  for (const m of api.matchAll(/import\('\.\.\/types\.js'\)\.(\w+)/g)) assert.ok(defined.has(m[1]), `${m[1]} が types.js に無い`);
  const returns = [...api.matchAll(/@returns \{([^\n]*)\}/g)].map((m) => m[1]);
  assert.ok(returns.length >= 15);
  for (const r of returns) assert.match(r, /^Promise</, r);
});

test('版・文書: package.json / package-lock.json / CHANGELOG がそろい、検証の方針が文書にある', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const [a, b, c] = pkg.version.split('.').map(Number);
  assert.ok(a > 6 || b > 8 || (b === 8 && c >= 1));
  assert.ok(read('CHANGELOG.md').startsWith(`# 変更履歴\n\n## v${pkg.version}`));
  assert.match(read('CHANGELOG.md'), /## v6\.8\.1/);
  assert.match(read('docs', 'RELEASE_CHECKLIST.md'), /utils\/validate\.js/);
});
