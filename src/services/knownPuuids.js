import Match from '../models/Match.js';

// v6.6: 「アカウント検索を通った PUUID」だけを同期・履歴の対象にするための記録。
// 任意の PUUID で Riot API の枠を使われるのを防ぐ。メモリ内（再起動で消える）なので、
// 記録がないときは「保存済みの試合に参加している PUUID か」で代わりに確かめる（再起動直後でも通常の画面が動くように）
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX = 20000;
const known = new Map(); // puuid → 期限

export function rememberPuuid(puuid) {
  if (!puuid) return;
  if (known.size >= MAX) known.delete(known.keys().next().value);
  known.delete(puuid);
  known.set(puuid, Date.now() + TTL_MS);
}

export async function isKnownPuuid(puuid) {
  const until = known.get(puuid);
  if (until && until > Date.now()) return true;
  if (until) known.delete(puuid);
  try {
    if (await Match.exists({ participantPuuids: puuid })) {
      rememberPuuid(puuid);
      return true;
    }
  } catch {
    /* DB に問い合わせられないときは「未確認」として扱う */
  }
  return false;
}

export const _resetKnownPuuids = () => known.clear();
