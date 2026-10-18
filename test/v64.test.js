import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import axios from 'axios';
import { config } from '../src/config/index.js';
import {
  REGIONS, readRegion, regionOfMatchId, platformHost, clusterHost, accountHost, matchIdPattern
} from '../src/constants/regions.js';
import { basicAuth } from '../src/middleware/basicAuth.js';
import { regionContext, readCookie } from '../src/middleware/region.js';
import { getSummonerByPUUID, getMatchById, getMatchIdsByPUUID, getAccountByRiotId, getTimelineById } from '../src/services/riotApi.js';
import { slimMatch, slimRunes } from '../src/services/slimMatch.js';
import { buildDeltas, aggKey } from '../src/services/aggMath.js';
import { buildReport, buildMatchups, headToHead, rolesOf, verdictOf, makeItemClassifier } from '../src/services/buildMath.js';
import { extractRows, championMatchFilter } from '../src/services/championBuild.js';
import { makeHelpers } from '../src/utils/ddHelpers.js';
import { shardLabel } from '../src/constants/runes.js';
import { QUEUE_FILTERS } from '../src/constants/queues.js';
import { ROLE_LABELS } from '../src/constants/roles.js';
import { BAND_GROUPS } from '../src/constants/bands.js';

// ---------- リージョン ----------
test('regions: 検証・試合IDからの判別・ホストの選び方', () => {
  assert.equal(readRegion('KR'), 'kr');
  assert.equal(readRegion('xx'), 'jp');
  assert.equal(readRegion(undefined, 'na'), 'na');
  assert.equal(regionOfMatchId('JP1_123'), 'jp');
  assert.equal(regionOfMatchId('EUW1_9'), 'euw');
  assert.equal(regionOfMatchId('KR_77'), 'kr');
  assert.equal(regionOfMatchId('ZZ9_1'), null);
  assert.equal(regionOfMatchId('bad'), null);
  assert.equal(platformHost('na'), 'na1.api.riotgames.com');
  assert.equal(clusterHost('kr'), 'asia.api.riotgames.com');
  assert.equal(clusterHost('oce'), 'sea.api.riotgames.com');
  assert.equal(accountHost('oce'), 'asia.api.riotgames.com', 'account-v1 に sea は無いので asia 経由');
  assert.equal(accountHost('euw'), 'europe.api.riotgames.com');
  assert.equal(matchIdPattern('lan'), '^LA1_');
  // 試合IDの先頭が全リージョンで重複しない
  assert.equal(new Set(Object.values(REGIONS).map((r) => r.prefix)).size, Object.keys(REGIONS).length);
});

const realGet = axios.get;
test.afterEach(() => { axios.get = realGet; });

test('riotApi: リージョンごとに正しいホストを呼ぶ（試合IDで呼ぶ関数は試合IDから判別）', async () => {
  config.riotApiKey = 'RGAPI-test';
  const urls = [];
  axios.get = async (url) => { urls.push(url); return { data: {}, headers: {} }; };

  await getSummonerByPUUID('p', { region: 'kr' });
  await getSummonerByPUUID('p'); // 省略時は既定のリージョン
  await getMatchIdsByPUUID('p', { region: 'na' });
  await getMatchById('EUW1_5');
  await getMatchById('OC1_5');
  await getTimelineById('TW2_8');
  await getAccountByRiotId('a', 'b', { region: 'sg' });

  assert.match(urls[0], /^https:\/\/kr\.api\.riotgames\.com\/lol\/summoner/);
  assert.ok(urls[1].startsWith(`https://${platformHost(config.defaultRegion)}/`));
  assert.match(urls[2], /^https:\/\/americas\.api\.riotgames\.com\/lol\/match\/v5\/matches\/by-puuid\/p\/ids/);
  assert.match(urls[3], /^https:\/\/europe\.api\.riotgames\.com\/lol\/match\/v5\/matches\/EUW1_5$/);
  assert.match(urls[4], /^https:\/\/sea\.api\.riotgames\.com\/lol\/match\/v5\/matches\/OC1_5$/);
  assert.match(urls[5], /^https:\/\/sea\.api\.riotgames\.com\/.*\/TW2_8\/timeline$/);
  assert.match(urls[6], /^https:\/\/asia\.api\.riotgames\.com\/riot\/account\/v1\/accounts\/by-riot-id\/a\/b$/);
});

// ---------- ミドルウェア ----------
function run(req) {
  const res = { locals: {}, cookies: [], cookie(...a) { this.cookies.push(a); } };
  regionContext()({ headers: {}, query: {}, body: {}, method: 'GET', ...req }, res, () => {});
  return res;
}

