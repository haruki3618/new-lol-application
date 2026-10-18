const CDN = 'https://ddragon.leagueoflegends.com/cdn';

// テンプレートから画像URLや日本語名を引くためのヘルパー
// alt 用: 属性値に入っても壊れないよう、記号を取り除く
const clean = (v) => String(v || '').replace(/[<>"&]/g, '');

export function makeHelpers(dd) {
  const base = `${CDN}/${dd.version}/img`;
  return {
    version: dd.version,
    champImg: (id) => `${base}/champion/${id}.png`,
    itemImg: (id) => `${base}/item/${id}.png`,
    profileIcon: (id) => `${base}/profileicon/${id}.png`,
    cname: (id) => dd.champNames?.[id] || id,
    champIdByKey: (key) => dd.champKeyToId?.[String(key)] || null,
    spellImg: (key) => (dd.spells?.[key] ? `${base}/spell/${dd.spells[key]}` : null),
    runeImg: (id) => (dd.runes?.[id] ? `${CDN}/img/${dd.runes[id]}` : null),
    // v6.6: 画像の代替テキスト（スクリーンリーダー用。名前が引けないときは空）
    spellAlt: (key) => clean(dd.spellNames?.[key]),
    runeAlt: (id) => clean(dd.runeNames?.[id]),
    itemAlt: (id) => clean(dd.items?.[id]?.name)
  };
}
