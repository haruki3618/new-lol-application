import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeComp } from '../src/services/teamComp.js';
import { buildTimelineFindings, TL_DEFAULTS, lineChartSvg } from '../src/services/timelineMath.js';
import { rolesOf, forRole, verdictOf, buildReport, buildMatchups, headToHead } from '../src/services/buildMath.js';
import { summarizeRecent, scoreParticipants } from '../src/services/summarize.js';
import { summarizePlayer, forecast } from '../src/services/liveMath.js';
import { computeBaselines, baselineLookup } from '../src/services/scoreBaseline.js';
import { analyze, annotate, wilson } from '../src/services/insightsMath.js';
import { buildDeltas, mergeDeltas, toBulkOps } from '../src/services/aggMath.js';
import { buildReport as periodReport, lpChange } from '../src/services/reportMath.js';
import { analyzeDuo, splitCommonMatches } from '../src/services/duoMath.js';
import { evaluateWatch, formatMessage } from '../src/services/watchMath.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// ---- analyzeComp（これまでテストが無かった）----
const dd = {
  champTags: { Malphite: ['Tank', 'Mage'], Garen: ['Fighter', 'Tank'], Ahri: ['Mage', 'Assassin'], Jinx: ['Marksman'], Lux: ['Mage', 'Support'], Zed: ['Assassin'], Talon: ['Assassin'], Katarina: ['Assassin', 'Mage'] },
  champInfo: {
    Malphite: { attack: 5, magic: 7 }, Garen: { attack: 7, magic: 1 }, Ahri: { attack: 3, magic: 8 }, Jinx: { attack: 9, magic: 2 },
    Lux: { attack: 2, magic: 9 }, Zed: { attack: 9, magic: 1 }, Talon: { attack: 9, magic: 1 }, Katarina: { attack: 4, magic: 9 }
  }
};

test('analyzeComp: 情報が無い（知らない ID だけ・空・dd なし）なら null', () => {
  assert.equal(analyzeComp([], dd), null);
  assert.equal(analyzeComp(['Nobody', 'Unknown'], dd), null);
  assert.equal(analyzeComp(['Ahri'], undefined), null);
  assert.equal(analyzeComp(['Ahri'], {}), null);
  assert.equal(analyzeComp(['Ahri'], { champTags: { Ahri: ['Mage'] } }), null); // 情報（champInfo）が片方だけでも数えない
});

test('analyzeComp: 前衛なし・持続火力なしの警告と、ダメージの偏り', () => {
  const r = analyzeComp(['Zed', 'Talon', 'Katarina'], dd);
  assert.ok(r.warnings.some((w) => w.includes('前衛')));
  assert.ok(r.warnings.some((w) => w.includes('アサシンが多く')));
  assert.equal(r.adShare + r.apShare, 100);
  const phys = analyzeComp(['Zed', 'Talon', 'Garen', 'Jinx'], dd);
  assert.equal(phys.damageLabel, '物理寄り');
  assert.ok(phys.warnings.some((w) => w.includes('物理ダメージに偏')));
  const magic = analyzeComp(['Ahri', 'Lux', 'Katarina', 'Lux'], dd); // 魔法 76%（70% を超えると「魔法寄り」、75% 以上で警告）
  assert.equal(magic.damageLabel, '魔法寄り');
  assert.ok(magic.warnings.some((w) => w.includes('魔法ダメージに偏')));
});

test('analyzeComp: 主な役割は先頭のタグ。バランス型・警告なしの構成', () => {
  const r = analyzeComp(['Garen', 'Ahri', 'Jinx', 'Malphite', 'Lux'], dd);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.damageLabel, 'バランス型');
  const counts = Object.fromEntries(r.tags.map((t) => [t.tag, t.count]));
  assert.deepEqual(counts, { Fighter: 1, Mage: 2, Marksman: 1, Tank: 1 });
  assert.ok(r.tags[0].count >= r.tags[r.tags.length - 1].count); // 多い順
  // 5人未満で前衛が1人でも「1人だけ」の警告は出さない（known >= 5 のときだけ）
  assert.ok(!analyzeComp(['Garen', 'Jinx'], dd).warnings.some((w) => w.includes('1人だけ')));
});

test('analyzeComp: ダメージ情報が 0 のときは 50% として扱い、NaN にならない', () => {
  const r = analyzeComp(['Zed'], { champTags: { Zed: ['Assassin'] }, champInfo: { Zed: {} } });
  assert.equal(r.apShare, 50);
  assert.equal(r.adShare, 50);
});