test('regionContext: プレイヤーのページは URL だけで決まり、統計のページは Cookie も使う', () => {
  const def = config.defaultRegion;
  const cookie = { cookie: 'region=kr' };
  const stats = run({ path: '/champions', headers: cookie });
  assert.equal(stats.locals.region, 'kr', '統計は覚えているリージョン');
  assert.equal(stats.locals.rqs, '&region=kr');

  const player = run({ path: '/summoner', headers: cookie });
  assert.equal(player.locals.region, def, 'プレイヤーのページは Cookie を使わない（共有リンクが同じ人を指すように）');
  assert.equal(player.locals.formRegion, 'kr', 'フォームの初期値は覚えている方');

  const explicit = run({ path: '/summoner', query: { region: 'NA' } });
  assert.equal(explicit.locals.region, 'na');
  assert.equal(explicit.cookies[0][1], 'na', '選んだリージョンを覚える');

  const bad = run({ path: '/champions', query: { region: 'zzz' } });
  assert.equal(bad.locals.region, def);
  assert.equal(bad.cookies.length, 0);

  const api = run({ path: '/api/sync/start', method: 'POST', query: { region: 'kr' } });
  assert.equal(api.locals.region, 'kr');
  assert.equal(api.cookies.length, 0, 'API では Cookie を書き換えない');

  const post = run({ path: '/search', method: 'POST', body: { region: 'euw' } });
  assert.equal(post.locals.region, 'euw');
  assert.equal(readCookie({ headers: { cookie: 'a=1; region=jp' } }), 'jp');
});

// ---------- 保存・集計 ----------
test('slimRunes: 9個そろったときだけ保存する', () => {
  const perks = {
    styles: [
      { style: 8100, selections: [{ perk: 8112 }, { perk: 8126 }, { perk: 8140 }, { perk: 8135 }] },
      { style: 8200, selections: [{ perk: 8226 }, { perk: 8210 }] }
    ],
    statPerks: { offense: 5008, flex: 5008, defense: 5011 }
  };
  assert.deepEqual(slimRunes(perks), [8112, 8126, 8140, 8135, 8226, 8210, 5008, 5008, 5011]);
  assert.equal(slimRunes({ ...perks, statPerks: {} }), undefined);
  assert.equal(slimRunes(undefined), undefined);
});

test('slimMatch / buildDeltas: ルーン全体とリージョンを保存し、集計の行にリージョンを入れる', () => {
  const raw = {
    metadata: { matchId: 'KR_9', participants: ['a'] },
    info: {
      gameCreation: 1700000000000, gameDuration: 1800, queueId: 420, gameVersion: '15.3.1', teams: [],
      participants: [{
        puuid: 'a', teamId: 100, teamPosition: 'MIDDLE', championName: 'Ahri', win: true,
        perks: {
          styles: [
            { style: 8100, selections: [{ perk: 8112 }, { perk: 8126 }, { perk: 8140 }, { perk: 8135 }] },
            { style: 8200, selections: [{ perk: 8226 }, { perk: 8210 }] }
          ],
          statPerks: { offense: 5008, flex: 5008, defense: 5011 }
        }
      }]
    }
  };
  const d = slimMatch(raw);
  assert.equal(d.participants[0].primaryStyle, 8100);
  assert.equal(d.participants[0].runes.length, 9);
  const keys = buildDeltas(d).map((x) => x.key);
  assert.ok(keys.includes(aggKey(420, '15.3', 'UNKNOWN', 'ALL', 'Ahri', 'kr')));
  assert.ok(!keys.includes(aggKey(420, '15.3', 'UNKNOWN', 'ALL', 'Ahri', 'jp')), '韓国の試合が日本の集計に入らない');
});

