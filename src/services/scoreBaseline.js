// スコアの基準（DB に依存しない部分）。
// 「ロール × チャンピオン」の平均を基準にすると、サポートの視界やアタッカーの CS が公平に評価される。
// 行は ChampAgg（role は TOP / JUNGLE / MIDDLE / BOTTOM / UTILITY）を (role, champ) ごとに合算したもの。
const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

function means(a) {
  return {
    games: a.games,
    minutes: a.minutes,
    kda: a.kdaSum / a.games,
    dpm: a.damage / a.minutes,
    gpm: a.gold / a.minutes,
    cpm: a.cs / a.minutes,
    vpm: a.vision / a.minutes
  };
}

const zero = () => ({ games: 0, kdaSum: 0, damage: 0, gold: 0, cs: 0, vision: 0, minutes: 0 });
function addTo(acc, r) {
  for (const k of Object.keys(acc)) acc[k] += Number(r[k]) || 0;
}

/**
 * ChampAgg の行を「ロール × チャンピオン」ごとの平均にまとめる。キーは 'ROLE|チャンピオン'、ロール全体は 'ROLE|*'。
 * @param {object[]} rows
 * @returns {Map<string, {games: number, minutes: number, kda: number, dpm: number, gpm: number, cpm: number, vpm: number}>}
 */
export function computeBaselines(rows) {
  const map = new Map();
  const roleAcc = new Map();
  for (const r of rows) {
    if (!ROLES.includes(r.role) || !r.champ || !(r.games > 0) || !(r.minutes > 0)) continue;
    const acc = zero();
    addTo(acc, r);
    map.set(`${r.role}|${r.champ}`, means(acc));
    if (!roleAcc.has(r.role)) roleAcc.set(r.role, zero());
    addTo(roleAcc.get(r.role), r);
  }
  for (const [role, acc] of roleAcc) map.set(`${role}|*`, means(acc));
  return map;
}

// (チャンピオン, ロール) → 基準。試合数が足りなければ ロール全体 → null（試合内の相対評価に戻る）の順に使う
/**
 * (チャンピオン, ロール) → 基準を引く関数を作る。試合数が足りなければ ロール全体 → null の順に使う。
 * @param {Map<string, object>} map computeBaselines の戻り値
 * @param {{minChamp?: number, minRole?: number}} [options]
 * @returns {(champ: string, role: string) => (object | null)}
 */
export function baselineLookup(map, { minChamp = 30, minRole = 200 } = {}) {
  return (champ, role) => {
    if (!role) return null;
    const c = map.get(`${role}|${champ}`);
    if (c && c.games >= minChamp) return c;
    const r = map.get(`${role}|*`);
    return r && r.games >= minRole ? r : null;
  };
}
