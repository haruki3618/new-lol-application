import { getMatchById } from './riotApi.js';
import { fetchRawTimeline } from './timeline.js';
import { getDdragon } from './ddragon.js';
import { cached } from '../utils/cache.js';

const SKILL_KEYS = { 1: 'Q', 2: 'W', 3: 'E', 4: 'R' };
const SHARDS = {
  5008: '適応能力', 5005: '攻撃速度', 5007: 'スキルヘイスト',
  5002: '物理防御', 5003: '魔法防御', 5001: '体力成長', 5011: '体力', 5010: '移動速度', 5013: '粘り強さ'
};

// ルーン全種・スキル順・ビルド順を、1人分だけ取得する（30分キャッシュ）
export function getMatchDetail(matchId, puuid) {
  return cached(`detail:${matchId}:${puuid}`, 30 * 60 * 1000, async () => {
    const [raw, timeline, dd] = await Promise.all([getMatchById(matchId), fetchRawTimeline(matchId), getDdragon()]);
    const me = raw.info.participants.find((p) => p.puuid === puuid);
    if (!me) return null;

    const styles = me.perks?.styles || [];
    const stat = me.perks?.statPerks || {};
    const runes = {
      primaryStyle: styles[0]?.style,
      primary: (styles[0]?.selections || []).map((s) => s.perk),
      subStyle: styles[1]?.style,
      sub: (styles[1]?.selections || []).map((s) => s.perk),
      shards: [stat.offense, stat.flex, stat.defense].map((id) => SHARDS[id] || '?')
    };

    const events = (timeline.info.frames || [])
      .flatMap((f) => f.events || [])
      .filter((e) => e.participantId === me.participantId);

    // スキル取得順（Q/W/E/R）と、Q/W/E を5レベルにした順＝最大化順
    const skills = events.filter((e) => e.type === 'SKILL_LEVEL_UP').map((e) => SKILL_KEYS[e.skillSlot]).filter(Boolean);
    const counts = { Q: 0, W: 0, E: 0 };
    const maxOrder = [];
    for (const s of skills) if (counts[s] !== undefined && ++counts[s] === 5) maxOrder.push(s);
    const rest = Object.keys(counts).filter((k) => !maxOrder.includes(k)).sort((a, b) => counts[b] - counts[a]);

    // 購入順（取り消しは除外）。完成アイテムだけに絞る
    const bought = [];
    for (const e of events) {
      if (e.type === 'ITEM_PURCHASED') bought.push({ id: e.itemId, t: e.timestamp });
      else if (e.type === 'ITEM_UNDO') {
        const idx = bought.findLastIndex((b) => b.id === e.beforeId);
        if (idx >= 0) bought.splice(idx, 1);
      }
    }
    const build = bought
      .filter((b) => {
        const it = dd.items?.[b.id];
        return it && it.final && !it.consumed && it.total >= 400;
      })
      .map((b) => ({ id: b.id, min: Math.floor(b.t / 60000) }));

    return { runes, skills, maxOrder: [...maxOrder, ...rest], build };
  });
}
