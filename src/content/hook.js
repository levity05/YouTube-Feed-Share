/*
 * MAIN world (контекст страницы YouTube).
 * 1. Перехватывает ответы /youtubei/v1/browse (fetch и XHR) для главной,
 *    «Посмотреть позже» и истории и пересылает их изолированному content script.
 * 2. По запросу отдаёт ytInitialData и .data карточек текущей страницы.
 * 3. Запоминает ссылки плеера на субтитры (с токеном pot) — из них берётся текст видео.
 * Между мирами передаём только строки: объекты через CustomEvent не проходят.
 *
 * Версия: после обновления расширения во вкладке остаётся старый hook.js (страницу не перезагружали).
 * Новая версия тогда ставится поверх: свои перехватчики и свой канал команд (yfs:tx-request),
 * а пересылку лент оставляет старой копии, чтобы не было дублей.
 */
(function () {
  'use strict';
  const HOOK_VERSION = 6; // при изменении — поменять и HOOK_CHANNEL в ytfetch.js
  if ((window.__yfsHookVersion || 0) >= HOOK_VERSION) return;
  const firstInstall = !window.__yfsHooked;
  window.__yfsHooked = true;
  window.__yfsHookVersion = HOOK_VERSION;

  const BROWSE_RE = /\/youtubei\/v1\/browse/;
  // Окно Shorts: очередь следующих роликов приходит ответом reel_watch_sequence.
  const REEL_SEQUENCE_RE = /\/youtubei\/v1\/reel\/reel_watch_sequence/;
  const watched = (url) => BROWSE_RE.test(url) || REEL_SEQUENCE_RE.test(url);
  // Субтитры, которые загружает сам плеер: в ссылке есть токен pot, без него YouTube отдаёт пустой ответ.
  const TIMEDTEXT_RE = /\/api\/timedtext\?/;
  // Токен в ссылке привязан к дорожке: ссылку для «en» нельзя переделать в «ru» (ответ будет пустым).
  // Поэтому храним по ключу «ролик|язык|вид» и без автоперевода (tlang).
  const timedtext = new Map();
  const timedtextKey = (id, lang, kind) => `${id}|${lang}|${kind === 'asr' ? 'asr' : ''}`;
  function noteTimedtext(url) {
    try {
      if (!TIMEDTEXT_RE.test(url)) return;
      const u = new URL(url, location.origin);
      const id = u.searchParams.get('v');
      if (!id || u.searchParams.has('tlang')) return;
      const key = timedtextKey(id, u.searchParams.get('lang') || '', u.searchParams.get('kind') || '');
      // Ссылка с токеном pot надёжнее — её не затираем ссылкой без токена.
      if (u.searchParams.has('pot') || !timedtext.has(key)) timedtext.set(key, u.href);
    } catch {
      /* не мешаем странице */
    }
  }

  // Ответы YouTube на «Показать текст видео»: если пользователь открывал панель, текст уже есть.
  const TRANSCRIPT_RE = /\/youtubei\/v1\/(get_transcript|get_panel)/;
  const transcripts = new Map(); // id ролика → { kind, body } или { error }
  function currentVideoId() {
    const p = document.getElementById('movie_player');
    try {
      return (p && typeof p.getVideoData === 'function' && (p.getVideoData() || {}).video_id) || '';
    } catch {
      return '';
    }
  }
  function noteTranscript(url, status, text) {
    try {
      const id = currentVideoId();
      if (!id) return;
      const kind = /get_panel/.test(url) ? 'panel' : 'transcript';
      if (kind === 'panel' && text && !text.includes('transcriptSegmentViewModel')) return; // другая панель
      if (status !== 200 || !text) {
        if (!transcripts.has(id) || transcripts.get(id).error) transcripts.set(id, { error: String(status || 'empty') });
        return;
      }
      transcripts.set(id, { kind, body: text });
      if (transcripts.size > 6) transcripts.delete(transcripts.keys().next().value);
    } catch {
      /* не мешаем странице */
    }
  }
  const KNOWN_BROWSE_IDS = ['FEwhat_to_watch', 'VLWL', 'FEhistory'];

  /** Какой раздел YouTube открыт по адресу. */
  function pageKind(href) {
    const url = new URL(href, location.origin);
    if (url.pathname === '/') return 'home';
    if (url.pathname === '/playlist' && url.searchParams.get('list') === 'WL') return 'watch-later';
    if (url.pathname === '/feed/history') return 'history';
    if (url.pathname === '/shorts' || url.pathname.startsWith('/shorts/')) return 'shorts';
    return '';
  }

  function requestInfo(body) {
    try {
      const b = typeof body === 'string' && body ? JSON.parse(body) : null;
      return { browseId: (b && typeof b.browseId === 'string' && b.browseId) || '', continuation: !!(b && b.continuation) };
    } catch {
      return { browseId: '', continuation: false };
    }
  }

  function forward(url, body, responseText) {
    if (!responseText || responseText[0] !== '{') return;
    // Формат: «короткий JSON с описанием» + перевод строки + сырой ответ. Сырой ответ
    // изолированный скрипт не разбирает сразу — только когда идёт сбор (экономит CPU на обычном YouTube).
    if (REEL_SEQUENCE_RE.test(url)) {
      document.dispatchEvent(new CustomEvent('yfs:chunk', { detail: '{"reel":true}\n' + responseText }));
      return;
    }
    const info = requestInfo(body);
    if (!KNOWN_BROWSE_IDS.includes(info.browseId) && !info.continuation) return;
    const meta = `{"browseId":${JSON.stringify(info.browseId)},"continuation":${info.continuation}}`;
    document.dispatchEvent(new CustomEvent('yfs:chunk', { detail: meta + '\n' + responseText }));
  }

  // Фильтр ленты: ответы главной, поиска и рекомендаций — изолированному скрипту, только пока фильтр включён
  // (по ним он знает длительность, канал и прочее о карточках, которые YouTube рисует без этих данных).
  const FEED_RE = /\/youtubei\/v1\/(browse|search|next)(\?|$)/;
  let feedTap = false;
  function tapFeed(url, status, text) {
    if (feedTap && status === 200 && text && text[0] === '{') document.dispatchEvent(new CustomEvent('yfs:feeddata', { detail: text }));
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    let bodyPromise = null;
    let url = '';
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
      noteTimedtext(url);
      if (firstInstall && watched(url)) {
        if (init && typeof init.body === 'string') bodyPromise = Promise.resolve(init.body);
        // Тело Request читаем до того, как его заберёт настоящий fetch.
        else if (input instanceof Request) bodyPromise = input.clone().text().catch(() => '');
        else bodyPromise = Promise.resolve('');
      }
    } catch {
      bodyPromise = null;
    }

    const promise = originalFetch.apply(this, arguments);
    if (feedTap && FEED_RE.test(url)) {
      promise
        .then((res) => Promise.resolve(res.ok ? res.clone().text() : '').then((text) => tapFeed(url, res.status, text)))
        .catch(() => {});
    }
    if (TRANSCRIPT_RE.test(url)) {
      promise
        .then((res) => Promise.resolve(res.ok ? res.clone().text() : '').then((text) => noteTranscript(url, res.status, text)))
        .catch(() => {});
    }
    if (bodyPromise) {
      promise
        .then((res) => (res.ok ? res.clone().text() : ''))
        .then((text) => bodyPromise.then((body) => forward(url, body, text)))
        .catch(() => {});
    }
    return promise;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__yfsUrl = String(url || '');
    noteTimedtext(this.__yfsUrl);
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (feedTap && this.__yfsUrl && FEED_RE.test(this.__yfsUrl)) {
      this.addEventListener('load', () => {
        try {
          const rt = this.responseType;
          tapFeed(this.__yfsUrl, this.status, rt === '' || rt === 'text' ? this.responseText : rt === 'json' ? JSON.stringify(this.response) : '');
        } catch {
          /* не мешаем странице */
        }
      });
    }
    if (this.__yfsUrl && TRANSCRIPT_RE.test(this.__yfsUrl)) {
      this.addEventListener('loadend', () => {
        try {
          const rt = this.responseType;
          const text = rt === '' || rt === 'text' ? this.responseText : rt === 'json' ? JSON.stringify(this.response) : '';
          noteTranscript(this.__yfsUrl, this.status, text);
        } catch {
          /* не мешаем странице */
        }
      });
    }
    if (firstInstall && this.__yfsUrl && watched(this.__yfsUrl)) {
      this.addEventListener('load', () => {
        try {
          const rt = this.responseType;
          const text = rt === '' || rt === 'text' ? this.responseText : rt === 'json' ? JSON.stringify(this.response) : '';
          forward(this.__yfsUrl, typeof body === 'string' ? body : '', text);
        } catch {
          /* не мешаем странице */
        }
      });
    }
    return xhrSend.apply(this, arguments);
  };

  /** ytInitialData годится, только если документ изначально загружался как нужный раздел. */
  function initialData(kind) {
    const nav = performance.getEntriesByType('navigation')[0];
    const data = window.ytInitialData;
    if (!data || pageKind(nav ? nav.name : location.href) !== kind) return 'null';
    if (kind === 'home') {
      const tabs = data.contents && data.contents.twoColumnBrowseResultsRenderer && data.contents.twoColumnBrowseResultsRenderer.tabs;
      const isHome =
        Array.isArray(tabs) && tabs.some((t) => t.tabRenderer && t.tabRenderer.content && t.tabRenderer.content.richGridRenderer);
      if (!isHome) return 'null';
    }
    return JSON.stringify(data);
  }

  const DOM_SOURCES = {
    // .data у отрисованных карточек — точный порядок ленты, как её видит пользователь.
    home: { selector: 'ytd-browse[page-subtype="home"] ytd-rich-item-renderer', wrap: null },
    'watch-later': { selector: 'ytd-browse[page-subtype="playlist"] ytd-playlist-video-renderer', wrap: 'playlistVideoRenderer' },
  };

  function domData(kind) {
    const source = DOM_SOURCES[kind];
    if (!source) return '[]';
    const parts = [];
    for (const el of document.querySelectorAll(source.selector)) {
      const d = el.data || (el.__data && el.__data.data) || (el.polymerController && el.polymerController.data);
      if (!d) continue;
      try {
        parts.push(JSON.stringify(source.wrap ? { [source.wrap]: d } : d));
      } catch {
        /* циклические ссылки — пропускаем карточку */
      }
    }
    return '[' + parts.join(',') + ']';
  }

  /** Звук через API плеера YouTube (он сам помнит mute между роликами). Возвращает прежнее состояние. */
  function setPlayerMuted(mute) {
    const p = document.querySelector('#shorts-player') || document.getElementById('movie_player');
    if (!p || typeof p.isMuted !== 'function') return 'null';
    const was = !!p.isMuted();
    if (mute) p.mute();
    else p.unMute();
    return JSON.stringify(was);
  }

  /** Какой ролик сейчас в плеере и сколько он длится — из API плеера, а не из <video>, который YouTube переиспользует. */
  function playerInfo() {
    const p = document.querySelector('#shorts-player') || document.getElementById('movie_player');
    if (!p || typeof p.getVideoData !== 'function') return 'null';
    const data = p.getVideoData() || {};
    const duration = typeof p.getDuration === 'function' ? Number(p.getDuration()) : 0;
    return JSON.stringify({ id: data.video_id || '', duration: isFinite(duration) ? duration : 0 });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function seenTimedtext(id, track) {
    const key = timedtextKey(id, track.lang, track.kind);
    if (timedtext.has(key)) return timedtext.get(key);
    // Запасной путь — журнал загрузок страницы (если плеер скачал субтитры до нас).
    for (const e of performance.getEntriesByType('resource')) noteTimedtext(e.name);
    return timedtext.get(key) || '';
  }

  /**
   * Текст видео через плеер: так же, как кнопка «Субтитры». Плеер сам подписывает ссылку
   * токеном pot — поэтому способ работает и там, где панель «Показать текст видео» не грузится.
   * Если субтитры были выключены — включаем на мгновение и возвращаем как было.
   * Ответ: { url, tracks: [{ lang, kind, name }], audioLang, defaultIndex } или { tracks: [] }, если субтитров нет.
   */
  async function captionInfo(videoId) {
    const p = document.getElementById('movie_player');
    if (!p || typeof p.getVideoData !== 'function') return 'null';
    if ((p.getVideoData() || {}).video_id !== videoId) return 'null'; // в плеере другой ролик
    const pr = typeof p.getPlayerResponse === 'function' ? p.getPlayerResponse() : null;
    const list = (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    const tracks = list.map((t) => ({
      lang: t.languageCode || '',
      kind: t.kind || '',
      name: (t.name && (t.name.simpleText || (t.name.runs || []).map((r) => r.text).join(''))) || '',
    }));
    if (!tracks.length) return JSON.stringify({ url: '', tracks });
    const hints = captionHints(p, pr);
    // Дорожка — как у YouTube (тот же порядок, что transcript.js pickTrack): язык звука → по умолчанию → прочее.
    const base = (l) => String(l || '').split('-')[0].toLowerCase();
    const same = hints.audioLang ? tracks.filter((t) => base(t.lang) === base(hints.audioLang)) : [];
    const asr = tracks.find((t) => t.kind === 'asr');
    const pick =
      same.find((t) => t.kind !== 'asr') ||
      same[0] ||
      tracks[hints.defaultIndex] ||
      (asr && tracks.find((t) => t.kind !== 'asr' && base(t.lang) === base(asr.lang))) ||
      asr ||
      tracks[0];

    let url = seenTimedtext(videoId, pick);
    if (!url && typeof p.setOption === 'function') {
      let prev = null;
      try {
        prev = p.getOption('captions', 'track');
      } catch {
        prev = null;
      }
      const wasOn = !!(prev && prev.languageCode);
      try {
        // Плеер подписывает ссылку только для включённой дорожки — включаем нужную на мгновение.
        if (typeof p.loadModule === 'function') p.loadModule('captions');
        p.setOption('captions', 'track', { languageCode: pick.lang, ...(pick.kind ? { kind: pick.kind } : {}) });
        for (let i = 0; i < 25 && !url; i++) {
          await sleep(200);
          url = seenTimedtext(videoId, pick);
        }
      } finally {
        try {
          if (wasOn) p.setOption('captions', 'track', prev);
          else {
            p.setOption('captions', 'track', {});
            if (typeof p.unloadModule === 'function') p.unloadModule('captions');
          }
        } catch {
          /* плеер мог смениться */
        }
      }
    }
    return JSON.stringify({ url: url || '', tracks, pick, ...hints });
  }

  /** Язык звука из id дорожки плеера: «251;<base64 protobuf c lang=ru>». */
  function audioLangFromId(id) {
    try {
      const x = String(id || '').split(';')[1];
      if (!x) return '';
      const bin = atob(x.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((x.length + 3) % 4));
      const i = bin.indexOf('lang');
      if (i < 0 || bin.charCodeAt(i + 4) !== 0x12) return '';
      return bin.substr(i + 6, bin.charCodeAt(i + 5));
    } catch {
      return '';
    }
  }

  /**
   * Какой язык звучит и какие субтитры YouTube считает основными: { audioLang, defaultIndex }.
   * Язык — у дорожки, которая играет сейчас (если выбрали дубляж — его), иначе у дорожки по умолчанию.
   */
  function captionHints(p, pr) {
    const r = (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer) || {};
    const audios = Array.isArray(r.audioTracks) ? r.audioTracks : [];
    let audioLang = '';
    try {
      audioLang = typeof p.getAudioTrack === 'function' ? audioLangFromId((p.getAudioTrack() || {}).id) : '';
    } catch {
      audioLang = '';
    }
    const byLang = audioLang && audios.find((a) => String(a.audioTrackId || '').split('.')[0] === audioLang);
    const audio = byLang || audios[r.defaultAudioTrackIndex || 0];
    if (!audioLang && audio) audioLang = String(audio.audioTrackId || '').split('.')[0];
    const defaultIndex = audio && Number.isInteger(audio.defaultCaptionTrackIndex) ? audio.defaultCaptionTrackIndex : undefined;
    return { audioLang, defaultIndex };
  }

  function expandedPanels() {
    return Array.from(document.querySelectorAll('ytd-engagement-panel-section-list-renderer')).filter(
      (p) => p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'
    );
  }

  const TIME_RE = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;
  function toSec(ts) {
    return ts.split(':').reduce((a, p) => a * 60 + Number(p), 0);
  }

  /**
   * Текст видео прямо из открытой панели YouTube (если ответ сервера поймать не удалось:
   * например, страницу открыли до обновления расширения). Классическая панель — ytd-transcript-segment-renderer
   * (у неё есть .data со временем), новая — transcript-segment-view-model: берём время и самый длинный текст.
   */
  /** Строки новой панели текста. Если YouTube переименует элементы — ищем «*segment*» внутри панели текста. */
  function segmentElements() {
    const exact = document.querySelectorAll('transcript-segment-view-model');
    if (exact.length) return Array.from(exact);
    const out = [];
    for (const p of document.querySelectorAll('ytd-engagement-panel-section-list-renderer')) {
      if (!/transcript|timeline/i.test(p.getAttribute('target-id') || '')) continue;
      for (const e of p.querySelectorAll('*')) {
        if (/segment/i.test(e.tagName) && !out.some((o) => o.contains(e))) out.push(e);
      }
    }
    return out;
  }

  function readTranscriptDom() {
    const segments = [];
    for (const el of document.querySelectorAll('ytd-transcript-segment-renderer')) {
      const d = el.data || (el.__data && el.__data.data);
      let start = d && Number(d.startMs) >= 0 ? Number(d.startMs) / 1000 : NaN;
      let text = d && d.snippet ? (d.snippet.simpleText || (d.snippet.runs || []).map((r) => r.text).join('')) : '';
      if (!text) text = (el.querySelector('.segment-text') || {}).textContent || '';
      if (!(start >= 0)) {
        const ts = ((el.querySelector('.segment-timestamp') || {}).textContent || '').trim();
        start = TIME_RE.test(ts) ? toSec(ts) : NaN;
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (text && start >= 0) segments.push({ start, text });
    }
    if (!segments.length) {
      for (const el of segmentElements()) {
        const parts = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = n.textContent.replace(/\s+/g, ' ').trim();
          if (t) parts.push(t);
        }
        const ts = parts.find((t) => TIME_RE.test(t));
        const text = parts.filter((t) => !TIME_RE.test(t)).sort((a, b) => b.length - a.length)[0];
        if (ts && text) segments.push({ start: toSec(ts), text });
      }
    }
    segments.sort((a, b) => a.start - b.start);
    for (let i = 0; i < segments.length; i++) segments[i].end = i + 1 < segments.length ? segments[i + 1].start : segments[i].start + 5;
    return segments;
  }

  function domResult(videoId) {
    if (currentVideoId() !== videoId) return null;
    const segments = readTranscriptDom();
    return segments.length ? { kind: 'dom', body: JSON.stringify(segments) } : null;
  }

  /**
   * Текст видео так, как его показывает сам YouTube: нажимаем «Показать текст видео» в описании,
   * ловим ответ (его подписывает страница — с аккаунтом и всеми токенами) и закрываем панель обратно.
   */
  async function youtubeTranscript(videoId, open) {
    const have = transcripts.get(videoId);
    if (have && have.body) return JSON.stringify(have);
    const shown = domResult(videoId); // панель уже открыта пользователем
    if (shown) return JSON.stringify(shown);
    if (!open) return 'null';
    if (currentVideoId() !== videoId) return JSON.stringify({ error: 'other-video' });
    const btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
    if (!btn) return JSON.stringify({ error: 'no-button' });
    transcripts.delete(videoId);
    const before = new Set(expandedPanels());
    btn.click();
    let dom = null;
    for (let i = 0; i < 50 && !transcripts.has(videoId); i++) {
      await sleep(200);
      // Текст появился в панели, а ответ сервера мы не видели — читаем с экрана (после ещё одной паузы, чтобы дорисовался).
      if (i > 3 && (dom = domResult(videoId))) {
        await sleep(400);
        dom = domResult(videoId) || dom;
        break;
      }
    }
    for (const p of expandedPanels()) {
      if (before.has(p)) continue;
      const close = p.querySelector('#visibility-button button');
      if (close) close.click();
    }
    const hit = transcripts.get(videoId);
    if (hit && hit.body) return JSON.stringify(hit);
    return JSON.stringify(dom || hit || { error: 'timeout' });
  }

  /**
   * Аудио-режим: видео не видно — качество снижаем до минимального (меньше трафика и нагрузки),
   * при выходе возвращаем то, что было выбрано раньше.
   */
  let savedQuality = null;
  function lowQuality(on) {
    const p = document.getElementById('movie_player');
    if (!p || typeof p.setPlaybackQualityRange !== 'function') return 'false';
    try {
      if (on) {
        if (savedQuality === null) savedQuality = (typeof p.getPreferredQuality === 'function' && p.getPreferredQuality()) || 'auto';
        const levels = typeof p.getAvailableQualityLevels === 'function' ? p.getAvailableQualityLevels() : [];
        const low = levels.filter((q) => q !== 'auto').pop() || 'tiny';
        p.setPlaybackQualityRange(low, low);
      } else {
        const q = savedQuality || 'auto';
        savedQuality = null;
        p.setPlaybackQualityRange(q, q);
      }
      return 'true';
    } catch {
      return 'false';
    }
  }

  function mainPlayer() {
    return document.getElementById('movie_player');
  }

  /**
   * Громкость через API плеера (YouTube сам запоминает её между роликами и показывает в своём ползунке).
   * kind — JSON: { volume: 0–100 } или { muted: true/false }; без полей — только прочитать.
   */
  function volumeControl(kind) {
    const p = mainPlayer();
    if (!p || typeof p.getVolume !== 'function') return 'null';
    let req = {};
    try {
      req = kind ? JSON.parse(kind) : {};
    } catch {
      req = {};
    }
    if (Number.isFinite(req.volume)) {
      p.setVolume(Math.max(0, Math.min(100, Math.round(req.volume))));
      if (req.volume > 0 && p.isMuted()) p.unMute();
    }
    if (req.muted === true) p.mute();
    if (req.muted === false) p.unMute();
    return JSON.stringify({ volume: p.getVolume(), muted: !!p.isMuted() });
  }

  /** Соседний ролик в очереди плеера (плейлист, «Джем»): kind — next | prev. */
  function playerNav(kind) {
    const p = mainPlayer();
    if (!p) return 'false';
    if (kind === 'next' && typeof p.nextVideo === 'function') p.nextVideo();
    else if (kind === 'prev' && typeof p.previousVideo === 'function') p.previousVideo();
    else return 'false';
    return 'true';
  }

  /**
   * Переход на ролик внутри приложения YouTube, без перезагрузки страницы: то же событие yt-navigate,
   * которое шлёт клик по карточке. Страница (и экран аудио-режима поверх неё) не мигает.
   * Возвращает 'true', если событие отправлено; дошёл ли переход — проверяет вызывающий.
   */
  function spaNavigate(videoId) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return 'false';
    const app = document.querySelector('ytd-app');
    if (!app) return 'false';
    const url = '/watch?v=' + videoId;
    const endpoint = {
      commandMetadata: { webCommandMetadata: { url, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } },
      watchEndpoint: { videoId },
    };
    try {
      app.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint } }));
      return 'true';
    } catch {
      return 'false';
    }
  }

  /**
   * Что известно о ролике как о музыке: категория, тип музыкального видео (YouTube помечает клипы
   * и «Topic»-треки), автор, ключевые слова. Нужно аудио- и музыкальному режиму.
   */
  function musicInfo(videoId) {
    const p = mainPlayer();
    const pr = p && typeof p.getPlayerResponse === 'function' ? p.getPlayerResponse() : null;
    const vd = (pr && pr.videoDetails) || {};
    if (!pr || (videoId && vd.videoId !== videoId)) return 'null';
    const mf = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
    return JSON.stringify({
      id: vd.videoId || '',
      title: vd.title || '',
      author: vd.author || '',
      category: mf.category || '',
      musicVideoType: vd.musicVideoType || '',
      keywords: (vd.keywords || []).slice(0, 20),
      lengthSec: Number(vd.lengthSeconds) || 0,
    });
  }

  /**
   * Включить/выключить передачу ответов ленты. При включении сразу отдаём данные уже открытой страницы
   * (ytInitialData) и .data карточек, которые YouTube успел нарисовать.
   */
  function feedTapControl(kind) {
    feedTap = kind === 'on';
    if (!feedTap) return 'null';
    const parts = [];
    try {
      if (window.ytInitialData) parts.push(window.ytInitialData);
    } catch {
      /* нет данных страницы */
    }
    for (const el of document.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer')) {
      const d = el.data || (el.__data && el.__data.data);
      if (d && typeof d === 'object') parts.push({ [el.tagName === 'YTD-RICH-ITEM-RENDERER' ? 'richItem' : el.tagName === 'YTD-COMPACT-VIDEO-RENDERER' ? 'compactVideoRenderer' : 'videoRenderer']: d });
    }
    try {
      return JSON.stringify(parts);
    } catch {
      return '[]';
    }
  }

  const HANDLERS = {
    feedtap: (req) => feedTapControl(String(req.kind || '')),
    volume: (req) => volumeControl(String(req.kind || '')),
    nav: (req) => playerNav(String(req.kind || '')),
    goto: (req) => spaNavigate(String(req.kind || '')),
    music: (req) => musicInfo(String(req.kind || '')),
    quality: (req) => lowQuality(req.kind === 'low'),
    ytpanel: (req) => youtubeTranscript(String(req.kind || ''), false),
    'ytpanel-open': (req) => youtubeTranscript(String(req.kind || ''), true),
    initial: (req) => initialData(req.kind),
    playerinfo: () => playerInfo(),
    mute: () => setPlayerMuted(true),
    unmute: () => setPlayerMuted(false),
    dom: (req) => domData(req.kind),
    captions: (req) => captionInfo(String(req.kind || '')),
  };

  function listen(requestEvent, responseEvent) {
    document.addEventListener(requestEvent, (e) => answer(e, responseEvent));
  }

  async function answer(e, responseEvent) {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch {
      return;
    }
    let result = 'null';
    try {
      const handler = HANDLERS[req.what];
      if (handler) result = (await handler(req)) || 'null';
    } catch {
      result = 'null';
    }
    document.dispatchEvent(new CustomEvent(responseEvent, { detail: `{"id":${JSON.stringify(req.id)},"result":${result}}` }));
  }

  if (firstInstall) listen('yfs:request', 'yfs:response'); // сбор лент (collector.js)
  // Текст видео (ytfetch.js): канал с номером версии — старые копии во вкладке его не слушают.
  listen(`yfs:tx-v${HOOK_VERSION}-request`, `yfs:tx-v${HOOK_VERSION}-response`);
})();
