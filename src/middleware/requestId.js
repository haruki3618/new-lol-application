import crypto from 'node:crypto';

// リクエストごとの ID（v6.8.0）。ログの `req=` と、エラー画面・API エラーの「エラー ID」が同じ値になる。
// 手前のプロキシが付けた X-Request-Id は、安全な形のときだけ使う（ログへの注入を避ける）
const SAFE = /^[A-Za-z0-9-]{8,64}$/;

export function requestId() {
  return (req, res, next) => {
    const inbound = req.headers['x-request-id'];
    req.id = typeof inbound === 'string' && SAFE.test(inbound) ? inbound : crypto.randomBytes(4).toString('hex');
    res.locals.requestId = req.id;
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}
