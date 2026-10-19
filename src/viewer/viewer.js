'use strict';

/*
 * «Микро-YouTube»: библиотека снимков с разделами (главная, «Посмотреть позже»,
 * история, Shorts), обзором-статистикой и сравнением снимков.
 * Работает и как страница расширения, и как обычный сайт (GitHub Pages, localhost):
 * вне расширения состояние хранится в localStorage.
 * Все данные из файла считаются чужими: выводятся только через textContent,
 * а ссылки собираются из проверенных id и путей (см. feed.js → normalizeSnapshot).
 */

const F = YFS.feed;
const A = YFS.analytics;
const E = YFS.enrich;
const I18N = YFS.i18n;
const tr = I18N.t;
const $ = (id) => document.getElementById(id);
const IS_EXT = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
const MAX_SNAPS = 50;
const YT_ORIGIN = 'https://www.youtube.com';
const TAB_ICONS = { home: '🏠', 'watch-later': '🔖', history: '👁', shorts: '⚡', overview: '📊' };

// ---------- хранилище ----------

const store = {
  async get(key, fallback) {
    try {
      if (IS_EXT) {
        const r = await chrome.storage.local.get(key);
        return r[key] === undefined ? fallback : r[key];
      }
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  async set(key, value) {
    if (IS_EXT) return chrome.storage.local.set({ [key]: value });
    localStorage.setItem(key, JSON.stringify(value));
  },
};

let snaps = []; // [{ key, importedAt, own, snap, hidden: [id], watched: [id], compareKey? }]
let currentKey = null;
let settings = { theme: 'auto', lastKey: null, pro: false };
let viewerBase = null;
const view = { tab: '', filter: 'all', dur: 'any', period: 'all', channel: '', sort: 'feed', q: '', showHidden: false, onlyNew: false };
let visible = []; // ролики текущего раздела после фильтров
let queue = []; // порядок роликов для «предыдущее/следующее» в плеере
let playing = null; // { v, type }
let shortIndex = 0;
let shortPlayingId = null;
let enricher = null; // восстановление метаданных по id (enrich.js)

/** Ролик для показа: данные снимка + восстановленные метаданные (только заполняют пустые поля). */
function display(v) {
  return enricher ? E.merge(v, enricher.get(v.id)) : v;
}

function videosOf(rec, type) {
  const f = feedOf(rec, type);
  return f ? f.videos.map(display) : [];
}

function titleOf(v, fallback = tr('video.unknown')) {
  if (v.title) return v.title;
  return v.gone ? tr('video.gone') : fallback;
}

const feedTitle = (type) => tr('feed.' + type);

const ICONS = {
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  uncheck: 'M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  hide: 'M12 7a5 5 0 0 1 5 5c0 .65-.13 1.26-.36 1.83l2.92 2.92A11.8 11.8 0 0 0 23 12c-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.8 11.8 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55A2.8 2.8 0 0 0 9 12a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.55 1.55A5 5 0 0 1 7 12c0-.79.2-1.53.53-2.2z',
  restore: 'M13 3a9 9 0 0 0-9 9H1l3.9 3.9L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3z',
};

const PLAYER_ERRORS = { 2: 'player.err.badId', 5: 'player.err.html5', 100: 'player.err.removed', 101: 'player.err.noEmbed', 150: 'player.err.noEmbed' };

// ---------- утилиты ----------

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') node.style.cssText = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function svgIcon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const videosWord = (n) => tr('n.videos', { n });
const channelsWord = (n) => tr('n.channels', { n });

function formatDate(iso, withTime) {
  const opts = { day: 'numeric', month: 'long', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return new Date(iso).toLocaleString(I18N.locale(), opts);
}

let toastTimer = 0;
function toast(message, isError = false) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 6000 : 2500);
}

function current() {
  return snaps.find((r) => r.key === currentKey) || null;
}

function snapName(rec) {
  if (rec.own) return tr('snap.mine');
  return rec.snap.author ? tr('snap.of', { name: rec.snap.author }) : tr('snap.friend');
}

function feedOf(rec, type) {
  return rec.snap.feeds.find((f) => f.type === type) || null;
}

/** Сохранение с запасом: если место кончилось (localStorage ~5 МБ), удаляем самые старые снимки. */
/**
 * Запись библиотеки откладываем на 400 мс: при быстрых кликах («просмотрено», «скрыть»)
 * вся библиотека пишется один раз, а не на каждый клик. При закрытии вкладки — сразу.
 */
let saveTimer = 0;
let saveWaiters = [];
function saveSnaps() {
  clearTimeout(saveTimer);
  return new Promise((resolve) => {
    saveWaiters.push(resolve);
    saveTimer = setTimeout(flushSnaps, 400);
  });
}

async function flushSnaps() {
  clearTimeout(saveTimer);
  const waiters = saveWaiters;
  saveWaiters = [];
  await writeSnaps();
  waiters.forEach((r) => r());
}

addEventListener('pagehide', () => saveWaiters.length && flushSnaps());

async function writeSnaps() {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await store.set('yfs_feeds', snaps);
      return;
    } catch (err) {
      const victim = snaps.filter((r) => r.key !== currentKey).sort((a, b) => a.importedAt - b.importedAt)[0];
      if (!victim) {
        toast(tr('toast.saveFailed', { error: err.message }), true);
        return;
      }
      snaps = snaps.filter((r) => r !== victim);
      toast(tr('toast.storageFull'), true);
    }
  }
}

function saveSettings() {
  return store.set('yfs_viewer', settings).catch(() => {});
}

// ---------- тема и PRO ----------

const THEMES = ['auto', 'light', 'dark'];


function applyTheme() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  $('themeBtn').title = tr('theme.title', { name: tr('theme.' + settings.theme) });
}

function applyPro() {
  $('proBtn').hidden = !!settings.pro;
  $('proBadge').hidden = !settings.pro;
  $('proMark').hidden = !settings.pro;
}

function openPro() {
  YFS.pro.open({
    active: !!settings.pro,
    onActivated() {
      settings.pro = true;
      saveSettings();
      applyPro();
    },
  });
}

// ---------- импорт ----------

/** Ключ снимка; для одиночной «Главной» совпадает с ключом версии 1, чтобы повторный импорт не плодил дубли. */
function snapKey(snap) {
  if (snap.feeds.length === 1 && snap.feeds[0].type === 'home') {
    return 'f' + hashString(snap.exportedAt + '|' + snap.feeds[0].videos.map((v) => v.id).join('')).toString(36);
  }
  const ids = snap.feeds.map((f) => f.type + ':' + f.videos.map((v) => v.id).join('')).join('|');
  return 's' + hashString(snap.exportedAt + '|' + ids).toString(36);
}

async function importSnapshot(snap, { own = false, select: doSelect = true } = {}) {
  const key = snapKey(snap);
  let rec = snaps.find((r) => r.key === key);
  if (rec) {
    if (doSelect) toast(tr('toast.alreadyLoaded'));
  } else {
    rec = { key, importedAt: Date.now(), own, snap, hidden: [], watched: [] };
    snaps.unshift(rec);
    if (snaps.length > MAX_SNAPS) snaps.length = MAX_SNAPS;
    await saveSnaps();
    if (doSelect) toast(tr('toast.loaded', { count: videosWord(F.totalVideos(snap)) }));
  }
  if (doSelect) await select(key);
  return rec;
}

