import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import { clampInt } from '../utils/validate.js';
import { logRequestError } from '../utils/logger.js';
import { parseRiotId } from '../utils/riotId.js';
import { cached, staleAgeMs, STALE_1H } from '../utils/cache.js';
import { mapLimit } from '../utils/async.js';
import { makeHelpers } from '../utils/ddHelpers.js';
import { QUEUE_FILTERS, QUEUE_NAMES } from '../constants/queues.js';
import { ROLE_LABELS } from '../constants/roles.js';
import {
  getSummonerByPUUID,
  getLeagueEntriesByPUUID,
  getTopMasteries,
  getActiveGame
} from '../services/riotApi.js';
import { accountByRiotId } from '../services/names.js';
import { summarizeParticipant, summarizeRecent } from '../services/summarize.js';
import { getPlayerStats } from '../services/analytics.js';
import { getDdragon } from '../services/ddragon.js';
import { analyzeComp } from '../services/teamComp.js';
import { recordLp, getLpHistory } from '../services/lpHistory.js';
import { timeAgo } from '../utils/timeAgo.js';
import extraRouter from './extra.js';
import liveRouter from './live.js';
import timelineRouter from './timeline.js';
import syncRouter from './sync.js';
import championsRouter from './champions.js';
import duoRouter from './duo.js';
import watchRouter from './watch.js';
import reportRouter from './report.js';
import suggestRouter from './suggest.js';
import infoRouter, { getStatus } from './info.js';
import Match from '../models/Match.js';
import { getBaselineFn } from '../services/aggregate.js';
import { loadRecentGamesMap, getChampionMastery } from '../services/liveData.js';
import { summarizePlayer, forecast } from '../services/liveMath.js';
import { rememberPuuid } from '../services/knownPuuids.js';
import { refreshPlayerWeeks } from '../services/insights.js';
import { responseStatus, userMessage } from '../utils/httpError.js';

const router = safeRouter(Router());
router.use(syncRouter);
router.use(extraRouter);
router.use(liveRouter);
router.use(timelineRouter);
router.use(championsRouter);
router.use(duoRouter);
router.use(watchRouter);
router.use(reportRouter);
router.use(suggestRouter);
router.use(infoRouter);

const MIN = 60 * 1000;
const h0 = (dd, key) => (key ? dd.champKeyToId?.[String(key)] || null : null);
const INVALID_ID = 'Riot IDは「ゲーム名#タグ」の形式で入力してください。';

// v6.6.1: 利用者に見せる文と HTTP ステータスは utils/httpError.js に集約（想定外のエラーの内部文言を画面に出さない）
const errorMessage = (err) => userMessage(err, '予期せぬエラーが発生しました。しばらくしてからもう一度お試しください。');

const getAccount = (parsed, force = false, region) => accountByRiotId(parsed, force, region);

// v6.6: 取得に失敗したときは投げる（cached は失敗を保存しない）。呼び出し側が「失敗」と「本当に未ランク」を区別して画面を出す。
// ランクはリージョンごとのサーバーにある
const getLeague = (puuid, force = false, region) =>
  cached(`league:${region}:${puuid}`, 2 * MIN, () => getLeagueEntriesByPUUID(puuid, { region }), { force });

// 失敗しても画面は出す。{ entries, failed } で返す
const getLeagueSafe = (puuid, force, region) =>
  getLeague(puuid, force, region).then(
    (entries) => ({ entries, failed: false }),
    (err) => {
      console.warn(`[League] ランクの取得に失敗: ${err.status || ''} ${err.message}`);
      return { entries: [], failed: true };
    }
  );

// ホーム: サーバー状況・保存件数（どれが失敗しても画面は出す）
async function renderHome(res, error, region, riotId = '') {
  const [status, matchCount] = await Promise.all([
    getStatus(region).catch(() => null),
    Match.estimatedDocumentCount().catch(() => 0) // ホームの表示用なので概算でよい
  ]);
  res.render('index', {
    error,
    riotId: String(riotId || '').slice(0, 100), // v6.6: 間違えたときも入力を残す
    matchCount,
    statusInfo: status ? { issues: (status.maintenances || []).length + (status.incidents || []).length } : null
  });
}

router.get('/', (req, res, next) => renderHome(res, null, req.region).catch(next)); // v6.6.1: Express 4 は async の例外を拾わないので、next へ渡す
router.get('/about', (req, res) => res.render('about'));

