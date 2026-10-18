import { isRegion } from '../constants/regions.js';

// 起動時の環境変数チェック（v6.8.0）。
// 設定の書き間違い（Render の画面に貼ったときの引用符・空白、数字のつもりの文字、地域の綴り違い）を、
// 起動した後に「DB に接続できない」「全部 jp になっている」といった形で気づくのではなく、起動前に分かる形で止める。
//   errors   … このまま動かすと確実に困るもの。assertEnv は一覧を出して終了コード 1 で落ちる
//              （Render ではデプロイ失敗 = 通知が届く。GitHub Actions では赤くなる。古い版が動き続ける）
//   warnings … 動くが直したほうがよいもの。表示して続行する
// 依存パッケージなし。config/index.js を読み込まない（純粋な関数なので、そのままテストできる）。

// 数値として読む設定名と、許す範囲 [min, max]（max 省略可）
export const NUMERIC_VARS = {
  PORT: [0, 65535],
  RATE_LIMIT_1S: [1],
  RATE_LIMIT_120S: [1],
  RATE_HIGH_RATIO: [0, 1],
  RATE_LOW_RATIO: [0, 1],
  MATCH_TTL_DAYS: [0],
  MAX_MATCHES: [0],
  LP_TTL_DAYS: [0],
  PLAYER_TTL_DAYS: [0],
  PLAYER_WEEK_TTL_DAYS: [0],
  MAX_DB_MB: [0],
  DB_TARGET_PERCENT: [1, 100],
  STORAGE_CHECK_MIN: [0],
  CRAWLER_QUEUE: [0],
  CRAWLER_MATCHES_PER_PLAYER: [1],
  CRAWLER_SEEDS_PER_BAND: [1],
  CRAWLER_MAX_MINUTES: [0],
  TIER_MIN_GAMES: [0],
  BASELINE_MIN_CHAMP: [0],
  BASELINE_MIN_ROLE: [0],
  WATCH_INTERVAL_MIN: [0],
  WATCH_ADD_PER_HOUR: [0],
  WATCH_REMOVE_PER_HOUR: [0],
  HISTORY_PER_DAY: [0],
  SYNC_START_PER_MIN: [0],
  WEB_RATE_SCALE: [0]
};

const hasEdgeJunk = (v) => /^[\s"'`]|[\s"'`]$/.test(v);

// env: process.env / cfg: config（riotApiKey, mongoUri, mongoUriSet）
export function validateEnv(env, cfg, { production = false, needKey = production, needMongoUri = production } = {}) {
  const errors = [];
  const warnings = [];
  const set = (k) => env[k] !== undefined && env[k] !== '';

  // --- Riot API キー ---
  const key = cfg.riotApiKey || '';
  if (!key) {
    const alias = ['RIOT_KEY', 'API_KEY'].find((n) => env[n]);
    const hint = alias ? `（${alias} が設定されています。名前を RIOT_API_KEY に直してください。STRICT_ENV=1 のときは別名を読みません）` : '';
    const msg = `RIOT_API_KEY が未設定です。Riot Developer Portal で発行したキーを設定してください${hint}`;
    if (needKey) errors.push(msg);
    else warnings.push(`${msg}。保存済みのデータは見られますが、新しい試合は取得できません`);
  } else {
    if (hasEdgeJunk(key)) errors.push('RIOT_API_KEY の前後に空白や引用符が含まれています。貼り付けたときに紛れ込んでいないか確認してください（Render の Environment には引用符を付けずに貼ります）');
    else if (!key.startsWith('RGAPI-')) warnings.push('RIOT_API_KEY が "RGAPI-" で始まっていません。別の値を貼っていないか確認してください');
  }

  // --- MongoDB ---
  const uri = cfg.mongoUri || '';
  if (!cfg.mongoUriSet) {
    const msg = 'MONGODB_URI が未設定です（未設定だと localhost の MongoDB へ接続しようとします）';
    if (needMongoUri) errors.push(msg);
  } else if (hasEdgeJunk(uri)) {
    errors.push('MONGODB_URI の前後に空白や引用符が含まれています');
  } else if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    errors.push('MONGODB_URI が mongodb:// または mongodb+srv:// で始まっていません');
  } else if (/<password>|<db_password>|<username>/i.test(uri)) {
    errors.push('MONGODB_URI に <password> などの仮の文字が残っています。Atlas の接続文字列の <…> の部分を、実際の値に書き換えてください');
  }

  // --- 地域 ---
  for (const k of ['DEFAULT_REGION', 'CRAWLER_REGION']) {
    if (set(k) && !isRegion(String(env[k]).trim().toLowerCase())) {
      errors.push(`${k}=${JSON.stringify(env[k])} は知らない地域です（jp / kr / na / euw / eune / br / lan / las / oce / tr / ru / me / ph / sg / th / tw / vn）。このままだと jp として動いてしまいます`);
    }
  }

  // --- 数値 ---
  for (const [k, [min, max]] of Object.entries(NUMERIC_VARS)) {
    if (!set(k)) continue;
    const raw = String(env[k]).trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) errors.push(`${k}=${JSON.stringify(env[k])} は数値ではありません。このままだと既定値で動いてしまいます`);
    else if (n < min || (max !== undefined && n > max)) errors.push(`${k}=${raw} は範囲外です（${min}${max !== undefined ? `〜${max}` : ' 以上'}）`);
  }
  if (Number(env.RATE_LOW_RATIO) > Number(env.RATE_HIGH_RATIO)) warnings.push('RATE_LOW_RATIO が RATE_HIGH_RATIO より大きくなっています（クローラーの枠がユーザー操作の枠を超えます）');

  // --- 秘密の文字列・公開設定 ---
  if (set('WEBHOOK_SECRET') && String(env.WEBHOOK_SECRET).length < 16) warnings.push('WEBHOOK_SECRET が短すぎます（16 文字以上の長いランダム文字列にしてください。例: openssl rand -hex 32）');
  if (set('SITE_PASSWORD') && String(env.SITE_PASSWORD).length < 8) warnings.push('SITE_PASSWORD が短すぎます（8 文字以上を推奨）');
  if (env.RENDER === 'true' && !set('TRUST_PROXY')) warnings.push('Render の背後で TRUST_PROXY が未設定です。全員が同じ IP として数えられ、1 人のアクセスで全員が制限されます。TRUST_PROXY=1 を設定してください');

  return { errors, warnings };
}

// 本番（Render / NODE_ENV=production / GitHub Actions）かどうか
export const isProduction = (env = process.env) => env.NODE_ENV === 'production' || env.RENDER === 'true' || env.GITHUB_ACTIONS === 'true';

// 警告を出し、エラーがあれば一覧を出して終了する。logger / exit は差し替えできる（テスト用）
export function assertEnv(env, cfg, opts = {}, { warn = console.warn, error = console.error, exit = (c) => process.exit(c) } = {}) {
  const { errors, warnings } = validateEnv(env, cfg, { production: isProduction(env), ...opts });
  for (const w of warnings) warn(`[Config] 注意: ${w}`);
  if (errors.length) {
    error('[Config] 起動できません。環境変数を直してから、もう一度起動してください:');
    for (const e of errors) error(`  ✗ ${e}`);
    exit(1);
  }
  return { errors, warnings };
}