// ---------- おすすめビルド・対面 ----------
const ITEMS = {
  3006: { total: 1100, final: true, consumed: false, tags: ['Boots'] },
  1001: { total: 300, final: false, consumed: false, tags: ['Boots'] },
  6655: { total: 3000, final: true, consumed: false, tags: [] },
  3089: { total: 3400, final: true, consumed: false, tags: [] },
  3157: { total: 3000, final: true, consumed: false, tags: [] },
  2003: { total: 50, final: true, consumed: true, tags: [] },
  1052: { total: 435, final: false, consumed: false, tags: [] }
};
const RUNES_A = [8112, 8126, 8140, 8135, 8226, 8210, 5008, 5008, 5011];
const RUNES_B = [8229, 8226, 8210, 8237, 8345, 8347, 5008, 5008, 5011];
const part = (o = {}) => ({
  win: false, teamPosition: 'MIDDLE', keystone: 8112, subStyle: 8200, primaryStyle: 8100, runes: RUNES_A, summoner1Id: 4, summoner2Id: 14,
  item0: 3006, item1: 6655, item2: 3089, item3: 3157, item4: 1052, item5: 2003,
  kills: 5, deaths: 3, assists: 6, totalMinionsKilled: 200, neutralMinionsKilled: 10, goldEarned: 12000, totalDamageDealtToChampions: 20000, visionScore: 20, ...o
});
const opp = (name, o = {}) => ({ championName: name, kills: 3, deaths: 5, assists: 4, totalMinionsKilled: 180, neutralMinionsKilled: 0, goldEarned: 10000, totalDamageDealtToChampions: 15000, visionScore: 15, ...o });
const row = (me, o) => ({ dur: 1800, me: part(me), opp: o });

function sampleRows() {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(row({ win: i < 10 }, opp('Zed'))); // 10勝2敗（キーストーン 8112）
  for (let i = 0; i < 12; i++) rows.push(row({ win: i < 1, keystone: 8229, runes: RUNES_B, subStyle: 8300, primaryStyle: 8200 }, opp('Yasuo'))); // 1勝11敗
  rows.push(row({ win: true, keystone: 8112, runes: undefined }, opp('Zed'))); // 旧データ（ルーンページなし）
  rows.push(row({ win: true, teamPosition: 'BOTTOM' }, opp('Jinx')));
  rows.push(row({ win: false, teamPosition: '' }, undefined)); // ロールなし
  return rows;
}

test('buildMath: ロールは試合数の多い順に並ぶ', () => {
  const roles = rolesOf(sampleRows());
  assert.equal(roles[0].role, 'MIDDLE');
  assert.equal(roles[0].games, 25);
  assert.equal(roles[1].role, 'BOTTOM');
});

test('buildReport: おすすめは試合数が足りるものだけ。ルーンページは版3の試合だけで数える', () => {
  const r = buildReport(sampleRows(), { role: 'MIDDLE', minGames: 5, items: ITEMS });
  assert.equal(r.games, 25);
  assert.equal(r.keystones[0].id, 8112, '勝率が高く試合数もあるキーストーンが先頭');
  assert.equal(r.keystones[0].recommended, true);
  assert.equal(r.keystones[1].id, 8229);
  assert.equal(r.keystones[1].recommended, false);
  assert.equal(r.runeCoverage.withPages, 24);
  assert.deepEqual(r.runePages[0].runes, RUNES_A);
  assert.deepEqual(r.spells[0].ids, [4, 14]);
  assert.deepEqual(r.boots.map((b) => b.id), [3006], '素材のブーツ(1001)は入らない');
  assert.deepEqual(r.coreItems.map((i) => i.id).sort(), [3089, 3157, 6655], '消耗品・素材は完成品に入らない');
  assert.deepEqual(r.coreBuilds[0].ids, [3089, 3157, 6655]);
  assert.equal(r.coreBuilds[0].games, 25);
});

test('buildReport: 試合数が最低に届かないときはおすすめを付けず、参考にする', () => {
  const rows = [row({ win: true }, opp('Zed')), row({ win: true }, opp('Zed'))];
  const r = buildReport(rows, { role: 'MIDDLE', minGames: 5, items: ITEMS });
  assert.equal(r.enough, false);
  assert.ok(r.keystones.every((k) => !k.recommended && k.few));
  const empty = buildReport([], { items: ITEMS });
  assert.equal(empty.games, 0);
  assert.deepEqual(empty.keystones, []);
});

test('makeItemClassifier: アイテム表が無いときは全部を完成品として扱う', () => {
  assert.equal(makeItemClassifier({})(3089), 'core');
  assert.equal(makeItemClassifier({})(0), null);
  assert.equal(makeItemClassifier(ITEMS)(3006), 'boots');
  assert.equal(makeItemClassifier(ITEMS)(2003), null);
});

