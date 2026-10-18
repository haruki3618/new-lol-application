import 'dotenv/config';
import fs from 'node:fs';
import { readRegion } from '../constants/regions.js';

// package.json の version。静的ファイルの URL に付けて、更新後に古い JS / CSS がブラウザに残らないようにする
function readAppVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '';
  } catch {
    return '';
  }
}

// .env の正式な変数名は RIOT_API_KEY / MONGODB_URI です。
// 旧バージョンで使っていた別名も読めますが、使うと警告します。
// STRICT_ENV=1 にすると別名を一切読みません（.env が確定したらこの設定を推奨）。
const strict = process.env.STRICT_ENV === '1';
const warned = new Set();

const env = (primary, ...aliases) => {
  if (process.env[primary]) return process.env[primary];
  if (strict) return undefined;
  for (const n of aliases) {
    if (process.env[n]) {
      if (!warned.has(n)) {
        warned.add(n);
        console.warn(`[Config] 旧名の ${n} を使っています。.env の名前を ${primary} に変更してください（STRICT_ENV=1 で別名を無効化できます）`);
      }
      return process.env[n];
    }
  }
  return undefined;
};
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

// リバースプロキシの背後で動かすときだけ設定（例: TRUST_PROXY=1）。IP制限が正しく働くために必要
function parseTrustProxy(v) {
  if (v === undefined || v === '' || v === '0' || v === 'false') return false;
  if (v === 'true') return true;
  if (Number.isInteger(Number(v))) return Number(v);
  return v;
}

export const KEY_ENV_NAMES = ['RIOT_API_KEY', ...(strict ? [] : ['RIOT_KEY', 'API_KEY'])];

export const config = {
  appVersion: readAppVersion(),
  port: num(env('PORT'), 3000),
  // サイト全体を ID / パスワードで守る（公開の許可が下りるまで使う。SITE_PASSWORD が空なら無効）
  siteUser: process.env.SITE_USER || 'admin',
  sitePassword: process.env.SITE_PASSWORD || '',
  // 既定のリージョン（検索・統計で指定が無いときに使う）と、クローラーが試合を集めるリージョン
  defaultRegion: readRegion(process.env.DEFAULT_REGION, 'jp'),
  crawlerRegion: readRegion(process.env.CRAWLER_REGION || process.env.DEFAULT_REGION, 'jp'),
  riotApiKey: env('RIOT_API_KEY', 'RIOT_KEY', 'API_KEY'),
  keyEnvNames: KEY_ENV_NAMES,
  mongoUriSet: Boolean(env('MONGODB_URI', 'MONGO_URI', 'MONGODB_URL', 'MONGO_URL', 'DATABASE_URL')), // v6.8.0: 起動時チェック用（未設定だと localhost になるため）
  mongoUri: env('MONGODB_URI', 'MONGO_URI', 'MONGODB_URL', 'MONGO_URL', 'DATABASE_URL') || 'mongodb://127.0.0.1:27017/lol-analytics',

  // 開発キーの初期値（1秒20回 / 2分100回）。実行中は Riot の X-App-Rate-Limit ヘッダーから自動で学習します
  rate1s: num(env('RATE_LIMIT_1S', 'RATE_1S'), 20),
  rate120s: num(env('RATE_LIMIT_120S', 'RATE_120S'), 100),
  rateHighRatio: num(process.env.RATE_HIGH_RATIO, 0.85), // ユーザー操作が使える割合（v6.5.1: 0.95 → 0.85。残りは追跡・クローラー用の余裕）
  rateLowRatio: num(process.env.RATE_LOW_RATIO, 0.7), // クローラーが使える割合
  rateWaitMs: num(process.env.RATE_WAIT_MS, 20000), // ユーザー操作が待てる最大時間（超えたら「混雑」で返す）
  rateShared: process.env.RATE_SHARED !== '0', // MongoDB でプロセス間の使用回数を共有する

  // ---- データ容量の管理（v6.5） ----
  // 試合データの保持日数（0 で無期限）。MongoDB の TTL インデックスが期限を過ぎた試合を自動で削除する
  matchTtlDays: num(env('MATCH_TTL_DAYS'), 30),
  // 保存する試合の件数の上限（0 で無制限）。超えたら古い順に削除（クローラーが確認）
  maxMatches: num(env('MAX_MATCHES'), 20000),
  // LP 履歴・プレイヤー名の候補の保持日数（0 で無期限）
  lpTtlDays: num(env('LP_TTL_DAYS'), 90),
  playerTtlDays: num(env('PLAYER_TTL_DAYS'), 60),
  // v6.11.0: 週ごとのサマリー（試合より長く残す長期の推移）の保持日数（0 で無期限）
  playerWeekTtlDays: num(env('PLAYER_WEEK_TTL_DAYS'), 365),
  // データベース全体の容量の上限（MB。0 で無効）。Atlas 無料枠（M0）は 512MB なので、余裕を持たせた値にする
  maxDbMb: num(env('MAX_DB_MB'), 400),
  // 上限を超えたら、この割合（%）まで古い試合から削除する
  dbTargetPercent: num(env('DB_TARGET_PERCENT'), 85),
  // 容量を確認する間隔（分。サーバー内。0 で確認しない）
  storageCheckMin: num(env('STORAGE_CHECK_MIN'), 30),

  // クローラー
  crawlerQueue: num(env('CRAWLER_QUEUE'), 420),
  crawlerMatchesPerPlayer: num(env('CRAWLER_MATCHES_PER_PLAYER'), 20),
  // クローラーを自動で止めるまでの分数（0 で無制限）。GitHub Actions など、実行時間に上限がある場所で使う
  crawlerMaxMinutes: num(env('CRAWLER_MAX_MINUTES'), 0),
  crawlerInServer: process.argv.includes('--with-crawler') || process.env.CRAWLER_IN_SERVER === '1',

  // お気に入り追跡（Discord通知）の確認間隔（分）。0 で無効
  watchIntervalMin: num(env('WATCH_INTERVAL_MIN'), 10),
  // v6.5.1: お気に入り追跡の保護
  // 登録キー: 設定すると、追加するときにこのキーの入力が必要になる（公開サイトでの枠の独占・荒らし対策。空なら不要）
  watchRegisterKey: process.env.WATCH_REGISTER_KEY || '',
  // 1 にすると、追跡中のプレイヤー名を誰にでも一覧表示する（既定は件数だけ）
  watchPublicList: process.env.WATCH_PUBLIC_LIST === '1',
  // IP ごとの登録 / 解除の上限（1時間あたり）
  watchAddPerHour: num(env('WATCH_ADD_PER_HOUR'), 5),
  watchRemovePerHour: num(env('WATCH_REMOVE_PER_HOUR'), 10),
  // v6.6: 「過去の試合を読み込む」の IP ごとの 1 日あたりの上限（1回で最大300件の API を使うため）
  historyPerDay: num(env('HISTORY_PER_DAY'), 10),
  // v6.6: 同期の開始（API を使う）と、進捗の確認（軽い・1秒ごと）で別々に制限する（1分あたり・IPごと）
  syncStartPerMin: num(env('SYNC_START_PER_MIN'), 30),
  // Webhook URL を暗号化して保存するための秘密の文字列（長いランダム文字列。変えると既存の登録を復号できなくなる）
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  // 自サイトへのアクセス制限（1分あたり・IPごとの基準値に掛ける倍率）
  webRateScale: num(process.env.WEB_RATE_SCALE, 1),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY)
};

if (!config.riotApiKey) {
  console.warn('[Config] RIOT_API_KEY が設定されていません。.env を確認してください。');
}
