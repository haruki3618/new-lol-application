import { config } from '../config/index.js';
import { createRateLimiter } from './rateLimiter.js';
import { createMemoryStore, createMongoStore } from './rateStore.js';

// このプロセスのAPI呼び出しをすべてここで数える。
// RATE_SHARED=0 以外なら MongoDB 経由で、別プロセス（クローラー）の分も合算される
export const limiter = createRateLimiter({
  store: config.rateShared ? createMongoStore() : createMemoryStore(),
  windows: [
    { max: config.rate1s, windowMs: 1000 },
    { max: config.rate120s, windowMs: 120000 }
  ],
  ratios: { high: config.rateHighRatio, low: config.rateLowRatio },
  maxWaitMs: { high: config.rateWaitMs, low: Infinity }
});
