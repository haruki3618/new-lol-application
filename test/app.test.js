import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import app from '../src/app.js';
import { makeHelpers } from '../src/utils/ddHelpers.js';
import { buildTierList } from '../src/services/tierList.js';
import { analyze } from '../src/services/insightsMath.js';
import { QUEUE_FILTERS } from '../src/constants/queues.js';
import { ROLE_LABELS } from '../src/constants/roles.js';
import { BAND_GROUPS } from '../src/constants/bands.js';

const views = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views');
const h = makeHelpers({ version: '15.1.1', champNames: { Ahri: 'アーリ' }, champKeyToId: {}, spells: {}, runes: {} });
const render = (name, data) => ejs.renderFile(path.join(views, `${name}.ejs`), { h, ...data }, { views: [views] });
const QUEUES = QUEUE_FILTERS.filter((q) => q.id);

async function withServer(fn) {
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('サーバー: 静的ファイル・Chart.js・404・不正な入力', async () => {
  await withServer(async (base) => {
    const css = await fetch(`${base}/static/css/app.css`);
    assert.equal(css.status, 200, '_head.ejs が読む /static/css/app.css が配信される');
    const chart = await fetch(`${base}/static/vendor/chart.umd.js`);
    assert.equal(chart.status, 200, 'profile.ejs が読む Chart.js が配信される');
    assert.equal((await fetch(`${base}/about`)).status, 200);
    assert.equal((await fetch(`${base}/no-such-page`)).status, 404);
    assert.equal((await fetch(`${base}/insights/bad`)).status, 400);
    assert.equal((await fetch(`${base}/champion/%3Cscript%3E`)).status, 404);
    const res = await fetch(`${base}/about`);
    assert.ok(res.headers.get('content-security-policy'), 'セキュリティヘッダーが付く');
  });
});

test('テンプレート: ティアリスト・統計・ランキング・マルチ・診断が、ルートの渡す変数で描画できる', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    championName: 'Ahri', games: 40 + i, wins: 20 + i, winRate: 50, pickRate: 5, banRate: 3, kda: '2.50', kdaValue: 2.5
  }));
  const list = buildTierList(rows, rows, { minGames: 30 });
  const common = { queues: QUEUES, bandGroups: BAND_GROUPS, roleLabels: ROLE_LABELS };

  const tier = await render('tierlist', {
    ...common, patch: '15.3', patches: ['15.3', '15.2'], prevPatch: '15.2', totalMatches: 100, minGames: 30, list,
    objectives: { matches: 10, items: [{ label: 'バロン獲得', games: 5, wins: 4, winRate: 80 }] },
    selected: { queueId: 420, role: null, band: 'all' }
  });
  assert.match(tier, /ティアリスト/);

  const stats = await render('champions', {
    ...common, view: 'stats', allChamps: [], tagLabels: {}, rows, totalMatches: 100, banMatches: 80, patches: ['15.3'],
    minOptions: [1, 10], sorts: { winRate: '勝率' }, selected: { queueId: null, patch: null, role: null, min: 10, sort: 'winRate', band: 'all', tag: null }
  });
  assert.match(stats, /チャンピオン統計/);

  const all = await render('champions', {
    ...common, view: 'all', allChamps: [{ id: 'Ahri', name: 'アーリ', title: '九尾の狐' }], tagLabels: { Mage: 'メイジ' },
    rows: [], totalMatches: 0, banMatches: 0, patches: [], minOptions: [10], sorts: {}, selected: { tag: null, queueId: null, patch: null, role: null, min: 10, sort: 'winRate', band: 'all' }
  });
  assert.match(all, /アーリ/);

  const ranking = await render('ranking', {
    queues: { RANKED_SOLO_5x5: 'ソロ' }, queueKey: 'RANKED_SOLO_5x5', tiers: { challenger: 'チャレンジャー' }, tier: 'challenger', division: 'I',
    apex: true, rows: [{ rank: 1, name: 'a#JP1', lp: 900, wins: 10, losses: 5, winRate: 67 }], total: 1, page: 1, hasMore: false
  });
  assert.match(ranking, /a#JP1/);

  const multi = await render('multi', { raw: '', players: [{ input: 'x#1', error: '見つかりませんでした' }] });
  assert.match(multi, /見つかりませんでした/);

  const games = Array.from({ length: 40 }, (_, i) => ({ t: 1700000000000 + i * 4 * 3600000, dur: 1800, win: i % 3 === 0, champ: 'Ahri', role: 'MIDDLE' }));
  const insights = await render('insights', {
    puuid: 'x'.repeat(30), queueId: 420, queues: QUEUES, roleLabels: ROLE_LABELS, name: 'a#JP1', loaded: 40, capped: false, r: analyze(games)
  });
  assert.match(insights, /プレイ傾向の診断/);
  const empty = await render('insights', {
    puuid: 'x'.repeat(30), queueId: 420, queues: QUEUES, roleLabels: ROLE_LABELS, name: '', loaded: 0, capped: false, r: analyze([])
  });
  assert.match(empty, /まだ保存されていません/);
});
