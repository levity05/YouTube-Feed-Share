/*
 * Чат и раскладка прямых трансляций: настройки и правила (чистые функции, без DOM).
 * Их используют content/livechat.js (сам чат), content/livemode.js (раскладка страницы), настройки и Node-тесты.
 *
 * Сообщение: { id, author, text, type, own } — type: text | paid | member | system.
 */
(function (root) {
  'use strict';

  const DEFAULT_BOTS = ['nightbot', 'streamelements', 'moobot', 'fossabot', 'streamlabs', 'wizebot', 'botrix'];

  const DEFAULTS = {
    // чат
    theme: 'twitch', // twitch — сообщения одной строкой «ник: текст», как на Twitch | youtube — как было
    emojiSet: 'youtube', // youtube | native | twemoji | apple | google (Noto) | facebook | openmoji
    emojiSize: 24,
    nameColors: true, // ники разными цветами, как на Twitch / 7TV
    quickReply: true, // клик по нику — «@ник » в поле ввода
    highlightMentions: true,
    mentionSound: true,
    soundVolume: 0.6,
    aliases: [], // ещё имена, на которые реагировать (кроме своего ника)
    keywords: [], // слова, сообщения с которыми подсвечиваются
    hiddenUsers: {}, // ник (в нижнем регистре) → как писался
    hideBots: false,
    bots: DEFAULT_BOTS,
    hideCommands: false, // сообщения, которые начинаются с «!»
    fontSize: 14,
    timestamps: 'show', // show — ЧЧ:ММ без секунд | auto — как в YouTube | hide
    alternate: false, // полосы через строку
    compact: false,
    hideAvatars: false,
    hideTicker: false, // полоса платных сообщений сверху
    hidePaid: false, // суперчаты и стикеры в ленте
    hideMembers: false, // «новый спонсор», вехи
    hideSystem: false, // служебные сообщения YouTube
    // раскладка страницы трансляции
    layout: true,
    chatWidth: 420,
    chatSide: 'right', // right | left
    chatFullHeight: true,
    chatTall: true, // поднять чат к шапке YouTube: выше и без пустой полосы над ним
    hideRelated: true,
    hideBelow: false,
    // мини-чат: за кем следим
    watch: [],
    emoteSets: [], // наборы смайликов с сайтов: 7tv-global, bttv-global, ffz-global, event-halloween … (src/shared/emotes.js)
    emoteCustom: '', // свой набор 7TV: id или ссылка
    emoteChannel: false, // смайлики этого канала на 7TV (ищутся по названию канала)
    emoteChannelSet: null, // найденное: { key — название канала, id — набор (пусто: не нашли), name, count }
    emoteExtra: [], // добавленное из поиска 7TV: [{ id, name }] — набор стримера, либо { id: 'q:слово' } — самые популярные по слову
    emoteSize: 28,
    allMessages: true, // «Все сообщения»: вместо «Топ чата» (отфильтрованного YouTube) включить обычный чат
    groupMention: true, // в вкладке «Группа» ответ начинается с «@ник1 @ник2 »
    showBadges: true, // значки ведущего, модератора, спонсора
    paidInline: true, // суперчаты в ленте карточками
  };

  const TS = ['show', 'auto', 'hide'];
  const THEMES = ['twitch', 'youtube'];
  const EMOJI_SETS = ['youtube', 'native', 'twemoji', 'apple', 'google', 'facebook', 'openmoji'];
  const words = (a, max = 100) => [...new Set((Array.isArray(a) ? a : []).map((w) => String(w || '').trim()).filter(Boolean))].slice(0, max);
  const num = (v, a, b, d) => (Number.isFinite(Number(v)) ? Math.max(a, Math.min(b, Number(v))) : d);

  function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const bool = (k) => (typeof r[k] === 'boolean' ? r[k] : DEFAULTS[k]);
    const out = {};
    for (const k of Object.keys(DEFAULTS)) if (typeof DEFAULTS[k] === 'boolean') out[k] = bool(k);
    out.soundVolume = num(r.soundVolume, 0, 1, DEFAULTS.soundVolume);
    out.fontSize = Math.round(num(r.fontSize, 11, 22, DEFAULTS.fontSize));
    out.chatWidth = Math.round(num(r.chatWidth, 300, 900, DEFAULTS.chatWidth));
    out.chatSide = r.chatSide === 'left' ? 'left' : 'right';
    out.timestamps = TS.includes(r.timestamps) ? r.timestamps : DEFAULTS.timestamps;
    out.theme = THEMES.includes(r.theme) ? r.theme : DEFAULTS.theme;
    out.emojiSet = EMOJI_SETS.includes(r.emojiSet) ? r.emojiSet : DEFAULTS.emojiSet;
    out.emojiSize = Math.round(num(r.emojiSize, 16, 48, DEFAULTS.emojiSize));
    out.aliases = words(r.aliases, 20);
    out.keywords = words(r.keywords, 100);
    out.bots = r.bots === undefined ? DEFAULTS.bots.slice() : words(r.bots, 100).map((b) => b.toLowerCase());
    out.watch = words(r.watch, 20);
    out.emoteSets = [...new Set((Array.isArray(r.emoteSets) ? r.emoteSets : []).map(String).filter((x) => /^[a-z0-9-]{3,30}$/.test(x)))].slice(0, 12);
    out.emoteCustom = String(r.emoteCustom || '').trim().slice(0, 200);
    const cs = r.emoteChannelSet;
    out.emoteChannelSet = cs && typeof cs === 'object' && typeof cs.key === 'string' ? { key: cs.key.slice(0, 60), id: /^[\w-]{8,40}$/.test(String(cs.id || '')) ? String(cs.id) : '', name: String(cs.name || '').slice(0, 40), count: Math.max(0, Math.round(Number(cs.count) || 0)) } : null;
    const seenExtra = new Set();
    out.emoteExtra = (Array.isArray(r.emoteExtra) ? r.emoteExtra : [])
      .map((x) => ({ id: String((x && x.id) || ''), name: String((x && x.name) || '').trim().slice(0, 40) }))
      .filter((x) => (/^[\w-]{8,40}$/.test(x.id) || /^q:[\p{L}\p{N}_-]{2,30}$/u.test(x.id)) && x.name && !seenExtra.has(x.id) && seenExtra.add(x.id))
      .slice(0, 10);
    out.emoteSize = Math.round(num(r.emoteSize, 16, 64, DEFAULTS.emoteSize));
    out.hiddenUsers = r.hiddenUsers && typeof r.hiddenUsers === 'object' ? { ...r.hiddenUsers } : {};
    return out;
  }

  /** Ник без «@» и лишних пробелов, в нижнем регистре — ключ для сравнения. */
  const nameKey = (name) => String(name || '').replace(/^@+/, '').trim().toLowerCase();

  /**
   * Цвет ника по его имени: один и тот же ник — всегда один цвет, на тёмном и светлом фоне читается.
   * Оттенок — из хеша имени, насыщенность и яркость подобраны под тему.
   */
  // Пятнадцать стандартных цветов ников Twitch — в вариантах, которые читаются на тёмном и на светлом фоне.
  const TWITCH_DARK = ['#ff4d4d', '#7a7aff', '#2ecc40', '#e86060', '#ff7f50', '#9acd32', '#ff6a33', '#3cb371', '#daa520', '#e0803d', '#6fb5b8', '#1e90ff', '#ff69b4', '#a970ff', '#00e676'];
  const TWITCH_LIGHT = ['#d40000', '#0000cc', '#007a00', '#b22222', '#d2593a', '#6b8e23', '#e03e00', '#2e8b57', '#b8860b', '#d2691e', '#4c8a8c', '#1873cc', '#d63384', '#8a2be2', '#00a35a'];

  function hashName(name) {
    const s = nameKey(name);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  /** palette: 'twitch' — один из 15 цветов Twitch, иначе — любой оттенок из хеша. */
  function nameColor(name, dark = true, palette) {
    const h = hashName(name);
    if (palette === 'twitch') return (dark ? TWITCH_DARK : TWITCH_LIGHT)[h % 15];
    const hue = h % 360;
    return dark ? `hsl(${hue} 75% 68%)` : `hsl(${hue} 70% 36%)`;
  }

  /**
   * Время сообщения без секунд, 24 часа: «12:07 PM» → «12:07», «1:05:33 AM» → «01:05», «9:41» → «09:41».
   * Пусто — если это не время суток (например, смещение в повторе трансляции «1:02:33»).
   */
  function chatTime(text) {
    const t = String(text || '').trim();
    const m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?\s?m\.?|午前|午後|上午|下午|ДП|ПП)?$/i);
    if (!m) return '';
    let h = Number(m[1]);
    const ampm = (m[3] || '').toLowerCase();
    if (/^p|午後|下午|пп/.test(ampm) && h < 12) h += 12;
    if (/^a|午前|上午|дп/.test(ampm) && h === 12) h = 0;
    if (h > 23) return '';
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }

  // ---------- смайлики: те же символы Юникода, другой набор картинок ----------

  const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
  /** Стандартный ли это эмодзи (а не свой смайлик канала вроде «:_hello:»). */
  const isEmoji = (alt) => !!alt && !/^:.*:$/.test(alt) && EMOJI_RE.test(alt);

  /** Коды символов эмодзи в нижнем регистре: «😂» → ['1f602'], «❤️» → ['2764', 'fe0f']. */
  function emojiCodes(str) {
    return Array.from(String(str || '')).map((ch) => ch.codePointAt(0).toString(16));
  }

  const BASE = {
    twemoji: 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/',
    openmoji: 'https://cdn.jsdelivr.net/npm/openmoji@15.1.0/color/svg/',
    datasource: (set) => `https://cdn.jsdelivr.net/npm/emoji-datasource-${set}@15.1.2/img/${set}/64/`,
  };

  /**
   * Адреса картинки эмодзи в выбранном наборе — по порядку, какой пробовать (у наборов разные правила
   * про невидимый символ FE0F в имени файла). Пусто для youtube и native: там картинка не нужна.
   */
  function emojiUrls(set, str) {
    const codes = emojiCodes(str);
    if (!codes.length) return [];
    const bare = codes.filter((c) => c !== 'fe0f');
    const zwj = codes.includes('200d');
    const variants = (a, b) => [...new Set([a, b])];
    switch (set) {
      case 'twemoji':
        return variants((zwj ? codes : bare).join('-'), codes.join('-')).map((n) => BASE.twemoji + n + '.svg');
      case 'openmoji':
        return variants(bare.join('-').toUpperCase(), codes.join('-').toUpperCase()).map((n) => BASE.openmoji + n + '.svg');
      case 'apple':
      case 'google':
      case 'facebook':
        return variants(codes.join('-'), bare.join('-')).map((n) => BASE.datasource(set) + n + '.png');
      default:
        return [];
    }
  }

  /** Куда уходят запросы за картинками смайликов (для подсказки о приватности). */
  const EMOJI_HOST = 'cdn.jsdelivr.net';

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Упоминание: «@ник» где угодно или ник отдельным словом. names — свой ник и псевдонимы. */
  function isMention(text, names) {
    const t = String(text || '');
    for (const n of names || []) {
      const k = String(n || '').replace(/^@+/, '').trim();
      if (k.length < 2) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escapeRe(k)}(?![\\p{L}\\p{N}_])`, 'iu');
      if (re.test(t)) return true;
    }
    return false;
  }

  /** Есть ли в тексте слово из списка (без учёта регистра). */
  function hasKeyword(text, keywords) {
    const t = String(text || '').toLowerCase();
    return (keywords || []).some((k) => k && t.includes(String(k).toLowerCase()));
  }

  /** Почему сообщение скрыть (или '' — показывать): user | bot | command | paid | member | system. */
  function hideReason(msg, s) {
    const who = nameKey(msg.author);
    if (msg.own) return '';
    if (who && Object.prototype.hasOwnProperty.call(s.hiddenUsers, who)) return 'user';
    if (s.hideBots && who && s.bots.includes(who)) return 'bot';
    if (s.hideCommands && msg.type === 'text' && /^\s*!\S/.test(msg.text || '')) return 'command';
    if (s.hidePaid && msg.type === 'paid') return 'paid';
    if (s.hideMembers && msg.type === 'member') return 'member';
    if (s.hideSystem && msg.type === 'system') return 'system';
    return '';
  }

  // ---------- личные вкладки чата: «Группа» и отдельные люди ----------

  /** Начинается ли текст с обращения «@ник» (имя целиком, без учёта регистра). */
  function startsWithMention(text, name) {
    const n = nameKey(name);
    if (!n) return false;
    const t = String(text || '').trim().replace(/^@+/, '').toLowerCase();
    if (!t.startsWith(n)) return false;
    const next = t.charAt(n.length);
    return !next || !/[\p{L}\p{N}_]/u.test(next);
  }

  /**
   * Относится ли запись к вкладке: chat — всё; group — все выбранные люди; иначе — один человек.
   * Свои сообщения попадают во вкладку, из которой отправлены (entry.thread), а если такой пометки нет
   * (отправлено из общего чата) — когда начинаются с «@ника» этого человека.
   * watch — выбранные имена, thread — 'chat' | 'group' | ключ человека (nameKey).
   */
  function inThread(entry, thread, watch) {
    if (!entry || thread === 'chat' || !thread) return true;
    const keys = new Set((watch || []).map(nameKey));
    const mine = !!entry.own;
    if (thread === 'group') {
      if (mine) return entry.thread === 'group' || (watch || []).some((w) => startsWithMention(entry.text, w));
      return keys.has(entry.key);
    }
    if (mine) return entry.thread === thread || (!entry.thread && (watch || []).some((w) => nameKey(w) === thread && startsWithMention(entry.text, w)));
    return entry.key === thread;
  }

  /** Текст с учётом вкладки: у человека — «@ник текст», у группы — «@ник1 @ник2 текст» (если включено). */
  function composeText(text, thread, watch, groupMention = true) {
    const t = String(text || '').trim();
    if (!t) return '';
    const list = (watch || []).map((w) => String(w).replace(/^@+/, ''));
    if (thread === 'group') {
      if (!groupMention || /^@/.test(t)) return t;
      const prefix = list.slice(0, 5).map((w) => '@' + w).join(' ');
      return prefix ? prefix + ' ' + t : t;
    }
    const who = list.find((w) => nameKey(w) === thread);
    if (who && !startsWithMention(t, who) && !/^@/.test(t)) return '@' + who + ' ' + t;
    return t;
  }

  /** Слово «@пре…» перед кареткой: { start, query } или null — для подсказки ников при наборе. */
  function mentionQuery(text, caret) {
    const before = String(text || '').slice(0, caret);
    const m = before.match(/(^|[\s,.;!?])@([^\s@]*)$/u);
    return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
  }

  /** Подсказка ников: сначала начинающиеся с запроса, затем содержащие; без повторов, не больше limit. */
  function suggestNames(names, query, limit = 6) {
    const q = nameKey(query);
    const seen = new Set();
    const starts = [];
    const has = [];
    for (const n of names || []) {
      const k = nameKey(n);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      if (!q || k.startsWith(q)) starts.push(n);
      else if (k.includes(q)) has.push(n);
    }
    return [...starts, ...has].slice(0, limit);
  }

  /** Текст для мини-чата: если следим за одним человеком, ответ начинается с «@ник ». */
  function replyText(text, watch) {
    const t = String(text || '').trim();
    if (!t) return '';
    if (/^@/.test(t) || !watch || watch.length !== 1) return t;
    return `@${String(watch[0]).replace(/^@+/, '')} ${t}`;
  }

  const api = { DEFAULTS, DEFAULT_BOTS, THEMES, EMOJI_SETS, EMOJI_HOST, normalize, nameKey, nameColor, chatTime, startsWithMention, inThread, composeText, mentionQuery, suggestNames, isEmoji, emojiCodes, emojiUrls, isMention, hasKeyword, hideReason, replyText };
  root.YFS = root.YFS || {};
  root.YFS.liverules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