test('buildMatchups: 有利・不利・参考を判定し、少ない試合数で断定しない', () => {
  const m = buildMatchups(sampleRows(), { role: 'MIDDLE', minGames: 5 });
  assert.equal(m.opponents, 2);
  const zed = m.rows.find((x) => x.championName === 'Zed');
  const yas = m.rows.find((x) => x.championName === 'Yasuo');
  assert.equal(zed.games, 13);
  assert.equal(zed.verdict, 'good');
  assert.equal(yas.verdict, 'bad');
  assert.equal(zed.diff.gold, 2000);
  assert.equal(m.best[0].championName, 'Zed');
  assert.equal(m.worst[0].championName, 'Yasuo');
  assert.equal(buildMatchups(sampleRows(), { role: 'BOTTOM', minGames: 5 }).rows[0].verdict, 'few');
  assert.equal(buildMatchups(sampleRows(), { role: 'MIDDLE', sort: 'worst' }).rows[0].championName, 'Yasuo');
  assert.equal(verdictOf(5, 10, 5), 'even');
  assert.equal(verdictOf(0, 0, 5), 'few');
});

test('headToHead: 勝率・平均・差を出す', () => {
  const h2h = headToHead(sampleRows(), 'Zed', { role: 'MIDDLE', minGames: 5 });
  assert.equal(h2h.games, 13);
  assert.equal(h2h.wins, 11);
  assert.equal(h2h.avgMinutes, 30);
  assert.equal(h2h.diff.gold, 2000);
  assert.equal(h2h.diff.cs, 30);
  assert.equal(h2h.diff.deaths, -2);
  assert.equal(headToHead(sampleRows(), 'Nobody').games, 0);
});

// ---------- テンプレート ----------
const views = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views');
const h = makeHelpers({ version: '15.1.1', champNames: { Ahri: 'アーリ', Zed: 'ゼド' }, champKeyToId: {}, spells: { 4: 'SummonerFlash.png', 14: 'SummonerDot.png' }, runes: { 8112: 'a.png', 8100: 'b.png' } });
const render = (name, data) => ejs.renderFile(path.join(views, `${name}.ejs`), { h, ...data }, { views: [views] });
const QUEUES = QUEUE_FILTERS.filter((q) => q.id);