async function importText(text, opts) {
  return importSnapshot(await F.decodeSnapshot(text), opts);
}

async function importFiles(files, opts) {
  let last = null;
  for (const file of Array.from(files)) {
    if (file.size > 20 * 1024 * 1024) {
      toast(tr('toast.fileTooBig', { name: file.name }), true);
      continue;
    }
    try {
      last = await importText(await file.text(), opts);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, true);
    }
  }
  return last;
}

async function handleHash() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    if (hash === 'pro') {
      setTimeout(openPro, 300);
    } else if (hash === 'local=last') {
      const last = IS_EXT ? await store.get('yfs_last', null) : null;
      const data = last && (last.snap || last.feed);
      if (data) await importSnapshot(F.normalizeSnapshot(data), { own: true });
    } else if (/YFS[12]\./.test(hash)) {
      await importText(decodeURIComponent(hash));
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function resolveViewerBase() {
  if (location.protocol === 'https:' || location.protocol === 'http:') return location.origin + location.pathname;
  if (IS_EXT) {
    const opts = await store.get('yfs_opts', {});
    if (opts && opts.viewerUrl && F.buildShareLink('x', opts.viewerUrl)) return opts.viewerUrl;
  }
  return null;
}

/** Записи версии 1 хранили одну ленту в поле feed — переводим их в снимки. */
function migrate(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || !r.key) continue;
    try {
      const snap = r.snap ? r.snap : F.normalizeSnapshot(r.feed);
      const { feed, ...rest } = r;
      out.push({ hidden: [], watched: [], ...rest, snap });
    } catch {
      /* битая запись — пропускаем */
    }
  }
  return out;
}

// ---------- сравнение ----------

/** База для «Что нового?»: выбранный снимок или предыдущий снимок того же автора. */
function baseRec(rec) {
  if (rec.compareKey === '__none') return null;
  if (rec.compareKey) {
    const chosen = snaps.find((r) => r.key === rec.compareKey);
    if (chosen) return chosen;
  }
  const t = Date.parse(rec.snap.exportedAt);
  return (
    snaps
      .filter((r) => r !== rec && r.own === rec.own && (r.snap.author || '') === (rec.snap.author || '') && Date.parse(r.snap.exportedAt) < t)
      .sort((a, b) => Date.parse(b.snap.exportedAt) - Date.parse(a.snap.exportedAt))[0] || null
  );
}

function newIdsFor(rec, type) {
  const base = baseRec(rec);
  if (!base) return null;
  const f = feedOf(rec, type);
  const bf = feedOf(base, type);
  if (!bf) return null; // в прошлом снимке такого раздела не было — сравнивать не с чем
  const baseIds = new Set(bf.videos.map((v) => v.id));
  return new Set((f ? f.videos : []).filter((v) => !baseIds.has(v.id)).map((v) => v.id));
}

// ---------- выборка ----------

function dayAgo(day, exportedAt) {
  const ref = F.localDay(new Date(exportedAt));
  return Math.round((new Date(ref + 'T00:00:00') - new Date(day + 'T00:00:00')) / 86400000);
}

function matchesDuration(v) {
  if (view.dur === 'any') return true;
  const sec = F.durationToSeconds(v.duration);
  if (sec === null) return true; // длительность неизвестна — не отбрасываем ролик
  if (view.dur === 'short') return sec < 240;
  if (view.dur === 'mid') return sec >= 240 && sec <= 1200;
  return sec > 1200;
}

function filtered(rec, type) {
  const f = feedOf(rec, type);
  if (!f) return [];
  const hidden = new Set(rec.hidden);
  const watched = new Set(rec.watched);
  const newIds = view.onlyNew ? newIdsFor(rec, type) : null;
  const q = view.q.trim().toLowerCase();
  const list = videosOf(rec, type).filter((v) => {
    if (view.showHidden !== hidden.has(v.id)) return false;
    if (view.filter === 'watched' && !watched.has(v.id)) return false;
    if (view.filter === 'unwatched' && watched.has(v.id)) return false;
    if (newIds && !newIds.has(v.id)) return false;
    if (type !== 'shorts' && !matchesDuration(v)) return false;
    if (view.channel && (view.channel === '__none' ? !!A.channelKey(v) : A.channelKey(v) !== view.channel)) return false;
    if (type === 'history' && view.period !== 'all') {
      if (!v.watchedDay) return false;
      const ago = dayAgo(v.watchedDay, rec.snap.exportedAt);
      if (view.period === 'today' ? ago !== 0 : ago < 0 || ago > 6) return false;
    }
    return !q || `${v.title || ''} ${v.channel || ''} ${v.id}`.toLowerCase().includes(q);
  });

  const secs = (v) => F.durationToSeconds(v.duration);
  if (view.sort === 'shortFirst') list.sort((a, b) => (secs(a) ?? Infinity) - (secs(b) ?? Infinity));
  else if (view.sort === 'longFirst') list.sort((a, b) => (secs(b) ?? -1) - (secs(a) ?? -1));
  else if (view.sort === 'channel') list.sort((a, b) => (a.channel ? 0 : 1) - (b.channel ? 0 : 1) || (a.channel || '').localeCompare(b.channel || '', I18N.locale()));
  else if (view.sort === 'views') {
    const views = (v) => A.parseViews(v.views);
    list.sort((a, b) => (views(b) ?? -1) - (views(a) ?? -1)); // без просмотров — в конце
  }
  return list;
}

// ---------- карточки ----------

