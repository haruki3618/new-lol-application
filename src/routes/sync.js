import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import mongoose from 'mongoose';
import { QUEUE_FILTERS } from '../constants/queues.js';
import { startSync, getJob, publicJob } from '../services/syncJobs.js';
import { startHistory, getHistoryJob, publicHistoryJob } from '../services/historyJobs.js';
import { getRateStatus } from '../services/riotApi.js';
import { keyStatus } from '../services/keyStatus.js';
import { crawlerStatus } from '../services/crawler.js';
import { getStorageReport } from '../services/storage.js';
import { cached, cacheStats } from '../utils/cache.js';
import { responseStatus, userMessage } from '../utils/httpError.js';
import { isPuuid, clampInt } from '../utils/validate.js';
import { isKnownPuuid } from '../services/knownPuuids.js';

const router = safeRouter(Router());
const NOT_SEARCHED = 'このプレイヤーは先に Riot ID で検索してください。';

// 試合の同期を始める（結果はポーリングで受け取る）
router.post('/api/sync/start', async (req, res) => {
  const puuid = String(req.query.puuid || '');
  if (!isPuuid(puuid)) return res.status(400).json({ error: '不正なリクエストです。' });
  if (!(await isKnownPuuid(puuid))) return res.status(403).json({ error: NOT_SEARCHED });

  const queue = Number(req.query.queue);
  const queueId = QUEUE_FILTERS.some((q) => q.id === queue) ? queue : null;
  const count = clampInt(req.query.count, 10, 50, 20);

  try {
    const job = startSync(puuid, { queueId, count, force: req.query.force === '1', region: req.region });
    res.json(publicJob(job));
  } catch (err) {
    res.status(responseStatus(err)).json({ error: userMessage(err) }); // v6.7.0: Riot / MongoDB の文言を利用者に出さない
  }
});

router.get('/api/sync/status', (req, res) => {
  const job = getJob(String(req.query.job || ''));
  if (!job) return res.status(404).json({ error: '処理が見つかりません。ページを再読み込みしてください。' });
  res.json(publicJob(job));
});

// v5.2: 過去の試合をまとめて読み込む（最大300件。裏で少しずつ取得）
router.post('/api/history/start', async (req, res) => {
  const puuid = String(req.query.puuid || '');
  if (!isPuuid(puuid)) return res.status(400).json({ error: '不正なリクエストです。' });
  if (!(await isKnownPuuid(puuid))) return res.status(403).json({ error: NOT_SEARCHED });
  try {
    res.json(publicHistoryJob(startHistory(puuid, { limit: parseInt(req.query.limit, 10), region: req.region })));
  } catch (err) {
    res.status(responseStatus(err)).json({ error: userMessage(err) }); // v6.7.0: Riot / MongoDB の文言を利用者に出さない
  }
});

router.get('/api/history/status', (req, res) => {
  const job = getHistoryJob(String(req.query.job || ''));
  if (!job) return res.status(404).json({ error: '処理が見つかりません。ページを再読み込みしてください。' });
  res.json(publicHistoryJob(job));
});

// 監視用（機密情報は含まない）
router.get('/healthz', async (req, res) => {
  const dbOk = mongoose.connection.readyState === 1;
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    db: dbOk ? 'connected' : 'disconnected',
    apiKey: keyStatus.state,
    rate: await getRateStatus().catch(() => null),
    crawler: crawlerStatus,
    cache: cacheStats(), // v6.7.0: ヒット率・古い値を返した回数（再起動で 0 に戻る）
    storage: dbOk ? await cached('storage-report', 60000, getStorageReport).catch(() => null) : null,
    uptimeSec: Math.round(process.uptime())
  });
});

export default router;
