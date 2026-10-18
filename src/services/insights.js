import Match from '../models/Match.js';
import { analyze } from './insightsMath.js';
import { analyzePerformance } from './perfMath.js';
import { collapseWeeks } from './weekMath.js';
import { savePlayerWeeks, loadPlayerWeeks } from './weekSummary.js';

export const INSIGHT_MAX_GAMES = 500; // 新しい順にこの件数まで（これ以上は診断が重くなるだけで精度はほぼ変わらない）

// 保存済みの試合から、そのプレイヤーの視点の最小限の項目だけを取り出す（API は使わない）
export async function loadPlayerGames(puuid, { queueId = null, limit = INSIGHT_MAX_GAMES } = {}) {
  const filter = { participantPuuids: puuid };
  if (queueId) filter.queueId = queueId;

  const docs = await Match.find(filter)
    .sort({ gameCreation: -1 })
    .limit(limit)
    // 本人の参加者データだけを取り出す（10人分を読まない）
    .select({ gameCreation: 1, gameDuration: 1, queueId: 1, participants: { $elemMatch: { puuid } } })
    .lean();

  let name = '';
  const games = [];
  for (const d of docs) {
    const me = d.participants?.[0];
    if (!me) continue;
    if (!name && me.riotIdGameName) name = `${me.riotIdGameName}#${me.riotIdTagline || ''}`;
    games.push({
      t: d.gameCreation,
      dur: d.gameDuration || 0,
      win: Boolean(me.win),
      champ: me.championName,
      role: me.teamPosition || '',
      // v6.11.0: プレイ内容の診断・週ごとのサマリー用
      q: d.queueId || 0,
      k: me.kills || 0,
      d: me.deaths || 0,
      a: me.assists || 0,
      cs: (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0),
      vis: me.visionScore || 0,
      dmg: me.totalDamageDealtToChampions || 0,
      gold: me.goldEarned || 0
    });
  }
  return { name, games };
}

// v6.11.0: 保存済みの試合（全キュー）から、週ごとのサマリーを作って保存する。
// 試合は既定 30 日で消えるので、プロフィール・診断を開いたときに残しておく。同じ人は 10 分に 1 回まで
const WEEK_REFRESH_MS = 10 * 60 * 1000;
const lastRefresh = new Map(); // puuid → 時刻
export async function refreshPlayerWeeks(puuid, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - (lastRefresh.get(puuid) || 0) < WEEK_REFRESH_MS) return 0;
  lastRefresh.set(puuid, now);
  if (lastRefresh.size > 2000) lastRefresh.delete(lastRefresh.keys().next().value);
  const { games } = await loadPlayerGames(puuid, { queueId: null });
  return savePlayerWeeks(puuid, games);
}

export async function getInsights(puuid, { queueId = null } = {}) {
  const { name, games } = await loadPlayerGames(puuid, { queueId });
  // 週のサマリーは補助の情報。保存や読み込みに失敗しても、診断そのものは返す
  const weeks = await refreshPlayerWeeks(puuid).then(() => loadPlayerWeeks(puuid)).then((w) => collapseWeeks(w, queueId).slice(0, 26)).catch(() => []);
  return { name, loaded: games.length, capped: games.length >= INSIGHT_MAX_GAMES, result: analyze(games), perf: analyzePerformance(games), weeks };
}
