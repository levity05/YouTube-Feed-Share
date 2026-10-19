'use strict';

/* Общие настройки: язык интерфейса и AI-сводка (ключ Google AI Studio, модель, системный промт). */

const I18N = YFS.i18n;
const AI = YFS.ai;
const tr = I18N.t;
const $ = (id) => document.getElementById(id);

let saveTimer = 0;
function flashSaved() {
  $('saved').textContent = tr('common.saved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => ($('saved').textContent = ''), 1500);
}

async function getAi() {
  const { yfs_ai = {} } = await chrome.storage.local.get('yfs_ai');
  return { key: '', model: '', prompt: '', models: [], ...yfs_ai };
}

async function setAi(patch) {
  const cur = await getAi();
  await chrome.storage.local.set({ yfs_ai: { ...cur, ...patch } });
  flashSaved();
}

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  o.selected = !!selected;
  return o;
}

function fillModels(models, current) {
  const sel = $('model');
  // «Авто» — балансировщик: начинает с самой быстрой доступной модели и переключается, если она занята.
  const ranked = AI.rankModels(models);
  sel.replaceChildren(option('', tr('options.modelAuto', { model: (ranked[0] && ranked[0].id) || AI.DEFAULT_MODEL }), !current));
  const ids = new Set();
  for (const m of ranked) {
    ids.add(m.id);
    sel.append(option(m.id, m.title && m.title !== m.id ? `${m.title} (${m.id})` : m.id, m.id === current));
  }
  if (current && !ids.has(current)) sel.append(option(current, current, true));
}

async function checkKey() {
  const key = $('key').value.trim();
  const status = $('keyStatus');
  status.className = 'hint';
  if (!key) {
    status.textContent = tr('ai.err.noKey');
    return;
  }
  status.textContent = tr('options.checking');
  try {
    const models = await AI.listModels(key);
    const s = await getAi();
    await setAi({ key, models });
    fillModels(models, s.model);
    status.className = 'hint ok';
    status.textContent = tr('options.keyOk', { n: models.length });
  } catch (err) {
    status.className = 'hint bad';
    status.textContent = tr({ 'ai-key-invalid': 'ai.err.keyInvalid', 'ai-key-denied': 'ai.err.keyDenied', 'ai-quota': 'ai.err.quota' }[err.code] || 'ai.err.failed', { message: err.message });
  }
}

// ---------- пресеты сводки ----------
//
// Встроенные пресеты: текст можно править (yfs_ai.overrides[id]) и вернуть встроенный.
// Свои: yfs_ai.presets = [{ id, name, text }] — создать, скопировать, переименовать, удалить.
// Основной пресет (yfs_ai.preset) выбран в панели сводки по умолчанию.

const P = { list: [], selected: 'standard', dirty: false };

function presetName(p) {
  return p.builtin ? tr('ai.preset.' + p.id) : p.name || tr('ai.preset.custom');
}

async function loadPresets() {
  P.list = AI.presetList(await getAi(), I18N.lang);
  if (!P.list.some((p) => p.id === P.selected)) P.selected = P.list[0].id;
}

function selectedPreset() {
  return P.list.find((p) => p.id === P.selected) || P.list[0];
}

async function renderPresetList() {
  const s = await getAi();
  const def = P.list.some((p) => p.id === s.preset) ? s.preset : 'standard';
  const ul = $('presetList');
  ul.replaceChildren();
  for (const p of P.list) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(p.id === P.selected));
    li.tabIndex = 0;
    li.append(presetName(p));
    const badge = (text, cls) => {
      const b = document.createElement('span');
      b.className = 'badge' + (cls ? ' ' + cls : '');
      b.textContent = text;
      li.append(b);
    };
    if (p.id === def) badge(tr('options.isDefault'), 'default');
    if (p.edited) badge(tr('ai.edited'));
    if (!p.builtin) badge(tr('options.own'));
    const pick = () => selectPreset(p.id);
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
    ul.append(li);
  }
  $('makeDefault').disabled = selectedPreset().id === def;
}

function renderPresetEditor() {
  const p = selectedPreset();
  $('presetName').value = presetName(p);
  $('presetName').disabled = p.builtin;
  $('prompt').value = p.text;
  $('resetPrompt').hidden = !p.builtin;
  $('resetPrompt').disabled = !p.edited;
  $('deletePreset').hidden = p.builtin;
  P.dirty = false;
  updatePresetState();
}

