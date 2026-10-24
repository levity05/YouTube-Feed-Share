/*
 * 🎵 Своя очередь для «Слушать подряд».
 *
 * Плейлист YouTube через watch_videos принимает не больше 50 роликов, а очередь расширения — до 500.
 * Она хранится в chrome.storage.local (yfs_queue), переживает переходы между роликами и перезагрузку страницы:
 * когда трек заканчивается, расширение открывает следующий. Кнопки «предыдущий / следующий» аудио-режима
 * и список очереди работают от неё же. Порядок можно перемешать случайно или «умно» — Gemini выстраивает
 * треки так, чтобы звучали по-разному и один исполнитель не шёл подряд.
 *
 * Очередь выключается сама, когда человек открывает ролик, которого в ней нет.
 */
(function () {
  'use strict';
  if (window.top !== window || globalThis.__yfsQueueAlive) return;
  globalThis.__yfsQueueAlive = true;

  const YFS = globalThis.YFS;
  const W = YFS.watch;
  const R = YFS.feedrules;
  const KEY = 'yfs_queue';
  const MAX = 500;
  const ID_RE = /^[A-Za-z0-9_-]{11}$/;

  let q = null; // { ids, meta: {id: {title, channel}}, pos, at }
  let loaded = false;

  const announce = () => document.dispatchEvent(new CustomEvent('yfs:queue-change'));

  async function load() {
    q = (await W.store.get(KEY, null)) || null;
    if (q && !Array.isArray(q.ids)) q = null;
    loaded = true;
    sync();
    announce();
  }

  const save = () => W.store.set(KEY, q);

  function sync() {
    if (!q) return;
    const id = W.videoIdFromUrl();
    if (!id) return;
    const i = q.ids.indexOf(id);
    if (i >= 0) {
      if (q.pos !== i) {
        q.pos = i;
        save();
      }
    } else if (Date.now() - (q.at || 0) > 8000) stop(); // ушли на ролик не из очереди — очередь больше не нужна
  }

  function clean(ids, meta) {
    const list = [...new Set((ids || []).filter((id) => ID_RE.test(id)))].slice(0, MAX);
    const m = {};
    for (const id of list) if (meta && meta[id]) m[id] = { title: String(meta[id].title || '').slice(0, 140), channel: String(meta[id].channel || '').slice(0, 60) };
    return { list, m };
  }

  /** Новая очередь: сохраняем и открываем первый трек (аудио-режим включится сам, если opts.audio). */
  async function start(ids, meta, opts = {}) {
    const { list, m } = clean(ids, meta);
    if (list.length < 1) return false;
    q = { ids: list, meta: m, pos: 0, at: Date.now() };
    await save();
    if (opts.audio !== false) {
      try {
        sessionStorage.setItem('yfs_audio_mode', '1');
      } catch {
        /* без аудио-режима */
      }
    }
    announce();
    location.assign(`/watch?v=${list[0]}`);
    return true;
  }

  async function go(i) {
    if (!q || i < 0 || i >= q.ids.length) return false;
    q.pos = i;
    q.at = Date.now();
    await save();
    announce();
    const id = q.ids[i];
    if (id !== W.videoIdFromUrl()) await openVideo(id);
    return true;
  }

  /**
   * Открыть ролик без перезагрузки страницы (хук в MAIN-мире шлёт YouTube событие перехода) —
   * иначе экран аудио-режима мигал бы на каждом треке. Не сработало за 2,5 с — обычный переход.
   */
  async function openVideo(id) {
    const ok = YFS.askPage ? await YFS.askPage('goto', id, 1500).catch(() => false) : false;
    if (ok === true || ok === 'true') {
      for (let t = 0; t < 25; t++) {
        await new Promise((r) => setTimeout(r, 100));
        if (W.videoIdFromUrl() === id) return;
      }
    }
    location.assign(`/watch?v=${id}`);
  }

  const next = () => (q && q.pos + 1 < q.ids.length ? go(q.pos + 1) : Promise.resolve(false));
  const prev = () => (q && q.pos > 0 ? go(q.pos - 1) : Promise.resolve(false));

  function stop() {
    if (!q) return;
    q = null;
    W.store.set(KEY, null);
    announce();
  }

  const items = () => (q ? q.ids.map((id) => ({ id, title: (q.meta[id] && q.meta[id].title) || '', channel: (q.meta[id] && q.meta[id].channel) || '' })) : []);

  /**
   * Порядок треков: random — случайный, ai — выстраивает Gemini (до 200 треков за запрос, остальные — в конце вперемешку).
   * Бросает ошибку с кодом ai-no-key / ai-*, если ИИ недоступен — вызывающий решает, что показать.
   */
  async function arrange(ids, meta, mode, opts = {}) {
    if (mode === 'random') return R.shuffled(ids);
    if (mode !== 'ai') return ids.slice();
    const ai = (await W.store.get('yfs_ai', {})) || {};
    if (!ai.key) throw Object.assign(new Error('no key'), { code: 'ai-no-key' });
    const head = R.shuffled(ids).slice(0, 200); // какие 200 попадут к ИИ — случайно, чтобы «хвост» не терялся всегда одним и тем же
    const tail = ids.filter((id) => !head.includes(id));
    const out = await W.ai('yfs:ai-order', {
      key: ai.key,
      model: ai.model || '',
      models: ai.models || [],
      tracks: head.map((id) => ({ id, title: (meta[id] && meta[id].title) || '', channel: (meta[id] && meta[id].channel) || '' })),
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    return [...out.ids, ...R.shuffled(tail)];
  }

  /** Перемешать то, что ещё не играло (текущий трек остаётся на месте). */
  async function reorderRest(mode, opts) {
    if (!q) return false;
    const head = q.ids.slice(0, q.pos + 1);
    const rest = await arrange(q.ids.slice(q.pos + 1), q.meta, mode, opts);
    q.ids = [...head, ...rest];
    await save();
    announce();
    return true;
  }

  // За полсекунды до конца — сразу следующий трек: так автовоспроизведение YouTube не успевает
  // открыть свой ролик (два перехода подряд и давали мигание и «чужой» трек).
  let leaving = '';
  document.addEventListener(
    'timeupdate',
    (ev) => {
      const v = ev.target;
      if (!q || !(v instanceof HTMLVideoElement) || v.paused || !Number.isFinite(v.duration) || v.duration < 5) return;
      const id = W.videoIdFromUrl();
      if (q.ids[q.pos] !== id || leaving === id || v.duration - v.currentTime > 0.6) return;
      const player = document.getElementById('movie_player');
      if (player && player.classList.contains('ad-showing')) return;
      leaving = id;
      if (q.pos + 1 < q.ids.length) next();
    },
    true
  );

  // Трек закончился — следующий из очереди. Рекламу (тот же <video>) пропускаем.
  document.addEventListener(
    'ended',
    (ev) => {
      const v = ev.target;
      if (!q || !(v instanceof HTMLVideoElement)) return;
      const player = document.getElementById('movie_player');
      if (player && player.classList.contains('ad-showing')) return;
      if (Number.isFinite(v.duration) && v.currentTime < v.duration - 2) return;
      if (q.ids[q.pos] !== W.videoIdFromUrl() || leaving === W.videoIdFromUrl()) return;
      if (q.pos + 1 < q.ids.length) next();
      else stop();
    },
    true
  );
  document.addEventListener('yt-navigate-finish', () => setTimeout(sync, 400));

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      const v = changes[KEY].newValue || null;
      if (JSON.stringify(v) === JSON.stringify(q)) return;
      q = v && Array.isArray(v.ids) ? v : null;
      announce();
    });
  } catch {
    /* расширение перезагрузили */
  }

  YFS.queue = {
    start,
    go,
    next,
    prev,
    stop,
    arrange,
    reorderRest,
    get ready() {
      return loaded;
    },
    get active() {
      return !!q && q.ids.length > 0;
    },
    get pos() {
      return q ? q.pos : -1;
    },
    get length() {
      return q ? q.ids.length : 0;
    },
    get items() {
      return items();
    },
  };

  load().catch(() => {});
})();
