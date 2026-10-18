// タイムライン分析（v6.2）の計算部分。DB・API に依存しない純粋な関数なので、単体でテストできる。
// 流れ: Riot の生タイムライン → slimTimeline（保存用の軽い形）→ analyzeTimeline（1人の視点の分析）→ lineChartSvg（グラフ）

export const TL_DEFAULTS = {
  checkpoints: [10, 15, 20], // 比べる時刻（分）
  csDiffPt: 8, // 10分時点のCS差がこれ以上なら「差がある」と書く
  laneGoldDiff: 800, // 15分時点のレーン相手とのゴールド差の目安
  teamGoldDiff: 1500, // 15分時点のチームのゴールド差の目安
  swing: 3000, // 逆転・取りこぼしと書く最大差
  earlyDeathMin: 10, // 序盤デスの境目（分）
  frameJitterMs: 10000 // 毎分のフレームと見なす許容ずれ
};

const MONSTER_LABEL = {
  DRAGON: 'ドラゴン', ELDER_DRAGON: 'エルダードラゴン', HORDE: 'ヴォイドグラブ', RIFTHERALD: 'リフトヘラルド',
  BARON_NASHOR: 'バロン', ATAKHAN: 'アタカン'
};
const BUILDING_LABEL = { TOWER_BUILDING: 'タワー', INHIBITOR_BUILDING: 'インヒビター' };

// ---------- 保存用に軽くする ----------
// フレーム: 10人分の [ゴールド累計, CS(ミニオン+ジャングル), 経験値, レベル]。イベント: キル・エピックモンスター・建物だけ
export function slimTimeline(raw) {
  const info = raw?.info;
  if (!Array.isArray(info?.frames) || info.frames.length === 0) return null;

  const participants = (info.participants || []).map((p) => ({ id: p.participantId, puuid: p.puuid }));
  const frames = [];
  const events = [];
  for (const f of info.frames) {
    const pf = f.participantFrames || {};
    const row = [];
    for (let id = 1; id <= 10; id++) {
      const x = pf[id] ?? pf[String(id)];
      row.push(x ? [x.totalGold | 0, (x.minionsKilled | 0) + (x.jungleMinionsKilled | 0), x.xp | 0, x.level | 0] : null);
    }
    frames.push({ t: f.timestamp | 0, p: row });

    for (const e of f.events || []) {
      if (e.type === 'CHAMPION_KILL') {
        events.push({ t: e.timestamp | 0, type: 'K', k: e.killerId | 0, v: e.victimId | 0, a: e.assistingParticipantIds || [] });
      } else if (e.type === 'ELITE_MONSTER_KILL') {
        events.push({ t: e.timestamp | 0, type: 'M', m: e.monsterSubType === 'ELDER_DRAGON' ? 'ELDER_DRAGON' : e.monsterType, team: e.killerTeamId | 0 });
      } else if (e.type === 'BUILDING_KILL') {
        events.push({ t: e.timestamp | 0, type: 'B', b: e.buildingType, team: e.teamId | 0 }); // team は壊された側
      }
    }
  }
  return { v: 1, participants, frames, events };
}

