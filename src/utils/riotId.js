// "ゲーム名#タグ" を分解する。ゲーム名に # が含まれても最後の # で分ける
export function parseRiotId(input) {
  const text = String(input || '').trim();
  const idx = text.lastIndexOf('#');
  if (idx <= 0 || idx === text.length - 1) return null;

  const gameName = text.slice(0, idx).trim();
  const tagLine = text.slice(idx + 1).trim();
  if (!gameName || !tagLine || gameName.length > 32 || tagLine.length > 10) return null;
  return { gameName, tagLine };
}
