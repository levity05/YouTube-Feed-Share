/*
 * Фоновый скрипт:
 * 1. Проводит сбор снимка: по очереди открывает нужные разделы YouTube в одной
 *    вкладке, просит content script собрать ленты и складывает их в снимок v2.
 *    Состояние сбора лежит в chrome.storage.session — popup просто его показывает.
 * 2. Делает плеер в просмотрщике расширения рабочим без настроек: встроенный плеер
 *    YouTube (/embed) на странице chrome-extension:// падает с ошибкой 152/153, поэтому
 *    просмотрщик показывает во фрейме обычную страницу ролика, а здесь с неё снимается
 *    запрет на показ во фрейме — только для фреймов самого расширения.
 */
importScripts('shared/i18n.js', 'locales/en.js', 'shared/feed.js', 'shared/taste.js', 'shared/ai.js', 'shared/lyrics.js', 'shared/emotes.js');

const F = self.YFS.feed;
const AI = self.YFS.ai;
const aiRequests = new Map(); // reqId → AbortController (сводки для страницы ролика youtube.com)
const I18N = self.YFS.i18n;
const tr = I18N.t;

/** Язык фонового скрипта = выбранный в настройках (для текстов ошибок в popup). */
async function loadLanguage() {
  const code = I18N.resolve(await I18N.readPref());
  await I18N.fetchDict(code);
  I18N.setLanguage(code);
}
loadLanguage();
chrome.storage.onChanged.addListener((changes, area) => area === 'local' && changes.yfs_lang && loadLanguage());

/** Словари для content scripts (у них нет доступа к файлам расширения). */
async function localeDict(code) {
  if (!I18N.LANGUAGES.some((l) => l.code === code) || code === 'en') return {};
  await I18N.fetchDict(code);
  return I18N.dicts[code] || {};
}
const EMBED_REFERER_RULE_ID = 1; // старое правило версии 2.0 — удаляется при обновлении
const FRAME_RULE_ID = 2;
const CONTENT_FILES = ['src/shared/i18n.js', 'src/locales/en.js', 'src/shared/feed.js', 'src/shared/parse.js', 'src/shared/shortsrules.js', 'src/content/collector.js', 'src/content/panel.js'];
const PAGE_URLS = {
  home: 'https://www.youtube.com/',
  'watch-later': 'https://www.youtube.com/playlist?list=WL',
  history: 'https://www.youtube.com/feed/history',
  shorts: 'https://www.youtube.com/shorts',
};

// ---------- смайлики 7TV / BetterTTV / FrankerFaceZ ----------

const EMOTE_CACHE = 'yfs_emotes_cache';
const EMOTE_TTL = 3 * 24 * 3600 * 1000;

async function emoteJson(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { ...(init || {}), signal: ctrl.signal, credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Один набор → [[имя, адрес, анимированный]]. Ивентовские наборы — поиск по 7TV по нескольким словам, самые популярные. */
async function fetchEmotePack(id) {
  const E = self.YFS.emotes;
  if (id.startsWith('custom:')) return E.parseStvSet(await emoteJson(E.API.stvSet(id.slice(7))));
  if (id.startsWith('q:')) {
    // «самые популярные по слову» — как у ивентовских наборов, но слово своё
    return E.parseStvSearch(await emoteJson(E.API.stvGql, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: E.stvSearchBody(id.slice(2), 100) }));
  }
  const pack = E.PACKS.find((p) => p.id === id);
  if (!pack) return [];
  if (pack.kind === 'stv-set') return E.parseStvSet(await emoteJson(E.API.stvSet(pack.setId)));
  if (pack.kind === 'bttv') return E.parseBttv(await emoteJson(E.API.bttvGlobal));
  if (pack.kind === 'ffz') return E.parseFfz(await emoteJson(E.API.ffzGlobal));
  const lists = [];
  for (const term of pack.terms) {
    try {
      lists.push(E.parseStvSearch(await emoteJson(E.API.stvGql, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: E.stvSearchBody(term) })));
    } catch {
      /* это слово не нашлось — берём остальные */
    }
  }
  return E.merge(lists);
}

