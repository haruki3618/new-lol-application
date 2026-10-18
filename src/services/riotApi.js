import axios from 'axios';
import { config } from '../config/index.js';
import { sleep, backoffMs } from '../utils/async.js';
import { limiter } from './riotLimiter.js';
import { keyStatus, reloadKeyFromEnvFile } from './keyStatus.js';
import { describeEndpoint } from '../utils/logger.js';
import { readRegion, regionOfMatchId, platformHost, clusterHost, accountHost } from '../constants/regions.js';

// v6.4: リージョン対応。各関数は opts.region（'jp' / 'kr' / 'na' …）を受け取り、省略時は config.defaultRegion。
//   account-v1                               … accountHost（アカウントは全リージョン共通。sea は asia 経由）
//   match-v5                                 … clusterHost（試合IDの先頭からリージョンを判別するので、試合IDで呼ぶ関数は region 不要）
//   summoner / league / spectator / mastery / status … platformHost
const regionOf = (opts) => readRegion(opts?.region, config.defaultRegion);
const platform = (opts) => `https://${platformHost(regionOf(opts))}`;
const account = (opts) => `https://${accountHost(regionOf(opts))}`;
const cluster = (opts) => `https://${clusterHost(regionOf(opts))}`;
const clusterOfMatch = (matchId, opts) => `https://${clusterHost(regionOfMatchId(matchId) || regionOf(opts))}`;

export class RiotApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RiotApiError';
    this.status = status;
  }
}

// ---------- 共通リクエスト ----------
// レート制限は riotLimiter.js（プロセス間で共有・上限は Riot のヘッダーから自動学習）で管理する

let probeUntil = 0;
let probeResult = false;

// 403 が「キー失効」なのか「そのAPIだけ権限がない」のかを、軽い API で確かめる（60秒に1回まで）
async function keyIsRejected() {
  if (Date.now() < probeUntil) return probeResult;
  probeUntil = Date.now() + 60000;
  try {
    await limiter.acquire('high');
    await axios.get(`${platform()}/lol/status/v4/platform-data`, {
      timeout: 8000,
      headers: { 'X-Riot-Token': config.riotApiKey }
    });
    probeResult = false;
  } catch (err) {
    probeResult = [401, 403].includes(err.response?.status);
  }
  return probeResult;
}

async function fetchFromRiot(url, { params, priority = 'high', retries = 4 } = {}) {
  let lastError;
  let reloaded = false;
  const endpoint = describeEndpoint(url); // v6.8.0: エラーログに「どの API 呼び出しか」を残す（PUUID は先頭だけ）

  for (let attempt = 0; attempt < retries; attempt++) {
    await limiter.acquire(priority);

    try {
      const response = await axios.get(url, {
        params,
        timeout: 10000,
        headers: { 'X-Riot-Token': config.riotApiKey }
      });
      limiter.learn(response.headers);
      keyStatus.markValid();
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const headers = error.response?.headers;
      const message = error.response?.data?.status?.message || error.message;
      lastError = new RiotApiError(message, status || 500);
      lastError.endpoint = endpoint;
      lastError.attempts = attempt + 1;
      if (headers) limiter.learn(headers);

      if (status === 429) {
        const retryAfter = Number(headers?.['retry-after']) || 5;
        const type = headers?.['x-rate-limit-type'];
        console.warn(`[RiotAPI] 429 レート制限（${type || '種類不明'}）。${retryAfter}秒待機します | endpoint=${endpoint}`);
        const global = await limiter.penalize({ retryAfterSec: retryAfter, type });
        if (!global) await sleep(retryAfter * 1000 + 200);
        continue;
      }

      // キー失効の可能性。.env に新しいキーが書かれていれば、再起動なしで切り替えて1回だけやり直す
      if (status === 401 || status === 403) {
        if (!reloaded && reloadKeyFromEnvFile()) {
          reloaded = true;
          console.log('[RiotAPI] .env の新しい APIキーに切り替えました');
          continue;
        }
        if (status === 401 || (await keyIsRejected())) {
          if (!keyStatus.invalid) console.error('[RiotAPI] APIキーが無効か期限切れです。https://developer.riotgames.com/ で再発行し、.env を更新してください（保存すれば再起動は不要です）');
          keyStatus.markInvalid();
        }
        throw lastError;
      }

      // 5xx・ネットワークエラーは指数バックオフ（ジッター付き）で再試行
      if (!status || status >= 500) {
        await sleep(backoffMs(attempt)); // v6.7.0: ばらつき（ジッター）付き
        continue;
      }

      // 400 / 404 などは再試行しても無駄なので即座に投げる
      throw lastError;
    }
  }

  throw lastError;
}

// 起動時に APIキーを確認する（失効していたら手順をログに出す）
export async function checkApiKey() {
  try {
    await getPlatformStatus({ priority: 'high' });
    return 'valid';
  } catch (err) {
    if (keyStatus.invalid) return 'invalid';
    console.warn(`[RiotAPI] 起動時の確認に失敗しました: ${err.message}${err.endpoint ? ` | endpoint=${err.endpoint}` : ''}`);
    return 'unknown';
  }
}

export const getRateStatus = () => limiter.stats();

// ---------- エンドポイント ----------
/**
 * Riot ID（ゲーム名 + タグ）からアカウントを引く。見つからなければ status 404 の RiotApiError。
 * @param {string} gameName
 * @param {string} tagLine
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<import('../types.js').RiotAccount>}
 */
