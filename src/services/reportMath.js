// 週間・月間レポートの計算（DB に依存しない）

const DAY = 24 * 60 * 60 * 1000;
export const PERIODS = { week: { days: 7, label: '週間' }, month: { days: 30, label: '月間' } };

const pct = (w, g) => (g > 0 ? Math.round((w / g) * 100) : 0);
const kdaOf = (k, d, a) => (d === 0 ? (k + a > 0 ? 'Perfect' : '0.00') : ((k + a) / d).toFixed(2));

function summarize(rows) {
  const t = { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0, cs: 0, vision: 0, minutes: 0 };
  for (const { me, match } of rows) {
    t.games += 1;
    if (me.win) t.wins += 1;
    t.kills += me.kills || 0;
    t.deaths += me.deaths || 0;
    t.assists += me.assists || 0;
    t.cs += (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
    t.vision += me.visionScore || 0;
    t.minutes += (match.gameDuration || 0) / 60;
  }
  return {
    games: t.games,
    wins: t.wins,
    losses: t.games - t.wins,
    winRate: pct(t.wins, t.games),
    kda: kdaOf(t.kills, t.deaths, t.assists),
    kdaValue: t.deaths === 0 ? null : (t.kills + t.assists) / t.deaths,
    avgKills: t.games ? +(t.kills / t.games).toFixed(1) : 0,
    avgDeaths: t.games ? +(t.deaths / t.games).toFixed(1) : 0,
    avgAssists: t.games ? +(t.assists / t.games).toFixed(1) : 0,
    csPerMin: t.minutes > 0 ? +(t.cs / t.minutes).toFixed(1) : 0,
    visionPerMin: t.minutes > 0 ? +(t.vision / t.minutes).toFixed(2) : 0,
    hours: +(t.minutes / 60).toFixed(1)
  };
}

function pick(matches, puuid, from, to) {
  const rows = [];
  for (const match of matches || []) {
    if (!(match.gameCreation >= from && match.gameCreation < to)) continue;
    const me = (match.participants || []).find((p) => p.puuid === puuid);
    if (me) rows.push({ me, match });
  }
  return rows;
}

function champions(rows, limit = 5) {
  const map = new Map();
  for (const { me } of rows) {
    const e = map.get(me.championName) || { championName: me.championName, games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
    e.games += 1;
    if (me.win) e.wins += 1;
    e.kills += me.kills || 0;
    e.deaths += me.deaths || 0;
    e.assists += me.assists || 0;
    map.set(me.championName, e);
  }
  return [...map.values()]
    .sort((a, b) => b.games - a.games || b.wins - a.wins)
    .slice(0, limit)
    .map((e) => ({ championName: e.championName, games: e.games, wins: e.wins, losses: e.games - e.wins, winRate: pct(e.wins, e.games), kda: kdaOf(e.kills, e.deaths, e.assists) }));
}

// 日別の試合数・勝敗（棒グラフ用）。days 日前から今日まで、試合が無い日も 0 で並べる
function daily(rows, from, days) {
  const buckets = Array.from({ length: days }, (_, i) => ({ dayStart: from + i * DAY, games: 0, wins: 0 }));
  for (const { me, match } of rows) {
    const i = Math.min(days - 1, Math.floor((match.gameCreation - from) / DAY));
    if (i < 0) continue;
    buckets[i].games += 1;
    if (me.win) buckets[i].wins += 1;
  }
  return buckets;
}

// LP の増減。期間内の最初と最後のスナップショットの差（記録が2件未満なら null）
// snapshots: [{ at: ms, value: 絶対LP }]（古い順）
/**
 * 期間内の LP の増減（最初と最後の記録の差）。
 * @param {import('../types.js').LpPoint[]} snapshots 古い順
 * @param {number} from 期間の始まり（ミリ秒・含む）
 * @param {number} to 期間の終わり（ミリ秒・含まない）
 * @returns {{start: number, end: number, diff: number, points: number} | null} 期間内の記録が 2 件未満なら null
 */
export function lpChange(snapshots, from, to) {
  const inRange = (snapshots || []).filter((s) => s.at >= from && s.at < to);
  if (inRange.length < 2) return null;
  return { start: inRange[0].value, end: inRange[inRange.length - 1].value, diff: inRange[inRange.length - 1].value - inRange[0].value, points: inRange.length };
}

const delta = (cur, prev) => (prev.games > 0 && cur.games > 0 ? { winRate: cur.winRate - prev.winRate, csPerMin: +(cur.csPerMin - prev.csPerMin).toFixed(1) } : null);

/**
 * 週間・月間レポート。直近の期間と、その1つ前の期間を比べる。
 * @param {import('../types.js').MatchDoc[]} matches
 * @param {string} puuid
 * @param {{now?: number, period?: 'week' | 'month', snapshots?: import('../types.js').LpPoint[]}} [options] period が不正なら 'week'
 * @returns {{period: string, label: string, days: number, from: number, to: number, current: object, previous: object, delta: ({winRate: number, csPerMin: number} | null), champions: object[], best: (object | null), worst: (object | null), daily: object[], lp: (object | null)}}
 */
export function buildReport(matches, puuid, { now = Date.now(), period = 'week', snapshots = [] } = {}) {
  const key = Object.hasOwn(PERIODS, period) ? period : 'week';
  const cfg = PERIODS[key];
  const to = now + 1;
  const from = now - cfg.days * DAY;
  const prevFrom = from - cfg.days * DAY;

  const curRows = pick(matches, puuid, from, to);
  const prevRows = pick(matches, puuid, prevFrom, from);
  const current = summarize(curRows);
  const previous = summarize(prevRows);
  const champs = champions(curRows);

  // 得意・不得意は、3戦以上したチャンピオンだけで判定する
  const enough = champs.filter((c) => c.games >= 3);
  const best = enough.length ? [...enough].sort((a, b) => b.winRate - a.winRate || b.games - a.games)[0] : null;
  const worst = enough.length > 1 ? [...enough].sort((a, b) => a.winRate - b.winRate || b.games - a.games)[0] : null;

  return {
    period: key,
    label: cfg.label,
    days: cfg.days,
    from,
    to: now,
    current,
    previous,
    delta: delta(current, previous),
    champions: champs,
    best,
    worst: worst && best && worst.championName !== best.championName ? worst : null,
    daily: daily(curRows, from, cfg.days),
    lp: lpChange(snapshots, from, to)
  };
}
