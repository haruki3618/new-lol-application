import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import Match from '../src/models/Match.js';
import ChampAgg from '../src/models/ChampAgg.js';
import { rebuildAggregates } from '../src/services/aggregate.js';

// 保存されている試合から事前集計を作り直す（集計がずれたと感じたとき、初回の取り込みを先に済ませたいときに）
//
// 注意（v6.6.1）: 試合は期限（MATCH_TTL_DAYS）や容量の上限で消えるが、事前集計は消えた試合ぶんも残している。
// 作り直しは「いま保存されている試合」だけから集計するので、すでに消えた試合ぶんの統計・ティアリストは失われる。
// 失われるぶんがあるときは、--yes を付けないと実行しない。
const yes = process.argv.includes('--yes');

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
try {
  const [stored, rows] = await Promise.all([
    Match.estimatedDocumentCount(),
    ChampAgg.aggregate([{ $match: { role: 'TOTAL' } }, { $group: { _id: null, matches: { $sum: '$matches' } } }])
  ]);
  const aggregated = rows[0]?.matches || 0;
  if (aggregated > stored && !yes) {
    console.error(`作り直しを中止しました: 集計には ${aggregated} 試合ぶんが入っていますが、保存されている試合は ${stored} 件です。`);
    console.error(`作り直すと、すでに削除された約 ${aggregated - stored} 試合ぶんの統計が失われます（保持日数: ${config.matchTtlDays || '無期限'}）。`);
    console.error('それでよければ  npm run agg:rebuild -- --yes  で実行してください。');
    process.exitCode = 2;
  } else {
    const r = await rebuildAggregates();
    console.log(`作り直しました: ${r.matches} 試合 → ${r.rows} 行`);
  }
} catch (err) {
  console.error(`失敗: ${err.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
