import mongoose from 'mongoose';
import CacheEntry from '../models/CacheEntry.js';
import { cached } from './cache.js';

const ready = () => mongoose.connection.readyState === 1;
let lastWarn = 0;
const warn = (err) => {
  if (Date.now() - lastWarn > 60000) {
    lastWarn = Date.now();
    console.warn(`[Cache] 永続キャッシュを使えませんでした（メモリのみで継続）: ${err.message}`);
  }
};

export async function readPersistent(key) {
  if (!ready()) return null;
  try {
    const doc = await CacheEntry.findById(key).lean();
    if (!doc || doc.expiresAt.getTime() <= Date.now()) return null;
    return doc.v ?? null;
  } catch (err) {
    warn(err);
    return null;
  }
}

export async function writePersistent(key, value, ttlMs) {
  if (!ready()) return false;
  try {
    await CacheEntry.updateOne({ _id: key }, { $set: { v: value, expiresAt: new Date(Date.now() + ttlMs) } }, { upsert: true });
    return true;
  } catch (err) {
    warn(err);
    return false;
  }
}

// メモリ → MongoDB → API の順に探す。MongoDB が使えなくても通常のキャッシュとして動く
export function cachedPersistent(key, ttlMs, loader, { force = false, memoryMs = Math.min(ttlMs, 5 * 60 * 1000) } = {}) {
  return cached(
    key,
    memoryMs,
    async () => {
      if (!force) {
        const hit = await readPersistent(key);
        if (hit !== null) return hit;
      }
      const value = await loader();
      if (value !== undefined && value !== null) await writePersistent(key, value, ttlMs);
      return value;
    },
    { force }
  );
}
