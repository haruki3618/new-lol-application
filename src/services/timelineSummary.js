import Match from '../models/Match.js';
import { readPersistent } from '../utils/persistentCache.js';
import { mapLimit } from '../utils/async.js';
import { getSlimTimeline } from './timeline.js';
import { analyzeTimeline } from './timelineMath.js';
import { aggregateTimelines } from './timelineAggMath.js';

export const TL_SUMMARY_GAMES = 20; // 直近この試合数を集計の対象にする
export const TL_FETCH_MAX = 5; // 1 回の操作で API から取得する最大の試合数（試合 1 件につき API を 1 回使う）

const rosterOf = (doc) => (doc.participants || []).map((p) => ({
  puuid: p.puuid, teamId: p.teamId, position: p.teamPosition || '', championName: p.championName,
  name: p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagline || ''}` : '', win: Boolean(p.win)
}));

// 直近の試合のタイムラインを集計する。
//  fetchMissing = 0: すでに保存（30 日キャッシュ）されているものだけ使う（API を使わない）
//  fetchMissing > 0: 足りない試合を、新しい順に最大その数だけ API から取得して保存する
export async function getTimelineSummary(puuid, { queueId = null, limit = TL_SUMMARY_GAMES, fetchMissing = 0 } = {}) {
  const filter = { participantPuuids: puuid };
  if (queueId) filter.queueId = queueId;
  const docs = (await Match.find(filter).sort({ gameCreation: -1 }).limit(limit).select({ matchId: 1, gameDuration: 1, participants: 1 }).lean())
    .filter((d) => !(d.gameDuration > 0 && d.gameDuration < 300)); // リメイクは除く

  const slims = new Map();
  await mapLimit(docs, 5, async (d) => {
    const s = await readPersistent(`tl1:${d.matchId}`);
    if (s) slims.set(d.matchId, s);
  });

  let fetched = 0;
  let failed = 0;
  const todo = docs.filter((d) => !slims.has(d.matchId)).slice(0, Math.max(0, Math.min(fetchMissing, TL_FETCH_MAX)));
  await mapLimit(todo, 2, async (d) => {
    try {
      const s = await getSlimTimeline(d.matchId);
      if (s) { slims.set(d.matchId, s); fetched += 1; } else failed += 1;
    } catch {
      failed += 1; // 古い試合（404）や混雑。残りは続ける
    }
  });

  const analyses = [];
  for (const d of docs) {
    const slim = slims.get(d.matchId);
    const a = slim ? analyzeTimeline(slim, rosterOf(d), puuid) : null;
    if (a) analyses.push(a);
  }
  return {
    requested: docs.length,
    missing: docs.filter((d) => !slims.has(d.matchId)).length,
    fetched, failed,
    ...aggregateTimelines(analyses)
  };
}
