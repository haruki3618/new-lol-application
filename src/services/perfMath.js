// プレイ内容の診断（v6.11.0）の計算部分。DB に依存しない純粋な関数。
// v6.0 の診断は「勝敗・チャンピオン・ロール・時間」しか見ていなかった。ここでは保存済みの試合の
// KDA・CS・視界・ダメージ・ゴールドを使い、「勝ち負けでどう違うか」「直近で変わったか」「デスの多さ」を出す。
// 少ない試合数で断定しないため、所見にするのは次を満たしたものだけ:
//   ・全体で minTotal 試合以上、比べる2群がどちらも minGroup 試合以上
//   ・差が Welch の t 検定（大標本の近似）で両側95%水準で有意、かつ平均の差が minRelDiff 以上
import { zDiff } from './insightsMath.js';

export const PERF_DEFAULTS = {
  remakeSec: 300,
  minTotal: 20,
  recentN: 20, // 「直近」とみなす試合数
  minGroup: 15, // 比べる2群それぞれの最低試合数
  minRelDiff: 0.1, // 平均の差が、以前の平均の 10% 以上
  z: 1.96,
  deathHigh: 7, // 「デスが多い試合」の目安
  minBucketPt: 8
};

// key: 値の名前 / better: 大きいほど良い(1)か小さいほど良い(-1)か
export const METRICS = [
  { key: 'deaths', label: 'デス', better: -1, digits: 1 },
  { key: 'kda', label: 'KDA', better: 1, digits: 2 },
  { key: 'csMin', label: 'CS/分', better: 1, digits: 1 },
  { key: 'visMin', label: '視界スコア/分', better: 1, digits: 2 },
  { key: 'dmgMin', label: 'ダメージ/分', better: 1, digits: 0 }
];

const round = (n, d) => { const p = 10 ** d; return Math.round(n * p) / p; };
const finite = (n) => Number.isFinite(n);

// 1試合ぶんの指標。時間が分からない試合は分あたりの値を null にする
export function gameMetrics(g) {
  const min = g.dur > 0 ? g.dur / 60 : 0;
  const k = g.k || 0, d = g.d || 0, a = g.a || 0;
  return {
    t: g.t, win: Boolean(g.win), k, d, a,
    kda: (k + a) / Math.max(1, d),
    csMin: min ? (g.cs || 0) / min : null,
    visMin: min ? (g.vis || 0) / min : null,
    dmgMin: min ? (g.dmg || 0) / min : null,
    goldMin: min ? (g.gold || 0) / min : null,
    deaths: d
  };
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const variance = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
};
const valuesOf = (rows, key) => rows.map((r) => r[key]).filter(finite);

// Welch の t 値（A − B）。標本が足りなければ null
export function welchT(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  if (se === 0) return 0;
  return (mean(a) - mean(b)) / se;
}

// 試合の集合の平均。KDA は「合計キル+アシスト ÷ 合計デス」（1試合ごとの比の平均だと、デス0の試合に引っ張られる）
export function summarize(rows) {
  const n = rows.length;
  if (n === 0) return null;
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  const avg = (key, d) => { const m = mean(valuesOf(rows, key)); return m === null ? null : round(m, d); };
  return {
    n, wins: rows.filter((r) => r.win).length,
    kills: round(sum('k') / n, 1), deaths: round(sum('d') / n, 1), assists: round(sum('a') / n, 1),
    kda: round((sum('k') + sum('a')) / Math.max(1, sum('d')), 2),
    csMin: avg('csMin', 1), visMin: avg('visMin', 2), dmgMin: avg('dmgMin', 0), goldMin: avg('goldMin', 0)
  };
}

