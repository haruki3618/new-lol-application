import PlayerWeek from '../models/PlayerWeek.js';
import { config } from '../config/index.js';
import { buildWeeks, shouldReplace } from './weekMath.js';

const DAY = 86400000;
const WEEK = 7 * DAY;

// 週のサマリーを保存する。すでにある週より試合数が少ない計算結果では上書きしない（weekMath.shouldReplace）
export async function savePlayerWeeks(puuid, games) {
  const weeks = buildWeeks(games);
  if (weeks.length === 0) return 0;

  const existing = await PlayerWeek.find({ puuid, weekStart: { $in: weeks.map((w) => w.weekStart) } }).select({ weekStart: 1, queueId: 1, games: 1 }).lean();
  const have = new Map(existing.map((e) => [`${e.weekStart}:${e.queueId || 0}`, e]));

  const ttlDays = config.playerWeekTtlDays;
  const ops = [];
  for (const w of weeks) {
    if (!shouldReplace(have.get(`${w.weekStart}:${w.queueId}`), w)) continue;
    const replacement = { puuid, ...w };
    if (ttlDays > 0) replacement.expireAt = new Date(w.weekStart + WEEK + ttlDays * DAY); // 週の終わりから数える
    ops.push({ replaceOne: { filter: { puuid, weekStart: w.weekStart, queueId: w.queueId }, replacement, upsert: true } });
  }
  if (ops.length === 0) return 0;
  try {
    await PlayerWeek.bulkWrite(ops, { ordered: false });
  } catch (err) {
    if (err.code !== 11000 && !(err.writeErrors || []).every((e) => e.code === 11000)) throw err; // 同時に同じ週を書いた重複だけ無視
  }
  return ops.length;
}

// 新しい週から。1 人の 1 年ぶん（約 52 週 × キュー数）を超えないよう上限を付ける
export function loadPlayerWeeks(puuid, { limit = 600 } = {}) {
  return PlayerWeek.find({ puuid }).sort({ weekStart: -1 }).limit(limit).lean();
}
