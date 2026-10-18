import test from 'node:test';
import assert from 'node:assert/strict';
import { slimTimeline, analyzeTimeline, lineChartSvg } from '../src/services/timelineMath.js';

// 10人（1〜5 = チーム100、6〜10 = チーム200）、毎分のフレームを作る
function rawTimeline({ minutes = 20, goldPerMin = (id) => 300, csPerMin = (id) => 7, events = [] } = {}) {
  const frames = [];
  for (let m = 0; m <= minutes; m++) {
    const participantFrames = {};
    for (let id = 1; id <= 10; id++) {
      participantFrames[id] = { totalGold: 500 + goldPerMin(id) * m, minionsKilled: Math.round(csPerMin(id) * m), jungleMinionsKilled: 0, xp: 200 * m, level: 1 + Math.floor(m / 2) };
    }
    frames.push({ timestamp: m * 60000 + 25, participantFrames, events: events.filter((e) => Math.floor(e.timestamp / 60000) === m) });
  }
  return { info: { participants: Array.from({ length: 10 }, (_, i) => ({ participantId: i + 1, puuid: 'p' + (i + 1) })), frames } };
}
const POS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const roster = Array.from({ length: 10 }, (_, i) => ({
  puuid: 'p' + (i + 1), teamId: i < 5 ? 100 : 200, position: POS[i % 5], championName: 'Champ' + (i + 1), name: 'P' + (i + 1) + '#JP1', win: i < 5
}));

test('slimTimeline: フレームは10人分の [gold, cs, xp, level]、イベントはキュー・モンスター・建物だけ', () => {
  const raw = rawTimeline({ minutes: 3, events: [
    { type: 'CHAMPION_KILL', timestamp: 90000, killerId: 1, victimId: 6, assistingParticipantIds: [2] },
    { type: 'ELITE_MONSTER_KILL', timestamp: 120000, monsterType: 'DRAGON', killerTeamId: 100 },
    { type: 'WARD_PLACED', timestamp: 100000 }
  ] });
  const s = slimTimeline(raw);
  assert.equal(s.frames.length, 4);
  assert.equal(s.frames[2].p[0][0], 500 + 300 * 2);
  assert.equal(s.events.length, 2);
  assert.equal(slimTimeline({}), null);
});

test('analyzeTimeline: レーン相手との CS 差・ゴールド差（CS 7 対 5 を毎分）', () => {
  const raw = rawTimeline({ goldPerMin: (id) => (id === 3 ? 400 : id === 8 ? 300 : 350), csPerMin: (id) => (id === 3 ? 8 : id === 8 ? 6 : 7) });
  const r = analyzeTimeline(slimTimeline(raw), roster, 'p3'); // p3 = チーム100の MIDDLE → 相手は p8
  assert.equal(r.opp.name, 'P8#JP1');
  const c10 = r.checkpoints.find((c) => c.min === 10);
  assert.equal(c10.me.cs, 80);
  assert.equal(c10.opp.cs, 60);
  assert.equal(c10.csDiff, 20);
  assert.equal(c10.goldDiff, 1000);
  assert.ok(r.findings.some((f) => f.includes('10分時点のCS') && f.includes('20 多い')));
  assert.equal(r.lastMin, 20);
  assert.equal(r.series.lane.length, 21);
});

test('analyzeTimeline: 差が小さければ「ほぼ同じ」、10分未満の試合はチェックポイントなし', () => {
  const r = analyzeTimeline(slimTimeline(rawTimeline()), roster, 'p3');
  assert.ok(r.findings[0].includes('ほぼ同じ'));
  const short = analyzeTimeline(slimTimeline(rawTimeline({ minutes: 7 })), roster, 'p3');
  assert.equal(short.checkpoints.length, 0);
});

test('analyzeTimeline: 最後の中途半端なフレームは毎分の系列に入れない', () => {
  const raw = rawTimeline({ minutes: 5 });
  raw.info.frames.push({ ...raw.info.frames[5], timestamp: 5 * 60000 + 33000 });
  const r = analyzeTimeline(slimTimeline(raw), roster, 'p3');
  assert.equal(r.lastMin, 5);
  assert.equal(r.series.team.length, 6);
});

