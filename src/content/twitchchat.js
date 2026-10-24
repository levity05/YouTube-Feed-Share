/*
 * 📡 Чат трансляции «как на Twitch» — собственный интерфейс поверх родного чата YouTube.
 *
 * Родной чат YouTube продолжает работать невидимым: из него (через src/content/livechat.js) приходят сообщения,
 * в него уходит отправка. Всё, что видит человек, нарисовано здесь:
 *  - шапка «Чат трансляции», вкладки переписок: «Чат», «👥 Группа» и отдельные люди — переключаются между собой,
 *    у каждой своя лента, счётчик новых и своё поле ответа («@ник » подставляется само);
 *  - сообщения в одну строку «ЧЧ:ММ значки Ник: текст», цвета ников Twitch, значки ведущего, модератора, спонсора,
 *    суперчаты и спонсорство карточками, удалённые сообщения, подсветка упоминаний;
 *  - прокрутка как у Twitch: «Чат приостановлен» с кнопкой возврата, пока вы читаете историю;
 *  - при наведении — ответить, в переписку, скопировать ник, карточка человека, скрыть; клик по нику — ответить;
 *  - поле ввода Twitch: подсказка ников по «@», выбор эмодзи, счётчик 200 символов, фиолетовая кнопка «Чат»;
 *  - шестерёнка — настройки (общие с livechat.js).
 */
