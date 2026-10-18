import mongoose from 'mongoose';
import Match from '../models/Match.js';
import LpSnapshot from '../models/LpSnapshot.js';
import PlayerName from '../models/PlayerName.js';
import { config } from '../config/index.js';

// データベースの容量を、コード側から管理する（v6.5）
//   1. TTL インデックス … 期限を過ぎたデータを MongoDB が自動で削除する（試合 / LP 履歴 / プレイヤー名）。
//      CacheEntry・RateStamp はもともと期限付き。日数は環境変数で変えられ、変えて再起動すれば既存のインデックスにも反映される。
//   2. 件数の上限（MAX_MATCHES）と、容量の上限（MAX_DB_MB）… 超えたら古い試合から削除する。
//      Atlas 無料枠（M0）は 512MB で、超えると書き込みが止まる。上限に達する前に自動で空ける。

const DAY_S = 86400;

// ---- TTL の定義（Match.gameDate は日数を後から変えられるよう、モデルではなくここで作る） ----
export function ttlSpecs(cfg = config) {
  return [
    { name: 'matches', model: Match, field: 'gameDate', days: cfg.matchTtlDays },
    { name: 'lp_snapshots', model: LpSnapshot, field: 'at', days: cfg.lpTtlDays },
    { name: 'player_names', model: PlayerName, field: 'seenAt', days: cfg.playerTtlDays }
  ];
}

// 既存のインデックスの一覧から、TTL インデックスに必要な操作を決める（純粋関数）
//   none … そのままでよい / create … 作る / collmod … 日数だけ変える / recreate … TTL でない同じキーのインデックスを作り直す / drop … 無期限にするので TTL を外す
export function planTtl(indexes, field, seconds) {
  const ex = (indexes || []).find((i) => i.key && Object.keys(i.key).length === 1 && i.key[field] === 1);
  const hasTtl = ex && ex.expireAfterSeconds !== undefined;
  if (!seconds || seconds <= 0) return hasTtl ? 'drop' : 'none';
  if (!ex) return 'create';
  if (!hasTtl) return 'recreate';
  return ex.expireAfterSeconds === seconds ? 'none' : 'collmod';
}

async function listIndexes(model) {
  try {
    return await model.collection.indexes();
  } catch (err) {
    if (err.codeName === 'NamespaceNotFound' || err.code === 26) return []; // まだコレクションが無い
    throw err;
  }
}

// 全モデルの TTL インデックスを、設定の日数に合わせて作成・更新する。失敗しても起動は止めない
export async function ensureTtlIndexes(specs = ttlSpecs()) {
  const results = [];
  for (const { name, model, field, days } of specs) {
    const seconds = Math.round((days || 0) * DAY_S);
    try {
      const indexes = await listIndexes(model);
      const action = planTtl(indexes, field, seconds);
      const ex = indexes.find((i) => i.key && Object.keys(i.key).length === 1 && i.key[field] === 1);
      if (action === 'create') {
        await model.collection.createIndex({ [field]: 1 }, { expireAfterSeconds: seconds });
      } else if (action === 'collmod') {
        try {
          await model.db.db.command({ collMod: model.collection.collectionName, index: { keyPattern: { [field]: 1 }, expireAfterSeconds: seconds } });
        } catch {
          // collMod が使えない環境（無料枠など）は、作り直す
          await model.collection.dropIndex(ex.name);
          await model.collection.createIndex({ [field]: 1 }, { expireAfterSeconds: seconds });
        }
      } else if (action === 'recreate') {
        await model.collection.dropIndex(ex.name);
        await model.collection.createIndex({ [field]: 1 }, { expireAfterSeconds: seconds });
      } else if (action === 'drop') {
        await model.collection.dropIndex(ex.name);
      }
      results.push({ name, field, days, action });
      if (action !== 'none') console.log(`[Storage] ${name}: TTL ${days > 0 ? days + '日' : '無期限'} に設定しました（${action}）`);
    } catch (err) {
      results.push({ name, field, days, action: 'error', error: err.message });
      console.warn(`[Storage] ${name} の TTL を設定できませんでした（続行します）: ${err.message}`);
    }
  }
  return results;
}

// ---- 容量の確認 ----
const MB = 1024 * 1024;

// 使用量。dataSize（圧縮前のデータ）+ indexSize。削除するとすぐ減るので、上限の判定に向いている
export async function getDbUsage() {
  const s = await mongoose.connection.db.command({ dbStats: 1, scale: 1 });
  const dataSize = s.dataSize || 0;
  const indexSize = s.indexSize || 0;
  return { dataSize, indexSize, storageSize: s.storageSize || 0, usedBytes: dataSize + indexSize, objects: s.objects || 0 };
}

