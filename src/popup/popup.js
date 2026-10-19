'use strict';

const F = YFS.feed;
const I18N = YFS.i18n;
const tr = I18N.t;
const $ = (id) => document.getElementById(id);

const SOURCES = ['home', 'watch-later', 'history', 'shorts'];
const ICONS = { home: '🏠', 'watch-later': '🔖', history: '👁', shorts: '⚡' };
const pageTitle = (page) => tr('feed.' + page);

const DEFAULTS = {
  sources: { home: true, 'watch-later': false, history: false, shorts: false },
  counts: { home: '50', 'watch-later': '100', history: 'last100', shorts: '30' },
  historyShorts: false,
  filters: { excludeShorts: true, excludeWatched: true, excludeLive: false, minMinutes: '', maxMinutes: '', stopWords: '' },
  author: '',
  viewerUrl: '',
  lite: false,
};
const FILTER_CHECKS = ['excludeShorts', 'excludeWatched', 'excludeLive'];
const FILTER_FIELDS = ['minMinutes', 'maxMinutes', 'stopWords'];

let tab = null;
let last = null;
let savedOpts = {}; // последние сохранённые настройки (подпись и адрес просмотрщика задаются в настройках)

// ---------- вкладки: ▶ Смотреть · 📦 Снимок · ⚡ Shorts ----------

const TABS = ['watch', 'snapshot', 'shorts'];

function setTab(name, remember = true) {
  for (const t of TABS) {
    const on = t === name;
    $('tab-' + t).setAttribute('aria-selected', String(on));
    $('tab-' + t).tabIndex = on ? 0 : -1;
    $('pane-' + t).hidden = !on;
  }
  if (remember) {
    try {
      localStorage.setItem('yfs_popup_tab', name);
    } catch {
      /* без запоминания */
    }
  }
}

/** Какую вкладку открыть: идёт сбор — «Снимок»; открыт ролик — «Смотреть»; иначе — последняя открытая. */
function initialTab(onVideo, running) {
  if (running) return 'snapshot';
  if (onVideo) return 'watch';
  let saved = '';
  try {
    saved = localStorage.getItem('yfs_popup_tab') || '';
  } catch {
    saved = '';
  }
  return TABS.includes(saved) ? saved : 'watch';
}

// ---------- настройки ----------

/** Настройки v1 были плоскими ({ count, excludeShorts, … }) — переносим их. */
function migrate(saved) {
  if (!saved || typeof saved !== 'object') return {};
  if (saved.sources) return saved;
  const filters = {};
  for (const k of [...FILTER_CHECKS, ...FILTER_FIELDS]) if (k in saved) filters[k] = saved[k];
  return {
    counts: saved.count ? { home: String(saved.count) } : {},
    filters,
    author: saved.author,
    viewerUrl: saved.viewerUrl,
    lite: saved.lite,
  };
}

function readOptions() {
  const o = { sources: {}, counts: {}, filters: {} };
  for (const s of SOURCES) {
    o.sources[s] = $(`src-${s}`).checked;
    o.counts[s] = $(`cnt-${s}`).value;
  }
  for (const k of FILTER_CHECKS) o.filters[k] = $(k).checked;
  for (const k of FILTER_FIELDS) o.filters[k] = $(k).value.trim();
  o.author = savedOpts.author || '';
  o.viewerUrl = savedOpts.viewerUrl || '';
  o.lite = $('lite').checked;
  o.historyShorts = $('historyShorts').checked;
  return o;
}

function fillOptions(saved) {
  const m = migrate(saved);
  const o = {
    ...DEFAULTS,
    ...m,
    sources: { ...DEFAULTS.sources, ...m.sources },
    counts: { ...DEFAULTS.counts, ...m.counts },
    filters: { ...DEFAULTS.filters, ...m.filters },
  };
  for (const s of SOURCES) {
    $(`src-${s}`).checked = !!o.sources[s];
    const select = $(`cnt-${s}`);
    select.value = o.counts[s];
    if (select.selectedIndex === -1) select.value = DEFAULTS.counts[s];
  }
  for (const k of FILTER_CHECKS) $(k).checked = !!o.filters[k];
  for (const k of FILTER_FIELDS) $(k).value = o.filters[k];
  savedOpts = { ...m };
  $('lite').checked = !!o.lite;
  $('historyShorts').checked = !!o.historyShorts;
  syncForm();
}

function saveOptions() {
  savedOpts = { ...savedOpts, ...readOptions() };
  chrome.storage.local.set({ yfs_opts: savedOpts });
}

