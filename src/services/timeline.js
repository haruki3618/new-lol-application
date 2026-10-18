import Match from '../models/Match.js';
import { getTimelineById } from './riotApi.js';
import { ensureMatches } from './matchStore.js';
import { cachedPersistent } from '../utils/persistentCache.js';
import { slimTimeline, analyzeTimeline } from './timelineMath.js';

// 生のタイムラインは大きい（1試合で数百KB〜）ので、直近の数件だけ短時間メモリに置く。
// 「ビルド詳細」と「タイムライン分析」を続けて開いても、API は1回で済む
const RAW_TTL = 2 * 60 * 1000;
const RAW_MAX = 5;
const raws = new Map(); // matchId → { promise, expires }

export function fetchRawTimeline(matchId) {
  const now = Date.now();
  const hit = raws.get(matchId);
  if (hit && hit.expires > now) return hit.promise;

  const promise = getTimelineById(matchId);
  raws.set(matchId, { promise, expires: now + RAW_TTL });
  promise.catch(() => raws.delete(matchId)); // 失敗は覚えない
  while (raws.size > RAW_MAX) raws.delete(raws.keys().next().value);
  return promise;
}

const SLIM_TTL = 30 * 24 * 60 * 60 * 1000; // 軽くした形は MongoDB に30日置く（再読み込みで API を使わない）

export function getSlimTimeline(matchId) {
  return cachedPersistent(`tl1:${matchId}`, SLIM_TTL, async () => slimTimeline(await fetchRawTimeline(matchId)));
}

// 全員の puuid・チーム・ロール・チャンピオン・勝敗（保存済みの試合から。無ければ1回だけ取得して保存）
async function getRoster(matchId) {
  let doc = await Match.findOne({ matchId }).lean();
  if (!doc) doc = (await ensureMatches([matchId]))[0];
  if (!doc) return null;
  return doc.participants.map((p) => ({
    puuid: p.puuid,
    teamId: p.teamId,
    position: p.teamPosition || '',
    championName: p.championName,
    name: p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagline || ''}` : '',
    win: Boolean(p.win)
  }));
}

export async function getTimelineAnalysis(matchId, puuid) {
  const [slim, roster] = await Promise.all([getSlimTimeline(matchId), getRoster(matchId)]);
  if (!slim || !roster) return null;
  return analyzeTimeline(slim, roster, puuid);
}