test('テンプレート: チャンピオン詳細・対面・リージョン選択が描画できる', async () => {
  const rows = sampleRows();
  const selected = { queueId: null, patch: null, band: 'all', role: 'MIDDLE', min: 5, sort: 'games' };
  const html = await render('champion', {
    name: 'Ahri', detail: { totalMatches: 40, games: 22, wins: 14, winRate: 64, pickRate: 55, kda: '2.5', avgKills: '5', avgDeaths: '3', avgAssists: '6', roles: [] },
    info: null, patches: ['15.3'], selected, queues: QUEUES, bandGroups: BAND_GROUPS, roleLabels: ROLE_LABELS, tagLabels: {}, minOptions: [3, 5, 10, 20],
    matchupSorts: { games: '試合数' }, roles: rolesOf(rows), shardLabel,
    report: buildReport(rows, { role: 'MIDDLE', items: ITEMS }), matchups: buildMatchups(rows, { role: 'MIDDLE' }), scanned: rows.length, capped: false,
    regions: REGIONS, region: 'kr', formRegion: 'kr', rqs: '&region=kr', rq: '?region=kr'
  });
  assert.match(html, /おすすめビルド/);
  assert.match(html, /★おすすめ/);
  assert.match(html, /適応能力/);
  assert.match(html, /\/matchup\?champ=Ahri&amp;vs=Zed[^"]*&amp;region=kr/);
  assert.match(html, /<option value="kr" selected>/);

  const noData = await render('champion', {
    name: 'Ahri', detail: null, info: null, patches: [], selected, queues: QUEUES, bandGroups: BAND_GROUPS, roleLabels: ROLE_LABELS, tagLabels: {}, minOptions: [5],
    matchupSorts: {}, roles: [], shardLabel, report: buildReport([], { items: ITEMS }), matchups: buildMatchups([], {}), scanned: 0, capped: false
  });
  assert.match(noData, /保存済みの試合にこのチャンピオンがいません/);

  const m = await render('matchup', {
    champ: 'Ahri', vs: 'Zed', patches: [], selected, queues: QUEUES, bandGroups: BAND_GROUPS, minOptions: [5], roleLabels: ROLE_LABELS,
    roleOptions: rolesOf(rows).map((r) => ({ ...r, versus: 1 })), error: null, champList: [{ id: 'Ahri', name: 'アーリ' }],
    result: headToHead(rows, 'Zed', { role: 'MIDDLE' })
  });
  assert.match(m, /対面（直接対決）/);
  assert.match(m, /ゴールド/);
  const empty = await render('matchup', { champ: '', vs: '', patches: [], selected, queues: QUEUES, bandGroups: BAND_GROUPS, minOptions: [5], roleLabels: ROLE_LABELS, roleOptions: [], error: null, result: null, champList: [] });
  assert.match(empty, /調べる/);
});

test('テンプレート: ホーム・ランキング・ステータスにリージョン選択が出る', async () => {
  const regionData = { regions: REGIONS, region: 'na', formRegion: 'na', defaultRegion: 'jp', rqs: '&region=na', rq: '?region=na' };
  const home = await render('index', { error: null, matchCount: 3, statusInfo: null, ...regionData });
  assert.match(home, /<option value="na" selected>/);
  const status = await render('status', { name: 'NA1', maintenances: [], incidents: [], ...regionData });
  assert.match(status, /<option value="na" selected>/);
  const ranking = await render('ranking', {
    queues: { RANKED_SOLO_5x5: 'ソロ' }, queueKey: 'RANKED_SOLO_5x5', tiers: { challenger: 'チャレンジャー' }, tier: 'challenger', division: 'I',
    apex: true, rows: [{ rank: 1, name: 'a#NA1', lp: 900, wins: 10, losses: 5, winRate: 67 }], total: 1, page: 1, hasMore: false, ...regionData
  });
  assert.match(ranking, /\/summoner\?riotId=a%23NA1&amp;region=na/);
});

test('extractRows: 自分と同じロールで反対のチームにいた相手を選ぶ。ロールが無ければ対面なし', () => {
  const p = (championName, teamId, teamPosition, extra = {}) => ({ championName, teamId, teamPosition, win: teamId === 100, kills: 1, ...extra });
  const docs = [
    { gameDuration: 1500, participants: [p('Ahri', 100, 'MIDDLE'), p('Lux', 100, 'UTILITY'), p('Zed', 200, 'MIDDLE'), p('Sona', 200, 'UTILITY')] },
    { gameDuration: 900, participants: [p('Ahri', 200, ''), p('Zed', 100, '')] },
    { gameDuration: 1800, participants: [p('Ahri', 100, 'MIDDLE'), p('Ahri', 200, 'MIDDLE')] }, // ミラー
    { gameDuration: 1800, participants: [p('Lux', 100, 'MIDDLE')] }
  ];
  const rows = extractRows(docs, 'Ahri');
  assert.equal(rows.length, 4, 'ミラーは両方の視点で1行ずつ');
  assert.equal(rows[0].opp.championName, 'Zed');
  assert.equal(rows[0].dur, 1500);
  assert.equal(rows[1].opp, undefined);
  assert.equal(rows[2].opp.championName, 'Ahri');
  assert.equal(rows[0].me.puuid, undefined, '必要な項目だけ');
  assert.deepEqual(extractRows(undefined, 'Ahri'), []);
});

test('championMatchFilter: リージョン・モード・パッチ・帯で絞る', () => {
  const f = championMatchFilter('Ahri', { region: 'kr', queueId: 420, patch: '15.3', band: 'diamond' });
  assert.equal(f.matchId.$regex, '^KR_');
  assert.equal(f.queueId, 420);
  assert.ok(f.gameVersion.test('15.3.1.2'));
  assert.ok(!f.gameVersion.test('15.30.1'));
  assert.deepEqual(f.band.$in, ['MASTER_PLUS', 'DIAMOND']);
  assert.equal(championMatchFilter('Ahri', {}).band, undefined);
});

test('basicAuth: パスワード未設定なら素通し。設定時は /healthz 以外を守る', () => {
  const call = (mw, req) => {
    const res = { code: null, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, type() { return this; }, send() { return this; } };
    let passed = false;
    mw({ headers: {}, ...req }, res, () => { passed = true; });
    return { passed, res };
  };
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

  assert.equal(call(basicAuth({}), { path: '/' }).passed, true);
  const mw = basicAuth({ user: 'me', password: 'p:w' });
  assert.equal(call(mw, { path: '/healthz' }).passed, true);
  const denied = call(mw, { path: '/' });
  assert.equal(denied.passed, false);
  assert.equal(denied.res.code, 401);
  assert.match(denied.res.headers['WWW-Authenticate'], /Basic/);
  assert.equal(call(mw, { path: '/', headers: { authorization: basic('me', 'wrong') } }).passed, false);
  assert.equal(call(mw, { path: '/', headers: { authorization: basic('me', 'p:w') } }).passed, true, 'パスワードに : が入っていてもよい');
});