/** Поиск стримера на 7TV по имени (один-два запроса): у кого есть набор смайликов, с названием набора и числом смайликов. */
const EMOTE_FIND = new Map();
async function findEmoteUsers(queries) {
  const E = self.YFS.emotes;
  const post = (body) => emoteJson(E.API.stvGql, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const found = new Map();
  for (const q of queries) {
    const key = q.toLowerCase();
    let users = EMOTE_FIND.get(key);
    if (!users || Date.now() - users.at > 10 * 60000) {
      const list = E.parseStvUsers(await post(E.stvUsersBody(q))).slice(0, 10);
      if (list.length) {
        const info = E.parseStvSetInfo(await post(E.stvSetsBody([...new Set(list.map((u) => u.setId))])));
        for (const u of list) Object.assign(u, { setName: (info[u.setId] || {}).name || '', count: (info[u.setId] || {}).count || 0 });
      }
      users = { at: Date.now(), list: list.filter((u) => u.count > 0) };
      if (EMOTE_FIND.size > 40) EMOTE_FIND.clear();
      EMOTE_FIND.set(key, users);
    }
    for (const u of users.list) if (!found.has(u.user)) found.set(u.user, u);
  }
  return Array.from(found.values()).slice(0, 12);
}

async function loadEmoteSets(ids, force) {
  const { [EMOTE_CACHE]: cache = {} } = await chrome.storage.local.get(EMOTE_CACHE);
  const out = {};
  let dirty = false;
  await Promise.all(
    ids.map(async (id) => {
      const c = cache[id];
      if (!force && c && Date.now() - c.at < EMOTE_TTL) {
        out[id] = c.list;
        return;
      }
      try {
        const list = await fetchEmotePack(id);
        if (list.length) {
          cache[id] = { at: Date.now(), list };
          dirty = true;
        }
        out[id] = list.length ? list : c ? c.list : [];
      } catch {
        out[id] = c ? c.list : []; // сеть недоступна — показываем, что было
      }
    })
  );
  if (dirty) await chrome.storage.local.set({ [EMOTE_CACHE]: cache });
  return out;
}

// ---------- плеер просмотрщика: страница ролика во фрейме ----------

async function installRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [EMBED_REFERER_RULE_ID, FRAME_RULE_ID],
    addRules: [
      {
        id: FRAME_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
          ],
        },
        condition: {
          // Только фреймы, которые открыл сам просмотрщик расширения; обычный YouTube не затрагивается.
          initiatorDomains: [chrome.runtime.id],
          requestDomains: ['www.youtube.com'],
          resourceTypes: ['sub_frame'],
        },
      },
    ],
  });
}

chrome.runtime.onInstalled.addListener(installRules);
chrome.runtime.onStartup.addListener(installRules);

// ---------- сбор снимка ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let job = null; // { cancelled, tabId, state }

function pageKind(href) {
  try {
    const url = new URL(href);
    if (url.hostname !== 'www.youtube.com') return null;
    if (url.pathname === '/') return 'home';
    if (url.pathname === '/playlist' && url.searchParams.get('list') === 'WL') return 'watch-later';
    if (url.pathname === '/feed/history') return 'history';
    if (url.pathname === '/shorts' || url.pathname.startsWith('/shorts/')) return 'shorts';
    return '';
  } catch {
    return null;
  }
}

async function saveState() {
  await chrome.storage.session.set({ yfs_job: job.state });
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

/** Навигация с ожиданием полной загрузки страницы. */
function navigate(tabId, url) {
  return new Promise((resolve, reject) => {
    let started = false;
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(tr('bg.loadTimeout')));
    }, 45000);
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      if (info.status === 'complete' && started) {
        cleanup();
        resolve();
      }
    };
    const onRemoved = (id) => {
      if (id !== tabId) return;
      cleanup();
      reject(new Error(tr('bg.tabClosed')));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.update(tabId, { url, active: true }).catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

async function ping(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'yfs:ping' });
  } catch {
    return null;
  }
}

/** Вкладка могла быть открыта до установки расширения — тогда внедряем скрипты вручную. */
async function ensureScripts(tabId) {
  for (let i = 0; i < 10; i++) {
    if (await ping(tabId)) return;
    await sleep(300);
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/hook.js'], world: 'MAIN' });
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  if (!(await ping(tabId))) throw new Error(tr('bg.noConnect'));
}

async function openPage(tabId, page) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  // Уже на нужной странице — не перезагружаем (сохраняется, например, выбранный чип главной).
  if (pageKind(tab.url) === page && tab.status === 'complete') return;
  await navigate(tabId, PAGE_URLS[page]);
  await sleep(1500); // даём приложению YouTube отрисовать первую порцию
}