// フォーム送信は GET に変換してリダイレクト（URLを共有・再読み込みできるようにする）
router.post('/search', (req, res, next) => {
  const input = String(req.body?.riotId ?? ''); // v6.6.1: riotId[]=… のように配列で来ても .trim() で落ちない
  if (!parseRiotId(input)) {
    return renderHome(res, INVALID_ID, req.region, input).catch(next);
  }
  // 選んだリージョンを URL に入れる（既定のリージョンのときは省略）。共有したリンクが誰の画面でも同じプレイヤーになる
  res.redirect(`/summoner?riotId=${encodeURIComponent(input.trim())}${res.locals.rqs}`);
});

router.get('/summoner', async (req, res) => {
  const parsed = parseRiotId(req.query.riotId);
  const region = req.region;
  if (!parsed) return renderHome(res, INVALID_ID, region, req.query.riotId);

  const requestedQueue = Number(req.query.queue);
  const queueId = QUEUE_FILTERS.some((q) => q.id === requestedQueue) ? requestedQueue : null;
  const count = clampInt(req.query.count, 10, 50, 20);
  const force = req.query.refresh === '1';

  try {
    const riotId = `${parsed.gameName}#${parsed.tagLine}`;
    const account = await getAccount(parsed, force, region);
    const puuid = account.puuid;

    const [summoner, league, dd, masteries] = await Promise.all([
      cached(`summoner:${region}:${puuid}`, 2 * MIN, () => getSummonerByPUUID(puuid, { region }), { force, staleMs: STALE_1H }), // v6.7.0: 一時的な失敗は古い値で凌ぐ（アイコン・レベルは数分〜1時間ずれても害がない）
      getLeagueSafe(puuid, force, region),
      getDdragon(),
      // v6.6: 失敗は空配列にして画面は出すが、失敗をキャッシュしない（catch は cached の外）
      cached(`mastery:${region}:${puuid}`, 10 * MIN, () => getTopMasteries(puuid, 10, { region }), { force, staleMs: STALE_1H }).catch(() => [])
    ]);
    // v6.9.0: Riot API が不調で、サモナー情報かマスタリーを古い値で出したときは、画面に注意書きを出す（最も古いほうの経過分）
    const ages = [`summoner:${region}:${puuid}`, `mastery:${region}:${puuid}`].map(staleAgeMs).filter((a) => a !== null);
    const staleMin = ages.length ? Math.max(1, Math.round(Math.max(...ages) / 60000)) : null;
    const leagueEntries = league.entries;
    const leagueFailed = league.failed;

    // 取得に失敗したときは「未ランク」として LP を記録しない
    if (!leagueFailed) await recordLp(puuid, leagueEntries).catch((e) => console.warn(`[LP] 記録失敗: ${e.message}`));
    const lpHistory = await getLpHistory(puuid);

    const soloEntry = leagueEntries.find((e) => e.queueType === 'RANKED_SOLO_5x5') || null;
    const flexEntry = leagueEntries.find((e) => e.queueType === 'RANKED_FLEX_SR') || null;

    // まず DB にある試合だけで画面を出す。足りない試合はページ表示後に裏で取得して差し込む
    const filter = { participantPuuids: puuid };
    if (queueId) filter.queueId = queueId;
    const docs = await Match.find(filter).sort({ gameCreation: -1 }).limit(count).lean();
    const baseline = await getBaselineFn(); // v5.2: ロール×チャンピオンの基準でスコアを付ける（集計が未作成なら null → 従来の採点）
    const matches = docs
      .map((doc) => summarizeParticipant(doc, puuid, { baseline }))
      .filter(Boolean)
      .sort((a, b) => b.gameCreation - a.gameCreation);

    // 各チームの構成分析
    for (const m of matches) {
      for (const t of m.teams) t.comp = analyzeComp(t.players.map((p) => p.championName), dd);
    }

    const stats = await getPlayerStats(puuid, { queueId });
    // v6.11.0: 試合が期限で消える前に、週ごとの合計を残しておく（裏で実行。10 分に 1 回まで。失敗しても画面には影響しない）
    refreshPlayerWeeks(puuid).catch((e) => console.warn(`[Weeks] 週サマリーの保存に失敗: ${e.message}`));
    const bannerChamp = stats.champions[0]?.championName || h0(dd, masteries[0]?.championId);

    res.render('profile', {
      account,
      riotId,
      summoner,
      soloEntry,
      flexEntry,
      leagueFailed,
      staleMin,
      matches,
      recent: summarizeRecent(matches),
      stats,
      masteries,
      lpHistory,
      bannerChamp,
      h: makeHelpers(dd),
      timeAgo,
      roleLabels: ROLE_LABELS,
      queueFilters: QUEUE_FILTERS,
      selectedQueue: queueId,
      count,
      updatedAt: Date.now(),
      // nosync=1 は「差し込み後の再描画」用。通常表示のときだけブラウザが同期を始める
      sync: req.query.nosync === '1' ? null : { puuid, region, queue: queueId || '', count, force: force ? '1' : '0' }
    });
  } catch (err) {
    logRequestError('Route:profile', err, req);
    res.status(responseStatus(err)).render('error', { title: null, backUrl: '/', message: errorMessage(err), retryable: err.status === 429 || err.status >= 500 });
  }
});

