/*
 * Плеер просмотрщика расширения без ошибок 152/153.
 *
 * Встроенный плеер YouTube (youtube.com/embed) отказывается работать на странице
 * chrome-extension://. Поэтому просмотрщик расширения открывает во фрейме обычную
 * страницу ролика (youtube.com/watch или /shorts), а фоновый скрипт снимает с неё
 * запрет на показ во фрейме — только для фреймов самого расширения.
 *
 * Этот скрипт работает лишь в таком фрейме: прячет шапку, комментарии и рекомендации,
 * растягивает плеер на весь кадр и сообщает просмотрщику «готов» / «досмотрен».
 */
(function () {
  'use strict';
  if (window.top === window) return;

  let parentOrigin = '';
  try {
    const anc = location.ancestorOrigins;
    const ours = 'chrome-extension://' + chrome.runtime.id;
    if (!anc || !anc.length || anc[anc.length - 1] !== ours) return; // фрейм на чужом сайте — не трогаем
    parentOrigin = anc[0];
  } catch {
    return;
  }

  const CSS = `
    html, body { overflow: hidden !important; background: #000 !important; }
    #masthead-container, ytd-masthead, #guide, tp-yt-app-drawer, ytd-mini-guide-renderer,
    #secondary, #below, #comments, #related, ytd-watch-metadata, ytd-merch-shelf-renderer,
    ytd-engagement-panel-section-list-renderer, .ytp-chrome-top-buttons, ytd-popup-container,
    #navigation-button-up, #navigation-button-down, ytd-reel-video-renderer:not([is-active]) { display: none !important; }
    #page-manager { margin: 0 !important; }
    #shorts-inner-container { overflow: hidden !important; }
    ytd-watch-flexy #movie_player, ytd-watch-flexy .html5-video-player {
      position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2000 !important;
    }
    ytd-watch-flexy #movie_player .html5-video-container {
      position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;
    }
    ytd-watch-flexy #movie_player video {
      position: absolute !important; width: 100% !important; height: 100% !important;
      left: 0 !important; top: 0 !important; object-fit: contain !important;
    }
  `;

  function injectStyle() {
    if (document.getElementById('yfs-frame-style')) return;
    const style = document.createElement('style');
    style.id = 'yfs-frame-style';
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
  }
  injectStyle();
  document.addEventListener('DOMContentLoaded', () => {
    injectStyle();
    // Плеер YouTube пересчитывает размеры по событию resize — подталкиваем его под новый кадр.
    for (const delay of [300, 1500, 4000]) setTimeout(() => window.dispatchEvent(new Event('resize')), delay);
  });

  function tell(event) {
    try {
      window.parent.postMessage(JSON.stringify({ yfs: 'frame', event, path: location.pathname + location.search }), parentOrigin);
    } catch {
      /* просмотрщик закрыли */
    }
  }

  let ready = false;
  function onMedia(e) {
    if (!(e.target instanceof HTMLVideoElement)) return;
    if (e.type === 'loadeddata' && location.search.includes('yfs=loop')) e.target.loop = true; // Shorts в просмотрщике
    if (!ready && (e.type === 'loadeddata' || e.type === 'playing')) {
      ready = true;
      tell('ready');
    }
    if (e.type === 'playing') tell('playing');
    if (e.type === 'ended') {
      tell('ended');
      cancelAutoplayNext();
    }
  }

  /**
   * После конца ролика YouTube через несколько секунд включает рекомендованный.
   * Во фрейме просмотрщика это лишнее: отменяем только этот переход (кнопка «Отмена»
   * на заставке), общая настройка автовоспроизведения в аккаунте не меняется.
   */
  function cancelAutoplayNext() {
    let tries = 0;
    const timer = setInterval(() => {
      const btn = document.querySelector('.ytp-autonav-endscreen-upnext-cancel-button, .ytp-upnext-cancel-button');
      if (btn && btn.offsetParent !== null) {
        btn.click();
        clearInterval(timer);
      } else if (++tries > 20) {
        clearInterval(timer);
      }
    }, 250);
  }
  for (const type of ['loadeddata', 'playing', 'ended']) document.addEventListener(type, onMedia, true);

  // ---------- команды просмотрщика: текст видео и перемотка ----------

  window.addEventListener('message', async (e) => {
    if (e.source !== window.parent || e.origin !== parentOrigin) return;
    let msg;
    try {
      msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }
    if (!msg || msg.yfs !== 'cmd') return;
    const reply = (payload) =>
      window.parent.postMessage(JSON.stringify({ yfs: 'frame', event: msg.cmd, reqId: msg.reqId, ...payload }), parentOrigin);

    if (msg.cmd === 'seek') {
      const v = document.querySelector('#movie_player video') || document.querySelector('video');
      if (v) {
        v.currentTime = Math.max(0, Number(msg.time) || 0);
        v.play().catch(() => {});
      }
    } else if (msg.cmd === 'transcript') {
      try {
        reply({ ok: true, ...(await YFS.fetchTranscript(String(msg.videoId || ''), String(msg.params || ''))) });
      } catch (err) {
        reply({ ok: false, error: err.message, details: err.details || '' });
      }
    }
  });
})();
