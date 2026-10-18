// チャンピオンのティアリスト（DB に依存しない）。
// 勝率は試合数が少ないとぶれるため、「50% の仮想試合を prior 回足した」補正済み勝率で比べる。
// ティアは固定の閾値ではなく、条件を満たすチャンピオンの中での順位（上位10% = S / 35% = A / 75% = B / 残り = C）。
const round1 = (n) => Math.round(n * 10) / 10;

export function adjustedWinRate(wins, games, prior = 20) {
  return (wins + prior * 0.5) / (games + prior);
}

export function buildTierList(rows, prevRows = [], { minGames = 30, prior = 20 } = {}) {
  const prev = new Map(prevRows.map((r) => [r.championName, r]));

  const enriched = rows.map((r) => {
    const adj = adjustedWinRate(r.wins, r.games, prior) * 100;
    const score = adj - 50 + 0.08 * (r.pickRate || 0) + 0.04 * (r.banRate || 0);
    const p = prev.get(r.championName);
    const prevAdj = p && p.games >= minGames ? adjustedWinRate(p.wins, p.games, prior) * 100 : null;
    return { ...r, adj: round1(adj), score, delta: prevAdj === null ? null : round1(adj - prevAdj) };
  });

  const eligible = enriched.filter((r) => r.games >= minGames).sort((a, b) => b.score - a.score);
  const insufficient = enriched.filter((r) => r.games < minGames).sort((a, b) => b.games - a.games);
  const tiers = { S: [], A: [], B: [], C: [] };

  // 比べる相手が少なすぎるときは、ティアを付けると誤解を招くので付けない
  if (eligible.length < 5) {
    return { tiers, insufficient: [...eligible, ...insufficient], eligible: eligible.length, reliable: false };
  }

  const n = eligible.length;
  eligible.forEach((r, i) => {
    const pos = (i + 0.5) / n;
    tiers[pos <= 0.1 ? 'S' : pos <= 0.35 ? 'A' : pos <= 0.75 ? 'B' : 'C'].push(r);
  });
  return { tiers, insufficient, eligible: n, reliable: true };
}
