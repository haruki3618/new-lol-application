// IPごとのアクセス制限（スライディングウィンドウ・ログ方式）
// 固定ウィンドウだと、ウィンドウの境目をまたいで最大 2 倍まで通せてしまうため、
// 直近 windowMs の間に受け付けた時刻を記録して数える。
// 状態はプロセスのメモリ内（再起動で消える・複数インスタンスでは共有されない）。
// 記録するのは「受け付けた」リクエストだけなので、1 つのキーあたり最大 max 件で済む。
const MAX_KEYS = 50000; // 追跡する IP 数の上限（超えたら古いものから捨てる。メモリの暴走防止）

export function ipLimiter({
  name = 'limit',
  windowMs = 60000,
  max = 60,
  skip = null,
  keyFn = (req) => req.ip || req.socket?.remoteAddress || 'unknown',
  message = 'アクセスが多すぎます。しばらく待ってからもう一度お試しください。',
  now = Date.now
} = {}) {
  const hits = new Map(); // key → 受け付けた時刻の配列（古い順）

  const prune = (arr, t) => {
    let i = 0;
    while (i < arr.length && arr[i] <= t - windowMs) i += 1;
    if (i > 0) arr.splice(0, i);
    return arr;
  };

  const timer = setInterval(() => {
    const t = now();
    for (const [k, arr] of hits) {
      prune(arr, t);
      if (arr.length === 0) hits.delete(k);
    }
  }, Math.max(windowMs, 10000));
  timer.unref?.();

  const middleware = (req, res, next) => {
    if (skip?.(req)) return next();

    const t = now();
    const key = keyFn(req);
    let arr = hits.get(key);
    if (!arr) {
      if (hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value);
      arr = [];
      hits.set(key, arr);
    } else {
      prune(arr, t);
    }

    const allowed = arr.length < max;
    if (allowed) arr.push(t);

    // 次に 1 件空くまで（許可したときは、最も古い記録が消えるまで）の秒数
    const resetSec = arr.length ? Math.max(1, Math.ceil((arr[0] + windowMs - t) / 1000)) : Math.ceil(windowMs / 1000);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - arr.length)));
    res.setHeader('RateLimit-Reset', String(resetSec));
    if (allowed) return next();

    res.setHeader('Retry-After', String(resetSec));
    const url = req.originalUrl || req.url || '';
    const isApi = url.startsWith('/api') || String(req.headers?.accept || '').includes('application/json');
    if (typeof res.render === 'function' && !isApi) {
      // v6.6: 待ち時間を画面に出せるよう、あと何秒で再開できるかを渡す
      return res.status(429).render('error', { title: 'アクセスが集中しています', backUrl: '/', message, retryAfterSec: resetSec });
    }
    res.statusCode = 429;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(message);
  };

  middleware.reset = () => hits.clear();
  middleware.limiterName = name;
  return middleware;
}
