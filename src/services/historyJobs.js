import { randomUUID } from 'node:crypto';
import Match from '../models/Match.js';
import { mapLimit } from '../utils/async.js';
import { getMatchIdsByPUUID, getMatchById } from './riotApi.js';
import { saveMatch } from './matchStore.js';
import { config } from '../config/index.js';
import { readRegion } from '../constants/regions.js';

// 「過去の試合をまとめて読み込む」。プロフィールの表示は止めず、裏で少しずつ取得する。
// 他の操作（検索など）を邪魔しないよう優先度は low（API 上限の70%まで）。試合1件につき API を1回使う
const MAX_RUNNING = 2;
const PAGE = 100; // match-v5 の ids は1回で最大100件
export const MAX_LIMIT = 300;
const KEEP_MS = 10 * 60 * 1000;

const byPuuid = new Map();
const byId = new Map();
const running = () => [...byPuuid.values()].filter((j) => j.state === 'running').length;

export const getHistoryJob = (id) => byId.get(id) || null;

export function publicHistoryJob(job) {
  const { id, state, phase, found, total, done, added, failed, error } = job;
  return { id, state, phase, found, total, done, added, failed, error };
}

const friendly = (err) => {
  if (err.status === 429) return 'アクセスが集中しています。少し待ってからもう一度お試しください。';
  if (err.status === 401 || err.status === 403) return 'APIキーが無効か、期限切れです。';
  return err.message || '取得に失敗しました。';
};

async function run(job, limit) {
  try {
    // 1) 試合IDを新しい順に集める
    const ids = [];
    while (ids.length < limit) {
      const want = Math.min(PAGE, limit - ids.length);
      const page = await getMatchIdsByPUUID(job.puuid, { start: ids.length, count: want, priority: 'low', region: job.region });
      ids.push(...page);
      job.found = ids.length;
      if (page.length < want) break; // これ以上古い試合はない
    }

    // 2) DB にない分だけ取得
    const have = new Set((await Match.find({ matchId: { $in: ids } }).select('matchId').lean()).map((m) => m.matchId));
    const missing = ids.filter((id) => !have.has(id));
    job.total = missing.length;
    job.phase = 'matches';

    await mapLimit(missing, 3, async (matchId) => {
      try {
        const raw = await getMatchById(matchId, { priority: 'low' });
        if (await saveMatch(raw)) job.added += 1; // band は付けない（帯不明として貯まる）
      } catch (err) {
        job.failed += 1;
        console.warn(`[History] ${matchId} の取得に失敗: ${err.message}`);
      } finally {
        job.done += 1;
      }
    });
    job.state = 'done';
    job.phase = 'done';
  } catch (err) {
    job.state = 'error';
    job.error = friendly(err);
    console.warn(`[History] ${job.puuid.slice(0, 8)}… の読み込みに失敗: ${err.message}`);
  } finally {
    job.finishedAt = Date.now();
    setTimeout(() => {
      if (byPuuid.get(job.puuid) === job) byPuuid.delete(job.puuid);
      byId.delete(job.id);
    }, KEEP_MS).unref?.();
  }
}

export function startHistory(puuid, { limit = 100, region = config.defaultRegion } = {}) {
  const n = Math.min(Math.max(Math.round(limit) || 100, 20), MAX_LIMIT);
  const existing = byPuuid.get(puuid);
  if (existing?.state === 'running') return existing;
  if (running() >= MAX_RUNNING) {
    const err = new Error('ただいま混雑しています。少し待ってからもう一度お試しください。');
    err.status = 429;
    throw err;
  }
  const job = {
    id: randomUUID(), puuid, region: readRegion(region, config.defaultRegion), state: 'running', phase: 'ids',
    found: 0, total: 0, done: 0, added: 0, failed: 0, error: null, startedAt: Date.now(), finishedAt: null
  };
  byPuuid.set(puuid, job);
  byId.set(job.id, job);
  run(job, n);
  return job;
}
