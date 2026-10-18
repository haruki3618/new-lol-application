// 画面共通のスクリプト（v6.3.3 で作り直し、v6.6 で改善）
// テーマ・data-style の適用・タブ（URL に保存）・遅延読み込み・試合の開閉（キーボード対応）・
// 絞り込み・同期バー（ページ全体を再読み込みせず差し替え）・タイムライン/ビルドの読み込み・LPグラフ
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // LP グラフの状態（タブの # から直接開く場合に備えて、先に宣言しておく）
  let lpDrawn = false;
  let lpRows = null;
  let lpChart = null;

  // ---- トップの検索欄: マウス操作の環境（PC）だけ自動でフォーカスする ----
  // スマホで autofocus を付けると、開いた直後にキーボードが出て、下の機能カードが隠れてしまうため（v6.9.1）
  try {
    const box = $('.searchbox [data-riotid]');
    if (box && window.matchMedia('(hover: hover) and (pointer: fine)').matches) box.focus({ preventScroll: true });
  } catch { /* フォーカスできなくても検索は使える */ }

  // ---- テーマ（自動 / ライト / ダーク。自動は OS の設定に従う） ----
  const root = document.documentElement;
  const MODES = ['auto', 'light', 'dark'];
  const MODE_LABEL = { auto: '自動', light: 'ライト', dark: 'ダーク' };
  let themeMode = 'auto';
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') themeMode = saved;
  } catch { /* 保存値が読めなくても自動で動く */ }
  const applyTheme = () => {
    if (themeMode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', themeMode);
    $$('[data-theme-toggle]').forEach((b) => {
      b.title = '表示テーマ: ' + MODE_LABEL[themeMode] + '（クリックで切り替え）';
      b.setAttribute('aria-label', '表示テーマ: ' + MODE_LABEL[themeMode] + '。クリックで切り替え');
    });
  };
  applyTheme();

  // ---- data-style: 動的な値のスタイル（CSP で style="" 属性が使えないため、CSSOM で適用する） ----
  const applyStyles = () => {
    $$('[data-style]').forEach((el) => {
      el.style.cssText = el.getAttribute('data-style');
      el.removeAttribute('data-style');
    });
  };
  applyStyles();
  let styleQueued = false;
  new MutationObserver(() => {
    if (styleQueued) return;
    styleQueued = true;
    requestAnimationFrame(() => { styleQueued = false; applyStyles(); });
  }).observe(document.body, { childList: true, subtree: true });

  // ---- 画像の読み込み失敗（v6.5.1: インライン onerror をやめ、CSP の 'unsafe-inline' を不要にした） ----
  // error は bubble しないので capture で拾う（innerHTML で後から入った画像にも効く）
  const hideBroken = (img) => { img.style.visibility = 'hidden'; };
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.hasAttribute('data-hide-on-error')) hideBroken(t);
  }, true);
  // スクリプトの実行前にすでに失敗していた画像
  $$('img[data-hide-on-error]').forEach((img) => { if (img.complete && img.naturalWidth === 0) hideBroken(img); });

  // ---- 通信エラーの扱い（v6.6） ----
  // サーバーが 429 / 404 などを返したときに、その本文を画面へ差し込まず、状況に合わせた短い案内を出す
  const httpError = (r) => {
    const err = new Error('HTTP ' + r.status);
    err.status = r.status;
    err.retryAfter = Number(r.headers.get('Retry-After')) || 0;
    return err;
  };
  const errorText = (err) => {
    if (err && err.status === 429) {
      return 'アクセスが集中しています。' + (err.retryAfter ? 'あと約 ' + err.retryAfter + ' 秒' : 'しばらく') + '待ってから、もう一度お試しください。';
    }
    if (err && err.status === 404) return '見つかりませんでした。保存期間が過ぎたか、まだ保存されていない可能性があります。';
    if (err && err.status) return '読み込めませんでした（エラー ' + err.status + '）。';
    return '通信に失敗しました。接続を確認して、もう一度お試しください。';
  };
  const errorBox = (err, retry) => {
    const box = document.createElement('div');
    box.className = 'panel empty inline-err';
    box.setAttribute('role', 'alert');
    const msg = document.createElement('span');
    msg.textContent = errorText(err);
    box.appendChild(msg);
    if (retry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn sm';
      b.textContent = 'もう一度試す';
      b.addEventListener('click', retry);
      box.appendChild(b);
    }
    return box;
  };

  // ---- トースト通知（v6.7.0） ----
  // 画面の下に短いメッセージを出す。同期・履歴・ライブの失敗や、通信の切断をページのどこにいても気づけるようにする。
  // 使い方: window.lolToast('メッセージ', { type: 'error' | 'ok' | 'info', ms: 5000, sticky: false })。返り値の関数で閉じる
  const toastHost = (() => {
    const h = document.createElement('div');
    h.className = 'toasts';
    h.setAttribute('role', 'status');
    h.setAttribute('aria-live', 'polite');
    document.body.appendChild(h);
    return h;
  })();
  const lolToast = (message, { type = 'info', ms = 5000, sticky = false } = {}) => {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    const text = document.createElement('span');
    text.textContent = String(message || '');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-x';
    close.setAttribute('aria-label', '閉じる');
    close.textContent = '×';
    el.append(text, close);
    const dismiss = () => { clearTimeout(timer); el.remove(); };
    close.addEventListener('click', dismiss);
    const timer = sticky ? 0 : setTimeout(dismiss, ms);
    while (toastHost.children.length >= 3) toastHost.firstChild.remove(); // 溜めすぎない
    toastHost.appendChild(el);
    return dismiss;
  };
  window.lolToast = lolToast;

  // 通信の切断・復帰（戦績の同期やタブの読み込みが黙って失敗したように見えるのを防ぐ）
  let offlineToast = null;
  window.addEventListener('offline', () => {
    if (!offlineToast) offlineToast = lolToast('インターネットに接続されていません。接続が戻るまで読み込みはできません。', { type: 'error', sticky: true });
  });
  window.addEventListener('online', () => {
    if (offlineToast) { offlineToast(); offlineToast = null; }
    lolToast('接続が戻りました。', { type: 'ok', ms: 3000 });
  });
  if (navigator.onLine === false) window.dispatchEvent(new Event('offline'));

  // ---- タブ（data-tabs の中の .tab[data-tab] と、同じ id の .tab-pane） ----
  const loadLazy = async (pane) => {
    if (!pane || !pane.dataset.lazy || pane.dataset.loaded) return;
    pane.dataset.loaded = '1';
    pane.setAttribute('aria-busy', 'true'); // v6.7.0: 読み込み中をスクリーンリーダーにも伝える
    pane.innerHTML = '<div class="panel skel" aria-hidden="true"><i></i><i></i><i></i></div>';
    try {
      const r = await fetch(pane.dataset.lazy);
      if (!r.ok) throw httpError(r); // v6.6: 失敗のときは「読み込み済み」にせず、再試行できるようにする
      pane.innerHTML = await r.text();
    } catch (err) {
      pane.dataset.loaded = '';
      pane.replaceChildren(errorBox(err, () => loadLazy(pane)));
    } finally {
      pane.removeAttribute('aria-busy');
    }
  };
  const showTab = (box, name, { hash = true, focus = false } = {}) => {
    $$('.tab', box).forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    $$('.tab-pane').forEach((p) => p.classList.toggle('on', p.id === name));
    const pane = document.getElementById(name);
    loadLazy(pane);
    if (name === 'lp') drawLp();
    // v6.6: 選んだタブを URL の # に残す（共有・再読み込み・戻っても同じタブ）
    if (hash) { try { history.replaceState(null, '', '#' + encodeURIComponent(name)); } catch { /* 無視 */ } }
  };
  $$('[data-tabs]').forEach((box) => {
    box.setAttribute('role', 'tablist');
    $$('.tab', box).forEach((t) => {
      t.setAttribute('role', 'tab');
      const on = t.classList.contains('on');
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
  });
  const tabFromHash = () => {
    const box = $('[data-tabs]');
    if (!box || !location.hash) return;
    let name = '';
    try { name = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    if ($$('.tab', box).some((t) => t.dataset.tab === name)) showTab(box, name, { hash: false });
  };
  tabFromHash();
  window.addEventListener('hashchange', tabFromHash);

  // 矢印キーでタブを移動
  document.addEventListener('keydown', (e) => {
    const tab = e.target.closest && e.target.closest('[data-tabs] .tab');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      const box = tab.closest('[data-tabs]');
      const tabs = $$('.tab', box);
      let i = tabs.indexOf(tab);
      if (e.key === 'ArrowLeft') i = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'ArrowRight') i = (i + 1) % tabs.length;
      else if (e.key === 'Home') i = 0;
      else i = tabs.length - 1;
      e.preventDefault();
      showTab(box, tabs[i].dataset.tab, { focus: true });
      return;
    }
    // 試合カードの開閉（Enter / Space）
    const head = e.target.matches && e.target.matches('[data-collapse]') ? e.target : null;
    if (head && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggleCard(head);
    }
  });

  function toggleCard(head) {
    const d = document.getElementById(head.dataset.collapse);
    if (!d) return;
    const open = d.classList.toggle('open');
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  document.addEventListener('click', (e) => {
    const themeBtn = e.target.closest('[data-theme-toggle]');
    if (themeBtn) {
      themeMode = MODES[(MODES.indexOf(themeMode) + 1) % MODES.length];
      try { localStorage.setItem('theme', themeMode); } catch { /* 無視 */ }
      applyTheme();
      redrawLp();
      return;
    }

    if (e.target.closest('[data-reload]')) { location.reload(); return; }

    const tab = e.target.closest('[data-tabs] .tab');
    if (tab) { showTab(tab.closest('[data-tabs]'), tab.dataset.tab); return; }

    // 「もっと見る」: ページ全体を読み込み直さず、試合リストだけ差し替える
    const more = e.target.closest('a[data-more]');
    if (more && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      more.setAttribute('aria-busy', 'true');
      more.textContent = '読み込み中…';
      refreshProfile(more.href)
        .then(() => { try { history.replaceState(null, '', more.href + location.hash); } catch { /* 無視 */ } })
        .catch(() => { location.href = more.href; });
      return;
    }

    // 試合カードの開閉
    const head = e.target.closest('[data-collapse]');
    if (head && !e.target.closest('a, button')) { toggleCard(head); return; }

    // タイムライン分析
    const tl = e.target.closest('.tl-btn');
    if (tl) { loadFragment(tl, '/api/timeline?matchId=' + encodeURIComponent(tl.dataset.match) + '&puuid=' + encodeURIComponent(tl.dataset.puuid)); return; }

    // ルーン・スキル・ビルド
    const bd = e.target.closest('.build-btn');
    if (bd) { loadFragment(bd, '/api/detail?matchId=' + encodeURIComponent(bd.dataset.match) + '&puuid=' + encodeURIComponent(bd.dataset.puuid)); }
  });

  async function loadFragment(btn, url) {
    if (btn.disabled) return;
    const out = btn.nextElementSibling;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '読み込み中…';
    try {
      const r = await fetch(url);
      if (!r.ok) throw httpError(r); // v6.6: エラー文をそのまま差し込まず、ボタンも残して再試行できるようにする
      out.innerHTML = await r.text();
      btn.remove();
    } catch (err) {
      out.replaceChildren(errorBox(err));
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---- 絞り込み入力: <input data-filter="セレクタ"> ----
  document.addEventListener('input', (e) => {
    const inp = e.target.closest && e.target.closest('input[data-filter]');
    if (inp) {
      const q = inp.value.trim().toLowerCase();
      $$(inp.dataset.filter).forEach((el) => {
        el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }
    // Riot ID の入力: エラー表示を消す
    if (e.target.matches && e.target.matches('input[data-riotid]')) e.target.setCustomValidity('');
  });

  // ---- Riot ID の入力チェック（v6.6: 間違えても今の画面と入力を残す） ----
  document.addEventListener('submit', (e) => {
    const inp = e.target.querySelector && e.target.querySelector('input[data-riotid]');
    if (!inp) return;
    const v = inp.value.trim();
    const i = v.lastIndexOf('#');
    if (i > 0 && i < v.length - 1) { inp.setCustomValidity(''); saveRecent(e.target, v); return; }
    e.preventDefault();
    inp.setCustomValidity('Riot IDは「ゲーム名#タグ」の形式で入力してください。');
    inp.reportValidity();
  });

  // ---- 最近の検索（v6.10.0）: 検索した Riot ID を 6 件まで、この端末のブラウザにだけ保存する ----
  // トップの検索欄の下にボタンで並べ、押すと入力欄とリージョンを埋めてそのまま検索する。サーバーには送らない。
  const RECENT_KEY = 'recentSearches';
  const RECENT_MAX = 6;
  const readRecent = () => {
    try {
      const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(a)
        ? a.filter((x) => x && typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 64).slice(0, RECENT_MAX)
        : [];
    } catch { return []; }
  };
  const writeRecent = (list) => {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* 保存できなくても検索は使える */ }
  };
  function saveRecent(form, id) {
    const sel = form.querySelector('select[name="region"]');
    const region = sel ? sel.value : '';
    const same = (x) => x.id.toLowerCase() === id.toLowerCase() && (x.region || '') === region;
    writeRecent([{ id, region }].concat(readRecent().filter((x) => !same(x))));
  }
  function renderRecent() {
    const box = $('[data-recent]');
    if (!box) return;
    const list = readRecent();
    box.textContent = '';
    if (list.length === 0) { box.hidden = true; return; }
    const label = document.createElement('span');
    label.className = 'xs mute';
    label.textContent = '最近の検索';
    box.appendChild(label);
    list.forEach((x) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.recentId = x.id;
      b.dataset.recentRegion = x.region || '';
      b.textContent = x.id;
      if (x.region && x.region !== 'jp') {
        const tag = document.createElement('small');
        tag.textContent = x.region.toUpperCase();
        b.appendChild(tag);
      }
      box.appendChild(b);
    });
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'chip quiet';
    clear.dataset.recentClear = '1';
    clear.textContent = '履歴を消す';
    box.appendChild(clear);
    box.hidden = false;
  }
  renderRecent();
  document.addEventListener('click', (e) => {
    const chip = e.target.closest && e.target.closest('[data-recent-id]');
    if (chip) {
      const form = $('.searchbox');
      const inp = form && form.querySelector('input[data-riotid]');
      if (!inp) return;
      inp.value = chip.dataset.recentId;
      const sel = form.querySelector('select[name="region"]');
      const r = chip.dataset.recentRegion;
      if (sel && r && Array.from(sel.options).some((o) => o.value === r)) sel.value = r;
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
      return;
    }
    if (e.target.closest && e.target.closest('[data-recent-clear]')) { writeRecent([]); renderRecent(); }
  });

  // ---- 429 の画面: 待ち時間のカウントダウン ----
  $$('[data-countdown]').forEach((el) => {
    let n = Number(el.dataset.countdown) || 0;
    const t = setInterval(() => {
      n -= 1;
      el.textContent = String(Math.max(0, n));
      if (n <= 0) clearInterval(t);
    }, 1000);
  });

  // ---- 横スクロールできるメニューの端をぼかして、隠れた項目に気づけるようにする ----
  const updateFade = (el) => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('can-left', el.scrollLeft > 4);
    el.classList.toggle('can-right', max > 4 && el.scrollLeft < max - 4);
  };
  const fadeTargets = $$('.tabs, .nav-links');
  fadeTargets.forEach((el) => {
    updateFade(el);
    el.addEventListener('scroll', () => updateFade(el), { passive: true });
  });
  window.addEventListener('resize', () => fadeTargets.forEach(updateFade));

  // ---- プロフィールの差し替え（v6.6: 同期の完了・「もっと見る」でページ全体を読み込み直さない） ----
  // 今のタブ・スクロール位置・開いている試合のまま、中身だけを新しい内容にする
  async function refreshProfile(href) {
    const u = new URL(href || location.href, location.href);
    u.searchParams.set('nosync', '1');
    u.searchParams.delete('refresh');
    const r = await fetch(u.toString(), { headers: { Accept: 'text/html' } });
    if (!r.ok) throw httpError(r);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    if (!doc.getElementById('overview')) throw new Error('unexpected');

    const openIds = $$('.m-detail.open').map((d) => d.id); // 開いていた試合は開いたままにする（件数が増えても番号は同じ順）
    ['overview', 'champs', 'analysis', 'lp'].forEach((id) => {
      const cur = document.getElementById(id);
      const next = doc.getElementById(id);
      if (cur && next) cur.innerHTML = next.innerHTML;
    });
    const curName = $('.banner .grow');
    const nextName = doc.querySelector('.banner .grow');
    if (curName && nextName) curName.innerHTML = nextName.innerHTML;
    openIds.forEach((id) => {
      const d = document.getElementById(id);
      if (!d) return;
      d.classList.add('open');
      const head = $('[data-collapse="' + id + '"]');
      if (head) head.setAttribute('aria-expanded', 'true');
    });

    // LP グラフ: データを入れ替えて描き直す
    const curLp = document.getElementById('lp-data');
    const nextLp = doc.getElementById('lp-data');
    if (curLp && nextLp) curLp.textContent = nextLp.textContent;
    lpRows = null;
    destroyLp();
    if (document.getElementById('lp')?.classList.contains('on')) drawLp();
    applyStyles();
  }

  // ---- 同期バー: 開いた直後に最新の試合を取り込み、終わったら中身だけ差し替える ----
  const bar = document.getElementById('syncBar');
  if (bar) {
    const text = document.getElementById('syncText');
    const prog = document.getElementById('syncProg');
    const q = new URLSearchParams({ puuid: bar.dataset.puuid, count: bar.dataset.count, force: bar.dataset.force });
    if (bar.dataset.queue) q.set('queue', bar.dataset.queue);
    if (bar.dataset.region) q.set('region', bar.dataset.region);
    const fail = (msg) => {
      text.textContent = msg;
      lolToast(msg, { type: 'error', ms: 7000 }); // v6.7.0
      const sp = bar.querySelector('.spin');
      if (sp) sp.remove();
      if (prog) prog.parentElement.remove();
    };
    const done = () => {
      text.textContent = '最新の試合を反映しています…';
      refreshProfile(location.href)
        .then(() => {
          // refresh=1 は一度きりの指示なので URL から外す（タブの # は残す）
          const u = new URL(location.href);
          if (u.searchParams.has('refresh')) { u.searchParams.delete('refresh'); try { history.replaceState(null, '', u.pathname + u.search + u.hash); } catch { /* 無視 */ } }
          bar.remove();
        })
        .catch(() => {
          // 差し替えに失敗したら、従来どおりページを読み込み直す
          const u = new URL(location.href);
          u.searchParams.set('nosync', '1');
          u.searchParams.delete('refresh');
          location.replace(u.toString());
        });
    };
    // 処理の記録はサーバーのメモリにあるので、再起動やスリープで消えることがある（404）。1回だけ始め直す
    let restarted = false;
    const start = () => fetch('/api/sync/start?' + q.toString(), { method: 'POST' })
      .then(async (r) => {
        if (r.status === 429) throw httpError(r);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || '');
        return j;
      });
    const poll = async (id, t0) => {
      if (Date.now() - t0 > 5 * 60 * 1000) return fail('時間がかかっています。後で再読み込みしてください。');
      let job;
      try {
        const r = await fetch('/api/sync/status?job=' + encodeURIComponent(id));
        if (r.status === 429) { // 確認が多すぎるだけなので、待ってから続ける
          const wait = (Number(r.headers.get('Retry-After')) || 5) * 1000;
          return setTimeout(() => poll(id, t0), wait);
        }
        if (r.status === 404 && !restarted) {
          restarted = true;
          const j = await start();
          return j.state === 'done' ? done() : poll(j.id, t0);
        }
        job = await r.json();
        if (!r.ok) throw new Error(job.error || '');
      } catch (err) { return fail(err.message || '状態を確認できませんでした。'); }
      if (job.state === 'error') return fail(job.error || '取得に失敗しました。');
      if (job.state === 'done') { text.textContent = '完了しました。'; if (prog) prog.style.width = '100%'; return setTimeout(done, 300); }
      if (job.total > 0) {
        text.textContent = '試合を取得中… ' + job.done + ' / ' + job.total;
        if (prog) prog.style.width = Math.max(6, Math.round((job.done / job.total) * 100)) + '%';
      }
      setTimeout(() => poll(id, t0), 1000);
    };
    start()
      .then((job) => (job.state === 'done' ? done() : poll(job.id, Date.now())))
      .catch((err) => fail(err.status === 429 ? errorText(err) : (err.message || '開始できませんでした。')));
  }

  // ---- LP推移グラフ（Chart.js は defer 読み込み。タブを開いたとき描く） ----
  const readLp = () => {
    if (lpRows) return lpRows;
    try { lpRows = JSON.parse(document.getElementById('lp-data')?.textContent || '[]'); } catch { lpRows = []; }
    return lpRows;
  };
  function destroyLp() {
    if (lpChart) { lpChart.destroy(); lpChart = null; }
    lpDrawn = false;
  }
  function redrawLp() {
    if (!lpDrawn) return;
    destroyLp();
    drawLp();
  }
  function drawLp() {
    const cv = document.getElementById('lpChart');
    if (!cv || lpDrawn || readLp().length < 2) return;
    if (!window.Chart) { setTimeout(drawLp, 150); return; }
    lpDrawn = true;
    const rows = readLp();
    // テーマの色に合わせる（ライト/ダークで変わる）
    const css = getComputedStyle(root);
    const cyan = css.getPropertyValue('--cyan').trim() || '#3ee8ff';
    const mute = css.getPropertyValue('--mute').trim() || '#8b9bb8';
    const line = css.getPropertyValue('--line').trim() || '#1f2d4a';
    lpChart = new window.Chart(cv, {
      type: 'line',
      data: {
        labels: rows.map((r) => new Date(r.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
        datasets: [{ data: rows.map((r) => r.value), borderColor: cyan, backgroundColor: /^#[0-9a-f]{6}$/i.test(cyan) ? cyan + '22' : 'rgba(62,232,255,.12)', fill: true, tension: .25, pointRadius: 3 }]
      },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => rows[c.dataIndex].text } } },
        scales: { x: { ticks: { color: mute, maxTicksLimit: 8 }, grid: { color: line } }, y: { ticks: { color: mute }, grid: { color: line } } }
      }
    });
  }
})();
