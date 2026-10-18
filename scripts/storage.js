import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { ensureTtlIndexes, enforceRetention, getStorageReport } from '../src/services/storage.js';

// データベースの容量の確認と整理（GitHub Actions の定期実行や、手元での確認用）
//   npm run storage          … 使用量と保持設定を表示するだけ
//   npm run storage -- --apply … TTL インデックスを設定の日数に合わせ、件数・容量の上限を超えていれば古い試合を削除する
const apply = process.argv.includes('--apply');

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
try {
  if (apply) {
    await ensureTtlIndexes();
    const r = await enforceRetention({ storageIntervalMs: 0 });
    console.log(`[Storage] 削除: 件数上限 ${r.byCount} 件 / 容量上限 ${r.byBytes} 件`);
  }
  console.log(JSON.stringify(await getStorageReport(), null, 2));
} catch (err) {
  console.error(`[Storage] 失敗: ${err.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
