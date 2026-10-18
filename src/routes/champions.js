import { Router } from 'express';
import { safeRouter } from '../utils/asyncRoutes.js';
import { isChampId, validPatch } from '../utils/validate.js';
import { logRequestError } from '../utils/logger.js';
import { QUEUE_FILTERS } from '../constants/queues.js';
import { ROLE_LABELS } from '../constants/roles.js';
import { BAND_GROUPS, readBandGroup } from '../constants/bands.js';
import { v52 } from '../config/v52.js';
import { makeHelpers } from '../utils/ddHelpers.js';
import { getDdragon, getChampionDD } from '../services/ddragon.js';
import { getPatches, getChampionDetail } from '../services/championStats.js';
import { getAggPatches, getChampionAggTable, getObjectiveStats } from '../services/aggregate.js';
import { shardLabel } from '../constants/runes.js';
import { loadChampionRows, SCAN_LIMIT } from '../services/championBuild.js';
import { rolesOf, buildReport, buildMatchups, headToHead, MIN_GAMES } from '../services/buildMath.js';
import { buildTierList } from '../services/tierList.js';
import insightsRouter from './insights.js';
import { responseStatus, userMessage } from '../utils/httpError.js';

const router = safeRouter(Router());
router.use(insightsRouter);

const QUEUES = QUEUE_FILTERS.filter((q) => q.id);
const TAG_LABELS = { Fighter: 'ファイター', Tank: 'タンク', Mage: 'メイジ', Assassin: 'アサシン', Marksman: 'マークスマン', Support: 'サポート' };
const SORTS = { winRate: '勝率', pickRate: 'ピック率', banRate: 'バン率', kda: 'KDA', games: '試合数' };
const MIN_OPTIONS = [1, 5, 10, 30, 50, 100];
const BUILD_MIN_OPTIONS = [3, 5, 10, 20]; // ビルド・対面の最低試合数
const MATCHUP_SORTS = { games: '試合数', winRate: '勝率が高い順', worst: '勝率が低い順' };
const validRole = (r) => (Object.hasOwn(ROLE_LABELS, r) ? r : null);
const readQueue = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return QUEUES.some((q) => q.id === n) ? n : fallback;
};

function fail(res, err, backUrl = '/') {
  logRequestError('Route:champions', err, res.req);
  res.status(responseStatus(err)).render('error', { title: null, backUrl, message: userMessage(err, '集計を読み込めませんでした。'), retryable: err.status === 429 || err.status >= 500 });
}

