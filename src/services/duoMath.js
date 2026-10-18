// デュオ・対戦比較の計算（DB に依存しない。Match の lean ドキュメントの配列を渡す）

const pct = (w, g) => (g > 0 ? Math.round((w / g) * 100) : 0);
const kdaOf = (k, d, a) => (d === 0 ? 'Perfect' : ((k + a) / d).toFixed(2));
const blank = () => ({ games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 });

function add(e, p) {
  e.games += 1;
  if (p.win) e.wins += 1;
  e.kills += p.kills || 0;
  e.deaths += p.deaths || 0;
  e.assists += p.assists || 0;
}

function finish(e) {
  return {
    games: e.games,
    wins: e.wins,
    losses: e.games - e.wins,
    winRate: pct(e.wins, e.games),
    kda: kdaOf(e.kills, e.deaths, e.assists)
  };
}

// 勝率の差を「サンプルが少ないときは断定しない」ための目安にする
export const MIN_GAMES = 5;

// 2人が同じ試合にいたものを、同じチーム（デュオ）と相手チーム（対戦）に分ける
/**
 * 2 人が同じ試合にいたものを、同じチーム（duo）と相手チーム（versus）に分ける。
 * @param {import('../types.js').MatchDoc[]} matches
 * @param {string} puuidA
 * @param {string} puuidB 同じ PUUID なら何も返さない
 * @returns {{duo: {match: import('../types.js').MatchDoc, a: import('../types.js').Participant, b: import('../types.js').Participant}[], versus: {match: import('../types.js').MatchDoc, a: import('../types.js').Participant, b: import('../types.js').Participant}[]}}
 */
export function splitCommonMatches(matches, puuidA, puuidB) {
  const duo = [];
  const versus = [];
  for (const m of matches || []) {
    const a = (m.participants || []).find((p) => p.puuid === puuidA);
    const b = (m.participants || []).find((p) => p.puuid === puuidB);
    if (!a || !b || puuidA === puuidB) continue;
    (a.teamId === b.teamId ? duo : versus).push({ match: m, a, b });
  }
  return { duo, versus };
}

function topChampPairs(rows, limit = 5) {
  const map = new Map();
  for (const { a, b, } of rows) {
    const key = `${a.championName}|${b.championName}`;
    const e = map.get(key) || { champA: a.championName, champB: b.championName, games: 0, wins: 0 };
    e.games += 1;
    if (a.win) e.wins += 1;
    map.set(key, e);
  }
  return [...map.values()]
    .sort((x, y) => y.games - x.games || y.wins - x.wins)
    .slice(0, limit)
    .map((e) => ({ ...e, losses: e.games - e.wins, winRate: pct(e.wins, e.games) }));
}

// ロールの組み合わせ（例: BOTTOM + UTILITY）別の勝率
function roleCombos(rows) {
  const map = new Map();
  for (const { a, b } of rows) {
    if (!a.teamPosition || !b.teamPosition) continue;
    const key = `${a.teamPosition}|${b.teamPosition}`;
    const e = map.get(key) || { roleA: a.teamPosition, roleB: b.teamPosition, games: 0, wins: 0 };
    e.games += 1;
    if (a.win) e.wins += 1;
    map.set(key, e);
  }
  return [...map.values()]
    .sort((x, y) => y.games - x.games)
    .map((e) => ({ ...e, losses: e.games - e.wins, winRate: pct(e.wins, e.games) }));
}

// 個人の通常成績（比較の基準にする）。比較対象は「全試合」ではなく渡された試合に限る
function soloLine(matches, puuid) {
  const e = blank();
  for (const m of matches || []) {
    const p = (m.participants || []).find((x) => x.puuid === puuid);
    if (p) add(e, p);
  }
  return finish(e);
}

/**
 * デュオ・対戦の成績と相性の判定。共通の試合が MIN_GAMES 未満のときは判定しない（verdict.level = 'insufficient'）。
 * @param {import('../types.js').MatchDoc[]} matches
 * @param {string} puuidA
 * @param {string} puuidB
 * @returns {{totalCommon: number, duo: object, versus: object, solo: {a: object, b: object}, verdict: {level: 'insufficient' | 'good' | 'bad' | 'even', text: string}, recent: object[]}}
 */
export function analyzeDuo(matches, puuidA, puuidB) {
  const { duo, versus } = splitCommonMatches(matches, puuidA, puuidB);

  const duoA = blank();
  const duoB = blank();
  for (const { a, b } of duo) { add(duoA, a); add(duoB, b); }

  // 対戦: A から見た勝敗
  const vs = blank();
  const vsB = blank();
  for (const { a, b } of versus) { add(vs, a); add(vsB, b); }

  const duoSummary = finish(duoA);
  const soloA = soloLine(matches, puuidA);
  const soloB = soloLine(matches, puuidB);

  // 2人で組んだときの勝率が、それぞれ単独のときと比べてどうか（ポイント差）
  const verdict =
    duoSummary.games < MIN_GAMES
      ? { level: 'insufficient', text: `共通の試合が${MIN_GAMES}戦未満のため、相性は判定できません。` }
      : duoSummary.winRate >= 55
        ? { level: 'good', text: '2人で組んだときの勝率が高く、相性は良好です。' }
        : duoSummary.winRate <= 45
          ? { level: 'bad', text: '2人で組んだときの勝率が低めです。ロールやチャンピオンの組み合わせを見直す余地があります。' }
          : { level: 'even', text: '2人で組んだときの勝率は平均的です。' };

  return {
    totalCommon: duo.length + versus.length,
    duo: {
      ...duoSummary,
      a: finish(duoA),
      b: finish(duoB),
      pairs: topChampPairs(duo),
      roles: roleCombos(duo)
    },
    versus: {
      ...finish(vs), // A の勝敗
      b: finish(vsB)
    },
    solo: { a: soloA, b: soloB },
    verdict,
    recent: duo
      .map(({ match, a, b }) => ({ matchId: match.matchId, gameCreation: match.gameCreation, win: a.win, champA: a.championName, champB: b.championName }))
      .sort((x, y) => y.gameCreation - x.gameCreation)
      .slice(0, 10)
  };
}
