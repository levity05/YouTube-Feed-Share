/*
 * 📡 Страница прямой трансляции youtube.com/watch: удобная раскладка «плеер + чат».
 *
 * Пока на странице есть чат трансляции (и раскладка включена в ⚙ чата или в настройках расширения):
 *  - чат на всю высоту экрана и не уезжает при прокрутке;
 *  - ширина чата — своя (300–900 px); её можно менять, потянув за край чата;
 *  - чат слева или справа от плеера;
 *  - можно скрыть рекомендации под чатом и описание с комментариями под плеером.
 * В панели плеера — одна кнопка, как штатные кнопки YouTube; по ней открывается меню раскладки: вкл/выкл, сторона чата,
 * ширина S·M·L и «чат повыше».
 * Плеер YouTube сам подстраивается под оставшееся место. Настройки — yfs_live (те же, что у content/livechat.js).
 */
(function () {
  'use strict';
  if (window.top !== window || globalThis.__yfsLiveModeAlive) return;
  globalThis.__yfsLiveModeAlive = true;

  const YFS = globalThis.YFS;
  const L = YFS.liverules;
  const tr = (k, p) => YFS.i18n.t(k, p);
  const KEY = 'yfs_live';
  const root = document.documentElement;
  let s = L.normalize();
  let handle = null;
  let pbtn = null; // кнопка в панели плеера: { menu }
  let menu = null; // меню раскладки: { box, sw: [[ключ, кнопка]], seg: [{ btns, get }] }
  const SVG = 'http://www.w3.org/2000/svg';
  const SIZES = [['S', 340], ['M', 420], ['L', 560]];

  const CSS = `
    html[yfs-live] ytd-watch-flexy:not([theater]):not([fullscreen]) {
      --ytd-watch-flexy-sidebar-width: var(--yfs-chat-w) !important;
      --ytd-watch-flexy-sidebar-min-width: var(--yfs-chat-w) !important;
    }
    html[yfs-live] ytd-watch-flexy:not([theater]):not([fullscreen]) #secondary {
      width: var(--yfs-chat-w) !important; min-width: var(--yfs-chat-w) !important; max-width: var(--yfs-chat-w) !important; position: relative;
    }
    html[yfs-live][yfs-live-full] ytd-watch-flexy:not([theater]):not([fullscreen]) ytd-live-chat-frame#chat {
      position: sticky !important; top: 68px; height: calc(100vh - 84px) !important; max-height: none !important; min-height: 320px !important;
    }
    /* «Чат повыше»: колонка чата поднимается к шапке YouTube, чат занимает почти всю высоту окна от шапки до низа. */
    html[yfs-live][yfs-live-full][yfs-live-tall] ytd-watch-flexy:not([theater]):not([fullscreen]) #secondary { margin-top: -14px !important; }
    html[yfs-live][yfs-live-full][yfs-live-tall] ytd-watch-flexy:not([theater]):not([fullscreen]) ytd-live-chat-frame#chat {
      top: 64px !important; height: calc(100vh - 72px) !important;
    }
    html[yfs-live][yfs-live-norel] ytd-watch-flexy #related { display: none !important; }
    html[yfs-live][yfs-live-nobelow] ytd-watch-flexy #below ytd-watch-metadata #bottom-row,
    html[yfs-live][yfs-live-nobelow] ytd-watch-flexy #below #comments,
    html[yfs-live][yfs-live-nobelow] ytd-watch-flexy #below ytd-merch-shelf-renderer { display: none !important; }
    html[yfs-live][yfs-live-left] ytd-watch-flexy:not([theater]):not([fullscreen]) #columns { flex-direction: row-reverse !important; }
    html[yfs-live][yfs-live-left] ytd-watch-flexy:not([theater]):not([fullscreen]) #secondary { padding-left: 0 !important; padding-right: var(--ytd-margin-6x, 24px) !important; margin-left: var(--ytd-margin-6x, 24px) !important; }
    html[yfs-live][yfs-live-left] ytd-watch-flexy:not([theater]):not([fullscreen]) #primary { padding-left: 0 !important; }
    #yfs-live-handle { position: absolute; top: 0; bottom: 0; z-index: 5; width: 10px; cursor: col-resize; touch-action: none; }
    #yfs-live-handle::after { content: ''; position: absolute; top: 50%; left: 3px; width: 4px; height: 44px; margin-top: -22px; border-radius: 2px; background: rgba(127, 127, 127, .45); opacity: 0; transition: opacity .15s; }
    #yfs-live-handle:hover::after, #yfs-live-handle.on::after { opacity: 1; }
    html[yfs-live-resizing], html[yfs-live-resizing] * { cursor: col-resize !important; user-select: none !important; }
    html[yfs-live-resizing] ytd-live-chat-frame iframe { pointer-events: none; }
    /* Кнопки в панели плеера: тот же размер и выравнивание, что у штатных кнопок YouTube. */
    .yfs-live-pbtn { display: inline-flex !important; flex: 0 0 auto; align-items: center; justify-content: center; align-self: center; box-sizing: border-box; width: 48px !important; height: 48px !important; padding: 0 !important; margin: 0 !important; vertical-align: top; opacity: .9; }
    .yfs-live-pbtn:hover { opacity: 1; }
    .yfs-live-pbtn svg { display: block; width: 26px; height: 26px; fill: none; stroke: #fff; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .yfs-live-pbtn .c { fill: #fff; stroke: none; opacity: .45; transition: opacity .15s, fill .15s; }
    .yfs-live-pbtn.yfs-on .c { opacity: 1; fill: #ff4e45; }
    /* Меню раскладки над панелью плеера. */
    .yfs-live-menu { position: absolute; right: 12px; bottom: 66px; z-index: 2200; box-sizing: border-box; width: 244px; padding: 10px 12px 8px; border-radius: 12px; background: rgba(28, 28, 28, .96); color: #fff; font: 13px/18px Roboto, Arial, sans-serif; box-shadow: 0 6px 24px rgba(0, 0, 0, .6); cursor: default; }
    .yfs-live-menu[hidden] { display: none; }
    .yfs-live-menu .t { margin-bottom: 4px; color: #aaa; font-size: 11px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; }
    .yfs-live-menu .r { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; }
    .yfs-live-menu .r.col { display: block; }
    .yfs-live-menu .r.col > span { display: block; margin-bottom: 4px; color: #ddd; }
    .yfs-live-menu.off .dep { opacity: .4; pointer-events: none; }
    .yfs-live-menu .sw { position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 0; border: 0; border-radius: 10px; background: rgba(255, 255, 255, .3); cursor: pointer; transition: background .15s; }
    .yfs-live-menu .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
    .yfs-live-menu .sw[aria-checked='true'] { background: #ff4e45; }
    .yfs-live-menu .sw[aria-checked='true']::after { transform: translateX(16px); }
    .yfs-live-menu .seg { display: flex; gap: 4px; }
    .yfs-live-menu .seg button { flex: 1; height: 28px; padding: 0 6px; border: 0; border-radius: 14px; background: rgba(255, 255, 255, .12); color: #fff; cursor: pointer; font: inherit; white-space: nowrap; }
    .yfs-live-menu .seg button:hover { background: rgba(255, 255, 255, .22); }
    .yfs-live-menu .seg button[aria-checked='true'] { background: #fff; color: #0b0b0b; font-weight: 500; }
  `;

  function ensureStyle() {
    if (document.getElementById('yfs-live-mode-style')) return;
    // (стиль нужен и кнопкам плеера, поэтому подключается при первом показе любой из частей)
    const st = document.createElement('style');
    st.id = 'yfs-live-mode-style';
    st.textContent = CSS;
    (document.head || document.documentElement).append(st);
  }

  const chatFrame = () => document.querySelector('ytd-watch-flexy ytd-live-chat-frame#chat');
  const chatShown = (c) => !!c && !c.hasAttribute('collapsed') && c.getBoundingClientRect().height > 60;

  function apply() {
    const chat = chatFrame();
    const on = s.layout && location.pathname === '/watch' && chatShown(chat);
    root.toggleAttribute('yfs-live', on);
    root.toggleAttribute('yfs-live-full', on && s.chatFullHeight);
    root.toggleAttribute('yfs-live-norel', on && s.hideRelated);
    root.toggleAttribute('yfs-live-nobelow', on && s.hideBelow);
    root.toggleAttribute('yfs-live-left', on && s.chatSide === 'left');
    root.toggleAttribute('yfs-live-tall', on && s.chatTall);
    root.style.setProperty('--yfs-chat-w', `${s.chatWidth}px`);
    if (on) ensureStyle();
    placeHandle(on);
    placePlayerButtons(location.pathname === '/watch' && !!chat);
  }

  /** Значок 24×24: рамка плеера и закрашенная колонка чата («раскладка»). */
  function playerIcon() {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const add = (d, cls) => {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', d);
      if (cls) p.setAttribute('class', cls);
      svg.append(p);
    };
    add('M3.5 5.5h17v13h-17z');
    add('M14.5 6.4h5.1v11.2h-5.1z', 'c');
    return svg;
  }

  const h = (tag, cls, ...kids) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    n.append(...kids);
    return n;
  };

  /** Ширина чата ближе всего к S / M / L (если тянули за край — ни одна не подсвечена). */
  const nearestSize = () => {
    const hit = SIZES.find(([, w]) => Math.abs(w - s.chatWidth) <= 20);
    return hit ? hit[1] : 0;
  };

  function buildMenu() {
    const m = { box: h('div', 'yfs-live-menu'), sw: [], seg: [] };
    m.box.hidden = true;
    m.box.setAttribute('role', 'dialog');
    m.box.setAttribute('aria-label', tr('live.menu.title'));
    // Щелчки внутри меню не должны доходить до плеера (иначе пауза/полный экран).
    for (const t of ['click', 'dblclick', 'mousedown', 'pointerdown', 'contextmenu', 'keydown', 'keyup']) m.box.addEventListener(t, (e) => e.stopPropagation());
    const switchRow = (label, key, dep) => {
      const b = h('button', 'sw');
      b.type = 'button';
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-label', label);
      b.addEventListener('click', () => save({ [key]: !s[key] }));
      m.sw.push([key, b]);
      return h('div', 'r' + (dep ? ' dep' : ''), h('span', '', label), b);
    };
    const segRow = (label, items, get, set) => {
      const box = h('div', 'seg');
      box.setAttribute('role', 'radiogroup');
      const btns = items.map(([text, value]) => {
        const b = h('button', '', text);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => set(value));
        box.append(b);
        return [value, b];
      });
      m.seg.push({ btns, get });
      return h('div', 'r col dep', h('span', '', label), box);
    };
    m.box.append(
      h('div', 't', tr('live.menu.title')),
      switchRow(tr('live.layout'), 'layout', false),
      segRow(tr('live.menu.side'), [['◧ ' + tr('live.side.left'), 'left'], [tr('live.side.right') + ' ◨', 'right']], () => s.chatSide, (v) => save({ chatSide: v })),
      segRow(tr('live.menu.width'), SIZES, nearestSize, (w) => save({ chatWidth: w })),
      switchRow(tr('live.chatTall'), 'chatTall', true)
    );
    return m;
  }

  function syncMenu() {
    if (!menu) return;
    for (const [key, b] of menu.sw) b.setAttribute('aria-checked', String(!!s[key]));
    for (const g of menu.seg) {
      const cur = g.get();
      for (const [value, b] of g.btns) b.setAttribute('aria-checked', String(value === cur));
    }
    menu.box.classList.toggle('off', !s.layout);
  }

  const onOutside = (e) => {
    const path = e.composedPath();
    if (menu && !path.includes(menu.box) && !(pbtn && path.includes(pbtn.menu))) closeMenu();
  };
  const onEscape = (e) => {
    if (e.key === 'Escape' && menu && !menu.box.hidden) {
      e.stopPropagation();
      closeMenu();
    }
  };

  function closeMenu() {
    if (!menu || menu.box.hidden) return;
    menu.box.hidden = true;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEscape, true);
    if (pbtn) pbtn.menu.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu() {
    const player = document.querySelector('#movie_player');
    if (!player) return;
    if (!menu) menu = buildMenu();
    if (!menu.box.hidden) return closeMenu();
    if (menu.box.parentElement !== player) player.append(menu.box);
    syncMenu();
    menu.box.hidden = false;
    pbtn.menu.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onEscape, true);
  }

  /**
   * Кнопка в панели плеера — слева от «Настроек» (среди штатных кнопок YouTube), только на страницах с чатом трансляции.
   * Ищем по кнопке настроек, а не по контейнеру: в разных версиях плеера контейнеры называются по-разному.
   */
  function placePlayerButtons(show) {
    const settings = document.querySelector('#movie_player .ytp-settings-button');
    if (!show || !settings || !settings.parentElement) {
      if (pbtn) {
        closeMenu();
        pbtn.menu.remove();
        pbtn = null;
      }
      return;
    }
    ensureStyle();
    if (!pbtn) {
      const b = document.createElement('button');
      b.className = 'ytp-button yfs-live-pbtn';
      b.type = 'button';
      b.setAttribute('aria-haspopup', 'dialog');
      b.setAttribute('aria-expanded', 'false');
      b.append(playerIcon());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMenu();
      });
      pbtn = { menu: b };
    }
    if (pbtn.menu.nextElementSibling !== settings) settings.parentElement.insertBefore(pbtn.menu, settings);
    const title = tr('live.menu.title') + ': ' + tr(s.layout ? 'live.playerLayoutOn' : 'live.playerLayoutOff');
    pbtn.menu.classList.toggle('yfs-on', s.layout);
    pbtn.menu.title = title;
    pbtn.menu.setAttribute('aria-label', title);
    syncMenu();
    // Панель плеера спряталась — меню прячем вместе с ней.
    const player = document.querySelector('#movie_player');
    if (player && player.classList.contains('ytp-autohide')) closeMenu();
  }

  /** Ручка у края чата: потянуть — поменять ширину чата (плеер подстраивается). */
  function placeHandle(on) {
    const sec = document.querySelector('ytd-watch-flexy #secondary');
    if (!on || !sec) {
      if (handle) handle.remove(), (handle = null);
      return;
    }
    if (!handle) {
      handle = document.createElement('div');
      handle.id = 'yfs-live-handle';
      handle.title = tr('live.resize');
      handle.addEventListener('pointerdown', startResize);
      handle.addEventListener('dblclick', () => save({ chatWidth: L.DEFAULTS.chatWidth }));
    }
    if (handle.parentElement !== sec) sec.prepend(handle);
    handle.style.left = s.chatSide === 'left' ? 'auto' : '-12px';
    handle.style.right = s.chatSide === 'left' ? '12px' : 'auto';
  }

  function startResize(e) {
    if (e.button) return;
    e.preventDefault();
    const sec = document.querySelector('ytd-watch-flexy #secondary');
    if (!sec) return;
    const r = sec.getBoundingClientRect();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('on');
    root.setAttribute('yfs-live-resizing', '');
    let width = s.chatWidth;
    const move = (ev) => {
      width = Math.round(s.chatSide === 'left' ? ev.clientX - r.left : r.right - ev.clientX);
      width = Math.max(300, Math.min(900, width));
      root.style.setProperty('--yfs-chat-w', `${width}px`);
      window.dispatchEvent(new Event('resize')); // плеер YouTube пересчитывает размер
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.classList.remove('on');
      root.removeAttribute('yfs-live-resizing');
      save({ chatWidth: width });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  function save(patch) {
    s = L.normalize({ ...s, ...patch });
    try {
      chrome.storage.local.set({ [KEY]: s });
    } catch {
      /* расширение перезагрузили */
    }
    apply();
    window.dispatchEvent(new Event('resize'));
  }

  async function load() {
    try {
      s = L.normalize((await chrome.storage.local.get(KEY))[KEY]);
    } catch {
      s = L.normalize();
    }
    apply();
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      const before = JSON.stringify([s.layout, s.chatWidth, s.chatSide, s.chatFullHeight, s.hideRelated, s.hideBelow]);
      s = L.normalize(changes[KEY].newValue);
      apply();
      if (before !== JSON.stringify([s.layout, s.chatWidth, s.chatSide, s.chatFullHeight, s.hideRelated, s.hideBelow])) window.dispatchEvent(new Event('resize'));
    });
  } catch {
    /* расширение перезагрузили */
  }

  document.addEventListener('yt-navigate-finish', () => setTimeout(apply, 600));
  const stop = YFS.loop.every(2000, () => {
    try {
      if (!chrome.runtime.id) throw new Error('gone');
    } catch {
      stop();
      root.removeAttribute('yfs-live');
      if (handle) handle.remove();
      closeMenu();
      if (menu) menu.box.remove();
      if (pbtn) pbtn.menu.remove();
      return;
    }
    apply(); // чат появляется не сразу и его можно свернуть
  });
  YFS.i18n.init({ applyToPage: false }).catch(() => {}).then(load);
  YFS.liveMode = { apply, get settings() { return s; } };
})();
