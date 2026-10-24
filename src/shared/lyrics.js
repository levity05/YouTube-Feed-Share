/*
 * Тексты песен из открытых API, без ключей и регистрации:
 *   1. LRCLIB (lrclib.net) — тексты, часто с тайм-кодами (синхронизированные .lrc);
 *   2. lyrics.ovh — обычный текст без тайм-кодов.
 * Если тайм-кодов нет, строки получают приблизительное время: длина трека делится
 * между строками пропорционально их длине — текст «плывёт» вместе с песней.
 *
 * Чистые функции + lookup(fetchJson, info): сеть передаётся снаружи (фоновый скрипт или тест).
 */
(function (root) {
  'use strict';

  const LRCLIB = 'https://lrclib.net/api';
  const OVH = 'https://api.lyrics.ovh/v1';

  const enc = encodeURIComponent;

  function lrclibGetUrl(artist, track, durationSec) {
    const q = [`artist_name=${enc(artist)}`, `track_name=${enc(track)}`];
    if (durationSec > 0) q.push(`duration=${Math.round(durationSec)}`);
    return `${LRCLIB}/get?${q.join('&')}`;
  }

  const lrclibSearchUrl = (q) => `${LRCLIB}/search?q=${enc(q)}`;
  const ovhUrl = (artist, track) => `${OVH}/${enc(artist)}/${enc(track)}`;

  /** «[01:23.45] строка» → [{ start: 83.45, text }]. Строки без времени и пустые метки отбрасываются. */
  function parseLrc(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const stamps = Array.from(raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g));
      if (!stamps.length) continue;
      const line = raw.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of stamps) {
        const frac = m[3] ? Number('0.' + m[3]) : 0;
        out.push({ start: Number(m[1]) * 60 + Number(m[2]) + frac, text: line });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** Обычный текст → строки; повторяющиеся пустые строки (между куплетами) схлопываются в одну пустую. */
  function plainLines(text) {
    const lines = String(text || '')
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.trim());
    const out = [];
    for (const l of lines) {
      if (!l && (!out.length || !out[out.length - 1])) continue;
      out.push(l);
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out;
  }

  /**
   * Время для строк без тайм-кодов. Первые ~4% трека — вступление, последние ~4% — затухание,
   * между ними строки занимают время пропорционально длине (пустая строка — короткая пауза).
   */
  function spreadLines(lines, durationSec) {
    const d = Number(durationSec) > 0 ? Number(durationSec) : Math.max(60, lines.length * 4);
    const from = d * 0.04;
    const span = d * 0.92;
    const weight = (l) => (l ? 1 + l.length / 28 : 0.6);
    const total = lines.reduce((a, l) => a + weight(l), 0) || 1;
    let acc = 0;
    return lines.map((text) => {
      const start = from + (acc / total) * span;
      acc += weight(text);
      return { start: Math.round(start * 10) / 10, text };
    });
  }

  /** Результат LRCLIB → { synced, lines } (или null, если текста нет). */
  function fromLrclib(rec, durationSec) {
    if (!rec || rec.instrumental) return null;
    if (rec.syncedLyrics) {
      const lines = parseLrc(rec.syncedLyrics); // пустые строки — паузы между куплетами, оставляем
      if (lines.filter((l) => l.text).length >= 3) return { synced: true, lines };
    }
    const plain = plainLines(rec.plainLyrics);
    if (plain.length >= 3) return { synced: false, lines: spreadLines(plain, durationSec || rec.duration) };
    return null;
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  /** Лучший из результатов поиска: совпадение названия и исполнителя, длина трека, наличие тайм-кодов. */
  function pickBest(results, info) {
    const list = Array.isArray(results) ? results : [];
    const track = norm(info.track);
    const artist = norm(info.artist);
    let best = null;
    let bestScore = 0;
    for (const r of list) {
      if (!r || r.instrumental || !(r.syncedLyrics || r.plainLyrics)) continue;
      let s = 0;
      const rt = norm(r.trackName);
      const ra = norm(r.artistName);
      if (track && rt === track) s += 3;
      else if (track && (rt.includes(track) || track.includes(rt))) s += 1.5;
      if (artist && ra === artist) s += 2;
      else if (artist && (ra.includes(artist) || artist.includes(ra))) s += 1;
      if (info.durationSec > 0 && r.duration > 0) {
        const diff = Math.abs(r.duration - info.durationSec);
        if (diff <= 3) s += 2;
        else if (diff <= 10) s += 1;
        else if (diff > 40) s -= 2;
      }
      if (r.syncedLyrics) s += 0.5;
      if (s > bestScore) {
        bestScore = s;
        best = r;
      }
    }
    return bestScore >= 3 ? best : null; // меньше — скорее всего чужая песня
  }

  /** Варианты запросов: «исполнитель/трек» как разобрали, наоборот и без «feat.»-хвоста. */
  function variants(info) {
    const out = [];
    const add = (artist, track) => {
      artist = String(artist || '').trim();
      track = String(track || '').trim();
      if (!track) return;
      if (!out.some((v) => v.artist === artist && v.track === track)) out.push({ artist, track });
    };
    const stripFeat = (s) => String(s || '').replace(/\s*[\(\[]?\b(?:feat\.?|ft\.?|featuring|при уч\.?)\b.*$/i, '').trim();
    add(info.artist, info.track);
    add(stripFeat(info.artist), stripFeat(info.track));
    if (info.artist && info.track) add(info.track, info.artist); // «Трек - Исполнитель» бывает и так
    return out;
  }

  /**
   * Найти текст: LRCLIB (точный запрос → поиск) → lyrics.ovh.
   * fetchJson(url) → объект или null; никогда не бросает наружу ошибки сети (они — «нет текста»).
   * info: { artist, track, query, durationSec }. Ответ: { source, synced, lines } или null.
   */
  async function lookup(fetchJson, info) {
    const safe = async (url) => {
      try {
        return await fetchJson(url);
      } catch {
        return null;
      }
    };
    const dur = Number(info.durationSec) || 0;
    for (const v of variants(info)) {
      if (!v.artist) continue;
      const rec = await safe(lrclibGetUrl(v.artist, v.track, dur));
      const hit = fromLrclib(rec && !rec.statusCode ? rec : null, dur);
      if (hit) return { source: 'LRCLIB', ...hit };
    }
    const q = info.query || [info.artist, info.track].filter(Boolean).join(' ');
    if (q) {
      const found = await safe(lrclibSearchUrl(q));
      const best = pickBest(found, { artist: info.artist, track: info.track, durationSec: dur });
      const hit = fromLrclib(best, dur);
      if (hit) return { source: 'LRCLIB', ...hit };
    }
    for (const v of variants(info)) {
      if (!v.artist) continue;
      const rec = await safe(ovhUrl(v.artist, v.track));
      const lines = plainLines(rec && rec.lyrics);
      if (lines.length >= 3) return { source: 'lyrics.ovh', synced: false, lines: spreadLines(lines, dur) };
    }
    return null;
  }

  const api = { lrclibGetUrl, lrclibSearchUrl, ovhUrl, parseLrc, plainLines, spreadLines, fromLrclib, pickBest, variants, lookup };
  root.YFS = root.YFS || {};
  root.YFS.lyrics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
