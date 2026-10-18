export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 同時実行数を limit に抑えながら、配列を順序どおりに非同期処理する
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return results;
}

// 5xx・通信エラーの再試行までの待ち時間（v6.7.0）。指数的に増やし、半分〜全部の範囲でばらつかせる。
// 同じ失敗を同時に受けた複数のリクエストが、同じ瞬間に再試行して上流へ集中するのを避ける。
//   attempt 0 → 250〜500ms / 1 → 500〜1000ms / 2 → 1〜2s / 3 → 2〜4s …（上限 cap）
export function backoffMs(attempt, { base = 500, cap = 8000, rand = Math.random } = {}) {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + rand() * (exp / 2));
}
