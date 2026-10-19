/*
 * MAIN world, все фреймы YouTube.
 * Медиаклавиши и наушники: «следующий / предыдущий трек» переключают шорт.
 *
 * Работает через Media Session API: системные медиаклавиши Chrome отдаёт вкладке,
 * которая сейчас играет звук, — поэтому окно с Shorts может быть на втором мониторе
 * и без фокуса. YouTube сам ставит свои обработчики, поэтому наши периодически
 * переустанавливаются.
 */
(function () {
  'use strict';
  if (!('mediaSession' in navigator)) return;

  const isTop = window.top === window;
  let parentOrigin = '';
  if (!isTop) {
    try {
      const anc = location.ancestorOrigins;
      // Фрейм внутри просмотрщика расширения: сообщаем о нажатии родителю.
      if (anc && anc.length && anc[anc.length - 1].startsWith('chrome-extension://')) parentOrigin = anc[0];
    } catch {
      /* ancestorOrigins недоступен */
    }
    if (!parentOrigin) return;
  }

  function onShortsPage() {
    return /^\/shorts(\/|$)/.test(location.pathname) || !!parentOrigin;
  }

  function send(action) {
    if (parentOrigin) {
      window.parent.postMessage(JSON.stringify({ yfs: 'frame', event: 'media-' + action }), parentOrigin);
    } else {
      document.dispatchEvent(new CustomEvent('yfs:media', { detail: action }));
    }
  }

  function install() {
    if (!onShortsPage()) return;
    try {
      navigator.mediaSession.setActionHandler('nexttrack', () => send('next'));
      navigator.mediaSession.setActionHandler('previoustrack', () => send('prev'));
    } catch {
      /* действие не поддерживается */
    }
  }

  // YouTube переставляет свои обработчики при смене ролика — переустанавливаем,
  // но только пока открыта страница Shorts (или это фрейм просмотрщика).
  let timer = null;
  function sync() {
    const need = onShortsPage();
    if (need) install();
    if (need && !timer) timer = setInterval(install, 2000);
    if (!need && timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  sync();
  document.addEventListener('yt-navigate-finish', sync);
  window.addEventListener('popstate', sync);
})();
