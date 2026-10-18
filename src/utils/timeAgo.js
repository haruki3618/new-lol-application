// 「3分前」「2日前」のような相対時間（日本語）。画面（profile.ejs / _match.ejs）が使う
export function timeAgo(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '不明';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'たった今';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}時間前`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}日前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}か月前`;
  return `${Math.floor(d / 365)}年前`;
}
