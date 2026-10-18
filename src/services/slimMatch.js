// Riot の生レスポンスから必要項目だけを取り出す（DB に依存しない純粋な関数）
// v5.2: バン・オブジェクト・チームのキル数（teams）と、起点の帯（band）を追加。
// v6.4（版 3）: ルーン構成の全体（primaryStyle と runes）を追加。チャンピオンのおすすめルーン用。
//   版 2 までの試合には runes が無い（キーストーンとサブ系統だけ）。取得済みのデータの取りこぼしを無くすだけで、API は追加で使わない。
export const MATCH_SCHEMA_VERSION = 3;

export const PARTICIPANT_FIELDS = [
  'puuid', 'riotIdGameName', 'riotIdTagline', 'teamId', 'teamPosition', 'championName', 'champLevel',
  'kills', 'deaths', 'assists', 'win', 'totalMinionsKilled', 'neutralMinionsKilled', 'visionScore',
  'goldEarned', 'totalDamageDealtToChampions', 'totalDamageTaken', 'summoner1Id', 'summoner2Id',
  'keystone', 'subStyle', 'primaryStyle', 'runes', 'item0', 'item1', 'item2', 'item3', 'item4', 'item5', 'item6'
];

// ルーン構成を9個の数値にまとめる: [メイン4つ（先頭がキーストーン）, サブ2つ, 攻撃・柔軟・防御のシャード]。
// 欠けているとき（アリーナなどルーンの形が違う試合）は undefined（保存しない）
export function slimRunes(perks) {
  const styles = perks?.styles;
  const main = (styles?.[0]?.selections || []).map((s) => s.perk);
  const sub = (styles?.[1]?.selections || []).map((s) => s.perk);
  const stat = perks?.statPerks || {};
  const shards = [stat.offense, stat.flex, stat.defense];
  const all = [...main, ...sub, ...shards];
  return main.length === 4 && sub.length === 2 && all.every((n) => Number.isInteger(n) && n > 0) ? all : undefined;
}

export function slimTeam(t) {
  const o = t?.objectives || {};
  const kills = (k) => Number(o[k]?.kills) || 0;
  return {
    teamId: t.teamId,
    win: Boolean(t.win),
    bans: (t.bans || []).map((b) => b.championId).filter((id) => Number.isInteger(id) && id > 0),
    kills: kills('champion'),
    dragons: kills('dragon'),
    barons: kills('baron'),
    heralds: kills('riftHerald'),
    grubs: kills('horde'),
    towers: kills('tower'),
    inhibitors: kills('inhibitor'),
    firstBlood: Boolean(o.champion?.first),
    firstTower: Boolean(o.tower?.first)
  };
}

export function slimMatch(raw, { band } = {}) {
  const info = raw?.info;
  const metadata = raw?.metadata;
  if (!info?.participants || !metadata?.matchId) return null;

  return {
    matchId: metadata.matchId,
    gameCreation: info.gameCreation,
    gameDate: new Date(info.gameCreation),
    gameDuration: info.gameDuration,
    queueId: info.queueId,
    gameVersion: info.gameVersion,
    band: band || 'UNKNOWN',
    v: MATCH_SCHEMA_VERSION,
    participantPuuids: metadata.participants || info.participants.map((p) => p.puuid),
    teams: (info.teams || []).map(slimTeam),
    participants: info.participants.map((p) => {
      const slim = {};
      for (const field of PARTICIPANT_FIELDS) slim[field] = p[field];
      slim.keystone = p.perks?.styles?.[0]?.selections?.[0]?.perk;
      slim.subStyle = p.perks?.styles?.[1]?.style;
      slim.primaryStyle = p.perks?.styles?.[0]?.style;
      slim.runes = slimRunes(p.perks);
      return slim;
    })
  };
}
