// 週ごとのサマリー（v6.11.0）の計算部分。DB に依存しない純粋な関数。
// 試合は既定で 30 日で消えるため、診断・レポートは 1 か月より長い推移を出せなかった。
// 週ごとの合計だけを別に長く（既定 365 日）残しておけば、試合が消えたあとも長期の推移を見られる。
const DAY = 86400000;
const JST = 9 * 3600000;
const REMAKE_SEC = 300;

// その試合が属する週の開始（日本時間の月曜 0:00）を UTC のミリ秒で返す
export function weekStartOf(t) {
  const day = Math.floor((t + JST) / DAY); // 日本時間の日付（1970-01-01 からの日数）
  const dow = (day + 3) % 7; // 1970-01-01 は木曜。月曜 = 0
  return (day - dow) * DAY - JST;
}

export const weekLabel = (weekStart) => new Date(weekStart + JST).toISOString().slice(0, 10);

// 試合（診断用の形）を (週, キュー) ごとの合計にする。リメイクは除く
export function buildWeeks(games) {
  const by = new Map();
  for (const g of games || []) {
    if (!g || !Number.isFinite(g.t) || (g.dur > 0 && g.dur < REMAKE_SEC)) continue;
    const weekStart = weekStartOf(g.t);
    const queueId = Number(g.q) || 0;
    const key = `${weekStart}:${queueId}`;
    const w = by.get(key) || {
      weekStart, queueId, games: 0, wins: 0, kills: 0, deaths: 0, assists: 0, cs: 0, vision: 0, damage: 0, gold: 0, durationSec: 0, champs: new Map()
    };
    w.games += 1;
    if (g.win) w.wins += 1;
    w.kills += g.k || 0; w.deaths += g.d || 0; w.assists += g.a || 0;
    w.cs += g.cs || 0; w.vision += g.vis || 0; w.damage += g.dmg || 0; w.gold += g.gold || 0;
    w.durationSec += g.dur > 0 ? g.dur : 0;
    if (g.champ) {
      const c = w.champs.get(g.champ) || { name: g.champ, games: 0, wins: 0 };
      c.games += 1;
      if (g.win) c.wins += 1;
      w.champs.set(g.champ, c);
    }
    by.set(key, w);
  }
  return [...by.values()].map((w) => ({ ...w, champs: topChamps(w.champs.values()) })).sort((a, b) => b.weekStart - a.weekStart);
}

const topChamps = (iter, k = 5) => [...iter].sort((a, b) => b.games - a.games || a.name.localeCompare(b.name)).slice(0, k);

// すでに保存されている週より少ない試合数で上書きしない（古い試合が消えたあとに、一部の週を再計算して縮めないため）
export const shouldReplace = (existing, next) => !existing || next.games >= existing.games;

// 保存された週の一覧を、キューで絞って（null なら全キュー合算）週ごとにまとめ、表示用の値を付ける。新しい週が先
export function collapseWeeks(weeks, queueId = null) {
  const by = new Map();
  for (const w of weeks || []) {
    if (queueId !== null && (Number(w.queueId) || 0) !== queueId) continue;
    const x = by.get(w.weekStart) || { weekStart: w.weekStart, games: 0, wins: 0, kills: 0, deaths: 0, assists: 0, cs: 0, vision: 0, damage: 0, gold: 0, durationSec: 0, champs: new Map() };
    for (const f of ['games', 'wins', 'kills', 'deaths', 'assists', 'cs', 'vision', 'damage', 'gold', 'durationSec']) x[f] += w[f] || 0;
    for (const c of w.champs || []) {
      const y = x.champs.get(c.name) || { name: c.name, games: 0, wins: 0 };
      y.games += c.games || 0; y.wins += c.wins || 0;
      x.champs.set(c.name, y);
    }
    by.set(w.weekStart, x);
  }
  const r1 = (n) => Math.round(n * 10) / 10;
  return [...by.values()].sort((a, b) => b.weekStart - a.weekStart).map((x) => {
    const min = x.durationSec / 60;
    return {
      weekStart: x.weekStart, label: weekLabel(x.weekStart), games: x.games, wins: x.wins,
      winRate: x.games ? r1((x.wins / x.games) * 100) : 0,
      kda: Math.round(((x.kills + x.assists) / Math.max(1, x.deaths)) * 100) / 100,
      csMin: min ? r1(x.cs / min) : null,
      visMin: min ? Math.round((x.vision / min) * 100) / 100 : null,
      champs: topChamps(x.champs.values(), 3)
    };
  });
}
