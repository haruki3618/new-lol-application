// プロフィールに「プレイ傾向」へのリンクを足す（v6.0）。puuid は遅延読み込みタブのURLから読み取る（history.js と同じ方法）。
(function () {
  const lazy = document.getElementById('mastery');
  const host = document.querySelector('.banner .banner-actions') || document.querySelector('.banner .in > .flex');
  if (!lazy || !lazy.dataset.lazy || !host) return;
  // v6.10.1: プロフィールのテンプレートが同じリンクを持っているときは、重ねて足さない
  if (host.querySelector('a[href^="/insights/"]')) return;
  const puuid = new URL(lazy.dataset.lazy, location.origin).searchParams.get('puuid');
  if (!puuid || !/^[\w-]{20,100}$/.test(puuid)) return;

  const a = document.createElement('a');
  a.className = 'btn sm';
  a.href = '/insights/' + encodeURIComponent(puuid);
  a.textContent = 'プレイ傾向を診断';
  a.title = '連敗後・時間帯・チャンピオンプールなどの傾向（保存済みの試合から計算。API は使いません）';
  host.appendChild(a);
})();
