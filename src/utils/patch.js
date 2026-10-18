// "15.3.123.4567" → "15.3"
export function patchOf(version) {
  const m = /^(\d+)\.(\d+)/.exec(version || '');
  return m ? `${m[1]}.${m[2]}` : null;
}

// 新しいパッチが先頭に来る並び順
export function comparePatchDesc(a, b) {
  const [a1, a2] = a.split('.').map(Number);
  const [b1, b2] = b.split('.').map(Number);
  return b1 - a1 || b2 - a2;
}
