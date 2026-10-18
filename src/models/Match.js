import mongoose from 'mongoose';

// 保存するのは集計・表示に必要な項目だけ（容量を大きく節約できる）
const participantSchema = new mongoose.Schema(
  {
    puuid: String,
    riotIdGameName: String,
    riotIdTagline: String,
    teamId: Number,
    teamPosition: String,
    championName: String,
    champLevel: Number,
    kills: Number,
    deaths: Number,
    assists: Number,
    win: Boolean,
    totalMinionsKilled: Number,
    neutralMinionsKilled: Number,
    visionScore: Number,
    goldEarned: Number,
    totalDamageDealtToChampions: Number,
    totalDamageTaken: Number,
    summoner1Id: Number,
    summoner2Id: Number,
    keystone: Number, // メインルーン（キーストーン）のID
    subStyle: Number, // サブルーン系統のID
    primaryStyle: Number, // v6.4: メインルーン系統のID
    runes: [Number], // v6.4（版3）: [メイン4つ（先頭がキーストーン）, サブ2つ, シャード3つ]。旧データには無い
    item0: Number,
    item1: Number,
    item2: Number,
    item3: Number,
    item4: Number,
    item5: Number,
    item6: Number
  },
  { _id: false }
);

// v5.2: チームごとのバン・オブジェクト・キル数
const teamSchema = new mongoose.Schema(
  {
    teamId: Number,
    win: Boolean,
    bans: [Number], // チャンピオンの数値ID
    kills: Number,
    dragons: Number,
    barons: Number,
    heralds: Number,
    grubs: Number,
    towers: Number,
    inhibitors: Number,
    firstBlood: Boolean,
    firstTower: Boolean
  },
  { _id: false }
);

const matchSchema = new mongoose.Schema(
  {
    matchId: { type: String, required: true, unique: true },
    gameCreation: { type: Number, required: true },
    gameDate: { type: Date, required: true }, // TTL用の日付型
    gameDuration: Number,
    queueId: Number,
    gameVersion: String,
    band: String, // v5.2: 試合を見つけた起点プレイヤーの帯（MASTER_PLUS / DIAMOND / ...）。無ければ UNKNOWN 扱い
    v: Number, // 保存形式の版（2 = teams・band あり / 3 = runes あり。無い試合は v5.1 までのデータ）
    participantPuuids: [String], // 検索用（metadata.participants 相当）
    teams: [teamSchema],
    participants: [participantSchema]
  },
  { timestamps: false }
);

// プレイヤー検索・キュー絞り込み・新しい順の取得を1つのインデックスで賄う
matchSchema.index({ participantPuuids: 1, queueId: 1, gameCreation: -1 });
// 古いデータの削除（FIFOパージ）用
matchSchema.index({ gameCreation: 1 });
// v6.7.0: チャンピオン別ページ（championBuild.js: championName で絞って新しい順に読む）用。
//   これが無いと、試合数が少ないチャンピオンは保存済みの全試合を読んでから結果が出る。
//   参加者ごとに1エントリ（1試合あたり10件）増えるので、容量は試合数 × 約 0.4KB 程度（2万試合で約 8MB）
matchSchema.index({ 'participants.championName': 1, gameCreation: -1 });
// v6.7.0: パッチ一覧（championStats.js の getPatches: gameVersion の distinct）が全件を読まずに済む
matchSchema.index({ gameVersion: 1 });

// gameDate の TTL インデックス（期限切れの試合を MongoDB が自動で削除する）は、
// 日数を後から変えても反映できるよう、services/storage.js の ensureTtlIndexes() が起動時に作成・更新する

export const PARTICIPANT_FIELDS = Object.keys(participantSchema.paths);

export default mongoose.model('Match', matchSchema);