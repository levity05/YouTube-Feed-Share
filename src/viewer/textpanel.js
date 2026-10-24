'use strict';

/*
 * Панель «Текст / Сводка» в плеере просмотрщика.
 *   📝 Текст  — транскрипт ролика с тайм-кодами или без; копировать, скачать .txt, клик по времени — перемотка.
 *   ✨ Сводка — Gemini (ключ Google AI Studio): теги смысла, краткое содержание, ключевые мысли, хронология.
 *
 * Текст берётся у страницы ролика во фрейме (frame.js) — поэтому только в просмотрщике расширения.
 * Сводка работает везде: без текста Gemini смотрит сам ролик по ссылке.
 * Та же панель открывается и на обычной странице ролика youtube.com (content/watchtools.js):
 * там cfg.getTranscript / cfg.seek / cfg.summarize заменяют связь с фреймом.
 */
(function (root) {
  const T = root.YFS.transcript;
  const AI = root.YFS.ai;
  const I = root.YFS.i18n;
  const tr = I.t;
  const YT_ORIGIN = 'https://www.youtube.com';
  const AI_CACHE_MAX = 200;

  let cfg = null; // { store, toast, frameMode }
  let panel = null;
  let state = null; // { video, frame, tab, timestamps, transcript, transcriptError, loading, summary, summaryError }
  const transcripts = new Map(); // id → { segments, chapters, title, source }
  const pending = new Map(); // reqId → { resolve, reject, timer }
  let seq = 0;

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'className') n.className = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k in n) n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  }

  // ---------- связь с фреймом ролика ----------

  function askFrame(frame, cmd, extra, timeout = 25000) {
    return new Promise((resolve, reject) => {
      if (!frame || !frame.contentWindow) return reject(new Error('no-frame'));
      const reqId = `t${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error('timeout'));
      }, timeout);
      pending.set(reqId, { resolve, reject, timer });
      frame.contentWindow.postMessage(JSON.stringify({ yfs: 'cmd', cmd, reqId, ...extra }), YT_ORIGIN);
    });
  }

  /** Ответ frame.js (вызывает viewer.js из своего обработчика сообщений). */
  function onFrameReply(data) {
    const p = pending.get(data.reqId);
    if (!p) return;
    pending.delete(data.reqId);
    clearTimeout(p.timer);
    if (data.ok) p.resolve(data);
    else p.reject(Object.assign(new Error(data.error || 'failed'), { details: data.details || '' }));
  }

  function seek(sec) {
    if (!state || !cfg.frameMode) return;
    if (cfg.seek) return cfg.seek(sec); // страница ролика на youtube.com — видео рядом
    if (!state.frame || !state.frame.contentWindow) return;
    state.frame.contentWindow.postMessage(JSON.stringify({ yfs: 'cmd', cmd: 'seek', time: sec }), YT_ORIGIN);
  }

  async function loadTranscript() {
    const v = state.video;
    if (transcripts.has(v.id)) return transcripts.get(v.id);
    const r = cfg.getTranscript ? await cfg.getTranscript(v.id) : await askFrame(state.frame, 'transcript', { videoId: v.id }, 50000);
    const t = { segments: r.segments || [], chapters: r.chapters || [], title: r.title || '', channel: r.channel || '', source: r.source || '' };
    transcripts.set(v.id, t);
    return t;
  }

  // ---------- настройки AI ----------

  /**
   * Настройки AI: model '' — «Авто» (балансировщик сам выбирает самую быструю доступную),
   * preset — выбранный пресет; presets — все пресеты (встроенные с правками пользователя и свои, см. AI.presetList).
   */
  async function aiSettings() {
    const s = (await cfg.store.get('yfs_ai', {})) || {};
    const presets = AI.presetList(s, I.lang);
    const preset = presets.some((p) => p.id === s.preset) ? s.preset : s.prompt ? 'custom' : 'standard';
    return { key: s.key || '', model: s.model || '', models: s.models || [], preset, presets, raw: s };
  }

  function presetName(p) {
    return p.builtin ? tr('ai.preset.' + p.id) : p.name || tr('ai.preset.custom');
  }

  function currentPreset() {
    const list = state.presets || AI.presetList({}, I.lang);
    return list.find((p) => p.id === state.preset) || list[0];
  }

  /** Новый текст пресета: у встроенного — правка поверх (пустая или совпадающая со встроенным — сброс), у своего — сам текст. */
  async function savePresetText(p, text) {
    const s = (await cfg.store.get('yfs_ai', {})) || {};
    const t = String(text || '').trim();
    if (p.builtin) {
      // Правка встроенного пресета — только для текущего языка: на других языках остаётся их встроенный текст.
      await saveAiSettings(AI.overridePatch(s, p.id, I.lang, t));
    } else if (p.id === 'custom' && !(s.presets || []).some((x) => x.id === 'custom')) {
      await saveAiSettings({ prompt: t });
    } else {
      await saveAiSettings({ presets: (s.presets || []).map((x) => (x.id === p.id ? { ...x, text: t } : x)) });
    }
    state.presets = (await aiSettings()).presets;
  }

  async function saveAiSettings(patch) {
    const s = (await cfg.store.get('yfs_ai', {})) || {};
    await cfg.store.set('yfs_ai', { ...s, ...patch });
  }

  /** Список моделей для выбора: из проверки ключа в настройках, а если его нет — спрашиваем Google один раз. */
  async function ensureModels(s) {
    if (s.models.length || !s.key || state.modelsAsked) return s.models;
    state.modelsAsked = true;
    try {
      const models = await (cfg.listModels || AI.listModels)(s.key);
      if (models && models.length) {
        await saveAiSettings({ models });
        return models;
      }
    } catch {
      /* список не обязателен: «Авто» работает и без него */
    }
    return s.models;
  }

  // Стандартный пресет — старый ключ кэша (сводки, сделанные раньше, не теряются).
  const cacheKey = (id, preset) => id + '|' + I.lang + (preset && preset !== 'standard' ? '|' + preset : '');

  async function cachedSummary(id, preset) {
    const cache = (await cfg.store.get('yfs_ai_cache', {})) || {};
    const hit = cache[cacheKey(id, preset)] || null;
    if (!hit || !hit.promptHash || !state.presets) return hit;
    const p = state.presets.find((x) => x.id === preset);
    return p && AI.hashText(p.text) !== hit.promptHash ? null : hit;
  }

  async function saveSummary(id, preset, entry) {
    const cache = (await cfg.store.get('yfs_ai_cache', {})) || {};
    cache[cacheKey(id, preset)] = entry;
    const keys = Object.keys(cache);
    if (keys.length > AI_CACHE_MAX) {
      keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
      for (const k of keys.slice(0, keys.length - AI_CACHE_MAX)) delete cache[k];
    }
    await cfg.store.set('yfs_ai_cache', cache);
  }

  // ---------- вывод ----------

  function fileSafe(s) {
    return String(s || 'video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
  }

  function download(name, text) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      cfg.toast(tr('text.copied'));
    } catch (err) {
      // Запасной путь, если сайт запретил Clipboard API.
      const ta = el('textarea', { value: text });
      ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
      (panel || document.body).append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) cfg.toast(tr('text.copied'));
      else cfg.toast(err.message, true);
    }
  }

  function videoTitle() {
    const v = state.video;
    return v.title || (transcripts.get(v.id) || {}).title || v.id;
  }

  function videoChannel() {
    const v = state.video;
    return v.channel || (transcripts.get(v.id) || {}).channel || '';
  }

  /** «Название видео - Канал» — для имени .txt и первой строки файла. */
  function titleWithChannel() {
    const ch = videoChannel();
    return ch ? `${videoTitle()} - ${ch}` : videoTitle();
  }

  function baseFileName() {
    const ch = videoChannel();
    return ch ? `${fileSafe(videoTitle())} - ${fileSafe(ch)}` : fileSafe(videoTitle());
  }

  function transcriptString() {
    const t = transcripts.get(state.video.id);
    if (!t) return '';
    const head = `${titleWithChannel()}\nhttps://www.youtube.com/watch?v=${state.video.id}\n\n`;
    return head + T.formatTranscript(t.segments, { timestamps: state.timestamps });
  }

  function timeButton(label, sec) {
    const b = el('button', { type: 'button', className: 'tp-time', title: tr('text.seek') }, label);
    if (cfg.frameMode) b.addEventListener('click', () => seek(sec));
    else b.disabled = true;
    return b;
  }

  function renderText(body) {
    if (!cfg.frameMode) {
      body.append(el('p', { className: 'tp-note' }, tr('text.extOnly')));
      return;
    }
    if (state.loading === 'text') {
      body.append(el('p', { className: 'tp-note' }, tr('text.loading')));
      return;
    }
    if (state.transcriptError) {
      body.append(el('p', { className: 'tp-note' }, tr(state.transcriptError === 'no-transcript' ? 'text.none' : 'text.failed')));
      // Что ответил каждый способ — чтобы по скриншоту было видно, где YouTube что-то поменял.
      if (state.transcriptDetails) body.append(el('p', { className: 'tp-note small', title: state.transcriptDetails }, state.transcriptDetails));
      const retry = el('button', { type: 'button', className: 'pill' }, tr('text.retry'));
      retry.addEventListener('click', () => fetchText(true));
      body.append(retry);
      return;
    }
    const t = transcripts.get(state.video.id);
    if (!t) return;

    const ts = el('input', { type: 'checkbox', checked: state.timestamps });
    ts.addEventListener('change', () => {
      state.timestamps = ts.checked;
      render();
    });
    const copyBtn = el('button', { type: 'button', className: 'pill' }, tr('text.copy'));
    copyBtn.addEventListener('click', () => copy(transcriptString()));
    const dl = el('button', { type: 'button', className: 'pill' }, tr('text.download'));
    dl.addEventListener('click', () => download(`${baseFileName()}.txt`, transcriptString()));
    body.append(
      el(
        'div',
        { className: 'tp-tools' },
        el('label', { className: 'tp-check' }, ts, tr('text.timecodes')),
        el('span', { className: 'tp-spacer' }),
        copyBtn,
        dl
      ),
      el('p', { className: 'tp-note small' }, tr('text.stats', { n: t.segments.length }))
    );

    const list = el('div', { className: 'tp-transcript' });
    if (state.timestamps) {
      for (const s of t.segments) list.append(el('div', { className: 'tp-line' }, timeButton(T.formatTime(s.start), s.start), el('span', {}, s.text)));
    } else {
      for (const p of T.formatTranscript(t.segments, { timestamps: false }).split('\n\n')) list.append(el('p', {}, p));
    }
    body.append(list);
  }

  const AI_ERRORS = {
    'ai-no-key': 'ai.err.noKey',
    'ai-key-invalid': 'ai.err.keyInvalid',
    'ai-key-denied': 'ai.err.keyDenied',
    'ai-model-missing': 'ai.err.model',
    'ai-quota': 'ai.err.quota',
    'ai-server': 'ai.err.server',
    'ai-blocked': 'ai.err.blocked',
    'ai-failed': 'ai.err.failed',
    'ai-timeout': 'ai.err.server',
    'ai-network': 'ai.err.server',
  };

  /** Текст ошибки; если балансировщик перебрал несколько моделей — какие именно были заняты. */
  function aiErrorText(e) {
    const busy = ['ai-server', 'ai-quota', 'ai-timeout', 'ai-network', 'ai-model-missing'].includes(e.code);
    if (busy && e.tried && e.tried.length > 1) return tr('ai.err.busy', { models: e.tried.map((t) => t.model).join(', ') });
    return tr(AI_ERRORS[e.code] || 'ai.err.failed', { message: e.message });
  }

  // ---------- пресеты, модель, ход генерации ----------

  function aiControls(body) {
    const busy = state.loading === 'summary';
    const chips = el('div', { className: 'tp-presets', role: 'group', 'aria-label': tr('ai.presets') });
    for (const p of state.presets || []) {
      const on = state.preset === p.id;
      const b = el(
        'button',
        { type: 'button', className: 'tp-chip' + (on ? ' active' : ''), disabled: busy, 'aria-pressed': String(on), title: p.edited ? tr('ai.edited') : '' },
        presetName(p) + (p.edited ? ' •' : '')
      );
      b.addEventListener('click', () => choosePreset(p.id));
      chips.append(b);
    }
    const edit = el('button', { type: 'button', className: 'tp-chip tp-edit' + (state.editing ? ' active' : ''), disabled: busy, title: tr('ai.editPrompt'), 'aria-label': tr('ai.editPrompt') }, '✎');
    edit.addEventListener('click', () => {
      state.editing = !state.editing;
      state.draft = null;
      render();
    });
    chips.append(edit);
    const sel = el('select', { className: 'tp-model', title: tr('ai.model'), 'aria-label': tr('ai.model'), disabled: busy });
    sel.append(el('option', { value: '', selected: !state.aiModel }, tr('ai.modelAuto')));
    const ranked = AI.rankModels(state.models || []);
    for (const m of ranked) sel.append(el('option', { value: m.id, selected: m.id === state.aiModel }, m.id));
    if (state.aiModel && !ranked.some((m) => m.id === state.aiModel)) sel.append(el('option', { value: state.aiModel, selected: true }, state.aiModel));
    sel.addEventListener('change', () => {
      state.aiModel = sel.value;
      saveAiSettings({ model: sel.value });
    });
    body.append(el('div', { className: 'tp-tools tp-ai-controls' }, chips, el('span', { className: 'tp-spacer' }), sel));
    if (state.editing && !busy) promptEditor(body);
  }

  /** Правка промта выбранного пресета прямо в панели. Черновик переживает перерисовки панели. */
  function promptEditor(body) {
    const p = currentPreset();
    const ta = el('textarea', { className: 'tp-prompt', rows: 12, spellcheck: false, value: state.draft != null ? state.draft : p.text });
    ta.addEventListener('input', () => (state.draft = ta.value));
    const done = async (regenerate) => {
      await savePresetText(p, ta.value);
      state.editing = false;
      state.draft = null;
      if (regenerate) makeSummary(true);
      else render();
    };
    const run = el('button', { type: 'button', className: 'pill primary' }, tr('ai.savePromptRun'));
    run.addEventListener('click', () => done(true));
    const save = el('button', { type: 'button', className: 'pill' }, tr('ai.savePrompt'));
    save.addEventListener('click', () => done(false));
    const cancel = el('button', { type: 'button', className: 'pill' }, tr('common.cancel'));
    cancel.addEventListener('click', () => {
      state.editing = false;
      state.draft = null;
      render();
    });
    let reset = null;
    if (p.builtin) {
      reset = el('button', { type: 'button', className: 'pill', disabled: !p.edited && state.draft == null }, tr('ai.resetPrompt'));
      reset.addEventListener('click', async () => {
        await savePresetText(p, '');
        state.draft = null;
        render();
      });
    }
    let all = null;
    if (cfg.openSettings) {
      all = el('button', { type: 'button', className: 'tp-link' }, tr('ai.allPresets'));
      all.addEventListener('click', () => cfg.openSettings(p.id));
    }
    body.append(
      el('div', { className: 'tp-editor' }, el('p', { className: 'tp-note small' }, el('b', {}, presetName(p)), ' — ', tr('ai.promptHint', { ph: '{language}' })), ta),
      el('div', { className: 'tp-tools' }, run, save, reset, cancel, el('span', { className: 'tp-spacer' }), all)
    );
  }

  /** Пресет — одним нажатием: готовая сводка этого пресета из кэша или сразу новая. */
  async function choosePreset(id) {
    if (state.loading) return;
    state.preset = id;
    saveAiSettings({ preset: id });
    state.summaryError = null;
    state.summary = await cachedSummary(state.video.id, id);
    if (state.summary) render();
    else makeSummary();
  }

  function elapsedText() {
    return tr('ai.elapsed', { s: Math.max(0, Math.round((Date.now() - (state.startedAt || Date.now())) / 1000)) });
  }

  function progressText(p) {
    if (!p || !p.model) return '';
    if (p.tried && p.tried.length) return tr('ai.switched', { from: p.tried.map((t) => t.model).join(', '), to: p.model });
    return p.attempt ? tr('ai.retry', { model: p.model }) : p.model;
  }

  function keyForm(body) {
    const input = el('input', { type: 'password', className: 'tp-key', placeholder: 'AIza…', autocomplete: 'off', spellcheck: false });
    const save = el('button', { type: 'button', className: 'pill primary' }, tr('ai.saveKey'));
    save.addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) return;
      await saveAiSettings({ key });
      state.hasKey = true;
      render();
      makeSummary();
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());
    body.append(
      el('p', {}, tr('ai.needKey')),
      el('div', { className: 'tp-tools' }, input, save),
      el(
        'p',
        { className: 'tp-note small' },
        el('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener noreferrer' }, tr('ai.getKey')),
        ' · ',
        tr('ai.keyPrivacy')
      )
    );
  }

  function renderSummary(body) {
    if (state.hasKey === false) return keyForm(body);
    aiControls(body);
    if (state.loading === 'summary') {
      const stage = tr(state.summaryStage === 'text' ? 'ai.stageText' : 'ai.stageModel');
      const cancel = el('button', { type: 'button', className: 'pill' }, tr('common.cancel'));
      cancel.addEventListener('click', () => state.abort && state.abort.abort());
      body.append(
        el('p', { className: 'tp-note' }, stage, ' ', el('span', { className: 'tp-elapsed' }, elapsedText())),
        el('p', { className: 'tp-note small tp-progress' }, progressText(state.progress)),
        cancel
      );
      return;
    }
    if (state.summaryError) {
      body.append(el('p', { className: 'tp-error' }, aiErrorText(state.summaryError)));
      const retry = el('button', { type: 'button', className: 'pill' }, tr('text.retry'));
      retry.addEventListener('click', () => makeSummary(true));
      body.append(retry);
      if (state.summaryError.code === 'ai-key-invalid' || state.summaryError.code === 'ai-key-denied') keyForm(body);
      return;
    }
    const s = state.summary;
    if (!s) {
      const go = el('button', { type: 'button', className: 'pill primary' }, tr('ai.make'));
      go.addEventListener('click', () => makeSummary());
      body.append(el('p', { className: 'tp-note' }, tr('ai.intro')), go);
      return;
    }
    const r = s.result;
    const labels = { tags: tr('ai.tags'), summary: tr('ai.summary'), keyPoints: tr('ai.keyPoints'), chronology: tr('ai.chronology'), audience: tr('ai.audience') };
    const text = AI.summaryToText(r, { id: state.video.id, title: titleWithChannel() }, labels);
    const copyBtn = el('button', { type: 'button', className: 'pill' }, tr('text.copy'));
    copyBtn.addEventListener('click', () => copy(text));
    const dl = el('button', { type: 'button', className: 'pill' }, tr('text.download'));
    dl.addEventListener('click', () => download(`${baseFileName()} (${tr('ai.fileSuffix')}).txt`, text));
    const again = el('button', { type: 'button', className: 'pill' }, tr('ai.again'));
    again.addEventListener('click', () => makeSummary(true));

    const note = tr(s.usedTranscript ? 'ai.fromText' : 'ai.fromVideo', { model: s.model }) + (s.seconds ? ' · ' + tr('ai.elapsed', { s: s.seconds }) : '');
    const switched = s.tried && s.tried.length ? tr('ai.switched', { from: s.tried.map((t) => t.model).join(', '), to: s.model }) : '';
    body.append(el('div', { className: 'tp-tools' }, el('span', { className: 'tp-note small', title: switched }, note), el('span', { className: 'tp-spacer' }), copyBtn, dl, again));
    if (r.tags.length) body.append(el('div', { className: 'tp-tags' }, ...r.tags.map((t) => el('span', { className: 'tp-tag' }, '#' + t))));
    if (r.summary) body.append(el('h4', {}, labels.summary), el('p', {}, r.summary));
    if (r.keyPoints.length) body.append(el('h4', {}, labels.keyPoints), el('ul', { className: 'tp-points' }, ...r.keyPoints.map((p) => el('li', {}, p))));
    if (r.chronology.length) {
      const ol = el('ol', { className: 'tp-chrono' });
      for (const c of r.chronology) {
        const sec = T.timestampToSeconds(c.time);
        ol.append(el('li', {}, c.time ? timeButton(c.time, sec) : null, el('b', {}, c.title), c.details ? el('span', { className: 'muted' }, ' — ' + c.details) : null));
      }
      body.append(el('h4', {}, labels.chronology), ol);
    }
    if (r.audience) body.append(el('p', { className: 'tp-note' }, `${labels.audience}: ${r.audience}`));
  }

  function render() {
    if (!panel || !state) return;
    panel.hidden = false;
    for (const b of panel.querySelectorAll('[data-tp-tab]')) b.classList.toggle('active', b.dataset.tpTab === state.tab);
    const body = panel.querySelector('.tp-body');
    body.replaceChildren();
    if (state.tab === 'text') renderText(body);
    else renderSummary(body);
  }

  // ---------- действия ----------

  async function fetchText(force) {
    if (!cfg.frameMode) return render();
    if (force) transcripts.delete(state.video.id);
    const id = state.video.id;
    state.loading = 'text';
    state.transcriptError = '';
    state.transcriptDetails = '';
    render();
    try {
      await loadTranscript();
    } catch (err) {
      if (state && state.video.id === id) {
        state.transcriptError = err.message === 'no-transcript' ? 'no-transcript' : 'failed';
        state.transcriptDetails = err.details || (err.message !== 'no-transcript' && err.message !== 'transcript-failed' ? err.message : '');
      }
    }
    if (state && state.video.id === id) {
      state.loading = '';
      render();
    }
  }

  async function makeSummary(force) {
    const id = state.video.id;
    const s = await aiSettings();
    if (!s.key) {
      state.hasKey = false;
      return render();
    }
    state.hasKey = true;
    const preset = state.preset || s.preset;
    state.presets = s.presets;
    const prompt = AI.presetText(s.raw, preset, I.lang);
    if (!force) {
      const cached = await cachedSummary(id, preset);
      if (cached) {
        state.summary = cached;
        return render();
      }
    }
    const abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    Object.assign(state, { loading: 'summary', summaryError: null, summary: null, progress: null, abort, startedAt: Date.now() });
    // Таймер «N с» обновляем точечно, без перерисовки панели.
    const tick = setInterval(() => {
      const n = panel && panel.querySelector('.tp-elapsed');
      if (n) n.textContent = elapsedText();
    }, 1000);
    let segments = [];
    if (cfg.frameMode) {
      state.summaryStage = 'text';
      render();
      try {
        segments = (await loadTranscript()).segments;
      } catch {
        segments = []; // без текста — Gemini посмотрит сам ролик
      }
    }
    if (!state || state.video.id !== id) return clearInterval(tick);
    state.summaryStage = 'model';
    render();
    try {
      const v = state.video;
      const out = await (cfg.summarize || AI.summarizeSmart)({
        key: s.key,
        model: state.aiModel,
        models: s.models,
        prompt,
        video: { id: v.id, title: videoTitle(), channel: videoChannel(), duration: v.duration },
        segments,
        language: AI.languageName(I.info()),
        signal: abort ? abort.signal : undefined,
        onProgress(p) {
          if (!state || state.video.id !== id) return;
          state.progress = p;
          const n = panel && panel.querySelector('.tp-progress');
          if (n) n.textContent = progressText(p);
        },
      });
      const entry = { ...out, preset, promptHash: AI.hashText(prompt), seconds: Math.round((Date.now() - state.startedAt) / 1000), at: Date.now() };
      await saveSummary(id, preset, entry);
      if (state && state.video.id === id) state.summary = entry;
    } catch (err) {
      // «Отмена» — просто возвращаемся к кнопке «Сделать сводку».
      if (state && state.video.id === id && err.code !== 'ai-cancelled') state.summaryError = { code: err.code || 'ai-failed', message: err.message, tried: err.tried || [] };
    }
    clearInterval(tick);
    if (state && state.video.id === id) {
      state.loading = '';
      state.abort = null;
      render();
    }
  }

  // ---------- открытие и закрытие ----------

  function build() {
    panel = el('section', { className: 'text-panel', hidden: true });
    const tabs = el('div', { className: 'tp-tabs' });
    for (const [tab, label] of [
      ['text', tr('text.tab')],
      ['summary', tr('ai.tab')],
    ]) {
      const b = el('button', { type: 'button', className: 'tp-tab', dataset: { tpTab: tab } }, label);
      b.addEventListener('click', () => switchTab(tab));
      tabs.append(b);
    }
    const close = el('button', { type: 'button', className: 'icon-btn tp-close', 'aria-label': tr('common.close') }, '✕');
    close.addEventListener('click', hide);
    panel.append(el('div', { className: 'tp-head' }, tabs, close), el('div', { className: 'tp-body' }));
  }

  function switchTab(tab) {
    state.tab = tab;
    if (tab === 'text' && !transcripts.has(state.video.id) && !state.loading) fetchText();
    if (tab === 'summary' && !state.loading) {
      aiSettings().then(async (s) => {
        state.hasKey = !!s.key;
        state.preset = state.preset || s.preset;
        state.aiModel = s.model;
        state.presets = s.presets;
        state.models = s.models;
        if (s.key && !state.summary) state.summary = await cachedSummary(state.video.id, state.preset);
        render();
        const models = await ensureModels(s);
        if (models !== s.models && state && state.tab === 'summary' && !state.loading) {
          state.models = models;
          render();
        }
      });
    }
    render();
  }

  /** Показать панель для ролика. container — куда вставить, frame — iframe с этим роликом. */
  function open({ video, frame, container, tab }) {
    if (!panel) build();
    const sameVideo = state && state.video.id === video.id;
    if (!sameVideo) state = { video, frame, tab, timestamps: state ? state.timestamps : true, loading: '', summary: null, hasKey: null };
    else Object.assign(state, { frame, video: { ...state.video, ...video } });
    if (panel.parentElement !== container) container.append(panel);
    switchTab(tab);
    if (!cfg.overlay) panel.scrollIntoView({ block: 'nearest' });
    if (cfg.onOpen) cfg.onOpen();
  }

  /** Ролик сменился (следующий/предыдущий): если панель открыта — перезагрузить её для нового. */
  function follow(video, frame, container) {
    if (!panel || panel.hidden || !state) return;
    open({ video, frame, container, tab: state.tab });
  }

  function hide() {
    if (panel) panel.hidden = true;
    if (cfg && cfg.onHide) cfg.onHide();
  }

  function init(options) {
    cfg = options;
  }

  root.YFS.textPanel = {
    init,
    open,
    follow,
    hide,
    onFrameReply,
    get isOpen() {
      return !!panel && !panel.hidden;
    },
    get videoId() {
      return state ? state.video.id : '';
    },
  };
})(globalThis);
