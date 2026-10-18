// エラーログの共通処理（v6.8.0）。
// 以前は各所が `console.error(`[Route] ${err.status} ${err.message}`)` だけで、「どのリクエストの・どのプレイヤーの・
// どの Riot API 呼び出しが失敗したか」が残らなかった。ここでは 1 行にまとめて、次を必ず付ける:
//   [場所] 失敗: メッセージ | status=… | endpoint=…（Riot API の呼び出し先） | req=ID METHOD /path | region= riotId= …
// ・秘密は出さない: API キー（RGAPI-…）、Discord Webhook の URL、MongoDB の接続文字列のユーザー名・パスワードは伏せる。
// ・想定内のエラー（404 / 429 など、status がある）はスタックを出さない。想定外のもの（status が無い）だけスタックを付ける。
// ・同じ ID（req=）は、エラー画面の「エラー ID」と一致する。利用者から ID を聞けば、ログの該当行を探せる。

// 文字列から秘密を伏せる
export function redact(text) {
  return String(text ?? '')
    .replace(/RGAPI-[\w-]+/g, 'RGAPI-***')
    .replace(/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[\w/-]+/gi, 'https://discord.com/api/webhooks/***')
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, '$1***@');
}

const short = (v, n = 8) => {
  const s = String(v ?? '');
  return s.length > n + 2 ? `${s.slice(0, n)}…` : s;
};

// ログに残すクエリ（これ以外は残さない。長い・個人的なものを避ける）
const QUERY_KEYS = ['riotId', 'region', 'queue', 'patch', 'tier', 'division', 'role', 'champion', 'name', 'matchId'];

// Riot API の URL → ログ用の短い文字列。'jp1:/lol/summoner/v4/summoners/by-puuid/AbCdEfGh…'。
// ホストの先頭（jp1 / asia など）は残し、クエリは捨て、PUUID のような長い部分は先頭だけにする
export function describeEndpoint(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.split('/').map((seg) => (seg.length > 24 ? `${seg.slice(0, 8)}…` : seg)).join('/');
    return `${u.hostname.split('.')[0]}:${path}`;
  } catch {
    return '';
  }
}

// リクエストから、原因調査に使う情報だけを取り出す
export function requestContext(req) {
  if (!req) return null;
  const q = req.query || {};
  const parts = [];
  for (const k of QUERY_KEYS) {
    const v = q[k];
    if (typeof v === 'string' && v) parts.push(`${k}=${JSON.stringify(v.slice(0, 60))}`);
  }
  // PUUID は先頭だけ（全体は残さない）
  if (typeof q.puuid === 'string' && q.puuid) parts.push(`puuid=${short(q.puuid)}`);
  return {
    id: req.id || '',
    line: `${req.method || ''} ${req.path || req.url || ''}`.trim(),
    query: parts.join(' ')
  };
}

// 1 行のログ文字列を作る（テストしやすいよう、出力と分けてある）
export function formatError(scope, err, req = null, extra = {}) {
  const e = err && typeof err === 'object' ? err : { message: String(err ?? '') };
  const status = Number.isInteger(Number(e.status)) && e.status ? e.status : null;
  const parts = [`[${scope}] 失敗: ${redact(e.message || e.name || 'unknown')}`];
  if (status) parts.push(`status=${status}`);
  if (e.endpoint) parts.push(`endpoint=${redact(e.endpoint)}`);
  if (e.attempts) parts.push(`attempts=${e.attempts}`);
  const ctx = requestContext(req);
  if (ctx) {
    parts.push(`req=${ctx.id || '-'} ${ctx.line}`);
    if (ctx.query) parts.push(ctx.query);
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v !== undefined && v !== null && v !== '') parts.push(`${k}=${redact(typeof v === 'string' ? v : JSON.stringify(v))}`);
  }
  let line = parts.join(' | ');
  // 想定外のエラー（status が無い = コードの不具合・DB の例外など）だけ、スタックを付けて場所を追えるようにする
  if (!status && e.stack) line += `\n${redact(e.stack).split('\n').slice(0, 8).join('\n')}`;
  return line;
}

export function logError(scope, err, req = null, extra = {}) {
  console.error(formatError(scope, err, req, extra));
}

// ルートの catch 用。ログを出し、エラー画面に出す「エラー ID」を用意する（利用者の問い合わせからログを探せる）。
// 利用者側の問題（400 / 404 / 429 など）は ID を出さない
export function logRequestError(scope, err, req, extra = {}) {
  logError(scope, err, req, extra);
  const s = Number(err?.status);
  const serverSide = !Number.isInteger(s) || s < 400 || s >= 500 || s === 401 || s === 403;
  if (serverSide && req?.res?.locals && req.id) req.res.locals.errorId = req.id;
}
