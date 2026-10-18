import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { makeHelpers } from '../src/utils/ddHelpers.js';
import { analyze } from '../src/services/insightsMath.js';
import { analyzePerformance } from '../src/services/perfMath.js';
import { aggregateTimelines } from '../src/services/timelineAggMath.js';
import { buildWeeks, collapseWeeks } from '../src/services/weekMath.js';

const views = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views');
const h = makeHelpers({ version: '15.1.1', champNames: { Ahri: 'アーリ' }, champKeyToId: {}, spells: {}, runes: {} });
const render = (data) => ejs.renderFile(path.join(views, 'insights.ejs'), { h, ...data }, { views: [views] });

const games = Array.from({ length: 60 }, (_, i) => ({
  t: 1.76e12 + i * 7.2e6, dur: 1800, win: i % 3 !== 0, champ: i % 2 ? 'Ahri' : 'Zed', role: 'MIDDLE', q: 420,
  k: 5, d: i < 40 ? 4 : 9, a: 7, cs: 200, vis: 30, dmg: 20000, gold: 12000
}));
const base = { puuid: 'p'.repeat(78), queueId: 420, queues: [{ id: 420, label: 'ソロ' }], roleLabels: { MIDDLE: 'ミッド' }, name: 'x#JP1', loaded: 60, capped: false, r: analyze(games), matchTtlDays: 30 };
const A = (win, team15) => ({ me: { win }, checkpoints: [{ min: 15, csDiff: 6, goldDiff: -400, teamDiff: team15 }], peak: { lead: { v: 4000 }, deficit: null }, earlyDeaths: 2 });
const tl = { requested: 20, missing: 8, fetched: 0, failed: 0, ...aggregateTimelines([...Array.from({ length: 6 }, (_, i) => A(i < 4, 2000)), ...Array.from({ length: 6 }, (_, i) => A(i < 1, -2000))]) };

test('診断の画面: プレイ内容・週ごとの推移・タイムライン集計が描画できる（取得ボタンは POST）', async () => {
  const html = await render({ ...base, perf: analyzePerformance(games), weeks: collapseWeeks(buildWeeks(games), 420), tl, tlNote: { fetched: 3, failed: 1, asked: true } });
  for (const s of ['プレイ内容', '直近の変化', 'デス数別の勝率', '週ごとの推移', 'タイムライン集計', '3 試合ぶんを取得しました']) assert.ok(html.includes(s), s);
  assert.match(html, /<form method="post" action="\/insights\/p{78}\/timeline"/, '取得は POST（GET のリンクで API 枠を使わせない）');
  assert.match(html, /name="queue" value="420"/);
});

test('診断の画面: 新しい変数が渡されなくても（従来の呼び出しでも）描画できる', async () => {
  const html = await render(base);
  assert.ok(!html.includes('プレイ内容'));
  assert.ok(html.includes('プレイ傾向の診断'));
});

test('診断の画面: 試合が 1 件も残っていなくても、週ごとの推移は出る（試合が期限で消えたあとの長期の推移）', async () => {
  const html = await render({ ...base, r: analyze([]), perf: analyzePerformance([]), weeks: collapseWeeks(buildWeeks(games), 420), tl: null });
  assert.ok(html.includes('まだ保存されていません'));
  assert.ok(html.includes('週ごとの推移'));
});

test('診断の画面: 全キュー（queueId = null）の取得ボタンは queue=all を送る', async () => {
  const html = await render({ ...base, queueId: null, perf: analyzePerformance(games), weeks: [], tl });
  assert.match(html, /name="queue" value="all"/);
});
