export const QUEUE_NAMES = {
  400: 'ノーマル（ドラフト）',
  420: 'ランク（ソロ）',
  430: 'ノーマル（ブラインド）',
  440: 'ランク（フレックス）',
  450: 'ARAM',
  490: 'クイックプレイ',
  700: 'クラッシュ',
  900: 'URF',
  1700: 'アリーナ',
  1900: 'URF'
};

// 戦績画面のモード絞り込み（id: null は「すべて」）
export const QUEUE_FILTERS = [
  { id: null, label: 'すべて' },
  { id: 420, label: 'ランク（ソロ）' },
  { id: 440, label: 'ランク（フレックス）' },
  { id: 400, label: 'ノーマル' },
  { id: 450, label: 'ARAM' }
];
