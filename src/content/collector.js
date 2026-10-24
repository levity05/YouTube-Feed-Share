/*
 * Изолированный content script: копит ролики из перехваченных ответов
 * и по команде фонового скрипта собирает ленты с текущей страницы:
 *   главная            → home
 *   «Посмотреть позже» → watch-later
 *   история            → history (с днём просмотра)
 *   окно Shorts        → shorts (сборщик сам листает ролики без звука)
 * И PRO-функция: автолистание Shorts, когда ролик доиграл.
 *
 * Принцип ID-first: главное — найти videoId. Основной парсер знает форматы
 * YouTube; если он вдруг нашёл подозрительно мало, подключаются общий поиск
 * по JSON и ссылки из DOM — тогда часть роликов сохраняется только по ID,
 * а метаданные восстановит просмотрщик.
 */
(function () {
  'use strict';
  // После перезагрузки расширения старый экземпляр «осиротевает» — тогда ставимся заново.
  if (globalThis.__yfsCollectorAlive && globalThis.__yfsCollectorAlive()) return;
  globalThis.__yfsCollectorAlive = () => {
    try {
      return !!chrome.runtime.id;
    } catch {
      return false;
    }
  };

  const P = YFS.parse;
  const tr = (k, p) => YFS.i18n.t(k, p);
  YFS.i18n.init({ applyToPage: false }); // словарь подгрузится в фоне; до тех пор — английский
  const { durationToSeconds } = YFS.feed;

  const MAX_RUN_MS = { home: 120000, 'watch-later': 120000, history: 180000, shorts: 240000 };
  const MAX_IDLE_ROUNDS = 5;
  const CHUNK_WAIT_MS = 2500;
  const MAX_PER_FEED = 1000;
  const MAX_SAMPLE_CHARS = 3 * 1024 * 1024;
  const KIND_BY_BROWSE_ID = { FEwhat_to_watch: 'home', VLWL: 'watch-later', FEhistory: 'history' };
  const PAGE_SCOPES = {
    home: 'ytd-browse[page-subtype="home"]',
    'watch-later': 'ytd-browse[page-subtype="playlist"]',
    history: 'ytd-browse[page-subtype="history"]',
  };

  // Ответы /browse по разделам храним сырыми строками и разбираем только во время сбора:
  // на обычном YouTube расширение почти не тратит CPU. stale — раздел перезагружали, ytInitialData устарел.
  const MAX_TEXTS = 80; // ~10–20 МБ на раздел в худшем случае
  const emptyNet = () => ({ texts: [], parsed: 0, videos: [], generic: [], stale: false });
  const net = { home: emptyNet(), 'watch-later': emptyNet(), history: emptyNet(), shorts: emptyNet() };
  let lastChunkAt = 0;
  let job = null;

  function pageKind(href = location.href) {
    const url = new URL(href, location.origin);
    if (url.pathname === '/') return 'home';
    if (url.pathname === '/playlist' && url.searchParams.get('list') === 'WL') return 'watch-later';
    if (url.pathname === '/feed/history') return 'history';
    if (url.pathname === '/shorts' || url.pathname.startsWith('/shorts/')) return 'shorts';
    return '';
  }

  function pushText(st, text) {
    st.texts.push(text);
    if (st.texts.length > MAX_TEXTS) {
      st.texts.shift();
      st.parsed = Math.max(0, st.parsed - 1);
    }
  }

  /** Разобрать ещё не разобранные ответы раздела (инкрементально) и вернуть его состояние. */
  function parsedNet(kind) {
    const st = net[kind];
    for (; st.parsed < st.texts.length; st.parsed++) {
      let data;
      try {
        data = JSON.parse(st.texts[st.parsed]);
      } catch {
        continue;
      }
      if (kind === 'shorts') {
        st.generic.push(...P.extractGeneric(data).map((v) => ({ ...v, short: true })));
      } else {
        st.videos.push(...P.extractVideos(data));
        st.generic.push(...P.extractGeneric(data));
      }
    }
    return st;
  }

  /** Последние сырые ответы раздела — для образца отладки. */
  function lastRaws(kind, n = 2) {
    return net[kind].texts.slice(-n).map((t) => {
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    });
  }

  document.addEventListener('yfs:chunk', (e) => {
    const detail = String(e.detail || '');
    const nl = detail.indexOf('\n');
    if (nl < 0) return;
    let meta;
    try {
      meta = JSON.parse(detail.slice(0, nl));
    } catch {
      return;
    }
    const text = detail.slice(nl + 1);
    if (meta.reel) {
      pushText(net.shorts, text); // очередь окна Shorts: id в порядке показа
    } else {
      const freshKind = KIND_BY_BROWSE_ID[meta.browseId];
      const kind = freshKind || pageKind();
      if (!freshKind && !(meta.continuation && net[kind])) return;
      // Перезагрузка ленты (новый заход или выбран чип) — начинаем раздел заново. Признак ищем в строке, без разбора.
      if (freshKind || text.includes('RELOAD_CONTINUATION_SLOT_BODY')) net[kind] = { ...emptyNet(), stale: true };
      pushText(net[kind], text);
    }
    lastChunkAt = Date.now();
  });

  // ---------- запросы к hook.js (MAIN world) ----------

  const pending = new Map();
  let seq = 0;

  document.addEventListener('yfs:response', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg.result);
    }
  });

  function askHook(what, kind, timeout = 3000) {
    return new Promise((resolve) => {
      const id = `${++seq}`;
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) resolve(null);
      }, timeout);
      document.dispatchEvent(new CustomEvent('yfs:request', { detail: JSON.stringify({ id, what, kind }) }));
    });
  }

  // ---------- вспомогательное ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForChunk(since, timeout) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (lastChunkAt > since) return true;
      await sleep(150);
    }
    return false;
  }

  /** Фильтры не отбрасывают ролик из-за отсутствующих метаданных: нет длительности — фильтр длины его пропускает. */
  function makeFilter(f, { watched = true, live = true, duration = true, shorts = true } = {}) {
    const stopWords = String(f.stopWords || '')
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    const min = Math.max(0, Number(f.minMinutes) || 0) * 60;
    const max = Math.max(0, Number(f.maxMinutes) || 0) * 60;
    return (v) => {
      if (shorts && f.excludeShorts && v.short) return false;
      if (watched && f.excludeWatched && v.watched > 0) return false;
      if (live && f.excludeLive && (v.live || v.upcoming)) return false;
      if (duration) {
        const sec = durationToSeconds(v.duration);
        if (sec !== null && ((min && sec < min) || (max && sec > max))) return false;
      }
      if (stopWords.length) {
        const hay = `${v.title || ''} ${v.channel || ''}`.toLowerCase();
        if (stopWords.some((w) => hay.includes(w))) return false;
      }
      return true;
    };
  }

  /** Подписи секций истории → дата; ролик без подписи относится к дню предыдущего. */
  function resolveDays(list, today) {
    let label = '';
    const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    for (const v of list) {
      label = v.dayLabel || label;
      v.watchedDay = P.parseDayLabel(label, today) || '';
      v.daysAgo = v.watchedDay ? Math.round((todayMs - new Date(v.watchedDay + 'T00:00:00').getTime()) / 86400000) : null;
    }
    return list;
  }

  const HISTORY_MODES = {
    last50: { count: 50 },
    last100: { count: 100 },
    last200: { count: 200 },
    today: { days: 0 },
    week: { days: 6 },
  };

  /**
   * Цели сбора для текущей страницы. Каждая цель знает, какие ролики ей подходят,
   * сколько нужно и когда она выполнена.
   */
  function makeGoals(page, want, filters) {
    const goals = [];
    if (page === 'home') {
      if (want.home > 0) goals.push({ type: 'home', target: want.home, pick: (all) => all.filter(makeFilter(filters)) });
    } else if (page === 'watch-later' && want['watch-later'] > 0) {
      goals.push({ type: 'watch-later', target: want['watch-later'], pick: (all) => all.filter(makeFilter(filters)) });
    } else if (page === 'shorts' && want.shorts > 0) {
      const ok = makeFilter(filters, { watched: false, live: false, duration: false, shorts: false });
      goals.push({ type: 'shorts', target: want.shorts, pick: (all) => all.filter((v) => ok({ ...v, short: true })) });
    } else if (page === 'history' && HISTORY_MODES[want.history]) {
      const mode = HISTORY_MODES[want.history];
      const passes = makeFilter(filters, { watched: false, live: false, duration: false, shorts: false });
      // Shorts в историю попадают, только если пользователь явно их включил.
      const ok = (v) => passes(v) && (want.historyShorts || !v.short);
      goals.push({
        type: 'history',
        target: mode.count || MAX_PER_FEED,
        days: mode.days,
        pick: (all) => {
          const list = resolveDays(all, new Date()).filter(ok);
          return mode.days === undefined ? list : list.filter((v) => v.daysAgo === null || v.daysAgo <= mode.days);
        },
        // Период закончился, когда в истории появился ролик старше окна.
        // Если даты не распознаются (интерфейс не на русском/английском) — останавливаемся на 200.
        periodDone: (all) =>
          mode.days !== undefined &&
          (all.some((v) => v.daysAgo !== null && v.daysAgo > mode.days) ||
            (all.length >= 200 && all.every((v) => v.daysAgo === null))),
      });
    }
    return goals;
  }

  function finalize(type, list, target) {
    return list.slice(0, target).map((v, i) => {
      const out = { ...v, position: i + 1, confidence: P.confidence(v) };
      if (type === 'history') out.progress = v.watched;
      delete out.watched; // прогресс отправителя экспортируем только как часть истории
      delete out.dayLabel;
      delete out.daysAgo;
      return out;
    });
  }

  function scrollDown() {
    const el = document.scrollingElement || document.documentElement;
    if (window.innerHeight + window.scrollY >= el.scrollHeight - 50) window.scrollBy(0, -600);
    window.scrollTo(0, el.scrollHeight);
  }

  function report(data) {
    chrome.runtime.sendMessage({ type: 'yfs:progress', ...data }).catch(() => {
      /* слушателя нет — не страшно */
    });
  }

  /** Всё, что видно сейчас: основной парсер + запасные стратегии с проверкой на поломку. */
  async function snapshotOf(page, initial) {
    const st = parsedNet(page);
    const domJson = await askHook('dom', page);
    const scope = document.querySelector(PAGE_SCOPES[page]);
    const primaryLists = [];
    const genericLists = [];
    if (domJson) {
      primaryLists.push(P.extractVideos(domJson));
      genericLists.push(P.extractGeneric(domJson));
    }
    primaryLists.push(st.stale ? st.videos : initial.videos.concat(st.videos));
    genericLists.push(st.stale ? st.generic : initial.generic.concat(st.generic));
    if (page === 'home' && scope) primaryLists.push(P.scrapeDom(scope));
    // В истории порядок и дни задаёт JSON: DOM-список без заголовков дней ставим последним.
    if (page === 'history') primaryLists.reverse();
    return P.withFallback(primaryLists, genericLists, scope ? P.scrapeLinks(scope) : []);
  }

  // ---------- 🧠 ремонт парсера с помощью ИИ ----------

  const RECIPES_KEY = 'yfs_parser_recipes';

  function loadRecipes() {
    return chrome.storage.local
      .get(RECIPES_KEY)
      .then((d) => P.setLearned(d[RECIPES_KEY] || []))
      .catch(() => 0);
  }
  loadRecipes();
  try {
    chrome.storage.onChanged.addListener((changes, area) => area === 'local' && changes[RECIPES_KEY] && loadRecipes());
  } catch {
    /* расширение перезагрузили */
  }

  /**
   * Основной парсер не узнаёт новые карточки, а общий поиск видит их id → просим у Gemini «рецепт» разбора.
   * Только если пользователь включил это в настройках (yfs_ai.repair) и есть ключ. В модель уходят 2–3 обрезанные
   * карточки (структура и короткие строки), рецепт проверяется здесь же и только тогда сохраняется.
   * Ответ: { status: off | skip | failed | fixed, renderer?, found?, total? }.
   */
  async function tryRepair(page, initialJson) {
    let ai = {};
    try {
      ai = (await chrome.storage.local.get('yfs_ai')).yfs_ai || {};
    } catch {
      return { status: 'off' };
    }
    if (!ai.repair || !ai.key) return { status: 'off' };
    const datas = [initialJson, ...lastRaws(page, 6)].filter(Boolean);
    const primary = new Set(datas.flatMap((d) => P.extractVideos(d)).map((v) => v.id));
    const known = [...new Set(datas.flatMap((d) => P.extractGeneric(d)).map((v) => v.id))];
    const missing = known.filter((id) => !primary.has(id));
    if (missing.length < 3) return { status: 'skip' };
    const cards = P.findCards(datas, missing, 3);
    if (!cards.length) return { status: 'failed', reason: 'no-cards' };
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'yfs:ai-repair',
        reqId: 'repair' + Date.now(),
        args: { key: ai.key, model: ai.model || '', models: ai.models || [], page, ids: cards.map((c) => c.id), cards: cards.map((c) => ({ key: c.key, skeleton: P.skeleton(c.node) })) },
      });
    } catch {
      res = null;
    }
    if (!res || !res.ok) return { status: 'failed', reason: (res && res.code) || 'no-answer' };
    const recipe = res.out.recipe;
    const check = P.validateRecipe(recipe, datas, missing, known);
    if (!check.ok) return { status: 'failed', reason: 'invalid', found: check.found, total: check.total };
    const list = ((await chrome.storage.local.get(RECIPES_KEY))[RECIPES_KEY] || []).filter((r) => r && r.renderer !== recipe.renderer);
    list.push({ ...recipe, page, learnedAt: Date.now(), model: res.out.model, found: check.found });
    await chrome.storage.local.set({ [RECIPES_KEY]: list.slice(-20) });
    P.setLearned(list);
    return { status: 'fixed', renderer: recipe.renderer, found: check.found, total: check.total, model: res.out.model };
  }

  /** Образец ответа YouTube для отладки парсера — только локально, отправить его может лишь сам пользователь. */
  async function saveSample(page, health, initialJson) {
    try {
      const st = net[page];
      let data = JSON.stringify({ initial: st.stale ? null : initialJson, chunks: lastRaws(page, 2) });
      if (data.length > MAX_SAMPLE_CHARS) data = JSON.stringify({ initial: null, chunks: lastRaws(page, 1) });
      if (data.length > MAX_SAMPLE_CHARS) return;
      const sample = { page, savedAt: new Date().toISOString(), health, userAgent: navigator.userAgent, data: JSON.parse(data) };
      const { yfs_samples = [] } = await chrome.storage.local.get('yfs_samples');
      await chrome.storage.local.set({ yfs_samples: [sample, ...yfs_samples].slice(0, 3) });
    } catch {
      /* отладка не должна мешать сбору */
    }
  }

  // ---------- окно Shorts ----------

  const SHORT_ID_RE = /^\/shorts\/([A-Za-z0-9_-]{11})/;

  function currentShortId() {
    const m = location.pathname.match(SHORT_ID_RE);
    return m ? m[1] : '';
  }

  /** Активный ролик в окне Shorts (разметка менялась, поэтому несколько вариантов). */
  function activeReel() {
    return (
      document.querySelector('ytd-reel-video-renderer[is-active]') ||
      Array.from(document.querySelectorAll('ytd-reel-video-renderer, ytd-shorts [id^="reel"]')).find((el) => {
        const r = el.getBoundingClientRect();
        return r.top < innerHeight / 2 && r.bottom > innerHeight / 2;
      }) ||
      document.querySelector('ytd-shorts')
    );
  }

  function activeVideo() {
    const reel = activeReel();
    const inReel = reel && reel.querySelector('video');
    if (inReel) return inReel;
    const videos = Array.from(document.querySelectorAll('ytd-shorts video, #shorts-player video'));
    return videos.find((v) => !v.paused) || videos[0] || null;
  }

  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  /** Метаданные текущего шорта из DOM — по возможности; главное — id из адреса. */
  function readCurrentShort() {
    const id = currentShortId();
    if (!id) return null;
    const reel = activeReel() || document;
    const titleEl = reel.querySelector(
      'yt-shorts-video-title-view-model h2, [class*="ShortsVideoTitle"], h2.title, #overlay h2, .ytShortsVideoTitleViewModelShortsVideoTitle'
    );
    const channelLink = Array.from(
      reel.querySelectorAll('yt-reel-channel-bar-view-model a, [class*="ReelChannelBar"] a, ytd-channel-name a, a[href^="/@"]')
    ).find((a) => clean(a.textContent));
    const tagText = Array.from(reel.querySelectorAll('a[href^="/hashtag/"]'))
      .map((a) => a.textContent)
      .join(' ');
    return {
      id,
      tags: YFS.rules.extractTags(`${titleEl ? titleEl.textContent : ''} ${tagText}`),
      title: clean(titleEl && titleEl.textContent),
      channel: clean(channelLink && channelLink.textContent).replace(/^@/, ''),
      channelUrl: channelLink ? (channelLink.getAttribute('href') || '').split('?')[0] : '',
      short: true,
      url: '/shorts/' + id,
      source: 'shorts-page',
    };
  }

  // ---------- звук: Shorts собираются без звука ----------

  let silence = false; // пока идёт сбор Shorts, любой запущенный ролик сразу глушится

  function hush(e) {
    if (silence && e.target instanceof HTMLMediaElement && !e.target.muted) e.target.muted = true;
  }
  // События media не всплывают, но ловятся на перехвате — так глушим и ролики, которые YouTube создаст позже.
  for (const type of ['play', 'playing', 'loadedmetadata', 'volumechange']) document.addEventListener(type, hush, true);

  function muteAll() {
    for (const v of document.querySelectorAll('video')) v.muted = true;
  }

  // ---------- переход к следующему шорту ----------

  function clickNextButton(dir = 1) {
    const down = [
      '#navigation-button-down button',
      '#navigation-button-down [role="button"]',
      'ytd-shorts button[aria-label*="Next video" i]',
      'ytd-shorts button[aria-label*="Следующ" i]',
      'button[aria-label="Next video"]',
      'button[aria-label="Следующее видео"]',
    ];
    const up = [
      '#navigation-button-up button',
      '#navigation-button-up [role="button"]',
      'ytd-shorts button[aria-label*="Previous video" i]',
      'ytd-shorts button[aria-label*="Предыдущ" i]',
    ];
    const btn = document.querySelector((dir > 0 ? down : up).join(', '));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }

  function scrollReels(dir = 1) {
    const box = document.querySelector('#shorts-inner-container');
    if (!box) return false;
    box.scrollBy({ top: dir * box.clientHeight, behavior: 'smooth' });
    return true;
  }

  function pressArrowDown(dir = 1) {
    const target = document.querySelector('ytd-shorts') || document.body;
    const key = dir > 0 ? 'ArrowDown' : 'ArrowUp';
    const init = { key, code: key, keyCode: dir > 0 ? 40 : 38, which: dir > 0 ? 40 : 38, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    document.dispatchEvent(new KeyboardEvent('keydown', init));
    return true;
  }

  async function waitForShortChange(fromId, timeout) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (currentShortId() && currentShortId() !== fromId) return true;
      await sleep(120);
    }
    return false;
  }

  /**
   * Следующий шорт. YouTube часто меняет разметку, поэтому пробуем по очереди
   * кнопку «вниз», прокрутку ленты и клавишу ↓ — и каждый раз проверяем, что шорт сменился.
   */
  async function moveShort(dir) {
    const from = currentShortId();
    for (const attempt of [clickNextButton, scrollReels, pressArrowDown]) {
      if (!attempt(dir)) continue;
      // Адрес меняется с задержкой: если не дождаться, следующая попытка перелистнёт ещё один шорт.
      if (await waitForShortChange(from, 2500)) return true;
    }
    return false;
  }

  const nextShort = () => moveShort(1);

  /**
   * Сбор из окна Shorts: открываем ленту, без звука листаем вниз и запоминаем ролики.
   * Очередь из reel_watch_sequence даёт id ещё до того, как ролик показан.
   */
  async function collectShorts(goal, current) {
    silence = true;
    muteAll();
    const wasMuted = await askHook('mute', 'shorts'); // и сам плеер YouTube — чтобы не включал звук на новом ролике
    const initialJson = await askHook('initial', 'shorts');
    const initialGeneric = initialJson ? P.extractGeneric(initialJson).map((v) => ({ ...v, short: true })) : [];
    const visited = [];
    const startedAt = Date.now();
    let idle = 0;
    let reason = 'done';
    let all = [];

    try {
      for (;;) {
        muteAll();
        await sleep(600); // дать оверлею с названием отрисоваться
        const cur = readCurrentShort();
        if (cur) {
          const prev = visited.find((v) => v.id === cur.id);
          if (!prev) visited.push(cur);
          else for (const k of ['title', 'channel', 'channelUrl']) if (!prev[k] && cur[k]) prev[k] = cur[k];
        }
        all = P.mergeVideos([visited, initialGeneric, parsedNet('shorts').generic]).map((v) => ({ ...v, short: true }));
        const found = Math.min(goal.pick(all).length, goal.target);
        report({ phase: 'progress', page: 'shorts', goals: [{ type: 'shorts', found, target: goal.target }], scanned: all.length });
        if (found >= goal.target) break;
        if (current.cancelled) {
          reason = 'cancelled';
          break;
        }
        if (Date.now() - startedAt > MAX_RUN_MS.shorts) {
          reason = 'timeout';
          break;
        }
        if (await nextShort()) idle = 0;
        else if (++idle >= MAX_IDLE_ROUNDS) {
          reason = 'exhausted';
          break;
        }
      }
    } finally {
      const video = activeVideo();
      if (video) video.pause();
      silence = false;
      if (wasMuted === false) await askHook('unmute', 'shorts'); // вернуть пользователю его звук
    }
    if (!all.length) throw new Error(tr('collect.shortsEmpty'));

    const videos = finalize('shorts', goal.pick(all), goal.target);
    return {
      feeds: videos.length ? [{ type: 'shorts', videos }] : [],
      stats: { shorts: { found: videos.length, target: goal.target, scanned: all.length, reason, idOnly: videos.filter((v) => !v.title).length } },
      health: { suspicious: false, reasons: [] },
    };
  }

  // ---------- PRO: автолистание Shorts, правила пропуска, медиаклавиши ----------

  const R = YFS.rules;
  const auto = {
    wanted: false,
    pro: false,
    enabled: false,
    rules: R.normalizeRules(),
    seen: null,
    lastWritten: '',
    // конец ролика
    id: '',
    prev: 0,
    since: 0,
    advancing: false,
    doneFor: '',
    // оценка нового шорта по правилам
    evalId: '',
    evalSince: 0,
    evalDone: false,
    current: null, // { authorKey, authorName, tags, durationSec } текущего шорта
    skipped: 0,
    streak: 0,
    pauseUntil: 0,
    lastSkip: '',
  };

  async function loadAutoScroll() {
    try {
      const { yfs_viewer = {}, yfs_autoscroll = false, yfs_skip = null, yfs_seen = null } = await chrome.storage.local.get([
        'yfs_viewer',
        'yfs_autoscroll',
        'yfs_skip',
        'yfs_seen',
      ]);
      auto.pro = !!yfs_viewer.pro;
      auto.wanted = !!yfs_autoscroll;
      auto.rules = R.normalizeRules(yfs_skip);
      if (!auto.seen) auto.seen = yfs_seen && typeof yfs_seen === 'object' ? yfs_seen : { authors: {}, tags: {} };
    } catch {
      auto.pro = false;
    }
    auto.enabled = auto.pro && auto.wanted;
    syncShortsTimers();
  }

  let seenTimer = 0;
  function saveSeenSoon() {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => {
      auto.lastWritten = JSON.stringify(auto.seen);
      chrome.storage.local.set({ yfs_seen: auto.seen }).catch(() => {});
    }, 4000);
  }

  const reasonText = (r) => tr('skip.' + r);

  /** Плашка на странице Shorts: состояние, счётчик пропусков и кнопка «пропускать этого автора». */
  const badgeRefs = {};
  function ensureBadge() {
    let badge = document.getElementById('yfs-auto-badge');
    if (badge) return badge;
    badge = document.createElement('div');
    badge.id = 'yfs-auto-badge';
    badge.style.cssText =
      'position:fixed;left:16px;bottom:16px;z-index:9999;display:flex;flex-direction:column;gap:6px;align-items:flex-start;' +
      'max-width:340px;padding:8px 12px;border-radius:14px;background:rgba(0,0,0,.78);color:#fff;' +
      'font:500 13px/1.35 Roboto,Arial,sans-serif;pointer-events:none';
    badgeRefs.status = document.createElement('div');
    badgeRefs.info = document.createElement('div');
    badgeRefs.info.style.cssText = 'font-weight:400;opacity:.85';
    badgeRefs.btn = document.createElement('button');
    badgeRefs.btn.type = 'button';
    badgeRefs.btn.style.cssText =
      'pointer-events:auto;cursor:pointer;border:0;border-radius:12px;padding:3px 10px;background:#ffffff26;color:#fff;font:inherit';
    badgeRefs.btn.addEventListener('click', blockCurrentAuthor);
    badge.append(badgeRefs.status, badgeRefs.info, badgeRefs.btn);
    (document.body || document.documentElement).append(badge);
    return badge;
  }

  function updateAutoBadge() {
    const show = auto.wanted && !!currentShortId() && !job;
    const existing = document.getElementById('yfs-auto-badge');
    if (!show) {
      if (existing) existing.remove();
      return;
    }
    ensureBadge();
    if (!auto.enabled) {
      badgeRefs.status.textContent = tr('badge.needPro');
      badgeRefs.info.textContent = '';
      badgeRefs.btn.style.display = 'none';
      return;
    }
    badgeRefs.status.textContent = tr('badge.on') + (auto.skipped ? ' · ' + tr('badge.skipped', { n: auto.skipped }) : '');
    const cur = auto.current;
    const lines = [];
    if (cur && cur.authorName) lines.push(cur.authorName + (cur.durationSec ? ` · ${Math.round(cur.durationSec)} ${tr('unit.sec')}` : ''));
    if (auto.lastSkip) lines.push(tr('badge.lastSkip', { reason: auto.lastSkip }));
    badgeRefs.info.textContent = lines.join(' — ');
    const can = cur && cur.authorKey && !Object.prototype.hasOwnProperty.call(auto.rules.authors, cur.authorKey);
    badgeRefs.btn.style.display = can ? '' : 'none';
    if (can) badgeRefs.btn.textContent = tr('badge.blockAuthor', { name: cur.authorName });
  }

  async function blockCurrentAuthor() {
    const cur = auto.current;
    if (!cur || !cur.authorKey) return;
    auto.rules.authors[cur.authorKey] = cur.authorName || cur.authorKey;
    await chrome.storage.local.set({ yfs_skip: auto.rules }).catch(() => {});
    skipCurrent('author');
  }

  async function autoAdvance() {
    if (auto.advancing || auto.doneFor === currentShortId()) return;
    auto.advancing = true;
    auto.doneFor = currentShortId();
    try {
      await nextShort();
    } finally {
      auto.advancing = false;
    }
  }

  function skipCurrent(reason) {
    auto.skipped++;
    auto.streak++;
    auto.lastSkip = reasonText(reason);
    updateAutoBadge();
    autoAdvance();
  }

  /**
   * Новый шорт появился: через долю секунды читаем автора, теги и длительность,
   * записываем в «что смотрели» и решаем по правилам, пропускать ли.
   */
  let evalBusy = false;
  async function evaluateShort() {
    if (!auto.enabled || job || auto.advancing || evalBusy) return;
    const id = currentShortId();
    if (!id) return;
    if (id !== auto.evalId) {
      auto.evalId = id;
      auto.evalSince = Date.now();
      auto.evalDone = false;
      auto.current = null;
    }
    if (auto.evalDone || Date.now() - auto.evalSince < 700) return;

    const cur = readCurrentShort();
    // Оверлей с автором рисуется не сразу — ждём до 3 секунд.
    if (!(cur && (cur.channel || cur.channelUrl)) && Date.now() - auto.evalSince < 3000) return;
    // Длительность — только от плеера и только если он уже играет именно этот ролик:
    // <video> YouTube переиспользует, и сразу после смены шорта в нём ещё длина предыдущего.
    evalBusy = true;
    let durationSec = 0;
    try {
      const pi = await askHook('playerinfo', 'shorts', 1500);
      if (id !== currentShortId()) return; // шорт уже сменили, пока ждали
      if (pi && pi.id === id && pi.duration > 0) durationSec = pi.duration;
      else if (Date.now() - auto.evalSince < 3500) return; // плеер ещё переключается — повторим на следующем тике
    } finally {
      evalBusy = false;
    }
    auto.evalDone = true;
    const info = {
      durationSec,
      authorKey: cur ? R.authorKey(cur.channelUrl, cur.channel) : '',
      authorName: cur ? cur.channel : '',
      tags: cur ? cur.tags : [],
    };
    auto.current = info;
    auto.seen = R.recordSeen(auto.seen, info);
    saveSeenSoon();

    const reason = Date.now() < auto.pauseUntil ? null : R.decideSkip(info, auto.rules);
    if (reason) {
      // Защита от бесконечного пролистывания, если правила отсекают почти всё.
      if (auto.streak >= 25) {
        auto.streak = 0;
        auto.pauseUntil = Date.now() + 60000;
        auto.lastSkip = tr('skip.pause');
        updateAutoBadge();
        return;
      }
      skipCurrent(reason);
    } else {
      auto.streak = 0;
      updateAutoBadge();
    }
  }

  /**
   * Shorts зациклены, поэтому «ended» обычно не приходит. Ловим конец заранее —
   * за долю секунды до повтора, — а если не успели, то момент, когда время прыгнуло в начало.
   */
  function onTimeUpdate(e) {
    const v = e.target;
    const id = currentShortId();
    if (!(v instanceof HTMLVideoElement) || !auto.enabled || job || v.paused || !id) return;
    // Слушаем только видимый ролик: соседние YouTube подгружает заранее.
    if (v !== activeVideo()) return;
    // YouTube переиспользует один <video> для соседних шортов: при смене шорта забываем прошлое время,
    // иначе «прыжок» от конца старого к началу нового выглядит как повтор и листает ещё раз.
    if (id !== auto.id) {
      auto.id = id;
      auto.prev = 0;
      auto.since = Date.now();
    }
    const d = v.duration;
    const t = v.currentTime;
    const prev = auto.prev;
    auto.prev = t;
    if (!d || !isFinite(d) || d < 1) return;
    if (Date.now() - auto.since < 1500) return; // новый шорт ещё «устаканивается»
    if (auto.doneFor === id) return; // для этого шорта уже листали
    const nearEnd = t >= d - 0.35 && t > 1;
    const looped = prev > d - 1.2 && t < 1; // доиграл и вернулся в начало
    if (nearEnd || looped) autoAdvance();
  }

  function onEnded(e) {
    if (e.target instanceof HTMLVideoElement && e.target === activeVideo() && auto.enabled && !job && currentShortId()) autoAdvance();
  }

  // Медиаклавиши и наушники (см. media.js): «следующий/предыдущий трек» листают шорты.
  let lastMedia = 0;
  document.addEventListener('yfs:media', (e) => {
    if (!auto.enabled || job || auto.advancing || !currentShortId() || Date.now() - lastMedia < 400) return;
    lastMedia = Date.now();
    const dir = e.detail === 'prev' ? -1 : 1;
    auto.advancing = true;
    moveShort(dir).finally(() => (auto.advancing = false));
  });

  document.addEventListener('timeupdate', onTimeUpdate, true);
  document.addEventListener('ended', onEnded, true);
  // Таймеры работают только на странице Shorts и только когда автолистание нужно —
  // на остальном YouTube расширение ничего не делает в фоне.
  let shortsTimers = null;
  function syncShortsTimers() {
    const need = auto.wanted && pageKind() === 'shorts';
    if (need && !shortsTimers) shortsTimers = [setInterval(evaluateShort, 400), setInterval(updateAutoBadge, 2000)];
    if (!need && shortsTimers) {
      shortsTimers.forEach(clearInterval);
      shortsTimers = null;
    }
    updateAutoBadge();
  }
  // SPA-переходы YouTube (адрес меняется без перезагрузки страницы).
  document.addEventListener('yt-navigate-finish', syncShortsTimers);
  window.addEventListener('popstate', syncShortsTimers);
  loadAutoScroll();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.yfs_viewer || changes.yfs_autoscroll || changes.yfs_skip) loadAutoScroll();
    // Список «что смотрели» очистили на странице настроек — подхватываем, но не затираем собственную запись.
    if (changes.yfs_seen && JSON.stringify(changes.yfs_seen.newValue || null) !== auto.lastWritten) {
      auto.seen = changes.yfs_seen.newValue || { authors: {}, tags: {} };
    }
  });

  async function collect({ page, want = {}, filters = {} }) {
    if (pageKind() !== page) throw new Error(tr('collect.wrongPage'));
    if (job) throw new Error(tr('collect.running'));
    const goals = makeGoals(page, want, filters);
    if (!goals.length) throw new Error(tr('collect.nothingHere'));
    if (page === 'shorts') {
      job = { cancelled: false };
      try {
        return await collectShorts(goals[0], job);
      } finally {
        job = null;
      }
    }

    const startY = window.scrollY;
    const startedAt = Date.now();
    const current = (job = { cancelled: false });

    try {
      const initialJson = net[page].stale ? null : await askHook('initial', page);
      const initial = {
        videos: initialJson ? P.extractVideos(initialJson) : [],
        generic: initialJson ? P.extractGeneric(initialJson) : [],
      };
      let all = [];
      let health = null;
      let seen = 0;
      let idle = 0;
      let reason = 'done';
      let repair = null;

      for (;;) {
        ({ videos: all, health } = await snapshotOf(page, initial));
        // Похоже на поломку — один раз за сбор пробуем починить парсер с помощью ИИ.
        if (health.suspicious && !repair) {
          repair = await tryRepair(page, initialJson);
          if (repair.status === 'fixed') {
            // Рецепт выучен — разбираем уже полученные ответы заново.
            const st = net[page];
            Object.assign(st, { parsed: 0, videos: [], generic: [] });
            initial.videos = initialJson ? P.extractVideos(initialJson) : [];
            ({ videos: all, health } = await snapshotOf(page, initial));
          }
        }
        if (repair && repair.status !== 'off' && repair.status !== 'skip') health.ai = repair;
        const progress = goals.map((g) => ({ type: g.type, found: Math.min(g.pick(all).length, g.target), target: g.target }));
        report({ phase: 'progress', page, goals: progress, scanned: all.length, fallback: health.suspicious });

        const satisfied = goals.every((g, i) => progress[i].found >= g.target || (g.periodDone && g.periodDone(all)));
        if (satisfied) break;
        if (current.cancelled) {
          reason = 'cancelled';
          break;
        }
        if (all.length > seen) {
          seen = all.length;
          idle = 0;
        } else if (++idle >= MAX_IDLE_ROUNDS) {
          reason = 'exhausted';
          break;
        }
        if (Date.now() - startedAt > MAX_RUN_MS[page]) {
          reason = 'timeout';
          break;
        }
        const before = lastChunkAt;
        scrollDown();
        await waitForChunk(before, CHUNK_WAIT_MS);
        await sleep(400); // даём YouTube отрисовать новые карточки
      }

      if (!all.length) {
        throw new Error(
          page === 'home'
            ? tr('collect.noVideos')
            : tr('collect.emptyList')
        );
      }
      if (health.suspicious) await saveSample(page, health, initialJson);

      const feeds = [];
      const stats = {};
      for (const g of goals) {
        const videos = finalize(g.type, g.pick(all), g.target);
        stats[g.type] = {
          found: videos.length,
          target: g.days === undefined ? g.target : null,
          scanned: all.length,
          reason,
          idOnly: videos.filter((v) => !v.title).length,
          health,
        };
        if (g.type === 'history' && videos.length && videos.every((v) => !v.watchedDay)) stats.history.datesUnknown = true;
        if (videos.length) feeds.push({ type: g.type, videos });
      }
      return { feeds, stats, health };
    } finally {
      window.scrollTo(0, startY);
      job = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'yfs:ping') {
      sendResponse({ ok: true, page: pageKind(), running: !!job });
    } else if (msg.type === 'yfs:collect') {
      collect(msg.request || {}).then(
        (result) => sendResponse({ ok: true, ...result }),
        (err) => sendResponse({ ok: false, error: err.message })
      );
      return true; // ответим асинхронно
    } else if (msg.type === 'yfs:cancel') {
      if (job) job.cancelled = true;
      sendResponse({ ok: true });
    }
  });
})();
