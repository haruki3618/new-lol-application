import mongoose from 'mongoose';

// v6.11.0: プレイヤーの「週 × キュー」ごとの合計。試合（既定 30 日で削除）より長く残し、長期の推移を出すために使う。
// 1 件あたり約 0.3KB。1 人が 1 年・主に 1〜2 キューで 100 件ほど。
const playerWeekSchema = new mongoose.Schema(
  {
    puuid: { type: String, required: true },
    weekStart: { type: Number, required: true }, // 日本時間の月曜 0:00（UTC ミリ秒）
    queueId: { type: Number, default: 0 },
    games: Number,
    wins: Number,
    kills: Number,
    deaths: Number,
    assists: Number,
    cs: Number,
    vision: Number,
    damage: Number,
    gold: Number,
    durationSec: Number,
    champs: [{ _id: false, name: String, games: Number, wins: Number }],
    expireAt: Date // PLAYER_WEEK_TTL_DAYS が 0 でなければ、この日時に MongoDB が自動で削除する
  },
  { timestamps: false }
);

playerWeekSchema.index({ puuid: 1, weekStart: -1, queueId: 1 }, { unique: true });
playerWeekSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.PlayerWeek || mongoose.model('PlayerWeek', playerWeekSchema);
