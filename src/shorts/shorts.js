'use strict';

const R = YFS.rules;
const tr = YFS.i18n.t;
const $ = (id) => document.getElementById(id);

let rules = R.normalizeRules();
let seen = { authors: {}, tags: {} };
let pro = false;
let savedTimer = 0;

function flashSaved() {
  $('saved').textContent = tr('common.saved');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('saved').textContent = ''), 1500);
}

function saveRules() {
  rules = R.normalizeRules(rules);
  chrome.storage.local.set({ yfs_skip: rules }).then(flashSaved);
}

/** Строки списка: тем, кого смотрели (по частоте), плюс отмеченные вручную, которых в просмотренном ещё нет. */
function authorRows() {
  const rows = new Map();
  for (const [key, a] of Object.entries(seen.authors || {})) rows.set(key, { key, name: a.name || key, count: a.count || 0 });
  for (const [key, name] of Object.entries(rules.authors)) if (!rows.has(key)) rows.set(key, { key, name, count: 0 });
  return Array.from(rows.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

function tagRows() {
  const rows = new Map();
  for (const [tag, count] of Object.entries(seen.tags || {})) rows.set(tag, { key: tag, name: '#' + tag, count });
  for (const tag of rules.tags) if (!rows.has(tag)) rows.set(tag, { key: tag, name: '#' + tag, count: 0 });
  return Array.from(rows.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

function renderList(ul, rows, query, isBlocked, toggle) {
  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => !q || r.name.toLowerCase().includes(q));
  ul.replaceChildren();
  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = rows.length ? tr('shortsSettings.notFound') : tr('shortsSettings.emptyList');
    ul.append(li);
    return;
  }
  for (const r of shown) {
    const li = document.createElement('li');
    const blocked = isBlocked(r.key);
    li.className = blocked ? 'blocked' : '';
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = blocked;
    box.addEventListener('change', () => toggle(r, box.checked));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.name;
    name.title = r.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = r.count ? tr('n.times', { n: r.count }) : tr('shortsSettings.manual');
    label.append(box, name, count);
    li.append(label);
    ul.append(li);
  }
}

function render() {
  $('enabled').disabled = !pro;
  $('minSec').disabled = $('maxSec').disabled = !pro;
  $('proNote').hidden = pro;
  $('minSec').value = rules.minSec || '';
  $('maxSec').value = rules.maxSec || '';
  renderList(
    $('authors'),
    authorRows(),
    $('authorSearch').value,
    (key) => Object.prototype.hasOwnProperty.call(rules.authors, key),
    (row, on) => {
      if (on) rules.authors[row.key] = row.name;
      else delete rules.authors[row.key];
      saveRules();
      render();
    }
  );
  renderList(
    $('tags'),
    tagRows(),
    $('tagSearch').value,
    (tag) => rules.tags.includes(tag),
    (row, on) => {
      rules.tags = on ? [...rules.tags, row.key] : rules.tags.filter((t) => t !== row.key);
      saveRules();
      render();
    }
  );
}

async function load() {
  const data = await chrome.storage.local.get(['yfs_viewer', 'yfs_autoscroll', 'yfs_skip', 'yfs_seen']);
  pro = !!(data.yfs_viewer && data.yfs_viewer.pro);
  $('enabled').checked = pro && !!data.yfs_autoscroll;
  rules = R.normalizeRules(data.yfs_skip);
  seen = data.yfs_seen && typeof data.yfs_seen === 'object' ? data.yfs_seen : { authors: {}, tags: {} };
  render();
}

$('enabled').addEventListener('change', () => chrome.storage.local.set({ yfs_autoscroll: $('enabled').checked }).then(flashSaved));
for (const id of ['minSec', 'maxSec']) {
  $(id).addEventListener('change', () => {
    rules.minSec = Number($('minSec').value) || 0;
    rules.maxSec = Number($('maxSec').value) || 0;
    if (rules.minSec && rules.maxSec && rules.minSec > rules.maxSec) [rules.minSec, rules.maxSec] = [rules.maxSec, rules.minSec];
    saveRules();
    render();
  });
}
for (const btn of document.querySelectorAll('[data-preset]')) {
  btn.addEventListener('click', () => {
    if (!pro) return;
    [rules.minSec, rules.maxSec] = btn.dataset.preset.split(',').map(Number);
    saveRules();
    render();
  });
}
$('authorSearch').addEventListener('input', render);
$('tagSearch').addEventListener('input', render);

function addTag() {
  const tags = R.extractTags($('tagInput').value.includes('#') ? $('tagInput').value : '#' + $('tagInput').value.trim().replace(/\s+/g, '_'));
  if (!tags.length) return;
  rules.tags = [...new Set([...rules.tags, ...tags])];
  $('tagInput').value = '';
  saveRules();
  render();
}
$('tagAdd').addEventListener('click', addTag);
$('tagInput').addEventListener('keydown', (e) => e.key === 'Enter' && addTag());

$('clearSeen').addEventListener('click', async () => {
  if (!confirm(tr('shortsSettings.clearConfirm'))) return;
  seen = { authors: {}, tags: {} };
  await chrome.storage.local.set({ yfs_seen: seen });
  render();
});
$('getPro').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer/viewer.html#pro') });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.yfs_seen) seen = changes.yfs_seen.newValue || { authors: {}, tags: {} };
  if (changes.yfs_viewer) pro = !!(changes.yfs_viewer.newValue && changes.yfs_viewer.newValue.pro);
  if (changes.yfs_seen || changes.yfs_viewer) render();
});

YFS.i18n.init().then(load);
YFS.i18n.onChange(() => location.reload());
