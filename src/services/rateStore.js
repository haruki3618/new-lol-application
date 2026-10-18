import mongoose from 'mongoose';
import RateStamp from '../models/RateStamp.js';
import { readPersistent, writePersistent } from '../utils/persistentCache.js';

// 1プロセスだけで使う（または MongoDB が使えないときの）メモリ版
export function createMemoryStore() {
  let seq = 0;
  let stamps = [];
  let state = {};
  return {
    async add(t) {
      const id = ++seq;
      stamps.push({ id, t });
      return id;
    },
    async remove(id) {
      stamps = stamps.filter((s) => s.id !== id);
    },
    async list(since) {
      stamps = stamps.filter((s) => s.t > since);
      return stamps.map((s) => s.t).sort((a, b) => a - b);
    },
    async getState() {
      return { ...state };
    },
    async patchState(patch) {
      state = { ...state, ...patch };
    }
  };
}

const STATE_KEY = 'rate:state';
const STATE_TTL = 7 * 24 * 60 * 60 * 1000;
const STATE_REFRESH_MS = 1500;

// MongoDB に使用回数を記録して、サーバーとクローラーなど複数プロセスで合算する。
// MongoDB に繋がっていないときは自動でメモリ版にフォールバックする。
export function createMongoStore({ local = createMemoryStore(), log = console } = {}) {
  const ready = () => mongoose.connection.readyState === 1;
  let lastWarn = 0;
  const warn = (err) => {
    if (Date.now() - lastWarn > 60000) {
      lastWarn = Date.now();
      log.warn?.(`[RateLimit] MongoDB での共有に失敗したためメモリ版で動作します: ${err.message}`);
    }
  };

  let cachedState = null;
  let cachedAt = 0;

  // v6.6: 「枠を取る前の確認」の読み取りは 1 秒だけキャッシュし、MongoDB の読み取りを減らす。
  // 記録後の検証（fresh: true）は毎回読むので、別プロセスと同時に取って超過した分は従来どおり取り消される
  const LIST_TTL_MS = 1000;
  let listCache = null; // { at, stamps }

  return {
    async add(t) {
      const localId = await local.add(t);
      let remoteId = null;
      if (ready()) {
        try {
          const doc = await RateStamp.create({ t, expireAt: new Date(t + 5 * 60 * 1000) });
          remoteId = doc._id;
        } catch (err) {
          warn(err);
        }
      }
      return { localId, remoteId };
    },
    async remove(id) {
      await local.remove(id.localId);
      if (id.remoteId && ready()) {
        try {
          await RateStamp.deleteOne({ _id: id.remoteId });
        } catch (err) {
          warn(err);
        }
      }
    },
    async list(since, { fresh = false } = {}) {
      if (ready()) {
        try {
          if (!fresh && listCache && Date.now() - listCache.at < LIST_TTL_MS) {
            // キャッシュ後にこのプロセスが記録した分は、メモリ側から足す
            const mine = await local.list(since);
            return listCache.stamps.filter((t) => t > since).concat(mine.filter((t) => t > listCache.at)).sort((a, b) => a - b);
          }
          const at = Date.now();
          const rows = await RateStamp.find({ t: { $gt: since } }).select({ t: 1, _id: 0 }).lean();
          const stamps = rows.map((r) => r.t).sort((a, b) => a - b);
          listCache = { at, stamps };
          return stamps;
        } catch (err) {
          warn(err);
        }
      }
      return local.list(since);
    },
    async getState() {
      const mine = await local.getState();
      if (!ready()) return mine;
      if (!cachedState || Date.now() - cachedAt > STATE_REFRESH_MS) {
        cachedState = (await readPersistent(STATE_KEY)) || {};
        cachedAt = Date.now();
      }
      // 自分の記録と共有の記録のうち、停止期限は新しい方・上限は共有の方を採用
      return {
        limits: cachedState.limits || mine.limits,
        pausedUntil: Math.max(cachedState.pausedUntil || 0, mine.pausedUntil || 0)
      };
    },
    async patchState(patch) {
      await local.patchState(patch);
      if (!ready()) return;
      const current = (await readPersistent(STATE_KEY)) || {};
      const next = { ...current, ...patch };
      cachedState = next;
      cachedAt = Date.now();
      await writePersistent(STATE_KEY, next, STATE_TTL);
    }
  };
}
