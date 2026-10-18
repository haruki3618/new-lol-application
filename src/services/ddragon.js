import axios from 'axios';
import { cached } from '../utils/cache.js';
import { readPersistent, writePersistent } from '../utils/persistentCache.js';

// 最後の手段の固定値（versions.json を取得できず、保存済みの値も無いときだけ使う）。パッチ 26.20（2026-10-07）時点。
// Data Dragon の版は「パッチの年 − 10 . パッチ番号 . 1」（26.20 → 16.20.1）。シーズン中に古くなるので、年に数回は更新する（docs/RELEASE_CHECKLIST.md）。
const FALLBACK_VERSION = '16.20.1';
const HOUR = 60 * 60 * 1000;
const CDN = 'https://ddragon.leagueoflegends.com/cdn';

// 最後に取得に成功したバージョンを覚えておく（失敗したときに古い固定値へ戻らないため）
let lastGood = null;
const VERSION_KEY = 'ddragon-last-version';

// 画像表示用の Data Dragon の最新バージョンを取得（6時間キャッシュ）
export async function getDdragonVersion() {
  try {
    const version = await cached('ddragon-version', 6 * HOUR, async () => {
      const res = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json', {
        timeout: 5000
      });
      return res.data[0];
    });
    if (version !== lastGood) {
      lastGood = version;
      writePersistent(VERSION_KEY, version, 365 * 24 * HOUR).catch(() => {});
    }
    return version;
  } catch {
    if (lastGood) return lastGood;
    const saved = await readPersistent(VERSION_KEY);
    if (saved) {
      lastGood = saved;
      return saved;
    }
    console.warn(`[DataDragon] バージョンを取得できず、保存済みの値もないため ${FALLBACK_VERSION} を使います`);
    return FALLBACK_VERSION;
  }
}

async function loadStaticData(version) {
  const get = (url) => axios.get(url, { timeout: 8000 }).then((r) => r.data);
  const [runeStyles, spellJson, champJson, itemJson] = await Promise.all([
    get(`${CDN}/${version}/data/en_US/runesReforged.json`),
    get(`${CDN}/${version}/data/en_US/summoner.json`),
    get(`${CDN}/${version}/data/ja_JP/champion.json`),
    get(`${CDN}/${version}/data/ja_JP/item.json`)
  ]);

  const runes = {}; // ルーンID・系統ID → 画像パス
  const runeNames = {}; // ルーンID・系統ID → 名前（画像の alt 用）
  for (const style of runeStyles) {
    runes[style.id] = style.icon;
    runeNames[style.id] = style.name;
    for (const slot of style.slots) {
      for (const rune of slot.runes) {
        runes[rune.id] = rune.icon;
        runeNames[rune.id] = rune.name;
      }
    }
  }

  const spells = {}; // スペルのキー番号 → 画像ファイル名
  const spellNames = {}; // スペルのキー番号 → 名前（画像の alt 用）
  for (const s of Object.values(spellJson.data)) {
    spells[Number(s.key)] = s.image.full;
    spellNames[Number(s.key)] = s.name;
  }

  const champNames = {}; // 画像用ID(MonkeyKing) → 日本語名
  const champKeyToId = {}; // 数値ID(62) → 画像用ID
  const champTitles = {}; // 画像用ID → 二つ名
  const champTags = {}; // 画像用ID → ['Fighter', 'Assassin'] など（チーム構成の分析用）
  const champInfo = {}; // 画像用ID → { attack, defense, magic, difficulty }
  for (const c of Object.values(champJson.data)) {
    champNames[c.id] = c.name;
    champKeyToId[c.key] = c.id;
    champTitles[c.id] = c.title;
    champTags[c.id] = c.tags || [];
    champInfo[c.id] = c.info || {};
  }

  // アイテム: 完成品か・消耗品か・合計金額（ビルド順・人気アイテムの絞り込み用）
  const items = {};
  for (const [id, it] of Object.entries(itemJson.data)) {
    items[id] = {
      name: it.name,
      total: it.gold?.total || 0,
      final: !it.into || it.into.length === 0,
      consumed: Boolean(it.consumed),
      plain: it.plaintext || '',
      desc: String(it.description || '').replace(/<br\s*\/?>/gi, ' / ').replace(/<[^>]+>/g, ''),
      tags: it.tags || [],
      sr: Boolean(it.maps?.['11']),
      buyable: it.gold?.purchasable !== false,
      from: it.from || [],
      into: it.into || []
    };
  }

  return { runes, runeNames, spells, spellNames, champNames, champKeyToId, champTitles, champTags, champInfo, items };
}

// バージョン・ルーン・スペル・チャンピオン名などをまとめて返す。取得に失敗しても画面は出せるよう空で返す
export async function getDdragon() {
  const version = await getDdragonVersion();
  try {
    const data = await cached(`dd-static:${version}`, 6 * HOUR, () => loadStaticData(version));
    return { version, ...data };
  } catch (err) {
    console.warn(`[DDragon] 静的データの取得に失敗: ${err.message}`);
    return { version, runes: {}, runeNames: {}, spells: {}, spellNames: {}, champNames: {}, champKeyToId: {}, champTitles: {}, champTags: {}, champInfo: {}, items: {} };
  }
}

// チャンピオン1体の詳細（スキル・パッシブ・ロア・スキン）。表示するときだけ取得し、6時間キャッシュ
export async function getChampionDD(id) {
  const version = await getDdragonVersion();
  return cached(`dd-champ:${version}:${id}`, 6 * HOUR, async () => {
    const res = await axios.get(`${CDN}/${version}/data/ja_JP/champion/${id}.json`, { timeout: 8000 });
    const c = res.data.data[id];
    const clean = (t) => String(t || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
    return {
      id: c.id,
      name: c.name,
      title: c.title,
      lore: c.lore,
      tags: c.tags,
      resource: c.partype,
      stats: c.stats,
      allyTips: c.allytips || [],
      enemyTips: c.enemytips || [],
      passive: { name: c.passive.name, desc: clean(c.passive.description), img: c.passive.image.full },
      spells: c.spells.map((s, i) => ({
        key: ['Q', 'W', 'E', 'R'][i],
        name: s.name,
        desc: clean(s.description),
        cooldown: s.cooldownBurn,
        cost: s.costBurn,
        range: s.rangeBurn,
        img: s.image.full
      })),
      skins: c.skins.map((s) => ({ num: s.num, name: s.name === 'default' ? c.name : s.name }))
    };
  });
}
