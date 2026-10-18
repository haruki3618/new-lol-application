import Match from '../models/Match.js';
import { cached } from '../utils/cache.js';
import { patchOf, comparePatchDesc } from '../utils/patch.js';
import { config } from '../config/index.js';
import { BAND_GROUPS } from '../constants/bands.js';
import { readRegion, matchIdPattern } from '../constants/regions.js';

const TEN_MIN = 10 * 60 * 1000;
const kdaOf = (k, d, a) => (d === 0 ? 'Perfect' : ((k + a) / d).toFixed(2));
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

// v6.4: region（試合IDの先頭で判別）と band（クローラーの起点の帯）でも絞れる。region を渡さなければ全リージョン
export function buildFilter({ queueId = null, patch = null, region = null, band = 'all' } = {}) {
  const f = {};
  if (region) f.matchId = { $regex: matchIdPattern(region) };
  const bands = BAND_GROUPS[band]?.bands;
  if (bands) f.band = { $in: bands };
  if (queueId) f.queueId = queueId;
  if (patch && /^\d+\.\d+$/.test(patch)) f.gameVersion = new RegExp(`^${patch.replace('.', '\\.')}\\.`);
  return f;
}

// DBに保存されている試合のパッチ一覧（新しい順）
export function getPatches(region = null) {
  const rg = region ? readRegion(region, config.defaultRegion) : null;
  return cached(`patch-list:${rg || 'all'}`, TEN_MIN, async () => {
    const versions = await Match.distinct('gameVersion', rg ? { matchId: { $regex: matchIdPattern(rg) } } : {});
    return [...new Set(versions.map(patchOf).filter(Boolean))].sort(comparePatchDesc);
  });
}

// 全チャンピオンの勝率・ピック率（保存済みの試合からの集計）
export function getChampionTable(opts = {}) {
  const key = `champtable:${opts.region || 'all'}:${opts.queueId || 'all'}:${opts.patch || 'all'}:${opts.role || 'all'}`;
  return cached(key, TEN_MIN, async () => {
    const filter = buildFilter(opts);
    const [totalMatches, rows] = await Promise.all([
      Match.countDocuments(filter),
      Match.aggregate([
        { $match: filter },
        { $unwind: '$participants' },
        ...(opts.role ? [{ $match: { 'participants.teamPosition': opts.role } }] : []),
        {
          $group: {
            _id: '$participants.championName',
            games: { $sum: 1 },
            wins: { $sum: { $cond: ['$participants.win', 1, 0] } },
            kills: { $sum: '$participants.kills' },
            deaths: { $sum: '$participants.deaths' },
            assists: { $sum: '$participants.assists' }
          }
        }
      ])
    ]);

    return {
      totalMatches,
      rows: rows
        .filter((r) => r._id)
        .map((r) => ({
          championName: r._id,
          games: r.games,
          wins: r.wins,
          winRate: pct(r.wins, r.games),
          pickRate: totalMatches > 0 ? Math.round((r.games / totalMatches) * 1000) / 10 : 0,
          kda: kdaOf(r.kills, r.deaths, r.assists),
          kdaValue: (r.kills + r.assists) / Math.max(r.deaths, 1)
        }))
    };
  });
}

// 1体のチャンピオンの全体成績とロール別の割合（保存済みの試合からの集計）。
// v6.4: ルーン・スペル・アイテム・対面は championBuild.js（読み出し）と buildMath.js（計算）に移した
export function getChampionDetail(name, opts = {}) {
  const region = readRegion(opts.region, config.defaultRegion);
  const key = `champdetail:${region}:${name}:${opts.queueId || 'all'}:${opts.patch || 'all'}:${opts.band || 'all'}`;
  return cached(key, TEN_MIN, async () => {
    const filter = buildFilter({ ...opts, region });
    const winSum = { $sum: { $cond: ['$participants.win', 1, 0] } };

    const [totalMatches, [facet]] = await Promise.all([
      Match.countDocuments(filter),
      Match.aggregate([
        { $match: { ...filter, 'participants.championName': name } },
        { $unwind: '$participants' },
        { $match: { 'participants.championName': name } },
        {
          $facet: {
            total: [
              {
                $group: {
                  _id: null,
                  games: { $sum: 1 },
                  wins: winSum,
                  kills: { $sum: '$participants.kills' },
                  deaths: { $sum: '$participants.deaths' },
                  assists: { $sum: '$participants.assists' }
                }
              }
            ],
            roles: [
              { $group: { _id: '$participants.teamPosition', games: { $sum: 1 }, wins: winSum } },
              { $sort: { games: -1 } }
            ]
          }
        }
      ])
    ]);

    const t = facet?.total?.[0];
    if (!t) return null;

    const rate = (r) => ({ games: r.games, wins: r.wins, winRate: pct(r.wins, r.games) });
    return {
      name,
      totalMatches,
      games: t.games,
      wins: t.wins,
      winRate: pct(t.wins, t.games),
      pickRate: totalMatches > 0 ? Math.round((t.games / totalMatches) * 1000) / 10 : 0,
      kda: kdaOf(t.kills, t.deaths, t.assists),
      avgKills: (t.kills / t.games).toFixed(1),
      avgDeaths: (t.deaths / t.games).toFixed(1),
      avgAssists: (t.assists / t.games).toFixed(1),
      roles: facet.roles.filter((r) => r._id).map((r) => ({ role: r._id, ...rate(r), share: pct(r.games, t.games) }))
    };
  });
}
