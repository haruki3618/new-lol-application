import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import { clampInt } from '../utils/validate.js';
import { logRequestError } from '../utils/logger.js';
import { cached, staleAgeMs, STALE_1H } from '../utils/cache.js';
import { parseRiotId } from '../utils/riotId.js';
import { mapLimit } from '../utils/async.js';
import { makeHelpers } from '../utils/ddHelpers.js';
import { getDdragon } from '../services/ddragon.js';
import { namesOf, accountByRiotId } from '../services/names.js';
import { summarizeParticipant, summarizeRecent } from '../services/summarize.js';
import { ensureMatches } from '../services/matchStore.js';
import { responseStatus, userMessage } from '../utils/httpError.js';
import {
  getApexLeague, getLeagueEntriesByTier, getLeagueEntriesByPUUID, getTopMasteries, getMatchIdsByPUUID
} from '../services/riotApi.js';

const router = safeRouter(Router());
const MIN = 60 * 1000;
const PAGE_SIZE = 50;

const QUEUES = { RANKED_SOLO_5x5: 'ソロ / デュオ', RANKED_FLEX_SR: 'フレックス' };
const TIERS = {
  challenger: 'チャレンジャー', grandmaster: 'グランドマスター', master: 'マスター', diamond: 'ダイヤモンド',
  emerald: 'エメラルド', platinum: 'プラチナ', gold: 'ゴールド', silver: 'シルバー', bronze: 'ブロンズ', iron: 'アイアン'
};
const APEX = ['challenger', 'grandmaster', 'master'];
const DIVISIONS = ['I', 'II', 'III', 'IV'];

const fail = (res, err) => {
  logRequestError('Route:extra', err, res.req);
  res.status(responseStatus(err)).render('error', { title: null, backUrl: '/', message: userMessage(err), retryable: err.status === 429 || err.status >= 500 });
};

// ---------- ランキング ----------
router.get('/ranking', async (req, res) => {
  const queueKey = Object.hasOwn(QUEUES, req.query.queue) ? req.query.queue : 'RANKED_SOLO_5x5';
  const tier = Object.hasOwn(TIERS, req.query.tier) ? req.query.tier : 'challenger';
  const division = DIVISIONS.includes(req.query.division) ? req.query.division : 'I';
  const page = clampInt(req.query.page, 1, 200, 1);
  const apex = APEX.includes(tier);
  const region = req.region;

  try {
    let entries;
    let total = 0;
    let hasMore = false;
    let offset = 0;
    let staleKey; // v6.7.0: Riot API が不調で古い順位表を出したときの印

    if (apex) {
      staleKey = `apex:${region}:${queueKey}:${tier}`;
      const league = await cached(staleKey, 10 * MIN, () => getApexLeague(tier, { queue: queueKey, region }), { staleMs: STALE_1H });
      const sorted = [...(league.entries || [])].sort((a, b) => b.leaguePoints - a.leaguePoints);
      total = sorted.length;
      offset = (page - 1) * PAGE_SIZE;
      entries = sorted.slice(offset, offset + PAGE_SIZE);
      hasMore = offset + PAGE_SIZE < total;
    } else {
      // アイアン〜ダイヤは Riot 側のページ（約200人）をそのまま使い、LP の高い順に並べる
      staleKey = `tier:${region}:${queueKey}:${tier}:${division}:${page}`;
      const list = await cached(staleKey, 10 * MIN, () =>
        getLeagueEntriesByTier(queueKey, tier.toUpperCase(), division, page, { region })
      , { staleMs: STALE_1H });
      entries = [...list].sort((a, b) => b.leaguePoints - a.leaguePoints).slice(0, PAGE_SIZE);
      hasMore = list.length >= 200;
      offset = 0;
    }

    const names = await namesOf(entries.map((e) => e.puuid), region);
    const rows = entries.map((e, i) => ({
      rank: apex ? offset + i + 1 : i + 1,
      name: names[i],
      lp: e.leaguePoints,
      wins: e.wins,
      losses: e.losses,
      winRate: e.wins + e.losses > 0 ? Math.round((e.wins / (e.wins + e.losses)) * 100) : 0
    }));

    const age = staleAgeMs(staleKey);
    res.render('ranking', { queues: QUEUES, queueKey, tiers: TIERS, tier, division, apex, rows, total, page, hasMore, staleMin: age === null ? null : Math.max(1, Math.round(age / 60000)) });
  } catch (err) { fail(res, err); }
});

// ---------- マルチ検索 ----------
// ロビーのチャット（「名前#タグ がロビーに参加しました」など）をそのまま貼っても拾えるようにする
function extractIds(text) {
  const ids = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const cleaned = line.replace(/(がロビーに参加しました|joined the lobby|が参加しました)/gi, '').trim();
    const parsed = parseRiotId(cleaned);
    if (parsed) ids.push(`${parsed.gameName}#${parsed.tagLine}`);
  }
  return [...new Set(ids)].slice(0, 5);
}

router.get('/multi', async (req, res) => {
  const raw = String(req.query.ids || '').slice(0, 2000);
  const region = req.region;
  try {
    const dd = await getDdragon();
    const h = makeHelpers(dd);
    const ids = extractIds(raw);
    let players = null;

    if (raw.trim()) {
      players = await mapLimit(ids, 2, async (input) => {
        try {
          const account = await accountByRiotId(parseRiotId(input), false, region);
          const puuid = account.puuid;
          const [entries, masteries, matchIds] = await Promise.all([
            cached(`league:${region}:${puuid}`, 2 * MIN, () => getLeagueEntriesByPUUID(puuid, { region })).catch(() => []), // v6.6: 失敗をキャッシュしない
            cached(`mastery:${region}:${puuid}`, 10 * MIN, () => getTopMasteries(puuid, 5, { region })).catch(() => []),
            getMatchIdsByPUUID(puuid, { count: 10, queue: undefined, region }).catch(() => [])
          ]);
          const docs = await ensureMatches(matchIds, { concurrency: 2 });
          const matches = docs.map((d) => summarizeParticipant(d, puuid)).filter(Boolean);

          const byChamp = new Map();
          for (const m of matches) {
            const c = byChamp.get(m.championName) || { championName: m.championName, games: 0, wins: 0 };
            c.games += 1;
            if (m.win) c.wins += 1;
            byChamp.set(m.championName, c);
          }
          const champs = [...byChamp.values()]
            .sort((a, b) => b.games - a.games)
            .slice(0, 5)
            .map((c) => ({ ...c, winRate: Math.round((c.wins / c.games) * 100) }));

          return {
            name: `${account.gameName}#${account.tagLine}`,
            solo: entries.find((e) => e.queueType === 'RANKED_SOLO_5x5') || null,
            recent: summarizeRecent(matches),
            champs,
            masteries
          };
        } catch (err) {
          return { input, error: err.status === 404 ? '見つかりませんでした' : '取得に失敗しました' };
        }
      });
    }

    res.render('multi', { raw, players, h });
  } catch (err) { fail(res, err); }
});

export default router;
