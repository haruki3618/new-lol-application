// チャンピオンのおすすめビルド（ルーン・スペル・アイテム）と対面（マッチアップ）の計算部分。
// DB に依存しない純粋な関数なので、単体でテストできる。
//
// 入力 rows は、そのチャンピオンを使った参加者 1 人につき 1 件:
//   { dur(秒), me: { win, teamPosition, keystone, subStyle, primaryStyle, runes[9], summoner1Id, summoner2Id,
//                    item0..item5, kills, deaths, assists, totalMinionsKilled, neutralMinionsKilled,
//                    goldEarned, totalDamageDealtToChampions, visionScore },
//     opp: 同じロールで反対のチームにいた参加者（me と同じ項目。いなければ無し）}
//
// 並び順は「勝率の 95% 区間（Wilson）の下限」。試合数が少ない勝率をそのまま上位にしないための割引で、
// 最低試合数（minGames）に届かないものは「参考」として後ろに回し、おすすめ（recommended）にはしない。
import { wilson } from './insightsMath.js';
import { adjustedWinRate } from './tierList.js';

export const MIN_GAMES = 5; // 既定の最低試合数
export const MIN_RUNE_PAGES = 3; // ルーンページ全体は組み合わせが多いので、少し緩める

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (w, n) => (n > 0 ? round1((w / n) * 100) : 0);
const num = (n) => (Number.isFinite(n) ? n : 0);
const csOf = (p) => num(p?.totalMinionsKilled) + num(p?.neutralMinionsKilled);

// ---------- 共通の小さな道具 ----------

function addTo(map, key, make, win) {
  let e = map.get(key);
  if (!e) {
    e = make();
    e.games = 0;
    e.wins = 0;
    map.set(key, e);
  }
  e.games += 1;
  if (win) e.wins += 1;
  return e;
}

// 勝率・95%区間・ピック率を付ける
function finish(e, total) {
  const { lo, hi } = wilson(e.wins, e.games);
  return { ...e, winRate: pct(e.wins, e.games), ci: { lo, hi }, pickRate: total > 0 ? round1((e.games / total) * 100) : 0 };
}

// 最低試合数を満たすものを下限の高い順に、満たさないものを試合数の多い順に後ろへ。先頭だけおすすめ
function rank(list, minGames) {
  const eligible = list.filter((x) => x.games >= minGames).sort((a, b) => b.ci.lo - a.ci.lo || b.games - a.games);
  const rest = list.filter((x) => x.games < minGames).sort((a, b) => b.games - a.games);
  return [...eligible, ...rest].map((x, i) => ({ ...x, recommended: i === 0 && eligible.length > 0, few: x.games < minGames }));
}

// ---------- アイテムの分類 ----------

// items は Data Dragon のアイテム表（id → { total, final, consumed, tags }）。取れていないときは分類せず、全部を「完成品」として扱う
export function makeItemClassifier(items) {
  const known = items && Object.keys(items).length > 0;
  return (id) => {
    if (!(id > 0)) return null;
    if (!known) return 'core';
    const it = items[String(id)];
    if (!it) return null;
    const boots = (it.tags || []).includes('Boots') && (it.final || it.total >= 900);
    if (boots) return 'boots';
    if (it.final && !it.consumed && it.total >= 1000) return 'core';
    return null;
  };
}

const ITEM_KEYS = ['item0', 'item1', 'item2', 'item3', 'item4', 'item5'];
const itemsOf = (me) => ITEM_KEYS.map((k) => me?.[k]).filter((id) => id > 0);

function triples(ids) {
  const out = [];
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) for (let c = b + 1; c < ids.length; c++) out.push([ids[a], ids[b], ids[c]]);
  return out;
}

// ---------- ロール ----------

/**
 * 試合の行（me.teamPosition を持つ）をロール別にまとめる。試合数の多い順。
 * @param {{me?: {teamPosition?: string, win?: boolean}}[]} rows
 * @returns {{role: string, games: number, wins: number, winRate: number, share: number}[]} share は全体に占める割合（%）
 */
export function rolesOf(rows) {
  const by = new Map();
  for (const r of rows) {
    const role = r?.me?.teamPosition;
    if (role) addTo(by, role, () => ({ role }), r.me.win);
  }
  const total = rows.length;
  return [...by.values()]
    .sort((a, b) => b.games - a.games)
    .map((e) => ({ role: e.role, games: e.games, wins: e.wins, winRate: pct(e.wins, e.games), share: total > 0 ? Math.round((e.games / total) * 100) : 0 }));
}

