// 「帯」はクローラーが試合を見つけた起点プレイヤーのランク帯（試合の平均ランクではなく近似）
export const BAND_LABELS = {
  MASTER_PLUS: 'マスター以上', DIAMOND: 'ダイヤモンド', EMERALD: 'エメラルド',
  PLATINUM: 'プラチナ', GOLD: 'ゴールド', SILVER: 'シルバー', UNKNOWN: '帯不明（検索・旧データ）'
};

// 画面の絞り込み。「ダイヤ以上」は MASTER_PLUS + DIAMOND の合算。all は帯不明も含む
export const BAND_GROUPS = {
  all: { label: 'すべて', bands: null },
  master: { label: 'マスター以上', bands: ['MASTER_PLUS'] },
  diamond: { label: 'ダイヤ以上', bands: ['MASTER_PLUS', 'DIAMOND'] },
  emerald: { label: 'エメラルド以上', bands: ['MASTER_PLUS', 'DIAMOND', 'EMERALD'] }
};
export const readBandGroup = (v) => (Object.hasOwn(BAND_GROUPS, v) ? v : 'all');

// クローラーの起点の取り方（apex は順位表 API、tier は entries/{queue}/{tier}/{division}）
export const CRAWLER_TIERS = {
  MASTER_PLUS: { apex: ['challenger', 'grandmaster', 'master'] },
  DIAMOND: { tier: 'DIAMOND' },
  EMERALD: { tier: 'EMERALD' },
  PLATINUM: { tier: 'PLATINUM' },
  GOLD: { tier: 'GOLD' },
  SILVER: { tier: 'SILVER' }
};
