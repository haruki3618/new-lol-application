// メモリキャッシュ（TTL付き）。同じキーの同時リクエストは1回にまとめる
//
// v6.7.0: 「古い値で凌ぐ」（stale-if-error）と、ヒット率の記録を追加。
//   cached(key, ttl, loader, { staleMs })
//     loader が「一時的な失敗」（429 / 5xx / 通信エラー）で落ちたとき、期限が切れていても staleMs 以内の
//     古い値があればそれを返す。Riot API の障害・混雑のときに、エラー画面ではなく少し古いデータを出せる。
//     404 / 400 / 401 / 403 は「古い値で凌いでよい失敗」ではないので、そのまま投げる。
//     staleMs を渡さなければ従来どおり（失敗は投げるだけで、何も保存しない）。
const store = new Map();
const pending = new Map();
const MAX_ENTRIES = 5000;
const STALE_RETRY_MS = 15 * 1000; // 古い値を返したあと、この間は同じ失敗を繰り返して API を叩かない

export const STALE_1H = 60 * 60 * 1000;

const stats = { hit: 0, miss: 0, stale: 0, error: 0, shared: 0 };

// 古い値で凌いでよい失敗か。ステータスが無い（通信エラー・タイムアウト）・429・5xx だけ
export function isTransientError(err) {
  const s = Number(err?.status);
  if (!Number.isInteger(s) || s < 100) return true;
  return s === 429 || s >= 500;
}

export async function cached(key, ttlMs, loader, { force = false, staleMs = 0 } = {}) {
  const now = Date.now();
  const hit = store.get(key);
  if (!force && hit && hit.expires > now) { stats.hit++; return hit.value; }

  if (pending.has(key)) { stats.shared++; return pending.get(key); }
  stats.miss++;

  const promise = (async () => {
    try {
      const value = await loader();
      const at = Date.now();
      store.set(key, { value, expires: at + ttlMs, born: at, staleUntil: at + ttlMs + Math.max(0, staleMs), stale: false });
      if (store.size > MAX_ENTRIES) {
        for (const [k, v] of store) {
          if (v.staleUntil <= Date.now()) store.delete(k);
        }
        while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
      }
      return value;
    } catch (err) {
      stats.error++;
      // 古い値が許される期間内なら、それを返す（短い間だけ再利用して、障害中に API を叩き続けない）
      if (staleMs > 0 && hit && isTransientError(err) && hit.staleUntil > Date.now()) {
        stats.stale++;
        store.set(key, { ...hit, expires: Date.now() + STALE_RETRY_MS, stale: true });
        return hit.value;
      }
      throw err;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, promise);
  return promise;
}

// 直近の取得で「古い値」を返したキーなら、その値が取得された時刻からの経過ミリ秒。そうでなければ null。
// 画面に「最新の取得に失敗したため、N 分前のデータを表示しています」と出すために使う
export function staleAgeMs(key) {
  const e = store.get(key);
  return e && e.stale ? Math.max(0, Date.now() - e.born) : null;
}

// 監視用（/healthz）。再起動で 0 に戻る
export function cacheStats() {
  const total = stats.hit + stats.miss + stats.shared;
  return {
    ...stats,
    entries: store.size,
    hitRate: total > 0 ? Math.round(((stats.hit + stats.shared) / total) * 1000) / 10 : null
  };
}

// テスト用
export function _resetCache() {
  store.clear();
  pending.clear();
  for (const k of Object.keys(stats)) stats[k] = 0;
}
