// 利用者の入力（クエリ・パス・フォーム）の検証を 1 か所にまとめたもの（v6.8.1）。
// 以前は PUUID の判定が sync / live / insights / info の 4 か所に同じ正規表現で、timeline は長さ無制限の弱い判定、
// 試合 ID は長さ無制限、数値の範囲指定は各ルートに書き写されていた。直すときに 1 か所だけ直し忘れるのを防ぐ。
// どれも「形が正しいか」だけを見る（その PUUID・試合が実在するかは、各ルートが DB で確認する）。
// 配列・オブジェクトで渡されても（?puuid[$ne]=x など）、文字列でなければ不正として扱う。

const isStr = (v) => typeof v === 'string';

// Riot の PUUID（78 文字前後の英数字・- ・_）
export const isPuuid = (v) => isStr(v) && /^[\w-]{20,100}$/.test(v);

// 試合 ID（JP1_123456789 / NA1_… / EUW1_…）
export const isMatchId = (v) => isStr(v) && /^[A-Za-z0-9]{2,8}_\d{1,16}$/.test(v);

// Data Dragon のチャンピオン ID（Ahri / MonkeyKing / Kaisa）
export const isChampId = (v) => isStr(v) && /^[A-Za-z0-9]{1,30}$/.test(v);

// パッチ（14.10）。不正なら null
export const validPatch = (v) => (isStr(v) && /^\d+\.\d+$/.test(v) ? v : null);

// 数値の範囲指定（?count=…, ?page=…）。数字でない・0 のときは fallback にしてから、min〜max に収める
export function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10) || fallback;
  return Math.min(Math.max(n, min), max);
}
