import crypto from 'node:crypto';

// 公開の許可が下りるまで、サイト全体を ID とパスワードで守る（SITE_PASSWORD を設定したときだけ有効）。
// /healthz は監視用なので対象外。パスワードを設定しなければ何もしない
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

export function basicAuth({ user = 'admin', password = '' } = {}) {
  if (!password) return (req, res, next) => next();
  return (req, res, next) => {
    if (req.path === '/healthz') return next();
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i >= 0 && safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), password)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="LoL Analytics", charset="UTF-8"');
    res.status(401).type('text/plain; charset=utf-8').send('認証が必要です。');
  };
}
