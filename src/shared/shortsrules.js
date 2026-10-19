/*
 * Правила пропуска Shorts: длительность от/до, авторы и хештеги.
 * Чистые функции без DOM — работают в content script, на странице настроек и в Node-тестах.
 *
 * rules = { minSec, maxSec, authors: { <ключ>: <имя> }, tags: [<тег без #, нижний регистр>] }
 *   minSec / maxSec — 0 значит «не ограничивать».
 */
(function (root) {
  'use strict';

  const DEFAULT_RULES = { minSec: 0, maxSec: 0, authors: {}, tags: [] };

  function normalizeRules(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const num = (v) => {
      const n = Math.round(Number(v));
      return n > 0 && n < 86400 ? n : 0;
    };
    const authors = {};
    for (const [k, v] of Object.entries(r.authors && typeof r.authors === 'object' ? r.authors : {})) {
      if (typeof k === 'string' && k.length < 200) authors[k] = typeof v === 'string' ? v.slice(0, 120) : k;
    }
    const tags = Array.isArray(r.tags)
      ? [...new Set(r.tags.filter((t) => typeof t === 'string').map((t) => t.replace(/^#/, '').toLowerCase().trim()).filter(Boolean))].slice(0, 500)
      : [];
    return { minSec: num(r.minSec), maxSec: num(r.maxSec), authors, tags };
  }

  /** Хештеги из текста: «Смешно #Кот #cats» → ['кот', 'cats']. */
  function extractTags(text) {
    const out = [];
    for (const m of String(text || '').matchAll(/#([\p{L}\p{N}_]{1,60})/gu)) out.push(m[1].toLowerCase());
    return [...new Set(out)];
  }

  /** Ключ автора: handle из ссылки (/@name), иначе имя в нижнем регистре. */
  function authorKey(channelUrl, channelName) {
    const m = String(channelUrl || '').match(/^\/(@[^/?#\s]+)/);
    if (m) return decodeURIComponent(m[1]).toLowerCase();
    const name = String(channelName || '').trim().toLowerCase();
    return name ? 'name:' + name : '';
  }

  /**
   * Нужно ли пропустить шорт. info = { durationSec, authorKey, tags }.
   * Возвращает причину ('short' | 'long' | 'author' | 'tag') или null.
   * Если длительность неизвестна, фильтр длины его не трогает.
   */
  function decideSkip(info, rules) {
    const r = normalizeRules(rules);
    const d = Number(info.durationSec);
    if (d > 0) {
      if (r.minSec && d < r.minSec) return 'short';
      if (r.maxSec && d > r.maxSec) return 'long';
    }
    if (info.authorKey && Object.prototype.hasOwnProperty.call(r.authors, info.authorKey)) return 'author';
    if ((info.tags || []).some((t) => r.tags.includes(t))) return 'tag';
    return null;
  }

  /** Счётчики «что смотрели»: { authors: { ключ: { name, count } }, tags: { тег: count } }. */
  function recordSeen(seen, info) {
    const s = seen && typeof seen === 'object' ? seen : {};
    s.authors = s.authors || {};
    s.tags = s.tags || {};
    if (info.authorKey) {
      const a = s.authors[info.authorKey] || { name: info.authorName || info.authorKey, count: 0 };
      if (info.authorName) a.name = info.authorName;
      a.count++;
      s.authors[info.authorKey] = a;
    }
    for (const t of info.tags || []) s.tags[t] = (s.tags[t] || 0) + 1;
    return s;
  }

  const api = { DEFAULT_RULES, normalizeRules, extractTags, authorKey, decideSkip, recordSeen };
  root.YFS = root.YFS || {};
  root.YFS.rules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
