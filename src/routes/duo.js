import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import { logRequestError } from '../utils/logger.js';
import { parseRiotId } from '../utils/riotId.js';
import { makeHelpers } from '../utils/ddHelpers.js';
import { getDdragon } from '../services/ddragon.js';
import { accountByRiotId } from '../services/names.js';
import { analyzeDuo } from '../services/duoMath.js';
import { ROLE_LABELS } from '../constants/roles.js';
import Match from '../models/Match.js';
import { responseStatus } from '../utils/httpError.js';

const router = safeRouter(Router());

// 2人が両方参加している試合を DB から探す（API は使わない。保存済みの試合だけが対象）
router.get('/duo', async (req, res) => {
  const rawA = String(req.query.a || '').slice(0, 60);
  const rawB = String(req.query.b || '').slice(0, 60);
  const base = { title: 'デュオ比較', active: 'duo', rawA, rawB, roleLabels: ROLE_LABELS, result: null, error: null, names: null };

  try {
    const dd = await getDdragon();
    const h = makeHelpers(dd);

    if (!rawA && !rawB) return res.render('compare', { ...base, h });

    const a = parseRiotId(rawA);
    const b = parseRiotId(rawB);
    if (!a || !b) return res.render('compare', { ...base, h, error: 'Riot IDは「ゲーム名#タグ」の形式で2人分入力してください。' });

    const [accA, accB] = await Promise.all([accountByRiotId(a, false, req.region), accountByRiotId(b, false, req.region)]);
    if (accA.puuid === accB.puuid) return res.render('compare', { ...base, h, error: '同じプレイヤーは比較できません。' });

    const matches = await Match.find({ participantPuuids: { $all: [accA.puuid, accB.puuid] } })
      .sort({ gameCreation: -1 })
      .limit(300)
      .select('matchId gameCreation participants')
      .lean();

    res.render('compare', {
      ...base,
      h,
      names: { a: `${accA.gameName}#${accA.tagLine}`, b: `${accB.gameName}#${accB.tagLine}` },
      result: analyzeDuo(matches, accA.puuid, accB.puuid)
    });
  } catch (err) {
    logRequestError('Route:duo', err, req);
    const message = err.status === 404 ? 'プレイヤーが見つかりませんでした。Riot IDを確認してください。' : '比較を取得できませんでした。';
    res.status(responseStatus(err)).render('error', { title: null, backUrl: '/duo', message });
  }
});

export default router;