// ---- buildTimelineFindings（これまでテストが無かった）----
const cp = (min, o = {}) => ({ min, csDiff: null, goldDiff: null, teamDiff: 0, me: { cs: 0 }, opp: { cs: 0 }, ...o });
const result = (o = {}) => ({ checkpoints: [], peak: {}, me: { win: true }, earlyDeaths: 0, ...o });

test('buildTimelineFindings: 事実の言い換えだけを返し、条件を満たさなければ何も言わない', () => {
  assert.deepEqual(buildTimelineFindings(result()), []);
  const out = buildTimelineFindings(result({ checkpoints: [cp(10, { csDiff: -TL_DEFAULTS.csDiffPt, me: { cs: 60 }, opp: { cs: 60 + TL_DEFAULTS.csDiffPt } })] }));
  assert.equal(out.length, 1);
  assert.match(out[0], /10分時点のCSはレーン相手より \d+ 少ない（60 対 \d+）/);
  const same = buildTimelineFindings(result({ checkpoints: [cp(10, { csDiff: 1, me: { cs: 70 }, opp: { cs: 69 } })] }));
  assert.match(same[0], /ほぼ同じ/);
  // CS 差が null（相手が特定できない）なら言及しない
  assert.deepEqual(buildTimelineFindings(result({ checkpoints: [cp(10)] })), []);
});

test('buildTimelineFindings: 逆転勝ち・先行からの敗北・序盤のデス', () => {
  const o = TL_DEFAULTS;
  const comeback = buildTimelineFindings(result({ peak: { deficit: { v: -o.swing - 100, min: 18 } }, me: { win: true } }));
  assert.match(comeback.join(), /劣勢から逆転して勝利/);
  const thrown = buildTimelineFindings(result({ peak: { lead: { v: o.swing + 100, min: 20 } }, me: { win: false } }));
  assert.match(thrown.join(), /先行から、最終的に敗北/);
  // 勝ったのに「先行から敗北」は言わない
  assert.ok(!buildTimelineFindings(result({ peak: { lead: { v: o.swing + 100, min: 20 } }, me: { win: true } })).join().includes('敗北'));
  assert.match(buildTimelineFindings(result({ earlyDeaths: 3 })).join(), /3 回デスしている/);
  assert.deepEqual(buildTimelineFindings(result({ earlyDeaths: 1 })), []);
});

test('buildTimelineFindings: 15分のゴールド差・チーム差は、しきい値以上のときだけ', () => {
  const o = TL_DEFAULTS;
  const big = buildTimelineFindings(result({ checkpoints: [cp(15, { goldDiff: o.laneGoldDiff, teamDiff: o.teamGoldDiff })] }));
  assert.equal(big.length, 2);
  assert.match(big.join(), /味方が先行/);
  const behind = buildTimelineFindings(result({ checkpoints: [cp(15, { teamDiff: -o.teamGoldDiff })] }));
  assert.match(behind.join(), /味方が劣勢/);
  assert.deepEqual(buildTimelineFindings(result({ checkpoints: [cp(15, { goldDiff: 1, teamDiff: 1 })] })), []);
});

// ---- 欠損・古い形式のデータ（実際に起こりうる入力）で落ちない ----
test('欠損データ: 空・項目の欠けた行でも例外を投げず、安全な空の結果を返す', () => {
  const rows = [{}, { me: {} }, { me: { teamPosition: 'TOP' } }, { me: { teamPosition: 'TOP', win: true }, opp: { championName: 'Zed' } }];
  assert.doesNotThrow(() => { rolesOf(rows); buildReport(rows); buildMatchups(rows); headToHead(rows, 'Zed'); });
  assert.deepEqual(rolesOf([]), []);
  assert.equal(buildReport([]).games, 0);
  assert.equal(headToHead([], 'Zed').games, 0);
  assert.equal(headToHead(rows, 'Zed').games, 1); // 相手の項目が無い行は数えない
  assert.equal(forRole(rows, null), rows);
  assert.equal(verdictOf(0, 0), 'few');
  assert.equal(buildMatchups([]).rows.length, 0);
});

