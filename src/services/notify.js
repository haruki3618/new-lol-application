import { logError } from '../utils/logger.js';

// Node 18 以降は fetch が標準で使えるため、追加パッケージは不要
export async function sendDiscordNotification(webhookUrl, message) {
  const url = webhookUrl || process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
      redirect: 'error', // v6.6.1: Webhook 以外の場所へ転送されても POST しない
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) logError('Notify', Object.assign(new Error('Discord webhook がエラーを返しました'), { status: res.status }));
  } catch (err) {
    logError('Notify', err); // Webhook の URL がメッセージに含まれていても伏せる
  }
}