function updatePresetState() {
  const n = $('prompt').value.length.toLocaleString(I18N.locale());
  $('presetState').textContent = (P.dirty ? tr('options.unsaved') + ' · ' : '') + tr('options.chars', { n });
  $('savePreset').disabled = !P.dirty;
}

async function selectPreset(id) {
  if (P.dirty && id !== P.selected) await savePreset();
  P.selected = id;
  renderPresetEditor();
  await renderPresetList();
}

async function savePreset() {
  const p = selectedPreset();
  const s = await getAi();
  const text = $('prompt').value.trim();
  if (p.builtin) {
    const overrides = { ...(s.overrides || {}) };
    if (!text || text === AI.builtinPrompt(p.id, I18N.lang).trim()) delete overrides[p.id];
    else overrides[p.id] = text;
    await setAi({ overrides });
  } else {
    const name = $('presetName').value.trim() || presetName(p);
    await setAi({ presets: (s.presets || []).map((x) => (x.id === p.id ? { ...x, name, text: text || x.text } : x)) });
  }
  await loadPresets();
  renderPresetEditor();
  await renderPresetList();
}

async function addPreset(name, text) {
  const s = await getAi();
  const id = 'p' + Date.now().toString(36);
  await setAi({ presets: [...(s.presets || []), { id, name, text }] });
  await loadPresets();
  await selectPreset(id);
  $('presetName').focus();
  $('presetName').select();
}

/** Старый единственный «свой промт» (yfs_ai.prompt) превращаем в обычный свой пресет с id «custom». */
async function migrateLegacyPrompt() {
  const s = await getAi();
  if (!s.prompt) return;
  const presets = Array.isArray(s.presets) ? s.presets : [];
  const next = presets.some((p) => p.id === 'custom') ? presets : [...presets, { id: 'custom', name: tr('ai.preset.custom'), text: s.prompt }];
  await chrome.storage.local.set({ yfs_ai: { ...s, presets: next, prompt: '' } });
}

async function initPresets() {
  await migrateLegacyPrompt();
  const s = await getAi();
  P.selected = s.preset || 'standard';
  // Ссылка из панели сводки: options.html#prompt=<id> — сразу открыть этот пресет.
  const m = location.hash.match(/prompt=([^&]+)/);
  if (m) P.selected = decodeURIComponent(m[1]);
  await loadPresets();
  renderPresetEditor();
  await renderPresetList();
  $('promptHint').textContent = tr('ai.promptHint', { ph: '{language}' });
  if (m) $('prompts').scrollIntoView();

  $('prompt').addEventListener('input', () => {
    P.dirty = true;
    updatePresetState();
  });
  $('presetName').addEventListener('input', () => {
    P.dirty = true;
    updatePresetState();
  });
  $('prompt').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      savePreset();
    }
  });
  $('savePreset').addEventListener('click', savePreset);
  $('makeDefault').addEventListener('click', async () => {
    if (P.dirty) await savePreset();
    await setAi({ preset: selectedPreset().id });
    await renderPresetList();
  });
  $('resetPrompt').addEventListener('click', async () => {
    const p = selectedPreset();
    const s2 = await getAi();
    const overrides = { ...(s2.overrides || {}) };
    delete overrides[p.id];
    await setAi({ overrides });
    await loadPresets();
    renderPresetEditor();
    await renderPresetList();
  });
  $('newPreset').addEventListener('click', async () => {
    const n = P.list.filter((p) => !p.builtin).length + 1;
    await addPreset(tr('options.newPresetName', { n }), AI.builtinPrompt('standard', I18N.lang));
  });
  $('duplicatePreset').addEventListener('click', async () => {
    const p = selectedPreset();
    await addPreset(`${presetName(p)} ${tr('options.copySuffix')}`, $('prompt').value.trim() || p.text);
  });
  $('deletePreset').addEventListener('click', async () => {
    const p = selectedPreset();
    if (p.builtin || !confirm(tr('options.deleteConfirm', { name: presetName(p) }))) return;
    const s2 = await getAi();
    await setAi({ presets: (s2.presets || []).filter((x) => x.id !== p.id), ...(s2.preset === p.id ? { preset: 'standard' } : {}) });
    P.dirty = false;
    P.selected = 'standard';
    await loadPresets();
    renderPresetEditor();
    await renderPresetList();
  });
  window.addEventListener('beforeunload', (e) => {
    if (P.dirty) e.preventDefault();
  });
}

