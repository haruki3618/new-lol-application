import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import Match from '../src/models/Match.js';

// 保存済みの試合データだけを削除する（LP推移の記録は残す）
await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
try {
  await Match.collection.drop();
  console.log('試合データを削除しました');
} catch (err) {
  console.log(err.codeName === 'NamespaceNotFound' ? '削除する試合データはありませんでした' : `失敗: ${err.message}`);
}
await Match.syncIndexes();
await mongoose.disconnect();
