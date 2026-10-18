import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config/index.js';
import { securityHeaders } from './middleware/security.js';
import { requestId } from './middleware/requestId.js';
import { logRequestError } from './utils/logger.js';
import { responseStatus, userMessage } from './utils/httpError.js';
import { compression } from './middleware/compression.js';
import { ipLimiter } from './middleware/ipLimiter.js';
import { basicAuth } from './middleware/basicAuth.js';
import { regionContext } from './middleware/region.js';
import { keyStatus } from './services/keyStatus.js';
import router from './routes/profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(requestId()); // v6.8.0: ログとエラー画面を結ぶリクエスト ID
app.use(securityHeaders());
app.use(basicAuth({ user: config.siteUser, password: config.sitePassword }));
app.use(compression());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// 静的ファイル（Chart.js は npm の配布物をそのまま配信する）
app.use('/static/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist'), { maxAge: '7d' }));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// 画面共通: リージョン（req.region / res.locals.region など）
app.use(regionContext());

// 画面共通: APIキー失効の警告
app.use((req, res, next) => {
  res.locals.keyInvalid = keyStatus.invalid;
  res.locals.matchTtlDays = config.matchTtlDays; // 保存期間の注記に使う（0 = 無期限）
  res.locals.assetV = config.appVersion; // v6.6.1: 静的ファイルの URL に ?v= を付ける（更新後に古い JS / CSS が最大 1 時間残るのを防ぐ）
  next();
});

// v6.6: プロキシの背後で TRUST_PROXY が未設定だと、全員が同じ IP に見えて 1 人のアクセスで全員が制限される。気づけるよう 1 回だけ警告する
let warnedProxy = false;
app.use((req, res, next) => {
  if (!warnedProxy && config.trustProxy === false && req.headers['x-forwarded-for']) {
    warnedProxy = true;
    console.warn('[Server] X-Forwarded-For ヘッダーを検出しましたが、TRUST_PROXY が未設定です。リバースプロキシ（Render など）の背後なら、全員が同じ IP として数えられます。TRUST_PROXY=1 などを設定してください');
  }
  next();
});

// IP ごとのアクセス制限（1分あたり。WEB_RATE_SCALE で全体を何倍かにできる）
const limit = (name, max) => ipLimiter({ name, max: Math.round(max * config.webRateScale) });
// v6.6: 同期は「開始」（Riot API を使う）と「進捗の確認」（軽い・約1秒ごと）で枠を分ける
app.use('/api/sync/start', limit('sync-start', config.syncStartPerMin));
app.use('/api/sync/status', limit('sync-status', 150));
app.use('/api/suggest', limit('suggest', 150));
app.use('/api/history/start', limit('history-start', 20));
app.use('/api/history/status', limit('history-status', 120));
// v6.6: 履歴の読み込みは 1 回で最大300件の API を使うので、IP ごとに 1 日あたりの回数も制限する（POST だけ）
app.post('/api/history/start', ipLimiter({ name: 'history-day', windowMs: 24 * 60 * 60 * 1000, max: config.historyPerDay, message: '本日の「過去の試合を読み込む」の上限に達しました。明日もう一度お試しください。' }));
app.use('/api/timeline', limit('timeline', 30));
app.use('/api/detail', limit('detail', 30));
app.use('/api/live-fill', limit('live-fill', 30));
app.use('/api/tab', limit('tab', 60));
app.use('/insights', limit('insights', 20));
app.use('/search', limit('search', 30));
app.use('/summoner', limit('summoner', 60));
app.use('/multi', limit('multi', 10));
app.use('/live', limit('live', 30));
app.use('/ranking', limit('ranking', 40));
app.use('/duo', limit('duo', 20));
app.use('/watch', limit('watch', 20));
// v6.5.1: 登録・解除は乱用されやすいので、IP ごとに 1 時間あたりの回数を別に制限する（POST だけ）
const hourly = (name, max) => ipLimiter({ name, windowMs: 60 * 60 * 1000, max, skip: (req) => req.method !== 'POST' });
app.post('/watch', hourly('watch-add', config.watchAddPerHour));
app.post('/watch/remove', hourly('watch-remove', config.watchRemovePerHour));
// v6.11.0: 診断のタイムライン集計は、足りない試合ぶんの Riot API を使う（最大 5 件 / 回）ので、IP ごとに 1 時間あたりの回数を制限する
app.post('/insights/:puuid/timeline', hourly('insights-tl', 12));
app.use('/report', limit('report', 30));
app.use('/champion', limit('champion', 60));
app.use('/matchup', limit('matchup', 60));

// v6.6: ブラウザが取りに来る /favicon.ico は、SVG のアイコンへ誘導する（404 のエラー画面を返さない）
app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/favicon.svg'));

app.use('/', router);

app.use((req, res) => {
  res.status(404).render('error', { title: 'ページが見つかりません', backUrl: '/', message: 'お探しのページは存在しません。' });
});

// eslint-disable-next-line no-unused-vars
// v6.8.0: ルート・ミドルウェアで拾われなかった例外（async の reject を含む）の最後の受け皿。
// ログには場所・リクエスト・（Riot API なら）呼び出し先を残し、利用者には内部の文言を見せずに「エラー ID」を出す
app.use((err, req, res, next) => {
  logRequestError('Server', err, req);
  if (res.headersSent) return next(err); // 途中まで送っていたら、Express に接続を閉じてもらう
  const status = responseStatus(err);
  const message = userMessage(err, '予期せぬエラーが発生しました。しばらくしてからもう一度お試しください。');
  // /api/ はブラウザの JS が読むので JSON で返す（HTML のエラー画面を返すと「状態を確認できません」になる）
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message, requestId: req.id });
  res.status(status).render('error', { title: null, backUrl: '/', message, retryable: status === 429 || status >= 500 });
});

export default app;
