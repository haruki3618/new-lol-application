import { randomUUID } from 'node:crypto';
import Match from '../models/Match.js';
import { cached } from '../utils/cache.js';
import { mapLimit } from '../utils/async.js';
import { getMatchIdsByPUUID, getMatchById } from './riotApi.js';
import { saveMatch } from './matchStore.js';
import { config } from '../config/index.js';
import { readRegion } from '../constants/regions.js';

// プロフィールを先に表示し、足りない試合は裏で取得するためのバックグラウンド処理。
// 同じプレイヤー・条件の同時リクエストは1つの処理を共有する
const MAX_RUNNING = 6;
const FRESH_MS = 60 * 1000; // 完了から1分以内なら再取得しない
const KEEP_MS = 10 * 60 * 1000;

const byKey = new Map();
const byId = new Map();

const running = () => [...byKey.values()].filter((j) => j.state === 'running').length;

export function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    phase: job.phase,
    total: job.total,
    done: job.done,
    added: job.added,
    failed: job.failed,
    error: job.error
  };
}

export function getJob(id) {
  return byId.get(id) || null;
}

function friendlyError(err) {
  if (err.status === 429) return 'アクセスが集中しています。少し待ってからもう一度お試しください。';
  if (err.status === 401 || err.status === 403) return 'APIキーが無効か、期限切れです。';
  return err.message || '取得に失敗しました。';
}

async function run(job, { queueId, count, force }) {
  try {
    job.phase = 'ids';
    const ids = await cached(
      `ids:${job.region}:${job.puuid}:${queueId || 'all'}:${count}`,
      60 * 1000,
      () => getMatchIdsByPUUID(job.puuid, { count, queue: queueId || undefined, region: job.region }),
      { force }
    );

    const have = new Set(
      (await Match.find({ matchId: { $in: ids } }).select('matchId').lean()).map((m) => m.matchId)
    );
    const missing = ids.filter((id) => !have.has(id));
    job.total = missing.length;
    job.phase = 'matches';

    await mapLimit(missing, 3, async (matchId) => {
      try {
        const raw = await getMatchById(matchId);
        if (await saveMatch(raw)) job.added += 1;
      } catch (err) {
        job.failed += 1;
        console.warn(`[Sync] ${matchId} の取得に失敗: ${err.message}`);
      } finally {
        job.done += 1;
      }
    });

    job.state = 'done';
    job.phase = 'done';
  } catch (err) {
    job.state = 'error';
    job.error = friendlyError(err);
    console.warn(`[Sync] ${job.puuid.slice(0, 8)}… の同期に失敗: ${err.message}`);
  } finally {
    job.finishedAt = Date.now();
    setTimeout(() => {
      if (byKey.get(job.key) === job) byKey.delete(job.key);
      byId.delete(job.id);
    }, KEEP_MS).unref?.();
  }
}

export function startSync(puuid, { queueId = null, count = 20, force = false, region = config.defaultRegion } = {}) {
  region = readRegion(region, config.defaultRegion);
  const key = `${region}:${puuid}:${queueId || 0}:${count}`;
  const existing = byKey.get(key);
  if (existing) {
    if (existing.state === 'running') return existing;
    if (!force && existing.state === 'done' && Date.now() - existing.finishedAt < FRESH_MS) return existing;
  }
  if (running() >= MAX_RUNNING) {
    const err = new Error('ただいま混雑しています。少し待ってからもう一度お試しください。');
    err.status = 429;
    throw err;
  }

  const job = {
    id: randomUUID(), key, puuid, region, state: 'running', phase: 'ids',
    total: 0, done: 0, added: 0, failed: 0, error: null, startedAt: Date.now(), finishedAt: null
  };
  byKey.set(key, job);
  byId.set(job.id, job);
  run(job, { queueId, count, force });
  return job;
}
