import { sleep as realSleep } from '../utils/async.js';

// 混雑で待てないときに投げるエラー（status 429 なので画面側は「アクセス集中」と表示する）
export class RateLimitBusyError extends Error {
  constructor(message = 'ただいまアクセスが集中しています。しばらく待ってからもう一度お試しください。') {
    super(message);
    this.name = 'RateLimitBusyError';
    this.status = 429;
  }
}

// "20:1,100:120" → [{ max: 20, windowMs: 1000 }, { max: 100, windowMs: 120000 }]
export function parseLimitHeader(value) {
  if (!value || typeof value !== 'string') return null;
  const out = [];
  for (const part of value.split(',')) {
    const [max, sec] = part.trim().split(':').map(Number);
    if (!Number.isFinite(max) || !Number.isFinite(sec) || max <= 0 || sec <= 0) return null;
    out.push({ max, windowMs: sec * 1000 });
  }
  return out.length ? out.sort((a, b) => a.windowMs - b.windowMs) : null;
}

const sameWindows = (a, b) =>
  a.length === b.length && a.every((w, i) => w.max === b[i].max && w.windowMs === b[i].windowMs);

const validWindows = (w) =>
  Array.isArray(w) && w.length > 0 && w.every((x) => Number.isFinite(x?.max) && x.max > 0 && Number.isFinite(x?.windowMs) && x.windowMs > 0);

/**
 * スライディングウィンドウ式のレート制限。
 * store を共有すれば、別プロセス（サーバーとクローラー）の使用回数も合算して数える。
 *   store: { add(t) → id, remove(id), list(sinceMs) → 昇順のタイムスタンプ配列, getState(), patchState(patch) }
 */
export function createRateLimiter({
  store,
  windows,
  ratios = { high: 0.95, low: 0.7 },
  maxWaitMs = { high: 20000, low: Infinity },
  maxPending = 200,
  now = Date.now,
  sleep = realSleep,
  jitter = () => Math.random() * 150,
  log = console
}) {
  let wins = [...windows].sort((a, b) => a.windowMs - b.windowMs);
  let chain = Promise.resolve();
  let pending = 0;
  const maxWindow = () => Math.max(...wins.map((w) => w.windowMs));
  const limitFor = (max, ratio) => Math.max(1, Math.floor(max * ratio));

  // stamps（昇順）を見て、あと何 ms 待てば1回使えるか。extra=-1 は「自分の記録を含めた検証」用
  function waitFor(stamps, t, ratio, extra = 0) {
    let wait = 0;
    for (const { max, windowMs } of wins) {
      const limit = limitFor(max, ratio);
      const inWindow = stamps.filter((s) => t - s < windowMs);
      if (inWindow.length + extra >= limit) {
        const idx = Math.min(Math.max(inWindow.length + extra - limit, 0), inWindow.length - 1);
        wait = Math.max(wait, windowMs - (t - inWindow[idx]) + 10);
      }
    }
    return wait;
  }

  // 同一プロセス内の判定は1件ずつ直列にする
  function critical(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  async function adoptSharedLimits() {
    const st = await store.getState();
    if (validWindows(st?.limits)) {
      const next = [...st.limits].sort((a, b) => a.windowMs - b.windowMs);
      if (!sameWindows(next, wins)) {
        wins = next;
        log.log?.(`[RateLimit] 共有された上限に切り替えました: ${next.map((w) => `${w.max}/${w.windowMs / 1000}s`).join(', ')}`);
      }
    }
    return st;
  }

  // 1回分の枠を取る。0 なら取得成功、正の値なら待つべき ms
  async function tryOnce(ratio) {
    const t = now();
    const st = await adoptSharedLimits();
    if (st?.pausedUntil && st.pausedUntil > t) return st.pausedUntil - t;

    const before = await store.list(t - maxWindow());
    const w1 = waitFor(before, t, ratio);
    if (w1 > 0) return w1;

    const id = await store.add(t);
    // 別プロセスと同時に取った場合に備え、記録後にもう一度数えて超えていたら取り消す
    const after = await store.list(t - maxWindow(), { fresh: true });
    const w2 = waitFor(after, t, ratio, -1);
    if (w2 > 0) {
      await store.remove(id);
      return w2 + jitter();
    }
    return 0;
  }

  async function acquire(priority = 'high') {
    const ratio = ratios[priority] ?? ratios.high;
    const limit = maxWaitMs[priority] ?? maxWaitMs.high;
    if (pending >= maxPending) throw new RateLimitBusyError();

    const started = now();
    pending += 1;
    try {
      for (;;) {
        const wait = await critical(() => tryOnce(ratio));
        if (wait <= 0) return;
        if (now() - started + wait > limit) throw new RateLimitBusyError();
        await sleep(wait);
      }
    } finally {
      pending -= 1;
    }
  }

  // レスポンスの X-App-Rate-Limit から上限を学習する（キーの種類が変わっても設定変更が要らない）
  function learn(headers) {
    const parsed = parseLimitHeader(headers?.['x-app-rate-limit']);
    if (!parsed || sameWindows(parsed, wins)) return false;
    wins = parsed;
    log.log?.(`[RateLimit] APIキーの上限を検出: ${parsed.map((w) => `${w.max}/${w.windowMs / 1000}s`).join(', ')}`);
    store.patchState({ limits: parsed }).catch(() => {});
    return true;
  }

  // 429 を受けたとき。アプリ全体の上限なら全プロセスで一定時間止める
  async function penalize({ retryAfterSec = 5, type } = {}) {
    if (type === 'method') return false; // メソッド単位の制限は呼び出し元が待つだけ
    const until = now() + retryAfterSec * 1000 + 200;
    await store.patchState({ pausedUntil: until }).catch(() => {});
    return true;
  }

  async function stats() {
    const t = now();
    const stamps = await store.list(t - maxWindow()).catch(() => []);
    const st = await store.getState().catch(() => ({}));
    return {
      windows: wins.map((w) => ({
        max: w.max,
        seconds: w.windowMs / 1000,
        used: stamps.filter((s) => t - s < w.windowMs).length
      })),
      pending,
      pausedForMs: st?.pausedUntil > t ? st.pausedUntil - t : 0
    };
  }

  return { acquire, learn, penalize, stats, get windows() { return wins; } };
}
