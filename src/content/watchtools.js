/*
 * Текст видео и AI-сводка на обычной странице ролика youtube.com.
 *
 * Под названием ролика — две кнопки: «📝 Текст видео» и «✨ Краткая сводка».
 * Они (и такие же кнопки в popup расширения) открывают справа поверх страницы
 * ту же панель, что в просмотрщике (viewer/textpanel.js): текст с тайм-кодами и без,
 * копирование, .txt, клик по времени — перемотка; сводка Gemini с кэшем.
 *
 * Всё в shadow DOM, чтобы стили YouTube и наши не мешали друг другу.
 */
(function () {
  'use strict';
  if (window.top !== window || globalThis.__yfsWatchAlive) return;
  globalThis.__yfsWatchAlive = true;

  const YFS = globalThis.YFS;
  const P = YFS.textPanel;
  const tr = (k, p) => YFS.i18n.t(k, p);

  let bar = null; // кнопки под названием ролика
  let overlay = null; // { host, root, slot, toast }
  let css = '';

  // После обновления расширения старые копии этого скрипта во вкладке продолжают жить
  // (их кнопки дублируются и уже не работают). Новая копия прячет чужие кнопки и панели,
  // а сама, оказавшись старой, тихо выключается.
  const VERSION = chrome.runtime.getManifest().version;
  const alive = () => {
    try {
      return !!chrome.runtime.id;
    } catch {
      return false;
    }
  };
  (function hideStaleCopies() {
    const old = document.getElementById('yfs-watch-style');
    if (old) old.remove();
    const style = document.createElement('style');
    style.id = 'yfs-watch-style';
    style.textContent = `#yfs-watch-bar:not([data-v="${VERSION}"]), #yfs-watch-panel:not([data-v="${VERSION}"]) { display: none !important; }`;
    (document.head || document.documentElement).append(style);
  })();

  // ---------- ролик на странице ----------

  function videoIdFromUrl() {
    if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v') || '';
    const m = location.pathname.match(/^\/shorts\/([\w-]{11})/);
    return m ? m[1] : '';
  }

  function activeVideoEl() {
    return (
      document.querySelector('ytd-reel-video-renderer[is-active] video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video')
    );
  }

  function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    return YFS.transcript.formatTime(sec);
  }

  function currentVideo() {
    const id = videoIdFromUrl();
    if (!id) return null;
    const short = location.pathname.startsWith('/shorts/');
    const h1 = short ? null : document.querySelector('ytd-watch-metadata #title h1');
    const title = (h1 && h1.textContent.trim()) || document.title.replace(/\s*-\s*YouTube\s*$/, '').replace(/^\(\d+\)\s*/, '');
    const chan = document.querySelector(short ? 'ytd-reel-video-renderer[is-active] #channel-name a, ytd-reel-video-renderer[is-active] .ytReelChannelBarViewModelChannelName' : 'ytd-watch-metadata #owner #channel-name a');
    const v = activeVideoEl();
    return { id, title, channel: chan ? chan.textContent.trim() : '', duration: v ? formatDuration(v.duration) : '', short };
  }

  // ---------- связь с фоновым скриптом ----------

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) reject(Object.assign(new Error(err.message), { code: 'ai-failed' }));
          else resolve(res);
        });
      } catch (err) {
        // Расширение перезагрузили, а вкладку — нет.
        reject(Object.assign(new Error(tr('watch.reload')), { code: 'ai-failed' }));
      }
    });
  }

  /** Сводку делает фоновый скрипт: запрос к Gemini уходит со страницы расширения, а не youtube.com. */
  // Ход генерации (какая модель, переключения) приходит от фонового скрипта отдельными сообщениями.
  const aiProgress = new Map(); // reqId → onProgress
  let aiSeq = 0;

  async function summarizeViaBackground(args) {
    const { onProgress, signal, ...rest } = args;
    const reqId = `ai${Date.now()}-${++aiSeq}`;
    if (onProgress) aiProgress.set(reqId, onProgress);
    const cancel = () => send({ type: 'yfs:ai-cancel', reqId }).catch(() => {});
    if (signal) signal.addEventListener('abort', cancel);
    try {
      const res = await send({ type: 'yfs:ai-summarize', reqId, args: rest });
      if (!res || !res.ok) throw Object.assign(new Error((res && res.message) || 'failed'), { code: (res && res.code) || 'ai-failed', tried: (res && res.tried) || [] });
      return res.out;
    } finally {
      aiProgress.delete(reqId);
      if (signal) signal.removeEventListener('abort', cancel);
    }
  }

  async function listModelsViaBackground(key) {
    const res = await send({ type: 'yfs:ai-models', key });
    if (!res || !res.ok) throw Object.assign(new Error((res && res.message) || 'failed'), { code: (res && res.code) || 'ai-failed' });
    return res.models;
  }

  const store = {
    async get(key, def) {
      try {
        const d = await chrome.storage.local.get(key);
        return d[key] === undefined ? def : d[key];
      } catch {
        return def;
      }
    },
    async set(key, value) {
      try {
        await chrome.storage.local.set({ [key]: value });
      } catch {
        /* расширение перезагрузили */
      }
    },
  };

  // ---------- оформление ----------

  const BASE_CSS = `
    :host { all: initial; }
    :host {
      --bg: #ffffff; --bg-elev: #ffffff; --text: #0f0f0f; --text-2: #606060; --chip: #0000000d; --chip-hover: #0000001a;
      --chip-active-bg: #0f0f0f; --chip-active-text: #ffffff; --border: #0000001a; --hover: #0000000d; --accent: #ff0033; --danger: #cc0000;
    }
    :host([dark]) {
      --bg: #0f0f0f; --bg-elev: #212121; --text: #f1f1f1; --text-2: #aaaaaa; --chip: #ffffff1a; --chip-hover: #ffffff33;
      --chip-active-bg: #f1f1f1; --chip-active-text: #0f0f0f; --border: #ffffff33; --hover: #ffffff1a; --danger: #ff6b6b;
    }
    * { box-sizing: border-box; }
    .muted { color: var(--text-2); }
    .small { font-size: 12px; }
    a { color: #3ea6ff; }
    .icon-btn { display: inline-grid; place-items: center; width: 40px; height: 40px; padding: 0; border: 0; border-radius: 50%;
      background: transparent; color: var(--text); font: inherit; cursor: pointer; }
    .icon-btn:hover { background: var(--hover); }
    .pill { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 16px; border: 0; border-radius: 18px;
      background: var(--chip); color: var(--text); font: inherit; font-weight: 500; white-space: nowrap; cursor: pointer; }
    .pill:hover { background: var(--chip-hover); }
    .pill.primary { background: var(--chip-active-bg); color: var(--chip-active-text); }
    .pill.primary:hover { opacity: .85; }
  `;

  const BAR_CSS = `
    .bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; font: 500 14px/1 Roboto, Arial, sans-serif; color: var(--text); }
    .bar.floating { position: fixed; right: 16px; bottom: 16px; z-index: 2100; margin: 0; }
    .bar.floating .pill { box-shadow: 0 2px 12px #0006; background: var(--bg-elev); }
  `;

  const OVERLAY_CSS = `
    .wrap { position: fixed; top: 68px; right: 16px; z-index: 2200; width: min(460px, calc(100vw - 32px));
      font: 14px/1.45 Roboto, Arial, sans-serif; color: var(--text); }
    .wrap .text-panel { margin: 0; background: var(--bg-elev); box-shadow: 0 8px 32px #0007; }
    .wrap .tp-body { max-height: calc(100vh - 160px); }
    .toast { position: fixed; left: 50%; bottom: 24px; z-index: 2300; transform: translateX(-50%); padding: 10px 16px; border-radius: 8px;
      background: #f1f1f1; color: #0f0f0f; font: 14px Roboto, Arial, sans-serif; box-shadow: 0 4px 16px #0006; }
    .toast.err { background: #cc0000; color: #fff; }
    .toast[hidden] { display: none; }
  `;

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    n.append(...kids.filter((k) => k !== null && k !== undefined));
    return n;
  }

  function applyTheme(host) {
    host.toggleAttribute('dark', document.documentElement.hasAttribute('dark'));
  }

  async function panelCss() {
    if (css) return css;
    try {
      const res = await send({ type: 'yfs:asset', path: 'src/viewer/textpanel.css' });
      css = (res && res.text) || '';
    } catch {
      css = '';
    }
    return css;
  }

  // ---------- панель поверх страницы ----------

  let toastTimer = 0;
  function toast(text, isError) {
    if (!overlay) return;
    const t = overlay.toast;
    t.textContent = text;
    t.className = isError ? 'toast err' : 'toast';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2200);
  }

  async function ensureOverlay() {
    if (overlay && overlay.host.isConnected) return overlay;
    const host = document.createElement('div');
    host.id = 'yfs-watch-panel';
    host.dataset.v = VERSION;
    const root = host.attachShadow({ mode: 'open' });
    const slot = el('div', { className: 'wrap' });
    const t = el('div', { className: 'toast', hidden: true });
    // Клавиши в панели не должны ставить паузу, листать и перематывать ролик (горячие клавиши YouTube).
    for (const type of ['keydown', 'keyup', 'keypress']) slot.addEventListener(type, (e) => e.stopPropagation());
    root.append(el('style', { textContent: BASE_CSS + (await panelCss()) + OVERLAY_CSS }), slot, t);
    (document.body || document.documentElement).append(host);
    overlay = { host, root, slot, toast: t };
    P.init({
      store,
      toast,
      frameMode: true,
      overlay: true,
      getTranscript: (id) => YFS.fetchTranscript(id),
      seek(sec) {
        const v = activeVideoEl();
        if (!v) return;
        v.currentTime = Math.max(0, sec);
        v.play().catch(() => {});
      },
      summarize: summarizeViaBackground,
      listModels: listModelsViaBackground,
      openSettings: (id) => send({ type: 'yfs:open-options', hash: 'prompt=' + encodeURIComponent(id) }).catch(() => {}),
    });
    return overlay;
  }

  async function open(tab) {
    const video = currentVideo();
    if (!video) return false;
    await i18nReady; // подписи панели — на выбранном языке, даже если скрипт подключили только что
    const o = await ensureOverlay();
    applyTheme(o.host);
    P.open({ video, frame: null, container: o.slot, tab: tab === 'summary' ? 'summary' : 'text' });
    return true;
  }

  /** Переход на другой ролик внутри YouTube: открытая панель переключается на него, иначе закрывается. */
  function followNavigation() {
    if (!P.isOpen) return;
    const video = currentVideo();
    if (!video) return P.hide();
    if (video.id !== P.videoId) P.follow(video, null, overlay.slot);
  }

  // ---------- кнопки под названием ролика ----------

  function makeBar(floating) {
    const host = document.createElement('div');
    host.id = 'yfs-watch-bar';
    host.dataset.v = VERSION;
    const root = host.attachShadow({ mode: 'open' });
    const text = el('button', { className: 'pill', type: 'button', textContent: tr('watch.text'), title: tr('watch.hint') });
    const sum = el('button', { className: 'pill', type: 'button', textContent: tr('watch.summary'), title: tr('watch.hint') });
    const audio = el('button', { className: 'pill', type: 'button', textContent: tr('watch.audio'), title: tr('audio.hint') });
    text.addEventListener('click', () => toggle('text'));
    sum.addEventListener('click', () => toggle('summary'));
    audio.addEventListener('click', () => YFS.audioMode && YFS.audioMode.toggle());
    root.append(el('style', { textContent: BASE_CSS + BAR_CSS }), el('div', { className: floating ? 'bar floating' : 'bar' }, text, sum, audio));
    applyTheme(host);
    return host;
  }

  function toggle(tab) {
    if (P.isOpen && P.videoId === videoIdFromUrl() && overlay && overlay.root.querySelector(`.tp-tab.active[data-tp-tab="${tab}"]`)) return P.hide();
    open(tab);
  }

  let missing = 0;
  function ensureBar() {
    const onWatch = location.pathname === '/watch' && !!videoIdFromUrl();
    if (!onWatch) {
      if (bar) bar.remove(), (bar = null);
      missing = 0;
      return;
    }
    const anchor = document.querySelector('ytd-watch-metadata #above-the-fold #middle-row');
    if (anchor) {
      if (bar && bar.isConnected && bar.nextElementSibling === anchor && !bar.shadowRoot.querySelector('.floating')) return applyTheme(bar);
      if (bar) bar.remove();
      bar = makeBar(false);
      anchor.parentElement.insertBefore(bar, anchor);
      return;
    }
    // Разметка YouTube поменялась и места под названием нет — показываем кнопки в углу экрана.
    if (++missing < 4 || (bar && bar.isConnected)) return;
    bar = makeBar(true);
    (document.body || document.documentElement).append(bar);
  }

  // Общее для resume.js и audiomode.js (тот же ролик, тот же <video>, та же проверка «расширение живо»).
  YFS.watch = { VERSION, alive, currentVideo, activeVideoEl, videoIdFromUrl, BASE_CSS, closePanel: () => P.isOpen && P.hide() };

  // ---------- popup расширения ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || sender.id !== chrome.runtime.id) return;
    if (msg.type === 'yfs:ai-progress') {
      const fn = aiProgress.get(msg.reqId);
      if (fn) fn(msg.progress);
    } else if (msg.type === 'yfs:watch-info') {
      const v = currentVideo();
      sendResponse(v ? { ok: true, video: v } : { ok: false });
    } else if (msg.type === 'yfs:watch-open') {
      open(msg.tab).then((ok) => sendResponse({ ok }), (err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  });

  const onNavigate = () => {
    missing = 0;
    ensureBar();
    followNavigation();
  };
  document.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('popstate', onNavigate);
  // Тема и перестройка разметки YouTube: редкая проверка, только на странице ролика.
  const timer = setInterval(() => {
    if (!alive()) {
      // Расширение обновили — эта копия устарела: убираем свои кнопки и больше ничего не делаем.
      clearInterval(timer);
      document.removeEventListener('yt-navigate-finish', onNavigate);
      window.removeEventListener('popstate', onNavigate);
      if (bar) bar.remove(), (bar = null);
      if (overlay) overlay.host.remove(), (overlay = null);
      return;
    }
    if (location.pathname === '/watch') ensureBar();
    if (overlay && P.isOpen) applyTheme(overlay.host);
  }, 1500);
  const i18nReady = YFS.i18n.init({ applyToPage: false }).catch(() => {});
  i18nReady.then(ensureBar);
  YFS.i18n.onChange(() =>
    YFS.i18n.init({ applyToPage: false }).then(() => {
      if (bar) bar.remove(), (bar = null);
      ensureBar();
    })
  );
})();
