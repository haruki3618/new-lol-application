import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import app from '../src/app.js';
import PlayerName from '../src/models/PlayerName.js';
import { planTtl, bytesToFree, ensureTtlIndexes, ttlSpecs } from '../src/services/storage.js';
import { parseSuggestQuery, normalizeName, escapeRegex, suggestPlayers, rememberFromMatch } from '../src/services/playerNames.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const DAY = 86400;

// ---------- TTL ----------
test('planTtl: 作成・日数変更・作り直し・無期限（TTL を外す）・何もしない を正しく選ぶ', () => {
  const ttl = (s) => [{ name: 'x', key: { gameDate: 1 }, expireAfterSeconds: s }];
  assert.equal(planTtl([], 'gameDate', 30 * DAY), 'create');
  assert.equal(planTtl(ttl(30 * DAY), 'gameDate', 30 * DAY), 'none');
  assert.equal(planTtl(ttl(30 * DAY), 'gameDate', 7 * DAY), 'collmod');
  assert.equal(planTtl([{ name: 'x', key: { gameDate: 1 } }], 'gameDate', 30 * DAY), 'recreate');
  assert.equal(planTtl(ttl(30 * DAY), 'gameDate', 0), 'drop');
  assert.equal(planTtl([], 'gameDate', 0), 'none');
  // 複合インデックスは対象にしない
  assert.equal(planTtl([{ name: 'c', key: { gameDate: 1, a: 1 }, expireAfterSeconds: 5 }], 'gameDate', 30 * DAY), 'create');
});

function fakeModel(indexes) {
  const calls = [];
  return {
    calls,
    collection: {
      collectionName: 'fake',
      indexes: async () => indexes,
      createIndex: async (k, o) => calls.push(['create', k, o]),
      dropIndex: async (n) => calls.push(['drop', n])
    },
    db: { db: { command: async (c) => { calls.push(['collMod', c.index]); } } }
  };
}

test('ensureTtlIndexes: 設定の日数でインデックスを作る・変える・外す', async () => {
  const a = fakeModel([]);
  const b = fakeModel([{ name: 'gameDate_1', key: { gameDate: 1 }, expireAfterSeconds: 30 * DAY }]);
  const c = fakeModel([{ name: 'gameDate_1', key: { gameDate: 1 }, expireAfterSeconds: 30 * DAY }]);
  const res = await ensureTtlIndexes([
    { name: 'a', model: a, field: 'gameDate', days: 30 },
    { name: 'b', model: b, field: 'gameDate', days: 7 },
    { name: 'c', model: c, field: 'gameDate', days: 0 }
  ]);
  assert.deepEqual(a.calls, [['create', { gameDate: 1 }, { expireAfterSeconds: 30 * DAY }]]);
  assert.deepEqual(b.calls, [['collMod', { keyPattern: { gameDate: 1 }, expireAfterSeconds: 7 * DAY }]]);
  assert.deepEqual(c.calls, [['drop', 'gameDate_1']]);
  assert.deepEqual(res.map((r) => r.action), ['create', 'collmod', 'drop']);
});

test('ensureTtlIndexes: collMod が使えない環境では作り直す・1つ失敗しても残りは続ける', async () => {
  const m = fakeModel([{ name: 'gameDate_1', key: { gameDate: 1 }, expireAfterSeconds: 30 * DAY }]);
  m.db.db.command = async () => { throw new Error('not supported'); };
  const bad = fakeModel([]);
  bad.collection.indexes = async () => { throw new Error('boom'); };
  const ok = fakeModel([]);
  const res = await ensureTtlIndexes([
    { name: 'bad', model: bad, field: 'at', days: 5 },
    { name: 'm', model: m, field: 'gameDate', days: 7 },
    { name: 'ok', model: ok, field: 'at', days: 5 }
  ]);
  assert.equal(res[0].action, 'error');
  assert.deepEqual(m.calls, [['drop', 'gameDate_1'], ['create', { gameDate: 1 }, { expireAfterSeconds: 7 * DAY }]]);
  assert.equal(ok.calls.length, 1);
});