async function getTab(tabId) {
  if (tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (pageKind(tab.url) !== null) return tab;
    } catch {
      /* вкладки уже нет */
    }
  }
  return chrome.tabs.create({ url: PAGE_URLS.home, active: true });
}

/**
 * Детектор поломки на уровне сбора: признаки от парсера + резкое падение
 * относительно прошлого сбора того же раздела (при той же цели).
 */
async function checkHealth(page, res) {
  const { yfs_health = {} } = await chrome.storage.local.get('yfs_health');
  const reasons = res.health && res.health.suspicious ? [...res.health.reasons] : [];
  let idOnly = 0;
  for (const [type, s] of Object.entries(res.stats || {})) {
    idOnly += s.idOnly || 0;
    const prev = yfs_health[type];
    if (prev && prev.found >= 20 && s.target && prev.target === s.target && s.found < prev.found * 0.3) reasons.push('drop');
    yfs_health[type] = { found: s.found, target: s.target, at: Date.now() };
  }
  await chrome.storage.local.set({ yfs_health });
  const ai = res.health && res.health.ai; // ремонт парсера с помощью ИИ: fixed | failed
  if (!reasons.length && !(ai && ai.status === 'fixed')) return null;
  return { page, reasons: [...new Set(reasons)], idOnly, recovered: (res.health && res.health.recovered) || 0, ai: ai || null };
}

function makePlan(sources) {
  const plan = [];
  const n = (v) => Math.max(0, Math.min(1000, Number(v) || 0));
  if (n(sources.home)) plan.push({ page: 'home', want: { home: n(sources.home) } });
  if (n(sources['watch-later'])) plan.push({ page: 'watch-later', want: { 'watch-later': n(sources['watch-later']) } });
  if (sources.history) {
    plan.push({ page: 'history', want: { history: String(sources.history), historyShorts: !!sources.historyShorts } });
  }
  // Окно Shorts — последним: просмотренные при сборе шорты не должны попасть в уже собранную историю.
  if (n(sources.shorts)) plan.push({ page: 'shorts', want: { shorts: n(sources.shorts) } });
  return plan;
}

