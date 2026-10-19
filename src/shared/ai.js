/*
 * AI-сводка видео через Gemini API (ключ Google AI Studio).
 * Чистая логика: собрать запрос, разобрать ответ, превратить сводку в текст.
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
  // Промт собирается из общих блоков (что на входе, формат ответа, правила, самопроверка)
  // и задачи пресета с требованиями к каждому полю. Схема ответа у всех пресетов одна (SCHEMA),
  // поэтому любой пресет — и встроенный, и свой — показывается в панели одинаково.
  // {language} заменяется языком интерфейса — на нём пишется сводка.
  // Тексты на английском и русском: в русском интерфейсе промты русские (их удобнее править).

  const PROMPT_BASE = {
    en: {
      intro:
        'You are an expert video analyst and editor. You get one YouTube video: its title, channel, duration and transcript. Every transcript line starts with a timestamp like [m:ss] or [h:mm:ss]. The transcript is often auto-generated: no punctuation, misheard words, wrong names, markers like [music] or [applause].',
      output:
        'Answer with JSON in the given schema. Write every text value in {language}, even if the video is in another language. Keep names, brands, titles of works, code and direct quotes in their original spelling.',
      fields: 'Fields:',
      rules: 'Rules:',
      common: [
        'Facts only from the transcript and metadata. Never invent numbers, names, dates, quotes or timestamps. If something is unclear or the transcript is cut off, say so briefly instead of guessing.',
        'Fix obvious speech-recognition errors using context (a misheard name, brand or term), without changing the meaning.',
        'Skip filler: greetings, "like and subscribe", channel promos, repetitions, [music]. A sponsor or ad segment goes into the chronology as a separate item marked as an ad, and nowhere else.',
        'Be concrete: not "the author talks about prices" but what exactly about prices, with the numbers. No phrases like "In this video the author…", "The video discusses…".',
        'Neutral tone. The author\'s opinions and forecasts are presented as opinions ("the author believes…"), not as facts.',
        'If the title asks a question or promises something ("what happened to…", "why…", "the best…"), the summary must give the actual answer from the video.',
        'Chronology: every "time" is copied from the start of an existing transcript line (m:ss or h:mm:ss), never calculated or rounded. Items go in increasing time order; the first is near the start, the last is near the end of the video.',
        'If the transcript is song lyrics, describe the theme and mood of the song instead of retelling the lines.',
        'If there is no transcript and you are given the video itself, use what is said and shown in it.',
        'Before answering, check silently: every timestamp exists in the transcript, every fact is supported by it, all text is in {language}.',
      ],
    },
    ru: {
      intro:
        'Ты — опытный аналитик и редактор видео. Тебе дают один ролик YouTube: название, канал, длительность и текст (расшифровку). Каждая строка расшифровки начинается с метки времени вида [m:ss] или [h:mm:ss]. Расшифровка часто автоматическая: без знаков препинания, с ослышками, искажёнными именами и пометками вроде [музыка] или [аплодисменты].',
      output:
        'Ответь JSON по заданной схеме. Все текстовые значения пиши на языке: {language} — даже если ролик на другом языке. Имена, бренды, названия произведений, код и прямые цитаты оставляй в исходном написании.',
      fields: 'Поля:',
      rules: 'Правила:',
      common: [
        'Только факты из расшифровки и данных ролика. Никогда не выдумывай числа, имена, даты, цитаты и метки времени. Если что-то неясно или текст обрывается — коротко так и скажи, а не угадывай.',
        'Исправляй очевидные ошибки распознавания речи по контексту (ослышка в имени, бренде, термине), не меняя смысла.',
        'Пропускай «воду»: приветствия, «ставьте лайк и подписывайтесь», рекламу канала, повторы, [музыка]. Спонсорская или рекламная вставка — отдельный пункт хронологии с пометкой, что это реклама, и больше нигде.',
        'Конкретно: не «автор рассказывает о ценах», а что именно о ценах, с цифрами. Без оборотов «В этом видео автор…», «В ролике рассматривается…».',
        'Нейтральный тон. Мнения и прогнозы автора подавай как мнения («автор считает…»), а не как факты.',
        'Если в названии вопрос или обещание («что стало с…», «почему…», «лучший…») — в сводке должен быть настоящий ответ из ролика.',
        'Хронология: каждое "time" скопировано из начала существующей строки расшифровки (m:ss или h:mm:ss), не вычислено и не округлено. Пункты идут по возрастанию времени; первый — близко к началу, последний — близко к концу ролика.',
        'Если расшифровка — текст песни, опиши тему и настроение песни, а не пересказывай куплеты.',
        'Если расшифровки нет и тебе дан сам ролик — опирайся на то, что в нём говорят и показывают.',
        'Перед ответом молча проверь: каждая метка времени есть в расшифровке, каждый факт подтверждается текстом, весь текст на языке {language}.',
      ],
    },
  };

  /** Задача и требования к полям для каждого встроенного пресета. */
  const PRESET_SPECS = {
    standard: {
      en: {
        task: 'Task: a balanced summary. Someone who reads it in a minute should understand what the video is about, its main points and its conclusion.',
        tags: '5–8 tags for the core meaning: topics, key names and concepts. 1–3 words each, lowercase except proper nouns, without "#", no generic words (video, youtube, review, vlog).',
        summary: '3–5 sentences. The first sentence is the main point or the answer the video gives. Then the key arguments or the story, then the conclusion or outcome.',
        keyPoints: '4–7 most important takeaways, ordered by importance. Each is one complete sentence with a concrete fact, argument, number or piece of advice.',
        chronology: '6–12 parts covering the whole video (2–4 for a short one). "title" — 2–6 words naming the topic of the part; "details" — one sentence about what is said or happens there.',
        audience: 'one sentence: who will benefit from the video and what they will get.',
      },
      ru: {
        task: 'Задача: сбалансированная сводка. Прочитав её за минуту, человек должен понять, о чём ролик, его главные мысли и вывод.',
        tags: '5–8 тегов основного смысла: темы, ключевые имена и понятия. 1–3 слова, строчными (кроме имён собственных), без «#», без общих слов (видео, ютуб, обзор, влог).',
        summary: '3–5 предложений. Первое — главная мысль или ответ, который даёт ролик. Дальше — ключевые доводы или сюжет, затем вывод или итог.',
        keyPoints: '4–7 самых важных мыслей по убыванию важности. Каждая — одно законченное предложение с конкретным фактом, доводом, числом или советом.',
        chronology: '6–12 частей, покрывающих весь ролик (2–4 для короткого). "title" — 2–6 слов, тема части; "details" — одно предложение о том, что там говорят или происходит.',
        audience: 'одно предложение: кому ролик полезен и что он из него получит.',
      },
    },
    brief: {
      en: {
        task: 'Task: a TL;DR that can be read in 15 seconds.',
        tags: '3–5 tags for the core topics, 1–3 words each, without "#".',
        summary: '1–2 sentences: the main point or answer and the conclusion.',
        keyPoints: 'exactly 3 short takeaways, up to 12 words each.',
        chronology: '3–5 main parts. "title" — 2–4 words; "details" — an empty string.',
        audience: 'up to 8 words.',
      },
      ru: {
        task: 'Задача: TL;DR, который читается за 15 секунд.',
        tags: '3–5 тегов главных тем, 1–3 слова, без «#».',
        summary: '1–2 предложения: главная мысль или ответ и вывод.',
        keyPoints: 'ровно 3 коротких пункта, до 12 слов каждый.',
        chronology: '3–5 главных частей. "title" — 2–4 слова; "details" — пустая строка.',
        audience: 'до 8 слов.',
      },
    },
    detailed: {
      en: {
        task: 'Task: a detailed retelling that replaces watching the video — all arguments, examples, numbers and conclusions in the order the author gives them.',
        tags: '8–12 tags covering all main topics, names and concepts, without "#".',
        summary: '2–4 paragraphs (8–16 sentences) separated by a blank line: the context and the question; the main argument or story step by step with examples and numbers; the conclusion. Retell the reasoning, not just list the topics.',
        keyPoints: '8–14 points: facts, numbers, arguments, recommendations — each one or two self-contained sentences.',
        chronology: 'a detailed outline: a new item at every change of topic, roughly every 1–3 minutes, up to 30 items. "title" — 3–8 words; "details" — 1–2 sentences with specifics.',
        audience: 'one sentence about who will find this useful.',
      },
      ru: {
        task: 'Задача: подробный пересказ, который заменяет просмотр, — все доводы, примеры, цифры и выводы в том порядке, в каком их даёт автор.',
        tags: '8–12 тегов: все главные темы, имена и понятия, без «#».',
        summary: '2–4 абзаца (8–16 предложений), между абзацами пустая строка: контекст и вопрос; главный довод или сюжет по шагам с примерами и цифрами; вывод. Пересказывай ход мысли, а не перечисляй темы.',
        keyPoints: '8–14 пунктов: факты, цифры, доводы, рекомендации — по одному-два самостоятельных предложения.',
        chronology: 'подробный план: новый пункт на каждой смене темы, примерно каждые 1–3 минуты, до 30 пунктов. "title" — 3–8 слов; "details" — 1–2 предложения с конкретикой.',
        audience: 'одно предложение: кому это пригодится.',
      },
    },
    study: {
      en: {
        task: 'Task: study notes for learning the material, the way a strong student writes them after a lecture.',
        tags: '5–10 key terms and concepts of the video, without "#".',
        summary: '3–6 sentences that explain the core idea in simple words, as a good teacher would, with one example from the video if there is one.',
        keyPoints: '6–12 things to remember: definitions ("Term — meaning"), rules, formulas, steps of a method, important numbers. Each is precise and self-contained; keep terms and units as in the video.',
        chronology: 'the lesson plan: 4–15 sections in order. "title" — the topic of the section; "details" — what exactly is explained or shown there, including examples.',
        audience: 'who the lesson is for and what prior knowledge it assumes.',
      },
      ru: {
        task: 'Задача: конспект для изучения материала — такой, какой пишет сильный студент после лекции.',
        tags: '5–10 ключевых терминов и понятий ролика, без «#».',
        summary: '3–6 предложений: главная идея простыми словами, как объяснил бы хороший преподаватель, с одним примером из ролика, если он есть.',
        keyPoints: '6–12 пунктов «запомнить»: определения («Термин — значение»), правила, формулы, шаги метода, важные числа. Каждый точный и самостоятельный; термины и единицы — как в ролике.',
        chronology: 'план занятия: 4–15 разделов по порядку. "title" — тема раздела; "details" — что именно там объясняют или показывают, включая примеры.',
        audience: 'для кого занятие и какие знания нужны заранее.',
      },
    },
    facts: {
      en: {
        task: 'Task: extract only the hard information — facts, numbers, dates, names, prices, claims and recommendations. No retelling of the story.',
        tags: '5–8 tags for the topics the facts are about, without "#".',
        summary: '2–3 sentences: what kind of information the video gives and its single most important fact or conclusion.',
        keyPoints: '8–15 items, one fact or claim each, with numbers, dates and names exactly as said. Mark opinions and forecasts of the author with "(opinion)" or "(forecast)", translated into {language}.',
        chronology: 'where the important facts are: 4–15 items. "title" — the fact in 3–7 words; "details" — its context in one sentence.',
        audience: 'one sentence about who needs this information.',
      },
      ru: {
        task: 'Задача: вытащить только «твёрдую» информацию — факты, цифры, даты, имена, цены, утверждения и рекомендации. Без пересказа сюжета.',
        tags: '5–8 тегов тем, к которым относятся факты, без «#».',
        summary: '2–3 предложения: какую информацию даёт ролик и самый важный факт или вывод.',
        keyPoints: '8–15 пунктов, в каждом один факт или утверждение, с числами, датами и именами точно как сказано. Мнения и прогнозы автора помечай «(мнение)» или «(прогноз)».',
        chronology: 'где в ролике важные факты: 4–15 пунктов. "title" — сам факт в 3–7 словах; "details" — его контекст в одном предложении.',
        audience: 'одно предложение: кому нужна эта информация.',
      },
    },
    clickbait: {
      en: {
        task: 'Task: decode the title. Find what the title promises or asks and give the answer right away, so the reader does not have to watch the video to find it.',
        tags: '3–6 tags, without "#".',
        summary: 'Start with the direct answer to the question or promise of the title (1–2 sentences). Then one sentence: does the video deliver on its title — fully, partly or not, and why; and how much of the video passes before the answer.',
        keyPoints: '3–6 points that support or explain the answer.',
        chronology: '3–8 items, including the exact moment where the answer is given (its "title" says that this is the answer). "details" — one sentence.',
        audience: 'one sentence: is it worth watching in full, and for whom.',
      },
      ru: {
        task: 'Задача: расшифровать заголовок. Найди, что обещает или о чём спрашивает название, и сразу дай ответ — чтобы его не пришлось искать в ролике.',
        tags: '3–6 тегов, без «#».',
        summary: 'Начни с прямого ответа на вопрос или обещание из названия (1–2 предложения). Затем одно предложение: выполняет ли ролик обещание заголовка — полностью, частично или нет, и почему; и сколько ролика проходит до ответа.',
        keyPoints: '3–6 пунктов, которые подтверждают или объясняют ответ.',
        chronology: '3–8 пунктов, включая точный момент, где звучит ответ (в его "title" так и сказано, что это ответ). "details" — одно предложение.',
        audience: 'одно предложение: стоит ли смотреть целиком и кому.',
      },
    },
  };

  const PRESET_IDS = Object.keys(PRESET_SPECS);
  const PROMPT_LANGS = Object.keys(PROMPT_BASE);

  /** Встроенный промт пресета на языке интерфейса (русский — для ru, иначе английский). */
  function builtinPrompt(id, uiLang) {
    const lang = PROMPT_LANGS.includes(uiLang) ? uiLang : 'en';
    const spec = (PRESET_SPECS[id] || PRESET_SPECS.standard)[lang];
    const base = PROMPT_BASE[lang];
    const field = (name) => `- "${name}": ${spec[name]}`;
    return [
      base.intro,
      spec.task,
      base.output,
      [base.fields, ...['tags', 'summary', 'keyPoints', 'chronology', 'audience'].map(field)].join('\n'),
      [base.rules, ...base.common.map((r) => '- ' + r)].join('\n'),
    ].join('\n\n');
  }

  /** Системный промт по умолчанию (стандартный пресет, английский). */
  const DEFAULT_PROMPT = builtinPrompt('standard', 'en');
  /** Встроенные промты на английском — для совместимости и тестов. */
  const PRESETS = Object.fromEntries(PRESET_IDS.map((id) => [id, builtinPrompt(id, 'en')]));

  /**
   * Все пресеты с учётом настроек (yfs_ai):
   *   встроенные — текст можно изменить (overrides[id]), сбросить — вернуть встроенный;
   *   свои — presets: [{ id, name, text }]; старый единственный «свой промт» (prompt) — пресет «custom».
   * Ответ: [{ id, builtin, name, text, edited }], name у встроенных пустое — подпись берётся из перевода.
   */
  function presetList(settings, uiLang) {
    const s = settings || {};
    const overrides = s.overrides && typeof s.overrides === 'object' ? s.overrides : {};
    const out = PRESET_IDS.map((id) => {
      const own = typeof overrides[id] === 'string' && overrides[id].trim() ? overrides[id] : '';
      return { id, builtin: true, name: '', text: own || builtinPrompt(id, uiLang), edited: !!own };
    });
    const customs = Array.isArray(s.presets) ? s.presets.filter((p) => p && p.id && typeof p.text === 'string') : [];
    if (s.prompt && !customs.some((p) => p.id === 'custom')) out.push({ id: 'custom', builtin: false, name: '', text: s.prompt, edited: false });
    for (const p of customs) out.push({ id: String(p.id), builtin: false, name: String(p.name || ''), text: p.text, edited: false });
    return out;
  }

  /** Текст пресета; неизвестный id — стандартный. */
  function presetText(settings, id, uiLang) {
    const list = presetList(settings, uiLang);
    return (list.find((p) => p.id === id) || list[0]).text;
  }

  /** Совместимость: promptFor(preset, custom) — встроенный английский пресет или свой текст. */
  function promptFor(preset, custom) {
    if (preset === 'custom' && custom) return custom;
    return PRESETS[preset] || DEFAULT_PROMPT;
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
    const system = String(prompt || DEFAULT_PROMPT).replace(/\{language\}/g, language || 'English');
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

  /**
   * Запрос сводки. Возвращает { result, model, usedTranscript } или бросает Error с .code.
   */
  async function summarize({ key, model, prompt, video, segments, language, fetchImpl, signal, timeoutMs = 90000, thinking = true }) {
    const doFetch = fetchImpl || ((...a) => fetch(...a));
    if (!key) throw Object.assign(new Error('no key'), { code: 'ai-no-key' });
    const m = model || DEFAULT_MODEL;
    // Таймаут и отмена: зависший запрос не держит панель вечно, а балансировщик переходит к другой модели.
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
        body: JSON.stringify(buildRequest({ video, segments, language, prompt, model: m, thinking })),
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
      // Модель не принимает настройку thinking — тот же запрос без неё.
      if (code === 'ai-thinking' && thinking) return summarize({ key, model, prompt, video, segments, language, fetchImpl, signal, timeoutMs, thinking: false });
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
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw Object.assign(new Error('bad json'), { code: 'ai-failed' });
    }
    return { result: normalizeResult(parsed), model: m, usedTranscript: !!(segments && segments.length) };
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
   * Сводка с балансировкой: модель перегружена (503), упёрлась в лимит (429), пропала (404) или не ответила вовремя —
   * повтор через ~1 с (только для 503) и переход к следующей модели. До maxModels моделей.
   * onProgress({ model, attempt, tried }) — что сейчас пробуем (для подписи в панели).
   * Ответ: { result, model, usedTranscript, tried: [{ model, code }] }.
   */
  async function summarizeSmart(args) {
    const { model, models, onProgress, maxModels = 4, signal } = args;
    const list = candidates(models, model).slice(0, maxModels);
    const tried = [];
    let lastErr = null;
    for (const m of list) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'ai-cancelled' });
        if (onProgress) onProgress({ model: m, attempt, tried: tried.slice() });
        try {
          const out = await summarize({ ...args, model: m });
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
    DEFAULT_PROMPT,
    PRESETS,
    PRESET_IDS,
    SCHEMA,
    builtinPrompt,
    presetList,
    presetText,
    promptFor,
    hashText,
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