// ロール指定（null なら全ロール）で絞る
/**
 * ロール指定（null なら全ロール）で行を絞る。
 * @template T
 * @param {T[]} rows
 * @param {string | null} role
 * @returns {T[]}
 */
export const forRole = (rows, role) => (role ? rows.filter((r) => r?.me?.teamPosition === role) : rows);

// ---------- おすすめビルド ----------

export function buildReport(rows, { role = null, minGames = MIN_GAMES, items = {} } = {}) {
  const list = forRole(rows, role).filter((r) => r?.me);
  const total = list.length;
  const wins = list.filter((r) => r.me.win).length;
  const classify = makeItemClassifier(items);

  const keystones = new Map();
  const pages = new Map();
  const spells = new Map();
  const boots = new Map();
  const core = new Map();
  const builds = new Map();
  let withPages = 0;

  for (const { me } of list) {
    if (me.keystone > 0) {
      const k = addTo(keystones, me.keystone, () => ({ id: me.keystone, subs: new Map() }), me.win);
      if (me.subStyle > 0) addTo(k.subs, me.subStyle, () => ({ id: me.subStyle }), me.win);
    }

    if (Array.isArray(me.runes) && me.runes.length === 9) {
      withPages += 1;
      addTo(pages, me.runes.join('-'), () => ({ runes: me.runes, primaryStyle: me.primaryStyle, subStyle: me.subStyle }), me.win);
    }

    if (me.summoner1Id > 0 && me.summoner2Id > 0) {
      const ids = [Math.min(me.summoner1Id, me.summoner2Id), Math.max(me.summoner1Id, me.summoner2Id)];
      addTo(spells, ids.join('-'), () => ({ ids }), me.win);
    }

    const mine = [...new Set(itemsOf(me))];
    const coreIds = [];
    for (const id of mine) {
      const kind = classify(id);
      if (kind === 'boots') addTo(boots, id, () => ({ id }), me.win);
      else if (kind === 'core') {
        coreIds.push(id);
        addTo(core, id, () => ({ id }), me.win);
      }
    }
    coreIds.sort((a, b) => a - b);
    for (const t of triples(coreIds)) addTo(builds, t.join('-'), () => ({ ids: t }), me.win);
  }

  const fin = (map) => [...map.values()].map((e) => finish(e, total));

  return {
    role,
    games: total,
    wins,
    winRate: pct(wins, total),
    ci: wilson(wins, total),
    minGames,
    enough: total >= minGames,
    keystones: rank(
      fin(keystones).map((k) => ({ ...k, subs: [...k.subs.values()].sort((a, b) => b.games - a.games).slice(0, 3).map((s) => ({ id: s.id, games: s.games, winRate: pct(s.wins, s.games) })) })),
      minGames
    ).slice(0, 6),
    runePages: rank(fin(pages), Math.min(minGames, MIN_RUNE_PAGES)).slice(0, 3),
    runeCoverage: { withPages, total }, // 版3（v6.4 以降に保存した試合）だけがルーンページ全体を持つ
    spells: rank(fin(spells), minGames).slice(0, 4),
    boots: rank(fin(boots), minGames).slice(0, 4),
    coreItems: fin(core).sort((a, b) => b.games - a.games || b.winRate - a.winRate).slice(0, 12).map((x) => ({ ...x, few: x.games < minGames })),
    coreBuilds: rank(fin(builds), minGames).slice(0, 5)
  };
}

// ---------- 対面（マッチアップ） ----------

// 勝率の区間が 50% をまたがなければ「有利/不利」、またぐなら「互角」、試合数が足りなければ「参考」
/**
 * 勝率の 95% 区間が 50% をまたがなければ有利 / 不利、またぐなら互角、試合数が足りなければ参考。
 * @param {number} wins
 * @param {number} games
 * @param {number} [minGames]
 * @returns {'few' | 'good' | 'bad' | 'even'}
 */
export function verdictOf(wins, games, minGames = MIN_GAMES) {
  if (games < minGames) return 'few';
  const { lo, hi } = wilson(wins, games);
  if (lo > 50) return 'good';
  if (hi < 50) return 'bad';
  return 'even';
}

function diffs(group) {
  const n = group.games;
  const avg = (v) => (n > 0 ? round1(v / n) : 0);
  return {
    gold: Math.round(group.gold / Math.max(n, 1)),
    cs: avg(group.cs),
    kills: avg(group.kills),
    deaths: avg(group.deaths),
    assists: avg(group.assists),
    damage: Math.round(group.damage / Math.max(n, 1)),
    vision: avg(group.vision)
  };
}

