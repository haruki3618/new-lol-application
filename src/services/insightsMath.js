// プレイ傾向の診断（v6.0）の計算部分。DB に依存しない純粋な関数なので、単体でテストできる。
// 入力: 1人分の保存済み試合 [{ t(開始ms), dur(秒), win, champ, role }]（順不同でよい）
// 「少ない試合数で断定しない」ため、所見にするのは次を全部満たした区分だけ:
//   ・診断全体で minTotal 試合以上
//   ・その区分とそれ以外の両方が minBucket 試合以上
//   ・2つの割合の差が両側95%水準で有意（z検定）かつ minDiffPt ポイント以上
export const JST_OFFSET_MS = 9 * 3600 * 1000;

export const DEFAULTS = {
  sessionGapMin: 60, // 前の試合の終了からこの分数以内に次が始まれば同じセッション
  remakeSec: 300, // これ未満の試合（リメイク・早期降参）は除外
  minTotal: 30,
  minBucket: 15,
  minDiffPt: 8,
  few: 10, // この試合数未満は「試合数が少ない」と表示
  z: 1.96
};

const round1 = (n) => Math.round(n * 10) / 10;
const rate = (w, n) => (n > 0 ? round1((w / n) * 100) : 0);

// Wilson 区間（95%）。単位は %（小数1桁）
/**
 * 勝率の Wilson 区間（既定は 95%）。
 * @param {number} wins
 * @param {number} n 試合数。0 以下なら { lo: 0, hi: 0 }
 * @param {number} [z]
 * @returns {{lo: number, hi: number}} 単位は %（小数 1 桁）
 */
export function wilson(wins, n, z = 1.96) {
  if (!(n > 0)) return { lo: 0, hi: 0 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: round1(Math.max(0, center - margin) * 100), hi: round1(Math.min(1, center + margin) * 100) };
}

// 2つの割合の差の z 値（A − B）。どちらかが 0 試合なら null
/**
 * 2 つの勝率の差（A − B）の z 値。
 * @param {number} winsA
 * @param {number} nA
 * @param {number} winsB
 * @param {number} nB
 * @returns {number | null} どちらかが 0 試合なら null
 */
export function zDiff(winsA, nA, winsB, nB) {
  if (!(nA > 0) || !(nB > 0)) return null;
  const pool = (winsA + winsB) / (nA + nB);
  const se = Math.sqrt(pool * (1 - pool) * (1 / nA + 1 / nB));
  if (se === 0) return 0;
  return (winsA / nA - winsB / nB) / se;
}

// 試合に「セッション内の順番・連敗数・連勝数・時間帯」を付ける。リメイクは除く
/**
 * 試合に「セッション内の順番・連敗数・連勝数・時間帯」を付ける。リメイク（remakeSec 未満）は除く。
 * @param {import('../types.js').InsightGame[]} games 順不同でよい
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{rows: object[], sessions: number}}
 */
export function annotate(games, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const list = (games || [])
    .filter((g) => g && Number.isFinite(g.t) && !(g.dur > 0 && g.dur < o.remakeSec))
    .sort((a, b) => a.t - b.t);

  const rows = [];
  let sessions = 0;
  let prevEnd = null;
  let idx = 0;
  let lossRun = 0;
  let winRun = 0;
  for (const g of list) {
    if (prevEnd === null || g.t - prevEnd > o.sessionGapMin * 60000) {
      sessions += 1;
      idx = 0;
      lossRun = 0;
      winRun = 0;
    }
    idx += 1;
    rows.push({
      t: g.t,
      win: Boolean(g.win),
      champ: g.champ,
      role: g.role || '',
      hour: new Date(g.t + JST_OFFSET_MS).getUTCHours(),
      idx,
      lossRun, // この試合に入る時点での連敗数
      winRun // 同、連勝数
    });
    if (g.win) { winRun += 1; lossRun = 0; } else { lossRun += 1; winRun = 0; }
    prevEnd = g.t + (g.dur > 0 ? g.dur * 1000 : 0);
  }
  return { rows, sessions };
}

const HOURS = [
  { key: 'late', label: '深夜（0〜5時）', test: (h) => h < 6 },
  { key: 'morning', label: '朝（6〜11時）', test: (h) => h >= 6 && h < 12 },
  { key: 'day', label: '昼（12〜17時）', test: (h) => h >= 12 && h < 18 },
  { key: 'night', label: '夜（18〜23時）', test: (h) => h >= 18 }
];

function makeBucket(key, label, subset, total, o) {
  const games = subset.length;
  const wins = subset.filter((r) => r.win).length;
  const restGames = total.games - games;
  const restWins = total.wins - wins;
  const diffPt = games > 0 && restGames > 0 ? round1(rate(wins, games) - rate(restWins, restGames)) : null;
  const z = zDiff(wins, games, restWins, restGames);
  const enough = games >= o.minBucket && restGames >= o.minBucket;
  const significant = enough && z !== null && Math.abs(z) >= o.z && diffPt !== null && Math.abs(diffPt) >= o.minDiffPt;
  return {
    key, label, games, wins,
    winRate: rate(wins, games),
    ci: wilson(wins, games, o.z),
    rest: { games: restGames, wins: restWins, winRate: rate(restWins, restGames) },
    diffPt, enough, significant,
    few: games < o.few
  };
}

