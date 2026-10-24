/*
 * Фильтр ленты рекомендаций: правила и разбор того, что YouTube пишет в карточке.
 * Чистые функции без DOM — их использует content/feedfilter.js и Node-тесты.
 *
 * Карточка: { id, title, channel, channelUrl, durationSec, live, upcoming, short, mix, watched, views, ageSec, lang, music }.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    enabled: false,
    scopes: { home: true, subs: true, search: true, related: true },
    hideShorts: false,
    hideLive: false,
    hideUpcoming: false,
    hideWatched: false,
    hideMixes: false,
    minMin: 0,
    maxMin: 0,
    langs: [], // показывать только эти языки; пусто — любые
    blockChannels: {}, // ключ канала → название
    blockWords: [], // слова и #хештеги: карточка скрывается, если есть хоть одно
    onlyWords: [], // если не пусто — показываются только карточки с одним из слов
    onlyMusic: false,
    sort: 'none', // none | newest | oldest | views | longest | shortest
    groupBy: 'none', // none | channel | kind | duration | lang | hashtag — «показать группами» вместо скрытия
    shuffle: 'none', // none | random | ai — порядок очереди «Слушать подряд»
    expandMixes: true, // доставать треки из миксов и джемов
  };
  const SORTS = ['none', 'newest', 'oldest', 'views', 'longest', 'shortest'];
  const GROUPS = ['none', 'channel', 'kind', 'duration', 'lang', 'hashtag'];
  const SHUFFLES = ['none', 'random', 'ai'];

  /** Случайный порядок (Фишер — Йейтс); исходный массив не меняется. */
  function shuffled(list, rnd = Math.random) {
    const a = Array.from(list || []);
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function normalizeRules(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const words = (a) => [...new Set((Array.isArray(a) ? a : []).map((w) => String(w || '').trim().toLowerCase()).filter(Boolean))].slice(0, 200);
    const num = (v) => Math.max(0, Math.min(600, Number(v) || 0));
    return {
      enabled: !!r.enabled,
      scopes: { ...DEFAULTS.scopes, ...(r.scopes && typeof r.scopes === 'object' ? r.scopes : {}) },
      hideShorts: !!r.hideShorts,
      hideLive: !!r.hideLive,
      hideUpcoming: !!r.hideUpcoming,
      hideWatched: !!r.hideWatched,
      hideMixes: !!r.hideMixes,
      minMin: num(r.minMin),
      maxMin: num(r.maxMin),
      langs: [...new Set((Array.isArray(r.langs) ? r.langs : []).map(String))].slice(0, 30),
      blockChannels: r.blockChannels && typeof r.blockChannels === 'object' ? { ...r.blockChannels } : {},
      blockWords: words(r.blockWords),
      onlyWords: words(r.onlyWords),
      onlyMusic: !!r.onlyMusic,
      sort: SORTS.includes(r.sort) ? r.sort : 'none',
      groupBy: GROUPS.includes(r.groupBy) ? r.groupBy : 'none',
      shuffle: SHUFFLES.includes(r.shuffle) ? r.shuffle : 'none',
      expandMixes: r.expandMixes !== false,
    };
  }

  // ---------- что написано в карточке ----------

  function durationToSec(s) {
    const m = String(s || '').trim().match(/^(\d+)(?::(\d{1,2}))?(?::(\d{1,2}))?$/);
    if (!m || m[2] === undefined) return 0;
    const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number);
    return parts.reduce((a, p) => a * 60 + p, 0);
  }

  // Множитель — сразу после числа. Без \b: в JS он не работает с кириллицей, поэтому «конец слова» — (?!\p{L}).
  const MULT = [
    [/^\s*(млрд|mrd|bln|billion|b)(?!\p{L})/iu, 1e9],
    [/^\s*(млн|mln|million|mio|m)(?!\p{L})/iu, 1e6],
    [/^\s*(тыс|k|thousand|mil)(?!\p{L})/iu, 1e3],
  ];

  /** «1,2 млн просмотров», «120 тыс.», «1.2M views», «3K», «15 482 просмотра» → число. */
  function parseCount(s) {
    const t = String(s || '').replace(/ /g, ' ').toLowerCase();
    const m = t.match(/(\d[\d\s.,]*)/);
    if (!m) return 0;
    let raw = m[1].trim();
    let mult = 1;
    const rest = t.slice(m.index + m[1].length);
    for (const [re, k] of MULT) {
      if (re.test(rest)) {
        mult = k;
        break;
      }
    }
    // «1,2» и «1.2» с множителем — дробь; «15 482» и «15,482» без множителя — разделители тысяч.
    if (mult > 1) raw = raw.replace(/\s/g, '').replace(',', '.');
    else raw = raw.replace(/[\s.,]/g, '');
    const n = parseFloat(raw);
    return Number.isFinite(n) ? Math.round(n * mult) : 0;
  }

  const AGE_UNITS = [
    [/(сек|second|sec)/i, 1],
    [/(мин|minute|min)/i, 60],
    [/(час|ч\.|hour|hr)/i, 3600],
    [/(дн|день|дня|day)/i, 86400],
    [/(нед|week|wk)/i, 604800],
    [/(мес|month|mo)/i, 2592000],
    [/(год|лет|г\.|л\.|year|yr)/i, 31536000],
  ];

  /** «3 дня назад», «11 л. назад», «2 weeks ago», «Streamed 5 hours ago» → секунды назад (0 — неизвестно). */
  function parseAge(s) {
    const t = String(s || '').toLowerCase();
    const m = t.match(/(\d+)\s*([^\d\s]+)/);
    if (!m) return 0;
    for (const [re, k] of AGE_UNITS) if (re.test(m[2])) return Number(m[1]) * k;
    return 0;
  }

  /**
   * Язык заголовка по письменности: кириллица (ru, uk — по буквам і ї є ґ), японский (кана), китайский,
   * корейский, арабский, иврит, греческий, деванагари, тайский; иначе latin (уточняется отдельно).
   */
  function scriptLang(text) {
    const t = String(text || '');
    const count = (re) => (t.match(re) || []).length;
    const letters = count(/\p{L}/gu) || 1;
    if (count(/[぀-ヿ]/g) > 0) return 'ja';
    if (count(/[가-힯]/g) / letters > 0.2) return 'ko';
    if (count(/[一-鿿]/g) / letters > 0.2) return 'zh';
    const cyr = count(/[Ѐ-ӿ]/g);
    if (cyr / letters > 0.3) return /[іїєґ]/i.test(t) ? 'uk' : /[ўі]/i.test(t) && !/[ыэъ]/i.test(t) ? 'be' : 'ru';
    if (count(/[؀-ۿ]/g) / letters > 0.3) return 'ar';
    if (count(/[֐-׿]/g) / letters > 0.3) return 'he';
    if (count(/[Ͱ-Ͽ]/g) / letters > 0.3) return 'el';
    if (count(/[ऀ-ॿ]/g) / letters > 0.3) return 'hi';
    if (count(/[฀-๿]/g) / letters > 0.3) return 'th';
    return letters > 1 ? 'latin' : '';
  }

  /** Хештеги из заголовка: «… #shorts #music» → ['#shorts', '#music']. */
  function hashtags(title) {
    return (String(title || '').match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase());
  }

  /** Ключ канала для блокировки: адрес (@handle или /channel/UC…), иначе имя. */
  function channelKey(card) {
    const u = String(card.channelUrl || '').split('?')[0];
    if (u) return u.toLowerCase();
    return String(card.channel || '').trim().toLowerCase();
  }

  // ---------- правила ----------

  /**
   * Скрыть ли карточку и почему. Ответ: { hide, reason } — reason: short | live | upcoming | watched | mix |
   * duration | lang | channel | word | only | music.
   */
  function decide(card, rules) {
    const r = rules;
    if (card.mix) return r.hideMixes || r.onlyMusic ? { hide: true, reason: 'mix' } : { hide: false };
    if (r.hideShorts && card.short) return { hide: true, reason: 'short' };
    if (r.hideLive && card.live) return { hide: true, reason: 'live' };
    if (r.hideUpcoming && card.upcoming) return { hide: true, reason: 'upcoming' };
    if (r.hideWatched && card.watched >= 80) return { hide: true, reason: 'watched' };
    const d = Number(card.durationSec) || 0;
    if (d > 0 && !card.short && ((r.minMin && d < r.minMin * 60) || (r.maxMin && d > r.maxMin * 60))) return { hide: true, reason: 'duration' };
    if (r.langs.length && card.lang && !r.langs.includes(card.lang)) return { hide: true, reason: 'lang' };
    if (Object.prototype.hasOwnProperty.call(r.blockChannels, channelKey(card))) return { hide: true, reason: 'channel' };
    const hay = `${card.title || ''} ${card.channel || ''}`.toLowerCase();
    if (r.blockWords.some((w) => hay.includes(w))) return { hide: true, reason: 'word' };
    if (r.onlyWords.length && !r.onlyWords.some((w) => hay.includes(w))) return { hide: true, reason: 'only' };
    if (r.onlyMusic && !(card.music >= 0.5)) return { hide: true, reason: 'music' };
    return { hide: false };
  }

  /** Число для сортировки (меньше — выше). Карточки без нужных данных уходят в конец. */
  function sortValue(card, mode) {
    const END = Number.MAX_SAFE_INTEGER;
    switch (mode) {
      case 'newest':
        return card.ageSec > 0 ? card.ageSec : END;
      case 'oldest':
        return card.ageSec > 0 ? -card.ageSec : END;
      case 'views':
        return card.views > 0 ? -card.views : END;
      case 'longest':
        return card.durationSec > 0 ? -card.durationSec : END;
      case 'shortest':
        return card.durationSec > 0 ? card.durationSec : END;
      default:
        return 0;
    }
  }

  /** Сводка по карточкам страницы: языки и каналы со счётчиками — для панели. */
  function summarize(cards) {
    const langs = {};
    const channels = {};
    for (const c of cards) {
      if (c.lang) langs[c.lang] = (langs[c.lang] || 0) + 1;
      const key = channelKey(c);
      if (key && c.channel) {
        const e = channels[key] || (channels[key] = { key, name: c.channel, count: 0 });
        e.count++;
      }
    }
    return {
      langs: Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
      channels: Object.values(channels).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    };
  }

  // ---------- группировка: показать карточки группами, а не скрывать ----------

  const KINDS = ['music', 'video', 'short', 'live', 'upcoming', 'mix'];
  const BUCKETS = ['under4', 'mid', 'long', 'over60', 'unknown'];

  /** Тип карточки для группировки: music | video | short | live | upcoming | mix. */
  function kindOf(card) {
    if (card.short) return 'short';
    if (card.live) return 'live';
    if (card.upcoming) return 'upcoming';
    if (card.mix) return 'mix';
    return card.music >= 0.5 ? 'music' : 'video';
  }

  /** Корзина длительности: under4 (до 4 мин), mid (4–20), long (20–60), over60, unknown. */
  function durationBucket(sec) {
    const d = Number(sec) || 0;
    if (d <= 0) return 'unknown';
    if (d < 240) return 'under4';
    if (d < 1200) return 'mid';
    if (d < 3600) return 'long';
    return 'over60';
  }

  /**
   * Карточки → группы: [{ key, labelKey?, label?, lang?, cards }].
   *   channel — по авторам (авторы с одним роликом собраны в «Остальные»);
   *   kind / duration — фиксированный порядок; lang — по числу; hashtag — теги, которые встретились минимум дважды.
   * labelKey — ключ перевода (подпись строит интерфейс), label — готовое название (имя автора, #тег), lang — код языка.
   */
  function groupCards(cards, by) {
    const list = Array.isArray(cards) ? cards : [];
    const OTHER = { key: '_other', labelKey: 'filter.group.other' };
    const byCount = (a, b) => b.cards.length - a.cards.length;
    const finish = (map, tail) => {
      const groups = Array.from(map.values()).filter((g) => g.cards.length);
      return tail && tail.cards.length ? [...groups, tail] : groups;
    };
    if (by === 'kind' || by === 'duration') {
      const order = by === 'kind' ? KINDS : BUCKETS;
      const prefix = by === 'kind' ? 'filter.kind.' : 'filter.dur.';
      const map = new Map(order.map((k) => [k, { key: k, labelKey: prefix + k, cards: [] }]));
      for (const c of list) map.get(by === 'kind' ? kindOf(c) : durationBucket(c.durationSec)).cards.push(c);
      return finish(map);
    }
    if (by === 'lang') {
      const map = new Map();
      const other = { ...OTHER, cards: [] };
      for (const c of list) {
        if (!c.lang) {
          other.cards.push(c);
          continue;
        }
        const g = map.get(c.lang) || map.set(c.lang, { key: c.lang, lang: c.lang, cards: [] }).get(c.lang);
        g.cards.push(c);
      }
      return finish(new Map([...map].sort((a, b) => byCount(a[1], b[1]))), other);
    }
    if (by === 'hashtag') {
      const counts = new Map();
      for (const c of list) for (const t of new Set(hashtags(c.title))) counts.set(t, (counts.get(t) || 0) + 1);
      const map = new Map();
      const other = { ...OTHER, cards: [] };
      for (const c of list) {
        const tags = [...new Set(hashtags(c.title))].filter((t) => counts.get(t) >= 2);
        if (!tags.length) other.cards.push(c);
        for (const t of tags) (map.get(t) || map.set(t, { key: t, label: t, cards: [] }).get(t)).cards.push(c);
      }
      return finish(new Map([...map].sort((a, b) => byCount(a[1], b[1]) || a[0].localeCompare(b[0]))), other);
    }
    // channel (по умолчанию)
    const map = new Map();
    for (const c of list) {
      const key = channelKey(c);
      if (!key || !c.channel) continue;
      const g = map.get(key) || map.set(key, { key, label: c.channel, channelUrl: c.channelUrl || '', cards: [] }).get(key);
      g.cards.push(c);
    }
    const other = { ...OTHER, cards: list.filter((c) => !channelKey(c) || !c.channel) };
    // Если повторяющихся авторов нет совсем, «Остальные» были бы одной кучей — тогда у каждого автора своя группа.
    const anyRepeat = Array.from(map.values()).some((g) => g.cards.length >= 2);
    const multi = new Map();
    for (const [k, g] of map) (g.cards.length >= 2 || !anyRepeat ? multi.set(k, g) : other.cards.push(...g.cards));
    return finish(new Map([...multi].sort((a, b) => byCount(a[1], b[1]) || a[1].label.localeCompare(b[1].label))), other);
  }

  const api = { DEFAULTS, SORTS, GROUPS, SHUFFLES, shuffled, kindOf, durationBucket, groupCards, normalizeRules, durationToSec, parseCount, parseAge, scriptLang, hashtags, channelKey, decide, sortValue, summarize };
  root.YFS = root.YFS || {};
  root.YFS.feedrules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
