import test from 'node:test';
import assert from 'node:assert/strict';
import { slimMatch, slimTeam, PARTICIPANT_FIELDS } from '../src/services/slimMatch.js';
import { buildDeltas, mergeDeltas, toBulkOps, aggKey } from '../src/services/aggMath.js';
import { buildTierList, adjustedWinRate } from '../src/services/tierList.js';
import { computeBaselines, baselineLookup } from '../src/services/scoreBaseline.js';
import { scoreParticipants, summarizeParticipant } from '../src/services/summarize.js';
import { readBandGroup, BAND_GROUPS } from '../src/constants/bands.js';

const rawTeam = (teamId, win, extra = {}) => ({
  teamId, win,
  bans: [{ championId: 266, pickTurn: 1 }, { championId: -1, pickTurn: 2 }, { championId: 103, pickTurn: 3 }],
  objectives: {
    champion: { first: teamId === 100, kills: 30 }, tower: { first: false, kills: 9 }, dragon: { kills: 3 },
    baron: { kills: 1 }, riftHerald: { kills: 0 }, horde: { kills: 4 }, inhibitor: { kills: 1 }
  },
  ...extra
});
const rawMatch = () => ({
  metadata: { matchId: 'JP1_1', participants: ['a', 'b'] },
  info: {
    gameCreation: 1700000000000, gameDuration: 1800, queueId: 420, gameVersion: '15.3.1',
    teams: [rawTeam(100, true), rawTeam(200, false, { bans: [] })],
    participants: [
      { puuid: 'a', teamId: 100, teamPosition: 'MIDDLE', championName: 'Ahri', win: true, kills: 5, deaths: 1, assists: 5, totalMinionsKilled: 200, neutralMinionsKilled: 10, totalDamageDealtToChampions: 20000, goldEarned: 12000, visionScore: 20, perks: { styles: [{ style: 8100, selections: [{ perk: 8112 }] }, { style: 8200 }] } },
      { puuid: 'b', teamId: 200, teamPosition: '', championName: 'Zed', win: false, kills: 1, deaths: 5, assists: 1 }
    ]
  }
});

test('slimMatch: バン・オブジェクト・帯・版数を保存し、不要な項目は捨てる', () => {
  const d = slimMatch(rawMatch(), { band: 'DIAMOND' });
  assert.equal(d.band, 'DIAMOND');
  assert.equal(d.v, 3);
  assert.deepEqual(d.teams[0].bans, [266, 103], '-1（バンなし）は除く');
  assert.equal(d.teams[0].dragons, 3);
  assert.equal(d.teams[0].firstBlood, true);
  assert.equal(d.teams[1].firstBlood, false);
  assert.equal(d.participants[0].keystone, 8112);
  assert.equal(d.participants[0].perks, undefined);
  assert.deepEqual(Object.keys(d.participants[0]).sort(), [...PARTICIPANT_FIELDS].sort());
  assert.equal(slimMatch(rawMatch()).band, 'UNKNOWN');
  assert.equal(slimMatch({}), null);
  assert.deepEqual(slimTeam({ teamId: 1 }).bans, [], 'objectives が無くても落ちない');
});

test('buildDeltas: チャンピオン・ロール・バン・オブジェクトを行ごとに加算する', () => {
  const doc = slimMatch(rawMatch(), { band: 'EMERALD' });
  const deltas = buildDeltas(doc);
  const by = Object.fromEntries(deltas.map((x) => [x.key, x.inc]));

  const all = by[aggKey(420, '15.3', 'EMERALD', 'ALL', 'Ahri')];
  assert.equal(all.games, 1);
  assert.equal(all.wins, 1);
  assert.equal(all.kdaSum, 10);
  assert.equal(all.cs, 210);
  assert.equal(all.minutes, 30);
  assert.ok(by[aggKey(420, '15.3', 'EMERALD', 'MIDDLE', 'Ahri')]);
  assert.equal(by[aggKey(420, '15.3', 'EMERALD', 'NONE', 'Zed')], undefined);
  assert.ok(by[aggKey(420, '15.3', 'EMERALD', 'ALL', 'Zed')], 'ロールなしも ALL には入る');
  assert.equal(Object.keys(by).filter((k) => k.includes('|MIDDLE|') || k.includes('|JUNGLE|')).length, 1, 'ロールなしはロール別に入らない');

  assert.deepEqual(by[aggKey(420, '15.3', 'EMERALD', 'BAN', '266')], { bans: 1 });
  const total = by[aggKey(420, '15.3', 'EMERALD', 'TOTAL', '-')];
  assert.equal(total.matches, 1);
  assert.equal(total.matchesBans, 1);
  assert.equal(total['obj.dragon3.g'], 2, '両チームが3体以上取った');
  assert.equal(total['obj.dragon3.w'], 1, '勝ったチームだけ勝利に数える');
  assert.equal(total['obj.baron.g'], 2);
  assert.equal(total['obj.herald.g'], undefined);
  assert.equal(total['obj.firstBlood.g'], 1);
});

