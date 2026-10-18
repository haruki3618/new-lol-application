import { patchOf } from '../utils/patch.js';
import { FALLBACK_REGION, regionOfMatchId } from '../constants/regions.js';

// 事前集計（ChampAgg）の計算部分。DB に依存しないので単体でテストできる。
// 1試合を保存するたびに、次の「行」へ加算する（行は リージョン × 試合の種類 × パッチ × 帯 × ロール × チャンピオン。リージョンは v6.4 で追加）:
//   role='ALL'    … 全ロール合算のチャンピオン別成績
//   role='TOP' 等 … ロール別のチャンピオン別成績
//   role='BAN'    … バン数（champ はチャンピオンの数値ID）
//   role='TOTAL'  … 試合数・オブジェクト別の勝敗（champ は '-'）
export const OBJECTIVES = {
  firstBlood: 'ファーストブラッド',
  firstTower: 'ファーストタワー',
  dragon3: 'ドラゴン3体以上',
  baron: 'バロン獲得',
  herald: 'リフトヘラルド獲得'
};

const num = (n) => (Number.isFinite(n) ? n : 0);
// region は最後の引数（省略時 jp）。v6.3 までの呼び出し方（5引数）でもそのまま使える
/**
 * 事前集計の行のキー（ChampAgg の _id）。region は最後の引数（省略時 jp）。
 * @param {number} q
 * @param {string} patch
 * @param {string} band
 * @param {string} role
 * @param {string | number} champ
 * @param {string} [region]
 * @returns {string}
 */
export const aggKey = (q, patch, band, role, champ, region = FALLBACK_REGION) => [region, q, patch, band, role, champ].join('|');

function delta(dims, inc) {
  return { key: aggKey(dims.q, dims.patch, dims.band, dims.role, dims.champ, dims.region), dims, inc };
}

function objectiveFlags(team) {
  return {
    firstBlood: Boolean(team.firstBlood),
    firstTower: Boolean(team.firstTower),
    dragon3: num(team.dragons) >= 3,
    baron: num(team.barons) >= 1,
    herald: num(team.heralds) >= 1
  };
}

// 1試合 → 加算する行の一覧（パッチが分からない試合は集計しない）
/**
 * 1 試合 → 加算する行の一覧。パッチが分からない試合・参加者が無い試合は集計しない。
 * @param {import('../types.js').MatchDoc} doc
 * @returns {{key: string, dims: import('../types.js').AggDims, inc: Record<string, number>}[] | null}
 */
export function buildDeltas(doc) {
  const patch = patchOf(doc?.gameVersion);
  if (!patch || !Array.isArray(doc.participants)) return null;

  const q = doc.queueId ?? 0;
  const region = doc.region || regionOfMatchId(doc.matchId) || FALLBACK_REGION;
  const band = doc.band || 'UNKNOWN';
  const minutes = num(doc.gameDuration) / 60;
  const out = [];

  for (const p of doc.participants) {
    if (!p.championName) continue;
    const k = num(p.kills);
    const d = num(p.deaths);
    const a = num(p.assists);
    const inc = {
      games: 1,
      wins: p.win ? 1 : 0,
      kills: k,
      deaths: d,
      assists: a,
      kdaSum: (k + a) / Math.max(d, 1),
      damage: num(p.totalDamageDealtToChampions),
      gold: num(p.goldEarned),
      cs: num(p.totalMinionsKilled) + num(p.neutralMinionsKilled),
      vision: num(p.visionScore),
      minutes
    };
    out.push(delta({ region, q, patch, band, role: 'ALL', champ: p.championName }, inc));
    if (p.teamPosition) out.push(delta({ region, q, patch, band, role: p.teamPosition, champ: p.championName }, inc));
  }

  const teams = Array.isArray(doc.teams) ? doc.teams : [];
  const total = { matches: 1 };
  if (teams.length > 0) {
    total.matchesBans = 1; // 「バン・オブジェクトの情報がある試合」の数（旧データを分母に入れないため）
    for (const t of teams) {
      for (const id of t.bans || []) out.push(delta({ region, q, patch, band, role: 'BAN', champ: String(id) }, { bans: 1 }));
      for (const [name, on] of Object.entries(objectiveFlags(t))) {
        if (!on) continue;
        total[`obj.${name}.g`] = (total[`obj.${name}.g`] || 0) + 1;
        if (t.win) total[`obj.${name}.w`] = (total[`obj.${name}.w`] || 0) + 1;
      }
    }
  }
  out.push(delta({ region, q, patch, band, role: 'TOTAL', champ: '-' }, total));
  return out;
}

// 同じ行への加算をまとめる（再構築のとき数万試合をメモリ上で合算する）
/**
 * 同じ行への加算をまとめる（再構築のとき数万試合をメモリ上で合算する）。acc を直接変更して返す。
 * @param {Map<string, {dims: import('../types.js').AggDims, inc: Record<string, number>}>} acc
 * @param {{key: string, dims: import('../types.js').AggDims, inc: Record<string, number>}[]} deltas
 * @returns {Map<string, {dims: import('../types.js').AggDims, inc: Record<string, number>}>}
 */
export function mergeDeltas(acc, deltas) {
  for (const { key, dims, inc } of deltas) {
    let entry = acc.get(key);
    if (!entry) {
      entry = { dims, inc: {} };
      acc.set(key, entry);
    }
    for (const [field, value] of Object.entries(inc)) entry.inc[field] = (entry.inc[field] || 0) + value;
  }
  return acc;
}

// MongoDB の bulkWrite 用。$inc は加算なので、同じ操作をやり直すと二重に数える点に注意
/**
 * MongoDB の bulkWrite 用の操作に変換する。$inc は加算なので、同じ操作をやり直すと二重に数える。
 * @param {Map<string, {dims: import('../types.js').AggDims, inc: Record<string, number>}>} acc
 * @returns {object[]}
 */
export function toBulkOps(acc) {
  return [...acc.entries()].map(([key, { dims, inc }]) => ({
    updateOne: { filter: { _id: key }, update: { $inc: inc, $setOnInsert: dims }, upsert: true }
  }));
}