function fillAvatar(box, v) {
  box.replaceChildren();
  box.style.background = '';
  const letter = () => {
    const name = (v.channel || v.title || '?').trim();
    box.textContent = (name[0] || '?').toUpperCase();
    box.style.background = `hsl(${hashString(name) % 360} 45% 45%)`;
  };
  if (!v.avatar) return letter();
  const img = el('img', { src: v.avatar, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
  img.addEventListener('error', () => {
    img.remove();
    letter();
  });
  box.append(img);
}

function card(v, isWatched) {
  // Удалённый ролик: превью всё равно 404 — не запрашиваем его повторно.
  const img = el('img', { src: v.gone ? undefined : F.thumbUrl(v.id), alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' });
  img.addEventListener('error', () => {
    if (img.dataset.fallback) return;
    img.dataset.fallback = '1';
    img.src = F.thumbUrl(v.id, 'hqdefault');
  });

  const thumb = el('a', { className: 'thumb', href: F.watchUrl(v), target: '_blank', rel: 'noopener noreferrer' }, img);
  if (v.live) thumb.append(el('span', { className: 'badge live' }, tr('badge.live')));
  else if (v.upcoming) thumb.append(el('span', { className: 'badge' }, tr('badge.upcoming')));
  else if (v.duration) thumb.append(el('span', { className: 'badge' }, v.duration));
  if (v.short) thumb.append(el('span', { className: 'badge left' }, 'Shorts'));
  // Прогресс из истории отправителя (сколько он досмотрел).
  if (v.progress && !isWatched) thumb.append(el('span', { className: 'progress', style: `width:${v.progress}%` }));

  const actions = el(
    'div',
    { className: 'hover-actions' },
    el(
      'button',
      { type: 'button', dataset: { act: 'watched' }, title: isWatched ? tr('action.unwatch') : tr('action.markWatched') },
      svgIcon(isWatched ? ICONS.uncheck : ICONS.check)
    ),
    el(
      'button',
      { type: 'button', dataset: { act: 'hide' }, title: view.showHidden ? tr('action.restore') : tr('action.hide') },
      svgIcon(view.showHidden ? ICONS.restore : ICONS.hide)
    )
  );

  const avatar = el('span', { className: 'avatar' });
  fillAvatar(avatar, v);
  const channel = v.channelUrl
    ? el('a', { className: 'channel', href: F.channelHref(v), target: '_blank', rel: 'noopener noreferrer' }, v.channel || tr('video.channel'))
    : el('span', { className: 'channel' }, v.channel || '');
  const quality = E.quality(v);
  // Значок — только когда не хватает названия или канала; одной длительности мало для шума на каждой карточке.
  const qBadge =
    quality === 'full' || (v.title && v.channel)
      ? null
      : el('span', { className: 'q q-' + quality, title: quality === 'id' ? tr('quality.idTitle') : tr('quality.partialTitle') }, quality === 'id' ? '○ ID' : '◐');
  const sub = v.title
    ? el('span', { className: 'sub' }, [v.views, v.published].filter(Boolean).join(' • '))
    : el('a', { className: 'sub watch-link', href: F.watchUrl(v), target: '_blank', rel: 'noopener noreferrer' }, tr('video.watchOnYoutube'));

  return el(
    'article',
    { className: 'card' + (isWatched ? ' watched' : ''), dataset: { id: v.id } },
    el('div', { className: 'thumb-wrap' }, thumb, actions),
    el(
      'div',
      { className: 'meta' },
      avatar,
      el(
        'div',
        { className: 'text' },
        el('h3', { className: 'title' + (v.title ? '' : ' unknown'), title: titleOf(v) }, qBadge, titleOf(v)),
        channel,
        sub
      )
    )
  );
}

function dayHeading(day, exportedAt, count) {
  let label;
  if (!day) label = tr('day.unknown');
  else {
    const ago = dayAgo(day, exportedAt);
    label =
      ago === 0
        ? tr('day.today')
        : ago === 1
          ? tr('day.yesterday')
          : new Date(day + 'T00:00:00').toLocaleDateString(I18N.locale(), { weekday: 'long', day: 'numeric', month: 'long' });
    label = label[0].toUpperCase() + label.slice(1);
  }
  return el('h2', { className: 'day-head' }, label, el('span', { className: 'muted' }, videosWord(count)));
}

// ---------- отрисовка: боковая панель, шапка, вкладки ----------

function renderSidebar() {
  const list = $('feedList');
  list.replaceChildren();
  if (!snaps.length) {
    list.append(el('p', { className: 'side-hint' }, tr('sidebar.empty')));
    return;
  }
  for (const rec of snaps) {
    const icons = rec.snap.feeds.map((f) => TAB_ICONS[f.type]).join('');
    const open = el(
      'button',
      { type: 'button' },
      el('span', { className: 'name' }, snapName(rec)),
      el(
        'span',
        { className: 'sub' },
        `${formatDate(rec.snap.exportedAt)} · `,
        el('span', { className: 'icons' }, icons),
        ` ${F.totalVideos(rec.snap)}`
      )
    );
    open.addEventListener('click', () => {
      select(rec.key);
      document.body.classList.remove('sidebar-open');
    });
    list.append(el('div', { className: 'feed-item' + (rec.key === currentKey ? ' active' : '') }, open));
  }
}

function renderHeader(rec) {
  $('ownBanner').hidden = !rec.own;
  $('feedTitle').textContent = snapName(rec);
  const sections = rec.snap.feeds.length;
  $('feedMeta').textContent = tr('header.meta', {
    sections: tr('n.sections', { n: sections }),
    videos: videosWord(F.totalVideos(rec.snap)),
    date: formatDate(rec.snap.exportedAt, true),
  });
  $('shareBtn').textContent = viewerBase ? tr('share.copyLink') : tr('share.copyCode');
  document.title = `${snapName(rec)} — Feed Share`;
}

function renderTabs(rec) {
  const tabs = $('tabs');
  tabs.replaceChildren();
  const items = rec.snap.feeds.map((f) => ({ id: f.type, title: feedTitle(f.type), n: f.videos.length - f.videos.filter((v) => rec.hidden.includes(v.id)).length }));
  items.push({ id: 'overview', title: tr('tab.overview') });
  for (const t of items) {
    const btn = el(
      'button',
      { className: 'tab' + (view.tab === t.id ? ' active' : ''), type: 'button', role: 'tab', dataset: { tab: t.id } },
      `${TAB_ICONS[t.id]} ${t.title}`,
      t.n !== undefined ? el('span', { className: 'num' }, String(t.n)) : null
    );
    btn.setAttribute('aria-selected', String(view.tab === t.id));
    tabs.append(btn);
  }
}

function renderToolbar(rec) {
  const type = view.tab;
  const isFeed = type !== 'overview';
  $('toolbar').hidden = !isFeed;
  $('search').disabled = !isFeed;
  if (!isFeed) return;

  $('periodGroup').hidden = type !== 'history';
  $('durGroup').hidden = type === 'shorts';
  for (const group of document.querySelectorAll('.chip-group')) {
    for (const c of group.children) c.classList.toggle('active', c.dataset.value === view[group.dataset.group]);
  }
  $('sort').value = view.sort;

  // Каналы текущего раздела — от самых частых.
  const f = feedOf(rec, type);
  const shown = videosOf(rec, type);
  const stats = A.feedStats(shown);
  const unknown = shown.filter((v) => !A.channelKey(v)).length;
  const sel = $('channelSel');
  sel.replaceChildren(el('option', { value: '' }, tr('channels.all', { n: stats.channels })));
  for (const c of stats.topChannels) {
    sel.append(el('option', { value: A.channelKey(c) }, `${c.name || tr('channels.untitled')} (${c.count})`));
  }
  if (unknown) sel.append(el('option', { value: '__none' }, tr('channels.unknown', { n: unknown })));
  if (view.channel && view.channel !== '__none' && !stats.topChannels.some((c) => A.channelKey(c) === view.channel)) view.channel = '';
  if (view.channel === '__none' && !unknown) view.channel = '';
  sel.value = view.channel;

  const newIds = newIdsFor(rec, type);
  const newBtn = $('newBtn');
  newBtn.classList.toggle('active', view.onlyNew);
  newBtn.textContent = newIds ? tr('new.withCount', { n: newIds.size }) : tr('new.button');

  const toggle = $('hiddenToggle');
  const hiddenHere = f ? f.videos.filter((v) => rec.hidden.includes(v.id)).length : 0;
  toggle.hidden = !hiddenHere && !view.showHidden;
  toggle.classList.toggle('active', view.showHidden);
  toggle.textContent = view.showHidden ? tr('hidden.back') : tr('hidden.count', { n: hiddenHere });
}

function renderCountLine(rec, type) {
  const f = feedOf(rec, type);
  const hiddenHere = f ? f.videos.filter((v) => rec.hidden.includes(v.id)).length : 0;
  const total = (f ? f.videos.length : 0) - hiddenHere;
  let text = view.showHidden
    ? tr(rec.own ? 'count.hiddenOwn' : 'count.hidden', { count: videosWord(hiddenHere) })
    : tr('count.shown', { shown: visible.length, total });
  if (view.onlyNew) {
    const base = baseRec(rec);
    if (base) text += ' · ' + tr('count.newSince', { date: formatDate(base.snap.exportedAt) });
  }
  const q = { full: 0, partial: 0, id: 0 };
  for (const v of visible) q[E.quality(v)]++;
  if (q.partial || q.id) {
    text += ' · ' + tr('count.quality', { full: q.full, partial: q.partial, id: q.id });
    if (enricher && enricher.pending()) text += ' · ' + tr('count.restoring');
  }
  $('countLine').textContent = text;
}

function renderGrid(rec) {
  const type = view.tab;
  visible = filtered(rec, type);
  renderCountLine(rec, type);
  const watched = new Set(rec.watched);
  const grid = $('grid');
  grid.replaceChildren();
  if (!visible.length) {
    let msg = tr('grid.nothing');
    if (view.showHidden) msg = tr('grid.noHidden');
    else if (view.onlyNew) msg = tr('grid.noNew');
    grid.append(el('p', { className: 'empty-filter' }, msg));
    return;
  }
  const frag = document.createDocumentFragment();
  const groupByDay = type === 'history' && view.sort === 'feed';
  let lastDay = null;
  for (let i = 0; i < visible.length; i++) {
    const v = visible[i];
    if (groupByDay && (v.watchedDay || '') !== lastDay) {
      lastDay = v.watchedDay || '';
      let n = 0;
      for (let j = i; j < visible.length && (visible[j].watchedDay || '') === lastDay; j++) n++;
      frag.append(dayHeading(lastDay, rec.snap.exportedAt, n));
    }
    frag.append(card(v, watched.has(v.id)));
  }
  grid.append(frag);
  if (enricher) enricher.want(visible); // список уже на экране, метаданные подтянутся постепенно
}

function renderSnap() {
  const rec = current();
  $('empty').hidden = !!rec;
  $('snapView').hidden = !rec;
  if (!rec) {
    stopShort();
    return;
  }
  const types = rec.snap.feeds.map((f) => f.type);
  if (view.tab !== 'overview' && !types.includes(view.tab)) view.tab = types[0];

  renderHeader(rec);
  renderTabs(rec);
  renderToolbar(rec);

  const tab = view.tab;
  $('grid').hidden = tab === 'overview' || tab === 'shorts';
  $('countLine').hidden = tab === 'overview';
  $('shortsView').hidden = tab !== 'shorts';
  $('overview').hidden = tab !== 'overview';
  if (tab !== 'shorts') stopShort();

  if (tab === 'overview') renderOverview(rec);
  else if (tab === 'shorts') renderShorts(rec);
  else renderGrid(rec);
}

function render() {
  renderSidebar();
  renderSnap();
}

function resetView() {
  Object.assign(view, { filter: 'all', dur: 'any', period: 'all', channel: '', showHidden: false, onlyNew: false });
}

async function select(key) {
  if (key !== currentKey) {
    resetView();
    view.tab = '';
    shortIndex = 0;
  }
  currentKey = key;
  settings.lastKey = key;
  await saveSettings();
  render();
  window.scrollTo(0, 0);
}

function switchTab(tab) {
  if (view.tab === tab) return;
  view.tab = tab;
  Object.assign(view, { channel: '', showHidden: false, period: 'all', onlyNew: false });
  shortIndex = 0;
  renderSnap();
  if (tab === 'shorts') document.querySelector('.short-stage').scrollIntoView({ block: 'center' });
}

// ---------- Shorts: вертикальный просмотр ----------

function stopShort() {
  if (shortPlayingId) $('shortPlayer').src = 'about:blank';
  shortPlayingId = null;
}

function renderShorts(rec) {
  visible = filtered(rec, 'shorts');
  renderCountLine(rec, 'shorts');
  const stage = document.querySelector('.short-stage');
  if (!visible.length) {
    stopShort();
    stage.hidden = true;
    $('countLine').hidden = false;
    $('countLine').textContent = tr(view.onlyNew ? 'shorts.noNew' : view.showHidden ? 'shorts.noHidden' : 'shorts.nothing');
    return;
  }
  stage.hidden = false;
  shortIndex = Math.max(0, Math.min(shortIndex, visible.length - 1));
  showShort(rec);
  // Сначала текущий и соседние шорты, потом остальные.
  if (enricher) enricher.want(visible.slice(shortIndex).concat(visible.slice(0, shortIndex)));
}

function showShort(rec) {
  const v = visible[shortIndex];
  if (shortPlayingId !== v.id) {
    shortPlayingId = v.id;
    loadPlayer($('shortPlayer'), v, { loop: true });
  }
  const channel = $('shortChannel');
  channel.textContent = v.channel ? '@' + v.channel.replace(/^@/, '') : '';
  if (v.channelUrl) channel.href = F.channelHref(v);
  else channel.removeAttribute('href');
  $('shortTitle').textContent = titleOf(v, tr('video.unknownShort'));
  $('shortCounter').textContent = `${shortIndex + 1} / ${visible.length}`;
  $('shortPrev').disabled = shortIndex === 0;
  $('shortNext').disabled = shortIndex >= visible.length - 1;
  const watched = rec.watched.includes(v.id);
  $('shortWatched').classList.toggle('active', watched);
  $('shortWatched').title = watched ? tr('action.unwatch') : tr('action.markWatched');
  $('shortWatchedMark').hidden = !watched;
  $('shortHide').title = view.showHidden ? tr('action.restore') : tr('action.hide');
  $('shortYoutube').href = F.watchUrl(v);
  YFS.textPanel.follow(v, $('shortPlayer'), $('shortsView'));
}

function stepShort(delta) {
  const rec = current();
  if (!rec || view.tab !== 'shorts') return;
  const next = shortIndex + delta;
  if (next < 0 || next >= visible.length) return;
  shortIndex = next;
  showShort(rec);
}

// ---------- обзор: статистика и сравнение ----------

function statCard(label, big, lines, hero) {
  return el(
    'div',
    { className: 'stat-card' + (hero ? ' hero' : '') },
    el('div', { className: 'label' }, label),
    el('div', { className: 'big' }, big),
    ...lines.filter(Boolean).map((l) => el('div', { className: 'line muted' }, l))
  );
}

function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return el(
    'div',
    { className: 'bars' },
    ...rows.map((r) =>
      el(
        'div',
        { className: 'bar-row' },
        el('span', { className: 'name', title: r.name }, r.name),
        el('div', { className: 'bar-track' }, el('div', { className: 'bar-fill', style: `width:${Math.round((r.n / max) * 100)}%` })),
        el('span', { className: 'n' }, String(r.n))
      )
    )
  );
}

/** Снимок без скрытых роликов — его показываем в статистике и отдаём в экспорт. */
function visibleSnap(rec) {
  const hidden = new Set(rec.hidden);
  return {
    ...rec.snap,
    feeds: rec.snap.feeds
      .map((f) => ({ ...f, videos: f.videos.filter((v) => !hidden.has(v.id)).map(display) }))
      .filter((f) => f.videos.length),
  };
}

function renderOverview(rec) {
  const box = $('overview');
  box.replaceChildren();
  const snap = visibleSnap(rec);
  if (!snap.feeds.length) {
    box.append(el('p', { className: 'empty-filter' }, tr('overview.allHidden')));
    return;
  }
  const s = A.snapshotStats(snap);
  // «Самый частый» имеет смысл, только если у канала больше одного ролика.
  const topOf = (st) => (st.topChannels[0] && st.topChannels[0].count > 1 ? st.topChannels[0] : null);
  const top = topOf(s.total);

  const cards = el('div', { className: 'stat-grid' });
  cards.append(
    statCard(
      rec.own ? tr('overview.yours') : snapName(rec),
      videosWord(s.total.count),
      [
        channelsWord(s.total.channels),
        s.total.avgSec ? tr('stats.avgDuration', { d: A.formatDuration(s.total.avgSec) }) : '',
        top ? tr('stats.topChannel', { name: top.name, count: videosWord(top.count) }) : '',
      ],
      true
    )
  );
  if (s.history) {
    const h = s.history;
    cards.append(
      statCard(tr('stats.historyWeek'), videosWord(h.week.count), [
        tr('stats.watchTime', { time: A.formatHours(h.week.watchSec) }),
        tr('stats.today', { count: videosWord(h.today.count), time: A.formatHours(h.today.watchSec) }),
        h.undated ? tr('stats.undated', { count: videosWord(h.undated) }) : '',
      ])
    );
  }
  for (const f of snap.feeds) {
    const fs = s.feeds[f.type];
    const t = topOf(fs);
    cards.append(
      statCard(`${TAB_ICONS[f.type]} ${feedTitle(f.type)}`, videosWord(fs.count), [
        channelsWord(fs.channels),
        fs.avgSec && f.type !== 'shorts' ? tr('stats.avgDuration', { d: A.formatDuration(fs.avgSec) }) : '',
        t ? tr('stats.mostOften', { name: t.name, n: t.count }) : '',
      ])
    );
  }
  box.append(el('h2', {}, tr('overview.stats')), cards);

  const topRows = s.total.topChannels.slice(0, 10).map((c) => ({ name: c.name || tr('channels.untitled'), n: c.count }));
  if (topRows.length > 1 && top) box.append(el('h2', {}, tr('overview.topChannels')), bars(topRows));

  if (s.history && s.history.byDay.length > 1) {
    const dayRows = s.history.byDay.slice(0, 14).map((d) => ({
      name: new Date(d.day + 'T00:00:00').toLocaleDateString(I18N.locale(), { weekday: 'short', day: 'numeric', month: 'short' }),
      n: d.count,
    }));
    box.append(el('h2', {}, tr('overview.byDay')), bars(dayRows));
  }

  box.append(el('h2', {}, tr('overview.changes')), renderDiff(rec));
}

function diffList(videos, linkOnly) {
  const LIMIT = 15;
  const ul = el('ul', { className: 'diff-list' });
  for (const v of videos.slice(0, LIMIT)) {
    const label = `${titleOf(v)}${v.channel ? ' — ' + v.channel : ''}`;
    if (linkOnly) {
      ul.append(el('li', {}, el('a', { href: F.watchUrl(v), target: '_blank', rel: 'noopener noreferrer', title: label }, label)));
    } else {
      const btn = el('button', { type: 'button', title: label }, label);
      btn.addEventListener('click', () => openPlayer(v, videos));
      ul.append(el('li', {}, btn));
    }
  }
  if (videos.length > LIMIT) ul.append(el('li', { className: 'muted' }, tr('diff.more', { n: videos.length - LIMIT })));
  if (!videos.length) ul.append(el('li', { className: 'muted' }, tr('diff.none')));
  return ul;
}

function renderDiff(rec) {
  const base = baseRec(rec);
  if (!base) {
    const pick = el('button', { className: 'pill', type: 'button' }, tr('diff.pick'));
    pick.addEventListener('click', openCompare);
    return el(
      'div',
      { className: 'diff-empty' },
      tr('diff.needBase'),
      el('div', { className: 'dlg-actions' }, pick)
    );
  }
  const wrap = el('div');
  const change = el('button', { className: 'pill', type: 'button' }, tr('diff.change'));
  change.addEventListener('click', openCompare);
  wrap.append(
    el('p', { className: 'muted' }, tr('diff.comparedWith', { name: snapName(base), date: formatDate(base.snap.exportedAt, true) }) + ' ', change)
  );
  for (const d of A.diffSnapshots(base.snap, visibleSnap(rec))) {
    const title = `${TAB_ICONS[d.type]} ${feedTitle(d.type)}`;
    if (d.baseMissing) {
      wrap.append(el('div', { className: 'diff-card' }, el('h3', {}, title), el('p', { className: 'muted' }, tr('diff.baseMissing'))));
      continue;
    }
    wrap.append(
      el(
        'div',
        { className: 'diff-card' },
        el('h3', {}, title),
        el(
          'div',
          { className: 'diff-nums' },
          el('span', { className: 'plus' }, tr('diff.added', { n: d.added.length })),
          el('span', { className: 'minus' }, tr('diff.removed', { n: d.removed.length })),
          el('span', { className: 'muted' }, tr('diff.kept', { n: d.kept }))
        ),
        el(
          'div',
          { className: 'diff-cols' },
          el('div', {}, el('h4', {}, tr('diff.newTitle')), diffList(d.added, false)),
          el('div', {}, el('h4', {}, tr('diff.goneTitle')), diffList(d.removed, true))
        )
      )
    );
  }
  return wrap;
}

function openCompare() {
  const rec = current();
  if (!rec) return;
  const list = $('compareList');
  list.replaceChildren();
  const auto = baseRec({ ...rec, compareKey: '' });
  const option = (value, label) =>
    el('label', {}, el('input', { type: 'radio', name: 'base', value, checked: (rec.compareKey || '') === value }), el('span', {}, label));
  list.append(
    option('', auto ? tr('compare.auto', { date: formatDate(auto.snap.exportedAt) }) : tr('compare.autoNone'))
  );
  for (const r of snaps) {
    if (r === rec) continue;
    list.append(option(r.key, `${snapName(r)} · ${formatDate(r.snap.exportedAt, true)} · ${videosWord(F.totalVideos(r.snap))}`));
  }
  list.append(option('__none', tr('compare.none')));
  $('compareDlg').showModal();
}

async function setCompare(key) {
  const rec = current();
  if (!rec) return;
  rec.compareKey = key;
  view.onlyNew = false;
  await saveSnaps();
  view.tab = 'overview';
  renderSnap();
}

// ---------- действия с роликами ----------

function toggleIn(list, id, on) {
  const i = list.indexOf(id);
  const want = on === undefined ? i === -1 : on;
  if (want && i === -1) list.push(id);
  if (!want && i !== -1) list.splice(i, 1);
  return want;
}

async function setWatched(id, on) {
  const rec = current();
  if (!rec) return;
  toggleIn(rec.watched, id, on);
  await saveSnaps();
  renderSnap();
  if (playing) updatePlayerButtons();
}

async function toggleHidden(id) {
  const rec = current();
  if (!rec) return;
  const hidden = toggleIn(rec.hidden, id);
  await saveSnaps();
  renderSnap();
  if (playing) updatePlayerButtons();
  toast(hidden ? tr(rec.own ? 'toast.hiddenOwn' : 'toast.hidden') : tr('toast.restored'));
}

function downloadSnap() {
  const snap = visibleSnap(current());
  if (!snap.feeds.length) return toast(tr('toast.nothingToExport'), true);
  const a = el('a', {
    href: URL.createObjectURL(new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' })),
    download: F.fileName(snap),
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function shareSnap() {
  try {
    const code = await F.encodeSnapshot(visibleSnap(current()));
    const text = (viewerBase && F.buildShareLink(code, viewerBase)) || code;
    await navigator.clipboard.writeText(text);
    const what = text === code ? tr('share.codeCopied') : tr('share.linkCopied');
    if (text.length > F.MESSENGER_LIMIT) {
      toast(tr('share.tooLong', { what, n: text.length }), true);
    } else {
      toast(what);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteSnap() {
  const rec = current();
  if (!rec || !confirm(tr('confirm.delete', { name: snapName(rec), count: videosWord(F.totalVideos(rec.snap)) }))) return;
  snaps = snaps.filter((r) => r !== rec);
  for (const r of snaps) if (r.compareKey === rec.key) delete r.compareKey;
  await saveSnaps();
  await select(snaps.length ? snaps[0].key : null);
}

// ---------- плеер ----------

function openPlayer(v, list) {
  const dlg = $('playerDlg');
  if (!dlg.open) queue = (list || visible).slice();
  playing = v;
  stopShort();

  $('playerError').hidden = true;
  $('playerBox').classList.toggle('vertical', !!v.short);
  loadPlayer($('player'), v);
  $('mTitle').textContent = titleOf(v);
  const channel = $('mChannel');
  channel.textContent = v.channel || '';
  if (v.channelUrl) channel.href = F.channelHref(v);
  else channel.removeAttribute('href');
  $('mMeta').textContent = [v.views, v.published, v.duration].filter(Boolean).join(' • ');
  fillAvatar($('mAvatar'), v);
  $('mYoutube').href = F.watchUrl(v);
  $('playerErrorLink').href = F.watchUrl(v);
  updatePlayerButtons();
  if (!dlg.open) dlg.showModal();
  YFS.textPanel.follow(v, $('player'), $('playerInfo'));
}

function updatePlayerButtons() {
  const rec = current();
  if (!rec || !playing) return;
  const watched = rec.watched.includes(playing.id);
  $('mWatched').textContent = watched ? tr('action.watchedDone') : tr('action.markWatched');
  $('mWatched').classList.toggle('active', watched);
  $('mHide').textContent = rec.hidden.includes(playing.id) ? tr('action.restore') : tr('action.hide');
  const i = queue.findIndex((x) => x.id === playing.id);
  $('mPrev').disabled = i <= 0;
  $('mNext').disabled = i === -1 || i >= queue.length - 1;
}

function step(delta) {
  const i = queue.findIndex((x) => x.id === playing.id);
  const next = queue[i + delta];
  if (next) openPlayer(next);
}

function showPlayerError(code) {
  const embedProblem = code === 152 || code === 153;
  $('playerErrorText').textContent = embedProblem
    ? tr('player.errWithCode', { text: embedFailureText(), code })
    : PLAYER_ERRORS[code] ? tr(PLAYER_ERRORS[code]) : tr('player.errGeneric', { code });
  if (playing) $('playerErrorLink').href = F.watchUrl(playing);
  $('playerError').hidden = false;
}

// Сообщения IFrame API: ошибки воспроизведения и окончание ролика.
// ---------- наушники и медиаклавиши (PRO) ----------

/** «Следующий / предыдущий трек» на наушниках листает шорты и ролики в плеере, даже если окно не в фокусе. */
function mediaStep(dir) {
  if (!settings.pro) return;
  if (playing) step(dir);
  else if (view.tab === 'shorts') stepShort(dir);
}

if ('mediaSession' in navigator) {
  for (const [action, dir] of [['nexttrack', 1], ['previoustrack', -1]]) {
    try {
      navigator.mediaSession.setActionHandler(action, () => mediaStep(dir));
    } catch {
      /* действие не поддерживается этим браузером */
    }
  }
}

// ---------- встраивание: обход ошибок 152/153 ----------

/**
 * Как показываем ролик:
 *   - в расширении — обычная страница ролика YouTube во фрейме (фоновый скрипт разрешает её
 *     показ во фрейме, content script frame.js оставляет только плеер). Встроенный плеер /embed
 *     на странице chrome-extension:// падает с ошибкой 152/153, а страница ролика — нет,
 *     и ничего настраивать не нужно;
 *   - на сайте или localhost — обычный встроенный плеер /embed.
 */
const FRAME_MODE = IS_EXT;

function playerOrigins() {
  return [YT_ORIGIN];
}

const frameState = new WeakMap(); // iframe → { ready, timer, fail }

function loadPlayer(frame, v, { loop = false } = {}) {
  let src;
  if (FRAME_MODE) {
    // Шорты тоже через /watch: страница /shorts/ во фрейме прячет «неактивные» ролики,
    // и YouTube перестаёт рисовать кадр (звук идёт, картинка замирает).
    src = `${YT_ORIGIN}/watch?v=${v.id}${loop ? '&yfs=loop' : ''}`;
  } else {
    src = `${YT_ORIGIN}/embed/${v.id}?autoplay=1&rel=0&playsinline=1&enablejsapi=1`;
    if (/^https?:$/.test(location.protocol)) src += `&origin=${encodeURIComponent(location.origin)}`;
    if (loop) src += `&loop=1&playlist=${v.id}`;
  }
  const errorBox = frame === $('player') ? $('playerError') : $('shortError');
  errorBox.hidden = true;
  const prev = frameState.get(frame);
  if (prev) clearTimeout(prev.timer);
  // Упавший на 152/153 плеер не присылает даже onError — поэтому ждём хоть какого-то ответа:
  // несколько секунд после загрузки iframe (медленная сеть не даёт ложной тревоги), но не дольше 25 с всего.
  const state = { ready: false, timer: 0 };
  state.fail = () => {
    if (!state.ready && frame.src === src) showEmbedFailure(frame, v);
  };
  state.timer = setTimeout(state.fail, 25000);
  frameState.set(frame, state);
  frame.src = src;
}

function embedFailureText() {
  if (location.protocol === 'file:') {
    return tr('player.failFile');
  }
  if (FRAME_MODE) {
    return tr('player.failFrame');
  }
  return tr('player.failEmbed');
}

function showEmbedFailure(frame, v) {
  const isShort = frame === $('shortPlayer');
  const box = $(isShort ? 'shortError' : 'playerError');
  $(isShort ? 'shortErrorText' : 'playerErrorText').textContent = embedFailureText();
  $(isShort ? 'shortErrorLink' : 'playerErrorLink').href = F.watchUrl(v);
  // В режиме страницы ролика видео, возможно, всё же идёт — не закрываем его, а показываем подсказку снизу.
  box.classList.toggle('soft', FRAME_MODE);
  box.hidden = false;
}

/** Мини-окно с самим YouTube: там нет ограничений встраивания. */
function openMiniWindow(v) {
  const url = F.watchUrl(v);
  const size = v.short ? { width: 420, height: 780 } : { width: 1000, height: 640 };
  if (IS_EXT && chrome.windows) chrome.windows.create({ url, type: 'popup', ...size });
  else window.open(url, 'yfs-mini', `popup,width=${size.width},height=${size.height}`);
}

window.addEventListener('message', (e) => {
  if (!playerOrigins().includes(e.origin)) return;
  const fromPlayer = !!playing && e.source === $('player').contentWindow;
  const fromShort = !!shortPlayingId && e.source === $('shortPlayer').contentWindow;
  if (!fromPlayer && !fromShort) return;
  let data;
  try {
    data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
  } catch {
    return;
  }
  if (!data) return;
  const frame = fromPlayer ? $('player') : $('shortPlayer');
  const st = frameState.get(frame);
  if (st && !st.ready) {
    st.ready = true; // плеер жив
    clearTimeout(st.timer);
    $(fromPlayer ? 'playerError' : 'shortError').hidden = true;
  }

  // Сообщения от страницы ролика (frame.js).
  if (data.yfs === 'frame') {
    if (data.event === 'transcript') {
      YFS.textPanel.onFrameReply(data);
      return;
    }
    if (data.event === 'media-next' || data.event === 'media-prev') {
      mediaStep(data.event === 'media-next' ? 1 : -1);
      return;
    }
    if (data.event === 'ended' && fromPlayer) setWatched(playing.id, true);
    if (data.event === 'playing' && fromShort && current() && !current().watched.includes(shortPlayingId)) setWatched(shortPlayingId, true);
    return;
  }

  // Сообщения IFrame API встроенного плеера.
  if (data.event === 'onError' && fromPlayer) showPlayerError(data.info);
  const state = data.event === 'onStateChange' ? data.info : data.event === 'infoDelivery' && data.info ? data.info.playerState : null;
  if (state === 0 && fromPlayer) setWatched(playing.id, true); // досмотрен до конца
  // Shorts зациклены и короткие — считаем просмотренным, как только начал играть.
  if (state === 1 && fromShort && current() && !current().watched.includes(shortPlayingId)) setWatched(shortPlayingId, true);
});

for (const id of ['player', 'shortPlayer']) {
  $(id).addEventListener('load', () => {
    const frame = $(id);
    if (!frame.src.startsWith(YT_ORIGIN)) return;
    const st = frameState.get(frame);
    if (st && !st.ready) {
      clearTimeout(st.timer);
      // Странице ролика нужно больше времени, чем встроенному плееру.
      st.timer = setTimeout(st.fail, FRAME_MODE ? 12000 : 6000);
    }
    if (FRAME_MODE) return; // страница ролика сама сообщит о себе через frame.js
    // Несколько попыток: плеер внутри мог ещё не успеть подписаться.
    for (const delay of [0, 1000, 3000]) {
      setTimeout(() => {
        try {
          frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'yfs-' + id, channel: 'widget' }), YT_ORIGIN);
        } catch {
          /* без IFrame API просто не будет автоотметки */
        }
      }, delay);
    }
  });
}

$('playerMini').addEventListener('click', () => playing && openMiniWindow(playing));
$('shortMini').addEventListener('click', () => {
  const v = visible[shortIndex];
  if (v) openMiniWindow(v);
});

$('playerDlg').addEventListener('close', () => {
  YFS.textPanel.hide();
  $('player').src = 'about:blank';
  playing = null;
  if (view.tab === 'shorts') renderSnap(); // вернуть шорт, остановленный на время плеера
});

// ---------- события ----------

$('grid').addEventListener('click', (e) => {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const id = cardEl.dataset.id;
  const act = e.target.closest('button[data-act]');
  if (act) {
    e.preventDefault();
    if (act.dataset.act === 'watched') setWatched(id);
    else toggleHidden(id);
    return;
  }
  if (!e.target.closest('.thumb, .title')) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey) return; // открыть на YouTube в новой вкладке
  e.preventDefault();
  const v = visible.find((x) => x.id === id);
  if (v) openPlayer(v, visible);
});

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});

for (const group of document.querySelectorAll('.chip-group')) {
  group.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    view[group.dataset.group] = chip.dataset.value;
    shortIndex = 0;
    renderSnap();
  });
}

$('newBtn').addEventListener('click', () => {
  const rec = current();
  if (!rec) return;
  if (!baseRec(rec)) {
    toast(tr('new.needBase'));
    openCompare();
    return;
  }
  if (!view.onlyNew && !newIdsFor(rec, view.tab)) {
    toast(tr('new.noSection', { title: feedTitle(view.tab) }));
    return;
  }
  view.onlyNew = !view.onlyNew;
  shortIndex = 0;
  renderSnap();
});

$('channelSel').addEventListener('change', () => {
  view.channel = $('channelSel').value;
  shortIndex = 0;
  renderSnap();
});

$('sort').addEventListener('change', () => {
  view.sort = $('sort').value;
  renderSnap();
});

$('hiddenToggle').addEventListener('click', () => {
  view.showHidden = !view.showHidden;
  shortIndex = 0;
  renderSnap();
});

let meowShown = false;
$('search').addEventListener('input', () => {
  view.q = $('search').value;
  shortIndex = 0;
  renderSnap();
  if (!meowShown && /^(мяу|meow|miau|miaou|nyan|喵|ニャー)$/i.test(view.q.trim())) {
    meowShown = true;
    toast(tr(settings.pro ? 'meow.pro' : 'meow.free'));
  }
});

$('dlBtn').addEventListener('click', downloadSnap);
$('shareBtn').addEventListener('click', shareSnap);
$('compareBtn').addEventListener('click', openCompare);
$('deleteBtn').addEventListener('click', deleteSnap);
$('mWatched').addEventListener('click', () => playing && setWatched(playing.id));
$('mHide').addEventListener('click', () => playing && toggleHidden(playing.id));
$('mPrev').addEventListener('click', () => step(-1));
$('mNext').addEventListener('click', () => step(1));
$('mText').addEventListener('click', () => playing && YFS.textPanel.open({ video: playing, frame: $('player'), container: $('playerInfo'), tab: 'text' }));
$('mSummary').addEventListener('click', () => playing && YFS.textPanel.open({ video: playing, frame: $('player'), container: $('playerInfo'), tab: 'summary' }));

$('shortPrev').addEventListener('click', () => stepShort(-1));
$('shortNext').addEventListener('click', () => stepShort(1));
$('shortWatched').addEventListener('click', () => shortPlayingId && setWatched(shortPlayingId));
$('shortHide').addEventListener('click', () => shortPlayingId && toggleHidden(shortPlayingId));
for (const [id, tab] of [['shortText', 'text'], ['shortSummary', 'summary']]) {
  $(id).addEventListener('click', () => {
    const v = visible[shortIndex];
    if (v) YFS.textPanel.open({ video: v, frame: $('shortPlayer'), container: $('shortsView'), tab });
  });
}

let wheelLock = 0;
document.querySelector('.short-stage').addEventListener(
  'wheel',
  (e) => {
    if (Math.abs(e.deltaY) < 10) return;
    e.preventDefault();
    if (Date.now() < wheelLock) return;
    wheelLock = Date.now() + 600;
    stepShort(e.deltaY > 0 ? 1 : -1);
  },
  { passive: false }
);

$('compareForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const checked = $('compareList').querySelector('input:checked');
  $('compareDlg').close();
  setCompare(checked ? checked.value : '');
});

$('compareFile').addEventListener('change', async () => {
  const file = $('compareFile').files[0];
  $('compareFile').value = '';
  if (!file) return;
  const target = currentKey;
  const rec = await importFiles([file], { select: false });
  $('compareDlg').close();
  if (!rec) return;
  if (rec.key === target) return toast(tr('toast.sameSnapshot'), true);
  renderSidebar();
  await setCompare(rec.key);
  toast(tr('toast.baseLoaded'));
});

$('themeBtn').addEventListener('click', () => {
  settings.theme = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length];
  applyTheme();
  saveSettings();
});