test('buildDeltas: 旧データ（teams なし）は試合数だけ数え、バン分母には入れない / パッチ不明は null', () => {
  const old = { gameVersion: '15.2.9', queueId: 420, gameDuration: 1500, participants: [{ championName: 'Ahri', win: true, teamPosition: 'MIDDLE' }] };
  const total = buildDeltas(old).find((x) => x.dims.role === 'TOTAL');
  assert.equal(total.dims.band, 'UNKNOWN');
  assert.equal(total.inc.matches, 1);
  assert.equal(total.inc.matchesBans, undefined);
  assert.equal(buildDeltas({ participants: [] }), null);
});

test('mergeDeltas / toBulkOps: 同じ行は合算され、upsert の操作になる', () => {
  const doc = slimMatch(rawMatch(), { band: 'EMERALD' });
  const acc = new Map();
  mergeDeltas(acc, buildDeltas(doc));
  mergeDeltas(acc, buildDeltas(doc));
  assert.equal(acc.get(aggKey(420, '15.3', 'EMERALD', 'ALL', 'Ahri')).inc.games, 2);
  const ops = toBulkOps(acc);
  const op = ops.find((o) => o.updateOne.filter._id === aggKey(420, '15.3', 'EMERALD', 'TOTAL', '-')).updateOne;
  assert.equal(op.upsert, true);
  assert.equal(op.update.$inc.matches, 2);
  assert.equal(op.update.$setOnInsert.role, 'TOTAL');
});

test('tierList: 補正済み勝率で並べ、少ない試合数は「データ不足」、前パッチとの差を出す', () => {
  assert.ok(adjustedWinRate(3, 3) < 0.6, '3戦3勝でも 100% 扱いにならない');
  const mk = (name, games, wins, pick = 5, ban = 0) => ({ championName: name, games, wins, pickRate: pick, banRate: ban });
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(mk('C' + i, 100, 40 + i)); // 40%〜59%
  rows.push(mk('Tiny', 3, 3));
  const prev = [mk('C19', 100, 50)];
  const r = buildTierList(rows, prev, { minGames: 30 });
  assert.equal(r.reliable, true);
  assert.equal(r.eligible, 20);
  assert.equal(r.tiers.S.length, 2);
  assert.equal(r.tiers.S[0].championName, 'C19');
  assert.equal(r.tiers.A.length + r.tiers.B.length + r.tiers.C.length, 18);
  assert.deepEqual(r.insufficient.map((x) => x.championName), ['Tiny']);
  assert.ok(r.tiers.S[0].delta > 0, '前パッチ 50% → 59% なので上昇');
  assert.equal(r.tiers.S[1].delta, null, '前パッチのデータがなければ null');
});

test('tierList: 比べる相手が5体未満ならティアを付けない', () => {
  const r = buildTierList([{ championName: 'A', games: 100, wins: 60, pickRate: 1, banRate: 0 }], [], { minGames: 30 });
  assert.equal(r.reliable, false);
  assert.equal(r.tiers.S.length, 0);
  assert.equal(r.insufficient.length, 1);
});

