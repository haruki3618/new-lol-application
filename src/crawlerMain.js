import mongoose from 'mongoose';
import { config } from './config/index.js';
import { assertEnv } from './config/validate.js';
import { installProcessGuards } from './utils/processGuard.js';
import { logError } from './utils/logger.js';
import { runCrawler } from './services/crawler.js';
import { ensureTtlIndexes } from './services/storage.js';

installProcessGuards('Crawler');
// v6.8.0: クローラーはキーが無いと何もできないので、どこで動かしても必須（Actions では Secrets の登録漏れがここで赤くなる）
assertEnv(process.env, config, { needKey: true });

let stopping = false;
const stop = () => {
  console.log('\n[Crawler] 停止処理中…');
  stopping = true;
  setTimeout(() => process.exit(0), 5000).unref(); // 通信中で止まらないときの保険
};
// CRAWLER_MAX_MINUTES を決めておくと、その時間で自動的に止まる（GitHub Actions の定期実行用）
if (config.crawlerMaxMinutes > 0) {
  setTimeout(() => {
    console.log(`[Crawler] 指定の ${config.crawlerMaxMinutes} 分に達したので止めます`);
    stop();
  }, config.crawlerMaxMinutes * 60 * 1000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

try {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  console.log('[DB] MongoDB に接続しました');
  await ensureTtlIndexes();
  await runCrawler(() => stopping);
} catch (err) {
  logError('Crawler', err);
} finally {
  await mongoose.disconnect();
  process.exit(0);
}