test('ttlSpecs: 試合・LP履歴・プレイヤー名が設定の日数に結び付く', () => {
  const specs = ttlSpecs({ matchTtlDays: 30, lpTtlDays: 90, playerTtlDays: 60 });
  assert.deepEqual(specs.map((s) => [s.name, s.field, s.days]), [['matches', 'gameDate', 30], ['lp_snapshots', 'at', 90], ['player_names', 'seenAt', 60]]);
});

test('Match モデルは gameDate の TTL を持たない（storage.js が日数を反映するため）。既定の保持は30日', async () => {
  const { default: Match } = await import('../src/models/Match.js');
  const { config } = await import('../src/config/index.js');
  const hasGameDate = Match.schema.indexes().some(([k]) => k.gameDate === 1);
  assert.equal(hasGameDate, false);
  assert.equal(config.matchTtlDays, 30);
});

// ---------- 容量の上限 ----------
test('bytesToFree: 上限以下なら0、超えたら目標の割合まで下げる量', () => {
  const MB = 1024 * 1024;
  assert.equal(bytesToFree(300 * MB, 400, 85), 0);
  assert.equal(bytesToFree(400 * MB, 400, 85), 0);
  assert.equal(bytesToFree(450 * MB, 400, 85), 450 * MB - 340 * MB);
  assert.equal(bytesToFree(999 * MB, 0, 85), 0, '0 は無効');
  assert.equal(bytesToFree(450 * MB, 400, 1000), 450 * MB - 396 * MB, '目標は99%までに丸める');
});

// ---------- 予測検索 ----------
test('parseSuggestQuery: 2文字から・タグは # の後ろ・全角半角と大文字小文字を区別しない', () => {
  assert.equal(parseSuggestQuery('a'), null);
  assert.equal(parseSuggestQuery(''), null);
  assert.equal(parseSuggestQuery('#JP1'), null);
  assert.equal(parseSuggestQuery('x'.repeat(41)), null);
  assert.deepEqual(parseSuggestQuery('てす'), { name: 'てす', tag: '' });
  assert.deepEqual(parseSuggestQuery('Ａｂ'), { name: 'ab', tag: '' }, '全角英字を半角・小文字にそろえる');
  assert.deepEqual(parseSuggestQuery('A#jp'), { name: 'a', tag: 'jp' }, 'タグまで打てば1文字でも検索');
  assert.deepEqual(parseSuggestQuery('a#b#c'), { name: 'a#b', tag: 'c' }, '最後の # で分ける');
  assert.equal(normalizeName(' ＴｅＳｔ '), 'test');
  assert.equal(escapeRegex('a.b*c(d)[e]'), 'a\\.b\\*c\\(d\\)\\[e\\]');
});

function stubFind(rows, seen) {
  PlayerName.find = (filter) => {
    seen.push(filter);
    const chain = { sort: () => chain, limit: () => chain, select: () => chain, maxTimeMS: () => chain, lean: async () => rows };
    return chain;
  };
}
async function withDb(fn) {
  const desc = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
  const orig = PlayerName.find;
  Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });
  try { await fn(); } finally {
    if (desc) Object.defineProperty(mongoose.connection, 'readyState', desc); else delete mongoose.connection.readyState;
    PlayerName.find = orig;
  }
}

test('suggestPlayers: リージョンと前方一致（正規表現は記号をエスケープ）で引き、Riot ID の形で返す', async () => {
  await withDb(async () => {
    const seen = [];
    stubFind([{ gameName: 'テスト太郎', tagLine: 'JP1' }, { gameName: 'テスト花子', tagLine: '1234' }], seen);
    const out = await suggestPlayers('テス', 'jp', 8);
    assert.deepEqual(out.map((o) => o.riotId), ['テスト太郎#JP1', 'テスト花子#1234']);
    assert.deepEqual(seen[0], { region: 'jp', n: { $regex: '^テス' } });
    assert.equal(seen.length, 1, '2文字では部分一致の補完をしない');

    const seen2 = [];
    stubFind([], seen2);
    await suggestPlayers('a.b#jp', 'kr', 8);
    assert.deepEqual(seen2[0], { region: 'kr', t: { $regex: '^jp' }, n: { $regex: '^a\\.b' } });

    // 3文字以上で前方一致が少ないとき、部分一致で補う（重複は除く）
    let n = 0;
    const seen3 = [];
    PlayerName.find = (f) => {
      seen3.push(f);
      const rows = n++ === 0 ? [{ gameName: 'abcx', tagLine: '1' }] : [{ gameName: 'abcx', tagLine: '1' }, { gameName: 'zabc', tagLine: '2' }];
      const chain = { sort: () => chain, limit: () => chain, select: () => chain, maxTimeMS: () => chain, lean: async () => rows };
      return chain;
    };
    const out3 = await suggestPlayers('abc', 'jp', 8);
    assert.deepEqual(out3.map((o) => o.riotId), ['abcx#1', 'zabc#2']);
    assert.deepEqual(seen3[1].n, { $regex: 'abc' });
  });
});

