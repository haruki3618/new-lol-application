import Watchlist from '../models/Watchlist.js';
import { getLeagueEntriesByPUUID } from './riotApi.js';
import { recordLp } from './lpHistory.js';
import { sendDiscordNotification } from './notify.js';
import { evaluateWatch, formatMessage } from './watchMath.js';
import { mapLimit } from '../utils/async.js';
import { config } from '../config/index.js';
import { revealWebhook } from './webhookVault.js';

export const MAX_WATCHES = 30;
export const WATCH_LOCK_MS = 5 * 60 * 1000; // 巡回中の印の有効時間（異常終了しても、これを過ぎれば次の巡回で拾う）

// v6.6: 1件ずつ「確認中」の印を条件付き更新で取る。すでに別の巡回が取っていれば null（飛ばす）。
// 取れたときは最新の状態の文書を返すので、古い状態で判定して二重に通知することがない。
// Mongoose の文書でないもの（テストの偽データなど）には何もしない
async function claimWatch(w) {
  if (!(w instanceof Watchlist) || !w._id) return w;
  const now = new Date();
  return Watchlist.findOneAndUpdate(
    { _id: w._id, $or: [{ lockedUntil: null }, { lockedUntil: { $exists: false } }, { lockedUntil: { $lt: now } }] },
    { $set: { lockedUntil: new Date(now.getTime() + WATCH_LOCK_MS) } },
    { new: true }
  );
} // Riot API のレート制限を守るための登録数の上限

// 依存を差し替えられるようにしてある（テストでは DB・API を使わない）
const defaults = {
  list: () => Watchlist.find({}).limit(MAX_WATCHES * 4),
  fetchEntries: (puuid, region) => getLeagueEntriesByPUUID(puuid, { priority: 'low', region }),
  notify: sendDiscordNotification,
  recordLp,
  claim: claimWatch
};

// 1周分: 全員のランク情報を取って判定し、状態を保存して、出来事があれば通知する
export async function runWatchCycle(deps = {}) {
  const d = { ...defaults, ...deps };
  const rows = await d.list();
  const summary = { checked: 0, notified: 0, failed: 0, skipped: 0 };

  // 同じプレイヤーを複数人が追跡していても、API は1回だけ呼ぶ
  const entryByPuuid = new Map();
  const fetchOnce = (puuid, region) => {
    const key = `${region}:${puuid}`;
    if (!entryByPuuid.has(key)) entryByPuuid.set(key, d.fetchEntries(puuid, region));
    return entryByPuuid.get(key);
  };

  await mapLimit(rows, 2, async (row) => {
    let w = row;
    try {
      w = await d.claim(row);
      if (!w) { summary.skipped += 1; return; } // 別の巡回が処理中
      const entries = await fetchOnce(w.puuid, w.region || config.defaultRegion);
      const solo = (entries || []).find((e) => e.queueType === 'RANKED_SOLO_5x5') || null;
      await d.recordLp?.(w.puuid, entries || []).catch(() => {});

      const { events, next } = evaluateWatch(w, solo);
      Object.assign(w, next, { lastCheckedAt: new Date(), lockedUntil: null });
      await w.save();
      summary.checked += 1;

      // 保存に成功してから通知する（保存に失敗して同じ通知を繰り返すのを避ける）
      if (events.length > 0) {
        await d.notify(revealWebhook(w.discordWebhookUrl), formatMessage(`${w.summonerName}#${w.tagLine}`, events, solo));
        summary.notified += 1;
      }
    } catch (err) {
      summary.failed += 1;
      console.warn(`[Watch] ${w.summonerName}#${w.tagLine} の確認に失敗: ${err.message}`);
      // 失敗したら印を外し、次の巡回で再開できるようにする（保存に失敗した場合は期限切れを待つ）
      if (w instanceof Watchlist && w._id) Watchlist.updateOne({ _id: w._id }, { $set: { lockedUntil: null } }).catch(() => {});
    }
  });
  return summary;
}

// サーバー起動時に呼ぶ。minutes が 0 以下なら何もしない。戻り値で停止できる
export function startWatchLoop(minutes, isStopping = () => false) {
  if (!(minutes > 0)) return () => {};
  const run = async () => {
    if (isStopping()) return;
    try {
      const s = await runWatchCycle();
      if (s.checked || s.failed) console.log(`[Watch] 確認 ${s.checked} 件 / 通知 ${s.notified} 件 / 失敗 ${s.failed} 件`);
    } catch (err) {
      console.warn(`[Watch] 巡回に失敗: ${err.message}`);
    }
  };
  const timer = setInterval(run, minutes * 60 * 1000);
  timer.unref();
  setTimeout(run, 15000).unref(); // 起動直後は集計などと重ならないよう少し待つ
  return () => clearInterval(timer);
}
