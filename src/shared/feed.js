/*
 * Формат снимка: схема, проверка входных данных и компактный код для ссылок.
 *
 * v2 (текущий): { format, version: 2, exportedAt, author?, lang?, feeds: [{ type, videos }] }
 * v1 (старый):  { format, version: 1, exportedAt, author?, lang?, videos }  → читается как одна лента «Главная».
 *
 * Обычный скрипт без модулей — подключается в content script, popup, viewer
 * (в том числе вне расширения) и в Node-тестах.
 */
(function (root) {
  'use strict';

  const FORMAT = 'yt-feed-share';
  const VERSION = 2;
  const CODE_PREFIX = 'YFS2.';
  const CODE_RE = /YFS[12]\.([A-Za-z0-9_-]+)/;
  const MAX_VIDEOS = 1000;
  const MAX_CODE_CHARS = 4 * 1024 * 1024;
  const MAX_INFLATED_BYTES = 16 * 1024 * 1024;
  // Telegram режет сообщения длиннее 4096 символов, Discord — 2000.
  const MESSENGER_LIMIT = 4096;

  const FEED_TYPES = {
    home: { title: 'Главная', short: 'Главная' },
    'watch-later': { title: 'Посмотреть позже', short: 'Позже' },
    history: { title: 'Просмотренное', short: 'История' },
    shorts: { title: 'Shorts', short: 'Shorts' },
  };
  const FEED_ORDER = Object.keys(FEED_TYPES);

  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const CONFIDENCE = ['high', 'medium', 'low'];
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const CHANNEL_PATH_RE = /^\/(@[^/?#\s]+|channel\/UC[\w-]{22}|c\/[^/?#\s]+|user\/[^/?#\s]+)$/;
  const IMAGE_HOST_RE = /^https:\/\/(yt3\.ggpht\.com|yt3\.googleusercontent\.com|i\.ytimg\.com|lh3\.googleusercontent\.com)\//;

  /** Ошибка с кодом: текст берётся из переводов, если они подключены, иначе — русский по умолчанию. */
  function fail(code, fallback) {
    const i18n = root.YFS && root.YFS.i18n;
    const msg = i18n ? i18n.t('err.' + code) : fallback;
    return Object.assign(new Error(msg === 'err.' + code ? fallback : msg), { code });
  }

  function str(value, max) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  }

  /** "1:02:03" → 3723, "10:23" → 623. Всё, что не похоже на длительность, → null. */
  function durationToSeconds(text) {
    if (typeof text !== 'string' || !/^\d+(:\d{1,2}){1,2}$/.test(text.trim())) return null;
    return text.trim().split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  }

  /** Исходная ссылка на ролик → относительный путь YouTube, только если она про этот же id. */
  function normalizeUrl(url, id) {
    let u = str(url, 300);
    if (!u) return '';
    u = u.replace(/^https?:\/\/(www\.|m\.)?youtube\.com/, '');
    if (!/^\/(watch\?|shorts\/)/.test(u) || !u.includes(id) || /[\s"'<>]/.test(u)) return '';
    return u;
  }

  /**
   * Ролик. Обязателен только id: всё остальное — метаданные, которые могут отсутствовать
   * (парсер нашёл лишь ссылку) и которые viewer умеет восстановить.
   */
  function normalizeVideo(v, type) {
    if (!v || typeof v !== 'object' || !ID_RE.test(v.id)) return null;
    const out = { id: v.id, title: str(v.title, 300) || null };
    const position = Math.round(Number(v.position));
    if (position > 0 && position < 100000) out.position = position;
    const url = normalizeUrl(v.url, v.id);
    if (url) out.url = url;
    const source = str(v.source, 48);
    if (/^[a-z][\w:-]*$/i.test(source)) out.source = source;
    if (CONFIDENCE.includes(v.confidence)) out.confidence = v.confidence;
    const channel = str(v.channel, 120);
    if (channel) out.channel = channel;
    const channelUrl = str(v.channelUrl, 300);
    if (CHANNEL_PATH_RE.test(channelUrl)) out.channelUrl = channelUrl;
    const avatar = str(v.avatar, 600);
    if (IMAGE_HOST_RE.test(avatar)) out.avatar = avatar;
    const duration = str(v.duration, 12);
    if (durationToSeconds(duration) !== null) out.duration = duration;
    const views = str(v.views, 80);
    if (views) out.views = views;
    const published = str(v.published, 80);
    if (published) out.published = published;
    if (v.live === true) out.live = true;
    if (v.upcoming === true) out.upcoming = true;
    if (v.short === true || type === 'shorts') out.short = true;
    // День просмотра и досмотренная доля — только у истории: это и есть её смысл.
    if (type === 'history') {
      if (DAY_RE.test(v.watchedDay) && !isNaN(Date.parse(v.watchedDay))) out.watchedDay = v.watchedDay;
      const progress = Math.round(Number(v.progress));
      if (progress > 0 && progress <= 100) out.progress = progress;
    }
    return out;
  }

  function normalizeVideos(list, type) {
    const seen = new Set();
    const out = [];
    let items = (Array.isArray(list) ? list : []).slice(0, MAX_VIDEOS);
    // Порядок ленты хранится отдельно в position: если он есть у всех — он главный.
    if (items.length && items.every((v) => v && Number(v.position) > 0)) {
      items = items.map((v, i) => [v, i]).sort((a, b) => a[0].position - b[0].position || a[1] - b[1]).map((x) => x[0]);
    }
    for (const item of items) {
      const v = normalizeVideo(item, type);
      if (v && !seen.has(v.id)) {
        seen.add(v.id);
        out.push(v);
      }
    }
    return out;
  }

  /** Приводит v1, v2 или голый массив роликов к снимку v2, иначе бросает понятную ошибку. */
  function normalizeSnapshot(raw) {
    if (Array.isArray(raw)) raw = { videos: raw };
    if (!raw || typeof raw !== 'object') throw fail('notSnapshot', 'Это не снимок: ожидался JSON-объект.');
    if (raw.format !== undefined && raw.format !== FORMAT) throw fail('unknownFormat', 'Неизвестный формат файла.');
    if (typeof raw.version === 'number' && raw.version > VERSION) {
      throw fail('newerVersion', 'Снимок создан более новой версией расширения — обновите его.');
    }

    let parts;
    if (Array.isArray(raw.feeds)) parts = raw.feeds;
    else if (Array.isArray(raw.videos)) parts = [{ type: 'home', videos: raw.videos }];
    else throw fail('noFeeds', 'В файле нет ни списка feeds, ни списка videos.');

    const byType = new Map();
    for (const part of parts.slice(0, 16)) {
      if (!part || !FEED_TYPES[part.type]) continue;
      const prev = byType.get(part.type) || [];
      byType.set(part.type, prev.concat(Array.isArray(part.videos) ? part.videos : []));
    }
    const feeds = FEED_ORDER.filter((t) => byType.has(t))
      .map((type) => ({ type, videos: normalizeVideos(byType.get(type), type) }))
      .filter((f) => f.videos.length);
    if (!feeds.length) throw fail('noVideos', 'В снимке нет ни одного корректного видео.');

    const snap = {
      format: FORMAT,
      version: VERSION,
      exportedAt: isNaN(Date.parse(raw.exportedAt)) ? new Date().toISOString() : new Date(raw.exportedAt).toISOString(),
    };
    const author = str(raw.author, 60);
    if (author) snap.author = author;
    const lang = str(raw.lang, 20);
    if (lang) snap.lang = lang;
    snap.feeds = feeds;
    return snap;
  }

  function counts(snap) {
    const out = {};
    for (const f of snap.feeds) out[f.type] = f.videos.length;
    return out;
  }

  function totalVideos(snap) {
    return snap.feeds.reduce((n, f) => n + f.videos.length, 0);
  }

  // ---------- код для ссылок ----------

  function bytesToBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(text) {
    let b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function readAll(stream, limit) {
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw fail('tooBig', 'Распакованные данные слишком большие.');
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  /**
   * Снимок → "YFS2.<deflate-raw + base64url>".
   * lite: без аватаров, просмотров, дат публикации, прогресса и служебных полей — код заметно короче.
   */
  async function encodeSnapshot(snap, { lite = false } = {}) {
    let s = normalizeSnapshot(snap);
    if (lite) {
      s = {
        ...s,
        feeds: s.feeds.map((f) => ({
          ...f,
          // Порядок задаёт сам массив, а исходные ссылки восстановимы из id.
          videos: f.videos.map(({ avatar, views, published, progress, url, source, confidence, position, ...rest }) => rest),
        })),
      };
    }
    const json = new TextEncoder().encode(JSON.stringify(s));
    const packed = await readAll(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw')), Infinity);
    return CODE_PREFIX + bytesToBase64Url(packed);
  }

  /** Принимает JSON (v1/v2), код YFS1./YFS2. или ссылку с кодом во фрагменте. */
  async function decodeSnapshot(input) {
    const text = String(input == null ? '' : input).trim();
    if (!text) throw fail('empty', 'Пустой ввод.');

    if (text[0] === '{' || text[0] === '[') {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw fail('badJson', 'Не удалось разобрать JSON.');
      }
      return normalizeSnapshot(data);
    }

    const m = text.match(CODE_RE);
    if (!m) throw fail('noCode', 'Не найден код снимка (YFS2.…), ссылка с ним или JSON.');
    if (m[1].length > MAX_CODE_CHARS) throw fail('codeTooLong', 'Код снимка слишком длинный.');

    let json;
    try {
      const inflated = await readAll(
        new Blob([base64UrlToBytes(m[1])]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
        MAX_INFLATED_BYTES
      );
      json = JSON.parse(new TextDecoder().decode(inflated));
    } catch {
      throw fail('codeBroken', 'Код повреждён или обрезан — возможно, мессенджер разрезал длинное сообщение. Передайте JSON-файлом.');
    }
    return normalizeSnapshot(json);
  }

  /** Ссылка на размещённый viewer с кодом во фрагменте (#…): фрагмент не уходит на сервер. */
  function buildShareLink(code, viewerUrl) {
    let url;
    try {
      url = new URL(viewerUrl);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url.href + '#' + code;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function localDay(date = new Date()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function fileName(snap, date = new Date(snap && snap.exportedAt ? snap.exportedAt : Date.now())) {
    return `yt_feed_${localDay(date)}.json`;
  }

  function thumbUrl(id, quality = 'mqdefault') {
    return `https://i.ytimg.com/vi/${id}/${quality}.jpg`;
  }

  function watchUrl(v) {
    return v.short ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`;
  }

  function channelHref(v) {
    return v.channelUrl ? 'https://www.youtube.com' + v.channelUrl : null;
  }

  const api = {
    FORMAT,
    VERSION,
    CODE_PREFIX,
    MESSENGER_LIMIT,
    FEED_TYPES,
    FEED_ORDER,
    ID_RE,
    durationToSeconds,
    normalizeVideo,
    normalizeSnapshot,
    counts,
    totalVideos,
    encodeSnapshot,
    decodeSnapshot,
    buildShareLink,
    localDay,
    fileName,
    thumbUrl,
    watchUrl,
    channelHref,
  };

  root.YFS = root.YFS || {};
  root.YFS.feed = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
