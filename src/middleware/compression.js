import zlib from 'node:zlib';

// gzip 圧縮（compression パッケージ相当の最小実装）。HTML・CSS・JS・JSON だけを圧縮する
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/i;

function addVary(res, value) {
  const current = res.getHeader('Vary');
  if (!current) return res.setHeader('Vary', value);
  if (!String(current).toLowerCase().split(/,\s*/).includes(value.toLowerCase())) {
    res.setHeader('Vary', `${current}, ${value}`);
  }
}

export function compression({ threshold = 1024 } = {}) {
  return (req, res, next) => {
    if (req.method === 'HEAD') return next();
    if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return next();

    const origWrite = res.write;
    const origEnd = res.end;
    const origWriteHead = res.writeHead;
    let decided = false;
    let gz = null;

    function decide() {
      if (decided) return;
      decided = true;
      addVary(res, 'Accept-Encoding');

      const type = res.getHeader('Content-Type');
      const status = res.statusCode;
      const length = Number(res.getHeader('Content-Length'));
      const skip =
        !type || !COMPRESSIBLE.test(String(type)) ||
        res.getHeader('Content-Encoding') ||
        status === 204 || status === 304 || status < 200 ||
        /no-transform/i.test(String(res.getHeader('Cache-Control') || '')) ||
        (length && length < threshold);
      if (skip) return;

      res.setHeader('Content-Encoding', 'gzip');
      res.removeHeader('Content-Length');
      gz = zlib.createGzip();
      gz.on('data', (chunk) => origWrite.call(res, chunk));
      gz.on('end', () => origEnd.call(res));
      gz.on('error', () => origEnd.call(res));
      // gz.write() が false を返して送り元が待機したとき、再開の合図は圧縮ストリームの 'drain'。
      // res の 'drain' として伝えないと応答が終わらない（Node 24 で発生）
      gz.on('drain', () => res.emit('drain'));
      res.on('close', () => gz && gz.destroy());
    }

    res.writeHead = function (statusCode, ...rest) {
      // writeHead に渡されたヘッダーも判定に使えるよう、先に setHeader で登録する
      const last = rest[rest.length - 1];
      if (last && typeof last === 'object' && !Array.isArray(last)) {
        for (const [k, v] of Object.entries(last)) res.setHeader(k, v);
        rest.pop();
      }
      this.statusCode = statusCode;
      decide();
      return origWriteHead.call(this, statusCode, ...rest);
    };

    res.write = function (chunk, encoding, cb) {
      decide();
      if (!gz) return origWrite.call(this, chunk, encoding, cb);
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      return gz.write(chunk, encoding, cb);
    };

    res.end = function (chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = null; }
      else if (typeof encoding === 'function') { cb = encoding; encoding = null; }
      decide();
      if (!gz) return origEnd.call(this, chunk, encoding, cb);
      if (cb) res.once('finish', cb);
      if (chunk) gz.write(chunk, encoding);
      gz.end();
      return this;
    };

    next();
  };
}
