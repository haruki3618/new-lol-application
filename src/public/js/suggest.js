// Riot ID 入力欄の予測（v6.5）
// 2文字ほど打つと、これまでに見かけたプレイヤーの候補を /api/suggest から取得して一覧に出す。
// ↑↓ で選択・Enter で決定・Esc で閉じる。マウス・タッチでも選べる。
(function () {
  const SELECTOR = 'input[name="riotId"], input[name="a"], input[name="b"]';
  const MIN_WAIT = 180; // 入力が止まってから問い合わせるまでの待ち（ミリ秒）
  let box = null; // 候補の一覧（1つを使い回す）
  let current = null; // いま候補を出している入力欄
  let items = [];
  let active = -1;
  let timer = 0;
  let ctrl = null;
  let seq = 0;

  const ensureBox = () => {
    if (box) return box;
    box = document.createElement('ul');
    box.className = 'suggest';
    box.id = 'suggest-list';
    box.setAttribute('role', 'listbox');
    box.hidden = true;
    // 入力欄からフォーカスが外れないよう、マウスで押した時点では何もさせない
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) choose(Number(li.dataset.i));
    });
    document.body.appendChild(box);
    return box;
  };

  const place = () => {
    if (!box || !current || box.hidden) return;
    const r = current.getBoundingClientRect();
    box.style.left = Math.round(r.left) + 'px';
    box.style.top = Math.round(r.bottom + 4) + 'px';
    box.style.width = Math.max(Math.round(r.width), 220) + 'px';
  };

  const close = () => {
    if (box) box.hidden = true;
    items = [];
    active = -1;
    if (current) {
      current.setAttribute('aria-expanded', 'false');
      current.removeAttribute('aria-activedescendant');
    }
  };

  const mark = (i) => {
    active = i;
    box.querySelectorAll('li').forEach((li, k) => {
      const on = k === i;
      li.classList.toggle('on', on);
      li.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        current.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView({ block: 'nearest' });
      }
    });
  };

  const render = (list, q) => {
    items = list;
    active = -1;
    if (!list.length) return close();
    const b = ensureBox();
    b.textContent = '';
    const lower = q.toLowerCase();
    list.forEach((it, i) => {
      const li = document.createElement('li');
      li.id = 'suggest-' + i;
      li.dataset.i = String(i);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      // 入力と一致した部分を強調（textContent で組み立てるので、名前に記号が含まれても安全）
      const name = document.createElement('span');
      name.className = 'sg-name';
      const at = it.gameName.toLowerCase().indexOf(lower.split('#')[0].trim());
      const len = lower.split('#')[0].trim().length;
      if (at >= 0 && len > 0) {
        name.append(it.gameName.slice(0, at));
        const m = document.createElement('mark');
        m.textContent = it.gameName.slice(at, at + len);
        name.append(m, it.gameName.slice(at + len));
      } else {
        name.textContent = it.gameName;
      }
      const tag = document.createElement('span');
      tag.className = 'sg-tag';
      tag.textContent = '#' + it.tagLine;
      li.append(name, tag);
      b.appendChild(li);
    });
    b.hidden = false;
    current.setAttribute('aria-expanded', 'true');
    place();
  };

  function choose(i) {
    const it = items[i];
    if (!it || !current) return;
    const input = current;
    input.value = it.riotId;
    close();
    const form = input.form;
    // 検索ボックスなら、そのまま検索する。比較ページなどの2つ並んだ入力欄は、次の欄へ移るだけ
    if (form && input.name === 'riotId' && form.getAttribute('action') === '/search') {
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
    } else {
      const next = form && Array.from(form.querySelectorAll(SELECTOR)).find((el) => el !== input && !el.value);
      (next || input).focus();
    }
  }

  const fetchSuggest = async (input) => {
    const q = input.value.trim();
    if ([...q.split('#')[0].trim()].length < 2 && !q.includes('#')) return close();
    if (q.length > 40) return close();
    const my = ++seq;
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    const sel = input.form && input.form.querySelector('select[name="region"]');
    const params = new URLSearchParams({ q });
    if (sel && sel.value) params.set('region', sel.value);
    try {
      const r = await fetch('/api/suggest?' + params.toString(), { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) return close();
      const data = await r.json();
      if (my !== seq || current !== input) return; // 古い応答は捨てる
      render(Array.isArray(data.items) ? data.items : [], q);
    } catch {
      /* 中断・通信失敗は無視（予測が出ないだけで、検索は使える） */
    }
  };

  document.addEventListener('focusin', (e) => {
    const input = e.target.closest && e.target.closest(SELECTOR);
    if (!input) return;
    if (!input.hasAttribute('role')) {
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-controls', 'suggest-list');
      input.setAttribute('aria-expanded', 'false');
      input.setAttribute('autocomplete', 'off');
    }
    if (current && current !== input) close();
    current = input;
  });

  document.addEventListener('input', (e) => {
    const input = e.target.closest && e.target.closest(SELECTOR);
    if (!input) return;
    current = input;
    clearTimeout(timer);
    // 日本語入力の変換中は問い合わせない（確定後の input で拾う）
    if (e.isComposing) return;
    timer = setTimeout(() => fetchSuggest(input), MIN_WAIT);
  });

  document.addEventListener('compositionend', (e) => {
    const input = e.target.closest && e.target.closest(SELECTOR);
    if (!input) return;
    clearTimeout(timer);
    timer = setTimeout(() => fetchSuggest(input), MIN_WAIT);
  });

  document.addEventListener('keydown', (e) => {
    const input = e.target.closest && e.target.closest(SELECTOR);
    if (!input || !box || box.hidden || !items.length || e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); mark((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mark((active - 1 + items.length) % items.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { close(); }
  });

  document.addEventListener('focusout', (e) => {
    if (e.target.closest && e.target.closest(SELECTOR)) setTimeout(() => { if (document.activeElement !== current) close(); }, 120);
  });
  document.addEventListener('click', (e) => {
    if (box && !box.hidden && !e.target.closest(SELECTOR) && !e.target.closest('.suggest')) close();
  });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, { passive: true });
})();
