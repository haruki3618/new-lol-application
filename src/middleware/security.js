// helmet 相当のセキュリティヘッダー（追加パッケージ不要の自前実装）
// 画像・フォントなど、このアプリが実際に使う外部ドメインだけを許可する
export const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: https://ddragon.leagueoflegends.com",
  // v6.6: テンプレートの style="" 属性をクラスへ移し、外部フォントもやめたので、style も font も自サイトだけでよい
  // （動的な値は data-style 属性を JS が CSSOM で適用する。CSSOM の操作は CSP の対象外）
  "style-src 'self'",
  "font-src 'self'",
  // v6.5.1: インライン onerror とグラフ用の inline script をなくしたので、スクリプトは自サイトのファイルだけ許可する
  // （LP のデータは <script type="application/json"> なので実行されず、CSP の対象外）
  "script-src 'self'",
  "connect-src 'self'"
].join('; ');

export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // HTTPS で配信しているときだけ HSTS を付ける
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}
