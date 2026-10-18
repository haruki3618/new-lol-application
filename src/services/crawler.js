import { config } from '../config/index.js';
import { v52 } from '../config/v52.js';
import { CRAWLER_TIERS } from '../constants/bands.js';
import { sleep } from '../utils/async.js';
import { getApexLeague, getLeagueEntriesByTier, getMatchIdsByPUUID } from './riotApi.js';
import { ensureMatches } from './matchStore.js';
import { enforceRetention } from './storage.js';

const region = config.crawlerRegion; // クローラーが試合を集めるリージョン（CRAWLER_REGION。既定は DEFAULT_REGION）

// /healthz で見られる状態
export const crawlerStatus = { running: false, region: config.crawlerRegion, queued: 0, checked: 0, lastAt: null, bands: {} };

const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

// 1つの帯の起点プレイヤーを集める（マスター以上は順位表、それ以下は entries/{queue}/{tier}/{division}）
async function seedBand(band) {
  const spec = CRAWLER_TIERS[band];
  if (!spec) {
    console.warn(`[Crawler] 不明な帯 ${band} は無視します（使えるのは ${Object.keys(CRAWLER_TIERS).join(', ')}）`);
    return [];
  }
  const puuids = [];
  try {
    if (spec.apex) {
      for (const tier of spec.apex) {
        const league = await getApexLeague(tier, { priority: 'low', region });
        for (const e of league.entries || []) if (e.puuid) puuids.push(e.puuid);
      }
    } else {
      for (const division of ['I', 'II', 'III', 'IV']) {
        const page = 1 + Math.floor(Math.random() * 3); // 毎回ちがうページから取り、同じ人ばかりにならないようにする
        const list = await getLeagueEntriesByTier('RANKED_SOLO_5x5', spec.tier, division, page, { priority: 'low', region });
        for (const e of list || []) if (e.puuid) puuids.push(e.puuid);
      }
    }
  } catch (err) {
    console.warn(`[Crawler] ${band} の起点の取得に失敗: ${err.message}`);
  }
  return shuffle(puuids).slice(0, v52.crawlerSeedsPerBand);
}

// 帯ごとの起点を交互に並べる（どの帯も均等に集まる）。各要素は { puuid, band }
async function seedAll() {
  const lists = [];
  for (const band of v52.crawlerBands) {
    lists.push((await seedBand(band)).map((puuid) => ({ puuid, band })));
  }
  const out = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

// 確認済みの起点を除く（純粋関数）
export const freshSeeds = (seeds, visited) => seeds.filter((s) => !visited.has(s.puuid));

// 起点をすべて確認し終えたときの待ち時間。新しい試合がたまるのを待つ（v6.6.1）
export const IDLE_WAIT_MS = 5 * 60 * 1000;

// 停止の合図を見ながら待つ（長く待っている間も止められる）
async function sleepUnlessStopped(ms, shouldStop) {
  for (let left = ms; left > 0 && !shouldStop(); left -= 1000) await sleep(Math.min(1000, left));
}

// 保存数・容量の上限を超えていたら、古い試合から削除する（services/storage.js）。事前集計は減らさない
const purge = () => enforceRetention();

// 起点の帯ごとに試合を集める。v5.2 からは参加者をたどって広げず、起点だけを入れ替えながら集める
// （たどると帯のラベルが混ざるため。ランクの試合は同じ帯のプレイヤー同士で組まれるので、起点の帯が近似になる）
export async function runCrawler(shouldStop = () => false) {
  let queue = await seedAll();
  const visited = new Set();

  if (queue.length === 0) {
    console.error('[Crawler] 起点のプレイヤーを取得できませんでした。APIキーを確認してください。');
    return;
  }
  console.log(`[Crawler] 開始（リージョン: ${region} / 帯: ${v52.crawlerBands.join(', ')} / 起点 ${queue.length} 人）`);
  crawlerStatus.running = true;

  while (!shouldStop()) {
    const item = queue.shift();
    if (!item) {
      console.log('[Crawler] 待ち行列が空になりました。起点を取り直します');
      if (visited.size > 50000) visited.clear();
      queue = freshSeeds(await seedAll(), visited);
      if (queue.length === 0) {
        // v6.6.1: 取り直した起点がすべて確認済みだと、以前は 10 秒おきに順位表の API を呼び続けて低優先の枠を使い切り、
        // ユーザー操作に使える枠まで減らしていた。確認済みを忘れて、しばらく待ってからやり直す
        console.log(`[Crawler] 起点はすべて確認済みです。${Math.round(IDLE_WAIT_MS / 60000)} 分待ってから最初からやり直します`);
        visited.clear();
        await sleepUnlessStopped(IDLE_WAIT_MS, shouldStop);
      } else {
        await sleep(1000);
      }
      continue;
    }
    if (visited.has(item.puuid)) continue;
    visited.add(item.puuid);

    try {
      const ids = await getMatchIdsByPUUID(item.puuid, {
        count: config.crawlerMatchesPerPlayer,
        queue: config.crawlerQueue,
        priority: 'low',
        region
      });
      const docs = await ensureMatches(ids, { priority: 'low', concurrency: 2, band: item.band });

      crawlerStatus.queued = queue.length;
      crawlerStatus.checked += 1;
      crawlerStatus.bands[item.band] = (crawlerStatus.bands[item.band] || 0) + 1;
      crawlerStatus.lastAt = new Date().toISOString();
      console.log(`[Crawler] ${item.band}: ${docs.length} 試合を確認 / 待ち ${queue.length} 人`);
      await purge();
    } catch (err) {
      console.warn(`[Crawler] スキップ: ${err.message}`);
      await sleep(1000);
    }
  }
  crawlerStatus.running = false;
  console.log('[Crawler] 停止しました');
}
