// ライブゲーム強化（v6.1）の計算部分。DB に依存しない純粋な関数なので、単体でテストできる。
// 入力: 1人分の保存済み試合 [{ t, queueId, win, champ, k, d, a, role }]（新しい順）
// 少ない試合数で断定しないため、「データ不足」を明示し、勝率は少ない試合数では全体の勝率に引き寄せて（縮小推定）使う。
// 勝敗予想は「個人成績の合算」だけの簡易な目安。チャンピオン相性・ドラフト・連携・ランク差は見ない。
import { wilson } from './insightsMath.js';

export const LIVE_DEFAULTS = {
  recentN: 10, // 直近の調子に使う試合数
  minPool: 10, // この試合数未満の人は「データ不足」（予想にも使わない）
  minChampShow: 5, // このチャンピオンでの試合数がこれ未満なら「少ない」と注記
  priorOverall: 20, // 全体の勝率を 50% に引き寄せる強さ（仮想の試合数）
  priorChamp: 10, // チャンピオン別の勝率を、その人の全体勝率に引き寄せる強さ
  minPlayersForForecast: 6, // 十分なデータのある人がこの人数未満なら予想しない
  logitScale: 1, // チーム平均の差を勝率に変える係数
  clampPct: [30, 70], // 予想の上下限（これ以上は言い切れない）
  evenBandPt: 3, // 差がこの幅（ポイント）未満なら「ほぼ互角」
  slightBandPt: 8, // この幅未満なら「やや優勢」
  remakeSec: 300
};

const pct1 = (w, n) => (n > 0 ? Math.round((w / n) * 1000) / 10 : null);
const sameChamp = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function kdaOf(games) {
  let k = 0, d = 0, a = 0;
  for (const g of games) { k += g.k || 0; d += g.d || 0; a += g.a || 0; }
  if (games.length === 0) return null;
  return {
    k: Math.round((k / games.length) * 10) / 10,
    d: Math.round((d / games.length) * 10) / 10,
    a: Math.round((a / games.length) * 10) / 10,
    ratio: Math.round(((k + a) / Math.max(1, d)) * 100) / 100
  };
}

// 1人分の要約
export function summarizePlayer(allGames, champ, queueId, options = {}) {
  const o = { ...LIVE_DEFAULTS, ...options };
  const games = (allGames || []).filter((g) => (g.dur === undefined || g.dur >= o.remakeSec));

  // 同じキューの試合が十分あればそれを、無ければ全キューを基準にする
  const sameQueue = queueId ? games.filter((g) => g.queueId === queueId) : games;
  const useQueue = sameQueue.length >= o.minPool;
  const pool = useQueue ? sameQueue : games;

  const recentGames = games.slice(0, o.recentN);
  const recent = {
    n: recentGames.length,
    wins: recentGames.filter((g) => g.win).length,
    results: recentGames.map((g) => Boolean(g.win)), // 新しい順
    kda: kdaOf(recentGames)
  };

  const poolWins = pool.filter((g) => g.win).length;
  const overall = { n: pool.length, wins: poolWins, rate: pct1(poolWins, pool.length), scope: useQueue ? 'queue' : 'all' };

  const champGames = pool.filter((g) => sameChamp(g.champ, champ));
  const champWins = champGames.filter((g) => g.win).length;
  const champion = {
    n: champGames.length,
    wins: champWins,
    rate: pct1(champWins, champGames.length),
    ci: wilson(champWins, champGames.length),
    kda: kdaOf(champGames),
    few: champGames.length < o.minChampShow
  };

  const enough = pool.length >= o.minPool;
  let strength = null;
  if (enough) {
    const pOverall = (poolWins + 0.5 * o.priorOverall) / (pool.length + o.priorOverall);
    const pChamp = (champWins + pOverall * o.priorChamp) / (champGames.length + o.priorChamp);
    strength = { pOverall, pChamp, logit: logit(pChamp) };
  }
  return { enough, recent, overall, champion, strength };
}

// 10人分から簡易の勝敗予想（個人成績の合算だけ）。teams: [{ teamId, players: [{ summary }] }]
export function forecast(teams, options = {}) {
  const o = { ...LIVE_DEFAULTS, ...options };
  const ready = teams.reduce((s, t) => s + t.players.filter((p) => p.summary?.enough).length, 0);
  const total = teams.reduce((s, t) => s + t.players.length, 0);
  const base = { available: false, ready, total, probs: {}, label: '', reason: '' };

  if (teams.length !== 2) return { ...base, reason: 'チームが2つ揃っていないため予想できません。' };
  if (ready < o.minPlayersForForecast) {
    return { ...base, reason: `保存済みの試合が十分な人が ${ready} / ${total} 人のため、予想は出しません（${o.minPlayersForForecast} 人以上で表示）。` };
  }

  // データ不足の人は「平均的（0）」として扱う（推測で強い・弱いと決めない）
  const mean = (t) => t.players.reduce((s, p) => s + (p.summary?.enough ? p.summary.strength.logit : 0), 0) / Math.max(1, t.players.length);
  const [a, b] = teams;
  const raw = sigmoid((mean(a) - mean(b)) * o.logitScale);
  const [lo, hi] = o.clampPct;
  const pa = Math.min(hi, Math.max(lo, Math.round(raw * 100)));
  const pb = 100 - pa;
  const diff = Math.abs(pa - pb) / 2;
  const leader = pa >= pb ? a : b;
  const label = diff < o.evenBandPt ? 'ほぼ互角' : diff < o.slightBandPt ? 'やや優勢' : '優勢';
  return {
    ...base,
    available: true,
    probs: { [a.teamId]: pa, [b.teamId]: pb },
    leaderTeamId: diff < o.evenBandPt ? null : leader.teamId,
    label,
    reason: ''
  };
}
