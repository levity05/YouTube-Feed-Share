/*
 * Текст видео и AI-сводка на обычной странице ролика youtube.com.
 *
 * Под названием ролика — кнопки: «📝 Текст видео», «✨ Краткая сводка», «🎧 Аудио-режим», «⚡ СДВГ-режим»,
 * а у музыкальных роликов ещё «🎵 Где послушать» — меню с поиском этого трека на Spotify, Apple Music и других площадках.
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

  const M = YFS.music;
  let bar = null; // кнопки под названием ролика
  let musicState = { id: '', show: false, t: null }; // похоже ли открытое видео на трек
  let menuOff = null; // снять обработчики открытого меню площадок
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

  /** Любой AI-запрос через фоновый скрипт: type — yfs:ai-summarize | yfs:ai-focus | yfs:ai-repair. */
  async function aiViaBackground(type, args) {
    const { onProgress, signal, ...rest } = args;
    const reqId = `ai${Date.now()}-${++aiSeq}`;
    if (onProgress) aiProgress.set(reqId, onProgress);
    const cancel = () => send({ type: 'yfs:ai-cancel', reqId }).catch(() => {});
    if (signal) signal.addEventListener('abort', cancel);
    try {
      const res = await send({ type, reqId, args: rest });
      if (!res || !res.ok) throw Object.assign(new Error((res && res.message) || 'failed'), { code: (res && res.code) || 'ai-failed', tried: (res && res.tried) || [] });
      return res.out;
    } finally {
      aiProgress.delete(reqId);
      if (signal) signal.removeEventListener('abort', cancel);
    }
  }

  const summarizeViaBackground = (args) => aiViaBackground('yfs:ai-summarize', args);

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
    .pill[hidden] { display: none; }
    .menu { position: fixed; z-index: 2300; min-width: 230px; max-width: 320px; max-height: calc(100vh - 16px); overflow-y: auto; padding: 6px; border: 1px solid var(--border); border-radius: 12px;
      background: var(--bg-elev); color: var(--text); box-shadow: 0 8px 32px #0008; font: 14px/1.3 Roboto, Arial, sans-serif; }
    .menu-title { margin-bottom: 4px; padding: 6px 10px 8px; border-bottom: 1px solid var(--border); color: var(--text-2); font-size: 12px; overflow-wrap: anywhere; }
    .menu a, .menu .mi { display: block; width: 100%; padding: 8px 10px; border: 0; border-radius: 8px; background: none; color: var(--text); font: inherit;
      text-align: left; text-decoration: none; cursor: pointer; }
    .menu a:hover, .menu .mi:hover { background: var(--hover); }
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
    if (YFS.focusMode) YFS.focusMode.closePanel(); // панели справа не накладываются друг на друга
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
    const focus = el('button', { className: 'pill', type: 'button', textContent: tr('watch.focus'), title: tr('focus.hint') });
    const music = el('button', { className: 'pill music', type: 'button', textContent: tr('watch.music'), title: tr('watch.musicHint'), hidden: true });
    music.addEventListener('click', () => toggleMusicMenu(root, music));
    text.addEventListener('click', () => toggle('text'));
    sum.addEventListener('click', () => toggle('summary'));
    audio.addEventListener('click', () => YFS.audioMode && YFS.audioMode.toggle());
    focus.addEventListener('click', () => YFS.focusMode && YFS.focusMode.togglePanel());
    root.append(el('style', { textContent: BASE_CSS + BAR_CSS }), el('div', { className: floating ? 'bar floating' : 'bar' }, text, sum, audio, focus, music));
    applyTheme(host);
    music.hidden = !(musicState.show && musicState.id === videoIdFromUrl());
    return host;
  }

  // ---------- 🎵 меню «Где послушать» ----------

  function closeMusicMenu(root) {
    const old = root && root.querySelector('.menu');
    if (old) old.remove();
    if (menuOff) menuOff();
    menuOff = null;
  }

  function toggleMusicMenu(root, btn) {
    if (root.querySelector('.menu')) return closeMusicMenu(root);
    const t = musicState.t;
    if (!t || !M) return;
    const menu = el('div', { className: 'menu', role: 'menu' }, el('div', { className: 'menu-title' }, t.artist && t.track ? `${t.artist} — ${t.track}` : t.query));
    for (const p of M.platformLinks(t.query)) menu.append(el('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', role: 'menuitem', textContent: p.name }));
    const copy = el('button', { className: 'mi', type: 'button', role: 'menuitem', textContent: tr('audio.copyTrack') });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(t.artist && t.track ? `${t.artist} — ${t.track}` : t.query);
        copy.textContent = tr('text.copied');
      } catch {
        /* без буфера обмена */
      }
    });
    const audio = el('button', { className: 'mi', type: 'button', role: 'menuitem', textContent: tr('watch.audio') });
    audio.addEventListener('click', () => {
      closeMusicMenu(root);
      if (YFS.audioMode) YFS.audioMode.toggle(true);
    });
    menu.append(copy, audio);
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(Math.round(r.left), window.innerWidth - 330))}px`;
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    root.append(menu);
    // Внизу экрана меню не помещается — открываем его над кнопкой.
    const h = menu.getBoundingClientRect().height;
    if (r.bottom + 6 + h > window.innerHeight - 8) menu.style.top = `${Math.max(8, Math.round(r.top - h - 6))}px`;
    const outside = (ev) => {
      if (!ev.composedPath().includes(root.host)) closeMusicMenu(root);
    };
    const onKey = (ev) => ev.key === 'Escape' && closeMusicMenu(root);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', outside, { once: true, passive: true });
    menuOff = () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  /** Похоже ли открытое видео на трек: для таких роликов на странице появляется кнопка «🎵 Где послушать». */
  async function checkMusic() {
    const id = videoIdFromUrl();
    if (!id || !M || musicState.id === id || location.pathname !== '/watch') return;
    musicState = { id, show: false, t: null };
    const v = currentVideo();
    const info = (YFS.askPage && (await YFS.askPage('music', id, 3000))) || {};
    if (videoIdFromUrl() !== id) return;
    const title = info.title || (v && v.title) || '';
    const channel = info.author || (v && v.channel) || '';
    if (!title) {
      musicState.id = ''; // заголовка ещё нет — проверим при следующем проходе
      return;
    }
    const score = M.musicScore({ title, channel, durationSec: info.lengthSec, musicVideoType: info.musicVideoType, category: info.category });
    musicState = { id, show: info.category === 'Music' || score >= 0.35, t: M.parseTrack(title, channel) };
    refreshMusicButton();
  }

  function refreshMusicButton() {
    const b = bar && bar.shadowRoot && bar.shadowRoot.querySelector('.music');
    if (!b) return;
    b.hidden = !(musicState.show && musicState.id === videoIdFromUrl());
    if (b.hidden) closeMusicMenu(bar.shadowRoot);
  }

  function toggle(tab) {
    if (P.isOpen && P.videoId === videoIdFromUrl() && overlay && overlay.root.querySelector(`.tp-tab.active[data-tp-tab="${tab}"]`)) return P.hide();
    open(tab);
  }

  let missing = 0;
  function ensureBar() {
    const onWatch = location.pathname === '/watch' && !!videoIdFromUrl();
    if (!onWatch) {
      if (bar) closeMusicMenu(bar.shadowRoot), bar.remove(), (bar = null);
      missing = 0;
      return;
    }
    checkMusic();
    refreshMusicButton();
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
  YFS.watch = {
    VERSION,
    alive,
    currentVideo,
    activeVideoEl,
    videoIdFromUrl,
    BASE_CSS,
    store,
    ai: aiViaBackground,
    openSettings: (hash) => send({ type: 'yfs:open-options', hash: hash || '' }).catch(() => {}),
    closePanel: () => P.isOpen && P.hide(),
    closeAll: () => {
      if (P.isOpen) P.hide();
      if (YFS.focusMode) YFS.focusMode.closePanel();
    },
  };

  // ---------- popup расширения ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || sender.id !== chrome.runtime.id) return;
    if (msg.type === 'yfs:ai-progress') {
      const fn = aiProgress.get(msg.reqId);
      if (fn) fn(msg.progress);
    } else if (msg.type === 'yfs:watch-info') {
      const v = currentVideo();
      sendResponse(v ? { ok: true, video: v } : { ok: false });
    } else if (msg.type === 'yfs:watch-open' && msg.tab === 'focus') {
      i18nReady.then(() => {
        if (!currentVideo() || !YFS.focusMode) return sendResponse({ ok: false });
        if (P.isOpen) P.hide();
        YFS.focusMode.togglePanel();
        sendResponse({ ok: true });
      });
      return true;
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
  // Тема и перестройка разметки YouTube: редкая проверка (общий таймер loop.js; в фоновой вкладке не тикает).
  const stopLoop = YFS.loop.every(1500, () => {
    if (!alive()) {
      // Расширение обновили — эта копия устарела: убираем свои кнопки и больше ничего не делаем.
      stopLoop();
      document.removeEventListener('yt-navigate-finish', onNavigate);
      window.removeEventListener('popstate', onNavigate);
      if (bar) bar.remove(), (bar = null);
      if (overlay) overlay.host.remove(), (overlay = null);
      return;
    }
    if (location.pathname === '/watch') ensureBar();
    if (overlay && P.isOpen) applyTheme(overlay.host);
  });
  const i18nReady = YFS.i18n.init({ applyToPage: false }).catch(() => {});
  i18nReady.then(ensureBar);
  // Язык сменили в настройках: новый словарь, потом событие yfs:lang-change — каждая панель на странице
  // (аудио-режим, СДВГ, фильтр, группы) пересобирается сама, без перезагрузки вкладки.
  YFS.i18n.onChange(() =>
    YFS.i18n.init({ applyToPage: false }).then(() => {
      if (bar) closeMusicMenu(bar.shadowRoot), bar.remove(), (bar = null);
      ensureBar();
      if (P.isOpen && overlay) {
        const tab = overlay.root.querySelector('.tp-tab.active[data-tp-tab="summary"]') ? 'summary' : 'text';
        P.hide();
        open(tab);
      }
      document.dispatchEvent(new CustomEvent('yfs:lang-change'));
    })
  );
})();
