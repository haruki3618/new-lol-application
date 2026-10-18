// ステータスシャード（ルーンページの下段）。Data Dragon の runesReforged には画像が無いので、名前だけを持つ
export const SHARD_LABELS = {
  5008: '適応能力', 5005: '攻撃速度', 5007: 'スキルヘイスト',
  5002: '物理防御', 5003: '魔法防御', 5001: '体力成長', 5011: '体力', 5010: '移動速度', 5013: '粘り強さ'
};
export const shardLabel = (id) => SHARD_LABELS[id] || '?';
