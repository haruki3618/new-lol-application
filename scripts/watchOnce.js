import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { runWatchCycle } from '../src/services/watchRunner.js';
import { assertEnv } from '../src/config/validate.js';
import { logError } from '../src/utils/logger.js';

assertEnv(process.env, config, { needKey: true, needMongoUri: true }); // v6.8.0: Secrets の登録漏れ・貼り間違いを、接続の前に止める

// お気に入り追跡を1周だけ確認して終わる（GitHub Actions の定期実行用）。
// 無料のホスティングはアクセスが無いと止まるので、サーバー内の巡回（WATCH_INTERVAL_MIN）の代わりに使う
await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
try {
  const s = await runWatchCycle();
  console.log(`[Watch] 確認 ${s.checked} 件 / 通知 ${s.notified} 件 / 失敗 ${s.failed} 件`);
} catch (err) {
  logError('Watch', err);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
