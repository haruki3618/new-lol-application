import { QUEUE_NAMES } from '../constants/queues.js';

const cap = (n) => Math.min(n, 3); // 極端な外れ値で点数が振り切れないようにする
const ratio = (value, mean) => (mean > 0 ? cap(value / mean) : 1);
const kdaOf = (k, d, a) => (d === 0 ? 'Perfect' : ((k + a) / d).toFixed(2));

// 試合の全参加者を 0〜10 点にする（OP.GG本家の計算式とは別物）
//  - 基準なし（既定）: その試合内の相対評価。重み KDA 35% / ダメージ 30% / キル関与 15% / ゴールド 10% / 視界 10%
//  - v5.2 基準あり: 「ロール × チャンピオン」の平均（DB に貯めた試合）との比較。
//    重み KDA 30% / ダメージ 25% / キル関与 15% / ゴールド 10% / 視界 10% / CS 10%（ダメージ・ゴールド・視界・CS は1分あたり）
//    基準になる試合数が足りない参加者は、その人だけ従来の試合内の相対評価に戻る。
//    baseline: (championName, teamPosition) → { kda, dpm, gpm, cpm, vpm } | null
export function scoreParticipants(participants, { baseline = null, durationMin = 0 } = {}) {
  const teamKills = {};
  for (const p of participants) teamKills[p.teamId] = (teamKills[p.teamId] || 0) + (p.kills || 0);

  const rows = participants.map((p) => {
    const k = p.kills || 0;
    const d = p.deaths || 0;
    const a = p.assists || 0;
    return {
      kda: (k + a) / Math.max(d, 1),
      dmg: p.totalDamageDealtToChampions || 0,
      kp: teamKills[p.teamId] > 0 ? (k + a) / teamKills[p.teamId] : 0,
      gold: p.goldEarned || 0,
      vision: p.visionScore || 0,
      cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0)
    };
  });

  const mean = (key) => rows.reduce((s, r) => s + r[key], 0) / (rows.length || 1);
  const m = { kda: mean('kda'), dmg: mean('dmg'), kp: mean('kp'), gold: mean('gold'), vision: mean('vision') };
  const useBaseline = typeof baseline === 'function' && durationMin > 0;

  const scores = rows.map((r, i) => {
    const b = useBaseline ? baseline(participants[i].championName, participants[i].teamPosition) : null;
    const composite = b
      ? 0.3 * ratio(r.kda, b.kda) +
        0.25 * ratio(r.dmg / durationMin, b.dpm) +
        0.15 * ratio(r.kp, m.kp) +
        0.1 * ratio(r.gold / durationMin, b.gpm) +
        0.1 * ratio(r.vision / durationMin, b.vpm) +
        0.1 * ratio(r.cs / durationMin, b.cpm)
      : 0.35 * ratio(r.kda, m.kda) +
        0.3 * ratio(r.dmg, m.dmg) +
        0.15 * ratio(r.kp, m.kp) +
        0.1 * ratio(r.gold, m.gold) +
        0.1 * ratio(r.vision, m.vision);
    const bonus = participants[i].win ? 0.3 : 0;
    return Math.round(Math.min(10, Math.max(0, composite * 5 + bonus)) * 10) / 10;
  });

  // 順位と MVP（勝利側トップ）/ ACE（敗北側トップ）
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const ranks = new Array(scores.length);
  order.forEach((idx, pos) => (ranks[idx] = pos + 1));

  const labels = new Array(scores.length).fill(null);
  const bestWin = order.find((i) => participants[i].win);
  const bestLose = order.find((i) => !participants[i].win);
  if (bestWin !== undefined) labels[bestWin] = 'MVP';
  if (bestLose !== undefined) labels[bestLose] = 'ACE';

  return scores.map((score, i) => ({ score, rank: ranks[i], label: labels[i] }));
}

