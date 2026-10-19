/*
 * 🎧 Аудио-режим на странице ролика youtube.com.
 *
 * Поверх всей страницы — спокойный экран «как у подкаста»: обложка, название, канал,
 * свои кнопки (пауза, ±10 с, скорость, перемотка) и текст видео, который идёт вместе со звуком:
 * текущая строка подсвечена и сама прокручивается, клик по строке — перемотка.
 * Плеер YouTube и рекомендации скрыты, звук играет как обычно. Качество видео на это время
 * снижается до минимального (видео всё равно не видно — меньше трафика и нагрузки).
 *
 * Режим переживает переход на следующий ролик и перезагрузку вкладки (sessionStorage).
 * Клавиши: пробел/K — пауза, ←/J и →/L — 10 секунд, Esc — вернуть видео.
 */
(function () {
  'use strict';
  if (window.top !== window || globalThis.__yfsAudioAlive) return;
  globalThis.__yfsAudioAlive = true;

  const YFS = globalThis.YFS;
  const W = YFS.watch;
  const T = YFS.transcript;
  const tr = (k, p) => YFS.i18n.t(k, p);
  const SESSION_KEY = 'yfs_audio_mode';
  const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];

  let ui = null; // { host, root, els… }
  let videoId = '';
  let segments = [];
  let current = -1;
  let follow = true;
  let userScrollAt = 0;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .screen { position: fixed; inset: 0; z-index: 2250; display: flex; flex-direction: column; align-items: center;
      overflow: hidden; background: #0f0f0f; color: #f1f1f1; font: 15px/1.5 Roboto, Arial, sans-serif; }
    .bg { position: absolute; inset: -40px; background-size: cover; background-position: center; filter: blur(40px) brightness(.35); transform: scale(1.1); }
    .col { position: relative; display: flex; flex-direction: column; width: min(760px, 100%); height: 100%; padding: 20px 16px 0; }
    .top { display: flex; gap: 16px; align-items: center; }
    .cover { flex: 0 0 auto; width: 132px; aspect-ratio: 16 / 9; border-radius: 10px; background: #222 center / cover; box-shadow: 0 6px 24px #000a; }
    .meta { flex: 1; min-width: 0; }
    .title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .channel { margin: 4px 0 0; color: #aaa; font-size: 14px; }
    .exit { flex: 0 0 auto; }
    button { border: 0; font: inherit; cursor: pointer; color: inherit; }
    .pill { height: 36px; padding: 0 14px; border-radius: 18px; background: #ffffff1f; white-space: nowrap; }
    .pill:hover { background: #ffffff33; }
    .controls { display: flex; align-items: center; justify-content: center; gap: 12px; margin: 18px 0 6px; }
    .round { width: 44px; height: 44px; border-radius: 50%; background: #ffffff1a; font-size: 15px; }
    .round:hover { background: #ffffff33; }
    .play { width: 60px; height: 60px; border-radius: 50%; background: #f1f1f1; color: #0f0f0f; font-size: 24px; }
    .speed { min-width: 64px; }
    .seek { display: flex; align-items: center; gap: 10px; font-variant-numeric: tabular-nums; font-size: 13px; color: #ccc; }
    .seek input { flex: 1; accent-color: #ff0033; }
    .bar2 { display: flex; align-items: center; gap: 12px; margin: 10px 0 6px; font-size: 13px; color: #aaa; }
    .bar2 label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .bar2 input { accent-color: #ff0033; }
    .spacer { flex: 1; }
    .text { flex: 1; overflow-y: auto; margin: 0 -16px; padding: 8px 16px 40vh; mask-image: linear-gradient(to bottom, transparent, #000 24px); }
    .line { display: flex; gap: 12px; padding: 6px 8px; border-radius: 8px; color: #9a9a9a; cursor: pointer; transition: color .2s, background .2s; }
    .line:hover { background: #ffffff12; }
    .line .t { flex: 0 0 52px; color: #3ea6ff; font-size: 12px; font-variant-numeric: tabular-nums; padding-top: 3px; }
    .line.past { color: #c8c8c8; }
    .line.now { color: #fff; background: #ffffff1a; font-size: 17px; }
    .note { margin: 16px 0; color: #aaa; text-align: center; }
    .hint { margin: 0; padding: 8px 0 12px; color: #777; font-size: 12px; text-align: center; }
  `;

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k in n) n[k] = v;
      else n.setAttribute(k, v);
    }
    n.append(...kids.filter((k) => k !== null && k !== undefined));
    return n;
  }

  const video = () => W.activeVideoEl();

  // ---------- экран ----------

  function build() {
    const host = document.createElement('div');
    host.id = 'yfs-audio';
    host.dataset.v = W.VERSION;
    const root = host.attachShadow({ mode: 'open' });
    const e = {};
    e.bg = el('div', { className: 'bg' });
    e.cover = el('div', { className: 'cover' });
    e.title = el('h1', { className: 'title' });
    e.channel = el('p', { className: 'channel' });
    e.exit = el('button', { className: 'pill exit', type: 'button' }, tr('audio.exit'));
    e.back = el('button', { className: 'round', type: 'button', title: tr('audio.back10'), 'aria-label': tr('audio.back10') }, '−10');
    e.play = el('button', { className: 'play', type: 'button', 'aria-label': tr('audio.play') }, '▶');
    e.fwd = el('button', { className: 'round', type: 'button', title: tr('audio.fwd10'), 'aria-label': tr('audio.fwd10') }, '+10');
    e.speed = el('button', { className: 'pill speed', type: 'button', title: tr('audio.speed') }, '1×');
    e.cur = el('span', {}, '0:00');
    e.range = el('input', { type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': tr('audio.seek') });
    e.total = el('span', {}, '0:00');
    e.follow = el('input', { type: 'checkbox', checked: true });
    e.text = el('div', { className: 'text', tabIndex: -1 });
    e.screen = el(
      'div',
      { className: 'screen', tabIndex: -1, role: 'dialog', 'aria-label': tr('watch.audio') },
      e.bg,
      el(
        'div',
        { className: 'col' },
        el('div', { className: 'top' }, e.cover, el('div', { className: 'meta' }, e.title, e.channel), e.exit),
        el('div', { className: 'controls' }, e.back, e.play, e.fwd, e.speed),
        el('div', { className: 'seek' }, e.cur, e.range, e.total),
        el('div', { className: 'bar2' }, el('label', {}, e.follow, tr('audio.follow')), el('span', { className: 'spacer' }), el('span', {}, tr('audio.lowData'))),
        e.text,
        el('p', { className: 'hint' }, tr('audio.hint'))
      )
    );
    root.append(el('style', { textContent: CSS }), e.screen);

    e.exit.addEventListener('click', () => toggle(false));
    e.play.addEventListener('click', playPause);
    e.back.addEventListener('click', () => skip(-10));
    e.fwd.addEventListener('click', () => skip(10));
    e.speed.addEventListener('click', nextSpeed);
    e.range.addEventListener('input', () => {
      const v = video();
      if (v && Number.isFinite(v.duration)) e.cur.textContent = T.formatTime((e.range.value / 1000) * v.duration);
    });
    e.range.addEventListener('change', () => {
      const v = video();
      if (v && Number.isFinite(v.duration)) v.currentTime = (e.range.value / 1000) * v.duration;
    });
    e.follow.addEventListener('change', () => {
      follow = e.follow.checked;
      if (follow) scrollToCurrent(true);
    });
    // Пользователь сам листает текст — на несколько секунд не тянем прокрутку к текущей строке.
    for (const t of ['wheel', 'touchmove']) e.text.addEventListener(t, () => (userScrollAt = Date.now()), { passive: true });
    e.text.addEventListener('click', (ev) => {
      const line = ev.target.closest('.line');
      if (!line) return;
      const v = video();
      if (v) {
        v.currentTime = Number(line.dataset.start) || 0;
        v.play().catch(() => {});
        userScrollAt = 0;
      }
    });
    // Клавиши — наши, а не YouTube (иначе пробел сработал бы дважды).
    e.screen.addEventListener('keydown', onKey);
    for (const t of ['keyup', 'keypress']) e.screen.addEventListener(t, (ev) => ev.stopPropagation());
    ui = { host, root, e };
    return ui;
  }

  function onKey(ev) {
    ev.stopPropagation();
    const k = ev.key;
    if (ev.target && ev.target.tagName === 'INPUT' && ev.target.type === 'range' && (k === 'ArrowLeft' || k === 'ArrowRight')) return;
    if (k === ' ' || k === 'k' || k === 'K') playPause();
    else if (k === 'ArrowLeft' || k === 'j' || k === 'J') skip(-10);
    else if (k === 'ArrowRight' || k === 'l' || k === 'L') skip(10);
    else if (k === 'Escape') toggle(false);
    else return;
    ev.preventDefault();
  }

  function playPause() {
    const v = video();
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  function skip(sec) {
    const v = video();
    if (v) v.currentTime = Math.max(0, Math.min((v.duration || Infinity) - 0.5, v.currentTime + sec));
  }

  function nextSpeed() {
    const v = video();
    if (!v) return;
    const i = SPEEDS.indexOf(v.playbackRate);
    v.playbackRate = SPEEDS[(i + 1) % SPEEDS.length];
  }

  // ---------- синхронизация с плеером ----------

  function updateControls() {
    const v = video();
    if (!ui || !v) return;
    const e = ui.e;
    e.play.textContent = v.paused ? '▶' : '❚❚';
    e.play.setAttribute('aria-label', tr(v.paused ? 'audio.play' : 'audio.pause'));
    e.speed.textContent = `${v.playbackRate}×`;
    const d = v.duration;
    if (Number.isFinite(d) && d > 0) {
      e.total.textContent = T.formatTime(d);
      if (ui.root.activeElement !== e.range) {
        e.range.value = String(Math.round((v.currentTime / d) * 1000));
        e.cur.textContent = T.formatTime(v.currentTime);
      }
    }
    highlight(v.currentTime);
  }

  /** Номер строки текста для момента t (двоичный поиск по началам строк). */
  function indexAt(t) {
    let lo = 0;
    let hi = segments.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].start <= t + 0.15) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  function highlight(t) {
    if (!ui || !segments.length) return;
    const i = indexAt(t);
    if (i === current) return;
    const lines = ui.e.text.children;
    const from = Math.max(0, Math.min(i, current));
    const to = Math.max(i, current);
    // Перекрашиваем только изменившийся участок — строк бывает несколько тысяч.
    for (let k = from; k <= to && k < lines.length; k++) {
      lines[k].classList.toggle('now', k === i);
      lines[k].classList.toggle('past', k < i);
    }
    if (current > i) for (let k = Math.max(0, i + 1); k <= current && k < lines.length; k++) lines[k].classList.remove('past');
    current = i;
    scrollToCurrent(false);
  }

  function scrollToCurrent(force) {
    if (!ui || current < 0 || (!force && (!follow || Date.now() - userScrollAt < 4000))) return;
    const line = ui.e.text.children[current];
    if (!line) return;
    const box = ui.e.text;
    // Текущая строка — на трети высоты списка (видно и прошлое, и то, что дальше).
    const target = box.scrollTop + (line.getBoundingClientRect().top - box.getBoundingClientRect().top) - box.clientHeight * 0.3;
    box.scrollTo({ top: Math.max(0, target), behavior: force ? 'auto' : 'smooth' });
  }

  function onMedia(ev) {
    if (!ui || !(ev.target instanceof HTMLVideoElement) || ev.target !== video()) return;
    updateControls();
  }

  // ---------- текст видео ----------

  async function loadText(id) {
    segments = [];
    current = -1;
    const box = ui.e.text;
    box.replaceChildren(el('p', { className: 'note' }, tr('text.loading')));
    try {
      const r = await YFS.fetchTranscript(id);
      if (!ui || videoId !== id) return;
      segments = (r.segments || []).slice().sort((a, b) => a.start - b.start);
      const frag = document.createDocumentFragment();
      for (const s of segments) frag.append(el('div', { className: 'line', dataset: undefined }, el('span', { className: 't' }, T.formatTime(s.start)), el('span', {}, s.text)));
      [...frag.children].forEach((n, i) => (n.dataset.start = String(segments[i].start)));
      box.replaceChildren(frag);
      if (!ui.e.channel.textContent && r.channel) ui.e.channel.textContent = r.channel;
      updateControls();
      scrollToCurrent(true);
    } catch (err) {
      if (!ui || videoId !== id) return;
      box.replaceChildren(el('p', { className: 'note' }, tr(err.message === 'no-transcript' ? 'text.none' : 'text.failed')));
    }
  }

  function showVideo() {
    const v = W.currentVideo();
    if (!ui || !v) return;
    const e = ui.e;
    const thumb = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
    e.cover.style.backgroundImage = `url("${thumb}")`;
    e.bg.style.backgroundImage = `url("${thumb}")`;
    e.title.textContent = v.title || '';
    e.channel.textContent = v.channel || '';
    if (v.id !== videoId) {
      videoId = v.id;
      loadText(v.id);
    }
    updateControls();
  }

  // ---------- вкл/выкл ----------

  function isOn() {
    return !!(ui && ui.host.isConnected);
  }

  function remember(on) {
    try {
      if (on) sessionStorage.setItem(SESSION_KEY, '1');
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* без запоминания */
    }
  }

  function toggle(force) {
    const on = typeof force === 'boolean' ? force : !isOn();
    if (on === isOn()) return on;
    if (on && (!W.currentVideo() || location.pathname !== '/watch')) return false;
    remember(on);
    if (on) {
      W.closePanel();
      if (!ui) build();
      (document.body || document.documentElement).append(ui.host);
      document.documentElement.style.setProperty('overflow', 'hidden', 'important'); // страница под экраном не листается
      showVideo();
      ui.e.screen.focus();
      setTimeout(() => scrollToCurrent(true), 30); // после повторного открытия список снова на текущей строке
      if (YFS.askPage) YFS.askPage('quality', 'low', 3000);
    } else {
      ui.host.remove();
      document.documentElement.style.removeProperty('overflow');
      if (YFS.askPage) YFS.askPage('quality', 'normal', 3000);
    }
    return on;
  }

  for (const type of ['play', 'pause', 'timeupdate', 'durationchange', 'ratechange', 'seeked', 'loadedmetadata']) document.addEventListener(type, onMedia, true);

  // Следующий ролик (автовоспроизведение, плейлист) — экран остаётся, содержимое обновляется.
  document.addEventListener('yt-navigate-finish', () => {
    if (!isOn()) return;
    if (location.pathname !== '/watch') return toggle(false);
    setTimeout(() => {
      showVideo();
      if (YFS.askPage) YFS.askPage('quality', 'low', 3000);
    }, 300);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || sender.id !== chrome.runtime.id || msg.type !== 'yfs:audio-toggle') return;
    YFS.i18n.init({ applyToPage: false }).then(() => sendResponse({ ok: true, on: toggle() }), () => sendResponse({ ok: false }));
    return true;
  });

  const timer = setInterval(() => {
    if (W.alive()) return;
    clearInterval(timer);
    if (ui) ui.host.remove();
    document.documentElement.style.removeProperty('overflow');
  }, 3000);

  YFS.audioMode = { toggle: (f) => toggle(f), get on() { return isOn(); } };

  // После перезагрузки вкладки в аудио-режиме — вернуться в него.
  let wanted = false;
  try {
    wanted = sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    wanted = false;
  }
  if (wanted) {
    YFS.i18n.init({ applyToPage: false }).then(() => {
      const tryOn = (n) => (W.currentVideo() && location.pathname === '/watch' ? toggle(true) : n > 0 && setTimeout(() => tryOn(n - 1), 500));
      tryOn(10);
    });
  }
})();
