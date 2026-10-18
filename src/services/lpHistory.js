import LpSnapshot from '../models/LpSnapshot.js';

const BASE = { IRON: 0, BRONZE: 400, SILVER: 800, GOLD: 1200, PLATINUM: 1600, EMERALD: 2000, DIAMOND: 2400, MASTER: 2800, GRANDMASTER: 2800, CHALLENGER: 2800 };
const DIV = { IV: 0, III: 100, II: 200, I: 300 };
const QUEUES = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'];

// ティア・段位・LP を1本の数値にして、グラフの縦軸にする
export function absoluteLp(tier, rank, lp) {
  const base = BASE[tier] ?? 0;
  return base + (base >= 2800 ? 0 : DIV[rank] ?? 0) + (lp || 0);
}

// 前回から勝敗・LP・ランクのどれかが変わったときだけ記録する
export async function recordLp(puuid, entries) {
  for (const e of entries) {
    if (!QUEUES.includes(e.queueType)) continue;
    const last = await LpSnapshot.findOne({ puuid, queueType: e.queueType }).sort({ at: -1 }).lean();
    if (
      last &&
      last.tier === e.tier && last.rank === e.rank && last.lp === e.leaguePoints &&
      last.wins === e.wins && last.losses === e.losses
    ) continue;
    await LpSnapshot.create({
      puuid, queueType: e.queueType, tier: e.tier, rank: e.rank,
      lp: e.leaguePoints, wins: e.wins, losses: e.losses
    });
  }
}

export async function getLpHistory(puuid, queueType = 'RANKED_SOLO_5x5', limit = 100) {
  const rows = await LpSnapshot.find({ puuid, queueType }).sort({ at: -1 }).limit(limit).lean();
  rows.reverse();
  return rows.map((r) => ({
    at: r.at.getTime(),
    value: absoluteLp(r.tier, r.rank, r.lp),
    text: `${r.tier} ${r.rank} ${r.lp}LP`
  }));
}
