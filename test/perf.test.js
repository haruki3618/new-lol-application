import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePerformance, gameMetrics, summarize, welchT } from '../src/services/perfMath.js';

// 決まった乱数で、再現できるデータを作る
function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function makeGames(n, { deaths = 5, win = 0.5, seed = 1, start = 0 } = {}) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    t: 1_700_000_000_000 + (start + i) * 3_600_000, dur: 1800, win: r() < win,
    k: 5, d: Math.max(0, Math.round(deaths + (r() - 0.5) * 4)), a: 7, cs: 200, vis: 30, dmg: 20000, gold: 12000
  }));
}

test('gameMetrics: 分あたりの値と KDA（デス 0 でも割り算で壊れない）', () => {
  const m = gameMetrics({ t: 1, dur: 1200, win: true, k: 4, d: 0, a: 6, cs: 100, vis: 20, dmg: 10000, gold: 8000 });
  assert.equal(m.kda, 10);
  assert.equal(m.csMin, 5);
  assert.equal(m.visMin, 1);
  assert.equal(gameMetrics({ t: 1, dur: 0, k: 1, d: 1, a: 1 }).csMin, null, '時間が不明なら分あたりは null');
});

test('summarize: KDA は合計どうしの比。空なら null', () => {
  const rows = [
    gameMetrics({ t: 1, dur: 1800, win: true, k: 10, d: 0, a: 0, cs: 0, vis: 0, dmg: 0, gold: 0 }),
    gameMetrics({ t: 2, dur: 1800, win: false, k: 0, d: 10, a: 0, cs: 0, vis: 0, dmg: 0, gold: 0 })
  ];
  assert.equal(summarize(rows).kda, 1, '(10+0)/(0+10)。1 試合ごとの比の平均（5.0）にはしない');
  assert.equal(summarize([]), null);
});

test('welchT: 差が無ければ 0 付近、標本不足は null', () => {
  assert.equal(welchT([1], [1, 2]), null);
  assert.equal(welchT([5, 5, 5], [5, 5, 5]), 0);
  assert.ok(welchT([10, 11, 12, 11], [1, 2, 1, 2]) > 5);
});

test('analyzePerformance: 試合数が少ないと所見を出さない', () => {
  const r = analyzePerformance(makeGames(10));
  assert.equal(r.reliable, false);
  assert.deepEqual(r.findings, []);
  assert.equal(r.n, 10);
});

test('analyzePerformance: リメイクと壊れた行を除く', () => {
  const games = [...makeGames(25), { t: 5, dur: 120, win: false, k: 0, d: 0, a: 0 }, null, { t: NaN }];
  assert.equal(analyzePerformance(games).n, 25);
});

test('analyzePerformance: 直近だけデスが大きく増えたら「悪くなっています」を出す', () => {
  const earlier = makeGames(40, { deaths: 4, seed: 3, start: 0 });
  const recent = makeGames(20, { deaths: 9, seed: 4, start: 40 });
  const r = analyzePerformance([...earlier, ...recent]);
  assert.equal(r.trend.ready, true);
  const f = r.findings.find((x) => x.key === 'trend-deaths');
  assert.ok(f, 'デスの悪化を検出する');
  assert.equal(f.level, 'warn');
  assert.match(f.text, /悪くなっています/);
});

test('analyzePerformance: 変化が無いデータでは、傾向の所見を出さない（偶然を断定しない）', () => {
  const r = analyzePerformance(makeGames(80, { deaths: 5, seed: 7 }));
  assert.equal(r.findings.filter((f) => f.key.startsWith('trend-')).length, 0);
});

test('analyzePerformance: デスの多い試合の勝率が大きく低いと所見になる', () => {
  const games = [];
  for (let i = 0; i < 40; i++) games.push({ t: 1e12 + i * 3.6e6, dur: 1800, win: false, k: 2, d: 9, a: 3, cs: 150, vis: 20, dmg: 12000, gold: 9000 });
  for (let i = 0; i < 40; i++) games.push({ t: 2e12 + i * 3.6e6, dur: 1800, win: i % 4 !== 0, k: 8, d: 3, a: 9, cs: 200, vis: 25, dmg: 20000, gold: 12000 });
  const r = analyzePerformance(games);
  assert.ok(r.findings.some((f) => f.key === 'deaths-high' && f.level === 'warn'));
  assert.equal(r.deathBands.reduce((s, b) => s + b.games, 0), r.n, '帯の合計が全試合に一致する');
});