// 上限を超えているとき、目標の割合まで下げるのに空けたいバイト数（超えていなければ 0）。純粋関数
export function bytesToFree(usedBytes, maxMb, targetPercent = 85) {
  if (!(maxMb > 0)) return 0;
  const limit = maxMb * MB;
  if (usedBytes <= limit) return 0;
  const target = limit * (Math.min(Math.max(targetPercent, 10), 99) / 100);
  return Math.ceil(usedBytes - target);
}

// 容量が上限を超えていたら、古い試合から削除して目標まで下げる。
// 1回の実行で消す量には上限があり（BATCH × MAX_BATCHES）、設定ミスでデータが全部消えるのを防ぐ。
// 事前集計（champ_agg_rows）は、試合を消しても減らさない（統計は残り、容量はほとんど使わない）
const BATCH = 200;
const MAX_BATCHES = 50;
let lastCheck = 0;

export async function enforceStorageLimit({ minIntervalMs = 0, maxMb = config.maxDbMb, targetPercent = config.dbTargetPercent } = {}) {
  if (!(maxMb > 0) || mongoose.connection.readyState !== 1) return { checked: false, deleted: 0 };
  if (minIntervalMs > 0 && Date.now() - lastCheck < minIntervalMs) return { checked: false, deleted: 0 };
  lastCheck = Date.now();

  let usage;
  try {
    usage = await getDbUsage();
  } catch (err) {
    console.warn(`[Storage] 容量を確認できませんでした: ${err.message}`);
    return { checked: false, deleted: 0 };
  }

  let need = bytesToFree(usage.usedBytes, maxMb, targetPercent);
  if (need === 0) return { checked: true, deleted: 0, usedMb: usage.usedBytes / MB };

  console.log(`[Storage] 使用量 ${(usage.usedBytes / MB).toFixed(1)}MB が上限 ${maxMb}MB を超えています。古い試合を削除します`);
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES && need > 0; i++) {
    const old = await Match.find().sort({ gameCreation: 1 }).limit(BATCH).select('_id').lean();
    if (old.length === 0) break;
    await Match.deleteMany({ _id: { $in: old.map((m) => m._id) } });
    deleted += old.length;
    try {
      need = bytesToFree((await getDbUsage()).usedBytes, maxMb, targetPercent);
    } catch {
      break;
    }
  }
  console.log(`[Storage] 古い試合を ${deleted} 件削除しました`);
  return { checked: true, deleted, usedMb: usage.usedBytes / MB };
}

// 件数の上限（MAX_MATCHES）を超えた分を、古い順に削除する
export async function enforceMatchLimit(maxMatches = config.maxMatches) {
  if (!(maxMatches > 0)) return 0;
  const over = (await Match.estimatedDocumentCount()) - maxMatches;
  if (over <= 0) return 0;
  const old = await Match.find().sort({ gameCreation: 1 }).limit(over).select('_id').lean();
  await Match.deleteMany({ _id: { $in: old.map((m) => m._id) } });
  console.log(`[Storage] 上限 ${maxMatches} 件を超えた古い試合を ${old.length} 件削除しました`);
  return old.length;
}

// クローラーなどから、保存のたびに呼ぶ（容量の確認は minIntervalMs ごとに1回だけ）
export async function enforceRetention({ storageIntervalMs = 60000 } = {}) {
  const byCount = await enforceMatchLimit();
  const byBytes = await enforceStorageLimit({ minIntervalMs: storageIntervalMs });
  return { byCount, byBytes: byBytes.deleted };
}

// /healthz や管理用スクリプトで見せる状態
export async function getStorageReport() {
  const [usage, matches, players, lp] = await Promise.all([
    getDbUsage(),
    Match.estimatedDocumentCount(),
    PlayerName.estimatedDocumentCount(),
    LpSnapshot.estimatedDocumentCount()
  ]);
  const mb = (b) => Math.round((b / MB) * 10) / 10;
  return {
    usedMb: mb(usage.usedBytes),
    dataMb: mb(usage.dataSize),
    indexMb: mb(usage.indexSize),
    limitMb: config.maxDbMb,
    percent: config.maxDbMb > 0 ? Math.round((usage.usedBytes / (config.maxDbMb * MB)) * 100) : null,
    counts: { matches, players, lpSnapshots: lp },
    retention: { matchTtlDays: config.matchTtlDays, maxMatches: config.maxMatches, lpTtlDays: config.lpTtlDays, playerTtlDays: config.playerTtlDays }
  };
}

// サーバー内で定期的に確認する（無料プランでサーバーが止まっている間は GitHub Actions の crawler / storage が担当）
export function startStorageLoop(intervalMin = config.storageCheckMin, isStopping = () => false) {
  if (!(intervalMin > 0)) return null;
  const run = () => {
    if (isStopping()) return;
    enforceRetention({ storageIntervalMs: 0 }).catch((err) => console.warn(`[Storage] 確認に失敗: ${err.message}`));
  };
  const timer = setInterval(run, intervalMin * 60 * 1000);
  timer.unref?.();
  setTimeout(run, 15000).unref?.();
  return timer;
}
