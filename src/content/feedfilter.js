/*
 * 🎛 Фильтр рекомендаций на youtube.com: главная, подписки, поиск и колонка «рекомендуем» у ролика.
 *
 * Карточки можно скрывать по типу (Shorts, трансляции, премьеры, просмотренные, миксы), длительности,
 * языку заголовка, авторам, словам и #хештегам, оставить «только музыку» и пересортировать
 * (новые, старые, по просмотрам, по длительности). Вместо скрытия карточки можно показать группами:
 * по авторам, типу, длительности, языку или хештегам (экран «🗂 Лента по группам»).
 * «🔎 Найти всю музыку»: на главной включает чипы «Музыка» и «Джемы», раскрывает полки («Ещё»), пролистывает
 * ленту вниз и достаёт треки из миксов и джемов. «▶ Слушать подряд» собирает из найденного свою очередь
 * (src/content/queue.js, до 500 треков, без лимита watch_videos) — по порядку, вперемешку или в порядке от Gemini.
 *
 * Данные о карточках: ответы YouTube (hook.js передаёт их, пока фильтр включён) + запасной разбор DOM.
 * Правила — yfs_feedfilter, общие для всех вкладок. Кнопка 🎛 — справа внизу.
 */
(function () {
  'use strict';
  if (window.top !== window || globalThis.__yfsFeedAlive) return;
  globalThis.__yfsFeedAlive = true;

  const YFS = globalThis.YFS;
  const R = YFS.feedrules;
  const T = YFS.taste;
  const M = YFS.music;
  const P = YFS.parse;
  const W = YFS.watch;
  const tr = (k, p) => YFS.i18n.t(k, p);
  const KEY = 'yfs_feedfilter';
  const ID_RE = /(?:[?&]v=|\/shorts\/)([A-Za-z0-9_-]{11})/;
  const DUR_RE = /^\d{1,2}(:\d{2}){1,2}$/;
  const LIVE_RE = /^(live|в эфире|прямой эфир|наживо|en direct|en vivo|ao vivo|in diretta|na żywo|canlı|ライブ|直播)$/i;

  let rules = R.normalizeRules();
  let tapOn = false;
  const data = new Map(); // id → видео из ответов YouTube
  const langCache = new Map(); // заголовок → код языка (chrome.i18n.detectLanguage)
  let ui = null;
  let panelOpen = false;
  let observer = null;
  let applyTimer = 0;
  let stats = { total: 0, hidden: 0, cards: [] };
  let job = null; // прокрутка ленты: { music, total, cancelled, label }
  let cancelAll = false; // «Остановить» прерывает и переход между чипами
  let found = null; // последний результат поиска музыки: { scope, at, tracks: Map, mixes: Map }
  let groupOpen = false; // открыт экран «Лента по группам»
  let groupSig = '';
  let groupTimer = 0;
  const collapsed = new Set(); // свёрнутые группы

  // ---------- где мы ----------

  function scope() {
    const p = location.pathname;
    if (p === '/') return 'home';
    if (p === '/feed/subscriptions') return 'subs';
    if (p === '/results') return 'search';
    if (p === '/watch') return 'related';
    return '';
  }

  const CARD_SEL = {
    home: 'ytd-browse[page-subtype="home"] ytd-rich-item-renderer',
    subs: 'ytd-browse[page-subtype="subscriptions"] ytd-rich-item-renderer, ytd-browse[page-subtype="subscriptions"] ytd-video-renderer',
    search: 'ytd-search ytd-video-renderer, ytd-search yt-lockup-view-model',
    related: '#related yt-lockup-view-model, #related ytd-compact-video-renderer',
  };
  const SHELF_SEL = 'ytd-rich-section-renderer, ytd-reel-shelf-renderer, grid-shelf-view-model, ytd-rich-shelf-renderer';

  const active = () => rules.enabled && !!scope() && !!rules.scopes[scope()];
  const MAX_TRACKS = 300;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- данные карточек ----------

  function ingest(json) {
    let list = [];
    try {
      list = P.extractVideos(json);
    } catch {
      return;
    }
    for (const v of list) {
      const prev = data.get(v.id);
      data.set(v.id, prev ? { ...v, ...Object.fromEntries(Object.entries(prev).filter(([, x]) => x)) } : v);
    }
    // Память ограничена: старые записи уходят первыми.
    if (data.size > 3000) for (const k of Array.from(data.keys()).slice(0, data.size - 2500)) data.delete(k);
  }

  document.addEventListener('yfs:feeddata', (e) => {
    try {
      ingest(JSON.parse(e.detail));
      schedule();
    } catch {
      /* не JSON */
    }
  });

  async function setTap(on) {
    if (on === tapOn || !YFS.askPage) return;
    tapOn = on;
    const initial = await YFS.askPage('feedtap', on ? 'on' : 'off', 8000);
    if (on && Array.isArray(initial)) for (const part of initial) ingest(part);
    if (on) schedule();
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /** Карточка из DOM (запасной путь) — то, что видно пользователю. */
  function fromDom(el, href) {
    const titleEl = el.querySelector('#video-title, h3 a, h3, [class*="lockup-metadata-view-model"][class*="title"]');
    const title = clean((titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || '');
    const chLink = Array.from(el.querySelectorAll('a[href^="/@"], a[href^="/channel/"], a[href^="/c/"]')).find((a) => clean(a.textContent));
    let channel = clean(chLink && chLink.textContent);
    const spans = Array.from(el.querySelectorAll('#metadata-line span, [class*="metadata"] span[class*="text"], yt-content-metadata-view-model span'))
      .map((s) => clean(s.textContent))
      .filter((t) => t && t !== '•' && t !== title);
    if (!channel && el.tagName === 'YT-LOCKUP-VIEW-MODEL') channel = spans[0] || '';
    const badges = Array.from(el.querySelectorAll('badge-shape, [class*="badge-shape"], ytd-thumbnail-overlay-time-status-renderer')).map((b) => clean(b.textContent));
    const views = spans.find((t) => /\d/.test(t) && /(просмотр|зрител|view|watch|млн|тыс|\d\s?[kmb]\b)/i.test(t)) || '';
    const age = spans.find((t) => /(назад|ago|тому|hace|há|il y a|vor|fa|temu|önce|前)/i.test(t)) || '';
    const progress = el.querySelector('ytd-thumbnail-overlay-resume-playback-renderer #progress, [class*="ProgressBarSegment"], [class*="progress-bar-segment"]');
    return {
      title,
      channel,
      channelUrl: chLink ? (chLink.getAttribute('href') || '').split('?')[0] : '',
      duration: badges.find((t) => DUR_RE.test(t)) || '',
      live: badges.some((t) => LIVE_RE.test(t)) || !!el.querySelector('[overlay-style="LIVE"], [class*="ThumbnailLive"], .badge-style-type-live-now-alternate'),
      short: href.startsWith('/shorts/'),
      watched: progress ? parseFloat(progress.style.width) || 0 : 0,
      viewsText: views,
      ageText: age,
    };
  }

  function langOf(title) {
    const s = R.scriptLang(title);
    if (s !== 'latin') return s;
    const cached = langCache.get(title);
    if (cached !== undefined) return cached || 'latin';
    langCache.set(title, ''); // запрос пошёл — пока «латиница»
    try {
      if (chrome.i18n && chrome.i18n.detectLanguage) {
        chrome.i18n.detectLanguage(title, (res) => {
          const best = res && res.languages && res.languages[0];
          const code = best && (res.isReliable || best.percentage >= 60) ? String(best.language).split('-')[0] : '';
          langCache.set(title, code && code !== 'und' ? code : '');
          if (code) schedule();
        });
      }
    } catch {
      /* без уточнения */
    }
    return 'latin';
  }

  function cardOf(el) {
    const link = el.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]');
    const href = (link && link.getAttribute('href')) || '';
    const m = href.match(ID_RE);
    if (!m) return null;
    const id = m[1];
    const d = data.get(id) || {};
    const dom = fromDom(el, href);
    const mix = /[?&]start_radio=1/.test(href) || !!el.querySelector('yt-collection-thumbnail-view-model, ytd-playlist-thumbnail, yt-collections-stack');
    const title = d.title || dom.title;
    const channel = d.channel || dom.channel;
    const durationSec = R.durationToSec(d.duration || dom.duration);
    const card = {
      id,
      href: href.startsWith('/shorts/') ? `/shorts/${id}` : `/watch?v=${id}`,
      mixHref: mix && /[?&]list=/.test(href) ? href : '',
      title,
      channel,
      channelUrl: d.channelUrl || dom.channelUrl,
      durationSec,
      live: !!(d.live || dom.live),
      upcoming: !!d.upcoming && !dom.duration,
      short: !!(d.short || dom.short),
      mix,
      watched: Math.max(d.watched || 0, dom.watched || 0),
      views: R.parseCount(d.views || dom.viewsText),
      ageSec: R.parseAge(d.published || dom.ageText),
      lang: langOf(title),
    };
    card.music = mix ? 0 : M.musicScore({ title, channel, durationSec });
    return card;
  }

  // ---------- применение ----------

  function ensureStyle() {
    if (document.getElementById('yfs-feed-style')) return;
    const s = document.createElement('style');
    s.id = 'yfs-feed-style';
    s.textContent = '[data-yfs-hide]{display:none!important}';
    (document.head || document.documentElement).append(s);
  }

  function unflex(parent) {
    parent.removeAttribute('data-yfs-flex');
    parent.style.removeProperty('display');
    parent.style.removeProperty('flex-direction');
  }

  function clearAll() {
    for (const el of document.querySelectorAll('[data-yfs-flex]')) unflex(el);
    for (const el of document.querySelectorAll('[data-yfs-hide]')) el.removeAttribute('data-yfs-hide');
    for (const el of document.querySelectorAll('[data-yfs-order]')) {
      el.style.removeProperty('order');
      el.removeAttribute('data-yfs-order');
    }
    stats = { total: 0, hidden: 0, cards: [] };
    renderButton();
  }

  function apply() {
    applyTimer = 0;
    if (!active()) {
      clearAll();
      if (groupOpen) {
        groupOpen = false;
        renderGroups();
      }
      return;
    }
    ensureStyle();
    const sc = scope();
    const els = Array.from(document.querySelectorAll(CARD_SEL[sc]));
    const cards = [];
    let hidden = 0;
    const groups = new Map(); // родитель → карточки (для сортировки)
    for (const el of els) {
      const card = cardOf(el);
      if (!card) continue;
      card.el = el;
      cards.push(card);
      const { hide } = R.decide(card, rules);
      el.toggleAttribute('data-yfs-hide', hide);
      if (hide) hidden++;
      const g = groups.get(el.parentElement) || [];
      g.push(card);
      groups.set(el.parentElement, g);
    }
    // Полки Shorts (на главной и в поиске) — целиком.
    for (const shelf of document.querySelectorAll(SHELF_SEL)) {
      const shorts = shelf.querySelectorAll('a[href^="/shorts/"]').length;
      shelf.toggleAttribute('data-yfs-hide', !!rules.hideShorts && shorts > 1 && !shelf.querySelector('a[href*="/watch?v="]'));
    }
    // Сортировка: CSS order внутри общего контейнера (flex или grid) — разметку YouTube не трогаем.
    for (const [parent, list] of groups) {
      if (!parent) continue;
      // Обычный блочный список (поиск) на время сортировки — вертикальная flex-колонка: выглядит так же, а order работает.
      if (rules.sort !== 'none' && !parent.hasAttribute('data-yfs-flex') && getComputedStyle(parent).display === 'block' && list.length > 1) {
        parent.setAttribute('data-yfs-flex', '');
        parent.style.setProperty('display', 'flex');
        parent.style.setProperty('flex-direction', 'column');
      } else if (rules.sort === 'none' && parent.hasAttribute('data-yfs-flex')) unflex(parent);
      const sortable = rules.sort !== 'none' && /flex|grid/.test(getComputedStyle(parent).display);
      if (!sortable) {
        for (const c of list) if (c.el.hasAttribute('data-yfs-order')) (c.el.style.removeProperty('order'), c.el.removeAttribute('data-yfs-order'));
        continue;
      }
      list
        .map((c, i) => ({ c, i, v: R.sortValue(c, rules.sort) }))
        .sort((a, b) => a.v - b.v || a.i - b.i)
        .forEach((x, n) => {
          x.c.el.style.setProperty('order', String(n));
          x.c.el.setAttribute('data-yfs-order', '');
        });
    }
    stats = { total: cards.length, hidden, cards };
    renderButton();
    if (panelOpen) renderPanel();
    if (groupOpen) scheduleGroups();
  }

  /** Перерисовать не чаще раза в 300 мс (YouTube меняет DOM десятки раз в секунду). */
  function schedule() {
    if (!applyTimer) applyTimer = setTimeout(apply, 300);
  }

  function watchDom(on) {
    if (on && !observer) {
      observer = new MutationObserver(schedule);
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } else if (!on && observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function refresh() {
    const on = active();
    setTap(on);
    watchDom(on);
    ensureUi();
    schedule();
  }

  // ---------- прокрутка ленты: подгрузить карточки ----------

  const visibleMusic = () => stats.cards.filter((c) => c.music >= 0.5 && !(c.el && c.el.hasAttribute('data-yfs-hide'))).length;

  // Чипы вверху главной и кнопки «Ещё» у полок. Названия — на языках интерфейса YouTube.
  const CHIPS = {
    music: /^(музыка|music|música|musik|musique|musica|müzik|muzyka|музика|音楽|音乐)$/i,
    jams: /^(джемы|jams?|jam sessions?)$/i,
  };
  const MORE_RE = /^(ещё|еще|ще|показать (?:ещё|еще|больше)|развернуть|show more|more|expand|mehr|mehr anzeigen|mostrar más|más|afficher plus|plus|mostra altro|altro|mostrar mais|mais|pokaż więcej|więcej|rozwiń|daha fazla göster|daha fazla|もっと見る|さらに表示|显示更多|更多|показати більше|показати ще)$/i;
  let moreEpoch = 1; // новая лента (другой чип) — кнопки «Ещё» нажимаем заново
  const cls = (n) => String((n && n.getAttribute && n.getAttribute('class')) || '');

  function findChip(re) {
    for (const c of document.querySelectorAll('yt-chip-cloud-chip-renderer, chip-shape, ytd-feed-filter-chip-bar-renderer button')) {
      if (re.test(clean(c.textContent))) return c;
    }
    return null;
  }

  function chipSelected(c) {
    const b = c.matches('button') ? c : c.querySelector('button') || c;
    return c.hasAttribute('selected') || b.getAttribute('aria-selected') === 'true' || /active|selected/i.test(cls(c) + ' ' + cls(b));
  }

  /** Включает чип главной («Музыка», «Джемы»), если он есть и ещё не выбран. */
  async function pickChip(re) {
    const c = findChip(re);
    if (!c) return false;
    if (!chipSelected(c)) {
      moreEpoch++;
      (c.querySelector('button') || c).click();
      await sleep(2600); // лента перезагружается
    }
    return true;
  }

  /**
   * Нажимает «Ещё» у полок («Недавно прослушанные», «Джемы» и т. п.): без этого в них видна только первая строка.
   * Только видимые кнопки ленты (не меню и не боковую панель) и только нераскрытые (aria-expanded ≠ true).
   */
  function expandShelves() {
    let n = 0;
    for (const b of document.querySelectorAll('ytd-browse:not([hidden]) button, ytd-search button')) {
      if (b.getAttribute('aria-expanded') === 'true' || b.dataset.yfsMore === String(moreEpoch)) continue;
      const label = clean(b.getAttribute('aria-label'));
      const text = clean(b.textContent);
      if (!MORE_RE.test(text) && !MORE_RE.test(label)) continue;
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) continue; // кнопка скрыта (свёрнутая полка, другая вкладка)
      b.dataset.yfsMore = String(moreEpoch);
      b.click();
      n++;
    }
    return n;
  }

  /** Музыка и миксы со страницы → в коллекцию into (карточки уходят из DOM при смене чипа, поэтому копим данные). */
  function gather(into) {
    for (const c of stats.cards) {
      if (c.short) continue;
      if (c.mix) {
        if (c.mixHref) into.mixes.set(c.mixHref, c.title);
        continue;
      }
      if (c.music >= 0.5 && !(c.el && c.el.hasAttribute('data-yfs-hide'))) into.tracks.set(c.id, { id: c.id, title: c.title, channel: c.channel });
    }
  }

  /**
   * Сама листает ленту, как человек: шагами по экрану, а не прыжком в самый низ. Полки YouTube дорисовывают
   * карточки только когда видны на экране, поэтому прыжок пропускал середину ленты, а кнопки «Ещё» в ней
   * так и оставались ненажатыми. На каждом шаге — раскрыть полки и собрать карточки; внизу — дождаться,
   * пока YouTube подгрузит следующую порцию. Стоп: набралось opts.music треков, прошло opts.rounds порций
   * или лента кончилась (две порции без новых карточек). Потом прокрутка возвращается на прежнее место.
   */
  async function loadFeed(opts = {}) {
    if (job || !active()) return null;
    const sc = scope();
    const sel = CARD_SEL[sc];
    const startY = window.scrollY;
    const me = { music: 0, total: 0, cancelled: false, label: '' };
    job = me;
    renderStatus();
    const root = document.scrollingElement || document.documentElement;
    const stopped = () => me.cancelled || cancelAll || !active() || scope() !== sc;
    const count = () => document.querySelectorAll(sel).length;
    const update = () => {
      apply();
      if (opts.gather) gather(opts.gather);
      me.total = stats.cards.length;
      me.music = opts.gather ? opts.gather.tracks.size : visibleMusic();
      renderStatus();
      return opts.music && me.music >= opts.music;
    };
    let y = 0;
    root.scrollTo({ top: 0, behavior: 'auto' });
    await sleep(200);
    try {
      let stale = 0;
      for (let round = 0; round < (opts.rounds || 80) && !stopped(); round++) {
        if (update()) break;
        // 1. Пройти новую часть ленты шагами по ~80% экрана.
        while (!stopped()) {
          const bottom = root.scrollHeight - window.innerHeight;
          if (y >= bottom - 2) break;
          y = Math.min(bottom, y + Math.round(window.innerHeight * 0.8));
          root.scrollTo({ top: y, behavior: 'auto' });
          await sleep(220);
          if (expandShelves()) {
            await sleep(800); // раскрытая полка дорисовывает карточки
            if (update()) break;
          }
        }
        if (stopped() || update()) break;
        // 2. Внизу: показать YouTube «продолжение», чтобы он подгрузил следующую порцию.
        const before = count();
        const cont = document.querySelector('ytd-browse:not([hidden]) ytd-continuation-item-renderer, ytd-search ytd-continuation-item-renderer');
        if (cont) cont.scrollIntoView({ block: 'end' });
        let grew = false;
        for (let i = 0; i < 16 && !stopped() && !grew; i++) {
          await sleep(150);
          if (count() > before) grew = true;
          // Лента не двигается — «встряхиваем» прокрутку, чтобы сработал наблюдатель подгрузки YouTube.
          if (i === 6) root.scrollBy(0, -700);
          if (i === 7) root.scrollTo({ top: root.scrollHeight, behavior: 'auto' });
        }
        y = Math.max(0, Math.min(y, root.scrollHeight - window.innerHeight));
        stale = grew ? 0 : stale + 1;
        if (stale >= 2) break;
        if (grew) await sleep(300); // карточки дорисовываются
      }
    } finally {
      update();
      job = null;
      if (!groupOpen) window.scrollTo({ top: startY, behavior: 'auto' });
      renderStatus();
      if (panelOpen) renderPanel();
    }
    return { music: opts.gather ? opts.gather.tracks.size : visibleMusic(), total: stats.cards.length, cancelled: me.cancelled || cancelAll };
  }

  function renderStatus() {
    if (!ui) return;
    ui.status.hidden = !job;
    if (job) ui.statusText.textContent = job.label || tr('filter.loading', { total: job.total, music: job.music });
  }

  /** Треки из миксов и джемов: страница микса содержит его плейлист — берём его оттуда (до 10 миксов). */
  async function expandMixes(into) {
    const list = Array.from(into.mixes.keys()).slice(0, 10);
    if (!list.length) return;
    const me = { music: into.tracks.size, total: 0, cancelled: false, label: '' };
    job = me;
    try {
      let n = 0;
      for (const href of list) {
        if (me.cancelled || cancelAll) break;
        me.label = tr('filter.expanding', { n: ++n, total: list.length });
        renderStatus();
        try {
          const res = await fetch(new URL(href, location.origin).href, { credentials: 'include' });
          for (const t of M.extractPlaylistTracks(await res.text())) {
            if (!into.tracks.has(t.id) && into.tracks.size < MAX_TRACKS * 2) into.tracks.set(t.id, { id: t.id, title: t.title, channel: t.channel });
          }
        } catch {
          /* этот микс не открылся — берём остальные */
        }
      }
    } finally {
      job = null;
      renderStatus();
    }
  }

  /** «Найти всю музыку»: на главной — чипы «Музыка» и «Джемы», везде — прокрутка и «Ещё», потом треки из миксов. */
  async function collectMusic() {
    if (job || !active()) return found;
    cancelAll = false;
    const into = { scope: scope(), at: Date.now(), tracks: new Map(), mixes: new Map() };
    if (scope() === 'home') {
      for (const key of ['music', 'jams']) {
        if (cancelAll) break;
        if (await pickChip(CHIPS[key])) await loadFeed({ gather: into, music: MAX_TRACKS });
      }
    }
    if (!cancelAll && !into.tracks.size && !into.mixes.size) await loadFeed({ gather: into, music: MAX_TRACKS });
    if (!cancelAll && rules.expandMixes) await expandMixes(into);
    into.at = Date.now();
    found = into;
    if (panelOpen) renderPanel();
    return into;
  }

  // ---------- 🎵 слушать подряд ----------

  /** Список треков → очередь расширения; открывается первый трек, аудио-режим включается сам. */
  async function startQueue(list) {
    if (!list || list.length < 2) return toast(tr('filter.noMusic'));
    const meta = Object.fromEntries(list.map((t) => [t.id, { title: t.title, channel: t.channel }]));
    let ids = list.map((t) => t.id);
    if (rules.shuffle !== 'none' && YFS.queue) {
      job = { music: ids.length, total: 0, cancelled: false, label: tr(rules.shuffle === 'ai' ? 'filter.shufflingAi' : 'filter.shuffling') };
      renderStatus();
      try {
        ids = await YFS.queue.arrange(ids, meta, rules.shuffle);
      } catch (err) {
        toast(err.code === 'ai-no-key' ? tr('focus.needKey') : tr('ai.err.failed', { message: err.message || '' }));
        ids = R.shuffled(ids); // ИИ недоступен — хотя бы случайный порядок
      } finally {
        job = null;
        renderStatus();
      }
    }
    if (YFS.queue) return YFS.queue.start(ids, meta);
    const url = M.queueUrl(ids);
    if (!url) return toast(tr('filter.noMusic'));
    try {
      sessionStorage.setItem('yfs_audio_mode', '1');
    } catch {
      /* без аудио-режима */
    }
    location.assign(url);
  }

  /** Очередь из карточек одной группы (экран «Лента по группам»). */
  function playIds(ids, cards) {
    const byId = new Map((cards || []).map((c) => [c.id, c]));
    return startQueue(ids.map((id) => ({ id, title: (byId.get(id) || {}).title || '', channel: (byId.get(id) || {}).channel || '' })));
  }

  async function playMusic() {
    if (job) return;
    let into = found && found.scope === scope() && Date.now() - found.at < 600000 ? found : null;
    if (!into) {
      if (scope() === 'related') {
        into = { scope: 'related', at: Date.now(), tracks: new Map(), mixes: new Map() };
        const cur = W.currentVideo();
        if (cur) into.tracks.set(cur.id, { id: cur.id, title: cur.title, channel: cur.channel });
        gather(into);
        if (rules.expandMixes) await expandMixes(into);
      } else into = await collectMusic();
    }
    if (!into || cancelAll) return;
    await startQueue(Array.from(into.tracks.values()).slice(0, MAX_TRACKS * 2));
  }

  // ---------- 🗂 лента по группам ----------

  const fmtTime = (sec) => (YFS.transcript ? YFS.transcript.formatTime(sec) : '');

  function viewsLabel(n) {
    if (!n) return '';
    try {
      return new Intl.NumberFormat(YFS.i18n.locale(), { notation: 'compact' }).format(n);
    } catch {
      return String(n);
    }
  }

  function ageLabel(sec) {
    if (!sec) return '';
    for (const [size, unit] of [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
      if (sec >= size) {
        try {
          return new Intl.RelativeTimeFormat(YFS.i18n.locale(), { numeric: 'auto' }).format(-Math.floor(sec / size), unit);
        } catch {
          return '';
        }
      }
    }
    return '';
  }

  function groupName(g) {
    if (g.lang) return langName(g.lang);
    if (g.labelKey) return tr(g.labelKey);
    return g.label || '';
  }

  /** Открыть ролик из группы: если исходная карточка ещё на странице — кликаем её (YouTube перейдёт без перезагрузки). */
  function openCard(card) {
    const link = card.el && card.el.isConnected && card.el.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]');
    groupOpen = false;
    renderGroups();
    if (link) link.click();
    else location.assign(card.href);
  }

  function groupCardEl(c) {
    const a = el('a', { className: 'gc', href: c.href, title: c.title });
    const thumb = el('span', { className: 'th' }, el('img', { src: `https://i.ytimg.com/vi/${c.id}/mqdefault.jpg`, loading: 'lazy', alt: '' }));
    if (c.durationSec) thumb.append(el('i', {}, fmtTime(c.durationSec)));
    else if (c.live) thumb.append(el('i', { className: 'live' }, 'LIVE'));
    a.append(thumb, el('b', { className: 't' }, c.title), el('span', { className: 'm' }, [c.channel, viewsLabel(c.views), ageLabel(c.ageSec)].filter(Boolean).join(' · ')));
    a.addEventListener('click', (ev) => {
      if (ev.button || ev.ctrlKey || ev.metaKey || ev.shiftKey) return; // новая вкладка — обычной ссылкой
      ev.preventDefault();
      openCard(c);
    });
    return a;
  }

  function scheduleGroups() {
    if (!groupTimer)
      groupTimer = setTimeout(() => {
        groupTimer = 0;
        renderGroups();
      }, 350);
  }

  /** Пока открыт экран групп, страница YouTube под ним не прокручивается — иначе справа две полосы прокрутки. */
  function lockPage(on) {
    const root = document.documentElement;
    if (on) root.style.setProperty('overflow', 'hidden', 'important');
    else root.style.removeProperty('overflow');
  }

  // ---------- ⭐ подборка по вкусу ----------
  //
  // Профиль вкуса строится из последних ~100 роликов истории (отдельный сбор: yfs_taste_history), а похожие
  // ищутся среди карточек ленты, уже загруженных на странице. Расчёты — без AI (src/shared/taste.js);
  // описания ролики берут со своих страниц (описание и ключевые слова), результат кэшируется.
  // Gemini — по желанию, одним коротким запросом: выбрать лучшие и написать «почему».

  const TASTE = { count: 3, busy: false, label: '', results: null, message: '', ver: 0, hist: null, cancel: false };
  const TK = { hist: 'yfs_taste_history', meta: 'yfs_taste_meta', fb: 'yfs_taste_fb', pending: 'yfs_taste_pending' };
  const STAR = '__taste';
  let selGroup = '';

  const tasteBump = () => {
    TASTE.ver++;
    renderGroups(true);
  };

  async function storeGet(key, def) {
    try {
      const v = (await chrome.storage.local.get(key))[key];
      return v === undefined ? def : v;
    } catch {
      return def;
    }
  }

  async function loadTasteHistory() {
    const h = await storeGet(TK.hist, null);
    TASTE.hist = h && Array.isArray(h.videos) && h.videos.length ? h : null;
    return TASTE.hist;
  }

  /** Описание и ключевые слова роликов со страниц /watch (по очереди, с паузой), кэш на 400 роликов. */
  async function metaFor(ids, label) {
    const cache = await storeGet(TK.meta, {});
    const need = ids.filter((id) => !cache[id]);
    let done = 0;
    for (const id of need) {
      if (TASTE.cancel) break;
      TASTE.label = tr(label, { i: ++done, n: need.length });
      renderTasteLabel();
      try {
        const res = await fetch(`/watch?v=${id}`, { credentials: 'include' });
        const meta = YFS.taste.parseWatchMeta(await res.text(), id);
        if (meta) cache[id] = { kw: meta.keywords, d: YFS.taste.miniDescription(meta), c: meta.category, at: Date.now() };
      } catch {
        /* страница не открылась — обойдёмся заголовком */
      }
      await sleep(180);
    }
    const keys = Object.keys(cache);
    if (keys.length > 400) {
      keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
      for (const k of keys.slice(0, keys.length - 400)) delete cache[k];
    }
    if (need.length) chrome.storage.local.set({ [TK.meta]: cache }).catch(() => {});
    return cache;
  }

  const cardToVideo = (c) => ({ id: c.id, title: c.title, channel: c.channel, channelUrl: c.channelUrl, durationSec: c.durationSec, short: c.short, live: c.live, upcoming: c.upcoming, mix: c.mix, lang: c.lang });

  /** История → записи профиля (свежие первыми); у первых 12 с высокой долей просмотра подтягиваются описание и ключевые слова. */
  async function historyForProfile(hist) {
    const list = hist.videos.map((v) => ({ id: v.id, title: v.title || '', channel: v.channel || '', channelUrl: v.channelUrl || '', durationSec: R.durationToSec(v.duration), progress: v.progress, short: !!v.short, lang: R.scriptLang(v.title || '') }));
    const sample = list.filter((v) => !(v.progress < 40)).slice(0, 12).map((v) => v.id);
    const meta = await metaFor(sample, 'taste.studying');
    for (const v of list) {
      const m = meta[v.id];
      if (m) {
        v.keywords = m.kw;
        v.desc = m.d;
      }
    }
    return list;
  }

  async function runTaste(useAi) {
    if (TASTE.busy) return;
    const hist = await loadTasteHistory();
    if (!hist) {
      TASTE.message = 'noHistory';
      return tasteBump();
    }
    TASTE.busy = true;
    TASTE.cancel = false;
    TASTE.results = null;
    TASTE.message = '';
    TASTE.label = tr('taste.loadingFeed');
    tasteBump();
    try {
      if (stats.cards.length < 40 && scope() !== 'related') await loadFeed({ rounds: 6 });
      const fb = await storeGet(TK.fb, { banned: [], liked: [] });
      const profile = T.buildProfile(await historyForProfile(hist));
      const cands = stats.cards.filter((c) => !(c.el && c.el.hasAttribute('data-yfs-hide'))).map(cardToVideo);
      const count = TASTE.count;
      const short = T.rank(cands, profile, { limit: Math.min(24, count * 3), banned: { channels: new Set(fb.banned) }, liked: { channels: new Set(fb.liked) } });
      let picks = short.slice(0, count);
      const byId = new Map(stats.cards.map((c) => [c.id, c]));
      let why = new Map();
      if (useAi && short.length) {
        const meta = await metaFor(short.slice(0, 14).map((s) => s.video.id), 'taste.reading');
        TASTE.label = tr('taste.asking');
        renderTasteLabel();
        const ai = (await storeGet('yfs_ai', {})) || {};
        if (!ai.key) TASTE.message = 'noKey';
        else {
          try {
            const out = await W.ai('yfs:ai-taste', {
              key: ai.key,
              model: ai.model || '',
              models: ai.models || [],
              profile: T.summarize(profile),
              candidates: short.map((s) => ({ id: s.video.id, title: s.video.title, channel: s.video.channel, minutes: Math.round((s.video.durationSec || 0) / 60), desc: (meta[s.video.id] || {}).d || '' })),
              count,
              language: YFS.ai.languageName(YFS.i18n.info()),
            });
            const order = new Map(out.picks.map((p) => [p.id, p.why]));
            picks = out.picks.map((p) => short.find((s) => s.video.id === p.id)).filter(Boolean);
            why = order;
          } catch (err) {
            TASTE.message = err.code === 'ai-no-key' ? 'noKey' : 'aiFailed';
          }
        }
      }
      const meta = await metaFor(picks.map((p) => p.video.id), 'taste.reading');
      TASTE.results = picks.map((p) => ({ ...p, card: byId.get(p.video.id), desc: (meta[p.video.id] || {}).d || '', why: why.get(p.video.id) || '' }));
      TASTE.summary = T.summarize(profile, 6);
      if (!TASTE.results.length) TASTE.message = TASTE.message || 'empty';
    } catch (err) {
      TASTE.message = 'failed';
    } finally {
      TASTE.busy = false;
      TASTE.label = '';
      tasteBump();
    }
  }

  /** Собрать историю (100 роликов) отдельным сбором и вернуться на эту страницу: подборка запустится сама. */
  async function collectTasteHistory() {
    if (!confirm(tr('taste.collectConfirm'))) return;
    await chrome.storage.local.set({ [TK.pending]: { at: Date.now(), count: TASTE.count, scope: scope() } });
    chrome.runtime.sendMessage({ type: 'yfs:start', options: { sources: { history: 'last100' }, filters: {}, author: '', lang: YFS.i18n.lang, target: 'taste', returnUrl: location.href } });
    toast(tr('taste.collecting'));
  }

  /** После возврата со страницы истории: если сбор был запущен отсюда — открыть «Для вас» и подобрать. */
  async function resumeTaste() {
    const p = await storeGet(TK.pending, null);
    if (!p || Date.now() - p.at > 15 * 60000) return;
    const h = await loadTasteHistory();
    if (!h || (h.collectedAt || 0) < p.at) return;
    await chrome.storage.local.remove(TK.pending);
    TASTE.count = p.count || 3;
    for (let i = 0; i < 40 && stats.cards.length < 8; i++) await sleep(250); // карточки ленты появляются не сразу
    openGroups(null, STAR);
    runTaste(false);
  }

  async function tasteFeedback(res, kind) {
    const fb = await storeGet(TK.fb, { banned: [], liked: [] });
    const key = T.chKey(res.video);
    if (kind === 'down') {
      fb.banned = [...new Set([...fb.banned, key])].slice(-200);
      TASTE.results = (TASTE.results || []).filter((r) => r !== res);
      toast(tr('taste.banned'));
    } else {
      fb.liked = [...new Set([...fb.liked, key])].slice(-200);
      toast(tr('taste.liked'));
    }
    await chrome.storage.local.set({ [TK.fb]: fb });
    tasteBump();
  }

  function renderTasteLabel() {
    if (ui && ui.tasteLabel) ui.tasteLabel.textContent = TASTE.label;
  }

  function reasonText(r) {
    const parts = [];
    if (r.reasons.channel) parts.push(tr('taste.sameChannel', { name: r.reasons.channel.name, n: r.reasons.channel.count }));
    if (r.reasons.terms.length) parts.push(tr('taste.topics', { list: r.reasons.terms.join(', ') }));
    return parts.join(' · ');
  }

  function pickEl(r) {
    const c = r.card || r.video;
    const href = c.href || `/watch?v=${c.id}`;
    const open = (ev) => {
      if (ev && (ev.button || ev.ctrlKey || ev.metaKey || ev.shiftKey)) return;
      if (ev) ev.preventDefault();
      if (r.card) openCard(r.card);
      else location.assign(href);
    };
    const th = el('a', { className: 'th', href, title: c.title }, el('img', { src: `https://i.ytimg.com/vi/${c.id}/mqdefault.jpg`, loading: 'lazy', alt: '' }));
    if (c.durationSec) th.append(el('i', {}, fmtTime(c.durationSec)));
    th.addEventListener('click', open);
    const title = el('a', { className: 'pt', href }, c.title);
    title.addEventListener('click', open);
    const watch = el('button', { className: 'chip on', type: 'button' }, '▶ ' + tr('taste.open'));
    watch.addEventListener('click', () => open());
    const more = el('button', { className: 'chip', type: 'button', title: tr('taste.more') }, '👍');
    more.addEventListener('click', () => tasteFeedback(r, 'up'));
    const less = el('button', { className: 'chip', type: 'button', title: tr('taste.less') }, '👎');
    less.addEventListener('click', () => tasteFeedback(r, 'down'));
    return el(
      'article',
      { className: 'pick' },
      th,
      el(
        'div',
        { className: 'pb' },
        title,
        el('div', { className: 'pm' }, [c.channel, c.durationSec ? fmtTime(c.durationSec) : ''].filter(Boolean).join(' · ')),
        r.why ? el('p', { className: 'why' }, '✨ ' + r.why) : null,
        r.desc ? el('p', { className: 'desc' }, r.desc) : el('p', { className: 'desc dim' }, tr('taste.noDesc')),
        el('p', { className: 'rs' }, reasonText(r)),
        el('div', { className: 'pa' }, watch, more, less)
      )
    );
  }

  const put = (box, ...kids) => box.append(...kids.filter(Boolean));

  function renderTasteMain(box) {
    const hist = TASTE.hist;
    const counts = el('div', { className: 'chips' }, ...[1, 3, 5, 10].map((n) => chip(String(n), TASTE.count === n, () => ((TASTE.count = n), tasteBump()))));
    const run = el('button', { className: 'wide primary', type: 'button', disabled: TASTE.busy || !hist }, '⭐ ' + tr('taste.run'));
    run.addEventListener('click', () => runTaste(false));
    const ai = el('button', { className: 'wide', type: 'button', disabled: TASTE.busy || !hist, title: tr('taste.aiHint') }, '✨ ' + tr('taste.ai'));
    ai.addEventListener('click', () => runTaste(true));
    const stop = el('button', { className: 'chip', type: 'button' }, tr('filter.stop'));
    stop.addEventListener('click', () => (TASTE.cancel = true));
    ui.tasteLabel = el('span', {}, TASTE.label);
    const histLine = hist
      ? el('p', { className: 'hint' }, tr('taste.history', { n: hist.videos.length, when: ageLabel((Date.now() - (hist.collectedAt || 0)) / 1000) || '—' }), ' ', el('button', { className: 'link', type: 'button', onclick: collectTasteHistory }, tr('taste.refresh')))
      : el('div', { className: 'tbox' }, el('p', {}, tr('taste.noHistory')), el('button', { className: 'wide primary', type: 'button', onclick: collectTasteHistory }, '👁 ' + tr('taste.collect')));
    put(
      box,
      el('div', { className: 'tp' }, el('h3', {}, '⭐ ' + tr('taste.title')), el('p', { className: 'hint' }, tr('taste.intro')), histLine, hist ? el('div', { className: 'tctl' }, el('span', { className: 'hint' }, tr('taste.count')), counts, run, ai) : null),
      TASTE.busy ? el('div', { className: 'tbox row' }, ui.tasteLabel, stop) : null,
      TASTE.message ? el('p', { className: 'tbox warn' }, tr('taste.msg.' + TASTE.message)) : null,
      TASTE.results && TASTE.results.length ? el('p', { className: 'hint' }, tr('taste.profile', { topics: (TASTE.summary.terms || []).join(', '), channels: (TASTE.summary.channels || []).map((c) => c.name).slice(0, 4).join(', ') || '—' })) : null,
      ...(TASTE.results || []).map(pickEl)
    );
  }

  // ---------- 🗂 экран групп: слева группы, справа ролики ----------

  function renderGroups(force) {
    if (!ui) {
      lockPage(false);
      return;
    }
    ui.groups.hidden = !groupOpen;
    lockPage(groupOpen);
    if (!groupOpen) {
      groupSig = '';
      return;
    }
    const by = rules.groupBy === 'none' ? 'channel' : rules.groupBy;
    const cards = stats.cards.filter((c) => !(c.el && c.el.hasAttribute('data-yfs-hide')));
    const groups = R.groupCards(cards, by);
    if (selGroup !== STAR && !groups.some((g) => g.key === selGroup)) selGroup = groups.length ? groups[0].key : STAR;
    const sig = [by, selGroup, cards.map((c) => c.id).join(','), job ? `${job.total}/${job.music}` : '', YFS.i18n.lang, TASTE.ver].join('|');
    if (!force && sig === groupSig) return;
    groupSig = sig;

    // верхняя полоса: способ группировки, подгрузка, закрыть
    const bar = ui.gbar;
    bar.replaceChildren(el('h3', {}, tr('filter.groupTitle', { n: cards.length })));
    for (const g of R.GROUPS.filter((x) => x !== 'none')) {
      bar.append(
        chip(tr('filter.group.' + g), by === g, () => {
          selGroup = '';
          save({ groupBy: g });
          renderGroups(true);
        })
      );
    }
    bar.append(el('span', { className: 'sp' }));
    const more = el('button', { className: 'chip', type: 'button', disabled: !!job }, '🔎 ' + tr('filter.loadMore'));
    more.addEventListener('click', () => loadFeed({ rounds: 8 }));
    const close = el('button', { className: 'chip', type: 'button', 'aria-label': tr('common.close') }, '✕');
    close.addEventListener('click', () => {
      groupOpen = false;
      renderGroups();
    });
    bar.append(more, close);

    // левая панель: «Для вас» и список групп (прокручивается отдельно от правой)
    const sideTop = ui.gside.scrollTop;
    ui.gside.replaceChildren();
    const item = (key, label, n, cls) => {
      const b = el('button', { className: 'gi' + (cls ? ' ' + cls : '') + (selGroup === key ? ' on' : ''), type: 'button', 'aria-pressed': String(selGroup === key) }, el('b', { title: label }, label), n === undefined ? null : el('span', { className: 'n' }, String(n)));
      b.addEventListener('click', async () => {
        selGroup = key;
        ui.gmain.scrollTop = 0;
        if (key === STAR) await loadTasteHistory();
        renderGroups(true);
      });
      ui.gside.append(b);
    };
    item(STAR, '⭐ ' + tr('taste.groupName'), TASTE.results ? TASTE.results.length : undefined, 'star');
    for (const g of groups) item(g.key, groupName(g), g.cards.length);
    ui.gside.scrollTop = sideTop;

    // правая панель
    const keep = ui.gmain.scrollTop;
    ui.gmain.replaceChildren();
    if (selGroup === STAR) {
      renderTasteMain(ui.gmain);
      ui.gmain.scrollTop = keep;
      return;
    }
    const g = groups.find((x) => x.key === selGroup);
    if (!g) {
      ui.gmain.append(el('p', { className: 'hint', style: 'padding:24px 4px' }, tr('filter.groupEmpty')));
      return;
    }
    const tracks = g.cards.filter((c) => c.music >= 0.5);
    const top = el('div', { className: 'gtop' }, el('b', {}, groupName(g)), el('span', { className: 'n' }, String(g.cards.length)), el('span', { className: 'sp' }));
    if (tracks.length >= 2) {
      const play = el('button', { className: 'chip', type: 'button', title: tr('filter.groupPlay') }, `▶ ${tracks.length}`);
      play.addEventListener('click', () => playIds(tracks.map((c) => c.id), tracks));
      top.append(play);
    }
    if (g.channelUrl) top.append(el('a', { className: 'chip', href: g.channelUrl, title: tr('filter.openChannel'), textContent: '↗' }));
    ui.gmain.append(top, el('div', { className: 'gg' }, ...g.cards.map(groupCardEl)));
    ui.gmain.scrollTop = keep;
  }

  function openGroups(by, sel) {
    if (by && by !== 'none') save({ groupBy: by, enabled: true });
    else if (!rules.enabled) save({ enabled: true });
    if (rules.groupBy === 'none') save({ groupBy: 'channel' });
    if (sel) selGroup = sel;
    groupOpen = true;
    panelOpen = false;
    renderPanel();
    if (sel === STAR) loadTasteHistory().then(() => renderGroups(true));
    // Карточки собираются на следующем проходе — экран покажем сразу и дорисуем.
    schedule();
    renderGroups(true);
  }

  /** Команды из popup расширения: открыть панель, группы, подборку по вкусу, поиск музыки. */
  function feedAction(action) {
    if (!ui) return false;
    if (action === 'panel') {
      panelOpen = true;
      renderPanel();
    } else if (action === 'groups') openGroups();
    else if (action === 'taste') openGroups(null, STAR);
    else if (action === 'music') return collectMusic();
    return true;
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'yfs:feed-action' || sender.id !== chrome.runtime.id) return;
      Promise.resolve(feedAction(msg.action)).then(
        () => sendResponse({ ok: !!ui }),
        () => sendResponse({ ok: false })
      );
      return true;
    });
  } catch {
    /* расширение перезагрузили */
  }

  // ---------- кнопка и панель ----------
  //
  // Кнопка 🎛 перетаскивается мышью в любое место; после отпускания прилипает к ближайшему краю (лево / право),
  // положение запоминается (yfs_feedui). Панель открывается от кнопки к центру экрана или — если выбрано —
  // выезжает сбоку на всю высоту. Внутри — вкладки: Скрыть · Группы · Музыка · Каналы.

  const UI_KEY = 'yfs_feedui';
  const TABS = [
    ['hide', '🧹'],
    ['groups', '🗂'],
    ['music', '🎵'],
    ['people', '👤'],
  ];
  let view = { side: 'right', y: 0.92, tab: 'hide', drawer: true, drawerSet: 2 };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    button { font: inherit; color: inherit; }
    :focus-visible { outline: 2px solid #3ea6ff; outline-offset: 2px; }
    .wrap { position: fixed; z-index: 2140; font: 13px/1.4 Roboto, Arial, sans-serif; color: var(--text); touch-action: none; }
    .fab { position: relative; display: grid; place-items: center; width: 48px; height: 48px; border: 1px solid var(--border); border-radius: 50%;
      background: var(--bg-elev); font-size: 21px; box-shadow: 0 4px 16px #0005; cursor: grab; transition: transform .15s, box-shadow .15s; }
    .fab:hover { transform: scale(1.06); box-shadow: 0 6px 22px #0007; }
    .wrap.drag .fab { cursor: grabbing; transform: scale(1.1); box-shadow: 0 10px 30px #0009; }
    .fab.on::after { content: ''; position: absolute; inset: -3px; border: 2px solid var(--accent); border-radius: 50%; }
    .count { position: absolute; top: -5px; right: -5px; z-index: 1; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: var(--accent);
      color: #fff; font-size: 11px; font-weight: 600; line-height: 20px; text-align: center; }
    .count[hidden] { display: none; }
    .box { position: fixed; z-index: 2145; display: flex; flex-direction: column; width: min(380px, calc(100vw - 24px)); overflow: hidden;
      border: 1px solid var(--border); border-radius: 16px; background: var(--bg-elev); color: var(--text); box-shadow: 0 12px 40px #0008;
      font: 13px/1.4 Roboto, Arial, sans-serif; animation: pop .14s ease-out; }
    .box.drawer { top: 56px !important; bottom: 0 !important; right: 0 !important; left: auto !important; max-height: none !important; height: auto;
      width: min(400px, 100vw); border-radius: 16px 0 0 0; animation: slide .18s ease-out; }
    .box[hidden] { display: none; }
    @keyframes pop { from { opacity: 0; transform: scale(.97); } }
    @media (prefers-reduced-motion: reduce) { .box, .box.drawer { animation: none; } .fab { transition: none; } }
    @keyframes slide { from { transform: translateX(24px); opacity: 0; } }
    .head { display: flex; align-items: center; gap: 6px; padding: 12px 12px 8px 16px; }
    .head b { flex: 1; font-size: 15px; font-weight: 600; }
    .ib { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 50%; background: transparent; color: var(--text-2); cursor: pointer; }
    .ib:hover { background: var(--chip); color: var(--text); }
    .stat { margin: 0 16px 8px; color: var(--text-2); font-size: 12px; }
    .tabs { display: flex; gap: 2px; margin: 0 12px; padding: 3px; border-radius: 12px; background: var(--chip); }
    .tab { display: flex; flex: 1; align-items: center; justify-content: center; gap: 5px; height: 32px; padding: 0 6px; border: 0; border-radius: 9px;
      background: transparent; color: var(--text-2); font-size: 12px; font-weight: 500; white-space: nowrap; cursor: pointer; }
    .tab:hover { color: var(--text); }
    .tab[aria-selected='true'] { background: var(--bg-elev); color: var(--text); box-shadow: 0 1px 3px #0003; }
    .content { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 16px 16px; overscroll-behavior: contain; scrollbar-width: thin; }
    .foot { padding: 8px 16px 12px; border-top: 1px solid var(--border); color: var(--text-2); font-size: 11px; }
    h4 { margin: 14px 0 7px; color: var(--text-2); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: 15px; background: transparent;
      color: var(--text); font-size: 12px; cursor: pointer; text-decoration: none; }
    .chip:hover { background: var(--chip); }
    .chip.on { border-color: transparent; background: var(--text); color: var(--bg); font-weight: 500; }
    .chip:disabled { opacity: .45; cursor: default; }
    .chip .n { margin-left: 5px; opacity: .6; font-variant-numeric: tabular-nums; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    input[type=number], input[type=text], select { height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: 9px; background: transparent;
      color: var(--text); font: inherit; }
    select { width: 100%; }
    select option { background: var(--bg-elev); }
    input[type=number] { width: 70px; }
    input[type=text] { flex: 1; min-width: 0; }
    .hint { margin: 6px 0 0; color: var(--text-2); font-size: 12px; line-height: 1.4; }
    .wide { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 38px; margin-top: 10px; border: 0; border-radius: 19px;
      background: var(--chip); color: var(--text); font-weight: 500; cursor: pointer; }
    .wide:hover { background: var(--chip-hover); }
    .wide.primary { background: var(--text); color: var(--bg); }
    .wide.primary:hover { opacity: .9; }
    .wide:disabled { opacity: .45; cursor: default; }
    ul { margin: 0; padding: 0; list-style: none; }
    li { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 8px; border-radius: 8px; }
    li:hover { background: var(--chip); }
    li .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li.off .nm { color: var(--text-2); text-decoration: line-through; }
    li .c { color: var(--text-2); font-variant-numeric: tabular-nums; }
    .x { width: 28px; height: 28px; border: 0; border-radius: 50%; background: transparent; color: var(--text-2); cursor: pointer; }
    .x:hover { background: var(--chip-hover); color: var(--text); }
    .switch { appearance: none; position: relative; flex: 0 0 auto; width: 38px; height: 22px; margin: 0; border-radius: 11px; background: var(--chip-hover); cursor: pointer; transition: background .15s; }
    .switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px #0005; transition: transform .15s; }
    .switch:checked { background: var(--accent); }
    .switch:checked::after { transform: translateX(16px); }
    .toast { position: fixed; left: 50%; bottom: 24px; z-index: 2300; transform: translateX(-50%); padding: 10px 16px; border-radius: 10px; background: #f1f1f1; color: #0f0f0f;
      box-shadow: 0 4px 16px #0006; font: 13px Roboto, Arial, sans-serif; }
    .toast[hidden] { display: none; }
    .status { position: fixed; left: 50%; bottom: 24px; z-index: 2300; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 16px;
      border-radius: 24px; background: #212121; color: #fff; box-shadow: 0 4px 20px #0008; font: 13px Roboto, Arial, sans-serif; }
    .status[hidden] { display: none; }
    .status .chip { border-color: transparent; background: #ffffff2b; color: #fff; }
    .groups { position: fixed; left: 0; right: 0; top: 56px; bottom: 0; z-index: 2130; display: flex; flex-direction: column; background: var(--bg); color: var(--text);
      font: 14px/1.4 Roboto, Arial, sans-serif; }
    .groups[hidden] { display: none; }
    .gbar { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
    .gbar h3 { margin: 0 10px 0 0; font-size: 17px; font-weight: 600; }
    .sp { flex: 1; }
    .gsplit { display: flex; flex: 1; min-height: 0; }
    .gside { display: flex; flex: 0 0 300px; flex-direction: column; gap: 2px; padding: 8px; overflow-y: auto; overscroll-behavior: contain; border-right: 1px solid var(--border); scrollbar-width: thin; }
    .gi { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px; border: 0; border-radius: 10px; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
    .gi:hover { background: var(--chip); }
    .gi.on { background: var(--text); color: var(--bg); font-weight: 600; }
    .gi b { flex: 1; min-width: 0; overflow: hidden; font-weight: inherit; text-overflow: ellipsis; white-space: nowrap; }
    .gi .n, .gtop .n { padding: 0 8px; border-radius: 10px; background: var(--chip-hover); font-size: 12px; font-weight: 500; }
    .gi.star { margin-bottom: 6px; border: 1px dashed var(--border); }
    .gmain { flex: 1; min-width: 0; padding: 0 16px 56px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
    .gtop { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--border); background: var(--bg); font-size: 16px; }
    .gg { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 18px 12px; padding: 14px 0 22px; }
    .tp { padding-top: 14px; }
    .tp h3 { margin: 0 0 4px; font-size: 18px; }
    .tctl { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 10px 0 4px; }
    .tctl .wide { width: auto; margin: 0; padding: 0 18px; }
    .tbox { margin: 12px 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; }
    .tbox.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .tbox.warn { border-color: #b26a00; color: var(--text); background: #b26a0014; }
    .link { padding: 0; border: 0; background: none; color: #3ea6ff; font: inherit; cursor: pointer; text-decoration: underline; }
    .pick { display: grid; grid-template-columns: 240px 1fr; gap: 16px; margin: 14px 0; padding: 12px; border: 1px solid var(--border); border-radius: 14px; }
    .pick .th { position: relative; display: block; align-self: start; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 10px; background: var(--chip); }
    .pick .th img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .pick .th i { position: absolute; right: 6px; bottom: 6px; padding: 1px 5px; border-radius: 4px; background: #000c; color: #fff; font-style: normal; font-size: 12px; }
    .pick .pt { color: var(--text); font-size: 16px; font-weight: 600; line-height: 1.3; text-decoration: none; }
    .pick .pt:hover { text-decoration: underline; }
    .pick .pm, .pick .rs { color: var(--text-2); font-size: 12px; }
    .pick p { margin: 6px 0 0; }
    .pick .why { color: var(--text); }
    .pick .desc.dim { color: var(--text-2); font-style: italic; }
    .pick .pa { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    @media (max-width: 760px) {
      .gsplit { flex-direction: column; }
      .gside { flex: 0 0 auto; flex-direction: row; flex-wrap: nowrap; max-height: none; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); }
      .gi { width: auto; flex: 0 0 auto; }
      .pick { grid-template-columns: 1fr; }
    }
    .gc { display: flex; flex-direction: column; gap: 6px; min-width: 0; color: var(--text); text-decoration: none; }
    .gc .th { position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 10px; background: var(--chip); }
    .gc img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .gc .th i { position: absolute; right: 6px; bottom: 6px; padding: 1px 5px; border-radius: 4px; background: #000c; color: #fff; font-style: normal; font-size: 12px; }
    .gc .th i.live { background: #cc0000; }
    .gc .t { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 14px; font-weight: 500; line-height: 1.3; }
    .gc:hover .t { text-decoration: underline; }
    .gc .m { color: var(--text-2); font-size: 12px; }
  `;

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

  function save(patch) {
    rules = R.normalizeRules({ ...rules, ...patch });
    try {
      chrome.storage.local.set({ [KEY]: rules });
    } catch {
      /* расширение перезагрузили */
    }
    refresh();
    renderPanel();
    if (groupOpen) scheduleGroups();
  }

  function saveView(patch) {
    view = { ...view, ...patch };
    W.store.set(UI_KEY, view);
  }

  let toastTimer = 0;
  function toast(text) {
    if (!ui) return;
    ui.toast.textContent = text;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (ui.toast.hidden = true), 2500);
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** Кнопка на своём месте: у левого или правого края, на запомненной высоте. */
  function placeFab() {
    if (!ui) return;
    const w = ui.wrap;
    const size = 48;
    w.style.top = `${Math.round(clamp(view.y, 0, 1) * (window.innerHeight - size - 80) + 64)}px`;
    w.style.left = view.side === 'left' ? '20px' : 'auto';
    w.style.right = view.side === 'left' ? 'auto' : '20px';
    if (panelOpen) placeBox();
  }

  /** Панель — от кнопки к центру экрана: справа кнопка — панель левее, внизу — панель выше. */
  function placeBox() {
    if (!ui || view.drawer) return;
    const r = ui.fab.getBoundingClientRect();
    const b = ui.box.style;
    b.left = b.right = b.top = b.bottom = 'auto';
    if (view.side === 'left') b.left = `${Math.round(r.left)}px`;
    else b.right = `${Math.round(window.innerWidth - r.right)}px`;
    const below = r.top < window.innerHeight / 2;
    if (below) b.top = `${Math.round(r.bottom + 10)}px`;
    else b.bottom = `${Math.round(window.innerHeight - r.top + 10)}px`;
    const room = below ? window.innerHeight - r.bottom - 22 : r.top - 66;
    b.maxHeight = `${Math.max(260, Math.min(680, room))}px`;
  }

  /** Перетаскивание кнопки: клик остаётся кликом, сдвиг больше 6 px — перенос. */
  function setupDrag() {
    const { fab, wrap } = ui;
    let start = null;
    let moved = false;
    let swallow = false;
    fab.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      const r = wrap.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      moved = false;
      fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      moved = true;
      wrap.classList.add('drag');
      wrap.style.right = 'auto';
      wrap.style.left = `${Math.round(clamp(start.left + dx, 4, window.innerWidth - 52))}px`;
      wrap.style.top = `${Math.round(clamp(start.top + dy, 60, window.innerHeight - 52))}px`;
      if (panelOpen) (panelOpen = false), renderPanel();
    });
    const end = () => {
      if (!start) return;
      start = null;
      wrap.classList.remove('drag');
      if (!moved) return;
      swallow = true; // клик после переноса не открывает панель
      const r = wrap.getBoundingClientRect();
      saveView({ side: r.left + r.width / 2 < window.innerWidth / 2 ? 'left' : 'right', y: clamp((r.top - 64) / Math.max(1, window.innerHeight - 48 - 80), 0, 1) });
      placeFab();
    };
    fab.addEventListener('pointerup', end);
    fab.addEventListener('pointercancel', end);
    fab.addEventListener('click', () => {
      if (swallow) {
        swallow = false;
        return;
      }
      panelOpen = !panelOpen;
      renderPanel();
    });
  }

  function ensureUi() {
    const show = !!scope();
    if (!show) {
      if (ui) ui.host.remove(), (ui = null), (panelOpen = false), (groupOpen = false), lockPage(false);
      return;
    }
    if (ui && ui.host.isConnected) return;
    const host = document.createElement('div');
    host.id = 'yfs-feed-filter';
    host.dataset.v = W.VERSION;
    const root = host.attachShadow({ mode: 'open' });
    const fab = el('button', { className: 'fab', type: 'button', title: tr('filter.fabHint'), 'aria-label': tr('filter.title') }, '🎛');
    const count = el('span', { className: 'count', hidden: true });
    fab.append(count);
    const box = el('div', { className: 'box', hidden: true, role: 'dialog', 'aria-label': tr('filter.title') });
    const t = el('div', { className: 'toast', hidden: true });
    const statusText = el('span', {});
    const stop = el('button', { className: 'chip', type: 'button' }, tr('filter.stop'));
    stop.addEventListener('click', () => {
      cancelAll = true;
      if (job) job.cancelled = true;
    });
    const status = el('div', { className: 'status', hidden: true, role: 'status' }, statusText, stop);
    const gbar = el('div', { className: 'gbar' });
    const gside = el('nav', { className: 'gside', 'aria-label': tr('filter.group') });
    const gmain = el('div', { className: 'gmain' });
    const gbody = el('div', { className: 'gsplit' }, gside, gmain);
    const groups = el('div', { className: 'groups', hidden: true, role: 'dialog', 'aria-label': tr('filter.group') }, gbar, gbody);
    for (const type of ['keydown', 'keyup', 'keypress']) groups.addEventListener(type, (e) => e.stopPropagation());
    // Клавиши и колесо внутри панели — не YouTube (иначе пробел ставит паузу, а / уводит в поиск).
    for (const type of ['keydown', 'keyup', 'keypress', 'wheel']) box.addEventListener(type, (e) => e.stopPropagation());
    box.addEventListener('keydown', (e) => e.key === 'Escape' && ((panelOpen = false), renderPanel(), fab.focus()));
    const wrap = el('div', { className: 'wrap' }, fab);
    root.append(el('style', { textContent: W.BASE_CSS + CSS }), groups, box, wrap, t, status);
    (document.body || document.documentElement).append(host);
    ui = { host, root, fab, count, box, wrap, toast: t, status, statusText, groups, gbar, gbody, gside, gmain, tasteLabel: null };
    setupDrag();
    placeFab();
    renderButton();
  }

  function renderButton() {
    if (!ui) return;
    ui.host.toggleAttribute('dark', document.documentElement.hasAttribute('dark'));
    ui.fab.classList.toggle('on', active());
    ui.count.hidden = !(active() && stats.hidden);
    ui.count.textContent = String(stats.hidden);
  }

  function chip(label, on, onClick, count) {
    const b = el('button', { className: 'chip' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(!!on) }, label, count ? el('span', { className: 'n' }, String(count)) : null);
    b.addEventListener('click', onClick);
    return b;
  }

  const langName = (code) => {
    if (code === 'latin') return tr('filter.latin');
    try {
      const name = new Intl.DisplayNames([YFS.i18n.locale()], { type: 'language' }).of(code) || code;
      return name.charAt(0).toLocaleUpperCase(YFS.i18n.locale()) + name.slice(1);
    } catch {
      return code;
    }
  };

  function wordsEditor(field, placeholder) {
    const input = el('input', { type: 'text', placeholder });
    const add = () => {
      const words = input.value.split(',').map((w) => w.trim()).filter(Boolean);
      if (!words.length) return;
      input.value = '';
      input.blur();
      save({ [field]: [...rules[field], ...words] });
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
    const list = el('div', { className: 'chips', style: 'margin-top:6px' });
    for (const w of rules[field]) list.append(chip(w + '  ✕', true, () => save({ [field]: rules[field].filter((x) => x !== w) })));
    return [el('div', { className: 'row' }, input, chip('+', false, add)), list];
  }

  // ---------- вкладки панели ----------

  function tabHide(box, summary) {
    box.append(
      el('h4', {}, tr('filter.hide')),
      el(
        'div',
        { className: 'chips' },
        chip(tr('filter.shorts'), rules.hideShorts, () => save({ hideShorts: !rules.hideShorts })),
        chip(tr('filter.live'), rules.hideLive, () => save({ hideLive: !rules.hideLive })),
        chip(tr('filter.upcoming'), rules.hideUpcoming, () => save({ hideUpcoming: !rules.hideUpcoming })),
        chip(tr('filter.watched'), rules.hideWatched, () => save({ hideWatched: !rules.hideWatched })),
        chip(tr('filter.mixes'), rules.hideMixes, () => save({ hideMixes: !rules.hideMixes }))
      )
    );
    const min = el('input', { type: 'number', min: 0, max: 600, value: rules.minMin || '', placeholder: '0', 'aria-label': tr('filter.from') });
    const max = el('input', { type: 'number', min: 0, max: 600, value: rules.maxMin || '', placeholder: '∞', 'aria-label': tr('filter.to') });
    const applyRange = () => save({ minMin: Number(min.value) || 0, maxMin: Number(max.value) || 0 });
    min.addEventListener('change', applyRange);
    max.addEventListener('change', applyRange);
    const preset = (label, a, b) => chip(label, rules.minMin === a && rules.maxMin === b, () => save({ minMin: a, maxMin: b }));
    box.append(
      el('h4', {}, tr('filter.duration')),
      el('div', { className: 'chips' }, preset(tr('filter.any'), 0, 0), preset('< 4', 0, 4), preset('4–20', 4, 20), preset('> 20', 20, 0), preset('> 60', 60, 0)),
      el('div', { className: 'row', style: 'margin-top:8px' }, tr('filter.from'), min, tr('filter.to'), max, tr('filter.minutes'))
    );
    if (summary.langs.length) {
      box.append(
        el('h4', {}, tr('filter.language')),
        el(
          'div',
          { className: 'chips' },
          ...summary.langs.map((l) =>
            chip(langName(l.code), rules.langs.includes(l.code), () => save({ langs: rules.langs.includes(l.code) ? rules.langs.filter((x) => x !== l.code) : [...rules.langs, l.code] }), l.count)
          ),
          rules.langs.length ? chip(tr('filter.anyLang'), false, () => save({ langs: [] })) : null
        ),
        el('p', { className: 'hint' }, tr('filter.langHint'))
      );
    }
    const sort = el('select', { 'aria-label': tr('filter.sort') });
    for (const s of R.SORTS) sort.append(el('option', { value: s, selected: rules.sort === s }, tr('filter.sort.' + s)));
    sort.addEventListener('change', () => save({ sort: sort.value }));
    box.append(el('h4', {}, tr('filter.sort')), sort, el('p', { className: 'hint' }, tr('filter.sortHint')));
    box.append(
      el('h4', {}, tr('filter.where')),
      el(
        'div',
        { className: 'chips' },
        ...['home', 'subs', 'search', 'related'].map((s) => chip(tr('filter.scope.' + s), rules.scopes[s], () => save({ scopes: { ...rules.scopes, [s]: !rules.scopes[s] } })))
      )
    );
  }

  function tabGroups(box) {
    const show = el('button', { className: 'wide primary', type: 'button' }, '🗂 ' + tr('filter.groupShow'));
    show.addEventListener('click', () => openGroups());
    box.append(
      el('h4', {}, tr('filter.group')),
      el(
        'div',
        { className: 'chips' },
        ...R.GROUPS.filter((g) => g !== 'none').map((g) =>
          chip(tr('filter.group.' + g), rules.groupBy === g, () => {
            if (rules.groupBy === g && groupOpen) {
              groupOpen = false;
              renderGroups();
              renderPanel();
            } else openGroups(g);
          })
        )
      ),
      show,
      el('p', { className: 'hint' }, tr('filter.groupHint')),
      el('h4', {}, tr('taste.title')),
      (() => {
        const b = el('button', { className: 'wide', type: 'button' }, '⭐ ' + tr('taste.run'));
        b.addEventListener('click', () => openGroups(null, STAR));
        return b;
      })(),
      el('p', { className: 'hint' }, tr('taste.panelHint'))
    );
  }

  function tabMusic(box, sc) {
    const music = found && found.scope === sc ? found.tracks.size : visibleMusic();
    const play = el('button', { className: 'wide primary', type: 'button', disabled: !!job || (music < 2 && sc === 'related' && !stats.cards.length) }, tr('filter.playMusic', { n: music }));
    play.addEventListener('click', playMusic);
    const find = el('button', { className: 'wide', type: 'button', disabled: !!job || sc === 'related' }, '🔎 ' + tr('filter.findMusic'));
    find.addEventListener('click', async () => {
      const r = await collectMusic();
      if (r) toast(tr('filter.foundMusic', { n: r.tracks.size, mixes: r.mixes.size }));
    });
    box.append(
      el('div', { className: 'chips', style: 'margin-top:12px' }, chip(tr('filter.onlyMusic'), rules.onlyMusic, () => save({ onlyMusic: !rules.onlyMusic })), chip(tr('filter.expandMixes'), rules.expandMixes, () => save({ expandMixes: !rules.expandMixes }))),
      find,
      el('p', { className: 'hint' }, tr('filter.findMusicHint')),
      el('h4', {}, tr('filter.shuffle')),
      el('div', { className: 'chips' }, ...R.SHUFFLES.map((m) => chip(tr('filter.shuffle.' + m), rules.shuffle === m, () => save({ shuffle: m })))),
      play
    );
  }

  function tabPeople(box, summary) {
    const blocked = rules.blockChannels;
    const list = el('ul');
    const seen = new Set();
    for (const c of summary.channels.slice(0, 40)) {
      seen.add(c.key);
      const off = Object.prototype.hasOwnProperty.call(blocked, c.key);
      const b = el('button', { className: 'x', type: 'button', title: off ? tr('filter.unblock') : tr('filter.block'), 'aria-label': off ? tr('filter.unblock') : tr('filter.block') }, off ? '↺' : '🚫');
      b.addEventListener('click', () => {
        const next = { ...blocked };
        if (off) delete next[c.key];
        else next[c.key] = c.name;
        save({ blockChannels: next });
      });
      list.append(el('li', { className: off ? 'off' : '' }, el('span', { className: 'nm', title: c.name }, c.name), el('span', { className: 'c' }, String(c.count)), b));
    }
    for (const [key, name] of Object.entries(blocked)) {
      if (seen.has(key)) continue;
      const b = el('button', { className: 'x', type: 'button', title: tr('filter.unblock'), 'aria-label': tr('filter.unblock') }, '↺');
      b.addEventListener('click', () => {
        const next = { ...blocked };
        delete next[key];
        save({ blockChannels: next });
      });
      list.append(el('li', { className: 'off' }, el('span', { className: 'nm', title: name }, name), b));
    }
    box.append(el('h4', {}, tr('filter.channels')), list.children.length ? list : el('p', { className: 'hint' }, tr('filter.noChannels')));
    box.append(el('h4', {}, tr('filter.blockWords')), ...wordsEditor('blockWords', tr('filter.wordsPh')));
    box.append(el('h4', {}, tr('filter.onlyWords')), ...wordsEditor('onlyWords', tr('filter.wordsPh')));
  }

  function renderPanel() {
    if (!ui) return;
    ui.box.hidden = !panelOpen;
    if (!panelOpen) return;
    // Не перерисовываем под руками, пока человек печатает в поле.
    const focused = ui.root.activeElement;
    if (focused && focused.tagName === 'INPUT' && focused.type !== 'checkbox') return;
    const box = ui.box;
    const keepScroll = box.querySelector('.content') ? box.querySelector('.content').scrollTop : 0;
    box.classList.toggle('drawer', !!view.drawer);
    placeBox();
    const sc = scope();
    const sw = el('input', { type: 'checkbox', className: 'switch', checked: rules.enabled, 'aria-label': tr('filter.enabled'), title: tr('filter.enabled') });
    sw.addEventListener('change', () => save({ enabled: sw.checked }));
    const layout = el('button', { className: 'ib', type: 'button', title: tr(view.drawer ? 'filter.layoutPopover' : 'filter.layoutDrawer'), 'aria-label': tr(view.drawer ? 'filter.layoutPopover' : 'filter.layoutDrawer') }, view.drawer ? '◱' : '◨');
    layout.addEventListener('click', () => {
      saveView({ drawer: !view.drawer });
      renderPanel();
    });
    const close = el('button', { className: 'ib', type: 'button', title: tr('common.close'), 'aria-label': tr('common.close') }, '✕');
    close.addEventListener('click', () => {
      panelOpen = false;
      renderPanel();
    });
    const tabs = el('div', { className: 'tabs', role: 'tablist' });
    for (const [id, icon] of TABS) {
      const b = el('button', { className: 'tab', type: 'button', role: 'tab', 'aria-selected': String(view.tab === id), title: tr('filter.tab.' + id) }, icon, el('span', {}, tr('filter.tab.' + id)));
      b.addEventListener('click', () => {
        saveView({ tab: id });
        renderPanel();
      });
      tabs.append(b);
    }
    const content = el('div', { className: 'content', role: 'tabpanel' });
    const summary = R.summarize(stats.cards);
    if (view.tab === 'groups') tabGroups(content);
    else if (view.tab === 'music') tabMusic(content, sc);
    else if (view.tab === 'people') tabPeople(content, summary);
    else tabHide(content, summary);
    box.replaceChildren(
      el('div', { className: 'head' }, el('b', {}, tr('filter.title')), sw, layout, close),
      el('p', { className: 'stat' }, rules.enabled ? (rules.scopes[sc] ? tr('filter.stats', { hidden: stats.hidden, total: stats.total }) : tr('filter.scopeOff')) : tr('filter.off')),
      tabs,
      content,
      el('div', { className: 'foot' }, tr('filter.dragHint'))
    );
    content.scrollTop = keepScroll;
  }

  // ---------- запуск ----------

  async function load() {
    try {
      const v = await W.store.get(UI_KEY, null);
      if (v && typeof v === 'object') {
        view = { ...view, ...v, tab: TABS.some(([t]) => t === v.tab) ? v.tab : 'hide' };
        // Боковая панель на всю высоту — вид по умолчанию; у тех, кто был на старом, переключаем один раз.
        if (view.drawerSet !== 2) view = { ...view, drawer: true, drawerSet: 2 };
      }
    } catch {
      /* по умолчанию */
    }
    try {
      const d = await chrome.storage.local.get(KEY);
      rules = R.normalizeRules(d[KEY]);
    } catch {
      rules = R.normalizeRules();
    }
    refresh();
    loadTasteHistory();
    setTimeout(resumeTaste, 1500); // вернулись со страницы истории — подборка по вкусу продолжается сама
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) {
        rules = R.normalizeRules(changes[KEY].newValue);
        refresh();
        renderPanel();
      }
    });
  } catch {
    /* расширение перезагрузили */
  }
  window.addEventListener('resize', () => placeFab());
  document.addEventListener('yfs:lang-change', () => {
    if (!ui) return;
    ui.host.remove();
    ui = null;
    groupSig = '';
    ensureUi();
    renderPanel();
    renderGroups(true);
    renderStatus();
  });
  document.addEventListener('yt-navigate-finish', () => {
    panelOpen = false;
    groupOpen = false;
    renderGroups();
    refresh();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && groupOpen) {
        groupOpen = false;
        renderGroups();
      }
    },
    true
  );
  const stopLoop = YFS.loop.every(3000, () => {
    if (!W.alive()) {
      stopLoop();
      if (ui) ui.host.remove();
      lockPage(false);
      watchDom(false);
      clearAll();
      return;
    }
    ensureUi();
    renderButton();
  });
  YFS.i18n.init({ applyToPage: false }).then(load, load);

  YFS.feedFilter = {
    apply: schedule,
    get stats() {
      return stats;
    },
    playMusic,
    collectMusic,
    loadFeed,
    openGroups,
  };
})();