function trendOf(rows, o) {
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const recent = sorted.slice(-o.recentN);
  const earlier = sorted.slice(0, Math.max(0, sorted.length - o.recentN));
  const ready = recent.length >= o.minGroup && earlier.length >= o.minGroup;
  const out = { ready, recentN: recent.length, earlierN: earlier.length, rows: [] };
  if (!ready) return out;
  for (const m of METRICS) {
    const a = valuesOf(recent, m.key);
    const b = valuesOf(earlier, m.key);
    const ma = mean(a), mb = mean(b);
    if (ma === null || mb === null || mb === 0) continue;
    const rel = (ma - mb) / Math.abs(mb);
    const t = welchT(a, b);
    out.rows.push({
      key: m.key, label: m.label, digits: m.digits,
      recent: round(ma, m.digits), earlier: round(mb, m.digits), rel: round(rel * 100, 0),
      better: m.better, significant: t !== null && Math.abs(t) >= o.z && Math.abs(rel) >= o.minRelDiff
    });
  }
  return out;
}

const BANDS = [
  { label: '0〜3デス', test: (d) => d <= 3 },
  { label: '4〜6デス', test: (d) => d >= 4 && d <= 6 },
  { label: '7〜9デス', test: (d) => d >= 7 && d <= 9 },
  { label: '10デス以上', test: (d) => d >= 10 }
];

/**
 * プレイ内容の診断。
 * @param {Array<{t:number,dur:number,win:boolean,k:number,d:number,a:number,cs:number,vis:number,dmg:number,gold:number}>} games
 * @param {Partial<typeof PERF_DEFAULTS>} [options]
 */
export function analyzePerformance(games, options = {}) {
  const o = { ...PERF_DEFAULTS, ...options };
  const rows = (games || [])
    .filter((g) => g && finite(g.t) && !(g.dur > 0 && g.dur < o.remakeSec))
    .map(gameMetrics);
  const n = rows.length;
  const reliable = n >= o.minTotal;
  const winRows = rows.filter((r) => r.win);
  const lossRows = rows.filter((r) => !r.win);
  const trend = trendOf(rows, o);

  const deathBands = BANDS.map((b) => {
    const sub = rows.filter((r) => b.test(r.d));
    const wins = sub.filter((r) => r.win).length;
    return { label: b.label, games: sub.length, wins, winRate: sub.length ? round((wins / sub.length) * 100, 1) : 0 };
  });

  const findings = [];
  if (reliable) {
    for (const r of trend.rows) {
      if (!r.significant) continue;
      const improved = (r.recent - r.earlier) * r.better > 0;
      const sign = r.rel > 0 ? '+' : '';
      findings.push({
        level: improved ? 'good' : 'warn', key: `trend-${r.key}`,
        text: `直近 ${trend.recentN} 試合の平均${r.label}は ${r.recent}（それ以前の ${trend.earlierN} 試合は ${r.earlier}、${sign}${r.rel}%）。${improved ? '良くなっています。' : '悪くなっています。'}`
      });
    }
    const high = rows.filter((r) => r.d >= o.deathHigh);
    const low = rows.filter((r) => r.d < o.deathHigh);
    if (high.length >= o.minGroup && low.length >= o.minGroup) {
      const hw = high.filter((r) => r.win).length;
      const lw = low.filter((r) => r.win).length;
      const z = zDiff(hw, high.length, lw, low.length);
      const diff = round((hw / high.length - lw / low.length) * 100, 1);
      if (z !== null && Math.abs(z) >= o.z && Math.abs(diff) >= o.minBucketPt) {
        findings.push({
          level: diff < 0 ? 'warn' : 'info', key: 'deaths-high',
          text: `デスが ${o.deathHigh} 以上の試合は全体の ${round((high.length / n) * 100, 0)}%（${high.length} 試合）で、勝率は ${round((hw / high.length) * 100, 1)}%。それ未満の試合は ${round((lw / low.length) * 100, 1)}% です（差 ${diff > 0 ? '+' : ''}${diff}pt）。`
        });
      }
    }
    const order = { warn: 0, good: 1, info: 2 };
    findings.sort((a, b) => order[a.level] - order[b.level]);
  }

  return {
    n, reliable, minTotal: o.minTotal, recentN: o.recentN,
    all: summarize(rows), wins: summarize(winRows), losses: summarize(lossRows),
    trend, deathBands, findings
  };
}
