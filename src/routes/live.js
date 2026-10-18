import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import { isPuuid } from '../utils/validate.js';
import { fillRecentGames } from '../services/liveData.js';
import { isKnownPuuid } from '../services/knownPuuids.js';
import { responseStatus, userMessage } from '../utils/httpError.js';

const router = safeRouter(Router());

// ライブゲームで「データ不足」の人の直近の試合を取得する（利用者がボタンを押したときだけ）
// v6.6.1: 同期・履歴と同じく、検索またはライブ画面を通った PUUID だけ受け付ける（任意の PUUID で Riot API の枠を使われないように）
router.post('/api/live-fill', async (req, res) => {
  const puuid = String(req.query.puuid || '');
  if (!isPuuid(puuid)) return res.status(400).json({ error: '不正なリクエストです。' });
  if (!(await isKnownPuuid(puuid))) return res.status(403).json({ error: 'このプレイヤーは先に Riot ID で検索してください。' });
  try {
    const r = await fillRecentGames(puuid, 10, req.region);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(responseStatus(err)).json({ error: userMessage(err, '取得に失敗しました。') });
  }
});

export default router;
