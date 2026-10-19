/*
 * 🐈 × 10 = 🚀 PRO.
 * Пасхалка: «Upgrade to Pro» ничего не продаёт — нужно 10 раз погладить котика.
 * Никаких платежей и сетевых запросов, только SVG и CSS-анимации.
 */
(function (root) {
  'use strict';

  const GOAL = 10;
  const tr = (k, p) => root.YFS.i18n.t(k, p);
  // Строки из словарей — свои, но всё равно экранируем перед вставкой в разметку.
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const message = (n) => tr('pro.msg.' + Math.min(n, GOAL));
  const ENCORE_COUNT = 8;

  // Статичная разметка без пользовательских данных — innerHTML здесь безопасен.
  const CAT_SVG = `
<svg class="cat" viewBox="0 0 200 200" aria-hidden="true">
  <path class="cat-tail" d="M150 160 C 190 150, 195 105, 170 95" fill="none" stroke="#e8902a" stroke-width="14" stroke-linecap="round"/>
  <ellipse cx="100" cy="158" rx="56" ry="36" fill="#f4a340"/>
  <ellipse cx="78" cy="188" rx="15" ry="9" fill="#f7b866"/>
  <ellipse cx="122" cy="188" rx="15" ry="9" fill="#f7b866"/>
  <g class="cat-head">
    <path d="M58 70 L66 22 L98 52 Z" fill="#f4a340"/>
    <path d="M142 70 L134 22 L102 52 Z" fill="#f4a340"/>
    <path d="M66 62 L70 34 L88 52 Z" fill="#f7a8b8"/>
    <path d="M134 62 L130 34 L112 52 Z" fill="#f7a8b8"/>
    <circle cx="100" cy="92" r="50" fill="#f4a340"/>
    <path d="M86 46 q4 10 0 18 M100 43 q4 10 0 20 M114 46 q4 10 0 18" stroke="#e0821f" stroke-width="4" fill="none" stroke-linecap="round"/>
    <g class="eyes-open">
      <ellipse cx="80" cy="90" rx="8" ry="10" fill="#2b2b2b"/>
      <ellipse cx="120" cy="90" rx="8" ry="10" fill="#2b2b2b"/>
      <circle cx="83" cy="86" r="3" fill="#fff"/>
      <circle cx="123" cy="86" r="3" fill="#fff"/>
    </g>
    <g class="eyes-happy" fill="none" stroke="#2b2b2b" stroke-width="4" stroke-linecap="round">
      <path d="M70 92 q10 -12 20 0"/>
      <path d="M110 92 q10 -12 20 0"/>
    </g>
    <g class="shades">
      <path d="M62 82 h32 a4 4 0 0 1 4 4 v4 a12 12 0 0 1 -12 12 h-12 a12 12 0 0 1 -12 -12 z" fill="#111"/>
      <path d="M106 82 h32 v8 a12 12 0 0 1 -12 12 h-12 a12 12 0 0 1 -12 -12 v-4 a4 4 0 0 1 4 -4 z" fill="#111"/>
      <path d="M94 86 h12" stroke="#111" stroke-width="4"/>
      <path d="M68 86 l10 0" stroke="#fff" stroke-width="2" opacity=".5"/>
    </g>
    <ellipse class="blush" cx="70" cy="108" rx="9" ry="5" fill="#ff7a9a"/>
    <ellipse class="blush" cx="130" cy="108" rx="9" ry="5" fill="#ff7a9a"/>
    <path d="M95 104 h10 l-5 6 z" fill="#ff7a9a"/>
    <path d="M100 110 q-6 8 -12 2 M100 110 q6 8 12 2" fill="none" stroke="#2b2b2b" stroke-width="3" stroke-linecap="round"/>
    <path d="M54 100 h-26 M54 108 l-24 6 M146 100 h26 M146 108 l24 6" stroke="#8a5a1f" stroke-width="2" stroke-linecap="round"/>
  </g>
</svg>`;

  let dlg = null;
  let count = 0;
  let extra = 0;
  let options = {};

  function q(sel) {
    return dlg.querySelector(sel);
  }

  function heart(stage) {
    const h = document.createElement('span');
    h.className = 'pro-heart';
    h.textContent = ['♥', '♥', '💕', '✨'][Math.floor(Math.random() * 4)];
    h.style.left = 30 + Math.random() * 40 + '%';
    h.style.setProperty('--drift', (Math.random() * 60 - 30).toFixed(0) + 'px');
    stage.append(h);
    setTimeout(() => h.remove(), 1300);
  }

  function confetti() {
    const box = document.createElement('div');
    box.className = 'pro-confetti';
    const colors = ['#ff0033', '#ff7a00', '#ffd400', '#2ba640', '#3ea6ff', '#c45cff'];
    for (let i = 0; i < 60; i++) {
      const c = document.createElement('i');
      c.style.left = Math.random() * 100 + '%';
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = (Math.random() * 0.6).toFixed(2) + 's';
      c.style.setProperty('--spin', (Math.random() * 720 - 360).toFixed(0) + 'deg');
      box.append(c);
    }
    dlg.append(box);
    setTimeout(() => box.remove(), 3000);
  }

  function setMood(cat, n) {
    cat.classList.toggle('happy', n >= 3);
    cat.classList.toggle('blushing', n >= 5);
    cat.classList.toggle('purring', n >= 7);
  }

  function bounce(cat) {
    cat.classList.remove('petted');
    void cat.getBoundingClientRect(); // перезапуск анимации
    cat.classList.add('petted');
  }

  function renderPetting() {
    dlg.innerHTML = `
      <div class="pro-box">
        <div class="pro-title" id="proTitle">YFS PRO™</div>
        <p class="pro-sub">${esc(tr('pro.howTo', { n: GOAL }))}</p>
        <div class="pro-stage">${CAT_SVG}</div>
        <p class="pro-msg" aria-live="polite"></p>
        <button class="pill primary pro-pet" type="button">${esc(tr('pro.pet'))}</button>
        <div class="pro-progress"><div class="pro-progress-fill"></div></div>
        <div class="pro-count">0 / ${GOAL}</div>
        <button class="icon-btn pro-close" type="button" data-close aria-label="${esc(tr('common.close'))}">✕</button>
      </div>`;
    const cat = q('.cat');
    const update = () => {
      q('.pro-msg').textContent = message(count);
      q('.pro-count').textContent = `${Math.min(count, GOAL)} / ${GOAL}`;
      q('.pro-progress-fill').style.width = (Math.min(count, GOAL) / GOAL) * 100 + '%';
      setMood(cat, count);
    };
    const pet = () => {
      if (count >= GOAL) return;
      count++;
      bounce(cat);
      heart(q('.pro-stage'));
      if (count >= 7) heart(q('.pro-stage'));
      update();
      if (count === GOAL) {
        if (options.onActivated) options.onActivated();
        q('.pro-pet').disabled = true;
        setTimeout(renderUnlocked, 900);
      }
    };
    q('.pro-pet').addEventListener('click', pet);
    q('.pro-stage').addEventListener('click', pet);
    update();
  }

  function renderUnlocked() {
    if (!dlg.open) return;
    dlg.innerHTML = `
      <div class="pro-box">
        <div class="pro-title big" id="proTitle">🎉 PRO UNLOCKED</div>
        <p class="pro-sub">${esc(tr('pro.congrats'))}<br>${esc(tr('pro.youAre'))} <b>YouTube Feed Share PRO</b>.</p>
        <div class="pro-stage">${CAT_SVG}</div>
        <ul class="pro-perks">
          <li>${esc(tr('pro.perk1'))}</li>
          <li>${esc(tr('pro.perk2'))}</li>
          <li>${esc(tr('pro.perk3'))}</li>
          <li>${esc(tr('pro.perk4'))}</li>
        </ul>
        <button class="pill primary" type="button" data-close>${esc(tr('pro.continue'))}</button>
      </div>`;
    q('.cat').classList.add('cool', 'happy');
    confetti();
  }

  function renderActive() {
    dlg.innerHTML = `
      <div class="pro-box">
        <div class="pro-title" id="proTitle">🐈 PRO</div>
        <p class="pro-sub">${esc(tr('pro.activeThanks'))}</p>
        <div class="pro-stage">${CAT_SVG}</div>
        <p class="pro-sub muted">${esc(tr('pro.noIdea'))}<br>${esc(tr('pro.butWorks'))}</p>
        <p class="pro-msg" aria-live="polite"></p>
        <div class="pro-row">
          <button class="pill pro-pet" type="button">${esc(tr('pro.petMore'))}</button>
          <button class="pill primary" type="button" data-close>${esc(tr('common.close'))}</button>
        </div>
        <button class="icon-btn pro-close" type="button" data-close aria-label="${esc(tr('common.close'))}">✕</button>
      </div>`;
    const cat = q('.cat');
    cat.classList.add('cool', 'happy');
    const pet = () => {
      extra++;
      bounce(cat);
      heart(q('.pro-stage'));
      q('.pro-msg').textContent =
        extra === 37 ? tr('pro.reached37') : `${tr('pro.encore.' + (extra % ENCORE_COUNT))} · ${tr('pro.extra', { n: extra })}`;
      cat.classList.toggle('purring', extra >= 3);
    };
    q('.pro-pet').addEventListener('click', pet);
    q('.pro-stage').addEventListener('click', pet);
  }

  /** open({ active, onActivated }) — показать окно PRO. */
  function open(opts) {
    options = opts || {};
    dlg = document.getElementById('proDlg');
    count = 0;
    if (options.active) renderActive();
    else renderPetting();
    if (!dlg.open) dlg.showModal();
  }

  root.YFS = root.YFS || {};
  root.YFS.pro = { open };
})(typeof globalThis !== 'undefined' ? globalThis : this);
