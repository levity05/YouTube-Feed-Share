/*
 * Текст видео (транскрипт): разбор ответов YouTube и форматирование.
 * Чистые функции без DOM и сети — работают во фрейме ролика (frame.js), в просмотрщике и в Node-тестах.
 *
 * Источники (порядок — в content/ytfetch.js):
 *   1. /youtubei/v1/get_panel и get_transcript — то же, что кнопка «Показать текст видео»;
 *   2. субтитры по ссылке, которую подписал плеер (токен pot), формат json3;
 *   3. запасной: дорожки субтитров из ytInitialPlayerResponse.
 */
(function (root) {
  'use strict';

  /** JSON-объект сразу после метки в тексте скрипта: «var ytInitialData = {…};» → объект. */
  function jsonAfter(text, marker) {
    const at = text.indexOf(marker);
    if (at < 0) return null;
    const start = text.indexOf('{', at + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function find(node, key, test, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 40) return null;
    if (Array.isArray(node)) {
      for (const x of node) {
        const hit = find(x, key, test, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (!v || typeof v !== 'object') continue;
      if (k === key && (!test || test(v))) return v;
      const hit = find(v, key, test, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  function findAll(node, key, out = [], depth = 0) {
    if (!node || typeof node !== 'object' || depth > 40) return out;
    if (Array.isArray(node)) {
      for (const x of node) findAll(x, key, out, depth + 1);
      return out;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (!v || typeof v !== 'object') continue;
      if (k === key) out.push(v);
      else findAll(v, key, out, depth + 1);
    }
    return out;
  }

  function text(t) {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || '').join('');
    return '';
  }

  /**
   * Текст видео в формате 2026 года: кнопка «Показать текст видео» открывает панель
   * через /youtubei/v1/get_panel. Её параметры — в showEngagementPanelEndpoint ytInitialData.
   * Возвращает { panelId, params } или null.
   */
  function findPanelParams(initialData) {
    const ep = find(
      initialData,
      'showEngagementPanelEndpoint',
      (e) => e.identifier && /transcript/i.test(e.identifier.tag || '') && e.globalConfiguration && typeof e.globalConfiguration.params === 'string'
    );
    return ep ? { panelId: ep.identifier.tag, params: ep.globalConfiguration.params } : null;
  }

  function timestampToSeconds(ts) {
    if (!/^\d+(:\d{1,2}){0,2}$/.test(String(ts || '').trim())) return 0;
    return String(ts).trim().split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  }

  /** Ответ get_panel → { segments, chapters: [], languages: [] }. */
  function parsePanelResponse(json) {
    const segments = [];
    for (const item of findAll(json, 'macroMarkersPanelItemViewModel')) {
      const tl = item.item && item.item.timelineItemViewModel;
      if (!tl) continue;
      const seg = (tl.contentItems || []).map((c) => c && c.transcriptSegmentViewModel).filter(Boolean)[0];
      if (!seg) continue;
      const t = clean(seg.simpleText || text(seg.text) || '');
      if (!t) continue;
      const we = find(item.onTap, 'watchEndpoint');
      const start = we && Number(we.startTimeSeconds) >= 0 ? Number(we.startTimeSeconds) : timestampToSeconds(seg.timestamp || tl.timestamp);
      segments.push({ start, end: 0, text: t });
    }
    segments.sort((a, b) => a.start - b.start);
    // Конца у сегментов в этом формате нет — считаем им начало следующего.
    for (let i = 0; i < segments.length; i++) segments[i].end = i + 1 < segments.length ? segments[i + 1].start : segments[i].start + 5;
    return { segments, chapters: [], languages: [] };
  }

  /** Параметры старого запроса текста видео (get_transcript) из ytInitialData. */
  function findTranscriptParams(initialData) {
    const ep = find(initialData, 'getTranscriptEndpoint', (e) => typeof e.params === 'string');
    return ep ? ep.params : '';
  }

  const clean = (s) => s.replace(/\s+/g, ' ').trim();

  /**
   * Ответ get_transcript → { segments: [{ start, end, text }], chapters: [{ start, title }], languages: [{ title, params, selected }] }.
   * start/end — секунды.
   */
  function parseTranscriptResponse(json) {
    const segments = [];
    const chapters = [];
    for (const s of findAll(json, 'transcriptSegmentRenderer')) {
      const t = clean(text(s.snippet));
      if (!t) continue;
      segments.push({ start: Number(s.startMs) / 1000 || 0, end: Number(s.endMs) / 1000 || 0, text: t });
    }
    for (const h of findAll(json, 'transcriptSectionHeaderRenderer')) {
      const vm = h.sectionHeader && h.sectionHeader.sectionHeaderViewModel;
      const title = clean(text(h.snippet) || (vm && vm.headline && vm.headline.content) || '');
      if (title) chapters.push({ start: Number(h.startMs) / 1000 || 0, title });
    }
    const languages = [];
    const footer = find(json, 'transcriptFooterRenderer');
    const items = (footer && find(footer, 'subMenuItems', Array.isArray)) || [];
    for (const it of items) {
      const params = it && it.continuation && it.continuation.reloadContinuationData && it.continuation.reloadContinuationData.continuation;
      if (params) languages.push({ title: String(it.title || ''), params, selected: !!it.selected });
    }
    segments.sort((a, b) => a.start - b.start);
    return { segments, chapters, languages };
  }

  /** Дорожка субтитров в формате json3 → сегменты. */
  function parseJson3(json) {
    const segments = [];
    for (const ev of (json && json.events) || []) {
      if (!ev.segs) continue;
      const t = clean(ev.segs.map((s) => s.utf8 || '').join(''));
      if (!t) continue;
      const start = Number(ev.tStartMs) / 1000 || 0;
      segments.push({ start, end: start + (Number(ev.dDurationMs) / 1000 || 0), text: t });
    }
    return segments;
  }

  /** Дорожки субтитров из ytInitialPlayerResponse: [{ title, lang, url, auto }]. */
  function captionTracks(playerResponse) {
    const list =
      (playerResponse &&
        playerResponse.captions &&
        playerResponse.captions.playerCaptionsTracklistRenderer &&
        playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];
    return list
      .filter((c) => c && typeof c.baseUrl === 'string')
      .map((c) => ({ title: text(c.name), lang: c.languageCode || '', url: c.baseUrl, auto: c.kind === 'asr' }));
  }

  /**
   * Какую дорожку брать как «текст видео» — ту же, что показывает YouTube:
   *   1. на языке звука, который сейчас играет (авторская лучше автоматической);
   *   2. дорожка по умолчанию из данных ролика (defaultCaptionTrackIndex);
   *   3. авторская на языке автоматической, иначе автоматическая, иначе первая.
   * Автоматических дорожек бывает несколько (например, en и ru у русского ролика) — первая не обязательно верная.
   * tracks: [{ lang, kind }] (kind 'asr' — автоматические); hints: { audioLang, defaultIndex }.
   */
  function pickTrack(tracks, hints) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const base = (l) => String(l || '').split('-')[0].toLowerCase();
    const h = hints || {};
    if (h.audioLang) {
      const same = tracks.filter((t) => base(t.lang) === base(h.audioLang));
      const hit = same.find((t) => t.kind !== 'asr') || same[0];
      if (hit) return hit;
    }
    if (Number.isInteger(h.defaultIndex) && tracks[h.defaultIndex]) return tracks[h.defaultIndex];
    const asr = tracks.find((t) => t.kind === 'asr');
    return (asr && tracks.find((t) => t.kind !== 'asr' && base(t.lang) === base(asr.lang))) || asr || tracks[0];
  }

  /** Подсказки для pickTrack из ytInitialPlayerResponse: язык звука и дорожка субтитров по умолчанию. */
  function captionHints(playerResponse) {
    const r = playerResponse && playerResponse.captions && playerResponse.captions.playerCaptionsTracklistRenderer;
    const audio = r && Array.isArray(r.audioTracks) ? r.audioTracks[r.defaultAudioTrackIndex || 0] : null;
    if (!audio) return {};
    return {
      audioLang: String(audio.audioTrackId || '').split('.')[0],
      defaultIndex: Number.isInteger(audio.defaultCaptionTrackIndex) ? audio.defaultCaptionTrackIndex : undefined,
    };
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  /**
   * Текст для копирования и .txt.
   * timestamps: «[0:12] текст» построчно; без них — абзацы (новый абзац на паузе > 2 с или каждые ~600 знаков).
   */
  function formatTranscript(segments, { timestamps = true } = {}) {
    if (timestamps) return segments.map((s) => `[${formatTime(s.start)}] ${s.text}`).join('\n');
    const paragraphs = [];
    let cur = '';
    let lastEnd = 0;
    for (const s of segments) {
      const pause = s.start - lastEnd > 2;
      if (cur && (pause || cur.length > 600)) {
        paragraphs.push(cur.trim());
        cur = '';
      }
      cur += (cur ? ' ' : '') + s.text;
      lastEnd = s.end || s.start;
    }
    if (cur.trim()) paragraphs.push(cur.trim());
    return paragraphs.join('\n\n');
  }

  const api = {
    jsonAfter,
    findPanelParams,
    parsePanelResponse,
    findTranscriptParams,
    parseTranscriptResponse,
    parseJson3,
    captionTracks,
    pickTrack,
    captionHints,
    timestampToSeconds,
    formatTime,
    formatTranscript,
  };
  root.YFS = root.YFS || {};
  root.YFS.transcript = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
