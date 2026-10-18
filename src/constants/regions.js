// リージョン（Riot のサーバー）の定義。DB や設定に依存しない純粋なデータと関数だけを置く。
//   platform … summoner-v4 / league-v4 / spectator-v5 / champion-mastery-v4 / lol-status-v4 が使うホスト
//   cluster  … match-v5 が使う地域ホスト（americas / asia / europe / sea）
//   prefix   … 試合ID の先頭（例: JP1_123456 → jp）。試合のリージョンはここから判別する
// account-v1 は sea を持たないため、sea のリージョンは asia 経由で引く（アカウントは全リージョン共通）。
export const REGIONS = {
  jp: { label: '日本 (JP)', platform: 'jp1', cluster: 'asia', prefix: 'JP1' },
  kr: { label: '韓国 (KR)', platform: 'kr', cluster: 'asia', prefix: 'KR' },
  na: { label: '北米 (NA)', platform: 'na1', cluster: 'americas', prefix: 'NA1' },
  br: { label: 'ブラジル (BR)', platform: 'br1', cluster: 'americas', prefix: 'BR1' },
  lan: { label: '中南米北 (LAN)', platform: 'la1', cluster: 'americas', prefix: 'LA1' },
  las: { label: '中南米南 (LAS)', platform: 'la2', cluster: 'americas', prefix: 'LA2' },
  euw: { label: '西欧 (EUW)', platform: 'euw1', cluster: 'europe', prefix: 'EUW1' },
  eune: { label: '北東欧 (EUNE)', platform: 'eun1', cluster: 'europe', prefix: 'EUN1' },
  tr: { label: 'トルコ (TR)', platform: 'tr1', cluster: 'europe', prefix: 'TR1' },
  ru: { label: 'ロシア (RU)', platform: 'ru', cluster: 'europe', prefix: 'RU' },
  me: { label: '中東 (ME)', platform: 'me1', cluster: 'europe', prefix: 'ME1' },
  oce: { label: 'オセアニア (OCE)', platform: 'oc1', cluster: 'sea', prefix: 'OC1' },
  ph: { label: 'フィリピン (PH)', platform: 'ph2', cluster: 'sea', prefix: 'PH2' },
  sg: { label: 'シンガポール (SG)', platform: 'sg2', cluster: 'sea', prefix: 'SG2' },
  th: { label: 'タイ (TH)', platform: 'th2', cluster: 'sea', prefix: 'TH2' },
  tw: { label: '台湾 (TW)', platform: 'tw2', cluster: 'sea', prefix: 'TW2' },
  vn: { label: 'ベトナム (VN)', platform: 'vn2', cluster: 'sea', prefix: 'VN2' }
};

export const FALLBACK_REGION = 'jp';
export const REGION_KEYS = Object.keys(REGIONS);

export const isRegion = (v) => typeof v === 'string' && Object.hasOwn(REGIONS, v);

// 不正な値は fallback に戻す（大文字小文字は区別しない）
export function readRegion(v, fallback = FALLBACK_REGION) {
  const k = String(v ?? '').trim().toLowerCase();
  return isRegion(k) ? k : fallback;
}

export const platformHost = (region) => `${REGIONS[region]?.platform || REGIONS[FALLBACK_REGION].platform}.api.riotgames.com`;
export const clusterHost = (region) => `${REGIONS[region]?.cluster || REGIONS[FALLBACK_REGION].cluster}.api.riotgames.com`;
export const accountHost = (region) => {
  const cluster = REGIONS[region]?.cluster || REGIONS[FALLBACK_REGION].cluster;
  return `${cluster === 'sea' ? 'asia' : cluster}.api.riotgames.com`;
};

// "JP1_1234" → "jp"。判別できなければ null
const PREFIX_TO_REGION = Object.fromEntries(Object.entries(REGIONS).map(([k, r]) => [r.prefix, k]));
export function regionOfMatchId(matchId) {
  const m = /^([A-Za-z0-9]+)_\d+$/.exec(String(matchId || ''));
  return m ? PREFIX_TO_REGION[m[1].toUpperCase()] || null : null;
}

// MongoDB の matchId に対する前方一致の条件（そのリージョンの試合だけに絞る）
export const matchIdPattern = (region) => `^${REGIONS[region]?.prefix || REGIONS[FALLBACK_REGION].prefix}_`;