async function init() {
  await I18N.init();
  I18N.onChange(() => location.reload());

  // Язык
  const pref = await I18N.readPref();
  const lang = $('lang');
  lang.append(option('auto', tr('options.languageAuto', { name: I18N.info(I18N.resolve('auto')).name }), pref === 'auto'));
  for (const l of I18N.LANGUAGES) lang.append(option(l.code, l.name, pref === l.code));
  lang.addEventListener('change', () => I18N.savePref(lang.value)); // onChange перезагрузит страницу

  // AI
  const s = await getAi();
  $('key').value = s.key;
  fillModels(s.models || [], s.model);
  await initPresets();

  $('key').addEventListener('change', () => setAi({ key: $('key').value.trim() }));
  $('showKey').addEventListener('click', () => {
    const hidden = $('key').type === 'password';
    $('key').type = hidden ? 'text' : 'password';
    $('showKey').textContent = tr(hidden ? 'options.hide' : 'options.show');
  });
  $('checkKey').addEventListener('click', checkKey);
  $('model').addEventListener('change', () => setAi({ model: $('model').value }));

  $('openShorts').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/shorts/shorts.html') }));
  $('openViewer').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer/viewer.html') }));
  $('clearAiCache').addEventListener('click', async () => {
    await chrome.storage.local.remove('yfs_ai_cache');
    flashSaved();
  });
  $('clearResume').addEventListener('click', async () => {
    await chrome.storage.local.remove('yfs_resume');
    flashSaved();
  });

  await initShorts();
  await initShare();
  buildNav();
}

// ---------- ⚡ Shorts: автолистание (PRO) ----------

async function initShorts() {
  const render = async () => {
    const { yfs_viewer = {}, yfs_autoscroll = false } = await chrome.storage.local.get(['yfs_viewer', 'yfs_autoscroll']);
    const pro = !!yfs_viewer.pro;
    $('autoscroll').disabled = !pro;
    $('autoscroll').checked = pro && !!yfs_autoscroll;
    $('autoscrollHint').textContent = tr(pro ? 'popup.autoscrollOn' : 'popup.autoscrollPro');
  };
  await render();
  $('autoscroll').addEventListener('change', async () => {
    await chrome.storage.local.set({ yfs_autoscroll: $('autoscroll').checked });
    flashSaved();
  });
  chrome.storage.onChanged.addListener((c, area) => area === 'local' && (c.yfs_viewer || c.yfs_autoscroll) && render());
}

// ---------- 🔗 Обмен снимком: подпись и адрес просмотрщика (yfs_opts, их же читает popup) ----------

async function initShare() {
  const { yfs_opts = {} } = await chrome.storage.local.get('yfs_opts');
  $('author').value = yfs_opts.author || '';
  $('viewerUrl').value = yfs_opts.viewerUrl || '';
  // Сохранения по очереди: иначе два быстрых изменения прочитают старые yfs_opts и второе затрёт первое.
  let queue = Promise.resolve();
  const save = (field) => () => {
    const value = $(field).value.trim();
    if (field === 'viewerUrl' && value && !/^https:\/\//i.test(value)) {
      $(field).setCustomValidity('https://…');
      $(field).reportValidity();
      return;
    }
    $(field).setCustomValidity('');
    queue = queue.then(async () => {
      const { yfs_opts: cur = {} } = await chrome.storage.local.get('yfs_opts');
      await chrome.storage.local.set({ yfs_opts: { ...cur, [field]: value } });
      flashSaved();
    });
  };
  $('author').addEventListener('change', save('author'));
  $('viewerUrl').addEventListener('change', save('viewerUrl'));
}

// ---------- меню разделов: из заголовков секций, подсветка текущей при прокрутке ----------

const NAV_ICONS = { general: '🌐', ai: '✨', prompts: '📝', shorts: '⚡', share: '🔗', data: '🗂' };

function buildNav() {
  const nav = $('nav');
  const sections = [...document.querySelectorAll('main section.card[id]')];
  const links = new Map();
  for (const s of sections) {
    const a = document.createElement('a');
    a.href = '#' + s.id;
    // Одинаковый вид пунктов: значок раздела + заголовок без его собственного эмодзи.
    const title = s.querySelector('h2').textContent.replace(/^[^\p{L}\p{N}]+/u, '');
    a.textContent = `${NAV_ICONS[s.id] || '•'}  ${title}`;
    const li = document.createElement('li');
    li.append(a);
    nav.append(li);
    links.set(s, a);
  }
  const mark = (s) => links.forEach((a, sec) => a.classList.toggle('active', sec === s));
  const io = new IntersectionObserver(
    (entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) mark(top.target);
    },
    { rootMargin: '0px 0px -60% 0px' }
  );
  sections.forEach((s) => io.observe(s));
  mark(sections[0]);
}

init();