// ---------- 1人の視点の分析 ----------
// slim: slimTimeline の結果 / roster: [{ puuid, teamId, position, championName, name, win }] / mePuuid: 見る人
export function analyzeTimeline(slim, roster, mePuuid, options = {}) {
  const o = { ...TL_DEFAULTS, ...options };
  if (!slim?.frames?.length) return null;

  const idOf = new Map((slim.participants || []).map((p) => [p.puuid, p.id]));
  const players = roster.map((r) => ({ ...r, id: idOf.get(r.puuid) })).filter((r) => r.id);
  const me = players.find((p) => p.puuid === mePuuid);
  if (!me) return null;

  // 同じロールの相手チームのプレイヤーが1人だけならレーン相手（ロール不明・重複なら比べない）
  const sameRole = me.position ? players.filter((p) => p.teamId !== me.teamId && p.position === me.position) : [];
  const opp = sameRole.length === 1 ? sameRole[0] : null;
  const allyIds = players.filter((p) => p.teamId === me.teamId).map((p) => p.id);
  const foeIds = players.filter((p) => p.teamId !== me.teamId).map((p) => p.id);

  // 毎分のフレームだけ使う（最後の中途半端なフレームは除く）
  const byMin = new Map();
  for (const f of slim.frames) {
    const m = Math.round(f.t / 60000);
    if (Math.abs(f.t - m * 60000) <= o.frameJitterMs) byMin.set(m, f);
  }
  const minutes = [...byMin.keys()].sort((a, b) => a - b);
  const lastMin = minutes.length ? minutes[minutes.length - 1] : 0;
  const stat = (m, id) => {
    const x = byMin.get(m)?.p?.[id - 1];
    return x ? { gold: x[0], cs: x[1], xp: x[2], level: x[3] } : null;
  };
  const teamGold = (m, ids) => ids.reduce((s, id) => s + (stat(m, id)?.gold || 0), 0);

  const series = {
    team: minutes.map((m) => ({ min: m, v: teamGold(m, allyIds) - teamGold(m, foeIds) })),
    lane: opp ? minutes.map((m) => ({ min: m, v: (stat(m, me.id)?.gold || 0) - (stat(m, opp.id)?.gold || 0) })) : null
  };

  const checkpoints = o.checkpoints
    .filter((m) => byMin.has(m))
    .map((m) => {
      const a = stat(m, me.id);
      const b = opp ? stat(m, opp.id) : null;
      return {
        min: m, me: a, opp: b,
        csDiff: a && b ? a.cs - b.cs : null,
        goldDiff: a && b ? a.gold - b.gold : null,
        xpDiff: a && b ? a.xp - b.xp : null,
        teamDiff: teamGold(m, allyIds) - teamGold(m, foeIds)
      };
    });

  // 最大の先行・最大の劣勢・最終
  let lead = null, deficit = null;
  for (const p of series.team) {
    if (p.v > 0 && (!lead || p.v > lead.v)) lead = p;
    if (p.v < 0 && (!deficit || p.v < deficit.v)) deficit = p;
  }
  const finalDiff = series.team.length ? series.team[series.team.length - 1].v : 0;

  // 自分のキル・デス・アシスト（分）と序盤デス
  const toMin = (t) => Math.floor(t / 60000);
  const deaths = [], kills = [], assists = [];
  for (const e of slim.events || []) {
    if (e.type !== 'K') continue;
    if (e.v === me.id) deaths.push(toMin(e.t));
    if (e.k === me.id) kills.push(toMin(e.t));
    else if ((e.a || []).includes(me.id)) assists.push(toMin(e.t));
  }
  const earlyDeaths = deaths.filter((m) => m < o.earlyDeathMin).length;

  // オブジェクト（誰のチームが取ったか）
  const objectives = [];
  for (const e of slim.events || []) {
    if (e.type === 'M') {
      objectives.push({ min: toMin(e.t), label: MONSTER_LABEL[e.m] || e.m, mine: e.team === me.teamId });
    } else if (e.type === 'B') {
      objectives.push({ min: toMin(e.t), label: BUILDING_LABEL[e.b] || e.b, mine: e.team !== me.teamId });
    }
  }

  const result = {
    me: { id: me.id, teamId: me.teamId, championName: me.championName, position: me.position, win: Boolean(me.win), name: me.name },
    opp: opp ? { id: opp.id, championName: opp.championName, name: opp.name } : null,
    lastMin, series, checkpoints,
    peak: { lead, deficit }, finalDiff,
    deaths, kills, assists, earlyDeaths, objectives,
    findings: []
  };
  result.findings = buildTimelineFindings(result, o);
  return result;
}

const sgn = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toLocaleString('ja-JP');

