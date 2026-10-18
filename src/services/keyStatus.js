import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { config } from '../config/index.js';

// APIキーが有効かどうか（画面上の警告表示と /healthz に使う）
let state = 'unknown'; // 'unknown' | 'valid' | 'invalid'
let lastReloadAt = 0;

export const keyStatus = {
  get state() { return state; },
  get invalid() { return state === 'invalid'; },
  markValid() { state = 'valid'; },
  markInvalid() { state = 'invalid'; }
};

// 開発キーは24時間で失効する。.env を書き換えて保存すれば、再起動なしで新しいキーに切り替える
export function reloadKeyFromEnvFile(file = path.resolve(process.cwd(), '.env')) {
  if (Date.now() - lastReloadAt < 5000) return false;
  lastReloadAt = Date.now();
  try {
    const parsed = dotenv.parse(fs.readFileSync(file));
    for (const name of config.keyEnvNames) {
      const next = parsed[name]?.trim();
      if (next && next !== config.riotApiKey) {
        config.riotApiKey = next;
        state = 'unknown';
        return true;
      }
    }
  } catch {
    // .env が無い・読めない場合は何もしない
  }
  return false;
}