test('scoreBaseline: チャンピオン×ロールの平均を作り、試合数が足りなければロール全体→null', () => {
  const rows = [
    { role: 'UTILITY', champ: 'Lulu', games: 40, kdaSum: 200, damage: 40 * 8000, gold: 40 * 9000, cs: 40 * 30, vision: 40 * 60, minutes: 40 * 30 },
    { role: 'UTILITY', champ: 'Rare', games: 5, kdaSum: 25, damage: 5 * 8000, gold: 5 * 9000, cs: 5 * 30, vision: 5 * 60, minutes: 5 * 30 },
    { role: 'MIDDLE', champ: 'Ahri', games: 10, kdaSum: 30, damage: 1, gold: 1, cs: 1, vision: 1, minutes: 10 },
    { role: 'ALL', champ: 'Ahri', games: 999, kdaSum: 1, damage: 1, gold: 1, cs: 1, vision: 1, minutes: 1 }
  ];
  const map = computeBaselines(rows);
  assert.equal(map.has('ALL|Ahri'), false, 'ALL（全ロール合算）は基準にしない');
  const look = baselineLookup(map, { minChamp: 30, minRole: 40 });
  assert.equal(look('Lulu', 'UTILITY').kda, 5);
  assert.equal(look('Lulu', 'UTILITY').vpm, 2);
  assert.equal(look('Rare', 'UTILITY').games, 45, 'チャンピオン別が足りないのでロール全体');
  assert.equal(look('Ahri', 'MIDDLE'), null, 'ロール全体も足りない');
  assert.equal(look('Ahri', ''), null);
});

test('scoreParticipants: 基準なしは従来どおり。基準ありなら「サポートとして平均的」な人が不当に低くならない', () => {
  // 3人のキャリー（ダメージ・ゴールド多め）と、サポートとして基準ちょうどの成績の Lulu
  const carry = (teamId, win) => ({ teamId, win, championName: 'Jinx', teamPosition: 'BOTTOM', kills: 8, deaths: 3, assists: 6, totalDamageDealtToChampions: 30000, goldEarned: 14000, visionScore: 15, totalMinionsKilled: 260 });
  const lulu = { teamId: 100, win: true, championName: 'Lulu', teamPosition: 'UTILITY', kills: 2, deaths: 2, assists: 8, totalDamageDealtToChampions: 8100, goldEarned: 9000, visionScore: 60, totalMinionsKilled: 30 };
  const players = [lulu, carry(100, true), carry(200, false), carry(200, false)];

  assert.deepEqual(scoreParticipants(players, { baseline: null, durationMin: 30 }), scoreParticipants(players));

  const baseline = (champ, role) => (role === 'UTILITY'
    ? { kda: 5, dpm: 270, gpm: 300, cpm: 1, vpm: 2 }
    : { kda: 3, dpm: 1000, gpm: 450, cpm: 8.5, vpm: 0.5 });
  const scored = scoreParticipants(players, { baseline, durationMin: 30 });
  for (const s of scored) assert.ok(s.score >= 0 && s.score <= 10);
  // 基準ちょうどの成績なら約5点 + 勝利ボーナス 0.3（ロールの違いで下げられない）
  assert.ok(scored[0].score >= 5.0 && scored[0].score <= 5.7, `基準どおりのサポートは中位の点（${scored[0].score}）`);

  // 同じサポートでも、視界を稼げば（基準の2倍）点が上がる
  const warded = scoreParticipants([{ ...lulu, visionScore: 120 }, ...players.slice(1)], { baseline, durationMin: 30 });
  assert.ok(warded[0].score > scored[0].score);
});

test('summarizeParticipant: opts.baseline が使われ、省略しても動く', () => {
  const doc = {
    matchId: 'x', gameCreation: 1, gameDuration: 1800, queueId: 420,
    participants: [
      { puuid: 'me', teamId: 100, win: true, championName: 'Ahri', teamPosition: 'MIDDLE', kills: 5, deaths: 1, assists: 5 },
      { puuid: 'o', teamId: 200, win: false, championName: 'Zed', teamPosition: 'MIDDLE', kills: 1, deaths: 5, assists: 1 }
    ]
  };
  assert.ok(summarizeParticipant(doc, 'me'));
  const called = [];
  summarizeParticipant(doc, 'me', { baseline: (c, r) => { called.push([c, r]); return null; } });
  assert.deepEqual(called, [['Ahri', 'MIDDLE'], ['Zed', 'MIDDLE']]);
});

test('bands: 不正な値は all に戻る / ダイヤ以上はマスター以上を含む', () => {
  assert.equal(readBandGroup('diamond'), 'diamond');
  assert.equal(readBandGroup('__proto__'), 'all');
  assert.equal(readBandGroup(undefined), 'all');
  assert.deepEqual(BAND_GROUPS.diamond.bands, ['MASTER_PLUS', 'DIAMOND']);
  assert.equal(BAND_GROUPS.all.bands, null);
});
