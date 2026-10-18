import mongoose from 'mongoose';

// 検索ボックスの予測（オートコンプリート）用に、これまでに見かけたプレイヤー名を覚えておく。
// Riot API には名前の前方一致検索が無いので、保存済みの試合の参加者・検索したプレイヤーから自前で作る。
// n は検索用に正規化した「ゲーム名」（NFKC・小文字）。seenAt の TTL インデックスで古い名前は自動で消える
const playerNameSchema = new mongoose.Schema(
  {
    puuid: { type: String, required: true },
    region: { type: String, required: true },
    gameName: { type: String, required: true },
    tagLine: { type: String, required: true },
    n: { type: String, required: true },
    t: { type: String, required: true }, // タグの小文字
    hits: { type: Number, default: 0 }, // 検索された回数（人気順の並べ替えに使う）
    seenAt: { type: Date, default: Date.now }
  },
  { versionKey: false, collection: 'player_names' }
);

playerNameSchema.index({ puuid: 1, region: 1 }, { unique: true });
playerNameSchema.index({ region: 1, n: 1 });
// seenAt の TTL インデックスは services/storage.js の ensureTtlIndexes() が作成する

export default mongoose.models.PlayerName || mongoose.model('PlayerName', playerNameSchema);
