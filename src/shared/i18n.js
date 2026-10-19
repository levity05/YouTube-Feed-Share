/*
 * Переводы интерфейса.
 *
 *   t('key', { n: 5, name: 'Саша' }) — строка с подстановками {name}; если значение — объект
 *   { one, few, many, other }, форма выбирается по n через Intl.PluralRules.
 *
 * Английский словарь (src/locales/en.js) подключается всегда и служит запасным.
 * Остальные языки — JSON в src/locales/; страницы грузят их сами, content scripts — через фоновый скрипт.
 * Выбор языка: 'auto' (язык браузера) или код; хранится в yfs_lang.
 */
(function (root) {
  'use strict';

  const LANGUAGES = [
    { code: 'en', name: 'English', english: 'English', locale: 'en-US' },
    { code: 'ru', name: 'Русский', english: 'Russian', locale: 'ru-RU' },
    { code: 'uk', name: 'Українська', english: 'Ukrainian', locale: 'uk-UA' },
    { code: 'es', name: 'Español', english: 'Spanish', locale: 'es-ES' },
    { code: 'pt', name: 'Português', english: 'Portuguese', locale: 'pt-BR' },
    { code: 'fr', name: 'Français', english: 'French', locale: 'fr-FR' },
    { code: 'de', name: 'Deutsch', english: 'German', locale: 'de-DE' },
    { code: 'it', name: 'Italiano', english: 'Italian', locale: 'it-IT' },
    { code: 'pl', name: 'Polski', english: 'Polish', locale: 'pl-PL' },
    { code: 'tr', name: 'Türkçe', english: 'Turkish', locale: 'tr-TR' },
    { code: 'ja', name: '日本語', english: 'Japanese', locale: 'ja-JP' },
    { code: 'zh', name: '简体中文', english: 'Simplified Chinese', locale: 'zh-CN' },
  ];
  const CODES = LANGUAGES.map((l) => l.code);

  const dicts = {};
  let lang = 'en';
  const plurals = {};

  // Каталог словарей для страниц: …/src/shared/i18n.js → …/src/locales/
  const LOCALES_BASE =
    root.document && root.document.currentScript && root.document.currentScript.src
      ? new URL('../locales/', root.document.currentScript.src).href
      : null;

  function register(code, dict) {
    dicts[code] = Object.assign(dicts[code] || {}, dict || {});
  }

  /** 'auto' → первый поддерживаемый язык браузера, иначе английский. */
  function resolve(pref) {
    if (pref && pref !== 'auto' && CODES.includes(pref)) return pref;
    const nav = root.navigator ? root.navigator.languages || [root.navigator.language] : [];
    for (const n of nav) {
      const c = String(n || '').toLowerCase().split('-')[0];
      if (CODES.includes(c)) return c;
    }
    return 'en';
  }

  function pluralCategory(n) {
    if (!plurals[lang]) {
      try {
        plurals[lang] = new Intl.PluralRules(locale());
      } catch {
        plurals[lang] = { select: (x) => (x === 1 ? 'one' : 'other') };
      }
    }
    return plurals[lang].select(Number(n) || 0);
  }

  function lookup(key) {
    const d = dicts[lang];
    if (d && d[key] !== undefined) return d[key];
    if (dicts.en && dicts.en[key] !== undefined) return dicts.en[key];
    return undefined;
  }

  function t(key, params) {
    let v = lookup(key);
    if (v === undefined) return key;
    if (v && typeof v === 'object') {
      const n = params && params.n !== undefined ? params.n : 0;
      v = v[pluralCategory(n)] ?? v.other ?? v.many ?? v.one ?? '';
    }
    let s = String(v);
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
    return s;
  }

  function info(code = lang) {
    return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
  }

  function locale() {
    return info().locale;
  }

  function setLanguage(code) {
    lang = CODES.includes(code) ? code : 'en';
    if (root.document && root.document.documentElement) root.document.documentElement.lang = lang;
  }

  /**
   * Перевести разметку: data-i18n (текст), data-i18n-placeholder, data-i18n-title, data-i18n-aria (aria-label),
   * data-i18n-html — только для доверенных строк из словаря с <b>, <code>, <a>.
   */
  function apply(scope) {
    const rootEl = scope || (root.document && root.document);
    if (!rootEl) return;
    for (const el of rootEl.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of rootEl.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
    for (const el of rootEl.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of rootEl.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of rootEl.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }

  async function fetchDict(code) {
    if (code === 'en' || dicts[code]) return;
    try {
      const ownFiles = root.location && root.location.protocol === 'chrome-extension:';
      if (LOCALES_BASE) {
        // страница (расширения или размещённый просмотрщик)
        const res = await fetch(new URL(code + '.json', LOCALES_BASE));
        if (res.ok) register(code, await res.json());
      } else if (ownFiles && root.chrome && root.chrome.runtime && root.chrome.runtime.getURL) {
        // фоновый скрипт расширения
        const res = await fetch(root.chrome.runtime.getURL('src/locales/' + code + '.json'));
        if (res.ok) register(code, await res.json());
      } else if (root.chrome && root.chrome.runtime && root.chrome.runtime.sendMessage) {
        // content script на YouTube: файлов расширения ему не видно — словарь отдаёт фоновый скрипт
        const dict = await root.chrome.runtime.sendMessage({ type: 'yfs:locale', code });
        if (dict && typeof dict === 'object') register(code, dict);
      }
    } catch {
      /* нет словаря — остаётся английский */
    }
  }

  async function readPref() {
    try {
      if (root.chrome && root.chrome.storage && root.chrome.storage.local) {
        const { yfs_lang } = await root.chrome.storage.local.get('yfs_lang');
        return yfs_lang || 'auto';
      }
      return (root.localStorage && root.localStorage.getItem('yfs_lang')) || 'auto';
    } catch {
      return 'auto';
    }
  }

  async function savePref(pref) {
    try {
      if (root.chrome && root.chrome.storage && root.chrome.storage.local) await root.chrome.storage.local.set({ yfs_lang: pref });
      else if (root.localStorage) root.localStorage.setItem('yfs_lang', pref);
    } catch {
      /* не сохранилось — выбор действует до перезагрузки */
    }
  }

  /** Загрузить выбранный язык (и применить к странице). Возвращает код языка. */
  async function init({ applyToPage = true } = {}) {
    const code = resolve(await readPref());
    await fetchDict(code);
    setLanguage(code);
    if (applyToPage) apply();
    return code;
  }

  /** Подписка на смену языка (в другой вкладке/настройках). */
  function onChange(cb) {
    if (root.chrome && root.chrome.storage && root.chrome.storage.onChanged) {
      root.chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.yfs_lang) cb();
      });
    } else if (root.addEventListener) {
      root.addEventListener('storage', (e) => e.key === 'yfs_lang' && cb());
    }
  }

  const api = {
    LANGUAGES,
    register,
    resolve,
    t,
    apply,
    init,
    onChange,
    readPref,
    savePref,
    fetchDict,
    setLanguage,
    locale,
    info,
    get lang() {
      return lang;
    },
    dicts,
  };
  root.YFS = root.YFS || {};
  root.YFS.i18n = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
