import { cachedPersistent, writePersistent } from '../utils/persistentCache.js';
import { mapLimit } from '../utils/async.js';
import { getAccountByPUUID, getAccountByRiotId, RiotApiError } from './riotApi.js';
import { createNegativeCache } from '../utils/negativeCache.js';
import { rememberSearched } from './playerNames.js';
import { rememberPuuid } from './knownPuuids.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NAME_TTL = 3 * DAY; // PUUID → Riot ID（ランキングの名前解決。再起動しても残る）
const ACCOUNT_TTL = 2 * HOUR; // Riot ID → アカウント（再起動しても残る）
const notFound = createNegativeCache({ ttlMs: 60 * 1000 }); // v6.6.1: 存在しない Riot ID は 60 秒だけ覚え、同じ検索で API を使わない
export const _resetAccountNotFound = () => notFound.clear();

// PUUID → "ゲーム名#タグ"（失敗したら空文字）
// アカウントは全リージョン共通なのでキャッシュは puuid だけで共有し、region は問い合わせ先の地域ホストを選ぶためだけに使う
export function nameOf(puuid, region) {
  if (!puuid) return Promise.resolve('');
  return cachedPersistent(`acc-puuid:${puuid}`, NAME_TTL, () => getAccountByPUUID(puuid, { region }))
    .then((a) => (a?.gameName ? `${a.gameName}#${a.tagLine}` : ''))
    .catch(() => '');
}

export const namesOf = (puuids, region) => mapLimit(puuids, 4, (puuid) => nameOf(puuid, region));

// "ゲーム名#タグ" → アカウント（puuid を含む）。プロフィール・マルチ検索で共通に使う
export async function accountByRiotId(parsed, force = false, region) {
  const key = `account:${parsed.gameName}#${parsed.tagLine}`.toLowerCase();
  if (force) notFound.delete(key); // 「再取得」は覚えた「見つからない」も無視してもう一度確かめる
  else if (notFound.has(key)) throw new RiotApiError('プレイヤーが見つかりませんでした', 404);
  let account;
  try {
    account = await cachedPersistent(
      key,
      ACCOUNT_TTL,
      async () => {
        const account = await getAccountByRiotId(parsed.gameName, parsed.tagLine, { region });
        // 逆引き（PUUID → 名前）も同時に覚えておくと、あとで API を呼ばずに済む
        if (account?.puuid) writePersistent(`acc-puuid:${account.puuid}`, account, NAME_TTL).catch(() => {});
        return account;
      },
      { force }
    );
  } catch (err) {
    if (err?.status === 404) notFound.add(key); // 429 / 5xx などの一時的な失敗は覚えない
    throw err;
  }
  // 検索ボックスの予測に出せるよう、検索されたプレイヤーを覚える（人気順の並べ替えにも使う）
  if (account?.puuid) rememberPuuid(account.puuid); // v6.6: 同期・履歴 API は、検索を通った PUUID だけ受け付ける
  if (account?.puuid && region) rememberSearched(account, region).catch(() => {});
  return account;
}
