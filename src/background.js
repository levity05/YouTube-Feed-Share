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
importScripts('shared/i18n.js', 'locales/en.js', 'shared/feed.js', 'shared/ai.js');

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
  return reasons.length ? { page, reasons: [...new Set(reasons)], idOnly, recovered: (res.health && res.health.recovered) || 0 } : null;
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
    await chrome.storage.local.set({ yfs_last: { snap, stats, collectedAt: Date.now() } });
    job.state.result = F.counts(snap);
    setBadge('✓', '#2ba640');
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

  // AI-сводка для панели на странице ролика youtube.com: запрос к Gemini делаем отсюда,
  // чтобы он не зависел от правил сайта YouTube.
  // Балансировщик моделей (AI.summarizeSmart): ход — сообщениями во вкладку, «Отмена» — через yfs:ai-cancel.
  if (msg.type === 'yfs:ai-summarize') {
    const reqId = String(msg.reqId || '');
    const ctrl = new AbortController();
    aiRequests.set(reqId, ctrl);
    const tabId = sender.tab && sender.tab.id;
    const target = sender.frameId ? { frameId: sender.frameId } : undefined;
    AI.summarizeSmart({
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
    runJob(msg.options || {}, msg.tabId);
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