(function () {
  'use strict';
  if (!/^\/live_chat(_replay)?\b/.test(location.pathname) || globalThis.__yfsTwitchAlive) return;
  globalThis.__yfsTwitchAlive = true;

  const YFS = globalThis.YFS;
  const L = YFS.liverules;
  const tr = (k, p) => YFS.i18n.t(k, p);
  const ROWS_MAX = 400;
  const START = Date.now();
  const EMOJI = Array.from(
    '😀😃😄😁😆😅😂🤣🥲😊😇🙂😉😍🥰😘😋😛😜🤪😎🤩🥳😏😒😞😔😟😕🙁😣😖😫😩🥺😢😭😤😠😡🤬🤯😳🥵🥶😱😨😰😥😓🤗🤔🤭🤫🫡🫠😐😑😶🙄😬😮😯😲🥱😴🤤😪😵🤐🥴🤢🤮🤧😷🤒🤕🤑🤠😈👿💀☠️💩🤡👻👽🤖' +
      '👍👎👌✌️🤞🤟🤘🤙👈👉👆👇☝️👋🤚🖐️✋🖖👏🙌🤝🙏💪🫶❤️🧡💛💚💙💜🖤🤍💔❤️‍🔥💯💢💥💫💦💨🕊️' +
      '🔥✨⭐🌟⚡🎉🎊🎁🏆🥇🎮🎯🎲🎧🎤🎵🎶🍕🍔🍟🍺🍻🥂☕🍿🚀💎💰👑🎂🌈☀️🌙👀🧠🤌'
  );

  let C = null; // YFS.liveChat — данные и действия из livechat.js
  let ui = null;
  const view = { pick: 'emoji', thread: 'chat', unread: {}, stick: true, pending: 0, suggest: [], suggestIdx: 0, suggestStart: 0, emoji: false, adding: false };
  const rows = new Map(); // id записи → элемент строки

  const S = () => C.settings;
  const dark = () => C.dark;
  const nameColor = (name) => (S().nameColors ? L.nameColor(name, dark(), 'twitch') : 'inherit');

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k in n) n[k] = v;
      else n.setAttribute(k, v);
    }
    n.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
    return n;
  }

  // ---------- значки и иконки (SVG, без innerHTML — у YouTube Trusted Types) ----------

  const SVGNS = 'http://www.w3.org/2000/svg';
  const BADGE = {
    owner: { bg: '#e91916', d: 'M3.5 5.5h7v7h-7zM11.5 7.3l3-1.8v7l-3-1.8z', fill: true },
    moderator: { bg: '#00ad03', d: 'M13.2 4.4a3 3 0 0 1-3.6 3.9l-4.5 4.5a1.4 1.4 0 0 1-2-2l4.5-4.5A3 3 0 0 1 11.5 2.4L9.7 4.2l1.3 1.3z', fill: true },
    member: { bg: '#9147ff', d: 'M9 3l1.7 3.6 3.9.5-2.9 2.7.7 3.9L9 11.8 5.6 13.7l.7-3.9L3.4 7.1l3.9-.5z', fill: true },
    verified: { bg: '#8a8a95', d: 'M4.5 9.3l2.8 2.8 5.6-5.8', fill: false },
  };
  const ICON = {
    gear: 'M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.73 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.25.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z',
    smile: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-3.5-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM12 17.5c2.3 0 4.2-1.4 5-3.5H7c.8 2.1 2.7 3.5 5 3.5z',
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
    down: 'M12 16.5 5.5 10l1.4-1.4 5.1 5.1 5.1-5.1 1.4 1.4z',
  };

  function svg(name, size = 20) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size));
    s.setAttribute('height', String(size));
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', ICON[name]);
    p.setAttribute('fill', 'currentColor');
    s.append(p);
    return s;
  }

  function badgeEl(b) {
    if (b.type === 'member' && b.src) return el('img', { className: 'badge', src: b.src, alt: b.label || tr('live.badge.member'), title: b.label || tr('live.badge.member') });
    const def = BADGE[b.type] || BADGE.verified;
    const box = el('span', { className: 'badge', title: tr('live.badge.' + (BADGE[b.type] ? b.type : 'verified')) });
    box.style.background = def.bg;
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 18 18');
    s.setAttribute('width', '18');
    s.setAttribute('height', '18');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', def.d);
    if (def.fill) p.setAttribute('fill', '#fff');
    else {
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', '#fff');
      p.setAttribute('stroke-width', '1.8');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
    }
    s.append(p);
    box.append(s);
    return box;
  }

  // ---------- содержимое сообщения ----------

  const dataCache = new Map();
  /** Картинка как data:-адрес через фоновый скрипт — запасной путь, если YouTube не пускает загрузку с CDN напрямую. */
  function fetchDataUrl(url) {
    if (!dataCache.has(url)) {
      dataCache.set(
        url,
        new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: 'yfs:img', url }, (r) => {
              void chrome.runtime.lastError;
              resolve(r && r.ok ? r.dataUrl : '');
            });
          } catch {
            resolve('');
          }
        })
      );
    }
    return dataCache.get(url);
  }

  /** Смайлик из 7TV / BetterTTV / FFZ / ивентового набора. Не загрузился — сначала data:-адрес, потом просто слово. */
  function emoteImg(q) {
    const img = el('img', { className: 'emo emote', src: q.url, alt: q.name, title: q.name, style: `height:${S().emoteSize}px` });
    let tried = false;
    img.addEventListener('error', () => {
      if (tried) return img.replaceWith(document.createTextNode(q.name));
      tried = true;
      fetchDataUrl(q.url).then((d) => (d ? (img.src = d) : img.replaceWith(document.createTextNode(q.name))));
    });
    return img;
  }

  /** Текст сообщения: слова-смайлики (имя в карте наборов) заменяются картинками, остальное — как есть. */
  function appendText(box, text) {
    const map = C.emotes;
    if (!map || !map.size) return box.append(text);
    for (const q of YFS.emotes.tokenize(text, map)) box.append(q.t === 'text' ? q.v : emoteImg(q));
  }

  /** Эмодзи — картинкой выбранного набора (с запасными адресами и системным символом в конце) или системным шрифтом. */
  function emojiNode(alt, origSrc) {
    const set = S().emojiSet;
    const size = S().emojiSize;
    const native = () => el('span', { className: 'emo-native', style: `font-size:${Math.round(size * 0.82)}px` }, alt);
    if (set === 'native') return native();
    if (set === 'youtube') return el('img', { className: 'emo', src: origSrc, alt, title: alt, style: `height:${size}px` });
    const urls = L.emojiUrls(set, alt);
    const img = el('img', { className: 'emo', alt, title: alt, style: `height:${size}px` });
    let i = 0;
    let viaBackground = false;
    img.addEventListener('error', () => {
      i++;
      if (i < urls.length) img.src = urls[i];
      else if (!viaBackground) {
        viaBackground = true;
        fetchDataUrl(urls[0]).then((d) => (d ? (img.src = d) : img.replaceWith(native())));
      } else img.replaceWith(native());
    });
    img.src = urls[0];
    return img;
  }

  function contentOf(e) {
    const box = el('span', { className: 'tx' });
    if (e.deleted) {
      box.className = 'tx deleted';
      box.append(tr('live.deleted'));
      return box;
    }
    for (const p of e.parts) {
      if (p.t === 'text') appendText(box, p.v);
      else if (p.t === 'link') box.append(el('a', { href: p.href, target: '_blank', rel: 'noopener noreferrer' }, p.v || p.href));
      else if (p.t === 'img') {
        if (L.isEmoji(p.alt)) box.append(emojiNode(p.alt, p.src));
        else box.append(el('img', { className: 'emo custom', src: p.src, alt: p.alt, title: p.alt, style: `height:${S().emojiSize + 4}px` }));
      }
    }
    if (!box.childNodes.length) box.append(e.text);
    return box;
  }

  // ---------- строки ленты ----------

  function paidRow(e) {
    const color = e.extra && e.extra.color ? e.extra.color : '#1e88e5';
    const card = el('div', { className: 'paid', 'data-id': e.id });
    card.style.setProperty('--pc', color);
    card.append(el('div', { className: 'ph' }, el('b', { className: 'pa' }, (e.extra && e.extra.amount) || '💰'), el('span', { className: 'pn' }, e.name)));
    if (e.text) card.append(el('div', { className: 'pt' }, contentOf(e)));
    return card;
  }

  function buildRow(e) {
    const s = S();
    if (e.type === 'paid' && s.paidInline) return paidRow(e);
    if (e.type === 'member' || e.type === 'paid') {
      const what = e.extra ? [e.extra.header, e.extra.amount].filter(Boolean).join(' · ') : '';
      return el('div', { className: 'sys member', 'data-id': e.id }, '⭐ ', el('b', {}, e.name || ''), what ? ' ' + what : '', e.text ? ' — ' + e.text : '');
    }
    if (e.type === 'system') return el('div', { className: 'sys', 'data-id': e.id }, e.text || (e.extra && e.extra.header) || '');
    const cls = ['msg'];
    if (e.mention && s.highlightMentions) cls.push('mention');
    else if (e.keyword) cls.push('keyword');
    if (s.watch.some((w) => L.nameKey(w) === e.key)) cls.push('watched');
    if (e.own) cls.push('own');
    const row = el('div', { className: cls.join(' '), 'data-id': e.id, 'data-key': e.key });
    if (s.timestamps !== 'hide' && e.label) row.append(el('span', { className: 'ts' }, e.label));
    if (s.showBadges && e.badges.length) {
      const bs = el('span', { className: 'badges' });
      for (const b of e.badges) bs.append(badgeEl(b));
      row.append(bs);
    }
    const nm = el('b', { className: 'nm', role: 'button', title: tr('live.quickReplyHint') }, e.name);
    nm.style.color = nameColor(e.name);
    row.append(nm, el('span', { className: 'colon' }, ':'), contentOf(e));
    return row;
  }

  const visible = (e) => {
    if (e.hidden) return false;
    if (view.thread === 'chat') return true;
    return e.type === 'text' && L.inThread(e, view.thread, S().watch);
  };

  // ---------- лента ----------

  const atBottom = () => ui.list.scrollHeight - ui.list.scrollTop - ui.list.clientHeight < 48;

  function renderPaused() {
    ui.paused.hidden = view.stick;
    if (!view.stick) ui.pausedText.textContent = view.pending ? tr('live.pausedNew', { n: view.pending }) : tr('live.paused');
  }

  function toBottom() {
    ui.list.scrollTop = ui.list.scrollHeight;
    view.stick = true;
    view.pending = 0;
    renderPaused();
  }

  function trim() {
    while (ui.list.children.length > ROWS_MAX) {
      const first = ui.list.firstElementChild;
      rows.delete(first.dataset.id);
      first.remove();
    }
  }

  function renderList() {
    rows.clear();
    ui.list.replaceChildren();
    const frag = document.createDocumentFragment();
    const items = C.feed.filter(visible).slice(-ROWS_MAX);
    items.forEach((e, i) => {
      const row = buildRow(e);
      if (S().alternate && i % 2) row.classList.add('alt');
      rows.set(e.id, row);
      frag.append(row);
    });
    ui.list.append(frag);
    if (!items.length) ui.list.append(el('p', { className: 'empty' }, view.thread === 'chat' ? tr('live.chatEmpty') : tr('live.miniWaiting')));
    toBottom();
  }

  function appendEntry(e) {
    const empty = ui.list.querySelector('.empty');
    if (empty) empty.remove();
    const row = buildRow(e);
    if (S().alternate && ui.list.children.length % 2) row.classList.add('alt');
    rows.set(e.id, row);
    ui.list.append(row);
    if (view.stick) {
      trim();
      ui.list.scrollTop = ui.list.scrollHeight;
    } else {
      view.pending++;
      renderPaused();
    }
  }

  // ---------- вкладки переписок ----------

  function tabsList() {
    const w = S().watch;
    const t = [{ id: 'chat', label: tr('live.chatTab') }];
    if (w.length > 1) t.push({ id: 'group', label: '👥 ' + tr('live.group') });
    for (const n of w) t.push({ id: L.nameKey(n), label: n, person: true });
    return t;
  }

  /** Узкая колонка людей слева (как в Discord): общий чат, группа и отдельные люди; круглые значки, у активного — квадрат с полоской. */
  const initial = (name) => ([...String(name || '?').replace(/^@+/, '')][0] || '?').toUpperCase();

  function renderTabs() {
    const tabs = tabsList();
    if (!tabs.some((t) => t.id === view.thread)) view.thread = 'chat';
    // Пока переписок нет, колонка не занимает место: «+» живёт в заголовке чата.
    ui.tabs.hidden = tabs.length < 2 && !view.adding;
    ui.headAdd.hidden = !ui.tabs.hidden;
    ui.tabs.replaceChildren();
    for (const t of tabs) {
      const on = t.id === view.thread;
      const b = el('button', { className: 'rb' + (on ? ' on' : '') + (t.person ? ' person' : ''), type: 'button', role: 'tab', 'aria-selected': String(on), title: t.label, 'aria-label': t.label }, t.person ? initial(t.label) : t.id === 'group' ? '👥' : '#');
      if (t.person) {
        const c = nameColor(t.label);
        b.style.background = c === 'inherit' ? 'var(--accent)' : c;
      }
      const n = view.unread[t.id] || 0;
      if (n && !on) b.append(el('span', { className: 'dot' }, n > 99 ? '99+' : String(n)));
      b.addEventListener('click', () => switchThread(t.id));
      if (t.person) {
        const x = el('span', { className: 'x', role: 'button', title: tr('live.unwatch'), 'aria-label': tr('live.unwatch') }, '✕');
        x.addEventListener('click', (ev) => {
          ev.stopPropagation();
          C.toggleWatch(t.label, false);
        });
        b.append(x);
      }
      ui.tabs.append(b);
    }
    const add = el('button', { className: 'rb add' + (view.adding ? ' on' : ''), type: 'button', title: tr('live.addThread'), 'aria-label': tr('live.addThread') }, svg('plus', 18));
    add.addEventListener('click', toggleAdding);
    ui.tabs.append(add);
    renderAdd();
    renderCompose();
  }

  function toggleAdding() {
    view.adding = !view.adding;
    renderTabs();
  }

  function switchThread(id) {
    if (view.thread === id) return;
    view.thread = id;
    view.unread[id] = 0;
    renderTabs();
    renderList();
    ui.input.focus();
  }

  /** «+»: ввести ник человека (с подсказкой по тем, кто писал) — для него появится своя вкладка. */
  function renderAdd() {
    ui.add.hidden = !view.adding;
    if (!view.adding) return;
    ui.addInput.placeholder = tr('live.addThreadPh');
    renderAddList();
    if (!ui.root.activeElement) ui.addInput.focus();
  }

  function renderAddList() {
    const names = L.suggestNames(recentNames(), ui.addInput.value, 8);
    ui.addList.replaceChildren(
      ...names.map((n) => {
        const b = el('button', { type: 'button', className: 'sg' }, n);
        b.style.color = nameColor(n);
        b.addEventListener('click', () => {
          view.adding = false;
          C.toggleWatch(n, true);
        });
        return b;
      })
    );
  }

  function recentNames() {
    const out = [];
    const seen = new Set();
    for (let i = C.feed.length - 1; i >= 0 && out.length < 80; i--) {
      const e = C.feed[i];
      if (e.type !== 'text' || !e.name || e.own || seen.has(e.key)) continue;
      seen.add(e.key);
      out.push(e.name);
    }
    return out;
  }

  // ---------- поле ввода ----------

  const placeholder = () => {
    if (view.thread === 'chat') return tr('live.inputPh');
    if (view.thread === 'group') return tr('live.miniPh');
    const who = S().watch.find((n) => L.nameKey(n) === view.thread);
    return tr('live.replyTo', { name: who || '' });
  };

  function renderCompose() {
    const can = C.canSend;
    ui.input.placeholder = can ? placeholder() : tr('live.needLogin');
    ui.input.disabled = !can;
    ui.send.disabled = !can;
    ui.emojiBtn.disabled = !can;
    // Над полем: кому уйдёт сообщение.
    const w = S().watch;
    if (view.thread === 'chat') ui.to.hidden = true;
    else {
      ui.to.hidden = false;
      ui.to.replaceChildren();
      if (view.thread === 'group') {
        const sw = el('button', { className: 'pill' + (S().groupMention ? ' on' : ''), type: 'button', title: tr('live.groupMentionHint') }, '👥 ' + (S().groupMention ? w.slice(0, 5).map((n) => '@' + n).join(' ') : tr('live.groupNoMention')));
        sw.addEventListener('click', () => C.save({ groupMention: !S().groupMention }));
        ui.to.append(sw);
      } else {
        const who = w.find((n) => L.nameKey(n) === view.thread);
        ui.to.append(el('span', { className: 'pill on' }, '↩ @' + (who || '')));
      }
    }
    autoGrow();
    renderCount();
  }

  function renderCount() {
    const n = ui.input.value.length;
    ui.count.textContent = `${n}/200`;
    ui.count.hidden = n < 120;
    ui.count.classList.toggle('over', n >= 200);
  }

  function autoGrow() {
    ui.input.style.height = 'auto';
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, 96)}px`;
  }

  function insertAtCaret(text) {
    const t = ui.input;
    const a = t.selectionStart ?? t.value.length;
    const b = t.selectionEnd ?? t.value.length;
    t.value = t.value.slice(0, a) + text + t.value.slice(b);
    t.selectionStart = t.selectionEnd = a + text.length;
    t.focus();
    autoGrow();
    renderCount();
    updateSuggest();
  }

  function send() {
    const raw = ui.input.value.replace(/\s+/g, ' ').trim();
    if (!raw) return;
    const text = L.composeText(raw, view.thread, S().watch, S().groupMention);
    C.registerSend(text, view.thread);
    if (C.sendToChat(text)) {
      ui.input.value = '';
      autoGrow();
      renderCount();
      closeSuggest();
      setTimeout(toBottom, 250);
    }
  }

  // ---------- подсказка ников по «@» ----------

  function updateSuggest() {
    const q = L.mentionQuery(ui.input.value, ui.input.selectionStart ?? 0);
    if (!q) return closeSuggest();
    view.suggest = L.suggestNames(recentNames(), q.query, 6);
    view.suggestIdx = 0;
    view.suggestStart = q.start;
    renderSuggest();
  }

  function renderSuggest() {
    ui.suggest.hidden = !view.suggest.length;
    ui.suggest.replaceChildren(
      ...view.suggest.map((n, i) => {
        const b = el('button', { type: 'button', className: 'sg' + (i === view.suggestIdx ? ' on' : '') }, '@' + n);
        b.style.color = nameColor(n);
        b.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          view.suggestIdx = i;
          acceptSuggest();
        });
        return b;
      })
    );
  }

  function closeSuggest() {
    view.suggest = [];
    ui.suggest.hidden = true;
  }

  function acceptSuggest() {
    const n = view.suggest[view.suggestIdx];
    if (!n) return;
    const t = ui.input;
    const caret = t.selectionStart ?? t.value.length;
    t.value = t.value.slice(0, view.suggestStart) + '@' + n + ' ' + t.value.slice(caret);
    t.selectionStart = t.selectionEnd = view.suggestStart + n.length + 2;
    closeSuggest();
    autoGrow();
    renderCount();
    t.focus();
  }

  // ---------- эмодзи ----------

  /** Окно выбора: вкладка «Эмодзи» (в выбранном наборе) и «Смайлики» (из 7TV / BTTV / FFZ, с поиском). */
  function renderEmoji() {
    ui.emojiBox.hidden = !view.emoji;
    if (!view.emoji) return;
    const emotes = C.emotes;
    const hasEmotes = !!emotes && emotes.size > 0;
    if (view.pick === 'emotes' && !hasEmotes) view.pick = 'emoji';
    const tab = (id, label) => {
      const b = el('button', { type: 'button', className: 'pk' + (view.pick === id ? ' on' : '') }, label);
      b.addEventListener('click', () => {
        view.pick = id;
        renderEmoji();
      });
      return b;
    };
    const grid = el('div', { className: 'pk-grid' });
    const head = el('div', { className: 'pk-tabs' }, tab('emoji', '😀 ' + tr('live.emoji.tab')), hasEmotes ? tab('emotes', tr('live.emotes.tab', { n: emotes.size })) : null);
    ui.emojiBox.replaceChildren(head);
    if (view.pick === 'emotes') {
      const search = el('input', { type: 'text', className: 'pk-search', placeholder: tr('live.emotes.search'), spellcheck: false });
      const fill = () => {
        const q = search.value.trim().toLowerCase();
        grid.replaceChildren();
        let n = 0;
        for (const [name, e] of emotes) {
          if (q && !name.toLowerCase().includes(q)) continue;
          const b = el('button', { type: 'button', className: 'eb wide', title: name, 'aria-label': name });
          b.append(emoteImg({ name, url: e.url }));
          b.addEventListener('click', () => insertAtCaret(name + ' '));
          grid.append(b);
          if (++n >= 300) break;
        }
      };
      search.addEventListener('input', fill);
      search.addEventListener('keydown', (ev) => ev.stopPropagation());
      ui.emojiBox.append(search, grid);
      fill();
      return;
    }
    const set = S().emojiSet;
    for (const e of EMOJI) {
      const b = el('button', { type: 'button', className: 'eb', title: e, 'aria-label': e });
      if (set === 'youtube' || set === 'native') b.append(el('span', { className: 'emo-native' }, e));
      else {
        const urls = L.emojiUrls(set, e);
        const img = el('img', { alt: e, loading: 'lazy', src: urls[0] });
        let i = 0;
        img.addEventListener('error', () => (++i < urls.length ? (img.src = urls[i]) : img.replaceWith(e)));
        b.append(img);
      }
      b.addEventListener('click', () => insertAtCaret(e));
      grid.append(b);
    }
    ui.emojiBox.append(grid);
  }

  // ---------- кнопки при наведении ----------

  function showTools(row) {
    const key = row.dataset.key;
    if (!key) return;
    const e = C.feed.find((x) => x.id === row.dataset.id);
    if (!e) return;
    const tb = ui.tools;
    const watched = S().watch.some((n) => L.nameKey(n) === key);
    tb.replaceChildren();
    const add = (icon, title, fn) => {
      const b = el('button', { type: 'button', title, 'aria-label': title }, icon);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
      });
      tb.append(b);
    };
    add('↩', tr('live.reply'), () => reply(e.name));
    add(watched ? '💬✓' : '💬', tr(watched ? 'live.openThread' : 'live.watch'), () => {
      if (!watched) C.toggleWatch(e.name, true);
      else switchThread(key);
    });
    add('📋', tr('live.copy'), () => C.copyName(e.name));
    add('👤', tr('live.card'), () => C.openCard(e.name, row));
    if (!e.own) add('🚫', tr('live.hide'), () => C.hideUser(e.name, true));
    row.append(tb);
  }

  function reply(name) {
    if (!C.canSend) return C.toast(tr('live.noInput'));
    const t = ui.input;
    const before = t.value;
    const mention = '@' + name.replace(/^@+/, '') + ' ';
    if (before.includes(mention)) return t.focus();
    t.value = (before && !/\s$/.test(before) ? before + ' ' : before) + mention;
    t.focus();
    t.selectionStart = t.selectionEnd = t.value.length;
    autoGrow();
    renderCount();
  }

  // ---------- каркас ----------

  const CSS = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483000; display: block;
      --bg: #18181b; --bg2: #26262c; --text: #efeff1; --muted: #adadb8; --line: rgba(255,255,255,.1); --hover: rgba(255,255,255,.07); --input: rgba(255,255,255,.1);
      --accent: #9147ff; --accent-h: #772ce8; --warn: #ffaa00; font: 13px/20px 'Segoe UI', Inter, 'Helvetica Neue', Roboto, Arial, sans-serif; color: var(--text); }
    :host([light]) { --bg: #ffffff; --bg2: #f1f1f4; --text: #0e0e10; --muted: #53535f; --line: rgba(0,0,0,.12); --hover: rgba(0,0,0,.06); --input: rgba(0,0,0,.07); }
    * { box-sizing: border-box; }
    button, textarea, input { font: inherit; color: inherit; }
    button { cursor: pointer; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .tw { display: flex; flex-direction: column; height: 100%; background: var(--bg); }
    .head { position: relative; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; height: 46px; border-bottom: 1px solid var(--line); }
    .head b { font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .body { display: flex; flex: 1 1 auto; min-height: 0; }
    .col { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
    .rail { display: flex; flex: 0 0 56px; flex-direction: column; align-items: center; gap: 8px; padding: 8px 0; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; border-right: 1px solid var(--line); background: var(--bg2); }
    .rail[hidden] { display: none; }
    .rb { position: relative; display: grid; flex: 0 0 auto; place-items: center; width: 38px; height: 38px; padding: 0; border: 0; border-radius: 50%; background: var(--hover); color: var(--text); font-size: 15px; font-weight: 700; transition: border-radius .15s, background-color .15s; }
    .rb:hover, .rb.on { border-radius: 12px; }
    .rb:not(.person):hover, .rb:not(.person).on { background: var(--accent); color: #fff; }
    .rb.person { color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.55); }
    .rb.on::before { content: ''; position: absolute; left: -9px; top: 9px; bottom: 9px; width: 4px; border-radius: 0 4px 4px 0; background: var(--text); }
    .rb.add { border: 1px dashed var(--muted); background: transparent; color: var(--muted); }
    .rb .dot { position: absolute; right: -5px; bottom: -4px; min-width: 18px; height: 18px; padding: 0 5px; border: 2px solid var(--bg2); border-radius: 9px; background: #e91916; color: #fff; font-size: 10px; line-height: 14px; text-align: center; text-shadow: none; }
    .rb .x { position: absolute; right: -5px; top: -5px; display: none; width: 18px; height: 18px; border: 1px solid var(--line); border-radius: 50%; background: var(--bg); color: var(--muted); font-size: 9px; line-height: 16px; text-align: center; text-shadow: none; }
    .rb:hover .x { display: block; }
    .rb .x:hover { background: var(--line); color: var(--text); }
    .head .hadd { position: absolute; left: 8px; top: 50%; display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 1px dashed var(--muted); border-radius: 50%; background: transparent; color: var(--muted); transform: translateY(-50%); }
    .head .hadd:hover { border-color: var(--accent); color: var(--text); }
    .head .hadd[hidden] { display: none; }
    .addbox { flex: 0 0 auto; padding: 8px; border-bottom: 1px solid var(--line); background: var(--bg2); }
    .addbox[hidden] { display: none; }
    .addbox input { width: 100%; height: 32px; padding: 0 10px; border: 2px solid transparent; border-radius: 6px; background: var(--input); }
    .addbox input:focus { border-color: var(--accent); outline: 0; }
    .sgl { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .sg { padding: 3px 10px; border: 0; border-radius: 12px; background: var(--hover); font-weight: 600; }
    .sg:hover, .sg.on { background: var(--accent); color: #fff !important; }
    .listwrap { position: relative; flex: 1 1 auto; min-height: 0; }
    .list { position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain; padding: 6px 0 8px; scrollbar-width: thin; scrollbar-color: var(--line) transparent; font-size: var(--fs, 13px); }
    .msg { position: relative; padding: 4px 14px 4px 12px; border-left: 3px solid transparent; overflow-wrap: anywhere; line-height: 1.5; }
    .msg:hover { background: var(--hover); }
    .msg.alt { background: var(--hover); }
    .msg.mention { border-left-color: var(--warn); background: rgba(255,170,0,.13); }
    .msg.keyword { border-left-color: #3ea6ff; background: rgba(62,166,255,.12); }
    .msg.watched { border-left-color: #2ba640; }
    .compact .msg { padding-top: 1px; padding-bottom: 1px; }
    .ts { margin-right: 6px; color: var(--muted); font-size: .85em; font-variant-numeric: tabular-nums; }
    .badges { display: inline-flex; gap: 3px; margin-right: 4px; vertical-align: -3px; }
    .badge { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 3px; object-fit: contain; }
    .nm { font-weight: 700; cursor: pointer; }
    .nm:hover { text-decoration: underline; }
    .colon { margin-right: 5px; }
    .tx a { color: #a970ff; }
    .tx.deleted { color: var(--muted); font-style: italic; }
    .emo { display: inline-block; vertical-align: middle; margin: -3px 1px; object-fit: contain; }
    .emo-native { vertical-align: middle; line-height: 1; font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif; }
    .sys { padding: 4px 14px; color: var(--muted); font-style: italic; }
    .sys.member { margin: 3px 0; border-left: 3px solid #9147ff; background: rgba(145,71,255,.12); color: var(--text); font-style: normal; }
    .paid { margin: 5px 10px; padding: 8px 10px; border-left: 4px solid var(--pc); border-radius: 6px; background: color-mix(in srgb, var(--pc) 18%, transparent); }
    .paid .ph { display: flex; align-items: baseline; gap: 8px; }
    .paid .pa { font-size: 1.1em; }
    .paid .pn { color: var(--muted); font-weight: 600; }
    .paid .pt { margin-top: 2px; }
    .empty { margin: 24px 16px; color: var(--muted); text-align: center; }
    .tools { position: absolute; top: -12px; right: 8px; z-index: 5; display: flex; gap: 1px; padding: 2px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg2); box-shadow: 0 2px 8px rgba(0,0,0,.35); font-style: normal; }
    .tools button { height: 26px; min-width: 28px; padding: 0 5px; border: 0; border-radius: 4px; background: transparent; font-size: 13px; }
    .tools button:hover { background: var(--accent); color: #fff; }
    .paused { position: absolute; left: 12px; right: 12px; bottom: 8px; z-index: 6; display: flex; align-items: center; justify-content: center; gap: 8px; height: 36px; border: 0; border-radius: 6px; background: rgba(24,24,27,.94); color: #fff; font-weight: 600; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
    .paused[hidden] { display: none; }
    .paused:hover { background: var(--accent); }
    .compose { position: relative; flex: 0 0 auto; padding: 8px 12px 12px; }
    .to { display: flex; margin: 0 0 6px; }
    .to[hidden] { display: none; }
    .pill { display: inline-block; max-width: 100%; overflow: hidden; padding: 2px 10px; border: 0; border-radius: 12px; background: var(--hover); color: var(--muted); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .pill.on { background: rgba(145,71,255,.22); color: var(--text); }
    .field { position: relative; }
    textarea { display: block; width: 100%; min-height: 36px; max-height: 96px; padding: 7px 40px 7px 10px; border: 2px solid transparent; border-radius: 6px; resize: none; background: var(--input); line-height: 18px; }
    textarea:hover { border-color: var(--line); }
    textarea:focus { border-color: var(--accent); background: transparent; outline: 0; }
    textarea:disabled { opacity: .7; cursor: not-allowed; }
    .emo-btn { position: absolute; right: 4px; bottom: 4px; display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); }
    .emo-btn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
    .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .grow { flex: 1; }
    .icon { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); }
    .icon:hover { background: var(--hover); color: var(--text); }
    .count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .count.over { color: #ff4d4d; }
    .count[hidden] { display: none; }
    .send { height: 30px; padding: 0 14px; border: 0; border-radius: 4px; background: var(--accent); color: #fff; font-weight: 600; }
    .send:hover:not(:disabled) { background: var(--accent-h); }
    .send:disabled { opacity: .5; cursor: not-allowed; }
    .suggest { position: absolute; left: 12px; right: 12px; bottom: 100%; z-index: 8; display: flex; flex-direction: column; padding: 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg2); box-shadow: 0 -4px 14px rgba(0,0,0,.35); }
    .suggest[hidden] { display: none; }
    .suggest .sg { border-radius: 4px; background: transparent; text-align: left; }
    .emojibox { position: absolute; left: 12px; right: 12px; bottom: 100%; z-index: 8; display: flex; flex-direction: column; max-height: 280px; padding: 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg2); box-shadow: 0 -4px 14px rgba(0,0,0,.35); }
    .pk-tabs { display: flex; gap: 4px; margin-bottom: 6px; }
    .pk { height: 28px; padding: 0 10px; border: 0; border-radius: 14px; background: transparent; color: var(--muted); font-weight: 600; }
    .pk:hover { background: var(--hover); color: var(--text); }
    .pk.on { background: var(--accent); color: #fff; }
    .pk-search { width: 100%; height: 30px; margin-bottom: 6px; padding: 0 10px; border: 2px solid transparent; border-radius: 6px; background: var(--input); }
    .pk-search:focus { border-color: var(--accent); outline: 0; }
    .pk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(34px, 1fr)); gap: 2px; overflow-y: auto; min-height: 0; }
    .eb.wide { height: 40px; }
    .eb.wide img { width: auto; max-width: 100%; height: 28px; }
    .emote { margin: -4px 2px; }
    .emojibox[hidden] { display: none; }
    .eb { display: grid; place-items: center; height: 34px; border: 0; border-radius: 4px; background: transparent; font-size: 22px; }
    .eb:hover { background: var(--hover); }
    .eb img { width: 24px; height: 24px; }
  `;

  function build() {
    const host = document.createElement('div');
    host.id = 'yfs-twitch';
    const root = host.attachShadow({ mode: 'open' });
    const e = {};
    e.title = el('b', {}, tr('live.chatTitle'));
    e.tabs = el('div', { className: 'rail', role: 'tablist', 'aria-orientation': 'vertical', hidden: true });
    e.headAdd = el('button', { className: 'hadd', type: 'button', title: tr('live.addThread'), 'aria-label': tr('live.addThread') }, svg('plus', 16));
    e.headAdd.addEventListener('click', toggleAdding);
    e.addInput = el('input', { type: 'text', autocomplete: 'off', spellcheck: false });
    e.addList = el('div', { className: 'sgl' });
    e.add = el('div', { className: 'addbox', hidden: true }, e.addInput, e.addList);
    e.list = el('div', { className: 'list', role: 'log', 'aria-live': 'off', tabIndex: 0 });
    e.pausedText = el('span', {});
    e.paused = el('button', { className: 'paused', type: 'button', hidden: true }, svg('down', 18), e.pausedText);
    e.tools = el('div', { className: 'tools' });
    e.to = el('div', { className: 'to', hidden: true });
    e.input = el('textarea', { rows: 1, maxLength: 200, spellcheck: true, 'aria-label': tr('live.inputPh') });
    e.emojiBtn = el('button', { className: 'emo-btn', type: 'button', title: tr('live.emoji'), 'aria-label': tr('live.emoji') }, svg('smile', 20));
    e.emojiBox = el('div', { className: 'emojibox', hidden: true });
    e.suggest = el('div', { className: 'suggest', hidden: true, role: 'listbox' });
    e.gear = el('button', { className: 'icon', type: 'button', title: tr('live.settings'), 'aria-label': tr('live.settings') }, svg('gear', 22));
    e.count = el('span', { className: 'count', hidden: true });
    e.send = el('button', { className: 'send', type: 'button' }, tr('live.sendBtn'));
    e.compose = el('div', { className: 'compose' }, e.suggest, e.emojiBox, e.to, el('div', { className: 'field' }, e.input, e.emojiBtn), el('div', { className: 'row' }, e.gear, el('span', { className: 'grow' }), e.count, e.send));
    const wrap = el('div', { className: 'tw' }, el('div', { className: 'head' }, e.headAdd, e.title), el('div', { className: 'body' }, e.tabs, el('div', { className: 'col' }, e.add, el('div', { className: 'listwrap' }, e.list, e.paused), e.compose)));
    root.append(el('style', { textContent: CSS }), wrap);
    ui = { host, root, wrap, ...e };

    e.list.addEventListener('scroll', () => {
      view.stick = atBottom();
      if (view.stick) view.pending = 0;
      renderPaused();
    });
    e.paused.addEventListener('click', toBottom);
    e.list.addEventListener('mouseover', (ev) => {
      const row = ev.target.closest && ev.target.closest('.msg');
      if (row && row.querySelector('.tools') !== e.tools) showTools(row);
    });
    e.list.addEventListener('click', (ev) => {
      const nm = ev.target.closest && ev.target.closest('.nm');
      if (!nm) return;
      const row = nm.closest('.msg');
      const entry = C.feed.find((x) => x.id === row.dataset.id);
      if (!entry) return;
      if (ev.ctrlKey || ev.metaKey) C.copyName(entry.name);
      else if (ev.altKey) C.openCard(entry.name, row);
      else if (S().quickReply) reply(entry.name);
    });
    e.input.addEventListener('input', () => {
      autoGrow();
      renderCount();
      updateSuggest();
    });
    e.input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (view.suggest.length && !ev.isComposing) {
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          view.suggestIdx = (view.suggestIdx + (ev.key === 'ArrowDown' ? 1 : view.suggest.length - 1)) % view.suggest.length;
          return renderSuggest();
        }
        if (ev.key === 'Tab' || ev.key === 'Enter') {
          ev.preventDefault();
          return acceptSuggest();
        }
        if (ev.key === 'Escape') {
          ev.preventDefault();
          return closeSuggest();
        }
      }
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        send();
      }
    });
    for (const t of ['keyup', 'keypress']) e.input.addEventListener(t, (ev) => ev.stopPropagation());
    e.input.addEventListener('blur', () => setTimeout(closeSuggest, 120));
    e.send.addEventListener('click', send);
    e.emojiBtn.addEventListener('click', () => {
      view.emoji = !view.emoji;
      renderEmoji();
    });
    e.gear.addEventListener('click', () => C.toggleSettings());
    e.addInput.addEventListener('input', renderAddList);
    e.addInput.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && ev.target.value.trim()) {
        view.adding = false;
        C.toggleWatch(ev.target.value.trim(), true);
        ev.target.value = '';
      } else if (ev.key === 'Escape') {
        view.adding = false;
        renderTabs();
      }
    });
    return ui;
  }

  function applyLook() {
    const s = S();
    ui.host.toggleAttribute('light', !dark());
    ui.list.style.setProperty('--fs', `${s.fontSize}px`);
    ui.wrap.classList.toggle('compact', !!s.compact);
    ui.title.textContent = tr('live.chatTitle');
    ui.gear.title = tr('live.settings');
  }

  function fullRender() {
    applyLook();
    renderTabs();
    renderList();
    renderEmoji();
  }

  // ---------- события от livechat.js ----------

  function onEvent(type, entry) {
    if (!ui || !ui.host.isConnected) return;
    if (type === 'reset') {
      ui.emojiBox.replaceChildren();
      return fullRender();
    }
    if (type === 'update') {
      const row = rows.get(entry.id);
      if (row) {
        const fresh = buildRow(entry);
        row.replaceWith(fresh);
        rows.set(entry.id, fresh);
      }
      return;
    }
    if (!entry.hidden && entry.type === 'text' && !entry.own && Date.now() - START > 3000) {
      let changed = false;
      for (const t of tabsList()) {
        if (t.id !== 'chat' && t.id !== view.thread && L.inThread(entry, t.id, S().watch)) {
          view.unread[t.id] = (view.unread[t.id] || 0) + 1;
          changed = true;
        }
      }
      if (changed) {
        const adding = view.adding;
        renderTabs();
        view.adding = adding;
      }
    }
    if (visible(entry)) appendEntry(entry);
  }

  // ---------- включение и выключение ----------

  function attach() {
    const on = document.documentElement.hasAttribute('yfs-tw');
    if (on && !(ui && ui.host.isConnected)) {
      if (!ui) build();
      (document.body || document.documentElement).append(ui.host);
      fullRender();
    } else if (!on && ui && ui.host.isConnected) ui.host.remove();
    if (on && ui) {
      ui.host.toggleAttribute('light', !dark());
      renderCompose();
    }
  }

  function start() {
    C = YFS.liveChat;
    if (!C) return;
    C.subscribe(onEvent);
    setInterval(() => {
      try {
        if (!chrome.runtime.id) throw new Error('gone');
      } catch {
        if (ui) ui.host.remove();
        return;
      }
      attach();
    }, 700);
    attach();
  }

  YFS.i18n.onChange(() =>
    YFS.i18n.init({ applyToPage: false }).then(() => {
      if (ui) ui.host.remove();
      ui = null;
      attach();
    })
  );
  if (YFS.liveChat) start();
  else document.addEventListener('yfs:livechat-ready', start, { once: true });
})();
