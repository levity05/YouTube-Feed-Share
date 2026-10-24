/*
 * ⭐ Подборка по вкусу — без AI.
 *
 * Из истории просмотров (до ~100 роликов) строится профиль вкуса: какие авторы и какие слова встречаются
 * в просмотренном, какой длины ролики смотрите, на каких языках. Каждая карточка ленты оценивается по похожести
 * (авторы, слова, длительность, язык) — это обычные вычисления, запросов к AI нет. Для найденных роликов
 * мини-описание берётся из описания самого видео (страница ролика), причина — «тот же автор» и общие темы.
 *
 * Чистые функции без DOM и сети: используются в content/feedfilter.js и в Node-тестах.
 * Видео: { id, title, channel, channelUrl, durationSec, progress (0–100), short, live, upcoming, mix, lang, keywords, desc }.
 */
(function (root) {
  'use strict';

  const STOP = new Set(
    (
      'the a an and or of to in on for with is are was were be as at by from it its this that these those how what why when where who which my your you i we they he she vs not no do does did can will just more most all any' +
      ' official video videos new full best top part episode ep live stream hd 4k 1080p shorts short trailer teaser clip clips subscribe channel' +
      ' и в во на с со по для как что это не а но или из за от до про при об без под над мой моя мои ваш вы я мы он она они его её их то кто где когда почему все всё еще ещё уже тоже так там тут' +
      ' можно будет был была были есть нет да вот чем чтобы если очень самый самая видео новый новая новые новое выпуск часть серия стрим эфир полный полная лучший лучшие смотреть канал подписывайся' +
      ' і та й в у на з зі до від про при без під над як що це не а але або чи для'
    ).split(/\s+/)
  );

  /** Окончания, которые отрезаются, чтобы «покер», «покера», «покере» считались одним словом. */
  const RU_END = /(ыми|ими|ого|его|ому|ему|ами|ями|ах|ях|ов|ев|ей|ом|ем|ам|ям|ий|ый|ой|ая|яя|ое|ее|ые|ие|ую|юю|ть|ся|а|я|ы|и|у|ю|е|о|ь)$/u;
  const EN_END = /(ing|ed|es|s)$/;

  function stem(word) {
    let w = word;
    if (/[а-яёіїєґ]/u.test(w)) {
      if (w.length > 4) w = w.replace(RU_END, '');
      if (w.length > 4) w = w.replace(RU_END, '');
    } else if (w.length > 4) w = w.replace(EN_END, '').replace(/([^aeiou])\1$/, '$1');
    else if (w.length > 3 && /[^s]s$/.test(w)) w = w.slice(0, -1);
    return w.slice(0, 9);
  }

  /** Как слово выглядело в тексте (самая короткая из встреченных форм): основа «начинающи» на экране — «начинающий». */
  const SURFACE = new Map();
  const show = (term) => SURFACE.get(term) || term;

  /** Слова текста без служебных, в основной форме: «Как я сломал логику Hitman…» → [сломал…, логик, hitman]. */
  function tokens(text) {
    const out = [];
    for (const raw of String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’+#-]*/gu) || []) {
      const w = raw.replace(/^[#'’+-]+|['’+-]+$/g, '');
      if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w)) continue;
      const s = stem(w);
      if (s.length >= 3 && !STOP.has(s)) {
        out.push(s);
        const known = SURFACE.get(s);
        if (!known || w.length < known.length) {
          if (SURFACE.size > 6000) SURFACE.clear();
          SURFACE.set(s, w);
        }
      }
    }
    return out;
  }

  const hashtags = (text) => (String(text || '').toLowerCase().match(/#[\p{L}\p{N}_]{3,}/gu) || []).map((t) => t.slice(1));

  /** Слова ролика с весами: заголовок 1, хештеги 1.5, ключевые слова видео 1.2, начало описания 0.4. */
  function termsOf(v) {
    const m = new Map();
    const add = (list, w) => {
      for (const t of list) m.set(t, (m.get(t) || 0) + w);
    };
    add(tokens(v.title), 1);
    add(tokens(hashtags(v.title).join(' ')), 0.5);
    add((v.keywords || []).flatMap((k) => tokens(k)), 1.2);
    add(tokens(String(v.desc || '').slice(0, 240)), 0.4);
    return m;
  }

  const chKey = (v) => String(v.channelUrl || v.channel || '').trim().toLowerCase();

  function weightedMedian(pairs) {
    const sorted = pairs.filter((p) => p[0] > 0).sort((a, b) => a[0] - b[0]);
    const total = sorted.reduce((a, p) => a + p[1], 0);
    if (!total) return 0;
    let acc = 0;
    for (const [x, w] of sorted) {
      acc += w;
      if (acc >= total / 2) return x;
    }
    return sorted[sorted.length - 1][0];
  }

  /**
   * Профиль вкуса. history — от новых к старым. Вес ролика: свежесть (e^(-i/60)) × доля досмотренного
   * (недосмотренное и «закрыл через минуту» почти не считаются).
   */
  function buildProfile(history) {
    const list = (Array.isArray(history) ? history : []).filter((v) => v && v.id);
    const terms = new Map();
    const channels = new Map();
    const langs = new Map();
    const durs = [];
    let shorts = 0;
    let totalW = 0;
    list.forEach((v, i) => {
      const progress = Number.isFinite(v.progress) && v.progress > 0 ? Math.min(100, v.progress) / 100 : 0.7; // нет данных — считаем «досмотрено наполовину и больше»
      const w = Math.exp(-i / 60) * (0.35 + 0.65 * progress);
      totalW += w;
      for (const [t, c] of termsOf(v)) terms.set(t, (terms.get(t) || 0) + w * c);
      const k = chKey(v);
      if (k) {
        const e = channels.get(k) || { key: k, name: v.channel || k, w: 0, count: 0 };
        e.w += w;
        e.count++;
        channels.set(k, e);
      }
      if (v.lang) langs.set(v.lang, (langs.get(v.lang) || 0) + w);
      if (v.durationSec > 0) durs.push([v.durationSec, w]);
      if (v.short) shorts += w;
    });
    const langTotal = Array.from(langs.values()).reduce((a, x) => a + x, 0) || 1;
    for (const [k, x] of langs) langs.set(k, x / langTotal);
    return {
      n: list.length,
      terms,
      channels,
      langs,
      medianDur: weightedMedian(durs),
      shortsShare: totalW ? shorts / totalW : 0,
      seen: new Set(list.map((v) => v.id)),
      // Ссылка на канал в карточке ленты и в истории может быть записана по-разному — ищем ещё и по названию.
      byName: new Map(Array.from(channels.values()).map((c) => [String(c.name).trim().toLowerCase(), c])),
      norm: Math.sqrt(Array.from(terms.values()).reduce((a, x) => a + x * x, 0)) || 1,
    };
  }

  /** Самые весомые слова и авторы профиля — для показа и короткого запроса к AI. */
  function summarize(profile, limit = 8) {
    return {
      videos: profile.n,
      terms: Array.from(profile.terms).sort((a, b) => b[1] - a[1]).slice(0, limit).map((x) => show(x[0])),
      channels: Array.from(profile.channels.values()).sort((a, b) => b.w - a.w).slice(0, limit).map((c) => ({ name: c.name, count: c.count })),
      medianMin: Math.round(profile.medianDur / 60),
    };
  }

  /**
   * Ранжирование карточек ленты. Возвращает [{ video, score, reasons }] по убыванию, не больше limit,
   * не больше двух роликов одного автора (чтобы подборка не состояла из одного канала).
   * opts: { limit, seen:Set (дополнительно просмотренные), banned:{ channels:Set }, liked:{ channels:Set }, perChannel }
   */
  function rank(cands, profile, opts = {}) {
    if (!profile || !profile.n) return [];
    const limit = opts.limit || 5;
    const perChannel = opts.perChannel || 2;
    const bannedCh = (opts.banned && opts.banned.channels) || new Set();
    const likedCh = (opts.liked && opts.liked.channels) || new Set();
    const seen = new Set([...profile.seen, ...(opts.seen || [])]);
    const pool = (Array.isArray(cands) ? cands : []).filter((v) => v && v.id && !seen.has(v.id) && !v.live && !v.upcoming && !v.mix && !(v.short && profile.shortsShare < 0.3) && !bannedCh.has(chKey(v)));
    // idf по истории и кандидатам вместе: частое везде слово («обзор») почти ничего не значит.
    const df = new Map();
    const docs = pool.map((v) => termsOf(v));
    for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) || 0) + 1);
    for (const t of profile.terms.keys()) df.set(t, (df.get(t) || 0) + 1);
    const N = docs.length + 1;
    const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));
    const maxCh = Math.max(0.0001, ...Array.from(profile.channels.values()).map((c) => c.w));
    const scored = pool.map((v, i) => {
      const d = docs[i];
      let dot = 0;
      let cn = 0;
      const hits = [];
      for (const [t, c] of d) {
        const wi = idf(t);
        cn += (c * wi) ** 2;
        const pw = profile.terms.get(t);
        if (pw) {
          dot += (c * wi) * (pw * wi);
          hits.push([t, c * pw * wi * wi]);
        }
      }
      // Профиль нормируется без idf — для сравнения кандидатов между собой это не важно.
      const term = cn && dot ? Math.min(1, dot / (Math.sqrt(cn) * profile.norm * 2.2)) : 0;
      const key = chKey(v);
      const ch = profile.channels.get(key) || (profile.byName && profile.byName.get(String(v.channel || '').trim().toLowerCase())) || null;
      const channel = ch ? Math.min(1, Math.log(1 + ch.w) / Math.log(1 + maxCh)) : 0;
      let dur = 0.5;
      if (v.durationSec > 0 && profile.medianDur > 0) {
        const z = Math.log(v.durationSec / profile.medianDur) / 0.9;
        dur = Math.exp(-(z * z) / 2);
      }
      const lang = v.lang && profile.langs.size ? profile.langs.get(v.lang) || 0 : 0.5;
      let score = 0.5 * term + 0.3 * channel + 0.1 * dur + 0.1 * lang;
      if (likedCh.has(key)) score += 0.15;
      hits.sort((a, b) => b[1] - a[1]);
      return { video: v, score, matched: term > 0 || channel > 0, reasons: { channel: ch ? { name: ch.name, count: ch.count } : null, terms: hits.slice(0, 3).map((h) => show(h[0])), liked: likedCh.has(key) } };
    });
    scored.sort((a, b) => b.score - a.score);
    const out = [];
    const per = new Map();
    for (const s of scored) {
      if (s.score <= 0.02) break;
      if (!s.matched) continue; // совпадений ни по темам, ни по автору — подбирать нечем
      const k = chKey(s.video);
      if ((per.get(k) || 0) >= perChannel) continue;
      per.set(k, (per.get(k) || 0) + 1);
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  const entities = (s) => s.replace(/\\u0026/g, '&').replace(/\\u003d/g, '=').replace(/\\u003c/g, '<').replace(/\\u003e/g, '>');

  function jsonString(raw) {
    if (!raw) return '';
    try {
      return JSON.parse('"' + raw + '"');
    } catch {
      return entities(raw.replace(/\\n/g, '\n').replace(/\\"/g, '"'));
    }
  }

  /** Описание, ключевые слова и категория ролика из HTML страницы ролика (ytInitialPlayerResponse). */
  function parseWatchMeta(html, id) {
    const s = String(html || '');
    if (id && !s.includes('"videoId":"' + id + '"')) return null;
    const pick = (re) => {
      const m = s.match(re);
      return m ? m[1] : '';
    };
    const desc = jsonString(pick(/"shortDescription":"((?:[^"\\]|\\.)*)"/));
    let keywords = [];
    const kw = s.match(/"keywords":\[((?:"(?:[^"\\]|\\.)*"(?:,)?)*)\]/);
    if (kw) {
      try {
        keywords = JSON.parse('[' + kw[1] + ']').slice(0, 25);
      } catch {
        keywords = [];
      }
    }
    return { desc, keywords, category: jsonString(pick(/"category":"((?:[^"\\]|\\.)*)"/)), lengthSec: Number(pick(/"lengthSeconds":"(\d+)"/)) || 0 };
  }

  /**
   * Мини-описание из описания ролика: без ссылок, таймкодов, хештегов и призывов; два предложения, не длиннее max.
   * Нет описания — ключевые слова.
   */
  function miniDescription(meta, max = 190) {
    if (!meta) return '';
    const lines = String(meta.desc || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/https?:\/\/|^\s*[\d:]{3,8}\s|^#|@\w+\s*$|^[-=_*•·▬]{3,}/u.test(l) && !/подпис|subscribe|patreon|boosty|instagram|telegram|promo|промокод|реклам/i.test(l));
    let text = lines.join(' ').replace(/\s+/g, ' ');
    const sentences = text.match(/[^.!?…]+[.!?…]+(\s|$)|[^.!?…]+$/gu) || [];
    text = '';
    for (const sen of sentences) {
      if ((text + sen).trim().length > max) break;
      text = (text + sen).trim() + ' ';
      if (text.length > max * 0.55) break;
    }
    text = text.trim();
    if (!text && lines.length) text = lines[0].slice(0, max).trim();
    if (!text && meta.keywords && meta.keywords.length) text = meta.keywords.slice(0, 6).join(', ');
    return text.length > max ? text.slice(0, max - 1).trim() + '…' : text;
  }

  /** Ответ AI: [{ id, why }] → только известные id, без повторов, не больше n; недостающее добирается из исходного порядка. */
  function normalizePicks(raw, ids, n) {
    const known = new Set(ids);
    const out = [];
    const seen = new Set();
    for (const p of Array.isArray(raw && raw.picks) ? raw.picks : []) {
      const id = String((p && p.id) || '');
      if (!known.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, why: String((p && p.why) || '').trim().slice(0, 220) });
      if (out.length >= n) return out;
    }
    for (const id of ids) {
      if (out.length >= n) break;
      if (!seen.has(id)) out.push({ id, why: '' });
    }
    return out;
  }

  const api = { STOP, stem, show, tokens, hashtags, termsOf, chKey, buildProfile, summarize, rank, parseWatchMeta, miniDescription, normalizePicks };
  root.YFS = root.YFS || {};
  root.YFS.taste = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
