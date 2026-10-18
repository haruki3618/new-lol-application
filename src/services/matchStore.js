import Match from '../models/Match.js';
import { getMatchById } from './riotApi.js';
import { mapLimit } from '../utils/async.js';
import { slimMatch } from './slimMatch.js';
import { applyMatchToAggregates } from './aggregate.js';
import { rememberFromMatch } from './playerNames.js';

export { slimMatch };

// upsert なので、クローラーと検索が同時に同じ試合を保存しても落ちない。
// v5.2: 新しく保存できた試合だけ事前集計に加算する（二重に数えない）。band は試合を見つけた起点の帯
export async function saveMatch(raw, { band } = {}) {
  const doc = slimMatch(raw, { band });
  if (!doc) return null;

  let inserted = false;
  try {
    const res = await Match.updateOne({ matchId: doc.matchId }, { $setOnInsert: doc }, { upsert: true });
    inserted = (res?.upsertedCount || 0) > 0;
  } catch (err) {
    if (err.code !== 11000) throw err; // 同時挿入の重複キーだけ無視
  }

  if (inserted) {
    rememberFromMatch(doc).catch(() => {}); // 検索ボックスの予測用に参加者の名前を覚える（失敗しても無視）
    await applyMatchToAggregates(doc).catch((err) => console.warn(`[Agg] 加算に失敗（agg:rebuild で直せます）: ${err.message}`));
  }
  return doc;
}

// 指定IDの試合を返す。DBにないものだけ API から取得（同時実行数は小さく）
export async function ensureMatches(matchIds, { priority = 'high', concurrency = 3, band } = {}) {
  if (matchIds.length === 0) return [];

  const existing = await Match.find({ matchId: { $in: matchIds } }).lean();
  const byId = new Map(existing.map((m) => [m.matchId, m]));

  const missing = matchIds.filter((id) => !byId.has(id));

  await mapLimit(missing, concurrency, async (matchId) => {
    try {
      const raw = await getMatchById(matchId, { priority });
      const doc = await saveMatch(raw, { band });
      if (doc) byId.set(matchId, doc);
    } catch (err) {
      console.warn(`[MatchStore] ${matchId} の取得に失敗: ${err.message}`);
    }
  });

  return matchIds.map((id) => byId.get(id)).filter(Boolean);
}
