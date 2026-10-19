'use strict';

/*
 * player.html?v=<id>[&loop=1] — плеер YouTube на обычном https-адресе
 * и мост сообщений IFrame API между ним и просмотрщиком-родителем.
 */
(function () {
  const YT_ORIGIN = 'https://www.youtube.com';
  const params = new URLSearchParams(location.search);
  const id = params.get('v') || '';
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return;

  const yt = document.getElementById('yt');
  let src = `${YT_ORIGIN}/embed/${id}?autoplay=1&rel=0&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
  if (params.get('loop') === '1') src += `&loop=1&playlist=${id}`;
  yt.src = src;

  // Сами подписываемся на события плеера — родитель может прислать «listening» раньше, чем плеер загрузится.
  yt.addEventListener('load', () => {
    for (const delay of [0, 1000, 3000]) {
      setTimeout(() => yt.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'yfs-wrapper', channel: 'widget' }), YT_ORIGIN), delay);
    }
  });

  window.addEventListener('message', (e) => {
    if (e.source === yt.contentWindow && e.origin === YT_ORIGIN) {
      // Состояние плеера (готов, ошибка, закончился) — родителю; данных пользователя тут нет.
      if (window.parent !== window) window.parent.postMessage(e.data, '*');
    } else if (e.source === window.parent && window.parent !== window) {
      // Команды родителя (mute, playVideo…) — плееру.
      yt.contentWindow.postMessage(e.data, YT_ORIGIN);
    }
  });
})();
