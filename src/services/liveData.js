import Match from '../models/Match.js';
import { cached } from '../utils/cache.js';
import { mapLimit } from '../utils/async.js';
import { getMasteryByChampion, getMatchIdsByPUUID } from './riotApi.js';
import { ensureMatches } from './matchStore.js';
import { config } from '../config/index.js';
import { readRegion } from '../constants/regions.js';

const MIN = 60 * 1000;
export const LIVE_GAME_LIMIT = 60; // 1人あたり、新しい順にここまで読む

// 保存済みの試合から、そのプレイヤーの視点の最小限の項目だけを取り出す（API は使わない）
export async function loadRecentGames(puuid, limit = LIVE_GAME_LIMIT) {
  const docs = await Match.find({ participantPuuids: puuid })
    .sort({ gameCreation: -1 })
    .limit(limit)
    .select({ gameCreation: 1, gameDuration: 1, queueId: 1, participants: { $elemMatch: { puuid } } })
    .lean();

  const games = [];
  for (const d of docs) {
    const me = d.participants?.[0];
    if (!me) continue;
    games.push({
      t: d.gameCreation,
      dur: d.gameDuration || 0,
      queueId: d.queueId,
      win: Boolean(me.win),
      champ: me.championName,
      role: me.teamPosition || '',
      k: me.kills || 0,
      d: me.deaths || 0,
      a: me.assists || 0
    });
  }
  return games;
}

export async function loadRecentGamesMap(puuids) {
  const map = new Map();
  await mapLimit(puuids, 5, async (puuid) => {
    map.set(puuid, await loadRecentGames(puuid).catch(() => []));
  });
  return map;
}

// そのチャンピオンのマスタリー。持っていない（404）なら Lv0、取得できなかったときは null（画面で「取得できませんでした」）
export function getChampionMastery(puuid, championKey, region = config.defaultRegion) {
  if (!puuid || !championKey) return Promise.resolve(null);
  const rg = readRegion(region, config.defaultRegion);
  // v6.6: 取得に失敗したときはキャッシュしない（loader が投げれば cached は保存しない）。失敗は null で返す
  return cached(`mastery-ch:${rg}:${puuid}:${championKey}`, 10 * MIN, async () => {
    try {
      const m = await getMasteryByChampion(puuid, championKey, { region: rg });
      return { level: m.championLevel || 0, points: m.championPoints || 0, lastPlay: m.lastPlayTime || null };
    } catch (err) {
      if (err.status === 404) return { level: 0, points: 0, lastPlay: null };
      throw err;
    }
  }).catch(() => null);
}

// 直近の試合が足りない人の分だけ、利用者の操作で取得する（1人あたり最大 1 + count 回の API）
export function fillRecentGames(puuid, count = 10, region = config.defaultRegion) {
  const rg = readRegion(region, config.defaultRegion);
  return cached(`livefill:${rg}:${puuid}`, 5 * MIN, async () => {
    const ids = await getMatchIdsByPUUID(puuid, { count, region: rg });
    const docs = await ensureMatches(ids, { concurrency: 3 });
    return { requested: ids.length, saved: docs.length };
  });
}