test('suggestPlayers / rememberFromMatch: DB に繋がっていないときは何もせず落ちない', async () => {
  assert.deepEqual(await suggestPlayers('テスト', 'jp'), []);
  await rememberFromMatch({ matchId: 'JP1_1', participants: [{ puuid: 'p', riotIdGameName: 'a', riotIdTagline: 'b' }] });
});

test('rememberFromMatch: 試合IDからリージョンを決め、同じ人は短時間に2回書かない', async () => {
  await withDb(async () => {
    const calls = [];
    const orig = PlayerName.bulkWrite;
    PlayerName.bulkWrite = async (ops) => { calls.push(ops); };
    try {
      const doc = { matchId: 'KR_999', participants: [
        { puuid: 'pu-recent-1', riotIdGameName: 'Faker', riotIdTagline: 'KR1' },
        { puuid: 'pu-recent-2', riotIdGameName: '', riotIdTagline: 'x' }
      ] };
      await rememberFromMatch(doc);
      await rememberFromMatch(doc);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].length, 1, '名前の無い参加者は除く');
      const op = calls[0][0].updateOne;
      assert.deepEqual(op.filter, { puuid: 'pu-recent-1', region: 'kr' });
      assert.equal(op.update.$set.n, 'faker');
      await rememberFromMatch({ matchId: 'ZZ_1', participants: doc.participants });
      assert.equal(calls.length, 1, 'リージョン不明の試合は無視');
    } finally { PlayerName.bulkWrite = orig; }
  });
});

test('PlayerName モデル: 検索用の項目とインデックス', () => {
  for (const f of ['puuid', 'region', 'gameName', 'tagLine', 'n', 't', 'hits', 'seenAt']) assert.ok(PlayerName.schema.path(f), f);
  const keys = PlayerName.schema.indexes().map(([k]) => Object.keys(k).join(','));
  assert.ok(keys.includes('region,n'));
  assert.ok(keys.includes('puuid,region'));
});

// ---------- ルート・画面 ----------
test('/api/suggest: DB が無くても 200 で空の候補を返し、短すぎる入力でも落ちない', async () => {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const q of ['', 'a', 'テスト', '%00', 'x'.repeat(100)]) {
      const r = await fetch(`${base}/api/suggest?q=${encodeURIComponent(q)}&region=jp`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { items: [] });
    }
    const js = await fetch(`${base}/static/js/suggest.js`);
    assert.equal(js.status, 200);
    const home = await (await fetch(`${base}/`)).text();
    assert.ok(home.includes('/static/js/suggest.js'));
  } finally { server.close(); }
});

test('suggest.js / app.css: 予測の部品と、折り返しの設定が入っている', () => {
  const js = fs.readFileSync(path.join(root, 'public', 'js', 'suggest.js'), 'utf8');
  assert.match(js, /\/api\/suggest/);
  assert.match(js, /isComposing/, '日本語の変換中は問い合わせない');
  assert.match(js, /AbortController/);
  assert.doesNotMatch(js, /innerHTML/, '名前は textContent で組み立てる（XSS対策）');
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');
  for (const s of ['line-break: strict', 'auto-phrase', 'text-wrap: balance', '.suggest']) assert.ok(css.includes(s), s);
});
