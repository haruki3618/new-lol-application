import mongoose from 'mongoose';

// persistentCache.js が読み書きする形に合わせる（_id が文字列のキー、v が値、expiresAt が期限）。
// 以前は key / value / expireAt の仮実装で、_id に文字列を入れると ObjectId への変換に失敗していた。
const cacheEntrySchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    v: mongoose.Schema.Types.Mixed,
    expiresAt: { type: Date, required: true }
  },
  { versionKey: false }
);

// 期限が過ぎたら MongoDB が自動で削除する
cacheEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.CacheEntry || mongoose.model('CacheEntry', cacheEntrySchema);
