import './index.js'; // dotenv を先に読み込むため
// v5.2 で追加した設定（すべて任意。.env に書かなければ既定値）
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const v52 = {
  // クローラーが起点にする帯（MASTER_PLUS,DIAMOND,EMERALD,PLATINUM,GOLD,SILVER）
  crawlerBands: String(process.env.CRAWLER_BANDS || 'MASTER_PLUS,DIAMOND,EMERALD')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  crawlerSeedsPerBand: num(process.env.CRAWLER_SEEDS_PER_BAND, 150),
  // ティアリスト: これ未満の試合数は「データ不足」
  tierMinGames: num(process.env.TIER_MIN_GAMES, 30),
  // スコア基準: チャンピオン×ロール / ロール全体 の最低試合数
  baselineMinChamp: num(process.env.BASELINE_MIN_CHAMP, 30),
  baselineMinRole: num(process.env.BASELINE_MIN_ROLE, 200)
};