async function runJob(options, tabId) {
  const plan = makePlan(options.sources || {});
  job = {
    cancelled: false,
    tabId: null,
    state: {
      running: true,
      startedAt: Date.now(),
      steps: plan.map((p) => ({ page: p.page, status: 'pending', goals: [] })),
      warnings: [],
      error: '',
    },
  };
  await saveState();
  setBadge('…', '#cc0000');

  const feeds = [];
  const stats = {};
  try {
    if (!plan.length) throw new Error(tr('bg.noSources'));
    const tab = await getTab(tabId);
    job.tabId = tab.id;

    for (let i = 0; i < plan.length; i++) {
      const step = job.state.steps[i];
      if (job.cancelled) {
        step.status = 'cancelled';
        continue;
      }
      step.status = 'running';
      await saveState();
      try {
        await openPage(tab.id, plan[i].page);
        await ensureScripts(tab.id);
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: 'yfs:collect',
          request: { page: plan[i].page, want: plan[i].want, filters: options.filters || {} },
        });
        if (!res || !res.ok) throw new Error((res && res.error) || tr('bg.collectFailed'));
        feeds.push(...res.feeds);
        Object.assign(stats, res.stats);
        const warning = await checkHealth(plan[i].page, res);
        if (warning) job.state.warnings.push(warning);
        step.goals = Object.entries(res.stats).map(([type, s]) => ({ type, found: s.found, target: s.target }));
        step.status = job.cancelled ? 'cancelled' : 'done';
      } catch (err) {
        step.status = 'error';
        step.error = err.message;
      }
      await saveState();
    }

    if (!feeds.length) {
      throw new Error(job.state.steps.map((s) => s.error).filter(Boolean)[0] || tr('bg.nothing'));
    }
    const snap = F.normalizeSnapshot({
      exportedAt: new Date().toISOString(),
      author: options.author,
      lang: options.lang,
      feeds,
    });
    if (options.target === 'taste') {
      // История для подборки по вкусу — отдельно от последнего снимка (он нужен для обмена и не должен затираться).
      const hist = (snap.feeds.find((f) => f.type === 'history') || { videos: [] }).videos;
      await chrome.storage.local.set({ yfs_taste_history: { videos: hist.slice(0, 200), collectedAt: Date.now() } });
    } else await chrome.storage.local.set({ yfs_last: { snap, stats, collectedAt: Date.now() } });
    job.state.result = F.counts(snap);
    setBadge('✓', '#2ba640');
    // После сбора возвращаем вкладку туда, откуда начали (подборка по вкусу продолжится сама).
    if (options.returnUrl && /^https:\/\/www\.youtube\.com\//.test(String(options.returnUrl)) && job.tabId) {
      try {
        await chrome.tabs.update(job.tabId, { url: String(options.returnUrl) });
      } catch {
        /* вкладку закрыли */
      }
    }
  } catch (err) {
    job.state.error = err.message;
    setBadge('!', '#cc0000');
  } finally {
    job.state.running = false;
    job.state.finishedAt = Date.now();
    await saveState();
    job = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'yfs:locale') {
    localeDict(String(msg.code || '')).then(sendResponse);
    return true; // ответ асинхронный
  }

  if (msg.type === 'yfs:open-options') {
    const hash = /^[\w=%.-]*$/.test(String(msg.hash || '')) ? String(msg.hash || '') : '';
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') + (hash ? '#' + hash : '') });
    return;
  }

  if (msg.type === 'yfs:open-shorts-settings') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/shorts/shorts.html') });
    return;
  }

  // Запросы к Gemini со страницы youtube.com делаем отсюда, чтобы они не зависели от правил сайта YouTube.
  // Балансировщик моделей: ход — сообщениями во вкладку (yfs:ai-progress), «Отмена» — через yfs:ai-cancel.
  //   yfs:ai-summarize — сводка; yfs:ai-focus — план СДВГ-режима; yfs:ai-repair — рецепт для парсера.
  const AI_TASKS = { 'yfs:ai-summarize': AI.summarizeSmart, 'yfs:ai-focus': AI.focusPlan, 'yfs:ai-repair': AI.repairRecipe, 'yfs:ai-order': AI.orderTracks, 'yfs:ai-taste': AI.tastePicks };
  if (AI_TASKS[msg.type]) {
    const reqId = String(msg.reqId || '');
    const ctrl = new AbortController();
    aiRequests.set(reqId, ctrl);
    const tabId = sender.tab && sender.tab.id;
    const target = sender.frameId ? { frameId: sender.frameId } : undefined;
    AI_TASKS[msg.type]({
      ...(msg.args || {}),
      fetchImpl: undefined,
      signal: ctrl.signal,
      onProgress: (progress) => {
        if (tabId == null) return;
        const m = { type: 'yfs:ai-progress', reqId, progress };
        (target ? chrome.tabs.sendMessage(tabId, m, target) : chrome.tabs.sendMessage(tabId, m)).catch(() => {});
      },
    })
      .then(
        (out) => sendResponse({ ok: true, out }),
        (err) => sendResponse({ ok: false, code: err.code || 'ai-failed', message: err.message, tried: err.tried || [] })
      )
      .finally(() => aiRequests.delete(reqId));
    return true;
  }

  // Тексты песен: LRCLIB и lyrics.ovh (открытые API без ключей). Запрос делает фоновый скрипт —
  // страница youtube.com не может ходить на чужие адреса. Уходят только исполнитель, название и длина трека.
  if (msg.type === 'yfs:lyrics') {
    const info = msg.info && typeof msg.info === 'object' ? msg.info : {};
    const fetchJson = async (url) => {
      if (!/^https:\/\/(lrclib\.net|api\.lyrics\.ovh)\//.test(url)) return null;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' }, credentials: 'omit' });
        return r.ok ? await r.json() : null;
      } finally {
        clearTimeout(timer);
      }
    };
    self.YFS.lyrics
      .lookup(fetchJson, {
        artist: String(info.artist || '').slice(0, 200),
        track: String(info.track || '').slice(0, 200),
        query: String(info.query || '').slice(0, 300),
        durationSec: Number(info.durationSec) || 0,
      })
      .then((out) => sendResponse({ ok: true, out }), () => sendResponse({ ok: true, out: null }));
    return true;
  }

  // Смайлики 7TV / BetterTTV / FrankerFaceZ и ивентовские наборы: запросы делает фоновый скрипт, результат кэшируется
  // на три дня (yfs_emotes_cache). Уходят только названия наборов и слова поиска («halloween»).
  if (msg.type === 'yfs:emotes') {
    const ids = (Array.isArray(msg.ids) ? msg.ids : []).map(String).filter((id) => /^(custom:[\w-]{8,40}|q:[\p{L}\p{N}_-]{2,30}|[a-z0-9-]{3,30})$/u.test(id)).slice(0, 24);
    loadEmoteSets(ids, !!msg.force).then(
      (sets) => sendResponse({ ok: true, sets }),
      (err) => sendResponse({ ok: false, message: err.message })
    );
    return true;
  }

  // Поиск стримера на 7TV: уходит только название канала / слова, которые человек ввёл в поиск смайликов.
  if (msg.type === 'yfs:emote-find') {
    const queries = [...new Set((Array.isArray(msg.q) ? msg.q : [msg.q]).map((x) => String(x || '').trim().slice(0, 60)).filter((x) => x.length >= 2))].slice(0, 3);
    if (!queries.length) {
      sendResponse({ ok: true, users: [] });
      return;
    }
    findEmoteUsers(queries).then(
      (users) => sendResponse({ ok: true, users }),
      (err) => sendResponse({ ok: false, message: err.message })
    );
    return true;
  }

  // Картинка смайлика как data:-адрес — запасной путь, если страница YouTube не разрешает грузить её с CDN напрямую.
  if (msg.type === 'yfs:img') {
    const url = String(msg.url || '');
    if (!/^https:\/\/(cdn\.7tv\.app|cdn\.betterttv\.net|cdn\.frankerfacez\.com|cdn\.jsdelivr\.net)\//.test(url)) return;
    fetch(url, { credentials: 'omit' })
      .then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
        return `data:${r.headers.get('content-type') || 'image/webp'};base64,${btoa(bin)}`;
      })
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }), () => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'yfs:ai-cancel') {
    const ctrl = aiRequests.get(String(msg.reqId || ''));
    if (ctrl) ctrl.abort();
    return;
  }

  if (msg.type === 'yfs:ai-models') {
    AI.listModels(String(msg.key || '')).then(
      (models) => sendResponse({ ok: true, models }),
      (err) => sendResponse({ ok: false, code: err.code || 'ai-failed', message: err.message })
    );
    return true;
  }

  // Стили панели «Текст / Сводка» для shadow DOM на странице YouTube.
  if (msg.type === 'yfs:asset') {
    if (msg.path !== 'src/viewer/textpanel.css') return;
    fetch(chrome.runtime.getURL(msg.path))
      .then((r) => r.text())
      .then((text) => sendResponse({ text }), () => sendResponse({ text: '' }));
    return true;
  }

  if (msg.type === 'yfs:start') {
    if (job) {
      sendResponse({ ok: false, error: tr('collect.running') });
      return;
    }
    runJob(msg.options || {}, msg.tabId || (sender.tab && sender.tab.id));
    sendResponse({ ok: true });
  } else if (msg.type === 'yfs:cancel') {
    if (job) {
      job.cancelled = true;
      if (job.tabId) chrome.tabs.sendMessage(job.tabId, { type: 'yfs:cancel' }).catch(() => {});
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'yfs:progress' && job && sender.tab && sender.tab.id === job.tabId) {
    const step = job.state.steps.find((s) => s.status === 'running');
    if (step) {
      step.goals = msg.goals || [];
      step.scanned = msg.scanned || 0;
      saveState();
      const found = job.state.steps.reduce((n, s) => n + s.goals.reduce((m, g) => m + (g.found || 0), 0), 0);
      setBadge(String(found), '#cc0000');
    }
  }
});

// Service worker перезапустился посреди сбора — честно помечаем сбор прерванным.
chrome.storage.session.get('yfs_job').then(({ yfs_job }) => {
  if (yfs_job && yfs_job.running && !job) {
    chrome.storage.session.set({
      yfs_job: { ...yfs_job, running: false, error: tr('bg.interrupted') },
    });
  }
});
