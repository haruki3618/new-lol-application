// 型定義（JSDoc）。実行時には何もしない（import されても空のモジュール）。
// エディタ（VS Code など）がここの @typedef を読んで、計算ロジックの引数・戻り値の補完とチェックを出す。
// 依存パッケージは増やしていない。厳密にチェックしたい場合は、ファイルの先頭に // @ts-check を足す。
//
// 形は src/models/*.js のスキーマ、services/*Math.js の戻り値に合わせてある。変更したらここも直す。

/**
 * 保存済みの試合の参加者（models/Match.js の participantSchema）。旧データでは一部の項目が無い
 * @typedef {Object} Participant
 * @property {string} puuid
 * @property {string} [riotIdGameName]
 * @property {string} [riotIdTagline]
 * @property {number} teamId 100 / 200
 * @property {string} [teamPosition] TOP / JUNGLE / MIDDLE / BOTTOM / UTILITY（無いモードでは空）
 * @property {string} championName
 * @property {number} [champLevel]
 * @property {number} kills
 * @property {number} deaths
 * @property {number} assists
 * @property {boolean} win
 * @property {number} [totalMinionsKilled]
 * @property {number} [neutralMinionsKilled]
 * @property {number} [visionScore]
 * @property {number} [goldEarned]
 * @property {number} [totalDamageDealtToChampions]
 * @property {number} [totalDamageTaken]
 * @property {number} [summoner1Id]
 * @property {number} [summoner2Id]
 * @property {number} [keystone]
 * @property {number} [subStyle]
 * @property {number} [primaryStyle]
 * @property {number[]} [runes] [メイン4つ（先頭がキーストーン）, サブ2つ, シャード3つ]。版3以降
 * @property {number} [item0]
 * @property {number} [item1]
 * @property {number} [item2]
 * @property {number} [item3]
 * @property {number} [item4]
 * @property {number} [item5]
 * @property {number} [item6]
 */

/**
 * チームごとのバン・オブジェクト（models/Match.js の teamSchema）
 * @typedef {Object} TeamStat
 * @property {number} teamId
 * @property {boolean} win
 * @property {number[]} [bans] チャンピオンの数値ID
 * @property {number} [kills]
 * @property {number} [dragons]
 * @property {number} [barons]
 * @property {number} [heralds]
 * @property {number} [grubs]
 * @property {number} [towers]
 * @property {number} [inhibitors]
 * @property {boolean} [firstBlood]
 * @property {boolean} [firstTower]
 */

/**
 * 保存済みの試合（models/Match.js。.lean() で読んだ形）
 * @typedef {Object} MatchDoc
 * @property {string} matchId 例: JP1_123456789（先頭でリージョンが分かる）
 * @property {number} gameCreation 開始時刻（ミリ秒）
 * @property {Date} [gameDate]
 * @property {number} [gameDuration] 秒
 * @property {number} [queueId]
 * @property {string} [gameVersion] 例: 14.10.123.4567
 * @property {string} [band] 試合を見つけた起点プレイヤーの帯
 * @property {number} [v] 保存形式の版
 * @property {string[]} [participantPuuids]
 * @property {TeamStat[]} [teams]
 * @property {Participant[]} participants
 */

/**
 * Riot のリーグ情報 1 件（league-v4 / RANKED_SOLO_5x5 など）
 * @typedef {Object} LeagueEntry
 * @property {string} queueType
 * @property {string} tier IRON … CHALLENGER
 * @property {string} rank I〜IV（マスター以上は I）
 * @property {number} leaguePoints
 * @property {number} wins
 * @property {number} losses
 */

/**
 * LP のスナップショット（models/LpSnapshot.js を画面用に変換したもの）
 * @typedef {Object} LpPoint
 * @property {number} at ミリ秒
 * @property {number} value ティア・ディビジョンを含めた絶対 LP
 */

/**
 * 事前集計の 1 行（models/ChampAgg.js）。_id は aggKey の文字列
 * @typedef {Object} AggDims
 * @property {string} region
 * @property {number} q 試合の種類（queueId）
 * @property {string} patch 例: 14.10
 * @property {string} band
 * @property {string} role ALL / TOP / … / BAN / TOTAL
 * @property {string} champ チャンピオン名（BAN のときは数値 ID、TOTAL のときは '-'）
 */

/**
 * 診断（insightsMath）に渡す 1 試合
 * @typedef {Object} InsightGame
 * @property {number} t 開始時刻（ミリ秒）
 * @property {number} [dur] 秒
 * @property {boolean} win
 * @property {string} [champ]
 * @property {string} [role]
 */

/**
 * お気に入り追跡の前回の状態（models/Watchlist.js の一部）
 * @typedef {Object} WatchState
 * @property {string} [lastTier]
 * @property {string} [lastRank]
 * @property {number} [lastLp]
 * @property {number} [lastWins]
 * @property {number} [lastLosses]
 * @property {number} [consecutiveLosses]
 * @property {boolean} [initialized] false の間は基準を記録するだけで通知しない
 */

/**
 * 画面・通知に出す出来事
 * @typedef {Object} WatchEvent
 * @property {'LOSS_STREAK' | 'PROMOTED' | 'DEMOTED' | 'LP_SWING'} type
 * @property {string} text
 * @property {number} [streak] LOSS_STREAK のとき
 * @property {number} [diff] LP_SWING のとき
 */

// ---- Riot API の応答（riotApi.js の戻り値）。使っている項目だけを書いた部分的な型。Riot が項目を足しても壊れない ----

/**
 * Riot API を呼ぶときの共通の指定
 * @typedef {Object} RiotApiOptions
 * @property {string} [region] jp / kr / na … 省略時は DEFAULT_REGION
 * @property {'high' | 'low'} [priority] 'low' はクローラー・履歴・追跡の呼び出し（ユーザー操作に枠を残す）。省略時は 'high'
 */

/**
 * account-v1
 * @typedef {Object} RiotAccount
 * @property {string} puuid
 * @property {string} [gameName]
 * @property {string} [tagLine]
 */

/**
 * summoner-v4
 * @typedef {Object} RiotSummoner
 * @property {string} [puuid]
 * @property {number} profileIconId
 * @property {number} summonerLevel
 * @property {number} [revisionDate]
 */

/**
 * champion-mastery-v4（1 チャンピオン分）
 * @typedef {Object} RiotMastery
 * @property {number} championId 数値 ID（Data Dragon の key）
 * @property {number} championLevel
 * @property {number} championPoints
 * @property {number} [lastPlayTime]
 */

/**
 * league-v4 の apex リーグ（challenger / grandmaster / master）
 * @typedef {Object} RiotLeagueList
 * @property {string} tier
 * @property {string} [queue]
 * @property {{puuid?: string, summonerId?: string, leaguePoints: number, wins: number, losses: number}[]} entries
 */

/**
 * match-v5（保存・表示に使う項目だけ）
 * @typedef {Object} RiotMatchDto
 * @property {{matchId: string, participants: string[]}} metadata
 * @property {{gameCreation: number, gameDuration: number, gameVersion: string, queueId: number, participants: object[], teams: object[]}} info
 */

export {};
