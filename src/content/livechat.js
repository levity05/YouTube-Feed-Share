/*
 * 📡 Чат прямой трансляции YouTube (фрейм youtube.com/live_chat и всплывающее окно чата).
 *
 * Как у 7TV / BetterTTV:
 *  - вид «как на Twitch»: сообщение одной строкой «ЧЧ:ММ  значки Ник: текст», без аватаров, цвета ников Twitch,
 *    поле ввода и кнопка «Отправить» в стиле Twitch (можно вернуть обычный вид YouTube);
 *  - стандартные эмодзи (😂 ❤️ 🔥) другим набором: Twemoji, Apple, Google, Facebook, OpenMoji или системные —
 *    те же символы Юникода, картинки берутся с cdn.jsdelivr.net по коду символа; свои смайлики каналов не трогаем;
 *  - время сообщений без секунд (ЧЧ:ММ);
 *  - ники разными цветами; подсветка сообщений, где вас упомянули, и звук при упоминании;
 *  - клик по нику — «@ник » в поле ввода (быстрый ответ), Ctrl+клик — скопировать ник;
 *  - при наведении на сообщение — кнопки: ответить, скопировать ник, 💬 в мини-чат, 👤 карточка (все сообщения
 *    человека за эту трансляцию), 🚫 скрыть человека;
 *  - 💬 мини-чат: окно поверх чата только с сообщениями выбранных людей и своим полем ввода — пишет в общий чат,
 *    а если выбран один человек, ответ сам начинается с «@ник »;
 *  - ⚙ настройки: размер шрифта, время, полосы, компактный вид, без аватаров; скрыть ботов, команды «!», суперчаты,
 *    спонсорство, служебные сообщения, полосу платных сообщений; свои слова для подсветки.
 * Настройки — yfs_live (их же читает content/livemode.js для раскладки страницы трансляции).
 */
