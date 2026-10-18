import { config } from '../config/index.js';
import { REGIONS, isRegion } from '../constants/regions.js';

// リージョンの決め方（v6.4）
//   プレイヤーのページ（/summoner /live /report /duo /multi /watch …）… ?region= があればそれ、無ければ既定。
//     URL だけで対象が決まるので、共有されたリンクを誰が開いても同じプレイヤーになる。
//   統計のページ（/champions /tierlist /champion /matchup /ranking /status とホーム）… ?region= → 最後に選んだリージョン（Cookie）→ 既定。
// どのページでも、画面側は res.locals の region / rqs / rq / formRegion / regions を使う。
const STATS_PATH = /^\/(champions|tierlist|champion|matchup|ranking|status)(\/|$)/;
const COOKIE = 'region';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function readCookie(req, name = COOKIE) {
  const raw = String(req.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      // v6.6.1: 壊れた %xx（例: region=%E0%A4%A）で decodeURIComponent が例外を投げ、そのブラウザの全ページが 500 になっていた
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

const asRegion = (v) => {
  const k = String(v ?? '').trim().toLowerCase();
  return isRegion(k) ? k : null;
};

export function regionContext() {
  return (req, res, next) => {
    const explicit = asRegion(req.query?.region) || asRegion(req.body?.region);
    const remembered = asRegion(readCookie(req));
    const fallback = config.defaultRegion;
    const statsPage = req.path === '/' || STATS_PATH.test(req.path);

    const region = explicit || (statsPage ? remembered : null) || fallback;
    req.region = region;
    req.formRegion = explicit || remembered || fallback;

    // 画面から選んだリージョンを覚える（API や POST では書き換えない）
    if (explicit && explicit !== remembered && req.method === 'GET' && !req.path.startsWith('/api/')) {
      res.cookie(COOKIE, explicit, { maxAge: YEAR_MS, sameSite: 'lax', path: '/' });
    }

    res.locals.region = region;
    res.locals.formRegion = req.formRegion;
    res.locals.regions = REGIONS;
    res.locals.defaultRegion = fallback;
    res.locals.rqs = region === fallback ? '' : `&region=${region}`; // 既存のクエリの後ろに足す
    res.locals.rq = region === fallback ? '' : `?region=${region}`; // クエリが無い URL の後ろに足す
    next();
  };
}
