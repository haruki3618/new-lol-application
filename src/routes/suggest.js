import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import { readRegion } from '../constants/regions.js';
import { suggestPlayers } from '../services/playerNames.js';

const router = safeRouter(Router());

// 検索ボックスの予測: /api/suggest?q=ゲーム名の頭の数文字&region=jp → [{ riotId, gameName, tagLine }]
// これまでに見かけたプレイヤー（保存した試合の参加者・検索されたプレイヤー）から引く。Riot API は使わない
router.get('/api/suggest', async (req, res) => {
  const region = readRegion(req.query.region, req.region);
  try {
    const items = await suggestPlayers(String(req.query.q || ''), region, 8);
    res.set('Cache-Control', 'private, max-age=20');
    res.json({ items });
  } catch (err) {
    // 予測は補助機能なので、失敗しても検索自体は使えるよう空で返す
    console.warn(`[Suggest] ${err.message}`);
    res.json({ items: [] });
  }
});

export default router;
