/*
 * Восстановление метаданных по video.id: парсер отвечает за обнаружение роликов,
 * просмотрщик — за восстановление всего остального.
 *
 *   1. oEmbed YouTube (работает и на размещённом viewer, CORS открыт): название, канал, ссылка на канал.
 *   2. Страница ролика (только внутри расширения — там нет ограничений CORS): длительность и просмотры.
 *
 * Результаты кэшируются по id (video ID → metadata), порядок ленты не трогается:
 * метаданные только заполняют пустые поля карточки, главный ключ — всегда id.
 */
(function (root) {
  'use strict';

  const F = root.YFS && root.YFS.feed ? root.YFS.feed : typeof require === 'function' ? require('../shared/feed.js') : null;

  const FIELDS = ['title', 'channel', 'channelUrl', 'duration', 'views'];
  const RETRY_MS = 10 * 60 * 1000; // временную ошибку повторяем не чаще раза в 10 минут
  const MAX_CACHE = 5000;

  /** Уровень полноты данных карточки. */
  function quality(v) {
    if (!v.title) return 'id';
    const durationKnown = v.duration || v.live || v.upcoming || v.short;
    return v.channel && durationKnown ? 'full' : 'partial';
  }

  /** Метаданные только дополняют ролик из снимка, ничего не перезаписывая. */
  function merge(v, meta) {
    if (!meta) return v;
    const out = { ...v };
    for (const k of FIELDS) if (!out[k] && meta[k]) out[k] = meta[k];
    if (meta.status === 'gone') out.gone = true;
    return out;
  }

  /** Пропускаем внешние данные через ту же проверку, что и файлы снимков. */
  function sanitize(id, fields) {
    const v = F.normalizeVideo({ id, ...fields });
    const out = {};
    for (const k of FIELDS) if (v && v[k]) out[k] = v[k];
    return out;
  }

  function parseOEmbed(id, json) {
    const author = typeof json.author_url === 'string' ? json.author_url.replace(/^https?:\/\/(www\.)?youtube\.com/, '') : '';
    return sanitize(id, { title: json.title, channel: json.author_name, channelUrl: decodeURIComponent(author) });
  }

  function jsonString(raw) {
    try {
      return JSON.parse('"' + raw + '"');
    } catch {
      return '';
    }
  }

  function formatSeconds(total) {
    const s = Math.round(Number(total));
    if (!(s > 0)) return '';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function viewsText(n) {
    const i18n = root.YFS && root.YFS.i18n;
    if (i18n) return i18n.t('n.views', { n, count: n.toLocaleString(i18n.locale()) });
    return `${n.toLocaleString('ru-RU')} просмотров`;
  }

  /** Разбор HTML страницы ролика: поля videoDetails из ytInitialPlayerResponse. */
  function parseWatchHtml(id, html) {
    const pick = (re) => {
      const m = html.match(re);
      return m ? m[1] : '';
    };
    if (!html.includes(`"videoId":"${id}"`)) return {};
    const seconds = pick(/"lengthSeconds":"(\d+)"/);
    const views = pick(/"videoDetails":\{[^]*?"viewCount":"(\d+)"/);
    const isLive = /"isLiveContent":true/.test(html) && /"isLive":true/.test(html);
    return sanitize(id, {
      title: jsonString(pick(/"videoDetails":\{[^]*?"title":"((?:[^"\\]|\\.)*)"/)),
      channel: jsonString(pick(/"ownerChannelName":"((?:[^"\\]|\\.)*)"/)),
      channelUrl: jsonString(pick(/"ownerProfileUrl":"https?:\/\/www\.youtube\.com(\/[^"]+)"/)),
      duration: !isLive && seconds !== '0' ? formatSeconds(seconds) : '',
      views: views ? viewsText(Number(views)) : '',
    });
  }

  /**
   * Очередь восстановления.
   * want(videos) — дозаполнить то, чего не хватает (в порядке списка, новое — в начало очереди);
   * refresh(videos) — забыть прошлые попытки и запросить заново.
   */
  async function createEnricher({ load, save, fetchImpl, watchPage = false, onUpdate = () => {}, concurrency = 4 }) {
    const doFetch = fetchImpl || ((...a) => fetch(...a));
    const cache = new Map(Object.entries((await load()) || {}));
    const queue = [];
    const queued = new Set();
    let active = 0;
    let pausedUntil = 0;
    let saveTimer = 0;

    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        let entries = Array.from(cache.entries());
        if (entries.length > MAX_CACHE) {
          entries = entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CACHE);
          cache.clear();
          for (const [k, v] of entries) cache.set(k, v);
        }
        save(Object.fromEntries(entries));
      }, 1000);
    }

    function needsOEmbed(v, m) {
      if (v.title && v.channel) return false;
      if (!m || !m.status) return true;
      return m.status === 'error' && Date.now() - m.at > RETRY_MS;
    }

    function needsWatchPage(v, m) {
      if (!watchPage || v.duration || v.live || v.upcoming || v.short) return false;
      return !(m && m.deep) && !(m && m.status === 'gone');
    }

    function needed(v) {
      const m = cache.get(v.id);
      const d = merge(v, m);
      return needsOEmbed(d, m) || needsWatchPage(d, m);
    }

    async function request(url) {
      const res = await doFetch(url, { credentials: 'omit' });
      if (res.status === 429) {
        pausedUntil = Date.now() + 30000;
        throw new Error('rate');
      }
      return res;
    }

    async function work(task) {
      const m = { ...(cache.get(task.id) || {}) };
      const d = merge(task, m);
      if (needsOEmbed(d, m)) {
        try {
          const res = await request('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(F.watchUrl(task)));
          if (res.ok) {
            Object.assign(m, parseOEmbed(task.id, await res.json()), { status: 'ok' });
          } else if (res.status === 404 || res.status === 400) {
            m.status = 'gone'; // удалён или никогда не существовал
          } else if (res.status === 401 || res.status === 403) {
            m.status = 'noembed'; // встраивание запрещено или ролик приватный
          } else {
            m.status = 'error';
          }
        } catch {
          m.status = 'error';
          m.tries = (m.tries || 0) + 1;
        }
      }
      if (needsWatchPage(merge(task, m), m)) {
        try {
          const res = await doFetch('https://www.youtube.com/watch?v=' + task.id, { credentials: 'include' });
          if (res.ok) {
            const found = parseWatchHtml(task.id, await res.text());
            for (const k of FIELDS) if (!m[k] && found[k]) m[k] = found[k];
            if (!m.status || m.status === 'error' || m.status === 'noembed') m.status = found.title ? 'ok' : m.status;
          }
        } catch {
          /* длительность просто останется неизвестной */
        }
        m.deep = true;
      }
      m.at = Date.now();
      cache.set(task.id, m);
      scheduleSave();
      onUpdate(task.id);
    }

    function pump() {
      while (active < concurrency && queue.length) {
        if (Date.now() < pausedUntil) {
          setTimeout(pump, pausedUntil - Date.now());
          return;
        }
        const task = queue.shift();
        queued.delete(task.id);
        if (!needed(task)) continue;
        active++;
        work(task).finally(() => {
          active--;
          pump();
        });
      }
    }

    function want(videos) {
      const fresh = [];
      for (const v of videos) {
        if (!needed(v)) continue;
        if (queued.has(v.id)) {
          const i = queue.findIndex((t) => t.id === v.id);
          if (i !== -1) queue.splice(i, 1);
        }
        queued.add(v.id);
        fresh.push({ id: v.id, title: v.title, channel: v.channel, duration: v.duration, short: v.short, live: v.live, upcoming: v.upcoming });
      }
      queue.unshift(...fresh); // то, что пользователь видит сейчас, — первым
      pump();
      return fresh.length;
    }

    function refresh(videos) {
      for (const v of videos) cache.delete(v.id);
      scheduleSave();
      return want(videos);
    }

    return {
      get: (id) => cache.get(id),
      want,
      refresh,
      pending: () => queue.length + active,
    };
  }

  const api = { quality, merge, parseOEmbed, parseWatchHtml, createEnricher };
  root.YFS = root.YFS || {};
  root.YFS.enrich = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