test('欠損データ: 試合・参加者の項目が欠けていても要約・集計・診断が落ちない', () => {
  const m = [{}, { win: true }, { kills: 3 }];
  assert.doesNotThrow(() => summarizeRecent(m));
  assert.equal(summarizeRecent([]).games, 0);
  assert.equal(summarizeRecent(m).games, 3);
  assert.ok(!JSON.stringify(summarizeRecent(m)).includes('NaN'));
  assert.doesNotThrow(() => scoreParticipants([{}, { teamId: 100 }, { teamId: 200, kills: 1 }]));
  assert.doesNotThrow(() => summarizePlayer([], 'Ahri', 420));
  assert.doesNotThrow(() => summarizePlayer([{}, { win: true }], 'Ahri', 420));
  assert.deepEqual(forecast([]).available, false);
  assert.equal(forecast([{ players: [] }, { players: [] }]).available, false);
  assert.doesNotThrow(() => analyze([]));
  assert.doesNotThrow(() => analyze([{}, { t: 1, win: true }]));
  assert.doesNotThrow(() => annotate([]));
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 0 });
  assert.doesNotThrow(() => computeBaselines([]));
  assert.doesNotThrow(() => computeBaselines([{}]));
  assert.equal(baselineLookup(computeBaselines([]))('Ahri', 'MIDDLE'), null);
});

test('欠損データ: 集計・レポート・デュオ・追跡・グラフ', () => {
  assert.equal(buildDeltas({}), null);
  assert.equal(buildDeltas({ participants: [] }), null);
  assert.doesNotThrow(() => toBulkOps(mergeDeltas(new Map(), [])));
  assert.deepEqual(toBulkOps(new Map()), []);
  assert.doesNotThrow(() => periodReport([], 'p', { now: 1 }));
  assert.doesNotThrow(() => periodReport([{ gameCreation: 1 }], 'p', { now: 2, period: 'bogus' })); // 不正な期間は week
  assert.equal(lpChange([], 0, 10), null);
  assert.equal(analyzeDuo([], 'a', 'b').verdict.level, 'insufficient');
  assert.deepEqual(splitCommonMatches([{ participants: [] }], 'a', 'b'), { duo: [], versus: [] });
  assert.deepEqual(evaluateWatch({}, null).events, []);
  assert.doesNotThrow(() => formatMessage('x', [], null));
  const svg = lineChartSvg([]);
  assert.ok(typeof svg === 'string');
  assert.doesNotThrow(() => lineChartSvg([{ cls: 'a', label: 'x', points: [] }]));
});

// ---- 古い値の注意書き（プロフィール）----
test('プロフィール: 古いサモナー情報・マスタリーを出したときの注意書き', () => {
  const route = read('src', 'routes', 'profile.js');
  assert.match(route, /import \{ cached, staleAgeMs, STALE_1H \}/);
  assert.match(route, /staleAgeMs\)\.filter\(\(a\) => a !== null\)/);
  assert.match(route, /summoner:\$\{region\}:\$\{puuid\}`, `mastery:\$\{region\}:\$\{puuid\}`/);
  assert.match(route, /\n {6}staleMin,\n/);
  const view = read('src', 'views', 'profile.ejs');
  assert.match(view, /locals\.staleMin/);
  assert.ok(view.indexOf('locals.staleMin') < view.indexOf('id="syncBar"'));
  assert.match(read('src', 'public', 'css', 'app.css'), /\.inline-err/);
  // ランク（LP の記録元）には古い値を使わない（v6.7.0 の方針のまま）
  assert.doesNotMatch(route.split('\n').find((l) => l.includes('getLeagueEntriesByPUUID(puuid, { region })')) || '', /staleMs/);
});

// ---- CORS・CI・依存の更新 ----
test('CORS: 他のサイトから API を読めるようにする設定が無い（同一オリジンのみ）', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(root, 'src')).filter((f) => f.endsWith('.js') && !f.includes(`${path.sep}public${path.sep}`))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /Access-Control-Allow-Origin|require\('cors'\)|from 'cors'/i, f);
  }
  assert.match(read('src', 'middleware', 'security.js'), /frame-ancestors 'none'/);
});

test('CI・依存: Dependabot の設定と、テストの重複実行の取り消し', () => {
  const dep = read('.github', 'dependabot.yml');
  assert.match(dep, /package-ecosystem: npm/);
  assert.match(dep, /package-ecosystem: github-actions/);
  assert.match(dep, /minor-and-patch/);
  const ci = read('.github', 'workflows', 'test.yml');
  assert.match(ci, /cancel-in-progress: true/);
  assert.match(ci, /cache: npm/);
  assert.match(ci, /npm audit --omit=dev --audit-level=high/);
});

test('版・文書: 6.9.0 以降の版がそろい、CHANGELOG に実装しなかったものがある', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const [a, b] = pkg.version.split('.').map(Number);
  assert.ok(a > 6 || b >= 9);
  const log = read('CHANGELOG.md');
  assert.ok(log.startsWith(`# 変更履歴\n\n## v${pkg.version}`));
  assert.match(log, /## v6\.9\.0/);
  assert.match(log.split('## v6.8.1')[0], /実装しなかったもの/);
  assert.match(read('docs', 'OPERATIONS.md'), /Dependabot/);
});
