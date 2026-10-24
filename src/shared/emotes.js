/*
 * Смайлики из открытых API: 7TV, BetterTTV, FrankerFaceZ — как у расширения 7TV, плюс «ивентовские» наборы
 * (Хэллоуин, Пасха, Рождество и Новый год, День святого Валентина, лето, прайд).
 *
 * Чистые функции без сети и DOM: адреса запросов, разбор ответов в единый вид [имя, адрес картинки, анимированный],
 * разбор ссылки на набор, подстановка смайликов в текст (по словам, с учётом регистра). Запросы делает фоновый скрипт.
 */
(function (root) {
  'use strict';

  const API = {
    stvSet: (id) => `https://7tv.io/v3/emote-sets/${encodeURIComponent(id)}`,
    stvGql: 'https://7tv.io/v3/gql',
    bttvGlobal: 'https://api.betterttv.net/3/cached/emotes/global',
    ffzGlobal: 'https://api.frankerfacez.com/v1/set/global',
  };
  const CDN = {
    stv: (id) => `https://cdn.7tv.app/emote/${id}/2x.webp`,
    bttv: (id) => `https://cdn.betterttv.net/emote/${id}/2x.webp`,
  };

  /** Наборы из списка настроек. kind: set (готовый набор), search (поиск по 7TV), custom (набор по id из ссылки). */
  const PACKS = [
    { id: '7tv-global', icon: '🟦', kind: 'stv-set', setId: 'global' },
    { id: 'bttv-global', icon: '🟧', kind: 'bttv' },
    { id: 'ffz-global', icon: '🟪', kind: 'ffz' },
    { id: 'event-halloween', icon: '🎃', kind: 'stv-search', terms: ['halloween', 'spooky', 'pumpkin', 'ghost'] },
    { id: 'event-easter', icon: '🐣', kind: 'stv-search', terms: ['easter', 'bunny', 'egg'] },
    { id: 'event-christmas', icon: '🎄', kind: 'stv-search', terms: ['christmas', 'xmas', 'santa', 'newyear'] },
    { id: 'event-valentine', icon: '💝', kind: 'stv-search', terms: ['valentine', 'cupid', 'lovely'] },
    { id: 'event-summer', icon: '🏖️', kind: 'stv-search', terms: ['summer', 'beach', 'vacation'] },
    { id: 'event-pride', icon: '🏳️‍🌈', kind: 'stv-search', terms: ['pride', 'rainbow'] },
  ];
  const PACK_IDS = PACKS.map((p) => p.id);
  const PER_TERM = 30;
  const MAX_PER_PACK = 120;

  /** Id набора 7TV из того, что вставил человек: id или ссылка вида https://7tv.app/emote-sets/<id>. */
  function parseSetInput(text) {
    const t = String(text || '').trim();
    const m = t.match(/(?:emote-sets?\/)?([0-9A-HJKMNP-TV-Z]{26})\b/i) || t.match(/emote-sets?\/([\w-]{8,40})/i);
    return m ? m[1] : '';
  }

  const clean = (name) => String(name || '').trim();
  const valid = (name) => /^[^\s]{2,40}$/.test(name);

  /** Ответ 7TV (набор: { emotes: [{ id, name, data: { animated, listed } }] }) → [[имя, адрес, анимированный]]. */
  function parseStvSet(json) {
    const out = [];
    for (const e of (json && json.emotes) || []) {
      const name = clean(e.name);
      const id = e.id || (e.data && e.data.id);
      if (!id || !valid(name)) continue;
      out.push([name, CDN.stv(id), !!(e.data && e.data.animated)]);
    }
    return out;
  }

  /** Результат поиска 7TV (GraphQL): { data: { emotes: { items: [{ id, name, animated, listed }] } } }. */
  function parseStvSearch(json) {
    const items = (json && json.data && json.data.emotes && json.data.emotes.items) || [];
    return items.filter((e) => e && e.id && e.listed !== false && valid(clean(e.name))).map((e) => [clean(e.name), CDN.stv(e.id), !!e.animated]);
  }

  /** BetterTTV: [{ id, code, animated, modifier }]. Модификаторы (эффекты поверх смайлика) пропускаем. */
  function parseBttv(json) {
    return (Array.isArray(json) ? json : [])
      .filter((e) => e && e.id && !e.modifier && valid(clean(e.code)))
      .map((e) => [clean(e.code), CDN.bttv(e.id), !!e.animated]);
  }

  /** FrankerFaceZ: { default_sets: [3], sets: { 3: { emoticons: [{ name, urls: { 1, 2, 4 } }] } } }. */
  function parseFfz(json) {
    const out = [];
    const sets = (json && json.sets) || {};
    for (const key of (json && json.default_sets) || Object.keys(sets)) {
      for (const e of (sets[key] && sets[key].emoticons) || []) {
        const url = e.urls && (e.urls['2'] || e.urls['1'] || e.urls['4']);
        if (!url || e.modifier || !valid(clean(e.name))) continue;
        out.push([clean(e.name), String(url).replace(/^\/\//, 'https://'), false]);
      }
    }
    return out;
  }

  // ---------- 7TV: поиск стримера по имени и набор смайликов канала ----------

  /** Имя для сравнения: без «@», пробелов, точек, дефисов и подчёркиваний, в нижнем регистре («Bet Boom_» → «betboom»). */
  const normName = (x) => String(x || '').toLowerCase().replace(/^@+/, '').replace(/[\s._-]+/g, '');
  const SET_ID = /^[\w-]{8,40}$/;
  const PLATFORM_RANK = { YOUTUBE: 0, TWITCH: 1, KICK: 2, DISCORD: 3 };

  /** Запрос: пользователи 7TV по имени (с привязанными аккаунтами и выбранным у каждого набором смайликов). */
  function stvUsersBody(q) {
    return JSON.stringify({
      query: 'query($q:String!){users(query:$q){id username display_name connections{platform username display_name emote_set_id}}}',
      variables: { q: String(q) },
    });
  }

  /** Ответ → [{ user, name, platform, setId, conns: [{ platform, names }] }] — только те, у кого есть набор смайликов. */
  function parseStvUsers(json) {
    const out = [];
    for (const u of (json && json.data && json.data.users) || []) {
      if (!u || !u.id) continue;
      const conns = (u.connections || []).filter((c) => c && c.platform);
      const withSet = conns.filter((c) => SET_ID.test(String(c.emote_set_id || ''))).sort((a, b) => (PLATFORM_RANK[a.platform] ?? 9) - (PLATFORM_RANK[b.platform] ?? 9));
      if (!withSet.length) continue;
      out.push({
        user: String(u.id),
        name: clean(u.display_name || u.username),
        platform: String(withSet[0].platform),
        setId: String(withSet[0].emote_set_id),
        conns: conns.map((c) => ({ platform: String(c.platform), names: [normName(c.username), normName(c.display_name)].filter(Boolean) })),
        own: [normName(u.username), normName(u.display_name)].filter(Boolean),
      });
    }
    return out;
  }

  /** Запрос: названия и число смайликов у наборов по id. */
  function stvSetsBody(ids) {
    return JSON.stringify({
      query: 'query($ids:[ObjectID!]!){emoteSetsByID(list:$ids){id name emote_count}}',
      variables: { ids: ids.map(String) },
    });
  }

  /** Ответ → { id: { name, count } }. */
  function parseStvSetInfo(json) {
    const out = {};
    for (const s of (json && json.data && json.data.emoteSetsByID) || []) if (s && s.id) out[s.id] = { name: clean(s.name), count: Number(s.emote_count) || 0 };
    return out;
  }

  /**
   * Тот же человек среди найденных по имени канала: имя совпадает ТОЧНО (без пробелов, точек и регистра) с именем
   * или ником канала у него самого или у одного из привязанных аккаунтов. Похожие, но другие имена не берём.
   * Совпадение по привязанному YouTube-аккаунту важнее остальных. names — [название канала, @ник, имя владельца в чате].
   */
  function matchChannel(users, names) {
    const want = [...new Set((names || []).map(normName).filter((n) => n.length >= 3))];
    let best = null;
    let bestScore = 0;
    for (const u of users || []) {
      let score = 0;
      for (const n of want) {
        if (u.conns.some((c) => c.platform === 'YOUTUBE' && c.names.includes(n))) score = Math.max(score, 3);
        else if (u.conns.some((c) => c.names.includes(n))) score = Math.max(score, 2);
        else if (u.own.includes(n)) score = Math.max(score, 1);
      }
      if (score > bestScore) {
        best = u;
        bestScore = score;
      }
    }
    return best;
  }

  /** Запрос поиска 7TV по слову (самые популярные). */
  function stvSearchBody(term, limit = PER_TERM) {
    return JSON.stringify({
      query: 'query($q:String!,$l:Int){emotes(query:$q,page:1,limit:$l,sort:{value:"popularity",order:DESCENDING}){count items{id name animated listed}}}',
      variables: { q: String(term), l: limit },
    });
  }

  /** Слить списки по порядку: имя, встретившееся раньше, не перекрывается позднейшим; не больше max. */
  function merge(lists, max = MAX_PER_PACK) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const e of list) {
        if (seen.has(e[0])) continue;
        seen.add(e[0]);
        out.push(e);
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  /**
   * Разбить текст на части: слова-смайлики становятся { t: 'emote', name, url, animated }, остальное — { t: 'text', v }.
   * map — Map имя → { url, animated }. Имя ищется целым словом, с учётом регистра (как у 7TV).
   */
  function tokenize(text, map) {
    const parts = [];
    if (!map || !map.size) return [{ t: 'text', v: String(text || '') }];
    let buf = '';
    for (const piece of String(text || '').split(/(\s+)/)) {
      const e = piece && !/^\s+$/.test(piece) ? map.get(piece) : null;
      if (e) {
        if (buf) parts.push({ t: 'text', v: buf });
        buf = '';
        parts.push({ t: 'emote', name: piece, url: e.url, animated: !!e.animated });
      } else buf += piece;
    }
    if (buf) parts.push({ t: 'text', v: buf });
    return parts;
  }

  /** Карта имя → смайлик из наборов в порядке приоритета (первый набор главнее). sets: { id: [[имя, адрес, анимированный]] }. */
  function buildMap(order, sets) {
    const map = new Map();
    for (const id of order) {
      for (const [name, url, animated] of (sets && sets[id]) || []) if (!map.has(name)) map.set(name, { url, animated, set: id });
    }
    return map;
  }

  const api = { API, CDN, PACKS, PACK_IDS, PER_TERM, MAX_PER_PACK, SET_ID, normName, stvUsersBody, parseStvUsers, stvSetsBody, parseStvSetInfo, matchChannel, parseSetInput, parseStvSet, parseStvSearch, parseBttv, parseFfz, stvSearchBody, merge, tokenize, buildMap };
  root.YFS = root.YFS || {};
  root.YFS.emotes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
