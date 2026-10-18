import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import { isPuuid } from '../utils/validate.js';
import { logRequestError } from '../utils/logger.js';
import { cached, STALE_1H } from '../utils/cache.js';
import { makeHelpers } from '../utils/ddHelpers.js';
import { getPlatformStatus, getAllMasteries, getMasteryScore } from '../services/riotApi.js';
import { getDdragon } from '../services/ddragon.js';
import { config } from '../config/index.js';
import { readRegion } from '../constants/regions.js';
import { escapeHtml } from '../utils/escape.js';
import { responseStatus, userMessage } from '../utils/httpError.js';
import { isKnownPuuid } from '../services/knownPuuids.js';

const router = safeRouter(Router());
const MIN = 60 * 1000;

const fail = (res, err, backUrl = '/') => {
  logRequestError('Route:info', err, res.req);
  res.status(responseStatus(err)).render('error', { title: null, backUrl, message: userMessage(err), retryable: err.status === 429 || err.status >= 500 });
};
const jst = (t) => new Date(t).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// ホーム画面などから使う（失敗しても画面は出す）。ステータスはリージョンごと
export const getStatus = (region = config.defaultRegion) => {
  const rg = readRegion(region, config.defaultRegion);
  return cached(`status:${rg}`, 5 * MIN, () => getPlatformStatus({ region: rg }), { staleMs: STALE_1H });
};

// ---------- アイテム ----------
const ITEM_TAGS = {
  Damage: '攻撃力', SpellDamage: '魔力', CriticalStrike: 'クリティカル', AttackSpeed: '攻撃速度', LifeSteal: 'ライフスティール',
  Armor: '物理防御', SpellBlock: '魔法防御', Health: '体力', Mana: 'マナ', AbilityHaste: 'スキルヘイスト', Boots: 'ブーツ'
};
router.get('/items', async (req, res) => {
  try {
    const dd = await getDdragon();
    const tag = ITEM_TAGS[req.query.tag] ? req.query.tag : null;
    const items = Object.entries(dd.items || {})
      .map(([id, it]) => ({ id, ...it }))
      .filter((it) => it.sr && it.buyable && it.total >= 300 && (!tag || it.tags.includes(tag)))
      .sort((a, b) => b.total - a.total);
    res.render('items', { items, tag, tagLabels: ITEM_TAGS, h: makeHelpers(dd) });
  } catch (err) { fail(res, err); }
});

// ---------- サーバー状況 ----------
router.get('/status', async (req, res) => {
  try {
    const data = await getStatus(req.region);
    const pick = (arr) => (arr || []).find((x) => x.locale === 'ja_JP') || (arr || [])[0] || {};
    const conv = (m) => ({
      title: pick(m.titles).content || '(タイトルなし)',
      severity: m.incident_severity,
      status: m.maintenance_status || m.incident_severity || '',
      created: m.created_at ? jst(m.created_at) : '',
      updates: (m.updates || []).map((u) => pick(u.translations).content).filter(Boolean)
    });
    res.render('status', { name: data.name || req.region.toUpperCase(), maintenances: (data.maintenances || []).map(conv), incidents: (data.incidents || []).map(conv) });
  } catch (err) { fail(res, err); }
});

// ---------- プロフィールの遅延読み込みタブ ----------
router.get('/api/tab/:name', async (req, res) => {
  const puuid = String(req.query.puuid || '');
  if (!isPuuid(puuid)) return res.status(400).send('<div class="panel empty">不正なリクエストです。</div>');
  // v6.6.1: 同期・履歴と同じく、検索を通った PUUID だけ受け付ける（任意の PUUID で Riot API の枠を使われないように）
  if (!(await isKnownPuuid(puuid))) return res.status(403).send('<div class="panel empty">このプレイヤーは先に Riot ID で検索してください。</div>');

  try {
    if (req.params.name === 'mastery') {
      const [list, score, dd] = await Promise.all([
        cached(`mastery-all:${req.region}:${puuid}`, 10 * MIN, () => getAllMasteries(puuid, { region: req.region }), { staleMs: STALE_1H }),
        cached(`mastery-score:${req.region}:${puuid}`, 10 * MIN, () => getMasteryScore(puuid, { region: req.region })).catch(() => null),
        getDdragon()
      ]);
      return res.render('_tab_mastery', { list, score, h: makeHelpers(dd) });
    }

    res.status(404).send('<div class="panel empty">不明なタブです。</div>');
  } catch (err) {
    // v6.6.1: エラー文を HTML に入れるときは必ずエスケープする（以前は err.message をそのまま差し込んでいた）
    res.status(err.status === 404 ? 200 : responseStatus(err))
      .send(`<div class="panel empty">${err.status === 404 ? '該当するデータがありません。' : escapeHtml(userMessage(err, '取得に失敗しました。'))}</div>`);
  }
});

export default router;
