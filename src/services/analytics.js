import Match from '../models/Match.js';
import { patchOf, comparePatchDesc } from '../utils/patch.js';

const kdaOf = (k, d, a) => (d === 0 ? 'Perfect' : ((k + a) / d).toFixed(2));
const blank = () => ({ games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 });

function add(entry, me) {
  entry.games += 1;
  entry.kills += me.kills || 0;
  entry.deaths += me.deaths || 0;
  entry.assists += me.assists || 0;
  if (me.win) entry.wins += 1;
}

// DBに依存しない集計本体（テストしやすいよう分離）
export function computeStats(matches, puuid) {
  const champMap = new Map();
  const roleMap = new Map();
  const mateMap = new Map();
  const patchMap = new Map();
  let totalGames = 0;
  let totalWins = 0;

  for (const match of matches) {
    const me = match.participants.find((p) => p.puuid === puuid);
    if (!me) continue;

    totalGames += 1;
    if (me.win) totalWins += 1;

    // チャンピオン別
    const name = me.championName || 'Unknown';
    if (!champMap.has(name)) champMap.set(name, blank());
    add(champMap.get(name), me);

    // ロール別（ARAM などロールが無い試合は除外）
    if (me.teamPosition) {
      if (!roleMap.has(me.teamPosition)) roleMap.set(me.teamPosition, blank());
      add(roleMap.get(me.teamPosition), me);
    }

    // パッチ別
    const patch = patchOf(match.gameVersion);
    if (patch) {
      if (!patchMap.has(patch)) patchMap.set(patch, { ...blank(), champs: new Map() });
      const pt = patchMap.get(patch);
      add(pt, me);
      pt.champs.set(name, (pt.champs.get(name) || 0) + 1);
    }

    // 一緒にプレイした人（同じチーム）
    for (const p of match.participants) {
      if (p.puuid === puuid || p.teamId !== me.teamId || !p.puuid) continue;
      if (!mateMap.has(p.puuid)) {
        mateMap.set(p.puuid, { name: p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagline || ''}` : '', games: 0, wins: 0 });
      }
      const t = mateMap.get(p.puuid);
      t.games += 1;
      if (me.win) t.wins += 1;
    }
  }

  const champions = [...champMap.entries()]
    .map(([championName, d]) => ({
      championName,
      games: d.games,
      wins: d.wins,
      losses: d.games - d.wins,
      winRate: Math.round((d.wins / d.games) * 100),
      avgKills: (d.kills / d.games).toFixed(1),
      avgDeaths: (d.deaths / d.games).toFixed(1),
      avgAssists: (d.assists / d.games).toFixed(1),
      kda: kdaOf(d.kills, d.deaths, d.assists)
    }))
    .sort((a, b) => b.games - a.games);

  const roles = [...roleMap.entries()]
    .map(([role, d]) => ({
      role,
      games: d.games,
      wins: d.wins,
      losses: d.games - d.wins,
      winRate: Math.round((d.wins / d.games) * 100),
      kda: kdaOf(d.kills, d.deaths, d.assists)
    }))
    .sort((a, b) => b.games - a.games);

  const patches = [...patchMap.entries()]
    .map(([patch, d]) => ({
      patch,
      games: d.games,
      wins: d.wins,
      losses: d.games - d.wins,
      winRate: Math.round((d.wins / d.games) * 100),
      kda: kdaOf(d.kills, d.deaths, d.assists),
      topChamps: [...d.champs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n)
    }))
    .sort((a, b) => comparePatchDesc(a.patch, b.patch));

  // 2試合以上一緒にプレイした人だけ、多い順に10人
  const teammates = [...mateMap.entries()]
    .filter(([, t]) => t.games >= 2 && t.name)
    .map(([mateId, t]) => ({
      puuid: mateId,
      name: t.name,
      games: t.games,
      wins: t.wins,
      losses: t.games - t.wins,
      winRate: Math.round((t.wins / t.games) * 100)
    }))
    .sort((a, b) => b.games - a.games)
    .slice(0, 10);

  return {
    champions,
    roles,
    patches,
    teammates,
    totalGames,
    totalWins,
    totalWinRate: totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0
  };
}

// queueId を指定するとそのモードだけで集計する（null なら全モード）
export async function getPlayerStats(puuid, { queueId = null, limit = 300 } = {}) {
  const filter = { participantPuuids: puuid };
  if (queueId) filter.queueId = queueId;

  const matches = await Match.find(filter)
    .sort({ gameCreation: -1 })
    .limit(limit)
    .select('participants gameVersion')
    .lean();

  return computeStats(matches, puuid);
}
