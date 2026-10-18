import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, annotate, wilson, zDiff, DEFAULTS, JST_OFFSET_MS } from '../src/services/insightsMath.js';

const MIN = 60000;
const HOUR = 3600000;
// 日本時間の「年-月-日 時:分」から試合開始のミリ秒を作る
const jst = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS;
const g = (t, win, champ = 'Ahri', role = 'MIDDLE', dur = 1800) => ({ t, win, champ, role, dur });

test('wilson / zDiff: 少ない試合数は幅が広く、差が無ければ z は 0', () => {
  const small = wilson(3, 3);
  assert.ok(small.hi === 100 && small.lo < 50, '3戦3勝でも下限は低い');
  const big = wilson(300, 300);
  assert.ok(big.lo > 98);
  assert.equal(zDiff(10, 20, 10, 20), 0);
  assert.equal(zDiff(0, 0, 5, 10), null);
  assert.ok(zDiff(80, 100, 40, 100) > 5);
});

test('annotate: 60分を超える空きで別セッション、リメイクは除外、連敗・連勝の数え方', () => {
  const t0 = jst(2025, 1, 10, 20);
  const rows = annotate([
    g(t0, false),
    g(t0 + 40 * MIN, false),
    g(t0 + 80 * MIN, true), // 2連敗の直後
    g(t0 + 120 * MIN, true), // 勝ちの直後
    g(t0 + 5 * HOUR, false), // 前の試合の終了から60分超 → 新セッション
    g(t0 + 5 * HOUR + 10 * MIN, true, 'Zed', 'MIDDLE', 120) // 120秒 = リメイク（除外）
  ]);
  assert.equal(rows.rows.length, 5);
  assert.equal(rows.sessions, 2);
  const r = rows.rows;
  assert.deepEqual([r[0].idx, r[1].idx, r[2].idx, r[3].idx, r[4].idx], [1, 2, 3, 4, 1]);
  assert.equal(r[2].lossRun, 2);
  assert.equal(r[3].winRun, 1);
  assert.equal(r[4].lossRun, 0, '新しいセッションでは連敗がリセットされる');
});

test('annotate: 時間帯は日本時間（サーバーの時刻設定に依存しない）', () => {
  const { rows } = annotate([g(jst(2025, 3, 1, 0, 30)), g(jst(2025, 3, 1, 23, 59)), g(jst(2025, 3, 2, 6, 0))]);
  assert.deepEqual(rows.map((r) => r.hour), [0, 23, 6]);
});

// 6セッション分の、連敗後だけ勝てないデータを作る
function tiltData() {
  const games = [];
  let day = 1;
  for (let s = 0; s < 20; s++) {
    const t0 = jst(2025, 2, day++, 20);
    // 負け・負け のあとの3試合目は必ず負け、それ以外は勝ち
    games.push(g(t0, false), g(t0 + 35 * MIN, false), g(t0 + 70 * MIN, false), g(t0 + 105 * MIN, true), g(t0 + 140 * MIN, true));
  }
  return games;
}

test('analyze: 基本の集計（試合数・セッション数・連敗後の区分）', () => {
  const r = analyze(tiltData());
  assert.equal(r.reliable, true);
  assert.equal(r.total.games, 100);
  assert.equal(r.streakLossMulti.games, 40);
  assert.equal(r.streakLossMulti.winRate, 50); // 3試合目は必ず負け（0%）、4試合目は勝ち（100%）
  assert.ok(r.findings.every((f) => typeof f.text === 'string'));
});

test('analyze: 連敗後に確実に負けるデータ → warn の所見', () => {
  const games = [];
  for (let s = 0; s < 25; s++) {
    const t0 = jst(2025, 4, 1 + s, 21);
    // 1試合目 負け、2試合目 負け、3試合目 負け（連敗後は常に負け）、別日は 2連勝
    games.push(g(t0, false), g(t0 + 35 * MIN, false), g(t0 + 70 * MIN, false));
    games.push(g(t0 + 20 * HOUR, true), g(t0 + 20 * HOUR + 35 * MIN, true));
  }
  const r = analyze(games);
  assert.equal(r.streakLossMulti.winRate, 0);
  assert.equal(r.streakLossMulti.significant, true);
  assert.ok(r.findings.some((f) => f.level === 'warn' && f.text.includes('2連敗以上')));
});

test('analyze: 試合数が足りなければ診断しない / 空でも落ちない', () => {
  const few = analyze(Array.from({ length: 10 }, (_, i) => g(jst(2025, 5, 1 + i, 20), i % 2 === 0)));
  assert.equal(few.reliable, false);
  assert.deepEqual(few.findings, []);
  const none = analyze([]);
  assert.equal(none.total.games, 0);
  assert.equal(none.pool, null);
  assert.deepEqual(none.findings, []);
});

test('analyze: どの区分でも勝率が同じなら所見は出ない（偏りが無いのも結果）', () => {
  const hours = [2, 8, 14, 20];
  // 1日1試合ずつ、時間帯ごとに勝ち負けが交互 → どの時間帯も 50%、連敗もセッション内の順番も関係なし
  const games = Array.from({ length: 48 }, (_, i) => g(jst(2025, 6, 1 + i, hours[i % 4]), Math.floor(i / 4) % 2 === 0));
  const r = analyze(games);
  assert.equal(r.total.winRate, 50);
  assert.equal(r.reliable, true);
  assert.deepEqual(r.findings.filter((f) => f.level !== 'info'), []);
  assert.ok(r.hours.every((b) => b.winRate === 50 && !b.significant));
});

test('analyze: 試合数が少ない区分は significant にならない（minBucket）', () => {
  const games = [];
  for (let s = 0; s < 12; s++) {
    const t0 = jst(2025, 7, 1 + s, 20);
    games.push(g(t0, true), g(t0 + 35 * MIN, true), g(t0 + 70 * MIN, true));
  }
  // 深夜（3時）の試合を 5 戦 5 敗（少数）
  for (let s = 0; s < 5; s++) games.push(g(jst(2025, 8, 1 + s, 3), false));
  const r = analyze(games);
  const late = r.hours.find((b) => b.key === 'late');
  assert.equal(late.games, 5);
  assert.equal(late.significant, false);
  assert.equal(late.few, true);
});

test('analyze: チャンピオンプールの集計（上位・使用率・半分に必要な体数）', () => {
  const games = [];
  let t = jst(2025, 9, 1, 20);
  const push = (champ, win, n) => { for (let i = 0; i < n; i++) { games.push(g(t, win, champ)); t += 2 * HOUR; } };
  push('Ahri', true, 20); push('Ahri', false, 10);
  push('Zed', true, 5); push('Zed', false, 5);
  push('Lux', false, 4); push('Yasuo', true, 3); push('Teemo', false, 3);
  const r = analyze(games);
  assert.equal(r.total.games, 50);
  assert.equal(r.pool.unique, 5);
  assert.equal(r.pool.top[0].name, 'Ahri');
  assert.equal(r.pool.top1Share, 60);
  assert.equal(r.pool.halfCount, 1);
  assert.equal(r.pool.top3Share, 88);
  assert.ok(r.findings.some((f) => f.text.includes('60%')), '1体で半分以上を占める所見');
  assert.equal(r.roles[0].role, 'MIDDLE');
});

test('DEFAULTS: 判定の基準値が極端でない', () => {
  assert.ok(DEFAULTS.minBucket >= 10 && DEFAULTS.minTotal >= 30 && DEFAULTS.minDiffPt >= 5);
});