function poolOf(rows) {
  const by = new Map();
  const roles = new Map();
  for (const r of rows) {
    if (r.champ) {
      const c = by.get(r.champ) || { name: r.champ, games: 0, wins: 0 };
      c.games += 1;
      if (r.win) c.wins += 1;
      by.set(r.champ, c);
    }
    if (r.role) {
      const x = roles.get(r.role) || { role: r.role, games: 0, wins: 0 };
      x.games += 1;
      if (r.win) x.wins += 1;
      roles.set(r.role, x);
    }
  }
  const all = [...by.values()].sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
  const n = all.reduce((s, c) => s + c.games, 0);
  if (n === 0) return { pool: null, roles: [] };

  let cum = 0;
  let halfCount = 0;
  for (const c of all) { cum += c.games; halfCount += 1; if (cum * 2 >= n) break; }
  const share = (k) => Math.round((all.slice(0, k).reduce((s, c) => s + c.games, 0) / n) * 100);
  const fmt = (c) => ({ ...c, winRate: rate(c.wins, c.games), ci: wilson(c.wins, c.games) });

  return {
    pool: {
      unique: all.length,
      top: all.filter((c) => c.games >= 2).slice(0, 8).map(fmt),
      singles: all.filter((c) => c.games === 1).length,
      top1Share: share(1),
      top3Share: share(3),
      halfCount
    },
    roles: [...roles.values()]
      .sort((a, b) => b.games - a.games)
      .map((x) => ({ role: x.role, games: x.games, winRate: rate(x.wins, x.games), share: Math.round((x.games / rows.length) * 100) }))
  };
}

/**
 * プレイ傾向の診断。少ない試合数では断定せず、有意な差があった区分だけ所見にする。
 * @param {import('../types.js').InsightGame[]} games
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {object}
 */
export function analyze(games, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { rows, sessions } = annotate(games, o);
  const total = { games: rows.length, wins: rows.filter((r) => r.win).length };
  total.winRate = rate(total.wins, total.games);
  const b = (key, label, fn) => makeBucket(key, label, rows.filter(fn), total, o);

  const streak = [
    b('loss1', '1敗後', (r) => r.lossRun === 1),
    b('loss2', '2連敗後', (r) => r.lossRun === 2),
    b('loss3', '3連敗以上', (r) => r.lossRun >= 3),
    b('afterWin', '勝った直後', (r) => r.winRun >= 1),
    b('first', 'セッションの1試合目', (r) => r.idx === 1)
  ];
  const streakLossMulti = b('lossMulti', '2連敗以上', (r) => r.lossRun >= 2);
  const hours = HOURS.map((x) => b(x.key, x.label, (r) => x.test(r.hour)));
  const sessionIndex = [
    b('s1', '1試合目', (r) => r.idx === 1),
    b('s2', '2試合目', (r) => r.idx === 2),
    b('s3', '3試合目', (r) => r.idx === 3),
    b('s4', '4試合目', (r) => r.idx === 4),
    b('s5', '5試合目以降', (r) => r.idx >= 5)
  ];
  const sessionLate = b('s4p', '4試合目以降', (r) => r.idx >= 4);
  const { pool, roles } = poolOf(rows);

  const reliable = total.games >= o.minTotal;
  const findings = [];
  if (reliable) {
    const seen = new Set();
    for (const x of [...streak, streakLossMulti, ...hours, ...sessionIndex, sessionLate]) {
      if (!x.significant || seen.has(x.label)) continue;
      seen.add(x.label);
      const sign = x.diffPt > 0 ? '+' : '';
      findings.push({
        level: x.diffPt < 0 ? 'warn' : 'good',
        key: x.key,
        text: `${x.label}の勝率は ${x.winRate}%（それ以外は ${x.rest.winRate}%、差 ${sign}${x.diffPt}pt・${x.games}試合）。`
      });
    }
    if (pool && pool.top1Share >= 50 && pool.top[0]) {
      findings.push({ level: 'info', key: 'pool', text: `${pool.top[0].name} 1体で試合の ${pool.top1Share}% を占めています。` });
    }
    const order = { warn: 0, good: 1, info: 2 };
    findings.sort((a, c) => order[a.level] - order[c.level]);
  }

  return {
    reliable, minTotal: o.minTotal,
    opts: { sessionGapMin: o.sessionGapMin, minDiffPt: o.minDiffPt, minBucket: o.minBucket, remakeSec: o.remakeSec },
    total, sessions,
    from: rows[0]?.t ?? null, to: rows.length ? rows[rows.length - 1].t : null,
    streak, streakLossMulti, hours, sessionIndex, sessionLate,
    pool, roles, findings
  };
}
