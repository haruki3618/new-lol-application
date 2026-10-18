import Match from '../models/Match.js';
import ChampAgg from '../models/ChampAgg.js';
import { v52 } from '../config/v52.js';
import { BAND_GROUPS } from '../constants/bands.js';
import { buildDeltas, mergeDeltas, toBulkOps, OBJECTIVES } from './aggMath.js';
import { computeBaselines, baselineLookup } from './scoreBaseline.js';
import { cached } from '../utils/cache.js';
import { comparePatchDesc } from '../utils/patch.js';
import { config } from '../config/index.js';
import { readRegion } from '../constants/regions.js';

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const CHUNK = 1000;
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

// ---------- 書き込み ----------

// 新しく保存できた1試合を、事前集計の各行へ加算する
export async function applyMatchToAggregates(doc) {
  const deltas = buildDeltas(doc);
  if (!deltas || deltas.length === 0) return;
  await ChampAgg.bulkWrite(toBulkOps(mergeDeltas(new Map(), deltas)), { ordered: false });
  invalidateAggCache();
}

// 保存済みの試合から事前集計を作り直す（メモリ上で合算してから入れ替える）
export async function rebuildAggregates() {
  const acc = new Map();
  let matches = 0;
  const cursor = Match.find({}).lean().cursor();
  for await (const doc of cursor) {
    const deltas = buildDeltas(doc);
    if (!deltas) continue;
    mergeDeltas(acc, deltas);
    matches += 1;
  }
  await ChampAgg.deleteMany({});
  const ops = toBulkOps(acc);
  for (let i = 0; i < ops.length; i += CHUNK) {
    await ChampAgg.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
  }
  invalidateAggCache();
  return { matches, rows: ops.length };
}

// 集計がまだ空のとき、または region の無い旧い行（v6.3 まで）が残っているときに、集計を作り直す（同時に何度も走らせない）。
// どちらも試合が保存されているときだけ。保存済みの試合から作り直すので、API は使わない
let building = null;
export function ensureAggregates() {
  if (building) return building;
  building = (async () => {
    try {
      if ((await Match.estimatedDocumentCount()) === 0) return false;
      const empty = (await ChampAgg.estimatedDocumentCount()) === 0;
      const legacy = !empty && Boolean(await ChampAgg.exists({ region: { $exists: false } }));
      if (!empty && !legacy) return false;
      console.log(legacy ? '[Agg] リージョン対応のため事前集計を作り直します（1回だけ）…' : '[Agg] 事前集計を作成します（初回のみ）…');
      const r = await rebuildAggregates();
      console.log(`[Agg] 作成しました: ${r.matches} 試合 → ${r.rows} 行`);
      return true;
    } catch (err) {
      console.warn(`[Agg] 初回の集計に失敗: ${err.message}`);
      return false;
    } finally {
      building = null;
    }
  })();
  return building;
}

// ---------- 読み取り ----------

// 画面用の読み取りは短時間（TTL）だけメモリに置く
const cachedAgg = (key, ttl, loader) => cached(key, ttl, loader);
function invalidateAggCache() {
  // cache.js に削除 API は無いので、短い TTL で自然に入れ替わる
}

const TTL = 60 * 1000;

const regionOr = (r) => readRegion(r, config.defaultRegion);

function baseMatch({ queueId = 420, patch = null, band = 'all', region = null } = {}) {
  const m = { region: regionOr(region) };
  if (queueId) m.q = queueId; // null は「すべてのモード」
  if (patch) m.patch = patch;
  const bands = BAND_GROUPS[band]?.bands;
  if (bands) m.band = { $in: bands };
  return m;
}

// 集計にあるパッチ一覧（新しい順）
export function getAggPatches(queueId = 420, region = null) {
  const rg = regionOr(region);
  return cachedAgg(`agg-patches:${rg}:${queueId}`, TTL, async () => {
    await ensureAggregates();
    const list = await ChampAgg.distinct('patch', { region: rg, ...(queueId ? { q: queueId } : {}), role: 'TOTAL' });
    return list.sort(comparePatchDesc);
  });
}

