/*
 * Музыка на YouTube: похоже ли видео на трек, «Исполнитель — Название» из заголовка,
 * ссылки поиска этого трека на других площадках.
 * Чистые функции без DOM и сети — работают в content scripts, просмотрщике и Node-тестах.
 */
(function (root) {
  'use strict';

  // Пометки в заголовке, которые к названию трека не относятся: (Official Video), [4K], | Lyrics …
  const TAG_WORDS =
    'official|officiel|oficial|video|vídeo|clip|клип|music video|lyric video|lyrics?|текст|audio|visuali[sz]er|hd|hq|4k|8k|mv|m/v|' +
    'live|концерт|премьера|premiere|remaster(?:ed)?(?: \\d{4})?|explicit|clean|prod\\.?[^)\\]]*|full album|альбом|single|сингл|extended|radio edit';
  const BRACKET_RE = new RegExp(`\\s*[\\(\\[【][^\\)\\]】]*(?:${TAG_WORDS})[^\\)\\]】]*[\\)\\]】]`, 'gi');
  const PIPE_TAIL_RE = new RegExp(`\\s*[|｜]\\s*(?:${TAG_WORDS}).*$`, 'i');
  const SEPARATOR_RE = /\s+[-–—~]\s+|\s*[|｜]\s*/;
  const TOPIC_RE = /\s*[-–]\s*(topic|тема|темы|tema|thème|thema|tópico|konu|主题|トピック)$/i;

  function cleanTitle(title) {
    return String(title || '')
      .replace(BRACKET_RE, '')
      .replace(PIPE_TAIL_RE, '')
      .replace(/\s*#\S+/g, '') // хештеги
      .replace(/["«»“”]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** Имя исполнителя из названия канала: «Artist - Topic» → Artist, «ArtistVEVO» → Artist. */
  function channelArtist(channel) {
    const c = String(channel || '').trim();
    if (TOPIC_RE.test(c)) return c.replace(TOPIC_RE, '').trim();
    if (/vevo$/i.test(c)) return c.replace(/\s*vevo$/i, '').trim();
    return '';
  }

  /**
   * Трек из заголовка ролика: { artist, track, query }.
   * «Artist - Track (Official Video)» → Artist / Track; у «Topic»-каналов заголовок — само название трека.
   */
  function parseTrack(title, channel) {
    const clean = cleanTitle(title);
    const fromChannel = channelArtist(channel);
    let artist = '';
    let track = clean;
    const parts = clean.split(SEPARATOR_RE).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      artist = parts[0];
      track = parts.slice(1).join(' ');
    }
    if (!artist) artist = fromChannel || String(channel || '').replace(/\s*(official|music|records|channel)$/i, '').trim();
    const query = [artist, track].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
    return { artist, track, query: query || clean };
  }

  /**
   * Насколько ролик похож на музыкальный трек (0–1) по тому, что видно в карточке ленты.
   * info: { title, channel, durationSec, musicVideoType, category }.
   */
  function musicScore(info) {
    const t = String(info.title || '');
    const c = String(info.channel || '');
    if (/MUSIC_VIDEO_TYPE_/.test(info.musicVideoType || '')) return 1;
    let s = 0;
    if (info.category === 'Music') s += 0.5;
    if (TOPIC_RE.test(c) || /vevo$/i.test(c)) s += 0.6;
    if (/(records|music|recordings|label)$/i.test(c)) s += 0.2;
    if (/[\(\[](official|lyric|audio|visuali[sz]er|клип|mv|m\/v)/i.test(t)) s += 0.45;
    else if (/[|｜]\s*(lyrics?|текст|audio|official|премьера|клип)/i.test(t)) s += 0.35;
    if (/\b(feat\.?|ft\.)\s/i.test(t)) s += 0.2;
    if (SEPARATOR_RE.test(t) && t.length < 90) s += 0.15;
    const d = Number(info.durationSec) || 0;
    if (d >= 90 && d <= 480) s += 0.15;
    else if (d > 900) s -= 0.4; // подкасты, сборники, стримы
    if (/(подкаст|podcast|обзор|review|reaction|реакция|tutorial|урок|news|новости|стрим|stream|#shorts)/i.test(t)) s -= 0.6;
    return Math.max(0, Math.min(1, s));
  }

  const isMusic = (info, threshold = 0.5) => musicScore(info) >= threshold;

  /** Площадки, где искать трек. url(q) — страница поиска. */
  const PLATFORMS = [
    { id: 'spotify', name: 'Spotify', url: (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}` },
    { id: 'apple', name: 'Apple Music', url: (q) => `https://music.apple.com/search?term=${encodeURIComponent(q)}` },
    { id: 'yandex', name: 'Yandex Music', key: 'music.yandex', url: (q) => `https://music.yandex.ru/search?text=${encodeURIComponent(q)}` },
    { id: 'ytmusic', name: 'YouTube Music', url: (q) => `https://music.youtube.com/search?q=${encodeURIComponent(q)}` },
    { id: 'soundcloud', name: 'SoundCloud', url: (q) => `https://soundcloud.com/search?q=${encodeURIComponent(q)}` },
    { id: 'deezer', name: 'Deezer', url: (q) => `https://www.deezer.com/search/${encodeURIComponent(q)}` },
    { id: 'vk', name: 'VK Music', key: 'music.vk', url: (q) => `https://vk.com/audio?q=${encodeURIComponent(q)}` },
  ];

  function platformLinks(query) {
    const q = String(query || '').trim();
    const i18n = root.YFS && root.YFS.i18n;
    // Название площадки — на языке интерфейса, если для неё есть перевод (Яндекс Музыка, VK Музыка).
    const name = (p) => {
      const v = p.key && i18n ? i18n.t(p.key) : '';
      return v && v !== p.key ? v : p.name;
    };
    return q ? PLATFORMS.map((p) => ({ id: p.id, name: name(p), url: p.url(q) })) : [];
  }

  /**
   * Очередь из роликов одним адресом: YouTube сам соберёт временный плейлист,
   * будет играть подряд и переключать трек кнопками наушников. Не больше 50 роликов.
   */
  function queueUrl(ids) {
    const list = [...new Set((ids || []).filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)))].slice(0, 50);
    return list.length ? `https://www.youtube.com/watch_videos?video_ids=${list.join(',')}` : '';
  }

  // ---------- треки из страницы микса или плейлиста YouTube ----------

  /** Достаёт объект ytInitialData из HTML страницы (скобки считаются с учётом строк). */
  function extractInitialData(html) {
    const s = String(html || '');
    const m = s.match(/ytInitialData\s*=\s*/);
    if (!m) return null;
    let i = m.index + m[0].length;
    if (s[i] !== '{') return null;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(s.slice(i, j + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  const runsText = (x) => (x && (x.simpleText || (x.runs || []).map((r) => r.text).join(''))) || '';

  function clock(text) {
    const p = String(text || '').split(':').map(Number);
    return p.length >= 2 && p.every(Number.isFinite) ? p.reduce((a, n) => a * 60 + n, 0) : 0;
  }

  /**
   * Треки микса (playlistPanelVideoRenderer) или плейлиста (playlistVideoRenderer):
   * [{ id, title, channel, durationSec }] без повторов, по порядку.
   */
  function extractPlaylistTracks(html) {
    const data = extractInitialData(html);
    const out = [];
    const seen = new Set();
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 40) return;
      if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
      const r = node.playlistPanelVideoRenderer || node.playlistVideoRenderer;
      if (r && /^[A-Za-z0-9_-]{11}$/.test(r.videoId || '') && !seen.has(r.videoId)) {
        seen.add(r.videoId);
        out.push({
          id: r.videoId,
          title: runsText(r.title),
          channel: runsText(r.shortBylineText || r.longBylineText),
          durationSec: clock(runsText(r.lengthText)),
        });
        return;
      }
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    };
    walk(data, 0);
    return out;
  }

  const api = { extractInitialData, extractPlaylistTracks, cleanTitle, channelArtist, parseTrack, musicScore, isMusic, PLATFORMS, platformLinks, queueUrl };
  root.YFS = root.YFS || {};
  root.YFS.music = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
