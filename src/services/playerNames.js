import mongoose from 'mongoose';
import PlayerName from '../models/PlayerName.js';
import Match from '../models/Match.js';
import { regionOfMatchId } from '../constants/regions.js';

// 検索ボックスの予測用の「見かけたプレイヤー名」を覚える・引く。DB に繋がっていないときは何もしない

const ready = () => mongoose.connection.readyState === 1;
let lastWarn = 0;
const warn = (err) => {
  if (Date.now() - lastWarn > 60000) {
    lastWarn = Date.now();
    console.warn(`[Players] プレイヤー名を保存できませんでした（続行します）: ${err.message}`);
  }
};

// 検索用の正規化（全角・半角、大文字・小文字を区別しない）
export const normalizeName = (s) => String(s ?? '').normalize('NFKC').toLowerCase().trim();
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 入力 "ゲーム名#タグ" の途中までを、名前とタグに分ける。ゲーム名に # が含まれても最後の # で分ける（riotId.js と同じ）
export function parseSuggestQuery(input) {
  const text = normalizeName(input);
  if (!text || text.length > 40) return null;
  const idx = text.lastIndexOf('#');
  const name = idx >= 0 ? text.slice(0, idx).trim() : text;
  const tag = idx >= 0 ? text.slice(idx + 1).trim() : '';
  if (!name) return null;
  // 名前だけのときは2文字以上（1文字だと候補が多すぎる）。タグまで打っていれば1文字でも検索する
  if (!tag && [...name].length < 2) return null;
  return { name, tag };
}

const toDoc = (p, region, now) => {
  const gameName = String(p.gameName || '').trim();
  const tagLine = String(p.tagLine || '').trim();
  if (!p.puuid || !gameName || !tagLine) return null;
  return { puuid: p.puuid, region, gameName, tagLine, n: normalizeName(gameName), t: normalizeName(tagLine), seenAt: now };
};

const toOp = (d, hit) => ({
  updateOne: {
    filter: { puuid: d.puuid, region: d.region },
    update: {
      $set: { gameName: d.gameName, tagLine: d.tagLine, n: d.n, t: d.t, seenAt: d.seenAt },
      ...(hit ? { $inc: { hits: 1 } } : { $setOnInsert: { hits: 0 } })
    },
    upsert: true
  }
});

// 同じ人を短時間に何度も書き込まない（クローラーは同じプレイヤーを何度も見るため）
const recent = new Map();
const RECENT_MS = 6 * 60 * 60 * 1000;
const RECENT_MAX = 50000;

// 試合の参加者を覚える（保存できた試合ごとに呼ぶ）
export async function rememberFromMatch(doc) {
  if (!ready() || !doc) return;
  const region = regionOfMatchId(doc.matchId);
  if (!region) return;
  const now = new Date();
  const ops = [];
  for (const p of doc.participants || []) {
    const d = toDoc({ puuid: p.puuid, gameName: p.riotIdGameName, tagLine: p.riotIdTagline }, region, now);
    if (!d) continue;
    const key = `${region}:${d.puuid}`;
    if (now - (recent.get(key) || 0) < RECENT_MS) continue;
    if (recent.size >= RECENT_MAX) recent.clear();
    recent.set(key, +now);
    ops.push(toOp(d, false));
  }
  if (!ops.length) return;
  try {
    await PlayerName.bulkWrite(ops, { ordered: false });
  } catch (err) {
    warn(err);
  }
}

// 検索されたプレイヤーを覚える（人気順に使うので、検索のたびに hits を増やす）
export async function rememberSearched(account, region) {
  if (!ready() || !account || !region) return;
  const d = toDoc(account, region, new Date());
  if (!d) return;
  try {
    await PlayerName.bulkWrite([toOp(d, true)], { ordered: false });
  } catch (err) {
    warn(err);
  }
}

// 前方一致（なければ部分一致）で候補を返す。人気（検索回数）→ 最近見かけた順
export async function suggestPlayers(input, region, limit = 8) {
  const q = parseSuggestQuery(input);
  if (!q || !ready()) return [];
  const base = { region };
  if (q.tag) base.t = { $regex: `^${escapeRegex(q.tag)}` };
  const pick = (rows) => rows.map((r) => ({ riotId: `${r.gameName}#${r.tagLine}`, gameName: r.gameName, tagLine: r.tagLine }));
  const sort = { hits: -1, seenAt: -1 };

  const front = await PlayerName.find({ ...base, n: { $regex: `^${escapeRegex(q.name)}` } })
    .sort(sort).limit(limit).select('gameName tagLine').maxTimeMS(500).lean();
  let out = pick(front);

  // 前方一致が少ないときだけ部分一致で補う（名前の途中を覚えている場合）
  if (out.length < limit && [...q.name].length >= 3) {
    const ids = new Set(out.map((o) => o.riotId));
    const mid = await PlayerName.find({ ...base, n: { $regex: escapeRegex(q.name) } })
      .sort(sort).limit(limit * 2).select('gameName tagLine').maxTimeMS(500).lean();
    for (const o of pick(mid)) {
      if (out.length >= limit) break;
      if (!ids.has(o.riotId)) out.push(o);
    }
  }
  return out;
}

// 名前の一覧が空で、試合が保存されているとき（このバージョンへの更新直後など）、保存済みの試合から作る。API は使わない
let building = null;
export function ensurePlayerNames({ maxMatches = 20000 } = {}) {
  if (building) return building;
  building = (async () => {
    try {
      if ((await PlayerName.estimatedDocumentCount()) > 0) return 0;
      if ((await Match.estimatedDocumentCount()) === 0) return 0;
      console.log('[Players] 保存済みの試合からプレイヤー名の候補を作成します（初回のみ）…');
      const seen = new Map();
      const now = new Date();
      const cursor = Match.find({}).sort({ gameCreation: -1 }).limit(maxMatches).select('matchId participants').lean().cursor();
      for await (const m of cursor) {
        const region = regionOfMatchId(m.matchId);
        if (!region) continue;
        for (const p of m.participants || []) {
          const d = toDoc({ puuid: p.puuid, gameName: p.riotIdGameName, tagLine: p.riotIdTagline }, region, now);
          if (d && !seen.has(`${region}:${d.puuid}`)) seen.set(`${region}:${d.puuid}`, d);
        }
      }
      const ops = [...seen.values()].map((d) => toOp(d, false));
      for (let i = 0; i < ops.length; i += 1000) await PlayerName.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
      console.log(`[Players] ${ops.length} 人分の候補を作成しました`);
      return ops.length;
    } catch (err) {
      console.warn(`[Players] 候補の作成に失敗: ${err.message}`);
      return 0;
    } finally {
      building = null;
    }
  })();
  return building;
}
