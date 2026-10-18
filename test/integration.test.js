// MongoDB を使う結合テスト。環境変数 MONGODB_URI_TEST（テスト専用の DB。名前に "test" を含むこと）があるときだけ動く。
// ローカルでは MongoDB を起動して  MONGODB_URI_TEST=mongodb://127.0.0.1:27017/lol-analytics-test npm test
// CI（.github/workflows/test.yml）では MongoDB のサービスコンテナで常に実行する。Riot API は呼ばない。
import test from 'node:test';
import assert from 'node:assert/strict';

const URI = process.env.MONGODB_URI_TEST;
const dbName = URI ? new URL(URI).pathname.replace(/^\//, '') : '';
const skip = !URI ? 'MONGODB_URI_TEST が未設定' : !/test/i.test(dbName) ? 'DB 名に "test" を含まないため実行しない（本番の DB を消さないため）' : false;

const PUUID = 'T'.repeat(78);
const OTHER = 'U'.repeat(78);
const DAY = 86400000;

function seedMatch(i, now) {
  const created = now - i * 6 * 3600000;
  const me = { puuid: PUUID, riotIdGameName: 'Tester', riotIdTagline: 'JP1', teamId: 100, teamPosition: 'MIDDLE', championName: i % 2 ? 'Ahri' : 'Zed', kills: 5, deaths: i < 15 ? 4 : 9, assists: 7, win: i % 3 !== 0, totalMinionsKilled: 180, neutralMinionsKilled: 10, visionScore: 28, goldEarned: 12000, totalDamageDealtToChampions: 20000 };
  const foe = { puuid: OTHER, teamId: 200, teamPosition: 'MIDDLE', championName: 'Syndra', kills: 3, deaths: 5, assists: 4, win: !me.win };
  return { matchId: `JP1_${9000000 + i}`, gameCreation: created, gameDate: new Date(created), gameDuration: 1800, queueId: 420, gameVersion: '16.20.1', participantPuuids: [PUUID, OTHER], teams: [], participants: [me, foe] };
}

test('結合: 診断の画面 → 週サマリーの保存 → 試合が消えても週ごとの推移が残る', { skip }, async (t) => {
  const mongoose = (await import('mongoose')).default;
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 });
  const { default: Match } = await import('../src/models/Match.js');
  const { default: PlayerWeek } = await import('../src/models/PlayerWeek.js');
  const { default: app } = await import('../src/app.js');
  await Promise.all([Match.deleteMany({ participantPuuids: PUUID }), PlayerWeek.deleteMany({ puuid: PUUID })]);
  const server = app.listen(0);
  t.after(async () => {
    server.close();
    await Promise.all([Match.deleteMany({ participantPuuids: PUUID }), PlayerWeek.deleteMany({ puuid: PUUID })]);
    await mongoose.disconnect();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const now = Date.now();
  await Match.insertMany(Array.from({ length: 40 }, (_, i) => seedMatch(i, now)));

  const res = await fetch(`${base}/insights/${PUUID}?queue=420`);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const s of ['プレイ内容', '直近の変化', '週ごとの推移', 'タイムライン集計']) assert.ok(html.includes(s), `${s} が出る`);
  assert.ok((await PlayerWeek.countDocuments({ puuid: PUUID })) >= 1, '週サマリーが保存された');
  const total = (await PlayerWeek.find({ puuid: PUUID }).lean()).reduce((s, w) => s + w.games, 0);
  assert.equal(total, 40, '週サマリーの合計が試合数と一致する');

  // 試合が期限で消えた状況
  await Match.deleteMany({ participantPuuids: PUUID });
  const after = await fetch(`${base}/insights/${PUUID}?queue=420`);
  assert.equal(after.status, 200);
  const afterHtml = await after.text();
  assert.ok(afterHtml.includes('まだ保存されていません'));
  assert.ok(afterHtml.includes('週ごとの推移'), '試合が無くても長期の推移は残る');
  assert.equal((await PlayerWeek.find({ puuid: PUUID }).lean()).reduce((s, w) => s + w.games, 0), 40, '縮んだ再計算で上書きされない');
});

test('結合: タイムライン取得の POST は、不正な PUUID・未保存のプレイヤーを API を使わずに断る', { skip }, async (t) => {
  const mongoose = (await import('mongoose')).default;
  if (mongoose.connection.readyState !== 1) await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 });
  const { default: app } = await import('../src/app.js');
  const server = app.listen(0);
  t.after(async () => { server.close(); await mongoose.disconnect(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (puuid) => fetch(`${base}/insights/${puuid}/timeline`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'queue=420', redirect: 'manual' });

  assert.equal((await post('bad')).status, 400);
  assert.equal((await post('Z'.repeat(78))).status, 404, '試合が保存されていないプレイヤーは 404');
  assert.equal((await fetch(`${base}/insights/${PUUID}/timeline`)).status, 404, 'GET では実行されない（このパスは POST 専用）');
});
