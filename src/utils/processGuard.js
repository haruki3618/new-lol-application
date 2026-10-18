import { logError } from './logger.js';

// プロセス全体の最後の砦（v6.8.0）。
// ・未処理の Promise 拒否 / 例外は、場所が追えるようにログへ残して続行する（従来どおり）。
// ・ただし uncaughtException は、プロセスの状態が壊れている可能性がある。windowMs の間に maxUncaught 回
//   起きたら、「壊れたまま動き続ける」より再起動のほうが安全なので終了する（Render は自動で起動し直す）。
// proc / exit / now は差し替えられる（テスト用）。
export function installProcessGuards(scope, { proc = process, exit = (code) => process.exit(code), now = Date.now, maxUncaught = 5, windowMs = 60 * 1000 } = {}) {
  const hits = [];
  proc.on('unhandledRejection', (reason) => {
    logError(`${scope}:Process`, reason instanceof Error ? reason : new Error(`未処理の Promise 拒否: ${String(reason)}`));
  });
  proc.on('uncaughtException', (err) => {
    logError(`${scope}:Process`, err instanceof Error ? err : new Error(String(err)), null, { kind: 'uncaughtException' });
    const t = now();
    hits.push(t);
    while (hits.length && t - hits[0] > windowMs) hits.shift();
    if (hits.length >= maxUncaught) {
      console.error(`[${scope}:Process] ${Math.round(windowMs / 1000)} 秒に ${hits.length} 回の未処理の例外が起きたため、再起動のために終了します`);
      exit(1);
    }
  });
  return { hits };
}
