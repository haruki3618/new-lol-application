// プロフィールの「過去の試合をまとめて読み込む」ボタン（v5.2）。
// 画面は止めずに裏で取得し、終わったらページを読み込み直す。puuid は遅延読み込みタブのURLから読み取る。
(function () {
  const lazy = document.getElementById('mastery');
  const host = document.querySelector('.banner [data-history-host]') || document.querySelector('.banner .in > .flex');
  if (!lazy || !lazy.dataset.lazy || !host) return;
  const lazyParams = new URL(lazy.dataset.lazy, location.origin).searchParams;
  const puuid = lazyParams.get('puuid');
  const region = lazyParams.get('region') ? '&region=' + encodeURIComponent(lazyParams.get('region')) : '';
  if (!puuid) return;

  const box = document.createElement('div');
  box.className = 'flex aic g8 wrapf';
  const label = document.createElement('span');
  label.className = 'xs mute';
  label.textContent = '取得する試合数';
  const select = document.createElement('select');
  select.className = 'sm';
  select.title = '読み込む試合数（試合1件につき API を1回使います）';
  [[100, '100 試合'], [200, '200 試合'], [300, '300 試合']].forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    select.appendChild(o);
  });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn sm';
  btn.textContent = '過去の試合を読み込む';
  const text = document.createElement('span');
  text.className = 'xs mute';
  box.append(label, select, btn, text);
  host.appendChild(box);

  const fail = (msg) => {
    text.textContent = msg;
    if (window.lolToast) window.lolToast(msg, { type: 'error', ms: 7000 }); // v6.7.0: 画面の下にいても気づける
    btn.disabled = false;
    select.disabled = false;
  };

  const poll = async (id, startedAt) => {
    if (Date.now() - startedAt > 30 * 60 * 1000) return fail('時間がかかっています。後で再読み込みしてください。');
    let job;
    try {
      const r = await fetch('/api/history/status?job=' + encodeURIComponent(id));
      job = await r.json();
      if (!r.ok) throw new Error(job.error || '');
    } catch (err) {
      return fail(err.message || '状態を確認できませんでした。');
    }
    if (job.state === 'error') return fail(job.error || '取得に失敗しました。');
    if (job.state === 'done') {
      text.textContent = job.added + ' 件を追加しました。再読み込みします…';
      return setTimeout(() => location.reload(), 800);
    }
    text.textContent = job.phase === 'matches' && job.total > 0
      ? '取得中… ' + job.done + ' / ' + job.total + '（他の操作を優先するため時間がかかります）'
      : '試合の一覧を確認中… ' + job.found + ' 件';
    setTimeout(() => poll(id, startedAt), 1500);
  };

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    select.disabled = true;
    text.textContent = '開始しています…';
    try {
      const r = await fetch('/api/history/start?puuid=' + encodeURIComponent(puuid) + '&limit=' + select.value + region, { method: 'POST' });
      const job = await r.json();
      if (!r.ok) throw new Error(job.error || '');
      poll(job.id, Date.now());
    } catch (err) {
      fail(err.message || '開始できませんでした。');
    }
  });
})();
