import crypto from 'node:crypto';
import { config } from '../config/index.js';

// Discord Webhook URL の保管（v6.5.1）
//   Webhook URL は「知っていれば誰でもそのチャンネルに投稿できる」秘密情報。DB が漏れても使えないようにする。
//   - webhookHash : 重複チェック・解除の照合用（HMAC-SHA256。元の URL には戻せない）
//   - 保存する URL: WEBHOOK_SECRET があれば AES-256-GCM で暗号化（"enc:v1:" 付き）。無ければ従来どおり平文
//   旧データ（平文）はそのまま読める。起動時に migrateWatchlistWebhooks() が暗号化・ハッシュ付けをする。
const PREFIX = 'enc:v1:';

const aesKey = (secret) => crypto.createHash('sha256').update(`lol-analytics-webhook:${secret}`).digest();

export function webhookHash(url, secret = config.webhookSecret) {
  return crypto.createHmac('sha256', secret || 'lol-analytics').update(String(url)).digest('hex');
}

export function encryptWebhook(url, secret = config.webhookSecret) {
  if (!secret) return url;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(secret), iv);
  const body = Buffer.concat([cipher.update(String(url), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// 平文はそのまま返し、暗号化されたものは復号する（鍵が違う・無いときは例外）
export function revealWebhook(value, secret = config.webhookSecret) {
  if (!isEncrypted(value)) return value;
  if (!secret) throw new Error('Webhook が暗号化されていますが WEBHOOK_SECRET が設定されていません');
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// 既存の登録を新しい形式へ（何度実行しても同じ結果になる）
export async function migrateWatchlistWebhooks(Watchlist, secret = config.webhookSecret) {
  let changed = 0;
  const rows = await Watchlist.find({}).select('_id discordWebhookUrl webhookHash').lean();
  for (const r of rows) {
    const set = {};
    let plain;
    try { plain = revealWebhook(r.discordWebhookUrl, secret); } catch { continue; } // 復号できないものは触らない
    if (!r.webhookHash && plain) set.webhookHash = webhookHash(plain, secret);
    if (secret && plain && !isEncrypted(r.discordWebhookUrl)) set.discordWebhookUrl = encryptWebhook(plain, secret);
    if (Object.keys(set).length) {
      await Watchlist.updateOne({ _id: r._id }, { $set: set });
      changed += 1;
    }
  }
  return changed;
}