function syncForm() {
  let any = false;
  for (const s of SOURCES) {
    const on = $(`src-${s}`).checked;
    $(`cnt-${s}`).disabled = !on;
    any = any || on;
  }
  $('collect').disabled = !any;
  $('historyWarn').hidden = !$('src-history').checked;
  $('historyShortsRow').hidden = !$('src-history').checked;
  $('shortsWarn').hidden = !$('src-shorts').checked;
  $('loginHint').hidden = !$('src-history').checked && !$('src-watch-later').checked;
}

function applyPreset(name) {
  for (const s of SOURCES) $(`src-${s}`).checked = name === 'all' || name === s;
  syncForm();
  saveOptions();
}

// ---------- сообщения ----------

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

function describeTab() {
  let onYouTube = false;
  try {
    onYouTube = !!tab && new URL(tab.url).hostname === 'www.youtube.com';
  } catch {
    onYouTube = false;
  }
  $('tabHint').textContent = onYouTube
    ? tr('popup.tabThis')
    : tr('popup.tabNew');
  return onYouTube;
}

// ---------- сбор ----------

async function start(e) {
  e.preventDefault();
  showError('');
  saveOptions();
  const o = readOptions();
  const sources = {};
  for (const s of SOURCES) sources[s] = o.sources[s] ? (s === 'history' ? o.counts[s] : Number(o.counts[s])) : 0;
  sources.historyShorts = o.historyShorts;
  const res = await chrome.runtime.sendMessage({
    type: 'yfs:start',
    tabId: describeTab() ? tab.id : null,
    options: { sources, filters: o.filters, author: o.author, lang: navigator.language },
  });
  if (!res || !res.ok) showError((res && res.error) || tr('popup.startFailed'));
}

function goalText(g) {
  const name = tr('goal.' + g.type);
  return g.target ? `${name} ${g.found}/${g.target}` : `${name} ${g.found}`;
}

const STATE_KEYS = { pending: 'step.pending', cancelled: 'step.cancelled' };

function renderJob(state) {
  const running = !!(state && state.running);
  $('form').hidden = running;
  $('progress').hidden = !running;
  $('jobDot').hidden = !running;
  if (!state) return;

  const list = $('steps');
  list.replaceChildren();
  for (const step of state.steps || []) {
    const title = pageTitle(step.page);
    let status = STATE_KEYS[step.status] ? tr(STATE_KEYS[step.status]) : '';
    if (step.status === 'running') status = step.goals.length ? step.goals.map(goalText).join(', ') : tr('step.opening');
    if (step.status === 'done') status = '✓ ' + step.goals.map(goalText).join(', ');
    if (step.status === 'error') status = step.error || tr('step.error');
    const li = document.createElement('li');
    li.className = step.status;
    const name = document.createElement('span');
    name.textContent = title;
    const st = document.createElement('span');
    st.className = 'state';
    st.textContent = status;
    li.append(name, st);
    list.append(li);
  }
  renderHealth(running ? [] : state.warnings || []);
  if (!running && state.error) showError(state.error);
  else if (!running) {
    const failed = (state.steps || []).filter((s) => s.status === 'error');
    showError(failed.map((s) => `${pageTitle(s.page)}: ${s.error}`).join('\n'));
  }
}

// ---------- здоровье парсера ----------



function renderHealth(warnings) {
  const box = $('healthBox');
  if (!warnings.length) {
    box.hidden = true;
    return;
  }
  const lines = warnings.map((w) => {
    const why = w.reasons.map((r) => tr('health.' + r)).join('; ');
    const extra = w.idOnly ? ' ' + tr('health.idOnly', { n: w.idOnly }) : '';
    return `${pageTitle(w.page)}: ${why}.${extra}`;
  });
  $('healthText').textContent = tr('health.intro') + ' ' + lines.join(' ') + ' ' + tr('health.outro');
  box.hidden = false;
}

