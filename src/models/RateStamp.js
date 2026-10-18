import mongoose from 'mongoose';

// rateStore.js が使う API 呼び出しの記録（t は呼び出し時刻のミリ秒、expireAt を過ぎたら自動削除）。
// 以前は key が必須の仮実装で、t が保存されず、プロセス間の使用回数の共有ができなかった。
const rateStampSchema = new mongoose.Schema(
  {
    t: { type: Number, required: true, index: true },
    expireAt: { type: Date, required: true }
  },
  { versionKey: false }
);

rateStampSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.RateStamp || mongoose.model('RateStamp', rateStampSchema);
