import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import app from '../src/app.js';
import { makeHelpers } from '../src/utils/ddHelpers.js';
import { ROLE_LABELS } from '../src/constants/roles.js';
import { QUEUE_FILTERS } from '../src/constants/queues.js';
import { analyzeDuo } from '../src/services/duoMath.js';
import { buildReport } from '../src/services/reportMath.js';

const views = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views');
const h = makeHelpers({ version: '15.1.1', champNames: { Ahri: 'アーリ' }, champKeyToId: {}, spells: {}, runes: {} });
const render = (name, data) => ejs.renderFile(path.join(views, `${name}.ejs`), { h, ...data }, { views: [views] });

const part = (puuid, teamId, win) => ({ puuid, teamId, win, championName: 'Ahri', teamPosition: 'MIDDLE', kills: 4, deaths: 2, assists: 6, totalMinionsKilled: 150, visionScore: 20 });

test('テンプレート: デュオ比較（入力前・エラー・共通試合なし・結果あり）', async () => {
  const base = { title: 'デュオ比較', active: 'duo', rawA: '', rawB: '', roleLabels: ROLE_LABELS, result: null, error: null, names: null };
  assert.match(await render('compare', base), /デュオ \/ 対戦比較/);
  assert.match(await render('compare', { ...base, error: '形式が違います' }), /形式が違います/);

  const names = { a: 'a#JP1', b: 'b#JP1' };
  assert.match(await render('compare', { ...base, names, result: analyzeDuo([], 'A', 'B') }), /共通の試合が保存されていません/);

  const ms = Array.from({ length: 6 }, (_, i) => ({ matchId: `M${i}`, gameCreation: 1700000000000 + i, participants: [part('A', 100, i < 4), part('B', 100, i < 4)] }));
  const html = await render('compare', { ...base, names, result: analyzeDuo(ms, 'A', 'B') });
  assert.match(html, /4勝2敗/);
  assert.match(html, /アーリ/);
});

test('テンプレート: 週間レポート（試合あり・なし）', async () => {
  const now = 1_800_000_000_000;
  const common = { title: '週間レポート', active: '', riotId: 'a#JP1', period: 'week', queueId: 420, queues: QUEUE_FILTERS.filter((q) => q.id) };
  const empty = await render('report', { ...common, report: buildReport([], 'me', { now }) });
  assert.match(empty, /保存されている試合がありません/);

  const ms = [1, 2, 3].map((d, i) => ({ matchId: `M${i}`, gameCreation: now - d * 86400000, gameDuration: 1800, participants: [part('me', 100, i !== 2)] }));
  const html = await render('report', { ...common, report: buildReport(ms, 'me', { now, snapshots: [{ at: now - 3 * 86400000, value: 1000 }, { at: now - 86400000, value: 1040 }] }) });
  assert.match(html, /2勝1敗/);
  assert.match(html, /\+40/);
});

test('テンプレート: お気に入り追跡（Webhook URL は画面に出さない）', async () => {
  const items = [{ name: 'a#JP1', tier: 'GOLD II 50LP', consecutiveLosses: 3, lastCheckedAt: null }];
  const base = { title: 'お気に入り追跡', active: 'watch', items, total: 1, max: 30, message: null, error: null, needKey: false };

  // WATCH_PUBLIC_LIST=1 のとき: 一覧を表示する
  const open = await render('watch', { ...base, publicList: true });
  assert.match(open, /a#JP1/);
  assert.match(open, /3連敗中/);
  assert.doesNotMatch(open, /api\/webhooks\/\d/);
  assert.doesNotMatch(open, /name="registerKey"/);

  // 既定: 件数だけで、プレイヤー名は出さない
  const hidden = await render('watch', { ...base, publicList: false, items: [] });
  assert.match(hidden, /1 \/ 30/);
  assert.doesNotMatch(hidden, /a#JP1/);

  // 登録キーを要求する設定のとき: 入力欄が出る
  const keyed = await render('watch', { ...base, publicList: false, needKey: true, items: [] });
  assert.match(keyed, /name="registerKey"/);
});

test('ルート: レポートは Riot ID が不正なら 400（DB・API を使わずに返る）', async () => {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/report?riotId=bad`);
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