test('analyzeTimeline: 同じロールの相手が1人に決まらなければレーン比較をしない', () => {
  const dup = roster.map((r) => (r.puuid === 'p9' ? { ...r, position: 'MIDDLE' } : r));
  const r = analyzeTimeline(slimTimeline(rawTimeline()), dup, 'p3');
  assert.equal(r.opp, null);
  assert.equal(r.series.lane, null);
  assert.equal(r.checkpoints[0].csDiff, null);
});

test('analyzeTimeline: デス・キル・序盤デス・オブジェクト（建物は壊された側の反対が取った側）', () => {
  const raw = rawTimeline({ events: [
    { type: 'CHAMPION_KILL', timestamp: 3 * 60000, killerId: 8, victimId: 3, assistingParticipantIds: [] },
    { type: 'CHAMPION_KILL', timestamp: 8 * 60000, killerId: 9, victimId: 3, assistingParticipantIds: [] },
    { type: 'CHAMPION_KILL', timestamp: 12 * 60000, killerId: 3, victimId: 7, assistingParticipantIds: [] },
    { type: 'CHAMPION_KILL', timestamp: 13 * 60000, killerId: 1, victimId: 8, assistingParticipantIds: [3] },
    { type: 'ELITE_MONSTER_KILL', timestamp: 6 * 60000, monsterType: 'DRAGON', killerTeamId: 200 },
    { type: 'BUILDING_KILL', timestamp: 14 * 60000, buildingType: 'TOWER_BUILDING', teamId: 200 }
  ] });
  const r = analyzeTimeline(slimTimeline(raw), roster, 'p3');
  assert.deepEqual(r.deaths, [3, 8]);
  assert.deepEqual(r.kills, [12]);
  assert.deepEqual(r.assists, [13]);
  assert.equal(r.earlyDeaths, 2);
  assert.ok(r.findings.some((f) => f.includes('2 回デス')));
  const dragon = r.objectives.find((o) => o.label === 'ドラゴン');
  assert.equal(dragon.mine, false);
  assert.equal(r.objectives.find((o) => o.label === 'タワー').mine, true);
});

test('analyzeTimeline: 大きな劣勢からの逆転・先行からの敗北は、勝敗と最大差でだけ書く', () => {
  const behind = rawTimeline({ goldPerMin: (id) => (id <= 5 ? 200 : 600) }); // 味方が毎分 2000 ずつ遅れる
  const r = analyzeTimeline(slimTimeline(behind), roster, 'p3'); // roster では 100 側が win
  assert.ok(r.peak.deficit.v <= -3000);
  assert.ok(r.findings.some((f) => f.includes('逆転して勝利')));
  const lostRoster = roster.map((p) => ({ ...p, win: p.teamId === 200 }));
  const ahead = rawTimeline({ goldPerMin: (id) => (id <= 5 ? 600 : 200) });
  const r2 = analyzeTimeline(slimTimeline(ahead), lostRoster, 'p3');
  assert.ok(r2.findings.some((f) => f.includes('先行から、最終的に敗北')));
  assert.ok(!r2.findings.some((f) => f.includes('逆転して勝利')));
});

test('analyzeTimeline: 見る人が参加者にいなければ null', () => {
  assert.equal(analyzeTimeline(slimTimeline(rawTimeline()), roster, 'nobody'), null);
});

test('lineChartSvg: 点が2つ未満なら空、あれば polyline と 0 の線を含む', () => {
  assert.equal(lineChartSvg([{ cls: 'team', label: 'x', points: [{ min: 0, v: 0 }] }]), '');
  const svg = lineChartSvg([{ cls: 'team', label: 'ゴールド差', points: [{ min: 0, v: 0 }, { min: 10, v: 1200 }, { min: 20, v: -300 }] }]);
  assert.match(svg, /<svg/);
  assert.match(svg, /polyline class="tl-line team"/);
  assert.match(svg, /tl-grid zero/);
  assert.ok(!/NaN|undefined/.test(svg));
});
