import test from 'node:test';
import assert from 'node:assert/strict';
import { weekStartOf, weekLabel, buildWeeks, shouldReplace, collapseWeeks } from '../src/services/weekMath.js';

const JST = 9 * 3600000;
const at = (iso) => Date.parse(iso); // 例: '2026-10-12T00:00:00+09:00'

test('weekStartOf: 日本時間の月曜 0:00。日曜の深夜は前の週、月曜の 0:00 ちょうどは新しい週', () => {
  const mon = at('2026-10-12T00:00:00+09:00'); // 2026-10-12 は月曜
  assert.equal(weekLabel(weekStartOf(mon)), '2026-10-12');
  assert.equal(weekStartOf(mon), mon);
  assert.equal(weekLabel(weekStartOf(mon - 1)), '2026-10-05', '日曜 23:59:59 は前の週');
  assert.equal(weekLabel(weekStartOf(at('2026-10-18T23:59:00+09:00'))), '2026-10-12', '日曜は週の最後');
  assert.equal(new Date(weekStartOf(mon) + JST).getUTCDay(), 1, '日本時間で月曜');
});

const G = (iso, over = {}) => ({ t: at(iso), dur: 1800, win: true, q: 420, champ: 'Ahri', k: 5, d: 2, a: 7, cs: 180, vis: 30, dmg: 20000, gold: 12000, ...over });

test('buildWeeks: 週とキューで分け、リメイクは除く', () => {
  const weeks = buildWeeks([
    G('2026-10-12T10:00:00+09:00'), G('2026-10-13T10:00:00+09:00', { win: false, champ: 'Zed' }),
    G('2026-10-14T10:00:00+09:00', { q: 450 }), G('2026-10-05T10:00:00+09:00'),
    G('2026-10-12T12:00:00+09:00', { dur: 120 }) // リメイク
  ]);
  assert.equal(weeks.length, 3);
  assert.equal(weeks[0].weekStart > weeks[2].weekStart, true, '新しい週が先');
  const w = weeks.find((x) => weekLabel(x.weekStart) === '2026-10-12' && x.queueId === 420);
  assert.equal(w.games, 2);
  assert.equal(w.wins, 1);
  assert.deepEqual(w.champs.map((c) => c.name).sort(), ['Ahri', 'Zed']);
});

test('shouldReplace: 保存済みより少ない試合数では上書きしない', () => {
  assert.equal(shouldReplace(null, { games: 1 }), true);
  assert.equal(shouldReplace({ games: 10 }, { games: 4 }), false, '古い試合が消えて縮んだ再計算を保存しない');
  assert.equal(shouldReplace({ games: 4 }, { games: 4 }), true);
  assert.equal(shouldReplace({ games: 4 }, { games: 9 }), true);
});

test('collapseWeeks: キューで絞る／null なら全キュー合算。KDA・CS/分を付ける', () => {
  const stored = buildWeeks([G('2026-10-12T10:00:00+09:00'), G('2026-10-12T11:00:00+09:00', { q: 450, win: false, k: 0, d: 4, a: 0 })]);
  const all = collapseWeeks(stored, null);
  assert.equal(all.length, 1);
  assert.equal(all[0].games, 2);
  assert.equal(all[0].winRate, 50);
  assert.equal(all[0].kda, 2); // (5+7+0+0)/(2+4)
  assert.equal(all[0].label, '2026-10-12');
  assert.equal(collapseWeeks(stored, 420)[0].games, 1);
  assert.deepEqual(collapseWeeks(stored, 999), []);
  assert.deepEqual(collapseWeeks([], null), []);
});
