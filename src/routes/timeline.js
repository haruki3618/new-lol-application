import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import { isMatchId, isPuuid } from '../utils/validate.js';
import { makeHelpers } from '../utils/ddHelpers.js';
import { getDdragon } from '../services/ddragon.js';
import { getTimelineAnalysis } from '../services/timeline.js';
import { lineChartSvg } from '../services/timelineMath.js';
import { getMatchDetail } from '../services/matchDetail.js';
import Match from '../models/Match.js';
import { escapeHtml } from '../utils/escape.js';
import { responseStatus, userMessage } from '../utils/httpError.js';

const router = safeRouter(Router());

// v6.5.1: 保存済みの試合で、そのプレイヤーが参加したものだけ受け付ける。
// 任意の matchId / puuid で呼ばれて Riot API の枠を消費されるのを防ぐ（プロフィールの試合はすべて保存済み）
const isKnownMatch = async (matchId, puuid) => Boolean(await Match.exists({ matchId, participantPuuids: puuid }));
const NOT_STORED = '<div class="sm mute">この試合は保存されていないため、読み込めません（保存期間が過ぎた可能性があります）。</div>';

// タイムライン分析（HTML の断片を返す）。利用者が試合を開いてボタンを押したときだけ、その1試合ぶんの API を使う
router.get('/api/timeline', async (req, res) => {
  const { matchId, puuid } = req.query;
  if (!isMatchId(matchId) || !isPuuid(puuid)) {
    return res.status(400).send('<div class="sm lose">不正なリクエストです。</div>');
  }
  try {
    if (!(await isKnownMatch(matchId, puuid))) return res.send(NOT_STORED);
    const t = await getTimelineAnalysis(matchId, puuid);
    if (!t) return res.send('<div class="sm mute">この試合のタイムラインを分析できませんでした。</div>');
    const chartTeam = lineChartSvg([{ cls: 'team', label: 'チームのゴールド差', points: t.series.team }]);
    const chartLane = t.series.lane ? lineChartSvg([{ cls: 'lane', label: 'レーン相手とのゴールド差', points: t.series.lane }]) : '';
    res.render('_timeline', { t, chartTeam, chartLane, h: makeHelpers(await getDdragon()) });
  } catch (err) {
    const msg = err.status === 404 ? 'この試合のタイムラインは取得できません（古い試合など）。' : userMessage(err, '取得に失敗しました。しばらくしてからもう一度お試しください。');
    res.status(err.status === 404 ? 200 : responseStatus(err)).send(`<div class="sm ${err.status === 404 ? 'mute' : 'lose'}">${escapeHtml(msg)}</div>`);
  }
});

// ルーン・スキル順・ビルド順（HTML の断片を返す）。利用者が試合を開いてボタンを押したときだけ、その1試合ぶんの API を使う
router.get('/api/detail', async (req, res) => {
  const { matchId, puuid } = req.query;
  if (!isMatchId(matchId) || !isPuuid(puuid)) {
    return res.status(400).send('<div class="sm lose">不正なリクエストです。</div>');
  }
  try {
    if (!(await isKnownMatch(matchId, puuid))) return res.send(NOT_STORED);
    const d = await getMatchDetail(matchId, puuid);
    if (!d) return res.send('<div class="sm mute">この試合の詳細を取得できませんでした。</div>');
    res.render('_detail', { d, h: makeHelpers(await getDdragon()) });
  } catch (err) {
    const msg = err.status === 404 ? 'この試合の詳細は取得できません（古い試合など）。' : userMessage(err, '取得に失敗しました。しばらくしてからもう一度お試しください。');
    res.status(err.status === 404 ? 200 : responseStatus(err)).send(`<div class="sm ${err.status === 404 ? 'mute' : 'lose'}">${escapeHtml(msg)}</div>`);
  }
});

export default router;