// チャンピオン統計 / 図鑑
router.get('/champions', async (req, res) => {
  try {
    const dd = await getDdragon();
    const h = makeHelpers(dd);
    const view = req.query.view === 'all' ? 'all' : 'stats';

    if (view === 'all') {
      const tag = Object.hasOwn(TAG_LABELS, req.query.tag) ? req.query.tag : null;
      const allChamps = Object.keys(dd.champNames || {})
        .filter((id) => !tag || (dd.champTags[id] || []).includes(tag))
        .map((id) => ({ id, name: dd.champNames[id], title: dd.champTitles[id] || '' }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      return res.render('champions', {
        view, h, allChamps, tagLabels: TAG_LABELS, selected: { tag, queueId: null, patch: null, role: null, min: 10, sort: 'winRate', band: 'all' },
        queues: QUEUES, bandGroups: BAND_GROUPS, patches: [], minOptions: MIN_OPTIONS, sorts: SORTS, roleLabels: ROLE_LABELS,
        rows: [], totalMatches: 0, banMatches: 0
      });
    }

    const queueId = readQueue(req.query.queue, null);
    const band = readBandGroup(req.query.band);
    const role = validRole(req.query.role);
    const min = MIN_OPTIONS.includes(Number(req.query.min)) ? Number(req.query.min) : 10;
    const sort = Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : 'winRate';
    const patch = validPatch(req.query.patch);

    const region = req.region;
    const [patches, table] = await Promise.all([
      getAggPatches(queueId, region),
      getChampionAggTable({ queueId, patch, band, role, region }, dd.champKeyToId)
    ]);
    const key = { winRate: 'winRate', pickRate: 'pickRate', banRate: 'banRate', kda: 'kdaValue', games: 'games' }[sort];
    const rows = table.rows
      .filter((r) => r.games >= min)
      .sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || b.games - a.games);

    res.render('champions', {
      view, h, allChamps: [], tagLabels: TAG_LABELS,
      selected: { queueId, patch, role, min, sort, band, tag: null },
      queues: QUEUES, bandGroups: BAND_GROUPS, patches, minOptions: MIN_OPTIONS, sorts: SORTS, roleLabels: ROLE_LABELS,
      rows, totalMatches: table.totalMatches, banMatches: table.banMatches
    });
  } catch (err) { fail(res, err); }
});

// ティアリスト（事前集計だけを使う）
router.get('/tierlist', async (req, res) => {
  try {
    const dd = await getDdragon();
    const h = makeHelpers(dd);
    const queueId = readQueue(req.query.queue, 420) || 420;
    const band = readBandGroup(req.query.band);
    const role = validRole(req.query.role);

    const region = req.region;
    const patches = await getAggPatches(queueId, region);
    const patch = validPatch(req.query.patch) && patches.includes(req.query.patch) ? req.query.patch : patches[0] || null;
    const prevPatch = patch ? patches[patches.indexOf(patch) + 1] || null : null;

    const empty = { tiers: { S: [], A: [], B: [], C: [] }, insufficient: [], eligible: 0, reliable: false };
    let totalMatches = 0;
    let list = empty;
    let objectives = { matches: 0, items: [] };
    const minGames = role ? Math.ceil(v52.tierMinGames / 2) : v52.tierMinGames;

    if (patch) {
      const [cur, prev, obj] = await Promise.all([
        getChampionAggTable({ queueId, patch, band, role, region }, dd.champKeyToId),
        prevPatch ? getChampionAggTable({ queueId, patch: prevPatch, band, role, region }, dd.champKeyToId) : { rows: [] },
        getObjectiveStats({ queueId, patch, band, region })
      ]);
      totalMatches = cur.totalMatches;
      list = buildTierList(cur.rows, prev.rows, { minGames });
      objectives = obj;
    }

    res.render('tierlist', {
      h, patch, patches, prevPatch, totalMatches, minGames, list, objectives,
      selected: { queueId, role, band }, queues: QUEUES, bandGroups: BAND_GROUPS, roleLabels: ROLE_LABELS
    });
  } catch (err) { fail(res, err); }
});

// チャンピオン詳細（/champion/Ahri。数値ID でも開ける）
// v6.4: おすすめビルド（ルーン・スペル・アイテム）と対面を、ロール・帯・最低試合数で切り替えられる
router.get('/champion/:name', async (req, res) => {
  const raw = String(req.params.name || '');
  if (!isChampId(raw)) {
    return res.status(404).render('error', { title: null, backUrl: '/champions', message: 'チャンピオンが見つかりませんでした。' });
  }
  try {
    const dd = await getDdragon();
    const h = makeHelpers(dd);
    const name = /^\d+$/.test(raw) ? dd.champKeyToId?.[raw] || raw : raw;
    const region = req.region;
    const queueId = readQueue(req.query.queue, null);
    const patch = validPatch(req.query.patch);
    const band = readBandGroup(req.query.band);
    const min = BUILD_MIN_OPTIONS.includes(Number(req.query.min)) ? Number(req.query.min) : MIN_GAMES;
    const sort = Object.hasOwn(MATCHUP_SORTS, req.query.sort) ? req.query.sort : 'games';

    const [patches, detail, info, rows] = await Promise.all([
      getPatches(region),
      getChampionDetail(name, { queueId, patch, region, band }),
      getChampionDD(name).catch(() => null),
      loadChampionRows(name, { region, queueId, patch, band })
    ]);
    if (!detail && !info) {
      return res.status(404).render('error', { title: null, backUrl: '/champions', message: 'チャンピオンが見つかりませんでした。' });
    }

    // ロールの指定が無ければ、いちばん多く使われたロール（ARAM などロールが無いモードは「すべて」）
    const roles = rolesOf(rows);
    const roleParam = String(req.query.role || '');
    const role = roleParam === 'all' ? null : validRole(roleParam) || roles[0]?.role || null;

    res.render('champion', {
      name, h, detail, info, patches,
      selected: { queueId, patch, band, role, min, sort },
      queues: QUEUES, bandGroups: BAND_GROUPS, roleLabels: ROLE_LABELS, tagLabels: TAG_LABELS,
      minOptions: BUILD_MIN_OPTIONS, matchupSorts: MATCHUP_SORTS,
      roles, shardLabel,
      report: buildReport(rows, { role, minGames: min, items: dd.items }),
      matchups: buildMatchups(rows, { role, minGames: min, sort }),
      scanned: rows.length,
      capped: rows.length >= SCAN_LIMIT
    });
  } catch (err) { fail(res, err, '/champions'); }
});

// 2体の直接対決（/matchup?champ=Ahri&vs=Zed）。保存済みの試合だけで集計（API は使わない）
router.get('/matchup', async (req, res) => {
  const champ = String(req.query.champ || '');
  const vs = String(req.query.vs || '');
  try {
    const dd = await getDdragon();
    const h = makeHelpers(dd);
    const region = req.region;
    const queueId = readQueue(req.query.queue, null);
    const patch = validPatch(req.query.patch);
    const band = readBandGroup(req.query.band);
    const min = BUILD_MIN_OPTIONS.includes(Number(req.query.min)) ? Number(req.query.min) : MIN_GAMES;
    const patches = await getPatches(region);

    const base = {
      h, champ: '', vs: '', patches, selected: { queueId, patch, band, role: null, min }, queues: QUEUES, bandGroups: BAND_GROUPS,
      minOptions: BUILD_MIN_OPTIONS, roleLabels: ROLE_LABELS, roleOptions: [], result: null, error: null,
      champList: Object.keys(dd.champNames || {}).map((id) => ({ id, name: dd.champNames[id] })).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    };

    if (!champ && !vs) return res.render('matchup', base);
    if (!isChampId(champ) || !isChampId(vs)) return res.render('matchup', { ...base, error: 'チャンピオンを2体とも選んでください。' });
    if (champ === vs) return res.render('matchup', { ...base, champ, vs, error: '同じチャンピオンは比較できません。' });
    const known = dd.champNames && Object.keys(dd.champNames).length > 0;
    if (known && (!dd.champNames[champ] || !dd.champNames[vs])) return res.render('matchup', { ...base, champ, vs, error: 'チャンピオンが見つかりませんでした。' });

    const rows = await loadChampionRows(champ, { region, queueId, patch, band });
    const roles = rolesOf(rows);
    // この2体がいちばん多く当たったロールを初期値にする（指定があればそれ）
    const roleOptions = roles.map((r) => ({ ...r, versus: headToHead(rows, vs, { role: r.role, minGames: min }).games }));
    const best = [...roleOptions].sort((a, b) => b.versus - a.versus || b.games - a.games)[0];
    const roleParam = String(req.query.role || '');
    const role = roleParam === 'all' ? null : validRole(roleParam) || best?.role || null;

    res.render('matchup', {
      ...base, champ, vs, roleOptions, selected: { queueId, patch, band, role, min },
      result: headToHead(rows, vs, { role, minGames: min })
    });
  } catch (err) { fail(res, err, '/champions'); }
});

export default router;