function buildPlayer(p, scored, maxDmg, myPuuid) {
  const kills = p.kills || 0;
  const deaths = p.deaths || 0;
  const assists = p.assists || 0;
  const gameName = p.riotIdGameName || '';
  const name = gameName ? `${gameName}#${p.riotIdTagline || ''}` : '';

  return {
    puuid: p.puuid,
    name,
    isMe: p.puuid === myPuuid,
    teamId: p.teamId,
    win: Boolean(p.win),
    position: p.teamPosition || '',
    championName: p.championName,
    champLevel: p.champLevel,
    kills,
    deaths,
    assists,
    kda: kdaOf(kills, deaths, assists),
    cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
    damage: p.totalDamageDealtToChampions || 0,
    damagePct: Math.round(((p.totalDamageDealtToChampions || 0) / maxDmg) * 100),
    gold: p.goldEarned || 0,
    visionScore: p.visionScore || 0,
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
    spell1: p.summoner1Id,
    spell2: p.summoner2Id,
    keystone: p.keystone,
    subStyle: p.subStyle,
    score: scored.score,
    rank: scored.rank,
    label: scored.label
  };
}

// opts.baseline を渡すと、ロール × チャンピオンの基準でスコアを付ける（省略すると従来どおり）
export function summarizeParticipant(matchDoc, puuid, opts = {}) {
  const participants = matchDoc.participants || [];
  const meIndex = participants.findIndex((p) => p.puuid === puuid);
  if (meIndex < 0) return null;

  const scored = scoreParticipants(participants, {
    baseline: opts.baseline || null,
    durationMin: (matchDoc.gameDuration || 0) / 60
  });
  const maxDmg = Math.max(1, ...participants.map((p) => p.totalDamageDealtToChampions || 0));
  const players = participants.map((p, i) => buildPlayer(p, scored[i], maxDmg, puuid));

  const teamIds = [...new Set(players.map((p) => p.teamId))].sort((a, b) => a - b);
  const teams = teamIds.map((teamId) => {
    const members = players.filter((p) => p.teamId === teamId);
    const sum = (key) => members.reduce((s, p) => s + p[key], 0);
    return {
      teamId,
      win: members[0].win,
      kills: sum('kills'),
      deaths: sum('deaths'),
      assists: sum('assists'),
      gold: sum('gold'),
      players: members
    };
  });

  const me = players[meIndex];
  const myTeam = teams.find((t) => t.teamId === me.teamId);

  return {
    matchId: matchDoc.matchId,
    gameCreation: matchDoc.gameCreation,
    gameDuration: matchDoc.gameDuration || 0,
    queueName: QUEUE_NAMES[matchDoc.queueId] || `Queue ${matchDoc.queueId}`,
    win: me.win,
    championName: me.championName,
    champLevel: me.champLevel,
    kills: me.kills,
    deaths: me.deaths,
    assists: me.assists,
    kda: me.kda,
    killParticipation: myTeam.kills > 0 ? Math.round(((me.kills + me.assists) / myTeam.kills) * 100) : 0,
    cs: me.cs,
    visionScore: me.visionScore,
    items: me.items,
    position: me.position,
    spell1: me.spell1,
    spell2: me.spell2,
    keystone: me.keystone,
    subStyle: me.subStyle,
    score: me.score,
    rank: me.rank,
    label: me.label,
    teams
  };
}

// 表示中の試合一覧の要約（勝敗・平均KDA）
/**
 * 表示中の試合一覧の要約（勝敗・平均 KDA）。数値の平均は表示用の文字列。
 * @param {{win?: boolean, kills?: number, deaths?: number, assists?: number, score?: number}[]} matches
 * @returns {{games: number, wins: number, losses: number, winRate: number, avgKills: string, avgDeaths: string, avgAssists: string, kda: string, avgScore: string}}
 */
export function summarizeRecent(matches) {
  const games = matches.length;
  if (games === 0) {
    return { games: 0, wins: 0, losses: 0, winRate: 0, avgKills: '0.0', avgDeaths: '0.0', avgAssists: '0.0', kda: '0.00', avgScore: '0.0' };
  }

  const wins = matches.filter((m) => m.win).length;
  const sum = (key) => matches.reduce((s, m) => s + (m[key] || 0), 0);
  const k = sum('kills');
  const d = sum('deaths');
  const a = sum('assists');

  return {
    games,
    wins,
    losses: games - wins,
    winRate: Math.round((wins / games) * 100),
    avgKills: (k / games).toFixed(1),
    avgDeaths: (d / games).toFixed(1),
    avgAssists: (a / games).toFixed(1),
    kda: kdaOf(k, d, a),
    avgScore: (sum('score') / games).toFixed(1)
  };
}
