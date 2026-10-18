import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import { parseRiotId } from '../utils/riotId.js';
import { accountByRiotId } from '../services/names.js';
import { getLeagueEntriesByPUUID } from '../services/riotApi.js';
import { isDiscordWebhook } from '../services/watchMath.js';
import { MAX_WATCHES } from '../services/watchRunner.js';
import Watchlist from '../models/Watchlist.js';
import { config } from '../config/index.js';
import { webhookHash, encryptWebhook } from '../services/webhookVault.js';
import crypto from 'node:crypto';

const router = safeRouter(Router());

// 登録キーの比較（長さが違っても時間が変わらないよう、ハッシュにしてから比べる）
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
export const keyOk = (given, expected = config.watchRegisterKey) => !expected || crypto.timingSafeEqual(sha(given), sha(expected));
// v6.6.1: IPv4 は約 43 億通りしかなく、鍵なしのハッシュは総当たりで元の IP に戻せる。WEBHOOK_SECRET があれば HMAC にして戻せなくする
export const ipTag = (req, secret = config.webhookSecret) =>
  (secret
    ? crypto.createHmac('sha256', secret).update(`watch:${req.ip || ''}`)
    : crypto.createHash('sha256').update(`watch:${req.ip || ''}`)
  ).digest('hex').slice(0, 16);

// Webhook URL は秘密情報なので、画面には出さない。
// 追跡中のプレイヤー名も、既定では件数だけ（WATCH_PUBLIC_LIST=1 のときだけ一覧を出す）
async function renderPage(res, { message = null, error = null, status = 200 } = {}) {
  const total = await Watchlist.estimatedDocumentCount();
  let items = [];
  if (config.watchPublicList) {
    const rows = await Watchlist.find({}).sort({ createdAt: -1 }).limit(MAX_WATCHES * 4).lean();
    items = rows.map((w) => ({
      name: `${w.summonerName}#${w.tagLine}`,
      region: w.region || 'jp',
      tier: w.initialized ? `${w.lastTier} ${w.lastRank} ${w.lastLp}LP` : '初回確認待ち',
      consecutiveLosses: w.consecutiveLosses || 0,
      lastCheckedAt: w.lastCheckedAt || null
    }));
  }
  res.status(status).render('watch', {
    title: 'お気に入り追跡', active: 'watch', items, total, publicList: config.watchPublicList,
    needKey: Boolean(config.watchRegisterKey), max: MAX_WATCHES, message, error
  });
}

router.get('/watch', async (req, res, next) => {
  try { await renderPage(res); } catch (err) { next(err); }
});

router.post('/watch', async (req, res, next) => {
  try {
    if (!keyOk(req.body.registerKey)) return await renderPage(res, { error: '登録キーが違います。', status: 403 });
    const parsed = parseRiotId(req.body.riotId);
    const webhook = String(req.body.webhook || '').trim();
    if (!parsed) return await renderPage(res, { error: 'Riot IDは「ゲーム名#タグ」の形式で入力してください。', status: 400 });
    if (!isDiscordWebhook(webhook)) return await renderPage(res, { error: 'Discord の Webhook URL（https://discord.com/api/webhooks/…）を入力してください。', status: 400 });

    if ((await Watchlist.countDocuments({})) >= MAX_WATCHES) {
      return await renderPage(res, { error: `登録数が上限（${MAX_WATCHES}件）に達しています。`, status: 400 });
    }

    const region = req.region; // フォームで選んだリージョン（ランクを確認するサーバー）
    let account;
    try {
      account = await accountByRiotId(parsed, false, region);
    } catch (err) {
      return await renderPage(res, { error: err.status === 404 ? 'プレイヤーが見つかりませんでした。' : 'プレイヤー情報を取得できませんでした。', status: err.status === 404 ? 404 : 502 });
    }

    // 登録時点のランクを基準にする（初回の通知を出さないため initialized は runner が立てる）
    const entries = await getLeagueEntriesByPUUID(account.puuid, { region }).catch(() => []);
    const solo = entries.find((e) => e.queueType === 'RANKED_SOLO_5x5');

    let created;
    try {
      created = await Watchlist.create({
        puuid: account.puuid,
        summonerName: account.gameName,
        tagLine: account.tagLine,
        discordWebhookUrl: encryptWebhook(webhook),
        webhookHash: webhookHash(webhook),
        registeredBy: ipTag(req),
        region,
        ...(solo ? { initialized: true, lastTier: solo.tier, lastRank: solo.rank, lastLp: solo.leaguePoints, lastWins: solo.wins, lastLosses: solo.losses } : {})
      });
    } catch (err) {
      if (err.code === 11000) return await renderPage(res, { error: 'このプレイヤーは、同じ Webhook で登録済みです。', status: 409 });
      throw err;
    }
    // 件数の確認と登録の間に別のリクエストが入っても上限を超えないよう、登録後にもう一度数える
    // （同時に超えた場合は、この登録を取り消す。取り消し合って両方失敗することはあっても、上限は守られる）
    if ((await Watchlist.countDocuments()) > MAX_WATCHES) {
      await Watchlist.deleteOne({ _id: created._id });
      return await renderPage(res, { error: `登録数が上限（${MAX_WATCHES}件）に達しています。`, status: 400 });
    }
    await renderPage(res, { message: `${account.gameName}#${account.tagLine} を追跡に追加しました。` });
  } catch (err) { next(err); }
});

// 解除には、登録時と同じ Webhook URL が必要（他人の登録を消せないようにする）
router.post('/watch/remove', async (req, res, next) => {
  try {
    const parsed = parseRiotId(req.body.riotId);
    const webhook = String(req.body.webhook || '').trim();
    if (!parsed || !isDiscordWebhook(webhook)) return await renderPage(res, { error: 'Riot ID と、登録時の Webhook URL を入力してください。', status: 400 });

    const r = await Watchlist.deleteOne({
      summonerName: parsed.gameName,
      tagLine: parsed.tagLine,
      $or: [{ webhookHash: webhookHash(webhook) }, { discordWebhookUrl: webhook }] // 後者は移行前の旧データ用
    });
    if (r.deletedCount === 0) return await renderPage(res, { error: '該当する登録が見つかりません（Webhook URL が一致しない可能性があります）。', status: 404 });
    await renderPage(res, { message: '追跡を解除しました。' });
  } catch (err) { next(err); }
});

export default router;