// 現在プレイ中の試合（ライブゲーム）
router.get('/live', async (req, res) => {
  const parsed = parseRiotId(req.query.riotId);
  const region = req.region;
  if (!parsed) return renderHome(res, INVALID_ID, region, req.query.riotId);

  const riotId = `${parsed.gameName}#${parsed.tagLine}`;
  const backUrl = `/summoner?riotId=${encodeURIComponent(riotId)}${res.locals.rqs}`;

  try {
    const account = await getAccount(parsed, false, region);

    let game;
    try {
      game = await getActiveGame(account.puuid, { region });
    } catch (err) {
      if (err.status === 404) {
        // v6.6: 「ゲーム中ではない」は異常ではないので 200 で返す（監視やログでエラー扱いにならない）
        return res.render('error', {
          title: 'ゲーム中ではありません',
          backUrl,
          message: `${riotId} は現在ゲーム中ではありません。`
        });
      }
      throw err;
    }

    const dd = await getDdragon();
    const h = makeHelpers(dd);

    const queueId = game.gameQueueConfigId || null;
    const participants = game.participants || [];
    // v6.6.1: 検索したプレイヤーの試合の参加者なので、「データ不足を取得」（/api/live-fill）の対象として覚える
    for (const p of participants) rememberPuuid(p.puuid);

    // v6.1: 保存済みの試合は DB から先にまとめて読む（API は使わない）
    const gamesMap = await loadRecentGamesMap(participants.map((p) => p.puuid).filter(Boolean));

    // 全員のランクとマスタリーを取得（同時実行数は小さく。ランクは2分、マスタリーは10分キャッシュ）
    const players = await mapLimit(participants, 4, async (p) => {
      const championId = h.champIdByKey(p.championId);
      let solo = null;
      let mastery = null;
      let rankFailed = false; // v6.6: 取得失敗を「未ランク」と見せない
      if (p.puuid) {
        const [lg, m] = await Promise.all([getLeagueSafe(p.puuid, false, region), getChampionMastery(p.puuid, p.championId, region)]);
        solo = lg.entries.find((e) => e.queueType === 'RANKED_SOLO_5x5') || null;
        rankFailed = lg.failed;
        mastery = m;
      }
      return {
        teamId: p.teamId,
        puuid: p.puuid,
        name: p.riotId || p.summonerName || '非公開',
        isMe: p.puuid === account.puuid,
        championId,
        spell1: p.spell1Id,
        spell2: p.spell2Id,
        keystone: p.perks?.perkIds?.[0],
        subStyle: p.perks?.perkSubStyle,
        solo,
        rankFailed,
        mastery,
        summary: p.puuid ? summarizePlayer(gamesMap.get(p.puuid) || [], championId, queueId) : null
      };
    });

    const teamIds = [...new Set(players.map((p) => p.teamId))].sort((a, b) => a - b);
    const teams = teamIds.map((teamId) => {
      const members = players.filter((p) => p.teamId === teamId);
      return {
        teamId,
        players: members,
        comp: analyzeComp(members.map((p) => p.championId).filter(Boolean), dd)
      };
    });
    const prediction = forecast(teams);
    const lacking = players.filter((p) => p.puuid && !p.summary?.enough);

    res.render('live', {
      riotId,
      backUrl,
      queueName: QUEUE_NAMES[game.gameQueueConfigId] || game.gameMode || 'ゲーム中',
      gameLength: Math.max(0, game.gameLength || 0),
      teams,
      prediction,
      lacking: lacking.map((p) => p.puuid),
      h
    });
  } catch (err) {
    logRequestError('Route:live', err, req);
    res.status(responseStatus(err)).render('error', { title: null, backUrl: '/', message: errorMessage(err), retryable: err.status === 429 || err.status >= 500 });
  }
});

export default router;