// チャンピオン別の成績表。bans は数値IDなので idToName（数値ID → 画像用ID）で名前に直す
export function getChampionAggTable({ queueId = 420, patch = null, band = 'all', role = null, region = null } = {}, idToName = {}) {
  const rg = regionOr(region);
  const key = `agg-table:${rg}:${queueId}:${patch || 'all'}:${band}:${role || 'all'}:${Object.keys(idToName).length}`;
  return cachedAgg(key, TTL, async () => {
    await ensureAggregates();
    const match = baseMatch({ queueId, patch, band, region: rg });
    const [rows, totals, bans] = await Promise.all([
      ChampAgg.aggregate([
        { $match: { ...match, role: role || 'ALL' } },
        {
          $group: {
            _id: '$champ', games: { $sum: '$games' }, wins: { $sum: '$wins' },
            kills: { $sum: '$kills' }, deaths: { $sum: '$deaths' }, assists: { $sum: '$assists' }
          }
        }
      ]),
      ChampAgg.aggregate([
        { $match: { ...match, role: 'TOTAL' } },
        { $group: { _id: null, matches: { $sum: '$matches' }, matchesBans: { $sum: '$matchesBans' } } }
      ]),
      ChampAgg.aggregate([{ $match: { ...match, role: 'BAN' } }, { $group: { _id: '$champ', bans: { $sum: '$bans' } } }])
    ]);

    const totalMatches = totals[0]?.matches || 0;
    const banMatches = totals[0]?.matchesBans || 0;
    const banByName = new Map();
    for (const b of bans) {
      const name = idToName[b._id];
      if (name) banByName.set(name, (banByName.get(name) || 0) + b.bans);
    }

    return {
      totalMatches,
      banMatches,
      rows: rows
        .filter((r) => r._id && r.games > 0)
        .map((r) => ({
          championName: r._id,
          games: r.games,
          wins: r.wins,
          winRate: pct(r.wins, r.games),
          pickRate: totalMatches > 0 ? round1((r.games / totalMatches) * 100) : 0,
          banRate: banMatches > 0 ? round1(((banByName.get(r._id) || 0) / banMatches) * 100) : null,
          kda: r.deaths === 0 ? 'Perfect' : ((r.kills + r.assists) / r.deaths).toFixed(2),
          kdaValue: (r.kills + r.assists) / Math.max(r.deaths, 1)
        }))
    };
  });
}

// オブジェクトを取ったときのチームの勝率
export function getObjectiveStats({ queueId = 420, patch = null, band = 'all', region = null } = {}) {
  const rg = regionOr(region);
  return cachedAgg(`agg-obj:${rg}:${queueId}:${patch || 'all'}:${band}`, TTL, async () => {
    await ensureAggregates();
    const group = { _id: null, matches: { $sum: '$matchesBans' } };
    for (const name of Object.keys(OBJECTIVES)) {
      group[`${name}_g`] = { $sum: `$obj.${name}.g` };
      group[`${name}_w`] = { $sum: `$obj.${name}.w` };
    }
    const [t] = await ChampAgg.aggregate([
      { $match: { ...baseMatch({ queueId, patch, band, region: rg }), role: 'TOTAL' } },
      { $group: group }
    ]);
    return {
      matches: t?.matches || 0,
      items: Object.entries(OBJECTIVES).map(([name, label]) => {
        const games = t?.[`${name}_g`] || 0;
        const wins = t?.[`${name}_w`] || 0;
        return { name, label, games, wins, winRate: pct(wins, games) };
      })
    };
  });
}

// スコアの基準。集計が空なら null（従来の試合内の相対評価に戻る）
export function getBaselineFn() {
  return cachedAgg('agg-baseline', 10 * 60 * 1000, async () => {
    const rows = await ChampAgg.aggregate([
      { $match: { q: 420, role: { $in: ROLES } } },
      {
        $group: {
          _id: { role: '$role', champ: '$champ' },
          games: { $sum: '$games' }, kdaSum: { $sum: '$kdaSum' }, damage: { $sum: '$damage' },
          gold: { $sum: '$gold' }, cs: { $sum: '$cs' }, vision: { $sum: '$vision' }, minutes: { $sum: '$minutes' }
        }
      }
    ]);
    if (rows.length === 0) return null;
    const flat = rows.map(({ _id, ...r }) => ({ role: _id.role, champ: _id.champ, ...r }));
    return baselineLookup(computeBaselines(flat), { minChamp: v52.baselineMinChamp, minRole: v52.baselineMinRole });
  });
}
