/*
 * Панель настроек Shorts прямо на странице youtube.com/shorts:
 * шестерёнка справа вверху раскрывает длительность от/до, авторов и хештеги.
 * Работает в shadow DOM, чтобы стили YouTube не мешали. Данные — те же, что на странице
 * настроек (chrome.storage: yfs_skip, yfs_seen, yfs_autoscroll), поэтому всё синхронно.
 */
(function () {
  'use strict';
  if (window.top !== window || globalThis.__yfsPanelAlive) return;
  globalThis.__yfsPanelAlive = true;

  const R = YFS.rules;
  const tr = (k, p) => YFS.i18n.t(k, p);
  const MAX_ROWS = 40;
  const state = { open: false, pro: false, enabled: false, rules: R.normalizeRules(), seen: { authors: {}, tags: {} } };
  let host = null;
  let root = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { position: fixed; top: 64px; right: 16px; z-index: 10000; font: 13px/1.4 Roboto, Arial, sans-serif; color: #f1f1f1; }
    .gear { width: 40px; height: 40px; border: 0; border-radius: 50%; background: rgba(0,0,0,.72); color: #fff; font-size: 20px; cursor: pointer; }
    .gear:hover { background: rgba(0,0,0,.9); }
    .box { position: absolute; top: 48px; right: 0; width: 320px; max-height: min(78vh, 640px); overflow-y: auto; padding: 14px;
           border-radius: 14px; background: rgba(24,24,24,.97); box-shadow: 0 8px 32px #000a; }
    .box[hidden] { display: none; }
    h3 { margin: 12px 0 4px; font-size: 13px; }
    h3:first-child { margin-top: 0; }
    .row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
    .hint { color: #aaa; font-size: 12px; margin: 4px 0; }
    .warn { color: #ffb74d; }
    input[type=number], input[type=text], input[type=search] { width: 70px; padding: 4px 8px; border: 1px solid #ffffff33; border-radius: 8px;
           background: transparent; color: #fff; font: inherit; }
    input[type=text], input[type=search] { width: 100%; }
    input[type=checkbox] { accent-color: #ff0033; }
    button.pill { padding: 3px 10px; border: 0; border-radius: 12px; background: #ffffff26; color: #fff; font: inherit; cursor: pointer; }
    button.pill:hover { background: #ffffff40; }
    .presets { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
    ul { margin: 4px 0 0; padding: 0; list-style: none; max-height: 150px; overflow-y: auto; }
    li { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
    li label { display: flex; flex: 1; gap: 8px; align-items: center; min-width: 0; cursor: pointer; }
    li .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li.blocked .n { text-decoration: line-through; color: #aaa; }
    li .c { margin-left: auto; color: #aaa; font-variant-numeric: tabular-nums; }
    .link { color: #3ea6ff; background: none; border: 0; padding: 0; font: inherit; cursor: pointer; }
  `;

  function save(rules) {
    state.rules = R.normalizeRules(rules);
    chrome.storage.local.set({ yfs_skip: state.rules }).catch(() => {});
  }

  function rows(map, mapRules, isTag) {
    const out = new Map();
    for (const [k, v] of Object.entries(map)) {
      out.set(k, isTag ? { key: k, name: '#' + k, count: v } : { key: k, name: v.name || k, count: v.count || 0 });
    }
    for (const k of isTag ? mapRules : Object.keys(mapRules)) {
      if (!out.has(k)) out.set(k, { key: k, name: isTag ? '#' + k : mapRules[k], count: 0 });
    }
    return Array.from(out.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru')).slice(0, MAX_ROWS);
  }

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    n.append(...kids.filter((k) => k !== null && k !== undefined));
    return n;
  }

  function listUl(items, isBlocked, toggle) {
    const ul = el('ul');
    if (!items.length) ul.append(el('li', { className: 'hint', textContent: tr('panel.empty') }));
    for (const r of items) {
      const box = el('input', { type: 'checkbox', checked: isBlocked(r.key) });
      box.addEventListener('change', () => toggle(r, box.checked));
      const li = el('li', { className: isBlocked(r.key) ? 'blocked' : '' }, el('label', {}, box, el('span', { className: 'n', textContent: r.name, title: r.name }), el('span', { className: 'c', textContent: r.count ? String(r.count) : '' })));
      ul.append(li);
    }
    return ul;
  }

  function render() {
    if (!root) return;
    const box = root.querySelector('.box');
    box.hidden = !state.open;
    if (!state.open) return;
    // Не перерисовываем под руками у пользователя, пока он печатает.
    if (root.activeElement && root.activeElement.tagName === 'INPUT' && root.activeElement.type !== 'checkbox') return;
    box.replaceChildren();

    if (!state.pro) {
      box.append(el('p', { className: 'hint warn', textContent: tr('panel.proOnly') }));
      return;
    }

    const on = el('input', { type: 'checkbox', checked: state.enabled });
    on.addEventListener('change', () => chrome.storage.local.set({ yfs_autoscroll: on.checked }));
    box.append(el('h3', { textContent: tr('panel.autoscroll') }), el('label', { className: 'row' }, on, tr('panel.autoscrollLabel')));

    const min = el('input', { type: 'number', min: 0, max: 3600, value: state.rules.minSec || '' });
    const max = el('input', { type: 'number', min: 0, max: 3600, value: state.rules.maxSec || '' });
    const applyRange = () => save({ ...state.rules, minSec: Number(min.value) || 0, maxSec: Number(max.value) || 0 });
    min.addEventListener('change', applyRange);
    max.addEventListener('change', applyRange);
    const presets = el('div', { className: 'presets' });
    for (const [label, a, b] of [[tr('preset.any'), 0, 0], [tr('preset.skipUnder30'), 30, 0], [tr('preset.15to60'), 15, 60], [tr('preset.upTo30'), 0, 30]]) {
      const btn = el('button', { className: 'pill', type: 'button', textContent: label });
      btn.addEventListener('click', () => {
        save({ ...state.rules, minSec: a, maxSec: b });
        render();
      });
      presets.append(btn);
    }
    box.append(
      el('h3', { textContent: tr('panel.duration') }),
      el('div', { className: 'row' }, tr('panel.notShorter'), min, tr('panel.notLonger'), max),
      el('p', { className: 'hint', textContent: tr('shortsSettings.durationHint') }),
      presets
    );

    box.append(
      el('h3', { textContent: tr('shortsSettings.authors') }),
      listUl(rows(state.seen.authors || {}, state.rules.authors, false), (k) => Object.prototype.hasOwnProperty.call(state.rules.authors, k), (r, checked) => {
        const authors = { ...state.rules.authors };
        if (checked) authors[r.key] = r.name;
        else delete authors[r.key];
        save({ ...state.rules, authors });
        render();
      })
    );

    const tagInput = el('input', { type: 'text', placeholder: tr('shortsSettings.addTagPh') });
    const addTag = () => {
      const tags = R.extractTags(tagInput.value.includes('#') ? tagInput.value : '#' + tagInput.value.trim().replace(/\s+/g, '_'));
      if (!tags.length) return;
      save({ ...state.rules, tags: [...state.rules.tags, ...tags] });
      tagInput.value = '';
      render();
    };
    tagInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // YouTube ловит клавиши на странице (пробел, стрелки)
      if (e.key === 'Enter') addTag();
    });
    box.append(
      el('h3', { textContent: tr('shortsSettings.tags') }),
      tagInput,
      listUl(rows(state.seen.tags || {}, state.rules.tags, true), (k) => state.rules.tags.includes(k), (r, checked) => {
        save({ ...state.rules, tags: checked ? [...state.rules.tags, r.key] : state.rules.tags.filter((t) => t !== r.key) });
        render();
      })
    );

    const full = el('button', { className: 'link', type: 'button', textContent: tr('panel.allSettings') });
    full.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'yfs:open-shorts-settings' }));
    box.append(el('p', { className: 'hint' }, full));
  }

  function ensure() {
    const onShorts = /^\/shorts(\/|$)/.test(location.pathname);
    if (!onShorts) {
      if (host) host.remove(), (host = null), (root = null);
      return;
    }
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'yfs-panel-host';
    root = host.attachShadow({ mode: 'open' });
    const gear = el('button', { className: 'gear', type: 'button', title: tr('shortsSettings.title'), textContent: '⚙' });
    gear.addEventListener('click', () => {
      state.open = !state.open;
      render();
    });
    const box = el('div', { className: 'box' });
    box.hidden = true;
    // Клавиши и колесо внутри панели не должны листать шорты и ставить паузу.
    for (const t of ['keydown', 'keyup', 'wheel']) box.addEventListener(t, (e) => e.stopPropagation());
    root.append(el('style', { textContent: CSS }), el('div', { className: 'wrap' }, gear, box));
    (document.body || document.documentElement).append(host);
    render();
  }

  async function load() {
    try {
      const d = await chrome.storage.local.get(['yfs_viewer', 'yfs_autoscroll', 'yfs_skip', 'yfs_seen']);
      state.pro = !!(d.yfs_viewer && d.yfs_viewer.pro);
      state.enabled = !!d.yfs_autoscroll;
      state.rules = R.normalizeRules(d.yfs_skip);
      state.seen = d.yfs_seen && typeof d.yfs_seen === 'object' ? d.yfs_seen : { authors: {}, tags: {} };
    } catch {
      /* расширение перезагрузили — панель просто устареет */
    }
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.yfs_viewer || changes.yfs_autoscroll || changes.yfs_skip || changes.yfs_seen)) load();
  });
  document.addEventListener('yt-navigate-finish', ensure);
  window.addEventListener('popstate', ensure);
  YFS.loop.every(5000, ensure); // редкая страховка: YouTube иногда перестраивает body (общий таймер loop.js)
  YFS.i18n.init({ applyToPage: false }).then(load).then(ensure);
  YFS.i18n.onChange(() => YFS.i18n.init({ applyToPage: false }).then(render));
})();
