// 「見つからなかった」結果を短時間だけ覚える（v6.6.1）。
// 存在しない Riot ID（打ち間違い・ボットの総当たり）を検索するたびに Riot API の枠を使わないようにする。
// 成功した結果や、一時的な失敗（429 / 5xx）は覚えない。
export function createNegativeCache({ ttlMs = 60 * 1000, max = 2000, now = Date.now } = {}) {
  const map = new Map(); // key → 期限

  return {
    has(key) {
      const until = map.get(key);
      if (!until) return false;
      if (until <= now()) { map.delete(key); return false; }
      return true;
    },
    add(key) {
      if (map.size >= max) map.delete(map.keys().next().value);
      map.delete(key);
      map.set(key, now() + ttlMs);
    },
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
    get size() { return map.size; }
  };
}
