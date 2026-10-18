// タイムライン分析の複数試合集計（v6.11.0）。DB・API に依存しない純粋な関数。
// 入力は analyzeTimeline（timelineMath.js）の結果の配列。1試合ごとの分析を、平均と「先行・劣勢のときの勝率」にまとめる。
export const TL_AGG_DEFAULTS = {
  checkpoints: [10, 15, 20],
  min: 5, // 所見にする最低試合数
  swing: 3000, // 「大きくリードした」「大きく劣勢だった」の目安（チームのゴールド差）
  earlyDeathCount: 2 // 10分までにこの数以上デスした試合を「序盤デスが多い」とする
};

const round = (n, d = 0) => { const p = 10 ** d; return Math.round(n * p) / p; };
const avg = (xs) => (xs.length ? round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
const rate = (w, n) => (n > 0 ? round((w / n) * 100, 1) : null);
const tally = (list) => ({ n: list.length, wins: list.filter((a) => a.me.win).length, winRate: rate(list.filter((a) => a.me.win).length, list.length) });

/**
 * @param {object[]} analyses analyzeTimeline の結果（null は除いて渡す）
 * @param {Partial<typeof TL_AGG_DEFAULTS>} [options]
 */
export function aggregateTimelines(analyses, options = {}) {
  const o = { ...TL_AGG_DEFAULTS, ...options };
  const list = (analyses || []).filter((a) => a && a.me);
  const cp = (a, m) => a.checkpoints.find((c) => c.min === m) || null;
  const nums = (m, key) => list.map((a) => cp(a, m)?.[key]).filter(Number.isFinite);

  const checkpoints = o.checkpoints.map((m) => ({
    min: m,
    n: list.filter((a) => cp(a, m)).length,
    csDiff: avg(nums(m, 'csDiff')), goldDiff: avg(nums(m, 'goldDiff')), teamDiff: avg(nums(m, 'teamDiff'))
  })).filter((c) => c.n > 0);

  const at15 = list.filter((a) => Number.isFinite(cp(a, 15)?.teamDiff));
  const ahead15 = tally(at15.filter((a) => cp(a, 15).teamDiff > 0));
  const behind15 = tally(at15.filter((a) => cp(a, 15).teamDiff < 0));
  const bigLead = tally(list.filter((a) => (a.peak?.lead?.v || 0) >= o.swing));
  const bigDeficit = tally(list.filter((a) => (a.peak?.deficit?.v || 0) <= -o.swing));
  const early = list.filter((a) => a.earlyDeaths >= o.earlyDeathCount);
  const notEarly = list.filter((a) => a.earlyDeaths < o.earlyDeathCount);
  const earlyDeaths = { avg: list.length ? round(list.reduce((s, a) => s + a.earlyDeaths, 0) / list.length, 1) : null, many: tally(early), rest: tally(notEarly) };

  const findings = [];
  if (ahead15.n >= o.min && behind15.n >= o.min) {
    findings.push({ level: 'info', key: 'at15', text: `15分時点でチームが先行していた ${ahead15.n} 試合は勝率 ${ahead15.winRate}%、劣勢だった ${behind15.n} 試合は ${behind15.winRate}% です。` });
  }
  if (bigLead.n >= o.min) {
    findings.push({
      level: bigLead.winRate < 70 ? 'warn' : 'good', key: 'lead',
      text: `ゴールドで ${o.swing.toLocaleString('ja-JP')} 以上リードした場面があった ${bigLead.n} 試合のうち、勝てたのは ${bigLead.wins} 試合（${bigLead.winRate}%）です。`
    });
  }
  if (bigDeficit.n >= o.min) {
    findings.push({ level: 'info', key: 'deficit', text: `${o.swing.toLocaleString('ja-JP')} 以上劣勢になった ${bigDeficit.n} 試合のうち、逆転できたのは ${bigDeficit.wins} 試合（${bigDeficit.winRate}%）です。` });
  }
  if (early.length >= o.min && notEarly.length >= o.min) {
    findings.push({
      level: earlyDeaths.many.winRate < earlyDeaths.rest.winRate ? 'warn' : 'info', key: 'early',
      text: `10分までに ${o.earlyDeathCount} デス以上した ${early.length} 試合の勝率は ${earlyDeaths.many.winRate}%（それ以外は ${earlyDeaths.rest.winRate}%）です。`
    });
  }
  const lane15 = checkpoints.find((c) => c.min === 15);
  if (lane15 && lane15.n >= o.min && lane15.goldDiff !== null && Math.abs(lane15.goldDiff) >= 300) {
    findings.push({
      level: lane15.goldDiff < 0 ? 'warn' : 'good', key: 'lane',
      text: `15分時点のレーン相手とのゴールド差は平均 ${lane15.goldDiff > 0 ? '+' : ''}${lane15.goldDiff.toLocaleString('ja-JP')}（${lane15.n} 試合）です。`
    });
  }
  const order = { warn: 0, good: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);

  return {
    analyzed: list.length, wins: list.filter((a) => a.me.win).length,
    checkpoints, ahead15, behind15, bigLead, bigDeficit, earlyDeaths, findings
  };
}
