// ライブゲーム: データ不足の人の直近の試合を、ボタンを押したときだけ順番に取得する
(function () {
  const box = document.getElementById('fillBox');
  if (!box) return;
  const btn = document.getElementById('fillBtn');
  const text = document.getElementById('fillText');
  const puuids = (box.dataset.puuids || '').split(',').filter(Boolean);
  const region = box.dataset.region ? '&region=' + encodeURIComponent(box.dataset.region) : '';

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    let failed = 0;
    for (let i = 0; i < puuids.length; i++) {
      text.textContent = '取得中… ' + (i + 1) + ' / ' + puuids.length;
      try {
        const r = await fetch('/api/live-fill?puuid=' + encodeURIComponent(puuids[i]) + region, { method: 'POST' });
        if (!r.ok) failed++;
      } catch { failed++; }
    }
    text.textContent = failed ? '一部を取得できませんでした（' + failed + ' 人）。再読み込みします…' : '取得しました。再読み込みします…';
    if (failed && window.lolToast) window.lolToast('一部のプレイヤーの試合を取得できませんでした（' + failed + ' 人）。時間をおいて、もう一度お試しください。', { type: 'error', ms: 7000 });
    setTimeout(() => location.reload(), 800);
  });
})();

// v6.6: ライブゲームの経過時間を、取得した時点から 1 秒ごとに進める（再読み込みしなくても実際のゲームに近い表示になる）
(function () {
  const el = document.querySelector('[data-elapsed]');
  if (!el) return;
  const base = Number(el.dataset.elapsed) || 0;
  const t0 = Date.now();
  const fmt = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const tick = () => { el.textContent = fmt(base + Math.floor((Date.now() - t0) / 1000)); };
  setInterval(tick, 1000);
})();
