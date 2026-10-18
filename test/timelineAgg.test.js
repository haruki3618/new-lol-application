import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTimelines } from '../src/services/timelineAggMath.js';

const A = ({ win = true, team15 = 1000, gold15 = 200, cs10 = 5, lead = 0, deficit = 0, early = 0 } = {}) => ({
  me: { win },
  checkpoints: [
    { min: 10, csDiff: cs10, goldDiff: gold15 / 2, teamDiff: team15 / 2 },
    { min: 15, csDiff: cs10 * 1.5, goldDiff: gold15, teamDiff: team15 }
  ],
  peak: { lead: lead ? { v: lead } : null, deficit: deficit ? { v: -deficit } : null },
  earlyDeaths: early
});

test('空・null でも落ちない', () => {
  const r = aggregateTimelines([null, undefined]);
  assert.equal(r.analyzed, 0);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.checkpoints, []);
});

test('平均は取得できた試合だけで数える（20分が無い試合は 20分に含めない）', () => {
  const r = aggregateTimelines([A({ cs10: 4 }), A({ cs10: 8 })]);
  assert.equal(r.checkpoints.find((c) => c.min === 10).csDiff, 6);
  assert.equal(r.checkpoints.find((c) => c.min === 20), undefined);
});

test('15分の先行・劣勢の勝率。5試合未満は所見にしない', () => {
  const few = aggregateTimelines([A({ team15: 2000 }), A({ team15: -2000, win: false })]);
  assert.equal(few.findings.length, 0);

  const list = [
    ...Array.from({ length: 6 }, (_, i) => A({ team15: 2000, win: i < 5 })),
    ...Array.from({ length: 6 }, (_, i) => A({ team15: -2000, win: i < 1 }))
  ];
  const r = aggregateTimelines(list);
  assert.equal(r.ahead15.n, 6);
  assert.equal(r.ahead15.wins, 5);
  assert.equal(r.behind15.winRate, 16.7);
  assert.ok(r.findings.some((f) => f.key === 'at15'));
});

test('大きなリードを取りこぼした試合が多いと warn', () => {
  const list = Array.from({ length: 8 }, (_, i) => A({ lead: 4000, win: i < 3 }));
  const f = aggregateTimelines(list).findings.find((x) => x.key === 'lead');
  assert.equal(f.level, 'warn');
  assert.match(f.text, /3 試合/);
});

test('序盤デスが多い試合と、それ以外の勝率を比べる', () => {
  const list = [
    ...Array.from({ length: 5 }, () => A({ early: 3, win: false })),
    ...Array.from({ length: 5 }, () => A({ early: 0, win: true }))
  ];
  const f = aggregateTimelines(list).findings.find((x) => x.key === 'early');
  assert.equal(f.level, 'warn');
  assert.equal(aggregateTimelines(list).earlyDeaths.avg, 1.5);
});