async function downloadSample() {
  const { yfs_samples = [] } = await chrome.storage.local.get('yfs_samples');
  if (!yfs_samples.length) return showError(tr('popup.noSamples'));
  const blob = new Blob([JSON.stringify(yfs_samples[0], null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `yfs_sample_${yfs_samples[0].page}_${F.localDay()}.json`;
  a.click();
}

// ---------- результат ----------



async function showResult() {
  if (!last || !last.snap) {
    $('result').hidden = true;
    return;
  }
  const total = F.totalVideos(last.snap);
  const when = new Date(last.collectedAt || last.snap.exportedAt).toLocaleString(I18N.locale(), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  $('resultText').textContent = tr('popup.ready', { count: tr('n.videos', { n: total }), when });
  const counts = $('resultCounts');
  counts.replaceChildren();
  for (const f of last.snap.feeds) {
    const chip = document.createElement('span');
    chip.textContent = `${ICONS[f.type]} ${tr('feedShort.' + f.type)} ${f.videos.length}`;
    counts.append(chip);
  }
  $('result').hidden = false;
  $('copy').textContent = savedOpts.viewerUrl ? tr('share.copyLink') : tr('share.copyCode');
  await updateCodeInfo();
}

async function shareText() {
  const code = await F.encodeSnapshot(last.snap, { lite: $('lite').checked });
  const viewerUrl = savedOpts.viewerUrl || '';
  return (viewerUrl && F.buildShareLink(code, viewerUrl)) || code;
}

async function updateCodeInfo() {
  const info = $('codeInfo');
  try {
    const text = await shareText();
    const len = text.length.toLocaleString(I18N.locale());
    const tooLong = text.length > F.MESSENGER_LIMIT;
    info.classList.toggle('warn', tooLong);
    info.textContent = tr(tooLong ? 'popup.codeTooLong' : 'popup.codeOk', { len });
  } catch (err) {
    info.textContent = err.message;
  }
}

function download() {
  const blob = new Blob([JSON.stringify(last.snap, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = F.fileName(last.snap);
  a.click();
}

async function copy() {
  try {
    await navigator.clipboard.writeText(await shareText());
    const btn = $('copy');
    const label = btn.textContent;
    btn.textContent = tr('popup.copied');
    setTimeout(() => (btn.textContent = label), 1500);
  } catch (err) {
    showError(tr('popup.copyFailed', { error: err.message }));
  }
}

function openViewer(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer/viewer.html') + hash });
}

// ---------- PRO: автолистание Shorts ----------

async function renderPro() {
  const { yfs_viewer = {}, yfs_autoscroll = false } = await chrome.storage.local.get(['yfs_viewer', 'yfs_autoscroll']);
  const pro = !!yfs_viewer.pro;
  $('autoscroll').disabled = !pro;
  $('autoscroll').checked = pro && !!yfs_autoscroll;
  $('getPro').hidden = pro;
  $('autoscrollHint').textContent = tr(pro ? 'popup.autoscrollOn' : 'popup.autoscrollPro');
}

// ---------- текст и сводка ролика, открытого во вкладке ----------

const WATCH_FILES = [
  'src/shared/i18n.js',
  'src/locales/en.js',
  'src/shared/transcript.js',
  'src/content/ytfetch.js',
  'src/shared/ai.js',
  'src/viewer/textpanel.js',
  'src/content/watchtools.js',
  'src/content/resume.js',
  'src/content/audiomode.js',
];

function tabVideoId() {
  try {
    const u = new URL(tab.url);
    if (u.hostname !== 'www.youtube.com') return '';
    if (u.pathname === '/watch') return u.searchParams.get('v') || '';
    const m = u.pathname.match(/^\/shorts\/([\w-]{11})/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function askTab(msg) {
  return chrome.tabs.sendMessage(tab.id, msg).catch(() => null);
}

// ---------- продолжить просмотр (resume.js запоминает, где остановились) ----------

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

async function renderResume() {
  const { yfs_resume = [] } = await chrome.storage.local.get('yfs_resume');
  const items = (Array.isArray(yfs_resume) ? yfs_resume : []).filter((x) => x && x.id && !x.done).slice(0, 5);
  $('noResume').hidden = !!items.length;
  $('resumeClear').hidden = !items.length;
  const ul = $('resumeList');
  ul.replaceChildren();
  for (const x of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = x.title || x.id;
    const img = document.createElement('img');
    img.src = `https://i.ytimg.com/vi/${x.id}/mqdefault.jpg`;
    img.alt = '';
    img.loading = 'lazy';
    const info = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'r-title';
    title.textContent = x.title || x.id;
    const sub = document.createElement('div');
    sub.className = 'r-sub';
    sub.textContent = [x.channel, tr('popup.resumeAt', { time: fmtTime(x.t), total: fmtTime(x.d) })].filter(Boolean).join(' · ');
    const bar = document.createElement('div');
    bar.className = 'r-bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.min(100, Math.round((x.t / (x.d || 1)) * 100))}%`;
    bar.append(fill);
    info.append(title, sub, bar);
    btn.append(img, info);
    btn.addEventListener('click', () => openResume(x));
    const li = document.createElement('li');
    li.append(btn);
    ul.append(li);
  }
}

/** Открыть ролик с места остановки (на 3 секунды раньше — чтобы вспомнить контекст). */
function openResume(x) {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(x.id)}&t=${Math.max(0, x.t - 3)}s`;
  let onYouTube = false;
  try {
    onYouTube = !!tab && new URL(tab.url).hostname === 'www.youtube.com';
  } catch {
    onYouTube = false;
  }
  if (onYouTube) chrome.tabs.update(tab.id, { url });
  else chrome.tabs.create({ url });
  window.close();
}

async function renderVideoCard() {
  const onVideo = !!tab && !!tabVideoId();
  $('noVideo').hidden = onVideo;
  if (!onVideo) return;
  $('videoAudio').hidden = !/\/watch/.test(new URL(tab.url).pathname); // аудио-режим — для обычных роликов, не Shorts
  $('videoTitle').textContent = (tab.title || '').replace(/\s*-\s*YouTube\s*$/, '');
  $('videoCard').hidden = false;
  const info = await askTab({ type: 'yfs:watch-info' });
  if (info && info.ok && info.video.title) $('videoTitle').textContent = info.video.title;
}

/** Открыть панель «Текст / Сводка» (или включить аудио-режим) на самой странице ролика и закрыть popup. */
async function openOnPage(which) {
  $('videoError').hidden = true;
  const msg = which === 'audio' ? { type: 'yfs:audio-toggle' } : { type: 'yfs:watch-open', tab: which };
  let res = await askTab(msg);
  if (!res) {
    // Вкладку открыли до установки или обновления расширения — подключаем скрипты сейчас.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/hook.js'], world: 'MAIN' }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: WATCH_FILES });
      res = await askTab(msg);
    } catch {
      res = null;
    }
  }
  if (res && res.ok) return window.close();
  $('videoError').textContent = tr('watch.reload');
  $('videoError').hidden = false;
}

// ---------- запуск ----------

async function init() {
  await I18N.init();
  I18N.onChange(() => location.reload());
  const [{ yfs_opts, yfs_last }, { yfs_job }] = await Promise.all([
    chrome.storage.local.get(['yfs_opts', 'yfs_last']),
    chrome.storage.session.get('yfs_job'),
  ]);
  fillOptions(yfs_opts);
  last = yfs_last && yfs_last.snap ? yfs_last : null;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  describeTab();
  renderVideoCard();
  renderResume();
  renderJob(yfs_job);
  setTab(initialTab(!!tabVideoId(), !!(yfs_job && yfs_job.running)), false);
  if (!yfs_job || !yfs_job.running) chrome.action.setBadgeText({ text: '' });
  showResult();
  renderPro();
}

/**
 * Привязать обработчик к элементу popup. Если элемента нет (например, разметка и скрипт
 * разных версий в момент обновления расширения) — пропускаем и пишем в консоль,
 * а не роняем весь popup на первой же кнопке.
 */
function on(target, type, fn) {
  const node = typeof target === 'string' ? $(target) : target;
  if (node) node.addEventListener(type, fn);
  else console.warn('[Feed Share] popup: нет элемента', target);
}

for (const s of SOURCES) {
  on(`src-${s}`, 'change', syncForm);
}
for (const btn of document.querySelectorAll('[data-preset]')) {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
}
on('form', 'change', saveOptions);
on('form', 'submit', start);
on('cancel', 'click', () => {
  chrome.runtime.sendMessage({ type: 'yfs:cancel' });
  $('cancel').disabled = true;
  $('cancel').textContent = tr('popup.stopping');
});
on('review', 'click', () => openViewer('#local=last'));
on('openViewer', 'click', () => openViewer());
on('openOptions', 'click', () => chrome.runtime.openOptionsPage());
for (const t of TABS) on('tab-' + t, 'click', () => setTab(t));
// Стрелки влево/вправо по вкладкам — как в обычном tablist.
on(document.querySelector('.tabs'), 'keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const cur = TABS.findIndex((t) => $('tab-' + t).getAttribute('aria-selected') === 'true');
  const next = TABS[(cur + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
  setTab(next);
  $('tab-' + next).focus();
});
on('videoText', 'click', () => openOnPage('text'));
on('videoSummary', 'click', () => openOnPage('summary'));
on('videoAudio', 'click', () => openOnPage('audio'));
on('resumeClear', 'click', async () => {
  await chrome.storage.local.remove('yfs_resume');
  renderResume();
});
on('download', 'click', download);
on('sampleBtn', 'click', downloadSample);
on('autoscroll', 'change', () => chrome.storage.local.set({ yfs_autoscroll: $('autoscroll').checked }));
on('getPro', 'click', () => openViewer('#pro'));
on('shortsSettings', 'click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/shorts/shorts.html') }));
on('copy', 'click', copy);
on('lite', 'change', () => {
  saveOptions();
  updateCodeInfo();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.yfs_job) {
    const state = changes.yfs_job.newValue;
    renderJob(state);
    if (state && !state.running) {
      $('cancel').disabled = false;
      $('cancel').textContent = tr('popup.stop');
    }
  }
  if (area === 'local' && changes.yfs_viewer) renderPro();
  if (area === 'local' && changes.yfs_last && changes.yfs_last.newValue) {
    last = changes.yfs_last.newValue;
    showResult();
  }
});

init().catch((err) => showError(err.message));