(function () {
  'use strict';
  if (!/^\/live_chat(_replay)?\b/.test(location.pathname) || globalThis.__yfsLiveChatAlive) return;
  globalThis.__yfsLiveChatAlive = true;

  const YFS = globalThis.YFS;
  const L = YFS.liverules;
  const E = YFS.emotes;
  const tr = (k, p) => YFS.i18n.t(k, p);
  const KEY = 'yfs_live';
  const LOG_MAX = 4000;

  let s = L.normalize();
  let myName = '';
  let list = null; // #items списка сообщений
  let observer = null;
  let lastDing = 0;
  let audio = null;
  let ui = null;
  let miniOpen = false;
  let settingsOpen = false;
  let cardFor = '';
  let settingsTab = 'look';
  const REPLAY = location.pathname.startsWith('/live_chat_replay'); // в повторе время — смещение в ролике, а не время суток
  const SAMPLE_EMOJI = ['😂', '❤️', '🔥', '👍', '🎉'];
  const ICON = {
    gear: 'M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.73 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.25.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z',
    chat: 'M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z',
  };

  function svgIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICON[name]);
    svg.append(p);
    return svg;
  }
  const startedAt = Date.now();
  const seen = new Set(); // id сообщений, которые уже обработаны (YouTube перерисовывает список при смене режима чата)
  const log = []; // все сообщения за сессию: { key, name, text, time, own }
  const byUser = new Map(); // ключ ника → { name, count }
  // Поток записей для вида «как на Twitch» (src/content/twitchchat.js): все типы сообщений по порядку.
  const subs = new Set();
  const feed = [];
  const byId = new Map();
  const FEED_MAX = 1500;
  const pendingSends = []; // что отправили из личных вкладок: { text, thread, at } — чтобы свои сообщения попали в нужную вкладку
  let miniThread = 'group';
  let modeTries = 0;
  let emoteMap = new Map(); // слово → { url, animated, set } из выбранных наборов (7TV, BTTV, FFZ, ивентовские)
  const emoteInfo = { loading: false, count: 0, failed: false, sets: {} };
  const emit = (type, entry) =>
    subs.forEach((fn) => {
      try {
        fn(type, entry);
      } catch {
        /* подписчик упал — остальным это не мешает */
      }
    });

  const clean = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const dark = () => document.documentElement.hasAttribute('dark') || matchMedia('(prefers-color-scheme: dark)').matches;
  const names = () => [myName, ...s.aliases].filter(Boolean);
  const watching = () => new Set(s.watch.map(L.nameKey));
  const palette = () => (s.theme === 'twitch' ? 'twitch' : '');

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

  // ---------- настройки ----------

  async function load() {
    try {
      s = L.normalize((await chrome.storage.local.get(KEY))[KEY]);
    } catch {
      s = L.normalize();
    }
    applyStyle();
    reprocess();
    renderAll();
    loadEmotes();
    scheduleChannelResolve();
  }

  const emoteKey = (x) => JSON.stringify([x.emoteSets, x.emoteCustom, x.emoteChannel, x.emoteChannelSet && x.emoteChannelSet.id, x.emoteExtra.map((e) => e.id)]);

  function save(patch) {
    const before = emoteKey(s);
    const wasChannel = s.emoteChannel;
    s = L.normalize({ ...s, ...patch });
    if (emoteKey(s) !== before) loadEmotes();
    if (s.emoteChannel && !wasChannel) scheduleChannelResolve();
    try {
      chrome.storage.local.set({ [KEY]: s });
    } catch {
      /* расширение перезагрузили */
    }
    applyStyle();
    reprocess();
    renderAll();
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      const next = L.normalize(changes[KEY].newValue);
      if (JSON.stringify(next) === JSON.stringify(s)) return;
      const emotesChanged = emoteKey(next) !== emoteKey(s);
      s = next;
      if (emotesChanged) loadEmotes();
      applyStyle();
      reprocess();
      renderAll();
    });
  } catch {
    /* расширение перезагрузили */
  }

  // ---------- оформление самого чата (обычный CSS страницы чата) ----------

  function applyStyle() {
    let st = document.getElementById('yfs-live-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'yfs-live-style';
      (document.head || document.documentElement).append(st);
    }
    const msg = 'yt-live-chat-text-message-renderer';
    const dk = dark();
    const sz = s.emojiSize;
    const css = [
      '[data-yfs-hide] { display: none !important; }',
      `${msg}[data-yfs-mention] { background: rgba(255, 170, 0, .16) !important; box-shadow: inset 3px 0 0 #ffaa00; }`,
      `${msg}[data-yfs-keyword] { background: rgba(62, 166, 255, .13) !important; box-shadow: inset 3px 0 0 #3ea6ff; }`,
      `${msg}[data-yfs-watch] { box-shadow: inset 3px 0 0 #2ba640; }`,
      `${msg} { font-size: ${s.fontSize}px !important; }`,
      `${msg} #message, ${msg} #author-name { font-size: ${s.fontSize}px !important; }`,
      `${msg} #message img.emoji, yt-live-chat-paid-message-renderer #message img.emoji { width: ${sz}px !important; height: ${sz}px !important; vertical-align: middle !important; }`,
      `.yfs-emoji { font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif; font-size: ${Math.round(sz * 0.86)}px; line-height: 1; vertical-align: middle; }`,
      `.yfs-ts { display: none; margin-right: 6px; color: var(--yt-live-chat-tertiary-text-color, #888); font-size: .86em; font-variant-numeric: tabular-nums; }`,
    ];
    if (s.quickReply) css.push(`${msg} #author-name { cursor: pointer; } ${msg} #author-name:hover { text-decoration: underline; }`);
    if (s.alternate) css.push(`#items > ${msg}:nth-child(even) { background-color: rgba(127, 127, 127, .09); }`);
    if (s.compact) css.push(`${msg} { padding-top: 2px !important; padding-bottom: 2px !important; } ${msg} #author-photo { width: 18px !important; height: 18px !important; margin-right: 8px !important; }`);
    // Время: ЧЧ:ММ без секунд (своё), как в YouTube или совсем без времени.
    if (s.timestamps === 'show' && !REPLAY) css.push(`${msg} #timestamp { display: none !important; } ${msg} .yfs-ts { display: inline; }`);
    if (s.timestamps === 'show' && REPLAY) css.push(`${msg} #timestamp { display: inline !important; }`);
    if (s.timestamps === 'hide') css.push(`${msg} #timestamp { display: none !important; }`);
    if (s.hideAvatars) css.push(`${msg} #author-photo { display: none !important; }`);
    if (s.hideTicker) css.push('yt-live-chat-ticker-renderer { display: none !important; }');
    // Вид «как на Twitch» рисует src/content/twitchchat.js своим интерфейсом. Родной чат YouTube при этом
    // продолжает работать (из него берутся сообщения и в него уходит отправка), но невидим и не ловит клики.
    const twitch = s.theme === 'twitch' && !!list;
    document.documentElement.toggleAttribute('yfs-tw', twitch);
    if (twitch) {
      css.push(
        'html[yfs-tw], html[yfs-tw] body { background: ' + (dk ? '#18181b' : '#ffffff') + ' !important; }',
        'html[yfs-tw] yt-live-chat-app { position: fixed !important; inset: 0 !important; opacity: 0 !important; pointer-events: none !important; z-index: -1 !important; }'
      );
    }
    st.textContent = css.join('\n');
  }

  // ---------- сообщения ----------

  /** Текст сообщения: обычный текст + alt у картинок-эмодзи (сами картинки не трогаем). */
  function textOf(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.nodeType === 1 && !(n.classList && (n.classList.contains('yfs-emoji') || n.classList.contains('yfs-ts')))) out += n.tagName === 'IMG' ? n.getAttribute('alt') || '' : textOf(n);
    }
    return out;
  }

  function readMsg(node) {
    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    let type = '';
    if (tag === 'yt-live-chat-text-message-renderer') type = 'text';
    else if (/paid-message|paid-sticker/.test(tag)) type = 'paid';
    else if (/membership|gift/.test(tag)) type = 'member';
    else if (/viewer-engagement|mode-change|banner|placeholder/.test(tag)) type = 'system';
    if (!type) return null;
    const nameEl = node.querySelector('#author-name');
    const author = clean(nameEl && nameEl.textContent);
    const body = node.querySelector('#message');
    const text = clean(body ? textOf(body) : '');
    const own = !!author && !!myName && L.nameKey(author) === L.nameKey(myName);
    return { id: node.id || '', author, text, type, own, nameEl, body, authorType: node.getAttribute('author-type') || '', deleted: node.hasAttribute('is-deleted') };
  }

  /** Значки автора: [{ type: owner | moderator | member | verified, src, label }] — по разметке YouTube и по роли. */
  function badgesOf(node) {
    const out = [];
    for (const b of node.querySelectorAll('yt-live-chat-author-badge-renderer')) {
      const img = b.querySelector('img');
      out.push({ type: b.getAttribute('type') || (img ? 'member' : 'verified'), src: img ? img.getAttribute('src') || '' : '', label: clean(b.getAttribute('aria-label') || (img && img.getAttribute('alt')) || '') });
    }
    const role = node.getAttribute('author-type') || '';
    for (const r of ['owner', 'moderator', 'member']) if (role.includes(r) && !out.some((x) => x.type === r)) out.push({ type: r, src: '', label: '' });
    const order = { owner: 0, moderator: 1, member: 2, verified: 3 };
    return out.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
  }

  /** Содержимое сообщения: текст, картинки (эмодзи и смайлики канала), ссылки — без разметки YouTube. */
  function partsOf(body) {
    const parts = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          if (c.textContent) parts.push({ t: 'text', v: c.textContent });
        } else if (c.nodeType === 1) {
          if (c.classList && (c.classList.contains('yfs-emoji') || c.classList.contains('yfs-ts'))) continue;
          if (c.tagName === 'IMG') parts.push({ t: 'img', src: c.dataset.yfsOrig || c.getAttribute('src') || '', alt: c.getAttribute('alt') || c.getAttribute('shared-tooltip-text') || '' });
          else if (c.tagName === 'A') parts.push({ t: 'link', href: c.getAttribute('href') || '', v: clean(c.textContent) });
          else walk(c);
        }
      }
    };
    if (body) walk(body);
    return parts;
  }

  /** Суперчат, стикер, спонсорство: сумма, заголовок и цвет карточки из переменных YouTube. */
  function extraOf(node, type) {
    if (type === 'text') return null;
    const pick = (sel) => clean((node.querySelector(sel) || {}).textContent);
    const cssVar = (name) => (node.style && node.style.getPropertyValue(name)) || '';
    return {
      amount: pick('#purchase-amount, #purchase-amount-chip'),
      header: pick('#header-primary-text, #primary-text'),
      sub: pick('#header-subtext, #header-secondary-text'),
      color: clean(cssVar('--yt-live-chat-paid-message-primary-color') || cssVar('--yt-live-chat-paid-sticker-background-color')),
    };
  }

  function labelOf(node) {
    const raw = clean((node.querySelector('#timestamp') || {}).textContent);
    if (REPLAY) return raw; // в повторе — смещение внутри ролика
    const t = L.chatTime(raw);
    if (t) return t;
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** «Это я отправил из вкладки X» — когда сообщение вернётся в чат, оно попадёт именно в эту вкладку. */
  function registerSend(text, thread) {
    pendingSends.push({ text: clean(text), thread, at: Date.now() });
    while (pendingSends.length > 20) pendingSends.shift();
  }

  function takeThread(m) {
    const i = pendingSends.findIndex((p) => p.text === m.text && Date.now() - p.at < 60000);
    return i < 0 ? '' : pendingSends.splice(i, 1)[0].thread;
  }

  function pushFeed(node, m, flags) {
    const entry = {
      id: m.id || `${m.type}|${m.author}|${m.text}`,
      key: L.nameKey(m.author),
      name: m.author,
      author: m.author,
      text: m.text,
      type: m.type,
      own: m.own,
      authorType: m.authorType,
      parts: partsOf(m.body),
      badges: badgesOf(node),
      extra: extraOf(node, m.type),
      label: labelOf(node),
      time: Date.now(),
      deleted: m.deleted,
      mention: flags.mention,
      keyword: flags.keyword,
      hidden: flags.reason,
      thread: m.own ? takeThread(m) : '',
    };
    feed.push(entry);
    byId.set(entry.id, entry);
    while (feed.length > FEED_MAX) byId.delete(feed.shift().id);
    return entry;
  }

  function remember(entry) {
    if (!entry.key) return;
    log.push(entry);
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
    const u = byUser.get(entry.key) || { name: entry.name, count: 0 };
    u.count++;
    u.name = entry.name;
    byUser.set(entry.key, u);
  }

  function processNode(node, fresh) {
    const m = readMsg(node);
    if (!m) return;
    const reason = L.hideReason(m, s);
    node.toggleAttribute('data-yfs-hide', !!reason);
    const twitch = s.theme === 'twitch';
    if (!twitch) restyleEmoji(node);
    let mention = false;
    let keyword = false;
    if (m.type === 'text') {
      if (!twitch) restyleTime(node);
      if (m.nameEl) {
        if (!twitch && s.nameColors && !/owner|moderator/.test(m.authorType)) m.nameEl.style.setProperty('color', L.nameColor(m.author, dark(), ''), 'important');
        else m.nameEl.style.removeProperty('color');
      }
      mention = !m.own && L.isMention(m.text, names());
      keyword = !mention && L.hasKeyword(m.text, s.keywords);
      node.toggleAttribute('data-yfs-mention', s.highlightMentions && mention);
      node.toggleAttribute('data-yfs-keyword', keyword);
      node.toggleAttribute('data-yfs-watch', watching().has(L.nameKey(m.author)));
    }
    const id = m.id || `${m.type}|${m.author}|${m.text}`;
    const known = byId.get(id);
    if (known) {
      // Сообщение уже в потоке: могли удалить (модератор) — сообщаем виду.
      if (known.deleted !== m.deleted) {
        known.deleted = m.deleted;
        emit('update', known);
      }
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > FEED_MAX * 3) seen.clear();
    const entry = pushFeed(node, m, { mention, keyword, reason });
    if (m.type === 'text') remember(entry);
    // Звук — только на новые сообщения (не на историю, которая была в чате при открытии).
    if (fresh && mention && !reason && Date.now() - startedAt > 2500) ding();
    if (m.type === 'text') {
      if (miniOpen && (watching().has(entry.key) || entry.own)) renderMini();
      if (cardFor === entry.key) renderCard();
    }
    emit('add', entry);
  }

  /**
   * Стандартные эмодзи — картинками выбранного набора (или системным шрифтом). Если картинки в наборе нет,
   * пробуем имя файла без FE0F, потом — системный символ. «Как в YouTube» возвращает исходную картинку.
   */
  function restyleEmoji(node) {
    const set = s.emojiSet;
    for (const img of node.querySelectorAll('#message img')) {
      const alt = img.getAttribute('alt') || '';
      if (!L.isEmoji(alt) || img.dataset.yfsSet === set) continue;
      if (img.dataset.yfsOrig === undefined) {
        img.dataset.yfsOrig = img.getAttribute('src') || '';
        if (img.hasAttribute('srcset')) img.dataset.yfsSrcset = img.getAttribute('srcset');
      }
      img.dataset.yfsSet = set;
      const next = img.nextElementSibling;
      if (next && next.classList.contains('yfs-emoji')) next.remove();
      img.style.removeProperty('display');
      img.onerror = null;
      if (set === 'youtube') {
        img.setAttribute('src', img.dataset.yfsOrig);
        if (img.dataset.yfsSrcset) img.setAttribute('srcset', img.dataset.yfsSrcset);
        continue;
      }
      img.removeAttribute('srcset');
      const native = () => {
        img.style.setProperty('display', 'none', 'important');
        const span = document.createElement('span');
        span.className = 'yfs-emoji';
        span.textContent = alt;
        img.after(span);
      };
      if (set === 'native') {
        native();
        continue;
      }
      const urls = L.emojiUrls(set, alt);
      let i = 0;
      img.onerror = () => {
        i++;
        if (i < urls.length) img.src = urls[i];
        else {
          img.onerror = null;
          native();
        }
      };
      img.src = urls[0];
    }
  }

  /** Своё время сообщения — ЧЧ:ММ без секунд (из времени YouTube, иначе — время, когда сообщение пришло). */
  function restyleTime(node) {
    if (s.timestamps !== 'show' || REPLAY || node.querySelector('.yfs-ts')) return;
    const ts = node.querySelector('#timestamp');
    const now = new Date();
    const t = L.chatTime(ts && ts.textContent) || `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const span = document.createElement('span');
    span.className = 'yfs-ts';
    span.textContent = t;
    (node.querySelector('#content') || node).prepend(span);
  }

  /** Настройки изменились: пересчитать пометки в DOM YouTube и в потоке записей, вид перерисуется сам. */
  function reprocess() {
    if (list) for (const node of list.children) processNode(node, false);
    for (const e of feed) {
      e.hidden = L.hideReason(e, s);
      if (e.type === 'text') {
        e.mention = !e.own && L.isMention(e.text, names());
        e.keyword = !e.mention && L.hasKeyword(e.text, s.keywords);
      }
    }
    emit('reset');
  }

  function findList() {
    const items = document.querySelector('yt-live-chat-item-list-renderer #items');
    if (items === list) return;
    if (observer) observer.disconnect();
    list = items;
    if (!list) return applyStyle();
    for (const node of list.children) processNode(node, false);
    observer = new MutationObserver((muts) => {
      for (const mu of muts) {
        for (const n of mu.addedNodes) if (n.nodeType === 1) processNode(n, true);
        // Модератор удалил сообщение: YouTube ставит is-deleted на уже существующий элемент.
        if (mu.type === 'attributes' && mu.target.nodeType === 1 && mu.target.parentElement === list) processNode(mu.target, false);
      }
    });
    observer.observe(list, { childList: true, attributes: true, attributeFilter: ['is-deleted'], subtree: true });
    applyStyle(); // чат найден — можно прятать родной интерфейс YouTube (вид «как на Twitch»)
    emit('reset');
  }

  function readMyName() {
    const n = document.querySelector('yt-live-chat-message-input-renderer #author-name, #input-container #author-name');
    const name = clean(n && n.textContent);
    if (name && name !== myName) {
      myName = name;
      reprocess();
    }
  }

  // ---------- звук при упоминании ----------

  function ding(force) {
    if (!force && (!s.mentionSound || Date.now() - lastDing < 1500)) return;
    lastDing = Date.now();
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const t = audio.currentTime;
      const peak = Math.max(0.002, s.soundVolume * 0.45);
      for (const [freq, at] of [
        [880, 0],
        [1318.5, 0.11],
      ]) {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t + at);
        g.gain.exponentialRampToValueAtTime(peak, t + at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.38);
        o.connect(g).connect(audio.destination);
        o.start(t + at);
        o.stop(t + at + 0.42);
      }
    } catch {
      /* без звука */
    }
  }

  // ---------- поле ввода YouTube: ответ и отправка ----------

  function inputEl() {
    return document.querySelector('yt-live-chat-text-input-field-renderer #input[contenteditable], yt-live-chat-text-input-field-renderer [contenteditable]');
  }

  function caretToEnd(node) {
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** «@ник » в поле ввода чата — ответить человеку. */
  function mention(name) {
    const input = inputEl();
    if (!input) return toast(tr('live.noInput'));
    input.focus();
    caretToEnd(input);
    const before = clean(input.textContent);
    document.execCommand('insertText', false, `${before && !/\s$/.test(input.textContent) ? ' ' : ''}@${name.replace(/^@+/, '')} `);
  }

  /** Отправить текст в общий чат: заменить содержимое поля ввода и нажать «Отправить». */
  function sendToChat(text) {
    const input = inputEl();
    if (!input) {
      toast(tr('live.noInput'));
      return false;
    }
    input.focus();
    const r = document.createRange();
    r.selectNodeContents(input);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.execCommand('insertText', false, text);
    setTimeout(() => {
      const btn = document.querySelector('yt-live-chat-message-input-renderer #send-button button, yt-live-chat-message-input-renderer #send-button yt-icon-button, #send-button button');
      if (btn) btn.click();
      else toast(tr('live.noSend'));
    }, 60);
    return true;
  }

  async function copyName(name) {
    try {
      await navigator.clipboard.writeText(name);
      toast(tr('live.copied', { name }));
    } catch {
      toast(name);
    }
  }

  function toggleWatch(name, on) {
    const key = L.nameKey(name);
    const has = s.watch.some((w) => L.nameKey(w) === key);
    const want = on === undefined ? !has : on;
    if (want && !has) save({ watch: [...s.watch, name.replace(/^@+/, '')] });
    else if (!want && has) save({ watch: s.watch.filter((w) => L.nameKey(w) !== key) });
    if (want) {
      miniThread = L.nameKey(name);
      if (s.theme !== 'twitch') miniOpen = true;
    }
    renderMini();
    emit('reset');
  }

  function hideUser(name, on) {
    const key = L.nameKey(name);
    const next = { ...s.hiddenUsers };
    if (on === false || (on === undefined && next[key])) delete next[key];
    else next[key] = name;
    save({ hiddenUsers: next });
  }

  // ---------- интерфейс (shadow DOM) ----------

  const CSS = `
    :host { all: initial; }
    :host { --bg: #ffffff; --elev: #ffffff; --text: #0f0f0f; --text-2: #606060; --chip: #0000000d; --chip-2: #0000001a; --border: #0000001f; --accent: #ff0033; }
    :host([dark]) { --bg: #0f0f0f; --elev: #282828; --text: #f1f1f1; --text-2: #aaaaaa; --chip: #ffffff14; --chip-2: #ffffff29; --border: #ffffff26; }
    * { box-sizing: border-box; }
    button, input, select { font: inherit; color: inherit; }
    :focus-visible { outline: 2px solid #3ea6ff; outline-offset: 1px; }
    .ui { font: 13px/1.4 Roboto, Arial, sans-serif; color: var(--text); }
    .hbtns { display: flex; gap: 0; }
    .hb { position: relative; display: grid; place-items: center; width: 36px; height: 36px; border: 0; border-radius: 50%; background: transparent; color: var(--text-2); cursor: pointer; }
    .hb:hover, .hb.on { background: var(--chip); color: var(--text); }
    .hb svg { width: 22px; height: 22px; fill: currentColor; }
    .hb .dot { position: absolute; top: 2px; right: 2px; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px; background: #2ba640; color: #fff; font-size: 10px; line-height: 15px; }
    .tools { position: fixed; z-index: 40; display: flex; gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: 10px; background: var(--elev); box-shadow: 0 4px 14px #0005; }
    .tools[hidden], .panel[hidden], .mini[hidden], .card[hidden], .toast[hidden] { display: none; }
    .tools button { display: grid; place-items: center; width: 28px; height: 26px; border: 0; border-radius: 7px; background: transparent; cursor: pointer; font-size: 13px; }
    .tools button:hover { background: var(--chip-2); }
    .panel { position: fixed; inset: 8px; max-width: 560px; margin-inline: auto; z-index: 50; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 14px; background: var(--elev); box-shadow: 0 10px 36px #0008; }
    .phead { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px 16px; border-bottom: 1px solid var(--border); }
    .phead b { flex: 1; font-size: 15px; }
    .ib { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 50%; background: transparent; color: var(--text-2); cursor: pointer; }
    .ib:hover { background: var(--chip); color: var(--text); }
    .pbody { flex: 1; overflow-y: auto; padding: 4px 16px 16px; overscroll-behavior: contain; scrollbar-width: thin; }
    h4 { margin: 16px 0 6px; color: var(--text-2); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    .opt { display: flex; align-items: center; gap: 10px; padding: 7px 0; cursor: pointer; }
    .opt .tx { flex: 1; min-width: 0; }
    .opt small { display: block; color: var(--text-2); font-size: 12px; }
    .switch { appearance: none; position: relative; flex: 0 0 auto; width: 36px; height: 20px; margin: 0; border-radius: 10px; background: var(--chip-2); cursor: pointer; transition: background .15s; }
    .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px #0005; transition: transform .15s; }
    .switch:checked { background: var(--accent); }
    .switch:checked::after { transform: translateX(16px); }
    .range { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
    .range span:first-child { flex: 1; }
    .range input { width: 140px; accent-color: var(--accent); }
    .range output { width: 44px; color: var(--text-2); text-align: right; font-variant-numeric: tabular-nums; }
    .seg { display: flex; gap: 4px; padding: 3px; border-radius: 10px; background: var(--chip); }
    .seg button { flex: 1; height: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--text-2); cursor: pointer; font-size: 12px; }
    .seg button[aria-checked='true'] { background: var(--elev); color: var(--text); box-shadow: 0 1px 3px #0003; }
    .row { display: flex; gap: 6px; align-items: center; }
    input[type=text] { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: 9px; background: transparent; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    .chip { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: 13px; background: transparent; cursor: pointer; font-size: 12px; }
    .chip:hover { background: var(--chip); }
    .chip.on { border-color: transparent; background: var(--text); color: var(--bg); }
    .btn { height: 32px; padding: 0 14px; border: 0; border-radius: 16px; background: var(--chip); cursor: pointer; font-weight: 500; }
    .btn:hover { background: var(--chip-2); }
    .btn.primary { background: var(--text); color: var(--bg); }
    .hint { margin: 4px 0 0; color: var(--text-2); font-size: 12px; }
    .mini { position: fixed; z-index: 45; display: flex; flex-direction: column; width: min(320px, calc(100vw - 16px)); height: min(340px, calc(100vh - 16px)); min-width: 220px; min-height: 160px;
      border: 1px solid var(--border); border-radius: 14px; background: var(--elev); box-shadow: 0 10px 32px #0008; resize: both; overflow: hidden; }
    .mhead { display: flex; align-items: center; gap: 6px; padding: 8px 8px 6px 12px; border-bottom: 1px solid var(--border); cursor: move; user-select: none; }
    .mhead b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .who { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 10px 0; }
    .mlist { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 10px; scrollbar-width: thin; }
    .m { padding: 3px 0; word-wrap: break-word; }
    .m b { margin-right: 6px; font-weight: 600; }
    .m time { margin-right: 6px; color: var(--text-2); font-size: 11px; font-variant-numeric: tabular-nums; }
    .m.own b { color: var(--text-2) !important; }
    .empty { padding: 14px 4px; color: var(--text-2); font-size: 12px; text-align: center; }
    .mfoot { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--border); }
    .card { position: fixed; z-index: 48; display: flex; flex-direction: column; width: min(300px, calc(100vw - 16px)); max-height: min(380px, calc(100vh - 16px));
      border: 1px solid var(--border); border-radius: 14px; background: var(--elev); box-shadow: 0 10px 32px #0008; }
    .chead { display: flex; align-items: center; gap: 8px; padding: 10px 8px 6px 14px; }
    .chead b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 15px; }
    .cact { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 12px 8px; }
    .acc { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; }
    .accs { overflow: hidden; border: 1px solid var(--border); border-radius: 12px; }
    .accs.open { border-color: var(--text-2); }
    .acch { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 12px; border: 0; background: transparent; color: var(--text); cursor: pointer; font-size: 14px; font-weight: 600; text-align: left; }
    .acch:hover { background: var(--chip); }
    .acch .al { flex: 1; }
    .acch .ac { color: var(--text-2); }
    .accb { padding: 0 12px 12px; }
    .accb > :first-child { margin-top: 6px; }
    .themes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; }
    .theme { padding: 8px; border: 2px solid var(--border); border-radius: 12px; background: transparent; cursor: pointer; text-align: left; }
    .theme:hover { border-color: var(--text-2); }
    .theme[aria-checked='true'] { border-color: #9147ff; }
    .theme > b { display: block; margin: 6px 2px 0; font-size: 12px; }
    .pv { overflow: hidden; padding: 6px 8px; border-radius: 8px; font-size: 12px; line-height: 18px; white-space: nowrap; }
    .pv.tw { background: #18181b; color: #efeff1; }
    .pv.yt { background: #0f0f0f; color: #f1f1f1; }
    :host(:not([dark])) .pv.tw { background: #fff; color: #0e0e10; border: 1px solid var(--border); }
    :host(:not([dark])) .pv.yt { background: #fff; color: #0f0f0f; border: 1px solid var(--border); }
    .pv .t { margin-right: 5px; color: #adadb8; font-size: 11px; }
    .pv .av { display: inline-block; width: 14px; height: 14px; margin-right: 6px; border-radius: 50%; background: #5c5c66; vertical-align: -3px; }
    .pv .yn { margin-right: 6px; color: #aaa; }
    .pv img { width: 16px; height: 16px; vertical-align: -3px; }
    .sets { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; }
    .set { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 2px solid var(--border); border-radius: 12px; background: transparent; cursor: pointer; text-align: left; }
    .set:hover { border-color: var(--text-2); }
    .set[aria-checked='true'] { border-color: #9147ff; }
    .set b { font-size: 12px; }
    .set .row { gap: 4px; min-height: 24px; font-size: 19px; line-height: 24px; }
    .set img { width: 24px; height: 24px; }
    .set small { color: var(--text-2); font-size: 11px; }
    /* Узкий чат (колонка справа от плеера, всплывающее окно): настройки занимают весь экран чата и складываются в одну колонку. */
    @media (max-width: 480px) {
      .panel { inset: 0; max-width: none; border: 0; border-radius: 0; }
      .pbody { padding: 4px 12px 14px; }
      .themes, .sets { grid-template-columns: 1fr; }
      .range { flex-wrap: wrap; }
      .range span:first-child { flex-basis: 100%; }
      .range input { flex: 1; width: auto; }
      .set .row { flex-wrap: wrap; }
      .mini { left: 8px !important; right: 8px !important; width: auto; }
    }
    .toast { position: fixed; left: 50%; bottom: 72px; z-index: 60; transform: translateX(-50%); max-width: calc(100vw - 24px); padding: 8px 14px; border-radius: 9px; background: #f1f1f1; color: #0f0f0f; box-shadow: 0 4px 14px #0006; font: 13px Roboto, Arial, sans-serif; }
  `;

  function ensureUi() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('div');
    host.id = 'yfs-livechat';
    host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483600;'; // окна настроек и карточки — поверх вида «как на Twitch»
    const root = host.attachShadow({ mode: 'open' });
    const wrap = el('div', { className: 'ui' });
    const gear = el('button', { className: 'hb', type: 'button', title: tr('live.settings'), 'aria-label': tr('live.settings') }, svgIcon('gear'));
    gear.addEventListener('click', () => {
      settingsOpen = !settingsOpen;
      renderAll();
    });
    const miniBtn = el('button', { className: 'hb', type: 'button', title: tr('live.mini'), 'aria-label': tr('live.mini') }, svgIcon('chat'));
    miniBtn.addEventListener('click', () => {
      miniOpen = !miniOpen;
      renderAll();
    });
    const tools = el('div', { className: 'tools', hidden: true });
    const panel = el('div', { className: 'panel', hidden: true, role: 'dialog', 'aria-label': tr('live.settings') });
    const mini = el('div', { className: 'mini', hidden: true, role: 'dialog', 'aria-label': tr('live.mini') });
    const card = el('div', { className: 'card', hidden: true, role: 'dialog' });
    const t = el('div', { className: 'toast', hidden: true, role: 'status' });
    // Клавиши внутри наших окон — наши (иначе Enter и другие клавиши уйдут в чат YouTube).
    for (const box of [panel, mini, card]) for (const type of ['keydown', 'keypress', 'keyup']) box.addEventListener(type, (e) => e.stopPropagation());
    wrap.append(tools, mini, card, panel, t);
    root.append(el('style', { textContent: CSS }), wrap);
    (document.body || document.documentElement).append(host);
    // Кнопки ⚙ и 💬 — отдельным узлом рядом с кнопкой «Отправить» (как шестерёнка у чата Twitch),
    // а если поля ввода нет (не вошли в аккаунт) — в шапке чата рядом с меню ⋮.
    const btnHost = document.createElement('span');
    btnHost.id = 'yfs-livechat-btns';
    btnHost.style.cssText = 'display:inline-flex;align-items:center;margin:0 2px;';
    const broot = btnHost.attachShadow({ mode: 'open' });
    broot.append(el('style', { textContent: CSS + '.hbtns { position: static; }' }), el('div', { className: 'ui' }, el('div', { className: 'hbtns' }, miniBtn, gear)));
    ui = { host, root, btnHost, gear, miniBtn, tools, panel, mini, card, toast: t, hoverFor: null };
    placeButtons();
    tools.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
    tools.addEventListener('mouseleave', hideToolsSoon);
    return ui;
  }

  /** Рядом с «Отправить»; без поля ввода — в шапку перед меню ⋮; нет и шапки — в правый верхний угол. */
  function placeButtons() {
    if (!ui) return;
    const send = document.querySelector('yt-live-chat-message-input-renderer #send-button');
    const header = document.querySelector('yt-live-chat-header-renderer');
    const anchor = send || (header && header.querySelector('#overflow, yt-live-chat-header-renderer > yt-icon-button, #menu-button, #close-button'));
    if (anchor && anchor.parentElement) {
      if (ui.btnHost.nextElementSibling !== anchor) anchor.parentElement.insertBefore(ui.btnHost, anchor);
      ui.btnHost.style.position = '';
    } else if (!ui.btnHost.isConnected || ui.btnHost.parentElement !== document.body) {
      ui.btnHost.style.cssText = 'position:fixed;top:8px;right:52px;z-index:2147483000;display:inline-flex;';
      (document.body || document.documentElement).append(ui.btnHost);
    }
    ui.btnHost.toggleAttribute('dark', dark());
    // В виде «как на Twitch» кнопки ⚙ и 💬 — внутри самого вида; родные кнопки YouTube скрыты.
    ui.btnHost.style.setProperty('display', s.theme === 'twitch' && list ? 'none' : 'inline-flex', 'important');
  }

  function renderAll() {
    ensureUi();
    ui.host.toggleAttribute('dark', dark());
    placeButtons();
    const n = s.watch.length;
    ui.miniBtn.replaceChildren(svgIcon('chat'), n ? el('span', { className: 'dot' }, String(n)) : null);
    ui.miniBtn.classList.toggle('on', miniOpen);
    ui.gear.classList.toggle('on', settingsOpen);
    renderSettings();
    renderMini();
    renderCard();
  }

  let toastTimer = 0;
  function toast(text) {
    ensureUi();
    ui.toast.textContent = text;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (ui.toast.hidden = true), 2200);
  }

  // ---------- кнопки при наведении на сообщение ----------

  let hoverTimer = 0;
  function hideToolsSoon() {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => ui && (ui.tools.hidden = true), 250);
  }

  function showTools(node) {
    ensureUi();
    const m = readMsg(node);
    if (!m || m.type !== 'text' || !m.author) return;
    clearTimeout(hoverTimer);
    const tools = ui.tools;
    ui.hoverFor = m.author;
    const b = (icon, title, fn) => {
      const x = el('button', { type: 'button', title, 'aria-label': title }, icon);
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
        tools.hidden = true;
      });
      return x;
    };
    const key = L.nameKey(m.author);
    tools.replaceChildren(
      b('↩', tr('live.reply'), () => mention(m.author)),
      b('📋', tr('live.copy'), () => copyName(m.author)),
      b(watching().has(key) ? '✓' : '💬', tr(watching().has(key) ? 'live.unwatch' : 'live.watch'), () => toggleWatch(m.author)),
      b('👤', tr('live.card'), () => openCard(m.author, node)),
      m.own ? null : b('🚫', tr('live.hide'), () => hideUser(m.author, true))
    );
    const r = node.getBoundingClientRect();
    tools.hidden = false;
    const w = tools.getBoundingClientRect().width || 150;
    tools.style.left = `${Math.max(4, Math.round(r.right - w - 6))}px`;
    tools.style.top = `${Math.max(4, Math.round(r.top - 14))}px`;
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      const node = e.target && e.target.closest && e.target.closest('yt-live-chat-text-message-renderer');
      if (node) showTools(node);
    },
    true
  );
  document.addEventListener(
    'mouseout',
    (e) => {
      const node = e.target && e.target.closest && e.target.closest('yt-live-chat-text-message-renderer');
      if (node && !(e.relatedTarget && node.contains(e.relatedTarget))) hideToolsSoon();
    },
    true
  );

  // Клик по нику: «@ник » в поле ввода; Ctrl/⌘ — скопировать; Alt — карточка человека.
  document.addEventListener(
    'click',
    (e) => {
      const nameEl = e.target && e.target.closest && e.target.closest('yt-live-chat-text-message-renderer #author-name');
      if (!nameEl || !s.quickReply) return;
      const name = clean(nameEl.textContent);
      if (!name) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) copyName(name);
      else if (e.altKey) openCard(name, nameEl.closest('yt-live-chat-text-message-renderer'));
      else mention(name);
    },
    true
  );

  // ---------- 👤 карточка человека: его сообщения за эту трансляцию ----------

  function openCard(name, near) {
    cardFor = L.nameKey(name);
    renderCard();
    if (near && ui) {
      const r = near.getBoundingClientRect();
      const c = ui.card.getBoundingClientRect();
      ui.card.style.left = `${Math.max(8, Math.min(window.innerWidth - c.width - 8, r.left + 8))}px`;
      ui.card.style.top = `${Math.max(8, Math.min(window.innerHeight - c.height - 8, r.bottom + 4))}px`;
    }
  }

  function messageRow(e, i) {
    const t = new Date(e.time);
    const row = el('div', { className: 'm' + (e.own ? ' own' : '') }, el('time', {}, `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`));
    if (i !== false) {
      const b = el('b', {}, e.name);
      b.style.color = L.nameColor(e.name, dark(), palette());
      row.append(b);
    }
    row.append(e.text);
    return row;
  }

  function renderCard() {
    if (!ui) return;
    const card = ui.card;
    if (!cardFor) {
      card.hidden = true;
      return;
    }
    const u = byUser.get(cardFor) || { name: cardFor, count: 0 };
    const close = el('button', { className: 'ib', type: 'button', 'aria-label': tr('common.close') }, '✕');
    close.addEventListener('click', () => {
      cardFor = '';
      renderCard();
    });
    const act = (label, fn) => {
      const b = el('button', { className: 'chip', type: 'button' }, label);
      b.addEventListener('click', fn);
      return b;
    };
    const w = watching().has(cardFor);
    const hidden = Object.prototype.hasOwnProperty.call(s.hiddenUsers, cardFor);
    const msgs = log.filter((e) => e.key === cardFor).slice(-60);
    const listEl = el('div', { className: 'mlist' }, ...(msgs.length ? msgs.map((e) => messageRow(e, false)) : [el('p', { className: 'empty' }, tr('live.cardEmpty'))]));
    const title = el('b', {}, u.name);
    title.style.color = L.nameColor(u.name, dark(), palette());
    card.replaceChildren(
      el('div', { className: 'chead' }, title, el('span', { className: 'hint', style: 'margin:0' }, tr('live.cardCount', { n: u.count })), close),
      el(
        'div',
        { className: 'cact' },
        act('↩ ' + tr('live.reply'), () => mention(u.name)),
        act('📋 ' + tr('live.copy'), () => copyName(u.name)),
        act((w ? '✓ ' : '💬 ') + tr(w ? 'live.unwatch' : 'live.watch'), () => toggleWatch(u.name)),
        act((hidden ? '↺ ' : '🚫 ') + tr(hidden ? 'live.unhide' : 'live.hide'), () => hideUser(u.name))
      ),
      listEl
    );
    card.hidden = false;
    listEl.scrollTop = listEl.scrollHeight;
  }

  // ---------- 💬 мини-чат ----------

  let miniPos = null; // { left, top } — куда перетащили окно

  /** Вкладки личных переписок: «Группа» (если выбрано двое и больше) и по вкладке на каждого человека. */
  function threadTabs() {
    const people = s.watch.map((n) => ({ id: L.nameKey(n), name: n }));
    return s.watch.length > 1 ? [{ id: 'group', group: true }, ...people] : people;
  }

  function renderMini() {
    if (!ui) return;
    const mini = ui.mini;
    if (!miniOpen) {
      mini.hidden = true;
      return;
    }
    const tabs = threadTabs();
    if (!tabs.some((t) => t.id === miniThread)) miniThread = tabs.length ? tabs[0].id : 'group';
    const thread = miniThread;
    const person = tabs.find((t) => t.id === thread && !t.group);
    const keep = mini.querySelector('input');
    const draft = keep ? keep.value : '';
    const hadFocus = keep && ui.root.activeElement === keep;
    const close = el('button', { className: 'ib', type: 'button', 'aria-label': tr('common.close') }, '✕');
    close.addEventListener('click', () => {
      miniOpen = false;
      renderAll();
    });
    const head = el('div', { className: 'mhead' }, el('b', {}, '💬 ' + tr('live.mini')), close);
    const bar = el('div', { className: 'who' });
    for (const t of tabs) {
      const b = el('button', { className: 'chip' + (t.id === thread ? ' on' : ''), type: 'button', 'aria-pressed': String(t.id === thread) }, t.group ? '👥 ' + tr('live.group') : t.name);
      b.addEventListener('click', () => {
        miniThread = t.id;
        renderMini();
      });
      bar.append(b);
    }
    if (person) {
      const rm = el('button', { className: 'chip', type: 'button', title: tr('live.unwatch') }, '✕');
      rm.addEventListener('click', () => toggleWatch(person.name, false));
      bar.append(rm);
    }
    const msgs = log.filter((e) => L.inThread(e, thread, s.watch)).slice(-200);
    const listEl = el('div', { className: 'mlist' }, ...(msgs.length ? msgs.map((e) => messageRow(e)) : [el('p', { className: 'empty' }, tr(s.watch.length ? 'live.miniWaiting' : 'live.miniEmpty'))]));
    const input = el('input', { type: 'text', placeholder: person ? tr('live.replyTo', { name: person.name }) : tr('live.miniPh'), value: draft, maxLength: 200, disabled: !s.watch.length });
    const send = el('button', { className: 'btn primary', type: 'button', disabled: !s.watch.length }, tr('live.send'));
    const doSend = () => {
      const text = L.composeText(input.value, thread, s.watch, s.groupMention);
      if (!text) return;
      registerSend(text, thread);
      if (sendToChat(text)) input.value = '';
    };
    send.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), doSend()));
    mini.replaceChildren(head, s.watch.length ? bar : null, listEl, el('div', { className: 'mfoot' }, input, send));
    mini.hidden = false;
    if (miniPos) {
      mini.style.left = `${miniPos.left}px`;
      mini.style.top = `${miniPos.top}px`;
    } else {
      mini.style.right = '8px';
      mini.style.bottom = '64px';
    }
    listEl.scrollTop = listEl.scrollHeight;
    if (hadFocus) input.focus();
    dragBy(head, mini);
  }

  function dragBy(handle, box) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button || e.target.closest('button')) return;
      const r = box.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        miniPos = {
          left: Math.round(Math.max(0, Math.min(window.innerWidth - r.width, r.left + ev.clientX - sx))),
          top: Math.round(Math.max(0, Math.min(window.innerHeight - 40, r.top + ev.clientY - sy))),
        };
        box.style.right = box.style.bottom = 'auto';
        box.style.left = `${miniPos.left}px`;
        box.style.top = `${miniPos.top}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  // ---------- ⚙ настройки ----------

  function renderSettings() {
    if (!ui) return;
    const panel = ui.panel;
    panel.hidden = !settingsOpen;
    if (!settingsOpen) return;
    const focused = ui.root.activeElement;
    if (focused && focused.tagName === 'INPUT' && focused.type === 'text') return;
    const top = panel.querySelector('.pbody') ? panel.querySelector('.pbody').scrollTop : 0;
    const opt = (key, label, hint) => {
      const sw = el('input', { type: 'checkbox', className: 'switch', checked: !!s[key], 'aria-label': label });
      sw.addEventListener('change', () => save({ [key]: sw.checked }));
      return el('label', { className: 'opt' }, el('span', { className: 'tx' }, label, hint ? el('small', {}, hint) : null), sw);
    };
    const range = (key, label, min, max, step, fmt) => {
      const out = el('output', {}, fmt(s[key]));
      const r = el('input', { type: 'range', min, max, step, value: s[key], 'aria-label': label });
      r.addEventListener('input', () => (out.textContent = fmt(Number(r.value))));
      r.addEventListener('change', () => save({ [key]: Number(r.value) }));
      return el('div', { className: 'range' }, el('span', {}, label), r, out);
    };
    const seg = (key, values) => {
      const box = el('div', { className: 'seg', role: 'radiogroup' });
      for (const [v, label] of values) {
        const b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(s[key] === v) }, label);
        b.addEventListener('click', () => save({ [key]: v }));
        box.append(b);
      }
      return box;
    };
    const words = (key, placeholder) => {
      const input = el('input', { type: 'text', placeholder });
      const add = () => {
        const w = input.value.split(',').map((x) => x.trim()).filter(Boolean);
        if (!w.length) return;
        input.value = '';
        input.blur();
        save({ [key]: [...s[key], ...w] });
      };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
      const plus = el('button', { className: 'btn', type: 'button' }, '+');
      plus.addEventListener('click', add);
      const chips = el('div', { className: 'chips' });
      for (const w of s[key]) {
        const c = el('button', { className: 'chip', type: 'button' }, w, ' ✕');
        c.addEventListener('click', () => save({ [key]: s[key].filter((x) => x !== w) }));
        chips.append(c);
      }
      return [el('div', { className: 'row' }, input, plus), chips];
    };
    const close = el('button', { className: 'ib', type: 'button', 'aria-label': tr('common.close') }, '✕');
    close.addEventListener('click', () => {
      settingsOpen = false;
      renderAll();
    });
    // Превью темы: две строчки чата в этом виде.
    const preview = (theme) => {
      const name = (n) => {
        const b = el('b', {}, n);
        b.style.color = L.nameColor(n, true, theme === 'twitch' ? 'twitch' : '');
        return b;
      };
      const line = (n, text) =>
        theme === 'twitch'
          ? el('div', {}, el('span', { className: 't' }, '21:07'), name(n), ': ', text)
          : el('div', {}, el('span', { className: 'av' }), el('span', { className: 'yn' }, n), text);
      return el('div', { className: 'pv ' + (theme === 'twitch' ? 'tw' : 'yt') }, line('StreamFan', tr('live.preview1') + ' 😂'), line('Kotik', tr('live.preview2')));
    };
    const themeCards = el('div', { className: 'themes', role: 'radiogroup', 'aria-label': tr('live.theme') });
    for (const th of L.THEMES) {
      const b = el('button', { className: 'theme', type: 'button', role: 'radio', 'aria-checked': String(s.theme === th) }, preview(th), el('b', {}, tr('live.theme.' + th)));
      b.addEventListener('click', () => save({ theme: th }));
      themeCards.append(b);
    }
    // Наборы смайликов: у каждого — те же пять эмодзи в его рисовке.
    const setCards = el('div', { className: 'sets', role: 'radiogroup', 'aria-label': tr('live.emoji') });
    for (const set of L.EMOJI_SETS) {
      const sample = el('div', { className: 'row' });
      if (set === 'youtube') sample.append(el('small', {}, tr('live.emoji.asIs')));
      else if (set === 'native') sample.append(el('span', { className: 'yfs-native' }, SAMPLE_EMOJI.join(' ')));
      else
        for (const e of SAMPLE_EMOJI) {
          const urls = L.emojiUrls(set, e);
          const img = el('img', { alt: e, loading: 'lazy', src: urls[0] });
          let i = 0;
          img.addEventListener('error', () => (++i < urls.length ? (img.src = urls[i]) : img.replaceWith(e)));
          sample.append(img);
        }
      const b = el('button', { className: 'set', type: 'button', role: 'radio', 'aria-checked': String(s.emojiSet === set) }, el('b', {}, tr('live.emoji.' + set)), sample);
      b.addEventListener('click', () => save({ emojiSet: set }));
      setCards.append(b);
    }
    const test = el('button', { className: 'btn', type: 'button' }, '🔔 ' + tr('live.testSound'));
    test.addEventListener('click', () => ding(true));
    const hiddenList = el('div', { className: 'chips' });
    for (const [key, name] of Object.entries(s.hiddenUsers)) {
      const c = el('button', { className: 'chip', type: 'button', title: tr('live.unhide') }, name, ' ↺');
      c.addEventListener('click', () => hideUser(key, false));
      hiddenList.append(c);
    }
    const TABS = ['look', 'emoji', 'mentions', 'hide', 'layout'];
    const SEC_ICON = { look: '🎨', emoji: '😀', mentions: '🔔', hide: '🚫', layout: '📐' };
    const PAGES = {
      look: () => [
        el('h4', {}, tr('live.theme')),
        themeCards,
        el('h4', {}, tr('live.secChat')),
        opt('nameColors', tr('live.nameColors')),
        opt('quickReply', tr('live.quickReply'), tr('live.quickReplyHint')),
        range('fontSize', tr('live.fontSize'), 11, 22, 1, (v) => `${v}px`),
        el('div', { className: 'opt', style: 'cursor:default' }, el('span', { className: 'tx' }, tr('live.timestamps'))),
        seg('timestamps', [
          ['show', tr('live.ts.show')],
          ['auto', tr('live.ts.auto')],
          ['hide', tr('live.ts.hide')],
        ]),
        opt('alternate', tr('live.alternate')),
        opt('compact', tr('live.compact')),
        opt('showBadges', tr('live.showBadges')),
        opt('paidInline', tr('live.paidInline')),
        opt('allMessages', tr('live.allMessages'), tr('live.allMessagesHint')),
        s.theme === 'youtube' ? opt('hideAvatars', tr('live.hideAvatars')) : null,
      ],
      emoji: () => {
        const toggle = (id) => save({ emoteSets: s.emoteSets.includes(id) ? s.emoteSets.filter((x) => x !== id) : [...s.emoteSets, id] });
        const packChips = (ids) => {
          const box = el('div', { className: 'chips' });
          for (const p of E.PACKS.filter((x) => ids(x.id))) {
            const on = s.emoteSets.includes(p.id);
            const b = el('button', { className: 'chip' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on) }, p.icon + ' ' + tr('live.emotes.pack.' + p.id));
            b.addEventListener('click', () => toggle(p.id));
            box.append(b);
          }
          return box;
        };
        const custom = el('input', { type: 'text', value: s.emoteCustom, placeholder: tr('live.emotes.customPh'), spellcheck: false, 'aria-label': tr('live.emotes.custom') });
        custom.addEventListener('change', () => save({ emoteCustom: custom.value.trim() }));
        custom.addEventListener('keydown', (e) => e.key === 'Enter' && custom.blur());
        const refresh = el('button', { className: 'btn', type: 'button', disabled: emoteInfo.loading }, '↻ ' + tr('live.emotes.refresh'));
        refresh.addEventListener('click', () => {
          resolveChannel(true);
          loadEmotes(true);
        });
        const any = s.emoteSets.length || E.parseSetInput(s.emoteCustom) || s.emoteExtra.length || (s.emoteChannel && s.emoteChannelSet && s.emoteChannelSet.id);
        // Смайлики канала: набор стримера на 7TV находится по названию канала (только точное совпадение имени).
        const chSet = s.emoteChannelSet;
        let chStatus = '';
        if (s.emoteChannel) {
          if (channelInfo.state === 'searching') chStatus = tr('live.emotes.loading');
          else if (channelInfo.state === 'unknown') chStatus = tr('live.emotes.channelUnknown');
          else if (channelInfo.state === 'failed') chStatus = tr('live.emotes.failed');
          else if (chSet && chSet.id) chStatus = tr('live.emotes.channelFound', { name: chSet.name, n: chSet.count });
          else if (chSet) chStatus = tr('live.emotes.channelNone', { name: channelInfo.names[0] || chSet.key });
        }
        // Поиск на 7TV: имя стримера (его набор) или слово («pepe») — самые популярные смайлики по слову.
        const findInput = el('input', { type: 'text', value: finder.q, placeholder: tr('live.emotes.findPh'), spellcheck: false, 'aria-label': tr('live.emotes.find') });
        const doFind = () => {
          const v = findInput.value;
          findInput.blur();
          runFinder(v);
        };
        findInput.addEventListener('keydown', (e) => e.key === 'Enter' && doFind());
        const findBtn = el('button', { className: 'btn', type: 'button', disabled: finder.busy }, tr('live.emotes.findBtn'));
        findBtn.addEventListener('click', doFind);
        const results = el('div', { className: 'chips' });
        const term = finder.q.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '').slice(0, 30);
        const addChip = (id, label, name) => {
          const on = s.emoteExtra.some((x) => x.id === id);
          const b = el('button', { className: 'chip' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on) }, (on ? '✓ ' : '＋ ') + label);
          b.addEventListener('click', () => toggleExtra(id, name));
          results.append(b);
        };
        if (finder.users) {
          if (term.length >= 2) addChip('q:' + term, '🔎 ' + tr('live.emotes.popular', { word: term }), term);
          for (const u of finder.users) addChip(u.setId, `${u.name} · ${STV_PLATFORM[u.platform] || u.platform} · ${tr('live.emotes.setCount', { n: u.count })}`, u.name);
        }
        const findStatus = finder.busy ? tr('live.emotes.loading') : finder.failed ? tr('live.emotes.failed') : finder.users && !finder.users.length ? tr('live.emotes.findNone') : '';
        const added = el('div', { className: 'chips' });
        for (const x of s.emoteExtra) {
          const c = el('button', { className: 'chip', type: 'button', title: tr('live.emotes.remove') }, (x.id.startsWith('q:') ? '🔎 ' : '') + x.name, ' ✕');
          c.addEventListener('click', () => toggleExtra(x.id, x.name));
          added.append(c);
        }
        const status = !any ? '' : emoteInfo.loading ? tr('live.emotes.loading') : emoteInfo.failed ? tr('live.emotes.failed') : tr('live.emotes.count', { n: emoteInfo.count });
        return [
          el('h4', {}, tr('live.emoji')),
          setCards,
          range('emojiSize', tr('live.emojiSize'), 16, 48, 2, (v) => `${v}px`),
          el('p', { className: 'hint' }, tr('live.emojiHint', { host: L.EMOJI_HOST })),
          el('h4', {}, tr('live.emotes')),
          el('p', { className: 'hint' }, tr('live.emotes.hint')),
          el('p', { className: 'hint', style: 'margin-top:10px' }, tr('live.emotes.sites')),
          packChips((id) => !id.startsWith('event-')),
          el('p', { className: 'hint', style: 'margin-top:10px' }, tr('live.emotes.events')),
          packChips((id) => id.startsWith('event-')),
          opt('emoteChannel', tr('live.emotes.channel'), tr('live.emotes.channelHint')),
          chStatus ? el('p', { className: 'hint', role: 'status', style: 'margin-top:0' }, chStatus) : null,
          el('p', { className: 'hint', style: 'margin-top:10px' }, tr('live.emotes.find')),
          el('div', { className: 'row' }, findInput, findBtn),
          findStatus ? el('p', { className: 'hint', role: 'status' }, findStatus) : null,
          results.children.length ? results : null,
          s.emoteExtra.length ? el('p', { className: 'hint', style: 'margin-top:10px' }, tr('live.emotes.added')) : null,
          s.emoteExtra.length ? added : null,
          el('p', { className: 'hint', style: 'margin-top:10px' }, tr('live.emotes.custom')),
          el('div', { className: 'row' }, custom),
          range('emoteSize', tr('live.emotes.size'), 16, 64, 2, (v) => `${v}px`),
          el('div', { className: 'row', style: 'margin-top:8px' }, refresh, el('span', { className: 'hint', style: 'margin:0', role: 'status' }, status)),
          s.theme !== 'twitch' ? el('p', { className: 'hint', style: 'color:#ffaa00' }, tr('live.emotes.needTwitch')) : null,
        ];
      },
    };
    const legacy = [
      el('h4', {}, tr('live.secMentions')),
      opt('highlightMentions', tr('live.highlight'), myName ? tr('live.myName', { name: myName }) : tr('live.myNameUnknown')),
      opt('mentionSound', tr('live.sound'), tr('live.soundHint')),
      range('soundVolume', tr('live.volume'), 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      el('div', { className: 'row', style: 'margin:4px 0 8px' }, test),
      el('p', { className: 'hint' }, tr('live.aliases')),
      ...words('aliases', tr('live.aliasesPh')),
      el('p', { className: 'hint', style: 'margin-top:10px' }, tr('live.keywords')),
      ...words('keywords', tr('live.keywordsPh')),
      opt('groupMention', tr('live.groupMention'), tr('live.groupMentionHint')),
      el('h4', {}, tr('live.secHide')),
      opt('hideBots', tr('live.hideBots'), s.bots.join(', ')),
      opt('hideCommands', tr('live.hideCommands')),
      opt('hidePaid', tr('live.hidePaid')),
      opt('hideMembers', tr('live.hideMembers')),
      opt('hideSystem', tr('live.hideSystem')),
      opt('hideTicker', tr('live.hideTicker')),
      el('p', { className: 'hint' }, tr('live.hiddenUsers')),
      hiddenList.children.length ? hiddenList : el('p', { className: 'hint' }, tr('live.hiddenNone')),
      el('h4', {}, tr('live.secLayout')),
      opt('layout', tr('live.layout'), tr('live.layoutHint')),
      range('chatWidth', tr('live.chatWidth'), 300, 900, 10, (v) => `${v}px`),
      el('div', { className: 'opt', style: 'cursor:default' }, el('span', { className: 'tx' }, tr('live.chatSide'))),
      seg('chatSide', [
        ['left', tr('live.side.left')],
        ['right', tr('live.side.right')],
      ]),
      opt('chatFullHeight', tr('live.fullHeight')),
      opt('chatTall', tr('live.chatTall'), tr('live.chatTallHint')),
      opt('hideRelated', tr('live.hideRelated')),
      opt('hideBelow', tr('live.hideBelow')),
    ];
    // Остальные вкладки — из прежнего списка по заголовкам разделов.
    const at = (title) => legacy.findIndex((n) => n.tagName === 'H4' && n.textContent === tr(title));
    const slice = (from, to) => legacy.slice(at(from), to ? at(to) : undefined);
    PAGES.mentions = () => slice('live.secMentions', 'live.secHide');
    PAGES.hide = () => slice('live.secHide', 'live.secLayout');
    PAGES.layout = () => slice('live.secLayout');
    // Аккордеон: разделы списком, раскрыт один; щелчок по раскрытому сворачивает его.
    const acc = el('div', { className: 'acc' });
    for (const t of TABS) {
      const open = settingsTab === t;
      const head = el('button', { className: 'acch', type: 'button', 'aria-expanded': String(open) }, el('span', { 'aria-hidden': 'true' }, SEC_ICON[t]), el('span', { className: 'al' }, tr('live.tab.' + t)), el('span', { className: 'ac', 'aria-hidden': 'true' }, open ? '▾' : '▸'));
      head.addEventListener('click', () => {
        settingsTab = open ? '' : t;
        renderSettings();
      });
      let nodes = [];
      if (open) {
        nodes = PAGES[t]();
        if (t !== 'look' && t !== 'emoji' && nodes[0] && nodes[0].tagName === 'H4') nodes = nodes.slice(1); // заголовок раздела уже на кнопке
      }
      acc.append(el('section', { className: 'accs' + (open ? ' open' : '') }, head, open ? el('div', { className: 'accb', role: 'region' }, ...nodes) : null));
    }
    const body = el('div', { className: 'pbody' }, acc);
    panel.replaceChildren(el('div', { className: 'phead' }, el('b', {}, tr('live.settings')), close), body);
    if (settingsTab === renderSettings.lastTab) body.scrollTop = top;
    else {
      const h = acc.querySelector('.accs.open .acch');
      body.scrollTop = h ? Math.max(0, h.getBoundingClientRect().top - body.getBoundingClientRect().top - 4) : 0;
    }
    renderSettings.lastTab = settingsTab;
  }

  /**
   * «Все сообщения»: YouTube по умолчанию показывает «Топ чата» — часть сообщений он отфильтровывает.
   * Переключаем на «Чат» (все сообщения), как на Twitch. Пункты выпадающего списка в шапке: первый — «Топ чата»,
   * второй — «Чат»; если разметка другая, ничего не делаем.
   */
  function ensureAllMessages() {
    if (!s.allMessages || REPLAY || modeTries >= 3 || !list) return;
    const items = Array.from(document.querySelectorAll('yt-live-chat-header-renderer tp-yt-paper-listbox a.yt-simple-endpoint, yt-live-chat-header-renderer #menu a.yt-simple-endpoint'));
    if (items.length < 2) return;
    const selected = items.findIndex((a) => a.classList.contains('iron-selected') || a.getAttribute('aria-selected') === 'true' || !!a.querySelector('.iron-selected, [aria-selected="true"]'));
    modeTries++;
    if (selected === 0) items[1].click();
  }

  // ---------- смайлики с сайтов (7TV, BetterTTV, FrankerFaceZ, ивентовские наборы) ----------

  // ---------- смайлики канала и поиск стримера на 7TV ----------

  const channelInfo = { state: '', names: [] }; // state: '' | searching | unknown | failed
  const finder = { q: '', busy: false, users: null, failed: false };
  const STV_PLATFORM = { TWITCH: 'Twitch', YOUTUBE: 'YouTube', KICK: 'Kick', DISCORD: 'Discord' };

  /** Название и @ник канала трансляции: чат — iframe того же сайта, поэтому читаем страницу-родителя; иначе — имя владельца в чате. */
  function channelNames() {
    const names = [];
    try {
      const doc = window.parent !== window ? window.parent.document : document;
      const a = doc.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a, ytd-video-owner-renderer ytd-channel-name a');
      if (a) {
        names.push(a.textContent.trim());
        const m = /\/@([^/?#]+)/.exec(a.getAttribute('href') || '');
        if (m) names.push(decodeURIComponent(m[1]));
      }
    } catch {
      /* родитель недоступен */
    }
    const owner = feed.find((x) => /owner/.test(x.authorType || ''));
    if (owner) names.push(owner.author);
    return [...new Set(names.map((n) => String(n || '').trim()).filter((n) => n.length >= 2))];
  }

  /** Стримеры на 7TV по имени: [{ user, name, platform, setId, setName, count, conns, own }]. */
  function findOnStv(queries) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'yfs:emote-find', q: queries }, (res) => {
          void chrome.runtime.lastError;
          if (res && res.ok) resolve(res.users || []);
          else reject(new Error((res && res.message) || 'failed'));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  let channelBusy = false;
  async function resolveChannel(force) {
    if (!s.emoteChannel || channelBusy) return;
    const names = channelNames();
    channelInfo.names = names;
    if (!names.length) {
      channelInfo.state = 'unknown';
      return renderSettings();
    }
    const key = E.normName(names[0]);
    if (!force && s.emoteChannelSet && s.emoteChannelSet.key === key) {
      channelInfo.state = '';
      return;
    }
    channelBusy = true;
    channelInfo.state = 'searching';
    renderSettings();
    try {
      const hit = E.matchChannel(await findOnStv(names.slice(0, 2)), names);
      channelInfo.state = '';
      save({ emoteChannelSet: { key, id: hit ? hit.setId : '', name: hit ? hit.name : '', count: hit ? hit.count : 0 } });
    } catch {
      channelInfo.state = 'failed';
    } finally {
      channelBusy = false;
      renderSettings();
    }
  }

  /** Название канала бывает известно не сразу (страница и чат грузятся отдельно) — пробуем несколько раз. */
  function scheduleChannelResolve(tries = 6) {
    if (!s.emoteChannel) return;
    resolveChannel().then(() => {
      if (channelInfo.state === 'unknown' && tries > 0) setTimeout(() => scheduleChannelResolve(tries - 1), 4000);
    });
  }

  async function runFinder(q) {
    const word = String(q || '').trim();
    if (word.length < 2) return;
    Object.assign(finder, { q: word, busy: true, users: null, failed: false });
    renderSettings();
    try {
      finder.users = await findOnStv([word]);
    } catch {
      finder.failed = true;
    }
    finder.busy = false;
    renderSettings();
  }

  function toggleExtra(id, name) {
    const has = s.emoteExtra.some((x) => x.id === id);
    save({ emoteExtra: has ? s.emoteExtra.filter((x) => x.id !== id) : [...s.emoteExtra, { id, name }] });
  }

  /** Порядок приоритета: свои наборы (по ссылке, канала, найденные) → ивентовские → 7TV → BTTV → FFZ (раньше стоящий перекрывает одноимённый). */
  function emoteOrder() {
    const custom = E.parseSetInput(s.emoteCustom);
    const ids = s.emoteSets.slice();
    const rank = (id) => (id.startsWith('event-') ? 1 : id === '7tv-global' ? 2 : id === 'bttv-global' ? 3 : 4);
    ids.sort((a, b) => rank(a) - rank(b));
    const mine = [custom && 'custom:' + custom, s.emoteChannel && s.emoteChannelSet && s.emoteChannelSet.id && 'custom:' + s.emoteChannelSet.id, ...s.emoteExtra.map((x) => (x.id.startsWith('q:') ? x.id : 'custom:' + x.id))].filter(Boolean);
    return { ids: [...new Set(mine), ...ids] };
  }

  function loadEmotes(force) {
    const { ids } = emoteOrder();
    if (!ids.length) {
      emoteMap = new Map();
      Object.assign(emoteInfo, { loading: false, count: 0, failed: false, sets: {} });
      emit('reset');
      renderSettings();
      return Promise.resolve();
    }
    emoteInfo.loading = true;
    emoteInfo.failed = false;
    renderSettings();
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'yfs:emotes', ids, force: !!force }, (res) => {
          void chrome.runtime.lastError;
          emoteInfo.loading = false;
          if (res && res.ok) {
            emoteMap = E.buildMap(ids, res.sets);
            emoteInfo.count = emoteMap.size;
            emoteInfo.sets = Object.fromEntries(Object.entries(res.sets).map(([k, v]) => [k, v.length]));
            emoteInfo.failed = !emoteMap.size;
          } else emoteInfo.failed = true;
          emit('reset');
          renderSettings();
          resolve();
        });
      } catch {
        emoteInfo.loading = false;
        emoteInfo.failed = true;
        resolve();
      }
    });
  }

  // ---------- запуск ----------

  const tick = () => {
    try {
      if (!chrome.runtime.id) return stop();
    } catch {
      return stop();
    }
    findList();
    ensureAllMessages();
    readMyName();
    if (ui) ui.host.toggleAttribute('dark', dark()), placeButtons();
  };
  const timer = setInterval(tick, 1500);
  function stop() {
    clearInterval(timer);
    if (observer) observer.disconnect();
    if (ui) ui.host.remove(), ui.btnHost.remove();
  }

  YFS.i18n
    .init({ applyToPage: false })
    .catch(() => {})
    .then(load)
    .then(tick);
  YFS.i18n.onChange(() =>
    YFS.i18n.init({ applyToPage: false }).then(() => {
      if (ui) ui.host.remove(), ui.btnHost.remove();
      ui = null;
      renderAll();
    })
  );

  /** То, чем пользуется вид «как на Twitch» (src/content/twitchchat.js). */
  YFS.liveChat = {
    mention,
    sendToChat,
    registerSend,
    toggleWatch,
    hideUser,
    copyName,
    openCard,
    toast,
    ding,
    save,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    toggleSettings() {
      settingsOpen = !settingsOpen;
      renderAll();
    },
    get feed() {
      return feed;
    },
    get log() {
      return log;
    },
    get settings() {
      return s;
    },
    get myName() {
      return myName;
    },
    get canSend() {
      return !!inputEl();
    },
    get dark() {
      return dark();
    },
    get replay() {
      return REPLAY;
    },
    get emotes() {
      return emoteMap;
    },
    get emoteInfo() {
      return emoteInfo;
    },
    refreshEmotes: () => loadEmotes(true),
  };
  document.dispatchEvent(new CustomEvent('yfs:livechat-ready'));
})();
