import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import { logRequestError } from '../utils/logger.js';
import { parseRiotId } from '../utils/riotId.js';
import { makeHelpers } from '../utils/ddHelpers.js';
import { QUEUE_FILTERS } from '../constants/queues.js';
import { getDdragon } from '../services/ddragon.js';
import { accountByRiotId } from '../services/names.js';
import { buildReport, PERIODS } from '../services/reportMath.js';
import { getLpHistory } from '../services/lpHistory.js';
import Match from '../models/Match.js';
import { responseStatus } from '../utils/httpError.js';

const router = safeRouter(Router());
const QUEUES = QUEUE_FILTERS.filter((q) => q.id);
const DAY = 24 * 60 * 60 * 1000;

// 週間・月間レポート。保存済みの試合と、記録済みの LP 履歴だけで作る（Riot API は使わない）
router.get('/report', async (req, res) => {
  const parsed = parseRiotId(req.query.riotId);
  if (!parsed) {
    return res.status(400).render('error', { title: null, backUrl: '/', message: 'Riot IDは「ゲーム名#タグ」の形式で指定してください。' });
  }
  const period = Object.hasOwn(PERIODS, req.query.period) ? req.query.period : 'week';
  const requested = Number(req.query.queue);
  const queueId = req.query.queue === 'all' ? null : QUEUES.some((q) => q.id === requested) ? requested : 420;
  const riotId = `${parsed.gameName}#${parsed.tagLine}`;

  try {
    const account = await accountByRiotId(parsed, false, req.region);
    const now = Date.now();
    const since = now - PERIODS[period].days * 2 * DAY; // 比較用に、直前の同じ長さの期間も読む

    const filter = { participantPuuids: account.puuid, gameCreation: { $gte: since } };
    if (queueId) filter.queueId = queueId;

    const [matches, lp, dd] = await Promise.all([
      Match.find(filter).sort({ gameCreation: -1 }).limit(1000).select('matchId gameCreation gameDuration participants').lean(),
      getLpHistory(account.puuid, 'RANKED_SOLO_5x5', 500),
      getDdragon()
    ]);

    res.render('report', {
      title: `${PERIODS[period].label}レポート`,
      active: '',
      riotId,
      period,
      queueId,
      queues: QUEUES,
      report: buildReport(matches, account.puuid, { now, period, snapshots: lp }),
      h: makeHelpers(dd)
    });
  } catch (err) {
    logRequestError('Route:report', err, req);
    const message = err.status === 404 ? 'プレイヤーが見つかりませんでした。Riot IDを確認してください。' : 'レポートを作成できませんでした。';
    res.status(responseStatus(err)).render('error', { title: null, backUrl: '/', message });
  }
});

export default router;
