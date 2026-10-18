import mongoose from 'mongoose';
import { config } from './config/index.js';
import { assertEnv } from './config/validate.js';
import { installProcessGuards } from './utils/processGuard.js';
import { logError } from './utils/logger.js';
import { checkApiKey } from './services/riotApi.js';
import { ensureAggregates } from './services/aggregate.js';
import { runCrawler } from './services/crawler.js';
import { startWatchLoop } from './services/watchRunner.js';
import { ensureTtlIndexes, startStorageLoop } from './services/storage.js';
import { ensurePlayerNames } from './services/playerNames.js';
import CacheEntry from './models/CacheEntry.js';
import Watchlist from './models/Watchlist.js';
import { migrateWatchlistWebhooks } from './services/webhookVault.js';
import RateStamp from './models/RateStamp.js';
import PlayerWeek from './models/PlayerWeek.js';
import app from './app.js';

let server;
let stopping = false;

async function start() {
  // v6.8.0: 設定の書き間違いは、DB に接続する前に分かる形で止める（落ちると Render はデプロイ失敗として通知し、古い版が動き続ける）
  assertEnv(process.env, config);

  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
    console.log('[DB] MongoDB に接続しました');
  } catch (err) {
    logError('DB', err, null, { 接続先: '(MONGODB_URI)' });
    console.error('    MongoDB を起動してから、もう一度実行してください。');
    process.exit(1);
  }

  // 旧バージョンの仮モデルが作った不要なインデックス（key の一意制約など）を取り除く。
  // この2つは期限付きの一時データだけを持つので、同期しても失うものはない
  await Promise.all([CacheEntry.syncIndexes(), RateStamp.syncIndexes()]).catch((err) =>
    console.warn(`[DB] インデックスの同期に失敗しました（続行します）: ${err.message}`)
  );

  // v6.5.1: 追跡の Webhook を新しい形式へ（ハッシュ付け・WEBHOOK_SECRET があれば暗号化）してから、インデックスを揃える
  try {
    const n = await migrateWatchlistWebhooks(Watchlist);
    if (n) console.log(`[Watch] Webhook の保存形式を更新しました（${n} 件）`);
    await Watchlist.syncIndexes();
  } catch (err) {
    console.warn(`[Watch] 追跡の移行に失敗しました（続行します）: ${err.message}`);
  }
  if (!config.webhookSecret) console.warn('[Watch] WEBHOOK_SECRET が未設定です。Webhook URL は暗号化されず保存されます');

  // v6.11.0: 週ごとのサマリーの一意・期限のインデックスを作る
  await PlayerWeek.syncIndexes().catch((err) => console.warn(`[DB] PlayerWeek のインデックスの同期に失敗しました（続行します）: ${err.message}`));

  // 容量の管理: 期限（TTL）のインデックスを設定の日数に合わせる
  await ensureTtlIndexes();

  server = app.listen(config.port, () => console.log(`Server running on http://localhost:${config.port}`));

  checkApiKey().then((state) => {
    if (state === 'invalid') console.warn('[RiotAPI] APIキーが無効か期限切れです。.env を書き換えて保存すれば、再起動なしで復旧します。');
  });
  ensureAggregates();
  ensurePlayerNames();
  startStorageLoop(config.storageCheckMin, () => stopping);
  startWatchLoop(config.watchIntervalMin, () => stopping);

  if (config.crawlerInServer) {
    console.log('[Crawler] サーバー内でクローラーを起動します');
    runCrawler(() => stopping).catch((err) => logError('Crawler', err));
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[Server] ${signal} を受け取りました。終了処理中…`);
  setTimeout(() => process.exit(0), 5000).unref();
  server?.close();
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}
// v6.6: バックグラウンド処理（集計・名前作成・追跡ループなど）の想定外の例外でプロセスごと落ちないよう、ログを出して続行する。
// 同期的な例外（uncaughtException）はプロセスの状態が壊れている可能性があるので、記録のうえ続行する。繰り返し起きるなら再起動で復旧する
// v6.8.0: ログに場所（スタック）を残す。uncaughtException が 1 分に 5 回起きたら、壊れたまま動かさず終了して再起動に任せる
installProcessGuards('Server');
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
