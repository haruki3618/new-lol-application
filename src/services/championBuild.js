import Match from '../models/Match.js';
import { cached } from '../utils/cache.js';
import { config } from '../config/index.js';
import { BAND_GROUPS } from '../constants/bands.js';
import { readRegion, matchIdPattern } from '../constants/regions.js';

// 1体のチャンピオンの「参加者 + 同じロールの相手」を、保存済みの試合から読み出す（API は使わない）。
// ビルド・ルーン・対面の計算は buildMath.js（DBなし）で行う。ここは読み出しだけ。
const TEN_MIN = 10 * 60 * 1000;
export const SCAN_LIMIT = 8000; // 新しい試合からここまで読む
const MIN_DURATION_SEC = 300; // リメイク・早期降参は除く

const ME_FIELDS = [
  'win', 'teamPosition', 'keystone', 'subStyle', 'primaryStyle', 'runes', 'summoner1Id', 'summoner2Id',
  'item0', 'item1', 'item2', 'item3', 'item4', 'item5',
  'kills', 'deaths', 'assists', 'totalMinionsKilled', 'neutralMinionsKilled', 'goldEarned', 'totalDamageDealtToChampions', 'visionScore'
];
const OPP_FIELDS = [
  'championName', 'kills', 'deaths', 'assists', 'totalMinionsKilled', 'neutralMinionsKilled', 'goldEarned', 'totalDamageDealtToChampions', 'visionScore'
];

export function patchFilter(patch) {
  return patch && /^\d+\.\d+$/.test(patch) ? new RegExp(`^${patch.replace('.', '\\.')}\\.`) : null;
}

// そのチャンピオンを含む試合の絞り込み条件（リージョン・モード・パッチ・帯）
export function championMatchFilter(name, { region, queueId = null, patch = null, band = 'all' } = {}) {
  const f = {
    matchId: { $regex: matchIdPattern(readRegion(region, config.defaultRegion)) },
    gameDuration: { $gte: MIN_DURATION_SEC },
    'participants.championName': name
  };
  if (queueId) f.queueId = queueId;
  const pf = patchFilter(patch);
  if (pf) f.gameVersion = pf;
  const bands = BAND_GROUPS[band]?.bands;
  if (bands) f.band = { $in: bands };
  return f;
}

// 試合のドキュメント → 「そのチャンピオンの参加者 + 同じロールの相手」の行（DB なしで単体テストできる）。
// ロールが無い試合（ARAM など）は対面なし。同じチャンピオンが両チームにいる試合（ミラー）は、自分と別チームの相手を選ぶ
export function extractRows(docs, name) {
  const rows = [];
  for (const d of docs || []) {
    const ps = d?.participants || [];
    for (const me of ps) {
      if (me?.championName !== name) continue;
      const opp = me.teamPosition
        ? ps.find((q) => q !== me && q.teamPosition === me.teamPosition && q.teamId !== me.teamId)
        : undefined;
      const row = { dur: d.gameDuration, me: pick(me, ME_FIELDS) };
      if (opp) row.opp = pick(opp, OPP_FIELDS);
      rows.push(row);
    }
  }
  return rows;
}

function pick(obj, fields) {
  const o = {};
  for (const f of fields) if (obj[f] !== undefined) o[f] = obj[f];
  return o;
}

export function loadChampionRows(name, opts = {}) {
  const region = readRegion(opts.region, config.defaultRegion);
  const key = `champrows:${region}:${opts.queueId || 'all'}:${opts.patch || 'all'}:${opts.band || 'all'}:${name}`;
  return cached(key, TEN_MIN, async () => {
    // 必要な項目だけを読む（1試合あたりの転送量を小さくする）。me / opp の取り出しは extractRows で行う
    const fields = [...new Set(['championName', 'teamId', 'teamPosition', ...ME_FIELDS, ...OPP_FIELDS])];
    const docs = await Match.aggregate([
      { $match: championMatchFilter(name, { ...opts, region }) },
      { $sort: { gameCreation: -1 } },
      { $limit: SCAN_LIMIT },
      { $project: { _id: 0, gameDuration: 1, ...Object.fromEntries(fields.map((f) => [`participants.${f}`, 1])) } }
    ]).allowDiskUse(true);
    return extractRows(docs, name);
  });
}