// 事実の言い換えだけ（原因や良し悪しは断定しない）
export function buildTimelineFindings(r, o = TL_DEFAULTS) {
  const out = [];
  const cp10 = r.checkpoints.find((c) => c.min === 10);
  const cp15 = r.checkpoints.find((c) => c.min === 15);

  if (cp10 && cp10.csDiff !== null) {
    if (Math.abs(cp10.csDiff) >= o.csDiffPt) {
      out.push(`10分時点のCSはレーン相手より ${Math.abs(cp10.csDiff)} ${cp10.csDiff > 0 ? '多い' : '少ない'}（${cp10.me.cs} 対 ${cp10.opp.cs}）。`);
    } else {
      out.push(`10分時点のCSはレーン相手とほぼ同じ（${cp10.me.cs} 対 ${cp10.opp.cs}）。`);
    }
  }
  if (cp15 && cp15.goldDiff !== null && Math.abs(cp15.goldDiff) >= o.laneGoldDiff) {
    out.push(`15分時点のゴールドはレーン相手より ${sgn(cp15.goldDiff)}。`);
  }
  if (cp15 && Math.abs(cp15.teamDiff) >= o.teamGoldDiff) {
    out.push(`15分時点のチームのゴールド差は ${sgn(cp15.teamDiff)}（${cp15.teamDiff > 0 ? '味方が先行' : '味方が劣勢'}）。`);
  }
  const { lead, deficit } = r.peak;
  if (r.me.win && deficit && deficit.v <= -o.swing) {
    out.push(`最大 ${sgn(deficit.v)}（${deficit.min}分）の劣勢から逆転して勝利。`);
  }
  if (!r.me.win && lead && lead.v >= o.swing) {
    out.push(`最大 ${sgn(lead.v)}（${lead.min}分）の先行から、最終的に敗北。`);
  }
  if (r.earlyDeaths >= 2) {
    out.push(`${o.earlyDeathMin}分までに ${r.earlyDeaths} 回デスしている。`);
  }
  return out;
}

// ---------- グラフ（サーバー側で作る SVG。スクリプト不要） ----------
// lines: [{ cls, label, points: [{ min, v }] }]。0 を中心に上下対称。文字列はすべて固定または数値のみ
export function lineChartSvg(lines, { w = 640, h = 180, padL = 46, padR = 10, padT = 10, padB = 22 } = {}) {
  const pts = lines.flatMap((l) => l.points || []);
  if (pts.length < 2) return '';
  const maxMin = Math.max(...pts.map((p) => p.min)) || 1;
  const rawMax = Math.max(...pts.map((p) => Math.abs(p.v)), 500);
  const step = rawMax > 6000 ? 2000 : rawMax > 2500 ? 1000 : 500;
  const yMax = Math.ceil(rawMax / step) * step;
  const x = (m) => padL + (m / maxMin) * (w - padL - padR);
  const y = (v) => padT + ((yMax - v) / (2 * yMax)) * (h - padT - padB);
  const f = (n) => Math.round(n * 10) / 10;

  const grid = [-yMax, 0, yMax].map((v) => `<line class="tl-grid${v === 0 ? ' zero' : ''}" x1="${padL}" x2="${w - padR}" y1="${f(y(v))}" y2="${f(y(v))}"/><text class="tl-axis" x="${padL - 6}" y="${f(y(v)) + 4}" text-anchor="end">${v > 0 ? '+' : ''}${v}</text>`).join('');
  const ticks = [];
  for (let m = 0; m <= maxMin; m += 5) ticks.push(`<text class="tl-axis" x="${f(x(m))}" y="${h - 6}" text-anchor="middle">${m}分</text>`);
  const paths = lines
    .filter((l) => l.points?.length > 1)
    .map((l) => `<polyline class="tl-line ${l.cls}" fill="none" points="${l.points.map((p) => `${f(x(p.min))},${f(y(p.v))}`).join(' ')}"/>`)
    .join('');
  return `<svg class="tl-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${lines.map((l) => l.label).join('・')}の推移">${grid}${ticks.join('')}${paths}</svg>`;
}
