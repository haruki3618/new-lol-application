import mongoose from 'mongoose';

// お気に入り追跡。同じプレイヤーを別々の人（別の Webhook）が追跡できるよう、puuid + Webhook を一意にする。
const watchlistSchema = new mongoose.Schema({
  puuid: { type: String, required: true },
  summonerName: { type: String, required: true },
  tagLine: { type: String, required: true },
  discordWebhookUrl: { type: String, default: '' }, // v6.5.1: WEBHOOK_SECRET があれば暗号化して保存（services/webhookVault.js）
  webhookHash: { type: String }, // v6.5.1: Webhook の HMAC。重複チェック・解除の照合に使う（元の URL には戻せない）
  registeredBy: { type: String }, // v6.5.1: 登録した IP のハッシュ（乱用の調査用。生の IP は保存しない）
  region: { type: String, default: 'jp' }, // v6.4: ランクを確認するサーバー。無い登録（v6.3 まで）は jp 扱い
  initialized: { type: Boolean, default: false }, // false の間は基準を記録するだけで通知しない
  lastLp: { type: Number, default: 0 },
  lastTier: { type: String, default: 'UNRANKED' },
  lastRank: { type: String, default: '' },
  lastWins: { type: Number, default: 0 },
  lastLosses: { type: Number, default: 0 },
  consecutiveLosses: { type: Number, default: 0 },
  lastCheckedAt: Date,
  lockedUntil: Date // v6.6: 巡回中の印。サーバー内ループと GitHub Actions が同じ登録を同時に処理して二重通知するのを防ぐ
}, { timestamps: true });

// 暗号化すると同じ URL でも毎回違う文字列になるので、一意性は webhookHash で見る。
// 旧データ（webhookHash が無い）は起動時の移行で付く。それまで衝突しないよう、あるものだけを対象にする
watchlistSchema.index({ puuid: 1, webhookHash: 1 }, { unique: true, partialFilterExpression: { webhookHash: { $type: 'string' } } });

export default mongoose.models.Watchlist || mongoose.model('Watchlist', watchlistSchema);
