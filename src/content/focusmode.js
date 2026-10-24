/*
 * ⚡ СДВГ-режим на странице ролика youtube.com.
 *
 * Gemini по тексту видео с тайм-кодами делит ролик на части и для каждой решает:
 *   ▶ смотреть как есть · ⏩ ускорить (1.5–2×) · ⏭ пропустить.
 * Дальше режим сам ведёт просмотр: скучное ускоряет, «воду» пропускает и коротко пишет поверх видео,
 * что там было («⏭ Вступление: автор здоровается и рассказывает про спонсора» — с кнопкой «↩ Вернуть»).
 * Под плеером — цветная полоса плана (зелёный, жёлтый, серый), в панели — список частей:
 * клик — перемотка, клик по значку — поменять решение для этой части.
 *
 * Стиль: мягко / норм / жёстко. План кэшируется (yfs_focus_cache), настройки — yfs_focus.
 */
(function () {
  'use strict';
  if (window.top !== window || globalThis.__yfsFocusAlive) return;
  globalThis.__yfsFocusAlive = true;

  const YFS = globalThis.YFS;
  const W = YFS.watch;
  const AI = YFS.ai;
  const T = YFS.transcript;
  const tr = (k, p) => YFS.i18n.t(k, p);
  const PREFS_KEY = 'yfs_focus';
  const CACHE_KEY = 'yfs_focus_cache';
  const CACHE_MAX = 100;
  const STYLES = ['ads', 'gentle', 'normal', 'hard', 'highlights'];
  const KINDS = ['auto', 'gaming', 'lecture', 'podcast', 'review', 'news', 'vlog', 'stream'];
  const KIND_ICON = { gaming: '🎮', lecture: '🎓', podcast: '🎙', review: '🔍', news: '📰', vlog: '🎒', stream: '📡', other: '🎬' };
  const M = YFS.music;
  const musicCache = new Map(); // id → трек ли это (для музыки режим не включается)
  let aiModels = []; // модели из настроек AI — для выбора в панели
  const RATES = [1.5, 1.75, 2];
  const ICON = { keep: '▶', fast: '⏩', skip: '⏭' };
  const COLOR = { keep: '#2ba640', fast: '#f2a20c', skip: '#717171' };

  let prefs = { style: 'normal', kind: 'auto', model: '', rate: 1.75, on: true, auto: false, toasts: true, strip: true };
  let state = null; // { id, plan, model, loading, error, progress, startedAt, abort }
  let panel = null; // { host, root, box, toast, strip }
  let panelOpen = false;
  let allowed = new Set(); // части, которые пользователь сам решил смотреть (вернул или перемотал туда)
  let ourRate = 0; // скорость, которую поставили мы (чтобы отличать от ручной)
  let baseRate = 1;
  let selfSeek = false;
  let lastSeg = null;
  let toastTimer = 0;
  let moreOpen = false;

  const video = () => W.activeVideoEl();
  const adShowing = () => {
    const p = document.getElementById('movie_player');
    return !!(p && p.classList.contains('ad-showing'));
  };

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k in n) n[k] = v;
      else n.setAttribute(k, v);
    }
    n.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
    return n;
  }

  // ---------- настройки и кэш ----------

  async function loadPrefs() {
    // auto — сам составлять план при открытии ролика (запрос к Gemini, по умолчанию выключено);
    // toasts — подсказка поверх видео о пропущенном; strip — цветная полоса плана под плеером.
    prefs = normalizePrefs(await W.store.get(PREFS_KEY, {}));
    const ai = (await W.store.get('yfs_ai', {})) || {};
    aiModels = AI.rankModels(ai.models || []);
  }

  /** «Профиль» плана для кэша: пресет + тип ролика (у «авто» ключ прежний — старые планы остаются). */
  const prof = (style = prefs.style, kind = prefs.kind) => style + (kind && kind !== 'auto' ? ':' + kind : '');

  /** Трек ли это: для музыки СДВГ-режим не нужен и не включается. */
  async function isMusicVideo(id) {
    if (musicCache.has(id)) return musicCache.get(id);
    const info = (YFS.askPage && (await YFS.askPage('music', id, 3000))) || null;
    if (!info) return false; // плеер ещё не ответил — проверим в следующий раз
    const v = W.currentVideo() || {};
    const music = info.category === 'Music' || (M && M.isMusic({ title: info.title || v.title, channel: info.author || v.channel, durationSec: info.lengthSec, musicVideoType: info.musicVideoType }));
    musicCache.set(id, !!music);
    return !!music;
  }

  function normalizePrefs(p) {
    p = p || {};
    return {
      style: STYLES.includes(p.style) ? p.style : 'normal',
      kind: KINDS.includes(p.kind) ? p.kind : 'auto', // тип ролика: auto — Gemini определяет сам
      model: typeof p.model === 'string' ? p.model : '', // '' — модель из настроек AI
      rate: RATES.includes(p.rate) ? p.rate : 1.75,
      on: p.on !== false,
      auto: p.auto === true,
      toasts: p.toasts !== false,
      strip: p.strip !== false,
    };
  }

  function savePrefs(patch) {
    prefs = { ...prefs, ...patch };
    W.store.set(PREFS_KEY, prefs);
    announce();
  }

  /** Аудио-режим и другие части слушают это событие: план, переключатель или текущая часть изменились. */
  function announce() {
    document.dispatchEvent(new CustomEvent('yfs:focus-change'));
  }

  const inAudio = () => !!(YFS.audioMode && YFS.audioMode.on);

  const cacheKey = (id, style) => `${id}|${YFS.i18n.lang}|${style}`;

  async function cached(id, style) {
    const c = (await W.store.get(CACHE_KEY, {})) || {};
    return c[cacheKey(id, style)] || null;
  }

  async function saveCache(id, style, entry) {
    const c = (await W.store.get(CACHE_KEY, {})) || {};
    c[cacheKey(id, style)] = entry;
    const keys = Object.keys(c);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => (c[a].at || 0) - (c[b].at || 0));
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete c[k];
    }
    await W.store.set(CACHE_KEY, c);
  }

  // ---------- план ----------

  async function makePlan(force) {
    const v = W.currentVideo();
    if (!v) return;
    const id = v.id;
    const style = prefs.style;
    const profile = prof();
    if (state && state.abort) state.abort.abort();
    if (await isMusicVideo(id)) {
      state = { id, plan: null, music: true, loading: '', error: null };
      return render();
    }
    state = { id, plan: null, loading: 'plan', error: null, progress: null, startedAt: Date.now(), abort: null };
    allowed = new Set();
    if (!force) {
      const hit = await cached(id, profile);
      if (hit && state.id === id) {
        Object.assign(state, { plan: hit.plan, model: hit.model, loading: '' });
        render();
        return;
      }
    }
    const ai = (await W.store.get('yfs_ai', {})) || {};
    if (!ai.key) {
      Object.assign(state, { loading: '', error: { code: 'ai-no-key' } });
      return render();
    }
    state.abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    state.loading = 'text';
    render();
    let segments = [];
    try {
      segments = (await YFS.fetchTranscript(id)).segments || [];
    } catch {
      segments = []; // без текста Gemini посмотрит сам ролик
    }
    if (!state || state.id !== id) return;
    state.loading = 'plan';
    render();
    const vid = video();
    try {
      const out = await W.ai('yfs:ai-focus', {
        key: ai.key,
        model: prefs.model || ai.model || '',
        models: ai.models || [],
        kind: prefs.kind === 'auto' ? '' : prefs.kind,
        video: { id, title: v.title, channel: v.channel, duration: v.duration },
        segments,
        durationSec: vid && Number.isFinite(vid.duration) ? vid.duration : 0,
        style,
        language: AI.languageName(YFS.i18n.info()),
        signal: state.abort ? state.abort.signal : undefined,
        onProgress: (p) => {
          if (state && state.id === id) {
            state.progress = p;
            render();
          }
        },
      });
      if (!state || state.id !== id) return;
      Object.assign(state, { plan: out.plan, model: out.model, loading: '' });
      await saveCache(id, profile, { plan: out.plan, model: out.model, at: Date.now() });
    } catch (err) {
      if (state && state.id === id) Object.assign(state, { loading: '', error: err.code === 'ai-cancelled' ? null : { code: err.code || 'ai-failed', message: err.message, tried: err.tried || [] } });
    }
    render();
  }

  const segAt = (t) => (state && state.plan ? state.plan.segments.find((s) => t >= s.start && t < s.end) : null);

  // ---------- управление просмотром ----------

  function setRate(v, rate) {
    ourRate = rate;
    v.playbackRate = rate;
  }

  function restoreRate(v) {
    if (ourRate && Math.abs(v.playbackRate - ourRate) < 0.01) v.playbackRate = baseRate;
    ourRate = 0;
  }

  function onTime(ev) {
    const v = ev.target;
    if (!(v instanceof HTMLVideoElement) || v !== video()) return;
    if (!prefs.on || !state || !state.plan || state.id !== W.videoIdFromUrl() || adShowing()) return;
    const seg = segAt(v.currentTime);
    if (seg !== lastSeg) {
      lastSeg = seg;
      renderCurrent();
      announce();
    }
    if (!seg) return;
    if (seg.action === 'skip' && !allowed.has(seg)) {
      selfSeek = true;
      v.currentTime = Math.min(seg.end + 0.05, (v.duration || seg.end + 1) - 0.25);
      showToast(seg, true);
      return;
    }
    if (seg.action === 'fast' && !allowed.has(seg)) {
      if (Math.abs(v.playbackRate - prefs.rate) > 0.01 && !ourRate) {
        baseRate = v.playbackRate;
        setRate(v, prefs.rate);
        showToast(seg, false);
      } else if (ourRate && Math.abs(ourRate - prefs.rate) > 0.01) setRate(v, prefs.rate);
    } else if (ourRate) restoreRate(v);
  }

  function onSeeked(ev) {
    const v = ev.target;
    if (!(v instanceof HTMLVideoElement) || v !== video()) return;
    if (selfSeek) {
      selfSeek = false;
      return;
    }
    // Человек сам перемотал в «пропускаемую» часть — значит, хочет её посмотреть.
    const seg = segAt(v.currentTime);
    if (seg && seg.action !== 'keep') allowed.add(seg);
  }

  function onRate(ev) {
    const v = ev.target;
    if (!(v instanceof HTMLVideoElement) || v !== video()) return;
    if (ourRate && Math.abs(v.playbackRate - ourRate) > 0.01) {
      // Скорость поменяли вручную — запоминаем её как обычную и не спорим до следующей части.
      baseRate = v.playbackRate;
      ourRate = 0;
      const seg = segAt(v.currentTime);
      if (seg) allowed.add(seg);
    } else if (!ourRate) baseRate = v.playbackRate;
  }

  // ---------- подсказка поверх видео и полоса плана ----------

  function playerRect() {
    const p = document.getElementById('movie_player');
    const r = p && p.getBoundingClientRect();
    return r && r.width > 0 ? r : null;
  }

  function showToast(seg, skipped) {
    if (!prefs.toasts) return;
    ensurePanel();
    const t = panel.toast;
    const undo = el('button', { type: 'button', className: 'undo' }, tr('focus.undo'));
    undo.addEventListener('click', () => {
      allowed.add(seg);
      const v = video();
      if (!v) return;
      if (skipped) {
        selfSeek = true;
        v.currentTime = seg.start;
      } else restoreRate(v);
      t.hidden = true;
    });
    const head = skipped ? `${ICON.skip} ${tr('focus.skipped', { time: T.formatTime(seg.end - seg.start) })}` : `${ICON.fast} ${prefs.rate}×`;
    t.replaceChildren(el('b', {}, head), el('span', {}, ` ${seg.title}${seg.summary ? ' — ' + seg.summary : ''}`), undo);
    const r = playerRect();
    if (inAudio()) {
      // В аудио-режиме плеера на экране нет — подсказка по центру сверху, поверх экрана режима.
      t.style.left = '50%';
      t.style.top = '16px';
      t.style.transform = 'translateX(-50%)';
      t.style.maxWidth = 'min(560px, calc(100vw - 32px))';
    } else {
      t.style.transform = '';
      t.style.left = r ? `${Math.round(r.left + 16)}px` : '16px';
      t.style.top = r ? `${Math.round(r.top + 16)}px` : '80px';
      t.style.maxWidth = r ? `${Math.round(Math.min(560, r.width - 32))}px` : '560px';
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), skipped ? 7000 : 4000);
  }

  /** Цветная полоса плана по нижнему краю плеера: где смотреть, где ускорение, где пропуск. */
  function renderStrip() {
    if (!panel) {
      if (!(state && state.plan && prefs.on && prefs.strip)) return;
      ensurePanel();
    }
    const strip = panel.strip;
    const plan = state && state.plan && state.id === W.videoIdFromUrl() ? state.plan : null;
    const r = playerRect();
    const total = plan && plan.segments.length ? plan.segments[plan.segments.length - 1].end : 0;
    if (!plan || !prefs.on || !prefs.strip || !r || !total || document.fullscreenElement || inAudio()) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    strip.style.left = `${Math.round(r.left)}px`;
    strip.style.top = `${Math.round(r.bottom - 3)}px`;
    strip.style.width = `${Math.round(r.width)}px`;
    if (strip.dataset.plan !== state.id + plan.segments.length) {
      strip.dataset.plan = state.id + plan.segments.length;
      strip.replaceChildren(...plan.segments.map((s) => el('i', { style: `flex:${(s.end - s.start).toFixed(2)};background:${COLOR[s.action]}` })));
    }
  }

  // ---------- панель ----------

  const CSS = `
    .wrap { position: fixed; top: 68px; right: 16px; z-index: 2200; width: min(440px, calc(100vw - 32px)); max-height: calc(100vh - 90px);
      display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-elev); color: var(--text);
      box-shadow: 0 8px 32px #0007; font: 14px/1.45 Roboto, Arial, sans-serif; }
    .wrap[hidden] { display: none; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    .head b { flex: 1; font-size: 15px; }
    .body { overflow-y: auto; padding: 10px 14px 14px; }
    .wrap.top { z-index: 2350; }
    .head .state { color: var(--text-2); font-size: 12px; }
    .presets { display: flex; flex-wrap: wrap; gap: 6px; }
    .preset { height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: 15px; background: transparent; color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
    .preset:hover { background: var(--hover); }
    .preset.on { border-color: transparent; background: var(--text); color: var(--bg); font-weight: 500; }
    .pdesc { margin: 6px 2px 10px; color: var(--text-2); font-size: 12px; min-height: 16px; }
    .pickers { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
    .pickers label { display: flex; flex-direction: column; gap: 3px; min-width: 0; color: var(--text-2); font-size: 12px; }
    select { height: 32px; min-width: 0; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elev); color: var(--text); font: inherit; font-size: 13px; }
    select:focus-visible, .preset:focus-visible, .act:focus-visible { outline: 2px solid #3ea6ff; outline-offset: 1px; }
    .kindbadge { display: inline-flex; align-items: center; gap: 6px; height: 24px; margin: 8px 0 0; padding: 0 10px; border-radius: 12px; background: var(--chip); font-size: 12px; font-weight: 500; }
    .card { margin: 10px 0 0; padding: 12px; border-radius: 12px; background: var(--chip); }
    .music { display: flex; gap: 10px; align-items: flex-start; margin: 10px 0 4px; padding: 12px; border-radius: 12px; background: var(--chip); }
    .music .ico { font-size: 22px; line-height: 1; }
    .seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 2px 0 8px; }
    .seg-b { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px;
      background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
    .seg-b:hover { background: var(--hover); }
    .seg-b.on { border-color: var(--text); background: var(--chip); }
    .seg-b b { font-size: 13px; font-weight: 600; }
    .seg-b small { color: var(--text-2); font-size: 11px; line-height: 1.3; }
    .ratebox { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
    .ratebox .lbl { margin: 0; }
    .big { width: 100%; justify-content: center; height: 42px; border-radius: 21px; margin-top: 4px; }
    .more { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px; }
    .more summary { cursor: pointer; color: var(--text-2); font-size: 13px; padding: 4px 0; }
    .opt { display: flex; align-items: center; gap: 12px; padding: 8px 0; cursor: pointer; }
    .opt .tx { flex: 1; min-width: 0; }
    .opt b { display: block; font-weight: 500; font-size: 13px; }
    .opt small { display: block; color: var(--text-2); font-size: 12px; line-height: 1.35; }
    .opt .switch { flex: 0 0 auto; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0; }
    .chip { height: 28px; padding: 0 12px; border: 0; border-radius: 14px; background: var(--chip); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
    .chip:hover { background: var(--chip-hover); }
    .chip.on { background: var(--text); color: var(--bg); }
    .lbl { margin: 8px 0 2px; color: var(--text-2); font-size: 12px; }
    .note { margin: 8px 0; color: var(--text-2); }
    .err { margin: 8px 0; color: var(--danger); }
    .save { margin: 10px 0 6px; font-weight: 500; }
    .bar { display: flex; height: 12px; margin: 6px 0 10px; overflow: hidden; border-radius: 6px; cursor: pointer; }
    .bar i { display: block; height: 100%; min-width: 2px; }
    .bar i + i { border-left: 1px solid var(--bg-elev); }
    .legend { display: flex; gap: 12px; color: var(--text-2); font-size: 12px; }
    .legend span::before { content: ''; display: inline-block; width: 9px; height: 9px; margin-right: 5px; border-radius: 2px; background: var(--c); }
    ol { margin: 8px 0 0; padding: 0; list-style: none; }
    li { display: grid; grid-template-columns: 92px 82px minmax(0, 1fr); gap: 6px; align-items: start; padding: 6px; border-radius: 8px; cursor: pointer; }
    li:hover { background: var(--hover); }
    li.now { background: var(--chip); }
    li.skip .txt { color: var(--text-2); }
    .acts { display: flex; gap: 3px; }
    .act { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%; background: var(--chip); color: var(--text); font-size: 12px; opacity: .5; cursor: pointer; }
    .act:hover { opacity: 1; background: var(--chip-hover); }
    .act.on { opacity: 1; background: var(--c); color: #0b0b0b; box-shadow: 0 0 0 2px var(--bg-elev), 0 0 0 3px var(--c); }
    .tm { color: #3ea6ff; font-size: 12px; font-variant-numeric: tabular-nums; padding-top: 5px; }
    .txt b { display: block; font-weight: 500; }
    .txt span { color: var(--text-2); font-size: 13px; }
    .switch { appearance: none; position: relative; flex: 0 0 auto; width: 34px; height: 20px; margin: 0; border-radius: 10px; background: var(--chip-hover); cursor: pointer; }
    .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
    .switch:checked { background: var(--accent); }
    .switch:checked::after { transform: translateX(14px); }
    .toast { position: fixed; z-index: 2400; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; padding: 10px 12px; border-radius: 10px;
      background: #000c; color: #fff; font: 14px/1.4 Roboto, Arial, sans-serif; box-shadow: 0 4px 18px #0008; backdrop-filter: blur(6px); }
    .toast[hidden], .strip[hidden] { display: none; }
    .undo { margin-left: auto; height: 26px; padding: 0 10px; border: 0; border-radius: 13px; background: #ffffff2e; color: #fff; font: inherit; font-size: 12px; cursor: pointer; }
    .strip { position: fixed; z-index: 2150; display: flex; height: 3px; pointer-events: none; opacity: .9; }
    .strip i { display: block; height: 100%; }
  `;

  function ensurePanel() {
    if (panel && panel.host.isConnected) return panel;
    const host = document.createElement('div');
    host.id = 'yfs-focus';
    host.dataset.v = W.VERSION;
    const root = host.attachShadow({ mode: 'open' });
    const box = el('div', { className: 'wrap', hidden: true, role: 'dialog', 'aria-label': tr('watch.focus') });
    for (const type of ['keydown', 'keyup', 'keypress']) box.addEventListener(type, (e) => e.stopPropagation());
    const toast = el('div', { className: 'toast', hidden: true, role: 'status' });
    const strip = el('div', { className: 'strip', hidden: true });
    root.append(el('style', { textContent: W.BASE_CSS + CSS }), box, toast, strip);
    (document.body || document.documentElement).append(host);
    panel = { host, root, box, toast, strip };
    return panel;
  }

  function chip(label, on, onClick) {
    const b = el('button', { className: 'chip' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(!!on) }, label);
    b.addEventListener('click', onClick);
    return b;
  }

  function seekTo(sec, seg) {
    const v = video();
    if (!v) return;
    if (seg) allowed.add(seg);
    selfSeek = true;
    v.currentTime = sec;
    v.play().catch(() => {});
  }

  function renderCurrent() {
    if (!panel || !panelOpen) return;
    const now = lastSeg && state && state.plan ? state.plan.segments.indexOf(lastSeg) : -1;
    panel.box.querySelectorAll('li').forEach((li, i) => li.classList.toggle('now', i === now));
  }

  /** Переключатель с подписью и пояснением (общий вид для всех настроек панели). */
  function option(label, hint, key, after) {
    const sw = el('input', { type: 'checkbox', className: 'switch', checked: !!prefs[key], 'aria-label': label });
    sw.addEventListener('change', () => {
      savePrefs({ [key]: sw.checked });
      if (after) after(sw.checked);
      render();
    });
    return el('label', { className: 'opt' }, el('span', { className: 'tx' }, el('b', {}, label), el('small', {}, hint)), sw);
  }

  /** Пресеты одной строкой чипов, под ними — что делает выбранный. */
  function presetPicker() {
    const row = el('div', { className: 'presets', role: 'radiogroup', 'aria-label': tr('focus.style') });
    for (const st of STYLES) {
      const b = el('button', { className: 'preset' + (prefs.style === st ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': String(prefs.style === st), title: tr('focus.style.' + st + 'Hint') }, tr('focus.style.' + st));
      b.addEventListener('click', () => selectStyle(st));
      row.append(b);
    }
    return el('div', {}, el('p', { className: 'lbl', style: 'margin-top:2px' }, tr('focus.style')), row, el('p', { className: 'pdesc' }, tr('focus.style.' + prefs.style + 'Hint')));
  }

  /** Тип ролика (игровое, лекция…) и модель Gemini для плана. */
  function pickers() {
    const kind = el('select', { 'aria-label': tr('focus.kind') });
    for (const k of KINDS) kind.append(el('option', { value: k, selected: prefs.kind === k }, (k === 'auto' ? '✨ ' : (KIND_ICON[k] || '') + ' ') + tr('focus.kind.' + k)));
    kind.addEventListener('change', () => selectProfile({ kind: kind.value }));
    const model = el('select', { 'aria-label': tr('focus.modelPick') });
    model.append(el('option', { value: '', selected: !prefs.model }, tr('focus.modelAuto')));
    const ids = new Set();
    for (const m of aiModels) {
      ids.add(m.id);
      model.append(el('option', { value: m.id, selected: prefs.model === m.id }, m.id));
    }
    if (prefs.model && !ids.has(prefs.model)) model.append(el('option', { value: prefs.model, selected: true }, prefs.model));
    model.addEventListener('change', () => (savePrefs({ model: model.value }), render()));
    return el('div', { className: 'pickers' }, el('label', {}, tr('focus.kind'), kind), el('label', {}, tr('focus.modelPick'), model));
  }

  function settingsBlock() {
    const d = el('details', { className: 'more' }, el('summary', {}, tr('focus.more')));
    d.open = !!moreOpen;
    d.addEventListener('toggle', () => (moreOpen = d.open));
    d.append(
      option(tr('focus.optAuto'), tr('focus.optAutoHint'), 'auto', (on) => on && !state && W.currentVideo() && makePlan(false)),
      option(tr('focus.optToasts'), tr('focus.optToastsHint'), 'toasts'),
      option(tr('focus.optStrip'), tr('focus.optStripHint'), 'strip', renderStrip)
    );
    return d;
  }

  function render() {
    renderStrip();
    announce();
    if (!panel || !panelOpen) return;
    const box = panel.box;
    box.hidden = false;
    box.classList.toggle('top', inAudio());
    panel.host.toggleAttribute('dark', document.documentElement.hasAttribute('dark'));
    const sw = el('input', { type: 'checkbox', className: 'switch', checked: prefs.on, 'aria-label': tr('focus.enabled'), title: tr('focus.enabled') });
    sw.addEventListener('change', () => {
      savePrefs({ on: sw.checked });
      if (!sw.checked && video()) restoreRate(video());
      render();
    });
    const close = el('button', { className: 'icon-btn', type: 'button', 'aria-label': tr('common.close') }, '✕');
    close.addEventListener('click', closePanel);
    const body = el('div', { className: 'body' });
    box.replaceChildren(el('div', { className: 'head' }, el('b', {}, tr('watch.focus')), el('span', { className: 'state' }, tr(prefs.on ? 'focus.on' : 'focus.off')), sw, close), body);

    const id = W.videoIdFromUrl();
    const has = state && state.id === id;
    if (has && state.music) {
      // Для музыки режим не включается: пропускать в треке нечего.
      body.append(el('div', { className: 'music' }, el('span', { className: 'ico' }, '🎵'), el('div', {}, el('b', {}, tr('focus.musicTitle')), el('p', { className: 'note', style: 'margin:4px 0 0' }, tr('focus.musicHint')))), settingsBlock());
      return;
    }
    body.append(presetPicker(), pickers(), el('div', { className: 'ratebox' }, el('span', { className: 'lbl' }, tr('focus.rate')), el('div', { className: 'chips' }, ...RATES.map((r) => chip(`${r}×`, prefs.rate === r, () => (savePrefs({ rate: r }), render()))))));
    if (!has || (!state.plan && !state.loading && !state.error)) {
      const go = el('button', { className: 'pill primary big', type: 'button' }, tr('focus.make'));
      go.addEventListener('click', () => makePlan(false));
      body.append(el('p', { className: 'note' }, has ? tr('focus.noPlanForStyle', { style: tr('focus.style.' + prefs.style) }) : tr('focus.intro')), go, settingsBlock());
      return;
    }
    if (state.loading) {
      const p = state.progress;
      const cancel = el('button', { className: 'pill', type: 'button' }, tr('common.cancel'));
      cancel.addEventListener('click', () => state.abort && state.abort.abort());
      body.append(
        el('p', { className: 'note' }, tr(state.loading === 'text' ? 'ai.stageText' : 'focus.stagePlan')),
        p && p.model ? el('p', { className: 'note' }, p.tried && p.tried.length ? tr('ai.switched', { from: p.tried.map((t) => t.model).join(', '), to: p.model }) : p.model) : null,
        cancel,
        settingsBlock()
      );
      return;
    }
    if (state.error) {
      const code = state.error.code;
      body.append(el('p', { className: 'err' }, code === 'ai-no-key' ? tr('focus.needKey') : tr({ 'ai-quota': 'ai.err.quota', 'ai-key-invalid': 'ai.err.keyInvalid', 'ai-server': 'ai.err.server' }[code] || 'ai.err.failed', { message: state.error.message || '' })));
      const again = el('button', { className: 'pill', type: 'button' }, code === 'ai-no-key' ? tr('focus.openSettings') : tr('text.retry'));
      again.addEventListener('click', () => (code === 'ai-no-key' ? W.openSettings('ai') : makePlan(true)));
      body.append(again, settingsBlock());
      return;
    }
    const plan = state.plan;
    if (!plan || !plan.segments.length) {
      body.append(el('p', { className: 'note' }, tr('focus.empty')), settingsBlock());
      return;
    }
    const s = AI.focusSavings(plan, prefs.rate);
    const pct = s.total ? Math.round((s.saved / s.total) * 100) : 0;
    const bar = el('div', { className: 'bar', title: tr('focus.barHint') }, ...plan.segments.map((x) => el('i', { style: `flex:${(x.end - x.start).toFixed(2)};background:${COLOR[x.action]}`, title: `${T.formatTime(x.start)} ${x.title}` })));
    bar.addEventListener('click', (e) => {
      const r = bar.getBoundingClientRect();
      seekTo(((e.clientX - r.left) / r.width) * s.total);
    });
    const again = el('button', { className: 'pill', type: 'button' }, tr('ai.again'));
    again.addEventListener('click', () => makePlan(true));
    body.append(
      plan.kind ? el('span', { className: 'kindbadge', title: tr('focus.kind') }, KIND_ICON[plan.kind] || KIND_ICON.other, tr('focus.kind.' + (plan.kind || 'other'))) : null,
      plan.overview ? el('p', { className: 'note' }, plan.overview) : null,
      el('p', { className: 'save' }, tr('focus.saves', { watch: T.formatTime(s.watch), total: T.formatTime(s.total), pct })),
      bar,
      el(
        'div',
        { className: 'legend' },
        el('span', { style: `--c:${COLOR.keep}` }, tr('focus.keep')),
        el('span', { style: `--c:${COLOR.fast}` }, tr('focus.fast')),
        el('span', { style: `--c:${COLOR.skip}` }, tr('focus.skip'))
      )
    );
    const ol = el('ol');
    for (const seg of plan.segments) {
      // Три значка сразу: смотреть / ускорить / пропустить — текущий выбран, остальные видны и подписаны.
      const act = el('span', { className: 'acts', role: 'radiogroup', 'aria-label': tr('focus.changeAction') });
      for (const a of ['keep', 'fast', 'skip']) {
        const b = el('button', { className: 'act' + (a === seg.action ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': String(a === seg.action), title: tr('focus.' + a) }, ICON[a]);
        b.style.setProperty('--c', COLOR[a]);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          setAction(plan.segments.indexOf(seg), a);
        });
        act.append(b);
      }
      const li = el(
        'li',
        { className: seg.action },
        act,
        el('span', { className: 'tm' }, `${T.formatTime(seg.start)}–${T.formatTime(seg.end)}`),
        el('span', { className: 'txt' }, el('b', {}, seg.title), seg.summary ? el('span', {}, seg.summary) : null)
      );
      li.addEventListener('click', () => seekTo(seg.start, seg));
      ol.append(li);
    }
    body.append(ol, el('p', { className: 'note' }, tr('focus.model', { model: state.model || '' })), again, settingsBlock());
    renderCurrent();
  }

  /** Решение для части плана выбрано вручную (значки ▶ ⏩ ⏭): сохраняем в кэш и применяем сразу. */
  function setAction(i, action) {
    const plan = state && state.plan;
    if (!plan || !plan.segments[i] || !['keep', 'fast', 'skip'].includes(action)) return;
    const seg = plan.segments[i];
    seg.action = action;
    allowed.delete(seg);
    if (video() && action === 'keep') restoreRate(video());
    saveCache(state.id, prof(), { plan, model: state.model, at: Date.now() });
    render();
  }

  /** Строгость сменили: готовый план для неё показываем сразу, а новый запрос к Gemini — только по кнопке. */
  async function selectStyle(style) {
    return selectProfile({ style });
  }

  async function selectProfile(patch) {
    if (Object.entries(patch).every(([k, v]) => prefs[k] === v)) return;
    savePrefs(patch);
    const id = W.videoIdFromUrl();
    if (state && state.abort && state.loading) state.abort.abort();
    if (state && state.music) return render();
    const hit = id && (await cached(id, prof()));
    state = id ? { id, plan: hit ? hit.plan : null, model: hit ? hit.model : '', loading: '', error: null } : null;
    allowed = new Set();
    lastSeg = null;
    render();
    announce();
  }

  function togglePanel() {
    if (panelOpen) return closePanel();
    if (!W.currentVideo()) return;
    if (YFS.textPanel && YFS.textPanel.isOpen) YFS.textPanel.hide(); // панели справа не накладываются
    ensurePanel();
    panelOpen = true;
    if (!state || state.id !== W.videoIdFromUrl()) {
      // Готовый план из кэша показываем сразу, новый — только по кнопке (это запрос к Gemini).
      const id = W.videoIdFromUrl();
      Promise.all([cached(id, prof()), isMusicVideo(id)]).then(([hit, music]) => {
        if (music) state = { id, plan: null, music: true, loading: '', error: null };
        else if (hit && W.currentVideo()) {
          state = { id, plan: hit.plan, model: hit.model, loading: '', error: null };
          allowed = new Set();
        }
        render();
      });
    }
    render();
  }

  function closePanel() {
    panelOpen = false;
    if (panel) panel.box.hidden = true;
  }

  // ---------- события ----------

  document.addEventListener('timeupdate', onTime, true);
  document.addEventListener('seeked', onSeeked, true);
  document.addEventListener('ratechange', onRate, true);
  document.addEventListener('yt-navigate-finish', async () => {
    lastSeg = null;
    ourRate = 0;
    const id = W.videoIdFromUrl();
    if (!id) {
      closePanel();
      if (panel) panel.strip.hidden = true;
      return;
    }
    // Новый ролик: если для него уже есть план — режим продолжит работать сам.
    const hit = await cached(id, prof());
    state = hit ? { id, plan: hit.plan, model: hit.model, loading: '', error: null } : null;
    allowed = new Set();
    render();
    // Трек? Тогда режим не нужен: ни автоплана, ни плана из кэша.
    setTimeout(async () => {
      if (W.videoIdFromUrl() !== id) return;
      if (await isMusicVideo(id)) {
        state = { id, plan: null, music: true, loading: '', error: null };
        render();
      } else if (!hit) autoPlan();
    }, 1200); // название и длительность ролика появляются не сразу // название и длительность ролика появляются не сразу
  });

  /** «Составлять план сам» (настройка): для нового ролика без плана — один запрос к Gemini. */
  async function autoPlan() {
    if (!prefs.auto || !prefs.on || location.pathname !== '/watch') return;
    const id = W.videoIdFromUrl();
    if (!id || (state && state.id === id && (state.plan || state.loading || state.error || state.music))) return;
    if (await isMusicVideo(id)) return;
    const v = video();
    if (v && Number.isFinite(v.duration) && v.duration < 120) return; // у короткого ролика пропускать нечего
    const ai = (await W.store.get('yfs_ai', {})) || {};
    if (ai.key && W.currentVideo()) makePlan(false);
  }

  // Настройки, изменённые на странице настроек расширения, действуют сразу.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[PREFS_KEY]) return;
      const next = normalizePrefs(changes[PREFS_KEY].newValue);
      if (JSON.stringify(next) === JSON.stringify(prefs)) return;
      const styleChanged = prof(next.style, next.kind) !== prof();
      prefs = next;
      if (styleChanged) {
        const id = W.videoIdFromUrl();
        cached(id, prof()).then((hit) => {
          state = id ? { id, plan: hit ? hit.plan : null, model: hit ? hit.model : '', loading: '', error: null } : null;
          render();
        });
      } else render();
    });
  } catch {
    /* расширение перезагрузили */
  }
  window.addEventListener('resize', renderStrip);
  const stopLoop = YFS.loop.every(1000, () => {
    if (!W.alive()) {
      stopLoop();
      if (panel) panel.host.remove();
      return;
    }
    renderStrip(); // плеер меняет размер (театр, мини-плеер) — полоса едет следом
  });

  document.addEventListener('yfs:lang-change', () => {
    if (!panel) return;
    panel.host.remove();
    panel = null;
    if (panelOpen) ensurePanel();
    render();
  });

  YFS.focusMode = {
    togglePanel,
    closePanel,
    makePlan,
    get state() {
      return state;
    },
    /** План для ролика на странице (или null) — его рисует аудио-режим на своей шкале. */
    get plan() {
      return state && state.plan && state.id === W.videoIdFromUrl() ? state.plan : null;
    },
    get loading() {
      return !!(state && state.loading && state.id === W.videoIdFromUrl());
    },
    get enabled() {
      return prefs.on;
    },
    setAction,
    get isMusic() {
      return !!(state && state.music && state.id === W.videoIdFromUrl());
    },
    setEnabled(on) {
      savePrefs({ on: !!on });
      if (!on && video()) restoreRate(video());
      render();
    },
    get current() {
      return lastSeg;
    },
    get prefs() {
      return { ...prefs };
    },
  };
  YFS.i18n
    .init({ applyToPage: false })
    .then(loadPrefs)
    .then(async () => {
      const id = W.videoIdFromUrl();
      const hit = id && (await cached(id, prof()));
      if (hit) state = { id, plan: hit.plan, model: hit.model, loading: '', error: null };
      renderStrip();
    })
    .catch(() => {});
})();
