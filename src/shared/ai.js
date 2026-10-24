/*
 * Gemini API (ключ Google AI Studio): AI-сводка видео, план СДВГ-режима, ремонт парсера.
 * Чистая логика: собрать запрос, разобрать ответ, балансировка по моделям, текст сводки.
 * Сеть — через переданный fetch, поэтому модуль работает в просмотрщике, на странице настроек и в Node-тестах.
 *
 * Ключ хранится только в этом браузере и уходит только на generativelanguage.googleapis.com.
 */
(function (root) {
  'use strict';

  const API = 'https://generativelanguage.googleapis.com/v1beta';
  const DEFAULT_MODEL = 'gemini-2.5-flash';
  const MAX_TRANSCRIPT_CHARS = 300000; // ~75 тыс. токенов — с запасом для длинных роликов

  // ---------- системные промты: пресеты ----------
  //
  // Тексты промтов лежат в словарях переводов (src/locales/*, ключи prompt.*), поэтому встроенные
  // пресеты сами меняются вместе с языком интерфейса. Промт собирается из общих частей (что на входе,
  // формат ответа, правила, самопроверка) и задачи пресета с требованиями к каждому полю.
  // Схема ответа у всех пресетов одна (SCHEMA). {language} заменяется названием языка сводки.

  const PRESET_IDS = ['standard', 'brief', 'detailed', 'study', 'facts', 'clickbait'];
  const PROMPT_FIELDS = ['tags', 'summary', 'keyPoints', 'chronology', 'audience'];
  const PROMPT_RULES = ['facts', 'asr', 'filler', 'concrete', 'opinions', 'title', 'time', 'plain', 'lyrics', 'noTranscript', 'check'];

  /** Откуда брать тексты: функция (key → строка), словарь или текущий язык интерфейса (YFS.i18n). */
  function translator(t) {
    if (typeof t === 'function') return t;
    if (t && typeof t === 'object') return (k) => (t[k] !== undefined ? t[k] : k);
    const i18n = root.YFS && root.YFS.i18n;
    return i18n ? (k) => i18n.t(k) : (k) => k;
  }

  /** Встроенный промт пресета на языке словаря. */
  function builtinPrompt(id, t) {
    const tr = translator(t);
    const p = PRESET_IDS.includes(id) ? id : 'standard';
    return [
      tr('prompt.intro'),
      tr(`prompt.${p}.task`),
      tr('prompt.output'),
      [tr('prompt.fields'), ...PROMPT_FIELDS.map((f) => `- "${f}": ${tr(`prompt.${p}.${f}`)}`)].join('\n'),
      [tr('prompt.rules'), ...PROMPT_RULES.map((r) => '- ' + tr('prompt.rule.' + r))].join('\n'),
    ].join('\n\n');
  }

  /**
   * Все пресеты с учётом настроек (yfs_ai):
   *   встроенные — текст на языке интерфейса; правка хранится отдельно для каждого языка
   *   (overridesByLang[lang][id]; старое overrides[id] действует для всех языков);
   *   свои — presets: [{ id, name, text }]; старый единственный «свой промт» (prompt) — пресет «custom».
   * Ответ: [{ id, builtin, name, text, edited }], name у встроенных пустое — подпись берётся из перевода.
   */
  function presetList(settings, lang, t) {
    const s = settings || {};
    const byLang = (s.overridesByLang && typeof s.overridesByLang === 'object' && s.overridesByLang[lang]) || {};
    const legacy = s.overrides && typeof s.overrides === 'object' ? s.overrides : {};
    const out = PRESET_IDS.map((id) => {
      const raw = typeof byLang[id] === 'string' ? byLang[id] : typeof legacy[id] === 'string' ? legacy[id] : '';
      const own = raw.trim() ? raw : '';
      return { id, builtin: true, name: '', text: own || builtinPrompt(id, t), edited: !!own };
    });
    const customs = Array.isArray(s.presets) ? s.presets.filter((p) => p && p.id && typeof p.text === 'string') : [];
    if (s.prompt && !customs.some((p) => p.id === 'custom')) out.push({ id: 'custom', builtin: false, name: '', text: s.prompt, edited: false });
    for (const p of customs) out.push({ id: String(p.id), builtin: false, name: String(p.name || ''), text: p.text, edited: false });
    return out;
  }

  /** Текст пресета; неизвестный id — стандартный. */
  function presetText(settings, id, lang, t) {
    const list = presetList(settings, lang, t);
    return (list.find((p) => p.id === id) || list[0]).text;
  }

  /**
   * Изменения настроек для правки встроенного пресета на языке lang.
   * Пустой текст или совпадающий со встроенным — сброс правки. Возвращает { overridesByLang, overrides }.
   */
  function overridePatch(settings, id, lang, text, t) {
    const s = settings || {};
    const byLang = { ...(s.overridesByLang || {}) };
    const cur = { ...(byLang[lang] || {}) };
    const v = String(text || '').trim();
    if (!v || v === builtinPrompt(id, t).trim()) delete cur[id];
    else cur[id] = v;
    byLang[lang] = cur;
    const overrides = { ...(s.overrides || {}) };
    delete overrides[id]; // старая правка «для всех языков» заменяется правкой этого языка
    return { overridesByLang: byLang, overrides };
  }

  /** Название языка сводки для промта: «Русский (Russian)». */
  function languageName(info) {
    if (!info) return 'English';
    return info.english && info.name && info.english !== info.name ? `${info.name} (${info.english})` : info.english || info.name || 'English';
  }

  /** Совместимость: promptFor(preset, custom) — встроенный пресет на текущем языке или свой текст. */
  function promptFor(preset, custom) {
    if (preset === 'custom' && custom) return custom;
    return builtinPrompt(preset);
  }

  /** Короткий отпечаток текста промта: сводка из кэша годится, только если промт с тех пор не меняли. */
  function hashText(text) {
    let h = 5381;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  const SCHEMA = {
    type: 'OBJECT',
    properties: {
      tags: { type: 'ARRAY', items: { type: 'STRING' } },
      summary: { type: 'STRING' },
      keyPoints: { type: 'ARRAY', items: { type: 'STRING' } },
      chronology: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { time: { type: 'STRING' }, title: { type: 'STRING' }, details: { type: 'STRING' } },
          required: ['time', 'title'],
          propertyOrdering: ['time', 'title', 'details'],
        },
      },
      audience: { type: 'STRING' },
    },
    required: ['tags', 'summary', 'keyPoints', 'chronology'],
    propertyOrdering: ['tags', 'summary', 'keyPoints', 'chronology', 'audience'],
  };

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  /**
   * Строки транскрипта для модели. Короткие соседние фразы склеиваются в строку на ~10 секунд
   * (метка времени — по началу строки): токенов меньше, модель отвечает быстрее, а тайм-коды остаются точными.
   * Слишком длинный текст обрезается с пометкой.
   */
  function transcriptText(segments) {
    const lines = [];
    let cur = null;
    for (const s of segments || []) {
      const t = String(s.text || '').trim();
      if (!t) continue;
      if (cur && s.start - cur.start < 10 && cur.text.length + t.length < 280) cur.text += ' ' + t;
      else lines.push((cur = { start: s.start, text: t }));
    }
    let out = '';
    for (const l of lines) {
      const line = `[${formatTime(l.start)}] ${l.text}\n`;
      if (out.length + line.length > MAX_TRANSCRIPT_CHARS) {
        out += '[… transcript truncated …]\n';
        break;
      }
      out += line;
    }
    return out;
  }

  /**
   * Скорость: «размышления» модели (thinking) для сводки не нужны и замедляют ответ в разы.
   * 2.5 Flash — выключаем, 2.5 Pro — минимум (выключить нельзя), 3.x — низкий уровень.
   */
  function thinkingConfig(model) {
    const m = String(model || '');
    if (/gemini-3/.test(m)) return { thinkingLevel: 'low' };
    if (/gemini-2\.5-pro/.test(m)) return { thinkingBudget: 128 };
    if (/gemini-2\.5-flash/.test(m)) return { thinkingBudget: 0 };
    return null;
  }

  /**
   * Тело запроса generateContent.
   * video: { id, title, channel, duration, short }; segments — транскрипт или пусто
   * (тогда модель смотрит сам ролик по ссылке YouTube — Gemini это умеет для публичных видео).
   */
  function buildRequest({ video, segments, language, prompt, model, thinking = true }) {
    const system = String(prompt || builtinPrompt('standard')).replace(/\{language\}/g, language || 'English');
    const url = `https://www.youtube.com/watch?v=${video.id}`;
    const meta = [
      video.title ? `Title: ${video.title}` : '',
      video.channel ? `Channel: ${video.channel}` : '',
      video.duration ? `Duration: ${video.duration}` : '',
      `URL: ${url}`,
    ]
      .filter(Boolean)
      .join('\n');
    const parts = segments && segments.length
      ? [{ text: `${meta}\n\nTranscript:\n${transcriptText(segments)}` }]
      : [{ fileData: { fileUri: url } }, { text: `${meta}\n\nNo transcript is available — summarize the video itself.` }];
    return {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        temperature: 0.3,
        ...(thinking && thinkingConfig(model) ? { thinkingConfig: thinkingConfig(model) } : {}),
      },
    };
  }

  /** Ошибка API → код для понятного сообщения в интерфейсе. */
  function errorCode(status, body) {
    const msg = JSON.stringify(body || {});
    if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(msg)) return 'ai-key-invalid';
    if (status === 400 && /thinking/i.test(msg)) return 'ai-thinking';
    if (status === 401 || status === 403) return 'ai-key-denied';
    if (status === 404) return 'ai-model-missing';
    if (status === 429) return 'ai-quota';
    if (status >= 500) return 'ai-server';
    return 'ai-failed';
  }

  /** Привести ответ модели к ожидаемой форме (лишнее отбрасываем, недостающее — пустое). */
  function normalizeResult(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const strs = (a, max) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, max) : []);
    return {
      tags: strs(r.tags, 15).map((t) => t.replace(/^#/, '')),
      summary: typeof r.summary === 'string' ? r.summary.trim() : '',
      keyPoints: strs(r.keyPoints, 12),
      chronology: (Array.isArray(r.chronology) ? r.chronology : [])
        .filter((c) => c && typeof c.title === 'string')
        .slice(0, 40)
        .map((c) => ({ time: String(c.time || '').trim(), title: c.title.trim(), details: typeof c.details === 'string' ? c.details.trim() : '' })),
      audience: typeof r.audience === 'string' ? r.audience.trim() : '',
    };
  }

  // ---------- общий вызов Gemini: JSON по схеме ----------

  /**
   * Один запрос generateContent → разобранный JSON ответа.
   * makeBody(thinking) строит тело запроса; если модель не принимает настройку thinking — повтор без неё.
   * Таймаут и отмена: зависший запрос не держит интерфейс, а балансировщик переходит к другой модели.
   */
  async function callGemini({ key, model, makeBody, fetchImpl, signal, timeoutMs = 90000, thinking = true }) {
    const doFetch = fetchImpl || ((...a) => fetch(...a));
    if (!key) throw Object.assign(new Error('no key'), { code: 'ai-no-key' });
    const m = model || DEFAULT_MODEL;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const onAbort = () => ctrl && ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
    let res;
    let body = null;
    try {
      res = await doFetch(`${API}/models/${encodeURIComponent(m)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(makeBody(thinking)),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    } catch (err) {
      if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'ai-cancelled' });
      throw Object.assign(new Error(err.name === 'AbortError' ? 'timeout' : err.message), { code: err.name === 'AbortError' ? 'ai-timeout' : 'ai-network' });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    // Ответ пришёл, но пользователь уже нажал «Отмена» — не показываем и не сохраняем.
    if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'ai-cancelled' });
    if (!res.ok) {
      const code = errorCode(res.status, body);
      if (code === 'ai-thinking' && thinking) return callGemini({ key, model: m, makeBody, fetchImpl, signal, timeoutMs, thinking: false });
      throw Object.assign(new Error((body && body.error && body.error.message) || 'HTTP ' + res.status), { code });
    }
    const cand = body && body.candidates && body.candidates[0];
    if (!cand) {
      const blocked = body && body.promptFeedback && body.promptFeedback.blockReason;
      throw Object.assign(new Error(blocked || 'empty'), { code: blocked ? 'ai-blocked' : 'ai-failed' });
    }
    if (/SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(cand.finishReason || '')) {
      throw Object.assign(new Error(cand.finishReason), { code: 'ai-blocked' });
    }
    const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || '').join('');
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('bad json'), { code: 'ai-failed' });
    }
  }

  function generationConfig(schema, temperature, model, thinking) {
    return {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature,
      ...(thinking && thinkingConfig(model) ? { thinkingConfig: thinkingConfig(model) } : {}),
    };
  }

  /**
   * Запрос сводки. Возвращает { result, model, usedTranscript } или бросает Error с .code.
   */
  async function summarize(args) {
    const m = args.model || DEFAULT_MODEL;
    const parsed = await callGemini({
      ...args,
      model: m,
      thinking: args.thinking !== false,
      makeBody: (thinking) => buildRequest({ ...args, model: m, thinking }),
    });
    return { result: normalizeResult(parsed), model: m, usedTranscript: !!(args.segments && args.segments.length) };
  }

  /** Любой запрос «системный промт + части + схема» → { data, model }. */
  async function generateJSON({ key, model, system, parts, schema, temperature = 0.2, fetchImpl, signal, timeoutMs }) {
    const m = model || DEFAULT_MODEL;
    const data = await callGemini({
      key,
      model: m,
      fetchImpl,
      signal,
      timeoutMs,
      makeBody: (thinking) => ({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: generationConfig(schema, temperature, m, thinking),
      }),
    });
    return { data, model: m };
  }

  /** Модели, которые умеют generateContent; заодно проверяет ключ. */
  async function listModels(key, fetchImpl) {
    const doFetch = fetchImpl || ((...a) => fetch(...a));
    const res = await doFetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) throw Object.assign(new Error((body && body.error && body.error.message) || 'HTTP ' + res.status), { code: errorCode(res.status, body) });
    return ((body && body.models) || [])
      .filter((x) => (x.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(x.name))
      .map((x) => ({ id: String(x.name).replace(/^models\//, ''), title: x.displayName || x.name }));
  }

  /** Из списка моделей — самая свежая «flash» (быстрая и дешёвая), иначе первая. */
  function pickModel(models) {
    const ver = (id) => Number((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const flash = models.filter((m) => /flash/.test(m.id) && !/lite|image|tts|audio|live|thinking-exp|embedding/.test(m.id));
    const pool = flash.length ? flash : models;
    return pool.slice().sort((a, b) => ver(b.id) - ver(a.id) || (/preview|exp/.test(a.id) ? 1 : 0) - (/preview|exp/.test(b.id) ? 1 : 0))[0]?.id || DEFAULT_MODEL;
  }

  // ---------- балансировщик моделей ----------

  /** Модели для текста: без картинок, озвучки, live, эмбеддингов и т. п. */
  const NOT_TEXT = /image|tts|audio|live|embedding|thinking-exp|robotics|computer-use|native|veo|imagen|aqa|learnlm|gemma/;
  const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];

  /**
   * Порядок моделей для сводки: быстрые flash (новые выше, стабильные выше preview),
   * затем flash-lite, затем pro (медленнее, и квота меньше).
   */
  function rankModels(models) {
    const ver = (id) => Number((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const tier = (id) => (/flash-lite/.test(id) ? 1 : /flash/.test(id) ? 0 : /pro/.test(id) ? 2 : 3);
    const preview = (id) => (/preview|exp/.test(id) ? 1 : 0);
    return (models || [])
      .map((m) => (typeof m === 'string' ? { id: m, title: m } : m))
      .filter((m) => m && /gemini/.test(m.id) && !NOT_TEXT.test(m.id))
      .sort((a, b) => tier(a.id) - tier(b.id) || ver(b.id) - ver(a.id) || preview(a.id) - preview(b.id) || a.id.localeCompare(b.id));
  }

  /** Модели, недавно ответившие «перегружена» или «лимит»: их пробуем в последнюю очередь. */
  const cooldown = new Map(); // id → до какого времени
  const RETRIABLE = new Set(['ai-server', 'ai-quota', 'ai-model-missing', 'ai-timeout', 'ai-network', 'ai-failed']);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function candidates(models, preferred, now = Date.now()) {
    const ranked = rankModels(models && models.length ? models : FALLBACK_MODELS).map((m) => m.id);
    const list = [...new Set([preferred, ...ranked].filter(Boolean))];
    const ready = list.filter((id) => !(cooldown.get(id) > now));
    const cooling = list.filter((id) => cooldown.get(id) > now);
    // Выбранную вручную модель пробуем первой, даже если она «остывает» — пользователь её выбрал.
    if (preferred && cooling.includes(preferred)) return [preferred, ...ready, ...cooling.filter((id) => id !== preferred)];
    return [...ready, ...cooling];
  }

  /**
   * Балансировка по моделям: модель перегружена (503), упёрлась в лимит (429), пропала (404) или не ответила
   * вовремя — повтор через ~1 с (только для 503) и переход к следующей модели. До maxModels моделей.
   * onProgress({ model, attempt, tried }) — что сейчас пробуем (для подписи в интерфейсе).
   * run(model) делает сам запрос. Ответ: результат run + tried: [{ model, code }].
   */
  async function balance(args, run) {
    const { model, models, onProgress, maxModels = 4, signal } = args;
    const list = candidates(models, model).slice(0, maxModels);
    const tried = [];
    let lastErr = null;
    for (const m of list) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'ai-cancelled' });
        if (onProgress) onProgress({ model: m, attempt, tried: tried.slice() });
        try {
          const out = await run(m);
          cooldown.delete(m);
          return { ...out, tried };
        } catch (err) {
          lastErr = err;
          if (!RETRIABLE.has(err.code)) throw Object.assign(err, { tried });
          if (err.code === 'ai-server' && attempt === 0) {
            await sleep(1200);
            continue;
          }
          break;
        }
      }
      cooldown.set(m, Date.now() + (lastErr.code === 'ai-quota' ? 10 : 2) * 60000);
      tried.push({ model: m, code: lastErr.code });
    }
    throw Object.assign(lastErr || new Error('no models'), { code: (lastErr && lastErr.code) || 'ai-failed', tried });
  }

  /** Сводка с балансировкой. Ответ: { result, model, usedTranscript, tried }. */
  function summarizeSmart(args) {
    return balance(args, (m) => summarize({ ...args, model: m }));
  }

  /** generateJSON с балансировкой. Ответ: { data, model, tried }. */
  function generateSmart(args) {
    return balance(args, (m) => generateJSON({ ...args, model: m }));
  }

  // ---------- ⚡ СДВГ-режим: план просмотра «что смотреть, что ускорить, что пропустить» ----------

  const FOCUS_ACTIONS = ['keep', 'fast', 'skip'];
  const FOCUS_STYLES = {
    ads: 'ads only: skip ONLY paid promotions, sponsor reads, self-promotion, “like and subscribe” and long intros/outros; everything else is keep.',
    gentle: 'gentle: skip only obvious filler (long intros, sponsor ads, outros, “subscribe” talk); everything else is keep or fast.',
    normal: 'balanced: keep the parts that carry the meaning, speed up slow or secondary parts, skip filler.',
    hard: 'aggressive: keep only the most valuable 25–40% of the video; everything else is fast or skip.',
    highlights: 'highlights only: keep just the best 10–20% — the strongest moments, answers and punchlines; skip the rest, but never skip the main answer or the ending the title promises.',
  };
  const FOCUS_STYLE_IDS = Object.keys(FOCUS_STYLES);

  // Тип ролика: у игрового, лекции, подкаста и т. д. «вода» разная — у каждого свои правила.
  const FOCUS_KINDS = {
    gaming: 'gaming / let’s play: keep action, fights, boss battles, clutch moments, funny reactions and story cutscenes; fast: walking, travel, looting, grinding, inventory and menus; skip: loading screens, “starting soon”, long intros, sponsor reads, idle waiting, deaths replayed again.',
    lecture: 'lecture / tutorial / explainer: keep explanations, definitions, examples, demos, code and the conclusion; fast: repetition and slow derivations of what was already explained; skip: greetings, housekeeping, course promotion, sponsor reads.',
    podcast: 'podcast / interview / talk show: keep substantive answers, stories and strong opinions; fast: small talk, tangents and long questions; skip: ads, intros, outros, guest bios read aloud.',
    review: 'review / tech / product video: keep the verdict, key pros and cons, test results, prices and comparisons; fast: unboxing, b-roll and specs read aloud; skip: sponsor reads and channel promotion.',
    news: 'news / analysis: keep the facts, numbers and new developments; fast: commentary and background most viewers know; skip: repeated recaps, teasers of other segments, ads.',
    vlog: 'vlog / travel / lifestyle: keep events, decisions and reveals; fast: travel shots, b-roll and routine; skip: intros, ads, “what’s up guys”.',
    stream: 'stream recording (VOD): keep highlights, reactions, announcements and the main event; fast: chatting with chat and slow stretches; skip: “starting soon” screens, BRB breaks, technical problems and long silences.',
    other: 'any other video: apply the general rules.',
  };
  const FOCUS_KIND_IDS = Object.keys(FOCUS_KINDS);

  const FOCUS_SCHEMA = {
    type: 'OBJECT',
    properties: {
      kind: { type: 'STRING', enum: FOCUS_KIND_IDS },
      overview: { type: 'STRING' },
      segments: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            start: { type: 'STRING' },
            end: { type: 'STRING' },
            action: { type: 'STRING', enum: FOCUS_ACTIONS },
            interest: { type: 'INTEGER' },
            title: { type: 'STRING' },
            summary: { type: 'STRING' },
          },
          required: ['start', 'end', 'action', 'title'],
          propertyOrdering: ['start', 'end', 'action', 'interest', 'title', 'summary'],
        },
      },
    },
    required: ['segments'],
    propertyOrdering: ['kind', 'overview', 'segments'],
  };

  /** Системный промт плана просмотра. style — gentle | normal | hard. */
  function focusPrompt(style, language, kind) {
    const forced = FOCUS_KINDS[kind] && kind !== 'other' ? kind : '';
    const kindRules = forced
      ? [`Video kind: ${forced} (chosen by the viewer). Rules for it — ${FOCUS_KINDS[forced]}`, `Return "kind": "${forced}".`]
      : ['First decide what kind of video it is and return it in "kind". Then use the rules for that kind:', ...FOCUS_KIND_IDS.map((k) => `- ${k}: ${FOCUS_KINDS[k]}`)];
    return [
      'You are a video editor who makes long videos watchable for people with ADHD or little time. You get a YouTube video’s metadata and its transcript; every line starts with a timestamp like [m:ss].',
      'Split the WHOLE video into consecutive segments without gaps or overlaps, from the first transcript line to the end of the video. For each segment:',
      '- "start", "end": timestamps copied from the beginnings of transcript lines (m:ss or h:mm:ss); "end" equals the next segment’s "start"; the last segment ends at the video duration.',
      '- "interest" 1–5: how much this part matters for understanding the video. 5 — key moments, answers, conclusions, demos, punchlines; 1 — filler: intros, sponsor ads, “like and subscribe”, repetition, off-topic chatter.',
      '- "action": "keep" (watch at normal speed), "fast" (worth hearing, but can be played faster), "skip" (nothing is lost).',
      '- "title": 2–5 words.',
      '- "summary": for "skip" and "fast" — what happens there in at most 12 words, so the viewer loses nothing by skipping; for "keep" — one short sentence.',
      '- "overview": one sentence about the whole video.',
      `Style: ${FOCUS_STYLES[style] || FOCUS_STYLES.normal}`,
      ...kindRules,
      'Segments are 15 seconds to 5 minutes long; merge neighbours with the same action. Never skip the main answer, the conclusion or the moment the title promises.',
      `Write "title", "summary" and "overview" in ${language || 'English'}. Plain text, no Markdown. Use only what is in the transcript; never invent timestamps.`,
    ].join('\n');
  }

  function buildFocusParts(video, segments) {
    const url = `https://www.youtube.com/watch?v=${video.id}`;
    const meta = [video.title && `Title: ${video.title}`, video.channel && `Channel: ${video.channel}`, video.duration && `Duration: ${video.duration}`, `URL: ${url}`]
      .filter(Boolean)
      .join('\n');
    return segments && segments.length
      ? [{ text: `${meta}\n\nTranscript:\n${transcriptText(segments)}` }]
      : [{ fileData: { fileUri: url } }, { text: `${meta}\n\nNo transcript is available — plan from the video itself.` }];
  }

  function timeToSec(ts) {
    const s = String(ts || '').trim();
    if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return NaN;
    return s.split(':').reduce((a, p) => a * 60 + Number(p), 0);
  }

  /**
   * Привести план модели в порядок: секунды, сортировка, без дыр и наложений, в пределах длительности.
   * Если модель «пропустила» почти всё — смягчаем: лишние skip становятся fast.
   * Ответ: { overview, segments: [{ start, end, action, interest, title, summary }] } (start/end — секунды).
   */
  function normalizeFocus(raw, durationSec, style) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const dur = Number(durationSec) > 0 ? Number(durationSec) : Infinity;
    let segs = (Array.isArray(r.segments) ? r.segments : [])
      .map((s) => ({
        start: timeToSec(s && s.start),
        end: timeToSec(s && s.end),
        action: FOCUS_ACTIONS.includes(s && s.action) ? s.action : 'keep',
        interest: Math.min(5, Math.max(1, Math.round(Number(s && s.interest) || 3))),
        title: String((s && s.title) || '').trim(),
        summary: String((s && s.summary) || '').trim(),
      }))
      .filter((s) => Number.isFinite(s.start) && s.start < dur)
      .sort((a, b) => a.start - b.start);
    // Конец сегмента — начало следующего: так нет ни дыр, ни наложений.
    for (let i = 0; i < segs.length; i++) {
      const next = segs[i + 1];
      segs[i].end = next ? next.start : Number.isFinite(segs[i].end) && segs[i].end > segs[i].start ? Math.min(segs[i].end, dur) : dur;
    }
    segs = segs.filter((s) => s.end > s.start);
    if (segs.length && segs[0].start > 0) segs[0].start = 0;
    const total = segs.reduce((a, s) => a + (s.end - s.start), 0) || 1;
    const skipped = segs.filter((s) => s.action === 'skip').reduce((a, s) => a + (s.end - s.start), 0);
    // «Только лучшее» может пропускать до 90%, остальные стили — до 80% (иначе модель «пропустила всё»).
    const limit = style === 'highlights' ? 0.9 : 0.8;
    if (skipped / total > limit) {
      // Самые «интересные» из пропущенных — ускоряем, пока пропуск не станет разумным.
      for (const s of segs.filter((x) => x.action === 'skip').sort((a, b) => b.interest - a.interest)) {
        if (segs.filter((x) => x.action === 'skip').reduce((a, x) => a + (x.end - x.start), 0) / total <= limit - 0.2) break;
        s.action = 'fast';
      }
    }
    return { kind: FOCUS_KIND_IDS.includes(r.kind) ? r.kind : 'other', overview: typeof r.overview === 'string' ? r.overview.trim() : '', segments: segs };
  }

  /** План просмотра с балансировкой. Ответ: { plan, model, tried, usedTranscript }. */
  async function focusPlan(args) {
    const out = await generateSmart({
      ...args,
      system: focusPrompt(args.style, args.language, args.kind),
      parts: buildFocusParts(args.video, args.segments),
      schema: FOCUS_SCHEMA,
      temperature: 0.2,
    });
    const plan = normalizeFocus(out.data, args.durationSec, args.style);
    if (FOCUS_KIND_IDS.includes(args.kind)) plan.kind = args.kind; // тип выбрал человек — он и показывается
    return { plan, model: out.model, tried: out.tried, usedTranscript: !!(args.segments && args.segments.length) };
  }

  /** Сколько времени экономит план при скорости fast: { watch, total, saved } в секундах. */
  function focusSavings(plan, fastRate = 1.75) {
    let watch = 0;
    let total = 0;
    for (const s of (plan && plan.segments) || []) {
      const d = s.end - s.start;
      total += d;
      if (s.action === 'keep') watch += d;
      else if (s.action === 'fast') watch += d / (fastRate || 1);
    }
    return { watch, total, saved: Math.max(0, total - watch) };
  }

  // ---------- ⭐ подборка по вкусу: один короткий запрос ----------

  const TASTE_SCHEMA = {
    type: 'OBJECT',
    properties: { picks: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, why: { type: 'STRING' } }, required: ['id', 'why'] } } },
    required: ['picks'],
  };

  const TASTE_PROMPT = [
    'You help a viewer choose what to watch next on YouTube.',
    'You get a short summary of their taste (topics and channels from their watch history) and a numbered list of candidate videos from their feed (id, title, channel, length, short description).',
    'Pick the videos they are most likely to enjoy, best first. For each pick write "why": one plain sentence (at most 25 words) saying what the video is about and why it fits this viewer. Use only the given information; do not invent facts.',
    'Prefer variety over several near-duplicates. Return ids exactly as given, each at most once. No Markdown.',
  ].join('\n');

  /**
   * args: { profile: { videos, terms, channels: [{name,count}], medianMin }, candidates: [{id,title,channel,minutes,desc}], count, language }.
   * Ответ: { picks: [{ id, why }], model, tried } — id только из candidates, ровно count (дополняется исходным порядком).
   */
  async function tastePicks(args) {
    const cands = (args.candidates || []).slice(0, 24);
    const p = args.profile || {};
    const lines = cands.map((c, i) => `${i + 1}. [${c.id}] ${String(c.title || '').slice(0, 110)} — ${String(c.channel || '').slice(0, 40)}${c.minutes ? ` (${c.minutes} min)` : ''}${c.desc ? ` :: ${String(c.desc).slice(0, 140)}` : ''}`);
    const text = [
      `Taste (from ${p.videos || 0} watched videos): topics — ${(p.terms || []).join(', ')}; favourite channels — ${(p.channels || []).map((c) => `${c.name} (${c.count})`).join(', ')}; typical length — ${p.medianMin || '?'} min.`,
      `Pick ${args.count || 3} videos. Write "why" in ${args.language || 'English'}.`,
      '',
      'Candidates:',
      ...lines,
    ].join('\n');
    const out = await generateSmart({ ...args, system: TASTE_PROMPT, parts: [{ text }], schema: TASTE_SCHEMA, temperature: 0.3 });
    const T = root.YFS && root.YFS.taste;
    const ids = cands.map((c) => c.id);
    const picks = T ? T.normalizePicks(out.data, ids, args.count || 3) : [];
    return { picks, model: out.model, tried: out.tried };
  }

  // ---------- 🔀 порядок треков в очереди ----------

  const ORDER_SCHEMA = {
    type: 'OBJECT',
    properties: { order: { type: 'ARRAY', items: { type: 'INTEGER' } } },
    required: ['order'],
  };

  const ORDER_PROMPT = [
    'You arrange a listening queue of music tracks into a pleasant order.',
    'Input: a numbered list of tracks (number, title, channel). Output: the numbers in the order they should be played, each number exactly once.',
    'Rules: open with a strong, catchy or well-known track; avoid two tracks by the same artist in a row; alternate energy and mood (calm after intense, then build up again); keep a loose feeling of flow — similar genre and language together, but not in long blocks; put long mixes and sets last.',
    'Do not explain anything: return only the JSON.',
  ].join('\n');

  /**
   * Ответ модели → порядок индексов без дыр и повторов: лишние и чужие номера выбрасываются,
   * пропущенные дописываются в исходном порядке. Всегда перестановка 0..n-1.
   */
  function normalizeOrder(order, n) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(order) ? order : []) {
      const i = Number(raw);
      if (Number.isInteger(i) && i >= 0 && i < n && !seen.has(i)) {
        seen.add(i);
        out.push(i);
      }
    }
    for (let i = 0; i < n; i++) if (!seen.has(i)) out.push(i);
    return out;
  }

  /** tracks: [{ id, title, channel }] → { ids: [...в новом порядке], model }. До 200 треков за запрос. */
  async function orderTracks(args) {
    const tracks = (args.tracks || []).slice(0, 200);
    const text = tracks.map((t, i) => `${i}. ${String(t.title || '').slice(0, 110)} — ${String(t.channel || '').slice(0, 50)}`).join('\n');
    const out = await generateSmart({ ...args, system: ORDER_PROMPT, parts: [{ text }], schema: ORDER_SCHEMA, temperature: 0.7 });
    const order = normalizeOrder(out.data && out.data.order, tracks.length);
    return { ids: order.map((i) => tracks[i].id), model: out.model, tried: out.tried };
  }

  // ---------- 🧠 ремонт парсера: «рецепт» разбора нового формата карточек ----------

  const RECIPE_SCHEMA = {
    type: 'OBJECT',
    properties: {
      renderer: { type: 'STRING' },
      fields: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          title: { type: 'STRING' },
          channel: { type: 'STRING' },
          duration: { type: 'STRING' },
          views: { type: 'STRING' },
          published: { type: 'STRING' },
          short: { type: 'STRING' },
        },
        required: ['id', 'title'],
      },
      notes: { type: 'STRING' },
    },
    required: ['renderer', 'fields'],
  };

  const REPAIR_PROMPT = [
    'You repair a parser of YouTube’s internal JSON (InnerTube). YouTube changed the format of video cards and the parser stopped finding them.',
    'You get the key name and a trimmed JSON skeleton of several video cards (long strings are cut, arrays are shortened), plus the video ids known to be inside them.',
    'Return a recipe: "renderer" — the JSON key whose value is one video card (the same key for all cards); "fields" — paths inside that value to each field.',
    'Path syntax: dot-separated keys relative to the card value; array index in brackets, e.g. metadata.rows[0].parts[1].text; [*] means “the first array element for which the rest of the path is non-empty”, e.g. badges[*].text.',
    'A path may end at a string, a number, or a text object ({content}, {simpleText} or {runs}) — the parser reads all of them.',
    '"id" must lead to the 11-character video id. "title", "channel", "duration" (like 12:34 or seconds), "views", "published" (like “3 days ago”) — empty string if absent.',
    '"short" — a path that exists only for Shorts cards (e.g. a reelWatchEndpoint), or an empty string.',
    'Use only keys that really exist in the skeletons. Do not output code. "notes" — one short sentence about what changed.',
  ].join('\n');

  /** Рецепт от модели (с балансировкой). cards: [{ key, skeleton }], ids — какие id в них лежат. Ответ: { recipe, model, tried }. */
  async function repairRecipe(args) {
    const text = [
      `Feed: ${args.page || 'unknown'}.`,
      `Video ids inside the cards: ${(args.ids || []).slice(0, 20).join(', ')}.`,
      'Cards:',
      ...(args.cards || []).map((c, i) => `#${i + 1} key "${c.key}":\n${JSON.stringify(c.skeleton)}`),
    ].join('\n');
    const out = await generateSmart({ ...args, system: REPAIR_PROMPT, parts: [{ text }], schema: RECIPE_SCHEMA, temperature: 0 });
    const d = out.data || {};
    const f = (d.fields && typeof d.fields === 'object' && d.fields) || {};
    const pick = (k) => (typeof f[k] === 'string' ? f[k].trim() : '');
    const recipe = {
      renderer: String(d.renderer || '').trim(),
      fields: { id: pick('id'), title: pick('title'), channel: pick('channel'), duration: pick('duration'), views: pick('views'), published: pick('published') },
      short: pick('short'),
      notes: typeof d.notes === 'string' ? d.notes.trim() : '',
    };
    return { recipe, model: out.model, tried: out.tried };
  }

  /** Сводка → текст для копирования и .txt. labels — подписи разделов на языке интерфейса. */
  function summaryToText(result, video, labels) {
    const L = { tags: 'Tags', summary: 'Summary', keyPoints: 'Key points', chronology: 'Chronology', audience: 'Audience', ...labels };
    const out = [];
    if (video && video.title) out.push(video.title, `https://www.youtube.com/watch?v=${video.id}`, '');
    if (result.tags.length) out.push(`${L.tags}: ${result.tags.map((t) => '#' + t.replace(/\s+/g, '_')).join(' ')}`, '');
    if (result.summary) out.push(`${L.summary}:`, result.summary, '');
    if (result.keyPoints.length) out.push(`${L.keyPoints}:`, ...result.keyPoints.map((p) => `• ${p}`), '');
    if (result.chronology.length) {
      out.push(`${L.chronology}:`, ...result.chronology.map((c) => `${c.time ? `[${c.time}] ` : ''}${c.title}${c.details ? ' — ' + c.details : ''}`), '');
    }
    if (result.audience) out.push(`${L.audience}: ${result.audience}`);
    return out.join('\n').trim();
  }

  const api = {
    DEFAULT_MODEL,
    /** Стандартный пресет на текущем языке интерфейса. */
    get DEFAULT_PROMPT() {
      return builtinPrompt('standard');
    },
    /** Встроенные пресеты на текущем языке интерфейса. */
    get PRESETS() {
      return Object.fromEntries(PRESET_IDS.map((id) => [id, builtinPrompt(id)]));
    },
    PRESET_IDS,
    PROMPT_FIELDS,
    PROMPT_RULES,
    SCHEMA,
    builtinPrompt,
    presetList,
    presetText,
    overridePatch,
    languageName,
    promptFor,
    hashText,
    callGemini,
    generateJSON,
    generateSmart,
    balance,
    FOCUS_ACTIONS,
    FOCUS_STYLE_IDS,
    FOCUS_KIND_IDS,
    focusPrompt,
    normalizeFocus,
    focusPlan,
    focusSavings,
    normalizeOrder,
    orderTracks,
    tastePicks,
    timeToSec,
    RECIPE_SCHEMA,
    repairRecipe,
    buildRequest,
    transcriptText,
    thinkingConfig,
    summarize,
    summarizeSmart,
    rankModels,
    candidates,
    cooldown,
    listModels,
    pickModel,
    normalizeResult,
    summaryToText,
    errorCode,
  };
  root.YFS = root.YFS || {};
  root.YFS.ai = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