export function getAccountByRiotId(gameName, tagLine, opts) {
  const url = `${account(opts)}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  return fetchFromRiot(url, opts);
}

/**
 * @param {string} puuid
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<import('../types.js').RiotSummoner>}
 */
export function getSummonerByPUUID(puuid, opts) {
  return fetchFromRiot(`${platform(opts)}/lol/summoner/v4/summoners/by-puuid/${puuid}`, opts);
}

// summonerId ベースは廃止方向のため PUUID ベースを使用
/**
 * 1 人のランク情報（ソロ / フレックスなど。ランク戦をしていなければ空の配列）。
 * @param {string} puuid
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<import('../types.js').LeagueEntry[]>}
 */
export function getLeagueEntriesByPUUID(puuid, opts) {
  return fetchFromRiot(`${platform(opts)}/lol/league/v4/entries/by-puuid/${puuid}`, opts);
}

/**
 * 試合 ID の一覧（新しい順）。count は 1〜100 に収められる。
 * @param {string} puuid
 * @param {{count?: number, start?: number, queue?: number, priority?: 'high' | 'low', region?: string}} [options]
 * @returns {Promise<string[]>}
 */
export function getMatchIdsByPUUID(puuid, { count = 20, start = 0, queue, priority, region } = {}) {
  const params = { start, count: Math.min(Math.max(count, 1), 100) };
  if (queue) params.queue = queue;
  return fetchFromRiot(`${cluster({ region })}/lol/match/v5/matches/by-puuid/${puuid}/ids`, { params, priority });
}

/**
 * 試合 1 件。リージョンは試合 ID の先頭から判別する。
 * @param {string} matchId
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<import('../types.js').RiotMatchDto>}
 */
export function getMatchById(matchId, opts) {
  return fetchFromRiot(`${clusterOfMatch(matchId, opts)}/lol/match/v5/matches/${matchId}`, opts);
}

// 現在プレイ中の試合（ゲーム中でなければ 404）
/**
 * 現在プレイ中の試合。ゲーム中でなければ status 404 の RiotApiError。
 * @param {string} puuid
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<object>}
 */
export function getActiveGame(puuid, opts) {
  return fetchFromRiot(`${platform(opts)}/lol/spectator/v5/active-games/by-summoner/${puuid}`, opts);
}

// チャンピオンマスタリー上位
/**
 * @param {string} puuid
 * @param {number} [count]
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<import('../types.js').RiotMastery[]>}
 */
export function getTopMasteries(puuid, count = 10, opts = {}) {
  return fetchFromRiot(
    `${platform(opts)}/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top`,
    { ...opts, params: { count } }
  );
}

// 特定チャンピオンのマスタリー（持っていなければ 404）。championId は数値ID
/**
 * @param {string} puuid
 * @param {number | string} championId 数値 ID
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<import('../types.js').RiotMastery>} 持っていなければ status 404 の RiotApiError
 */
export function getMasteryByChampion(puuid, championId, opts) {
  return fetchFromRiot(
    `${platform(opts)}/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/by-champion/${Number(championId)}`,
    opts
  );
}

// 試合のタイムライン（スキル取得・アイテム購入の履歴）
/**
 * @param {string} matchId
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<object>}
 */
export function getTimelineById(matchId, opts) {
  return fetchFromRiot(`${clusterOfMatch(matchId, opts)}/lol/match/v5/matches/${matchId}/timeline`, opts);
}

// PUUID から Riot ID を引く（ランキング表示用）
/**
 * @param {string} puuid
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<import('../types.js').RiotAccount>}
 */
export function getAccountByPUUID(puuid, opts) {
  return fetchFromRiot(`${account(opts)}/riot/account/v1/accounts/by-puuid/${puuid}`, opts);
}

// チャレンジャー / グランドマスター / マスターのリーグ
/**
 * @param {'challenger' | 'grandmaster' | 'master'} tier それ以外は status 400 の RiotApiError
 * @param {import('../types.js').RiotApiOptions & {queue?: string}} [options]
 * @returns {Promise<import('../types.js').RiotLeagueList>}
 */
export function getApexLeague(tier, { queue = 'RANKED_SOLO_5x5', ...opts } = {}) {
  const path = { challenger: 'challengerleagues', grandmaster: 'grandmasterleagues', master: 'masterleagues' }[tier];
  if (!path) throw new RiotApiError('不正なティアです', 400);
  return fetchFromRiot(`${platform(opts)}/lol/league/v4/${path}/by-queue/${queue}`, opts);
}

// ---------- v5 で追加 ----------
// アイアン〜ダイヤの順位表（1ページ約205人）
/**
 * アイアン〜ダイヤの順位表（1 ページ約 205 人）。
 * @param {string} queue 例: RANKED_SOLO_5x5
 * @param {string} tier 例: DIAMOND（大文字）
 * @param {string} division I〜IV
 * @param {number} [page]
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<object[]>}
 */
export function getLeagueEntriesByTier(queue, tier, division, page = 1, opts = {}) {
  return fetchFromRiot(`${platform(opts)}/lol/league/v4/entries/${queue}/${tier}/${division}`, { ...opts, params: { page } });
}

// マスタリー全件とスコア合計
/**
 * @param {string} puuid
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<import('../types.js').RiotMastery[]>}
 */
export function getAllMasteries(puuid, opts) {
  return fetchFromRiot(`${platform(opts)}/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}`, opts);
}
/**
 * @param {string} puuid
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<number>}
 */
export function getMasteryScore(puuid, opts) {
  return fetchFromRiot(`${platform(opts)}/lol/champion-mastery/v4/scores/by-puuid/${puuid}`, opts);
}

// サーバーの状態（メンテナンス・障害）
/**
 * サーバーの状態（メンテナンス・障害）。
 * @param {import('../types.js').RiotApiOptions} [opts]
 * @returns {Promise<object>}
 */
export function getPlatformStatus(opts) {
  return fetchFromRiot(`${platform(opts)}/lol/status/v4/platform-data`, opts);
}