const emptyDiff = () => ({ gold: 0, cs: 0, kills: 0, deaths: 0, assists: 0, damage: 0, vision: 0 });

// 自分 - 相手 の平均差を積み上げる
function addDiff(e, me, opp) {
  e.gold = (e.gold || 0) + num(me.goldEarned) - num(opp.goldEarned);
  e.cs = (e.cs || 0) + csOf(me) - csOf(opp);
  e.kills = (e.kills || 0) + num(me.kills) - num(opp.kills);
  e.deaths = (e.deaths || 0) + num(me.deaths) - num(opp.deaths);
  e.assists = (e.assists || 0) + num(me.assists) - num(opp.assists);
  e.damage = (e.damage || 0) + num(me.totalDamageDealtToChampions) - num(opp.totalDamageDealtToChampions);
  e.vision = (e.vision || 0) + num(me.visionScore) - num(opp.visionScore);
}

export function buildMatchups(rows, { role = null, minGames = MIN_GAMES, sort = 'games', limit = 40 } = {}) {
  const list = forRole(rows, role).filter((r) => r?.me && r?.opp?.championName);
  const by = new Map();
  for (const { me, opp } of list) {
    const e = addTo(by, opp.championName, () => ({ championName: opp.championName }), me.win);
    addDiff(e, me, opp);
  }

  const all = [...by.values()].map((e) => {
    const { lo, hi } = wilson(e.wins, e.games);
    return {
      championName: e.championName,
      games: e.games,
      wins: e.wins,
      losses: e.games - e.wins,
      winRate: pct(e.wins, e.games),
      adjusted: round1(adjustedWinRate(e.wins, e.games) * 100),
      ci: { lo, hi },
      verdict: verdictOf(e.wins, e.games, minGames),
      diff: diffs(e)
    };
  });

  const eligible = all.filter((x) => x.games >= minGames);
  const byAdj = (a, b) => b.adjusted - a.adjusted || b.games - a.games;
  const sorters = {
    games: (a, b) => b.games - a.games || b.adjusted - a.adjusted,
    winRate: byAdj,
    worst: (a, b) => a.adjusted - b.adjusted || b.games - a.games
  };
  const sorted = [...all].sort(sorters[sort] || sorters.games);

  return {
    role,
    minGames,
    games: list.length,
    opponents: all.length,
    best: eligible.filter((x) => x.winRate > 50).sort(byAdj).slice(0, 5),
    worst: eligible.filter((x) => x.winRate < 50).sort((a, b) => a.adjusted - b.adjusted || b.games - a.games).slice(0, 5),
    rows: sorted.slice(0, limit)
  };
}

// 2体の直接対決（champ の視点）。平均値は「自分」「相手」それぞれと、その差
export function headToHead(rows, vs, { role = null, minGames = MIN_GAMES } = {}) {
  const list = forRole(rows, role).filter((r) => r?.me && r?.opp?.championName === vs);
  const games = list.length;
  const wins = list.filter((r) => r.me.win).length;

  const sum = () => ({ games, gold: 0, cs: 0, kills: 0, deaths: 0, assists: 0, damage: 0, vision: 0 });
  const mine = sum();
  const theirs = sum();
  const diff = emptyDiff();
  let minutes = 0;
  const add = (g, p) => {
    g.gold += num(p.goldEarned);
    g.cs += csOf(p);
    g.kills += num(p.kills);
    g.deaths += num(p.deaths);
    g.assists += num(p.assists);
    g.damage += num(p.totalDamageDealtToChampions);
    g.vision += num(p.visionScore);
  };
  for (const { me, opp, dur } of list) {
    add(mine, me);
    add(theirs, opp);
    minutes += num(dur) / 60;
  }
  if (games > 0) {
    for (const k of Object.keys(diff)) diff[k] = k === 'gold' || k === 'damage' ? Math.round((mine[k] - theirs[k]) / games) : round1((mine[k] - theirs[k]) / games);
  }

  return {
    role,
    games,
    wins,
    losses: games - wins,
    winRate: pct(wins, games),
    ci: wilson(wins, games),
    verdict: verdictOf(wins, games, minGames),
    minGames,
    avgMinutes: games > 0 ? round1(minutes / games) : 0,
    me: diffs(mine),
    opp: diffs(theirs),
    diff
  };
}
