// チーム構成の分析。Data Dragon のタグ（Fighter など）と攻撃/魔力の評価値から出す「目安」で、
// 実際のダメージ量ではない。
const TAG_LABELS = {
  Fighter: 'ファイター',
  Tank: 'タンク',
  Mage: 'メイジ',
  Assassin: 'アサシン',
  Marksman: 'マークスマン',
  Support: 'サポート'
};

// champIds: Data Dragon 上のID（例: 'MonkeyKing'）の配列
export function analyzeComp(champIds, dd) {
  const tagCount = {};
  let ad = 0;
  let ap = 0;
  let known = 0;

  for (const id of champIds) {
    const tags = dd?.champTags?.[id];
    const info = dd?.champInfo?.[id];
    if (!tags || !info) continue;
    known += 1;
    tagCount[tags[0]] = (tagCount[tags[0]] || 0) + 1; // 先頭のタグを主な役割とみなす
    ad += info.attack || 0;
    ap += info.magic || 0;
  }
  if (known === 0) return null;

  const total = ad + ap;
  const apShare = total > 0 ? Math.round((ap / total) * 100) : 50;
  const adShare = 100 - apShare;
  const damageLabel = apShare < 30 ? '物理寄り' : apShare > 70 ? '魔法寄り' : 'バランス型';

  const count = (tag) => tagCount[tag] || 0;
  const frontline = count('Tank') + count('Fighter');
  const warnings = [];
  if (frontline === 0) warnings.push('前衛（タンク・ファイター）がいません。前線を張る役が不足しがちです。');
  else if (frontline === 1 && known >= 5) warnings.push('前衛が1人だけです。集団戦で前に出る役が足りない可能性があります。');
  if (count('Marksman') + count('Mage') === 0) warnings.push('持続火力役（メイジ・マークスマン）がいません。');
  if (count('Assassin') >= 3) warnings.push('アサシンが多く、集団戦で押し負けやすい構成です。');
  if (known >= 4 && adShare >= 75) warnings.push('物理ダメージに偏っており、相手に物理防御を積まれやすい構成です。');
  if (known >= 4 && apShare >= 75) warnings.push('魔法ダメージに偏っており、相手に魔法防御を積まれやすい構成です。');

  const tags = Object.entries(tagCount)
    .map(([tag, n]) => ({ tag, label: TAG_LABELS[tag] || tag, count: n }))
    .sort((a, b) => b.count - a.count);

  return { tags, adShare, apShare, damageLabel, warnings };
}