$('proBtn').addEventListener('click', openPro);
$('proBadge').addEventListener('click', openPro);

$('menuBtn').addEventListener('click', () => {
  const narrow = matchMedia('(max-width: 1000px)').matches;
  document.body.classList.toggle(narrow ? 'sidebar-open' : 'sidebar-collapsed');
});

$('main').addEventListener('click', () => document.body.classList.remove('sidebar-open'));

$('logo').addEventListener('click', (e) => {
  e.preventDefault();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || (e.target.closest && e.target.closest('input, textarea, select'))) return;
  if (e.key === '/') {
    e.preventDefault();
    $('search').focus();
  } else if (view.tab === 'shorts' && ['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) {
    e.preventDefault();
    stepShort(e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1);
  }
});

// Диалоги: закрытие по кнопке и по клику на фон.
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return dlg.close();
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dlg.close();
  });
}

// Импорт: диалог, файл, вставка, перетаскивание.
function openImport() {
  $('importError').hidden = true;
  $('importText').value = '';
  $('importDlg').showModal();
  $('importText').focus();
}

$('importBtn').addEventListener('click', openImport);
$('emptyImport').addEventListener('click', openImport);

$('importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await importText($('importText').value);
    $('importDlg').close();
  } catch (err) {
    $('importError').textContent = err.message;
    $('importError').hidden = false;
  }
});

