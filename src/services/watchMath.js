// お気に入り追跡の通知判定（DB・API に依存しない）。
// 前回の状態（Watchlist のドキュメント）と今回のランク情報を比べて、通知すべき出来事と次の状態を返す。

export const LOSS_STREAK_ALERT = 3; // この連敗数に達したら通知（以降は1敗ごとに通知しない）
export const LP_SWING_ALERT = 30; // 前回からの LP 変動がこれ以上なら通知

const TIER_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIV_ORDER = ['IV', 'III', 'II', 'I'];
const APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

// 大きいほど上位。ティア・ディビジョンの比較用（LP は含めない）
/**
 * ティア・ディビジョンの順位（大きいほど上位。LP は含めない）。
 * @param {string} tier
 * @param {string} [rank] I〜IV
 * @returns {number} 知らないティアは -1
 */
export function rankValue(tier, rank) {
  const t = TIER_ORDER.indexOf(tier);
  if (t < 0) return -1;
  return t * 10 + (APEX.has(tier) ? 0 : Math.max(0, DIV_ORDER.indexOf(rank)));
}

const label = (tier, rank) => (APEX.has(tier) ? tier : `${tier} ${rank}`);

// prev: { lastTier, lastRank, lastLp, lastWins, lastLosses, consecutiveLosses, initialized }
// entry: Riot のリーグ情報（RANKED_SOLO_5x5 の1件）または null
/**
 * 前回の状態と今回のランク情報を比べて、通知すべき出来事と次の状態を返す。
 * @param {import('../types.js').WatchState} prev
 * @param {import('../types.js').LeagueEntry | null} entry RANKED_SOLO_5x5 の 1 件。取得できなければ null（状態は変えない）
 * @returns {{events: import('../types.js').WatchEvent[], next: import('../types.js').WatchState}}
 */
export function evaluateWatch(prev, entry) {
  if (!entry) return { events: [], next: { ...prev } };

  const wins = entry.wins || 0;
  const losses = entry.losses || 0;
  const next = {
    lastTier: entry.tier,
    lastRank: entry.rank,
    lastLp: entry.leaguePoints,
    lastWins: wins,
    lastLosses: losses,
    consecutiveLosses: prev.consecutiveLosses || 0,
    initialized: true
  };

  // 初回は基準を記録するだけ。通知は出さない（登録直後の誤通知を防ぐ）
  if (!prev.initialized) {
    next.consecutiveLosses = 0;
    return { events: [], next };
  }

  const events = [];
  const dWins = wins - (prev.lastWins || 0);
  const dLosses = losses - (prev.lastLosses || 0);

  // 戦績が巻き戻った（シーズン切替など）場合は連敗だけ初期化して、差分は見ない
  if (dWins < 0 || dLosses < 0) {
    next.consecutiveLosses = 0;
    return { events, next };
  }

  // 連敗の更新。ポーリング間に複数試合ある場合は、勝ち→負けの順は分からないため
  // 「勝ちが1つも無く負けだけ増えた」ときだけ連敗を伸ばし、勝ちが混じれば保守的にリセットする
  if (dWins === 0 && dLosses > 0) next.consecutiveLosses = (prev.consecutiveLosses || 0) + dLosses;
  else if (dWins > 0) next.consecutiveLosses = 0;

  const before = prev.consecutiveLosses || 0;
  if (before < LOSS_STREAK_ALERT && next.consecutiveLosses >= LOSS_STREAK_ALERT) {
    events.push({ type: 'LOSS_STREAK', streak: next.consecutiveLosses, text: `${next.consecutiveLosses}連敗中です。少し休憩するのも手です。` });
  }

  const prevValue = rankValue(prev.lastTier, prev.lastRank);
  const nowValue = rankValue(entry.tier, entry.rank);
  if (prevValue >= 0 && nowValue > prevValue) {
    events.push({ type: 'PROMOTED', text: `${label(prev.lastTier, prev.lastRank)} → ${label(entry.tier, entry.rank)} に昇格しました！` });
  } else if (prevValue >= 0 && nowValue < prevValue) {
    events.push({ type: 'DEMOTED', text: `${label(prev.lastTier, prev.lastRank)} → ${label(entry.tier, entry.rank)} に降格しました。` });
  } else if (prevValue >= 0) {
    const diff = entry.leaguePoints - (prev.lastLp || 0);
    if (Math.abs(diff) >= LP_SWING_ALERT) {
      events.push({ type: 'LP_SWING', diff, text: `LPが ${diff > 0 ? '+' : ''}${diff} 変動しました（現在 ${entry.leaguePoints} LP）。` });
    }
  }

  return { events, next };
}

// Discord に送る本文
/**
 * Discord に送る本文。
 * @param {string} name
 * @param {import('../types.js').WatchEvent[]} events
 * @param {import('../types.js').LeagueEntry | null} entry
 * @returns {string}
 */
export function formatMessage(name, events, entry) {
  const head = `**${name}**${entry ? `（${label(entry.tier, entry.rank)} ${entry.leaguePoints}LP）` : ''}`;
  return [head, ...events.map((e) => `・${e.text}`)].join('\n');
}

// Discord の Webhook URL だけを許可する（任意のURLにサーバーからPOSTさせない = SSRF 対策）
/**
 * Discord の Webhook URL だけを許可する（任意の URL にサーバーから POST させない = SSRF 対策）。
 * @param {string} url
 * @returns {boolean}
 */
export function isDiscordWebhook(url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(u.hostname) &&
      /^\/api\/webhooks\/\d+\/[\w-]+$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}
