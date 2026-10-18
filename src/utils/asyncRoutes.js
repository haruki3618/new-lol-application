// async のルートの例外を、必ずエラー処理（app.js の最後のミドルウェア）へ渡す（v6.8.0）。
// Express 4 は async 関数が reject しても何もせず、リクエストが止まったままになる（v6.6.1 で個別に直した所以外にも起こりうる）。
// ルーターを safeRouter(Router()) で包むと、get / post / put / delete / patch に渡した関数が全部この保護の下に入る。
// 4 引数のエラー用ミドルウェアはそのまま通す。

const METHODS = ['get', 'post', 'put', 'delete', 'patch'];

export function wrapHandler(fn) {
  if (typeof fn !== 'function' || fn.length === 4) return fn;
  return function wrapped(req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') out.then(undefined, next);
    } catch (err) {
      next(err);
    }
  };
}

export function safeRouter(router) {
  for (const m of METHODS) {
    const orig = router[m]?.bind(router);
    if (!orig) continue;
    router[m] = (...args) => orig(...args.map((a) => (typeof a === 'function' ? wrapHandler(a) : Array.isArray(a) ? a.map(wrapHandler) : a)));
  }
  return router;
}
