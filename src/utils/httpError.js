// エラーを画面・JSON に出すときの共通処理（v6.6.1）。
// 以前は各ルートが err.status / err.message をそのまま画面へ出していた。
//   - Riot API のエラー本文や MongoDB のエラー文など、内部の文言が利用者に見えてしまう
//   - err.status が数値でないとき res.status() が例外になり、エラー画面すら出なくなる
//   - Riot の 401/403（= このサイトの API キーの問題）を、そのまま利用者への 401/403 として返していた
// ここでは「利用者に見せてよい日本語の文」と「安全な HTTP ステータス」だけを返す。

// 100〜599 の整数だけを通す。それ以外は fallback
export function safeStatus(err, fallback = 500) {
  const n = Number(err?.status);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : fallback;
}

// Riot API が返した 401/403 はサイト側のキーの問題なので、利用者には 503（一時的に使えない）として返す。
// 404（見つからない）・429（混雑）はそのまま。5xx は上流の障害なので 502
export function responseStatus(err) {
  const s = safeStatus(err);
  if (s === 401 || s === 403) return 503;
  if (s >= 500) return s === 500 ? 500 : 502;
  return s;
}

const MESSAGES = {
  400: 'リクエストの形式が正しくありません。入力内容を確認してください。',
  401: 'API キーが無効か、期限切れです。管理者が復旧するまでお待ちください。',
  403: 'API キーが無効か、期限切れです。管理者が復旧するまでお待ちください。',
  413: '送信された内容が大きすぎます。',
  404: '見つかりませんでした。プレイヤーを探している場合は、Riot ID のスペルとタグを確認してください。',
  429: 'アクセスが集中しています。しばらく待ってからもう一度お試しください。'
};

// 利用者に見せてよい文。想定外のエラー（DB の例外など）は、内部の文言を出さず fallback にする
export function userMessage(err, fallback = '情報を取得できませんでした。しばらくしてからもう一度お試しください。') {
  return MESSAGES[safeStatus(err, 0)] || fallback;
}
