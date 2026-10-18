import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import { isPuuid, clampInt } from '../utils/validate.js';
import { logRequestError } from '../utils/logger.js';
import { makeHelpers } from '../utils/ddHelpers.js';
import { QUEUE_FILTERS } from '../constants/queues.js';
import { ROLE_LABELS } from '../constants/roles.js';
import { getDdragon } from '../services/ddragon.js';
import { getInsights } from '../services/insights.js';
import { getTimelineSummary, TL_FETCH_MAX } from '../services/timelineSummary.js';
import Match from '../models/Match.js';
import { responseStatus, userMessage } from '../utils/httpError.js';

const router = safeRouter(Router());
const QUEUES = QUEUE_FILTERS.filter((q) => q.id);

// ?queue=all → null（全キュー）、一覧にある ID → その ID、それ以外 → ソロランク（420）
const parseQueue = (raw) => {
  if (raw === 'all') return null;
  const n = Number(raw);
  return QUEUES.some((q) => q.id === n) ? n : 420;
};

// プレイ傾向の診断（v6.0）。保存済みの試合だけで計算するので、Riot API は使わない
// v6.11.0: プレイ内容（KDA・CS・視界）、週ごとの長期の推移、タイムライン集計を追加（ここも API は使わない。取得は POST のボタンだけ）
router.get('/insights/:puuid', async (req, res) => {
  const puuid = String(req.params.puuid || '');
  if (!isPuuid(puuid)) {
    return res.status(400).render('error', { title: null, backUrl: '/', message: 'プレイヤーの指定が正しくありません。' });
  }
  const queueId = parseQueue(req.query.queue);

  try {
    const [data, tl, dd] = await Promise.all([
      getInsights(puuid, { queueId }),
      getTimelineSummary(puuid, { queueId }).catch((err) => { logRequestError('Route:insights:timeline', err, req); return null; }),
      getDdragon()
    ]);
    res.render('insights', {
      puuid, queueId, queues: QUEUES, roleLabels: ROLE_LABELS,
      name: data.name, loaded: data.loaded, capped: data.capped, r: data.result,
      perf: data.perf, weeks: data.weeks, tl,
      tlNote: { fetched: clampInt(req.query.tlf, 0, TL_FETCH_MAX, 0), failed: clampInt(req.query.tlx, 0, TL_FETCH_MAX, 0), asked: req.query.tlf !== undefined },
      h: makeHelpers(dd)
    });
  } catch (err) {
    logRequestError('Route:insights', err, req);
    res.status(responseStatus(err)).render('error', { title: null, backUrl: '/', message: userMessage(err, 'プレイ傾向を計算できませんでした。'), retryable: true });
  }
});

// タイムラインが未取得の試合を、新しい順に最大 TL_FETCH_MAX 件ぶん取得して保存する（Riot API を使う）。
// GET では実行しない（リンクを踏ませて API 枠を使わせる操作を防ぐ）。保存済みの試合の持ち主だけ受け付ける
router.post('/insights/:puuid/timeline', async (req, res) => {
  const puuid = String(req.params.puuid || '');
  if (!isPuuid(puuid)) {
    return res.status(400).render('error', { title: null, backUrl: '/', message: 'プレイヤーの指定が正しくありません。' });
  }
  if (!(await Match.exists({ participantPuuids: puuid }))) {
    return res.status(404).render('error', { title: null, backUrl: '/', message: 'このプレイヤーの試合が保存されていません。' });
  }
  const queueId = parseQueue(req.body?.queue);
  try {
    const s = await getTimelineSummary(puuid, { queueId, fetchMissing: TL_FETCH_MAX });
    res.redirect(303, `/insights/${encodeURIComponent(puuid)}?queue=${queueId === null ? 'all' : queueId}&tlf=${s.fetched}&tlx=${s.failed}#timeline`);
  } catch (err) {
    logRequestError('Route:insights:timeline-fetch', err, req);
    res.status(responseStatus(err)).render('error', { title: null, backUrl: `/insights/${encodeURIComponent(puuid)}`, message: userMessage(err, 'タイムラインを取得できませんでした。'), retryable: true });
  }
});

export default router;
