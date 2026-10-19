/*
 * «Где я остановился»: локальный список недавних роликов с моментом остановки.
 *
 * YouTube запоминает позицию не всегда (особенно без входа в аккаунт, после рекламы
 * или при переходах внутри сайта). Здесь позиция ролика сохраняется в chrome.storage.local
 * каждые ~10 секунд, на паузе и при уходе со страницы. Popup показывает последние 5 —
 * одно нажатие открывает ролик ровно с этого места. А если YouTube сам открыл ролик
 * с начала, слева внизу появляется «Вы остановились на 12:34 — Продолжить».
 *
 * Список: yfs_resume = [{ id, title, channel, t, d, at, done }], свежие сверху, не больше 50.
 */
(function () {
  'use strict';
  if (window.top !== window || globalThis.__yfsResumeAlive) return;
  globalThis.__yfsResumeAlive = true;

  const YFS = globalThis.YFS;
  const W = YFS.watch;
  const T = YFS.transcript;
  const tr = (k, p) => YFS.i18n.t(k, p);
  const KEY = 'yfs_resume';
  const MAX = 50;
  const MIN_DURATION = 60; // короткие ролики не запоминаем
  const END_MARGIN = 20; // последние 20 секунд — ролик досмотрен

  let last = { id: '', t: -1 }; // что сохранили последним (чтобы не писать одно и то же)

  /** Тот ли ролик сейчас в плеере, что в адресе: после перехода внутри YouTube <video> ещё секунду-две играет старый. */
  function playingId() {
    const id = W.videoIdFromUrl();
    if (!id || location.pathname !== '/watch') return '';
    const flexy = document.querySelector('ytd-watch-flexy');
    const shown = flexy && flexy.getAttribute('video-id');
    return shown && shown !== id ? '' : id;
  }

  function adShowing() {
    const p = document.getElementById('movie_player');
    return !!(p && p.classList.contains('ad-showing'));
  }

  async function readList() {
    try {
      const d = await chrome.storage.local.get(KEY);
      return Array.isArray(d[KEY]) ? d[KEY] : [];
    } catch {
      return [];
    }
  }

  async function save(force) {
    if (!W.alive()) return;
    const id = playingId();
    const v = W.activeVideoEl();
    if (!id || !v || adShowing()) return;
    const d = v.duration;
    const t = v.currentTime;
    if (!Number.isFinite(d) || d < MIN_DURATION || t < 5) return;
    if (!force && last.id === id && Math.abs(t - last.t) < 3) return;
    last = { id, t };
    const info = W.currentVideo() || {};
    const entry = { id, title: info.title || '', channel: info.channel || '', t: Math.floor(t), d: Math.floor(d), at: Date.now(), done: d - t < END_MARGIN };
    const list = (await readList()).filter((x) => x && x.id !== id);
    list.unshift(entry);
    try {
      await chrome.storage.local.set({ [KEY]: list.slice(0, MAX) });
    } catch {
      /* расширение перезагрузили */
    }
  }

  // ---------- «Продолжить с …» ----------

  let prompt = null;

  function hidePrompt() {
    if (prompt) prompt.remove();
    prompt = null;
  }

  function showPrompt(entry) {
    hidePrompt();
    const host = document.createElement('div');
    host.id = 'yfs-resume';
    host.dataset.v = W.VERSION;
    host.toggleAttribute('dark', document.documentElement.hasAttribute('dark'));
    const root = host.attachShadow({ mode: 'open' });
    const css = `
      .box { position: fixed; left: 16px; bottom: 16px; z-index: 2150; display: flex; align-items: center; gap: 10px;
        padding: 10px 12px 10px 16px; border-radius: 12px; background: var(--bg-elev); color: var(--text);
        box-shadow: 0 6px 24px #0007; font: 14px/1.3 Roboto, Arial, sans-serif; }
      .x { width: 32px; height: 32px; }
    `;
    const go = document.createElement('button');
    go.className = 'pill primary';
    go.textContent = '▶ ' + tr('resume.continue');
    go.addEventListener('click', () => {
      const v = W.activeVideoEl();
      if (v) {
        v.currentTime = Math.max(0, entry.t - 3);
        v.play().catch(() => {});
      }
      hidePrompt();
    });
    const x = document.createElement('button');
    x.className = 'icon-btn x';
    x.textContent = '✕';
    x.setAttribute('aria-label', tr('common.close'));
    x.addEventListener('click', hidePrompt);
    const text = document.createElement('span');
    text.textContent = tr('resume.prompt', { time: T.formatTime(entry.t) });
    const box = document.createElement('div');
    box.className = 'box';
    box.append(text, go, x);
    const style = document.createElement('style');
    style.textContent = W.BASE_CSS + css;
    root.append(style, box);
    (document.body || document.documentElement).append(host);
    prompt = host;
    setTimeout(() => prompt === host && hidePrompt(), 15000);
  }

  /** Открыли ролик: если YouTube начал с начала, а мы помним место дальше — предложить продолжить. */
  async function checkResume() {
    hidePrompt();
    const id = W.videoIdFromUrl();
    if (!id || location.pathname !== '/watch' || /[?&]t=/.test(location.search)) return;
    const entry = (await readList()).find((x) => x.id === id);
    if (!entry || entry.done || entry.t < 30) return;
    // Даём плееру время: реклама, автопереход YouTube к своей сохранённой позиции.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (W.videoIdFromUrl() !== id) return;
      const v = W.activeVideoEl();
      if (v && playingId() === id && !adShowing() && v.readyState > 0) {
        if (v.currentTime < entry.t - 30) showPrompt(entry);
        return;
      }
    }
  }

  // ---------- когда сохранять ----------

  // Пауза, перемотка, конец — сразу; во время просмотра — раз в 10 секунд.
  for (const type of ['pause', 'seeked', 'ended']) {
    document.addEventListener(
      type,
      (e) => {
        if (e.target instanceof HTMLVideoElement && e.target === W.activeVideoEl()) save(true);
      },
      true
    );
  }
  window.addEventListener('pagehide', () => save(true));
  document.addEventListener('yt-navigate-start', () => save(true)); // уходим на другой ролик — запомнить этот
  document.addEventListener('yt-navigate-finish', () => {
    last = { id: '', t: -1 };
    checkResume();
  });
  const timer = setInterval(() => {
    if (!W.alive()) {
      clearInterval(timer);
      hidePrompt();
      return;
    }
    // Фоновая вкладка тоже может играть (музыка, подкаст) — поэтому без проверки document.hidden.
    if (location.pathname === '/watch') save(false);
  }, 10000);
  YFS.i18n.init({ applyToPage: false }).then(checkResume, () => {});
})();
