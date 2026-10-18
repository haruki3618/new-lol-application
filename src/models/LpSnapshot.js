import mongoose from 'mongoose';

// lpHistory.js（recordLp / getLpHistory）が読み書きする項目に合わせたスキーマ。
// 以前は tier / rank / leaguePoints / timestamp だけの仮実装で、queueType・lp・wins・losses・at が
// strict モードで捨てられ、LP 履歴が保存されていなかった。
const lpSnapshotSchema = new mongoose.Schema({
  puuid: { type: String, required: true },
  queueType: { type: String, default: 'RANKED_SOLO_5x5' },
  tier: String,
  rank: String,
  lp: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  at: { type: Date, default: Date.now }
});

lpSnapshotSchema.index({ puuid: 1, queueType: 1, at: -1 });
// at の TTL インデックスは services/storage.js の ensureTtlIndexes() が作成する

export default mongoose.models.LpSnapshot || mongoose.model('LpSnapshot', lpSnapshotSchema);