$('fileInput').addEventListener('change', async () => {
  const files = $('fileInput').files;
  $('importDlg').close();
  await importFiles(files);
  $('fileInput').value = '';
});

document.addEventListener('paste', async (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  const data = e.clipboardData;
  if (!data) return;
  if (data.files && data.files.length) {
    e.preventDefault();
    return importFiles(data.files);
  }
  const text = data.getData('text');
  if (!text) return;
  e.preventDefault();
  try {
    await importText(text);
  } catch (err) {
    toast(err.message, true);
  }
});

let dragDepth = 0;
const draggingData = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).some((t) => t === 'Files' || t === 'text/plain');

window.addEventListener('dragenter', (e) => {
  if (!draggingData(e)) return;
  dragDepth++;
  $('dropOverlay').hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!draggingData(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('dropOverlay').hidden = true;
  }
});
window.addEventListener('dragover', (e) => {
  if (draggingData(e)) e.preventDefault();
});
window.addEventListener('drop', async (e) => {
  if (!draggingData(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  if (e.dataTransfer.files.length) return importFiles(e.dataTransfer.files);
  try {
    await importText(e.dataTransfer.getData('text/plain'));
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- восстановление метаданных ----------

let patchIds = new Set();
let patchTimer = 0;

/** Пришли метаданные — точечно обновляем карточки, не перерисовывая ленту и не меняя порядок. */
function onEnriched(id) {
  patchIds.add(id);
  clearTimeout(patchTimer);
  patchTimer = setTimeout(applyPatches, 150);
}

function applyPatches() {
  const ids = patchIds;
  patchIds = new Set();
  const rec = current();
  if (!rec) return;
  const watched = new Set(rec.watched);
  for (let i = 0; i < visible.length; i++) {
    if (!ids.has(visible[i].id)) continue;
    visible[i] = display(visible[i]);
    const node = $('grid').querySelector(`.card[data-id="${visible[i].id}"]`);
    if (node) node.replaceWith(card(visible[i], watched.has(visible[i].id)));
  }
  if (view.tab === 'shorts' && shortPlayingId && ids.has(shortPlayingId) && visible[shortIndex]) showShort(rec);
  if (playing && ids.has(playing.id)) {
    playing = display(playing);
    $('mTitle').textContent = titleOf(playing);
    $('mChannel').textContent = playing.channel || '';
    if (playing.channelUrl) $('mChannel').href = F.channelHref(playing);
    $('mMeta').textContent = [playing.views, playing.published, playing.duration].filter(Boolean).join(' • ');
  }
  if (view.tab !== 'overview') renderCountLine(rec, view.tab);
}

$('refreshBtn').addEventListener('click', () => {
  const rec = current();
  if (!rec || !enricher) return;
  const all = rec.snap.feeds.flatMap((f) => f.videos.map(display));
  const n = enricher.refresh(all.filter((v) => E.quality(v) !== 'full'));
  toast(n ? tr('toast.refreshing', { count: videosWord(n) }) : tr('toast.allData'));
  renderSnap();
});

window.addEventListener('hashchange', async () => {
  await handleHash();
  render();
});

// ---------- запуск ----------

async function init() {
  await I18N.init(); // язык интерфейса — до первой отрисовки
  I18N.onChange(() => location.reload());
  YFS.textPanel.init({
    store,
    toast,
    frameMode: FRAME_MODE,
    // «Все пресеты — в настройках»: только в расширении (на размещённом просмотрщике страницы настроек нет).
    openSettings: IS_EXT ? (id) => chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#prompt=' + encodeURIComponent(id)) }) : null,
  });
  const [savedSnaps, savedSettings] = await Promise.all([store.get('yfs_feeds', []), store.get('yfs_viewer', {})]);
  snaps = migrate(savedSnaps);
  settings = { ...settings, ...savedSettings };
  if (!THEMES.includes(settings.theme)) settings.theme = 'auto';
  applyTheme();
  applyPro();
  viewerBase = await resolveViewerBase();
  currentKey = snaps.some((r) => r.key === settings.lastKey) ? settings.lastKey : snaps.length ? snaps[0].key : null;
  try {
    enricher = await E.createEnricher({
      load: () => store.get('yfs_meta', {}),
      save: (data) => store.set('yfs_meta', data).catch(() => {}),
      watchPage: IS_EXT, // длительность и просмотры со страницы ролика доступны только расширению (CORS)
      onUpdate: onEnriched,
    });
  } catch {
    enricher = null; // без восстановления просмотрщик всё равно работает
  }
  await handleHash();
  render();
}

init().catch((err) => toast(err.message, true));
