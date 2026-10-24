/*
 * 🎧 Аудио-режим на странице ролика youtube.com.
 *
 * Поверх всей страницы — экран «как в музыкальном приложении»: по центру текст, который идёт вместе со звуком
 * (текущая строка подсвечена и сама прокручивается, клик по строке — перемотка), внизу полоса плеера:
 * обложка, название, канал, перемотка и свои кнопки (пауза, ±10 с, громкость, скорость, таймер сна).
 * Если играет очередь (плейлист, «🎵 Слушать подряд») — кнопки «предыдущий / следующий трек» и «Далее: …».
 * Если ролик — музыка, блок «🎵 Найти трек»: тот же трек на Spotify, Apple Music, Яндекс Музыке и т. д.
 * Для музыки сразу открывается вкладка «Песня». Очередь треков (своя очередь расширения без лимита в 50 треков,
 * а если её нет — панель плейлиста YouTube) выезжает справа по кнопке «☰ Очередь»: клик по строке — перейти к треку,
 * 🔀 — перемешать то, что ещё не играло, ✨ — выстроить порядок с помощью Gemini.
 * Сверху три вкладки: «Текст» (расшифровка), «🎵 Песня» (текст песни из LRCLIB и lyrics.ovh — с тайм-кодами
 * или с приблизительной прокруткой по длине трека) и «⚡ План» (разметка СДВГ-режима: что смотреть, ускорять, пропускать).
 * Разметка плана нарисована и на шкале перемотки в полосе плеера, и слева от строк текста.
 *
 * Плеер YouTube и рекомендации скрыты, звук играет как обычно. Качество видео на это время
 * снижается до минимального (видео всё равно не видно — меньше трафика и нагрузки).
 * Режим переживает переход на следующий ролик и перезагрузку вкладки (sessionStorage).
 * Клавиши: пробел/K — пауза, ←/J и →/L — 10 секунд, ↑/↓ — громкость, M — без звука,
 * Shift+N / Shift+P — следующий / предыдущий трек, Esc — вернуть видео.
 */
(function () {
  'use strict';
  if (window.top !== window || globalThis.__yfsAudioAlive) return;
  globalThis.__yfsAudioAlive = true;

  const YFS = globalThis.YFS;
  const W = YFS.watch;
  const T = YFS.transcript;
  const M = YFS.music;
  const tr = (k, p) => YFS.i18n.t(k, p);
  const SESSION_KEY = 'yfs_audio_mode';
  const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];
  const SLEEP = [0, 15, 30, 60, -1]; // минуты; -1 — до конца трека

  let ui = null;
  let videoId = '';
  let chapters = [];
  let follow = true;
  let userScrollAt = 0;
  let sleep = { mode: 0, until: 0 };
  let musicQuery = '';
  let trackInfo = null; // { artist, track, query, durationSec } — для поиска текста песни
  let tab = 'text'; // text | lyrics | plan
  let userTab = false; // вкладку выбрал человек — сами её больше не переключаем
  let lyricsFor = ''; // для какого ролика искали текст песни
  let planSig = '';
  const views = { text: { name: 'text', segs: [], cur: -1, box: null }, lyrics: { name: 'lyrics', segs: [], cur: -1, box: null } };
  const PLAN_COLOR = { keep: '#2ba640', fast: '#f2a20c', skip: '#717171' };
  const PLAN_ICON = { keep: '▶', fast: '⏩', skip: '⏭' };
  const LYRICS_CACHE = 'yfs_lyrics_cache';
  const focusApi = () => YFS.focusMode || null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    button { border: 0; font: inherit; color: inherit; cursor: pointer; background: none; }
    svg { width: 22px; height: 22px; fill: currentColor; display: block; }
    .screen { position: fixed; inset: 0; z-index: 2250; display: flex; flex-direction: column; overflow: hidden; background: #0b0b0b; color: #f1f1f1;
      font: 15px/1.5 Roboto, 'Segoe UI', Arial, sans-serif; }
    .bg { position: absolute; inset: -60px; background: center / cover; filter: blur(60px) saturate(1.4) brightness(.32); transform: scale(1.15); transition: background-image .4s; }
    .shade { position: absolute; inset: 0; background: radial-gradient(ellipse at 30% 20%, #ffffff0d, transparent 60%), linear-gradient(#0000, #000a); }
    .topbar { position: relative; z-index: 3; display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 20px; }
    .topbar .tabs { flex: 0 0 auto; }
    .topbar label { display: flex; align-items: center; gap: 6px; color: #aaa; font-size: 13px; cursor: pointer; }
    .topbar input { accent-color: #ff0033; }
    .sp { flex: 1; }
    .exit { display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border-radius: 18px; background: #ffffff1f; }
    .exit:hover { background: #ffffff33; }
    .main { position: relative; z-index: 1; display: flex; flex: 1; justify-content: center; min-height: 0; transition: padding-right .25s; }
    .stage { display: flex; flex: 1; flex-direction: column; min-width: 0; max-width: 820px; padding: 0 24px; }
    .deck { position: relative; z-index: 3; flex: 0 0 auto; padding: 10px 20px 14px; border-top: 1px solid #ffffff1a; background: #0b0b0bd9; backdrop-filter: blur(24px); }
    .seek { display: flex; align-items: center; gap: 10px; }
    .seek .mid { flex: 1; min-width: 0; }
    .seek input { display: block; width: 100%; height: 4px; margin: 6px 0; accent-color: #ff0033; cursor: pointer; }
    .seek > span { min-width: 40px; color: #aaa; font-size: 12px; font-variant-numeric: tabular-nums; }
    .seek > span:first-child { text-align: right; }
    .dk { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 16px; margin-top: 2px; }
    .meta { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .cover { flex: 0 0 auto; width: 88px; aspect-ratio: 16 / 9; border-radius: 8px; background: #1c1c1c center / cover; box-shadow: 0 6px 18px #000a; }
    .mt { min-width: 0; }
    .title { margin: 0; overflow: hidden; font-size: 15px; font-weight: 600; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
    .channel { margin: 0; overflow: hidden; color: #bdbdbd; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    .chapter { margin: 0; overflow: hidden; color: #ff6b81; font-size: 12px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
    .chapter:empty { display: none; }
    .controls { display: flex; align-items: center; justify-content: center; gap: 8px; }
    .ctl { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; color: #e8e8e8; }
    .ctl:hover:not(:disabled) { background: #ffffff1a; }
    .ctl:disabled { opacity: .3; cursor: default; }
    .play { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 50%; background: #f5f5f5; color: #0b0b0b; box-shadow: 0 6px 20px #0008; }
    .play:hover { transform: scale(1.04); }
    .play svg { width: 28px; height: 28px; }
    .tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
    .vol { display: flex; align-items: center; gap: 4px; width: 140px; }
    .vol input { flex: 1; min-width: 0; accent-color: #f1f1f1; }
    .pill { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 16px; background: #ffffff17; font-size: 13px;
      white-space: nowrap; font-variant-numeric: tabular-nums; }
    .pill:hover { background: #ffffff2b; }
    .pill.on { background: #f1f1f1; color: #0b0b0b; }
    .pill[hidden] { display: none; }
    .pill svg { width: 16px; height: 16px; }
    .extra { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; justify-content: flex-start; gap: 8px; padding: 6px 0 10px; }
    .extra:not(:has(.block:not([hidden]))) { display: none; }
    .block { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 100%; padding: 6px 12px; border-radius: 16px; background: #ffffff0f; }
    .block[hidden] { display: none; }
    .block h3 { margin: 0; color: #aaa; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; }
    .block p { margin: 0; overflow: hidden; max-width: 46ch; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    .block.music { padding: 0; background: none; }
    .mtog { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 15px; background: #ffffff17; font-size: 13px; white-space: nowrap; }
    .mtog:hover, .block.open .mtog { background: #ffffff2b; }
    .mtog .ic { display: none; }
    .block.open .mtog { width: 30px; justify-content: center; padding: 0; }
    .block.open .mtog .full { display: none; }
    .block.open .mtog .ic { display: inline; }
    .links { display: none; flex-wrap: wrap; gap: 6px; }
    .block.open .links { display: flex; }
    .pf { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--b, #ffffff22); color: var(--t, #fff); font-size: 13px; font-weight: 700; line-height: 1; text-decoration: none; transition: transform .12s; }
    .pf:hover { transform: scale(1.12); }
    .helpw { position: relative; }
    .help { display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid #ffffff3d; border-radius: 50%; color: #bbb; font-size: 13px; font-weight: 600; }
    .help:hover, .help:focus-visible { background: #ffffff1f; color: #fff; }
    .tip { position: absolute; z-index: 6; top: calc(100% + 8px); left: 0; display: none; width: min(340px, 80vw); padding: 10px 12px; border-radius: 12px; background: #1c1c1e; box-shadow: 0 8px 28px #000a; color: #ddd; font-size: 12px; line-height: 1.6; }
    .helpw:hover .tip, .helpw:focus-within .tip { display: block; }
    .text { flex: 1; overflow-y: auto; padding: 8px 4px 40vh; scrollbar-width: thin; scrollbar-color: #ffffff30 transparent;
      mask-image: linear-gradient(to bottom, transparent, #000 40px, #000 85%, transparent); }
    .line { display: flex; gap: 14px; padding: 7px 10px; border-radius: 10px; color: #8a8a8a; font-size: 17px; line-height: 1.45; cursor: pointer;
      transition: color .25s, background .25s, transform .25s; }
    .line:hover { background: #ffffff0f; }
    .line .t { flex: 0 0 54px; padding-top: 4px; color: #3ea6ff; font-size: 12px; font-variant-numeric: tabular-nums; opacity: .7; }
    .line.past { color: #c4c4c4; }
    .line.now { color: #fff; background: #ffffff14; font-size: 21px; font-weight: 600; }
    .line.now .t { opacity: 1; }
    .note { margin: 24px 0; color: #aaa; text-align: center; }

    .qcol { position: absolute; z-index: 4; top: 0; right: 0; bottom: 0; display: flex; flex-direction: column; width: min(380px, 94%); padding: 12px 14px 8px;
      border-left: 1px solid #ffffff1f; background: #121214f2; box-shadow: -18px 0 40px #0008; backdrop-filter: blur(20px); transition: transform .25s; }
    .qcol:not(.open) { visibility: hidden; transform: translateX(104%); transition: transform .25s, visibility 0s .25s; }
    .qcol[hidden] { display: none; }
    @media (min-width: 1100px) { .main.qopen { padding-right: 380px; } }
    .qhead { display: flex; align-items: center; gap: 6px; padding: 0 4px 10px; }
    .qhead b { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; }
    .qbtn { display: grid; place-items: center; flex: 0 0 auto; width: 32px; height: 32px; border-radius: 16px; background: #ffffff17; font-size: 14px; }
    .qbtn:hover:not(:disabled) { background: #ffffff30; }
    .qbtn:disabled { opacity: .45; cursor: default; }
    .qbtn[hidden] { display: none; }
    .qstate { margin: 0; padding: 0 4px 8px; color: #9a9a9a; font-size: 12px; }
    .qstate:empty { display: none; }
    .qlist { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #ffffff30 transparent; }
    .qi { display: flex; gap: 8px; padding: 8px; border-radius: 10px; cursor: pointer; }
    .qi:hover { background: #ffffff0f; }
    .qi.now { background: #ffffff1f; }
    .qi .qn { flex: 0 0 26px; padding-top: 2px; color: #888; font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
    .qi.now .qn { color: #ff6b81; }
    .qi .qt { min-width: 0; }
    .qi b { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 14px; font-weight: 500; line-height: 1.3; }
    .qi small { display: block; overflow: hidden; color: #999; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .planbar { display: flex; gap: 2px; height: 8px; margin-bottom: 8px; overflow: hidden; border-radius: 4px; cursor: pointer; }
    .planbar[hidden] { display: none; }
    .planbar i { display: block; height: 100%; min-width: 2px; opacity: .85; }
    .planbar i:hover { opacity: 1; }
    .focusrow { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .focusrow[hidden] { display: none; }
    .focusline { max-width: 190px; margin: 0; color: #bdbdbd; font-size: 12px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .tabs { display: flex; flex: 1; gap: 4px; }
    .tab { height: 32px; padding: 0 14px; border-radius: 16px; color: #bdbdbd; font-size: 14px; font-weight: 500; white-space: nowrap; }
    .tab:hover { background: #ffffff14; color: #fff; }
    .tab[aria-selected='true'] { background: #f1f1f1; color: #0b0b0b; }
    .tab[hidden] { display: none; }
    .pane { display: flex; flex: 1; flex-direction: column; min-height: 0; }
    .pane[hidden] { display: none; }
    .lyr-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 4px 8px; }
    .lyr-head input[type=text] { flex: 1; min-width: 160px; height: 32px; padding: 0 12px; border: 1px solid #ffffff2b; border-radius: 16px; background: #ffffff10; color: #f1f1f1; font: inherit; font-size: 13px; }
    .lyr-head input[type=text]::placeholder { color: #888; }
    .lyr-head .state { flex-basis: 100%; color: #8f8f8f; font-size: 12px; }
    .line[data-act='keep'] { box-shadow: inset 2px 0 0 #2ba64066; }
    .line[data-act='fast'] { box-shadow: inset 3px 0 0 #f2a20c; }
    .line[data-act='skip'] { box-shadow: inset 3px 0 0 #717171; opacity: .55; }
    .line.gap { min-height: 18px; padding: 2px 10px; cursor: default; }
    .line.lyr { justify-content: center; text-align: center; font-size: 22px; }
    .line.lyr.now { font-size: 27px; }
    .acts { display: flex; gap: 3px; }
    .acts button { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: #ffffff12; color: #cfcfcf; font-size: 12px; opacity: .55; }
    .acts button:hover { opacity: 1; background: #ffffff30; }
    .acts button.on { opacity: 1; background: var(--c); color: #0b0b0b; box-shadow: 0 0 0 2px #0b0b0b, 0 0 0 3px var(--c); }
    .plan-item { display: grid; grid-template-columns: 94px 92px minmax(0, 1fr); gap: 8px; align-items: start; padding: 9px 10px; border-radius: 10px; cursor: pointer; border-left: 3px solid var(--c); }
    .plan-item:hover { background: #ffffff0f; }
    .plan-item.now { background: #ffffff1a; }
    .plan-item.skip { opacity: .65; }
    .plan-item .ico { font-size: 15px; text-align: center; }
    .plan-item .tm { color: #3ea6ff; font-size: 12px; font-variant-numeric: tabular-nums; padding-top: 3px; }
    .plan-item b { display: block; font-weight: 600; font-size: 15px; }
    .plan-item span.sum { color: #aaa; font-size: 13px; }
    .plan-sum { margin: 4px 10px 12px; color: #d8d8d8; font-size: 14px; }
    @media (max-width: 860px) {
      .topbar { padding: 10px 12px; gap: 8px; }
      .stage { padding: 0 12px; }
      .deck { padding: 8px 12px 10px; }
      .dk { grid-template-columns: 1fr; gap: 6px; }
      .cover { width: 64px; }
      .tools { justify-content: space-between; }
      .vol, .focusline { display: none; }
    }
    @media (max-height: 640px) { .cover { width: 64px; } }
  `;

  // ---------- значки (SVG, без innerHTML — у YouTube Trusted Types) ----------

  const ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
    back: 'M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8zm-1.1 11h-.85v-3.26l-1.01.31v-.69l1.77-.63h.09V16zm4.28-1.76c0 .32-.03.6-.1.82-.07.23-.17.42-.29.57-.12.15-.28.26-.45.33-.17.07-.37.1-.59.1s-.41-.03-.59-.1a1.2 1.2 0 0 1-.46-.33 1.53 1.53 0 0 1-.3-.57c-.07-.22-.11-.5-.11-.82v-.74c0-.32.03-.6.1-.82.07-.23.17-.42.29-.57.12-.15.28-.26.45-.33.17-.07.37-.1.59-.1s.41.03.59.1c.18.07.33.18.46.33.13.15.23.34.3.57.07.22.11.5.11.82v.74zm-.85-.86c0-.19-.01-.35-.04-.48-.03-.13-.07-.23-.12-.31a.47.47 0 0 0-.19-.17.6.6 0 0 0-.25-.05c-.09 0-.18.02-.25.05a.47.47 0 0 0-.19.17c-.05.08-.09.18-.12.31-.03.13-.04.29-.04.48v.97c0 .19.01.35.04.48.03.13.07.24.12.32.05.08.11.14.19.17.08.03.16.05.25.05s.18-.02.25-.05a.47.47 0 0 0 .19-.17c.05-.08.09-.19.11-.32.03-.13.04-.29.04-.48v-.97z',
    fwd: 'M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8zm-1.1 11h-.85v-3.26l-1.01.31v-.69l1.77-.63h.09V16zm4.28-1.76c0 .32-.03.6-.1.82-.07.23-.17.42-.29.57-.12.15-.28.26-.45.33-.17.07-.37.1-.59.1s-.41-.03-.59-.1a1.2 1.2 0 0 1-.46-.33 1.53 1.53 0 0 1-.3-.57c-.07-.22-.11-.5-.11-.82v-.74c0-.32.03-.6.1-.82.07-.23.17-.42.29-.57.12-.15.28-.26.45-.33.17-.07.37-.1.59-.1s.41.03.59.1c.18.07.33.18.46.33.13.15.23.34.3.57.07.22.11.5.11.82v.74zm-.85-.86c0-.19-.01-.35-.04-.48-.03-.13-.07-.23-.12-.31a.47.47 0 0 0-.19-.17.6.6 0 0 0-.25-.05c-.09 0-.18.02-.25.05a.47.47 0 0 0-.19.17c-.05.08-.09.18-.12.31-.03.13-.04.29-.04.48v.97c0 .19.01.35.04.48.03.13.07.24.12.32.05.08.11.14.19.17.08.03.16.05.25.05s.18-.02.25-.05a.47.47 0 0 0 .19-.17c.05-.08.09-.19.11-.32.03-.13.04-.29.04-.48v-.97z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
    vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    mute: 'M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z',
    moon: 'M12.3 22a10 10 0 0 1-6.7-17.4 1 1 0 0 1 1.6 1A8 8 0 0 0 18.4 16.8a1 1 0 0 1 1 1.6A10 10 0 0 1 12.3 22z',
    tv: 'M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18v12z',
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name]);
    svg.append(p);
    return svg;
  }

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

  const video = () => W.activeVideoEl();
  const ownQueue = () => !!(YFS.queue && YFS.queue.active);
  const inQueue = () => ownQueue() || new URLSearchParams(location.search).has('list');

  /** Следующий / предыдущий трек: своя очередь расширения, иначе плейлист YouTube. */
  function trackNav(dir) {
    if (ownQueue()) return dir === 'next' ? YFS.queue.next() : YFS.queue.prev();
    return YFS.askPage && YFS.askPage('nav', dir, 3000);
  }

  // ---------- экран ----------

  function build() {
    const host = document.createElement('div');
    host.id = 'yfs-audio';
    host.dataset.v = W.VERSION;
    const root = host.attachShadow({ mode: 'open' });
    const e = {};
    const ctl = (name, label, onClick) => {
      const b = el('button', { className: 'ctl', type: 'button', title: label, 'aria-label': label }, icon(name));
      b.addEventListener('click', onClick);
      return b;
    };
    e.bg = el('div', { className: 'bg' });
    e.cover = el('div', { className: 'cover' });
    e.title = el('h1', { className: 'title' });
    e.channel = el('p', { className: 'channel' });
    e.chapter = el('p', { className: 'chapter' });
    e.range = el('input', { type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': tr('audio.seek') });
    e.cur = el('span', {}, '0:00');
    e.total = el('span', {}, '0:00');
    e.prev = ctl('prev', tr('audio.prevTrack'), () => trackNav('prev'));
    e.back = ctl('back', tr('audio.back10'), () => skip(-10));
    e.play = el('button', { className: 'play', type: 'button', 'aria-label': tr('audio.play') }, icon('play'));
    e.play.addEventListener('click', playPause);
    e.fwd = ctl('fwd', tr('audio.fwd10'), () => skip(10));
    e.next = ctl('next', tr('audio.nextTrack'), () => trackNav('next'));
    e.muteBtn = ctl('vol', tr('audio.mute'), toggleMute);
    e.volume = el('input', { type: 'range', min: 0, max: 100, step: 1, value: 100, 'aria-label': tr('audio.volume') });
    e.volume.addEventListener('input', () => setVolume(Number(e.volume.value)));
    e.speed = el('button', { className: 'pill', type: 'button', title: tr('audio.speed') }, '1×');
    e.speed.addEventListener('click', nextSpeed);
    e.sleep = el('button', { className: 'pill', type: 'button', title: tr('audio.sleep') }, icon('moon'), el('span', {}, ''));
    e.sleep.addEventListener('click', nextSleep);
    e.planbar = el('div', { className: 'planbar', hidden: true });
    e.planbar.addEventListener('click', (ev) => {
      const F = focusApi();
      const v = video();
      const plan = F && F.plan;
      if (!v || !plan || !plan.segments.length) return;
      const r = e.planbar.getBoundingClientRect();
      v.currentTime = Math.max(0, ((ev.clientX - r.left) / r.width) * plan.segments[plan.segments.length - 1].end);
    });
    e.focus = el('button', { className: 'pill', type: 'button', title: tr('watch.focus') }, el('span', {}, '⚡'), el('span', {}, tr('audio.focusBtn')));
    e.focus.addEventListener('click', () => focusApi() && focusApi().togglePanel());
    e.focusLine = el('p', { className: 'focusline' });
    e.qtitle = el('b', {});
    const qbtn = (label, title, onClick) => {
      const b = el('button', { className: 'qbtn', type: 'button', title, 'aria-label': title }, label);
      b.addEventListener('click', onClick);
      return b;
    };
    e.qshuffle = qbtn('🔀', tr('audio.queueShuffle'), () => reorderQueue('random'));
    e.qai = qbtn('✨', tr('audio.queueAi'), () => reorderQueue('ai'));
    e.qstop = qbtn('✕', tr('audio.queueStop'), () => YFS.queue && YFS.queue.stop());
    e.qstate = el('p', { className: 'qstate' });
    e.qlist = el('div', { className: 'qlist', role: 'list' });
    e.qclose = qbtn('›', tr('common.close'), () => setQueueOpen(false));
    e.qcol = el('div', { className: 'qcol', hidden: true }, el('div', { className: 'qhead' }, e.qtitle, e.qshuffle, e.qai, e.qstop, e.qclose), e.qstate, e.qlist);
    e.qtoggle = el('button', { className: 'pill', type: 'button', hidden: true, 'aria-expanded': 'false' });
    e.qtoggle.addEventListener('click', () => setQueueOpen(!qOpen));
    e.queue = el('div', { className: 'block', hidden: true }, el('h3', {}, tr('audio.upNext')), el('p', {}));
    // «🎵 Найти трек»: по щелчку надпись сворачивается в значок, а рядом разворачиваются значки площадок.
    e.musicToggle = el('button', { className: 'mtog', type: 'button', 'aria-expanded': 'false', title: tr('audio.findTrack') }, el('span', { className: 'full' }, tr('audio.findTrack')), el('span', { className: 'ic', 'aria-hidden': 'true' }, '🎵'));
    e.music = el('div', { className: 'block music', hidden: true }, e.musicToggle, el('div', { className: 'links' }));
    e.musicToggle.addEventListener('click', () => {
      const open = !e.music.classList.contains('open');
      e.music.classList.toggle('open', open);
      e.musicToggle.setAttribute('aria-expanded', String(open));
    });
    // Горячие клавиши — по наведению на «?».
    e.help = el('span', { className: 'helpw' }, el('button', { className: 'help', type: 'button', 'aria-label': tr('audio.shortcuts') }, '?'), el('div', { className: 'tip', role: 'tooltip' }, tr('audio.hint')));
    e.follow = el('input', { type: 'checkbox', checked: true });
    e.text = el('div', { className: 'text', tabIndex: -1 });
    e.lyrics = el('div', { className: 'text', tabIndex: -1 });
    e.plan = el('div', { className: 'text', tabIndex: -1 });
    e.lyricsInput = el('input', { type: 'text', placeholder: tr('audio.lyricsPh'), 'aria-label': tr('audio.lyricsPh'), spellcheck: false });
    e.lyricsGo = el('button', { className: 'pill', type: 'button' }, tr('audio.lyricsFind'));
    e.lyricsState = el('p', { className: 'state' }, '');
    const tabBtn = (name, label) => {
      const b = el('button', { className: 'tab', type: 'button', role: 'tab', 'aria-selected': String(name === 'text') }, label);
      b.addEventListener('click', () => setTab(name, true));
      return b;
    };
    e.tabs = { text: tabBtn('text', tr('text.tab')), lyrics: tabBtn('lyrics', '🎵 ' + tr('audio.tabLyrics')), plan: tabBtn('plan', '⚡ ' + tr('audio.tabPlan')) };
    e.lyricsPane = el('div', { className: 'pane', hidden: true }, el('div', { className: 'lyr-head' }, e.lyricsInput, e.lyricsGo, e.lyricsState), e.lyrics);
    e.planPane = el('div', { className: 'pane', hidden: true }, e.plan);
    e.textPane = el('div', { className: 'pane' }, e.text);
    views.text.box = e.text;
    views.lyrics.box = e.lyrics;
    e.exit = el('button', { className: 'exit', type: 'button' }, tr('audio.exit'));
    e.exit.addEventListener('click', () => toggle(false));

    e.extra = el('div', { className: 'extra' }, e.queue, e.music);
    e.main = el('div', { className: 'main' }, el('div', { className: 'stage' }, e.textPane, e.lyricsPane, e.planPane, e.extra), e.qcol);
    e.screen = el(
      'div',
      { className: 'screen', tabIndex: -1, role: 'dialog', 'aria-label': tr('watch.audio') },
      e.bg,
      el('div', { className: 'shade' }),
      el('div', { className: 'topbar' }, el('div', { className: 'tabs', role: 'tablist' }, e.tabs.text, e.tabs.lyrics, e.tabs.plan), el('label', {}, e.follow, tr('audio.follow')), e.help, el('span', { className: 'sp' }), e.qtoggle, e.exit),
      e.main,
      el(
        'div',
        { className: 'deck' },
        el('div', { className: 'seek' }, e.cur, el('div', { className: 'mid' }, e.planbar, e.range), e.total),
        el(
          'div',
          { className: 'dk' },
          el('div', { className: 'meta' }, e.cover, el('div', { className: 'mt' }, e.title, e.channel, e.chapter)),
          el('div', { className: 'controls' }, e.prev, e.back, e.play, e.fwd, e.next),
          el('div', { className: 'tools' }, el('div', { className: 'vol' }, e.muteBtn, e.volume), e.speed, e.sleep, el('div', { className: 'focusrow' }, e.focus, e.focusLine))
        )
      )
    );
    root.append(el('style', { textContent: CSS }), e.screen);

    e.range.addEventListener('input', () => {
      const v = video();
      if (v && Number.isFinite(v.duration)) e.cur.textContent = T.formatTime((e.range.value / 1000) * v.duration);
    });
    e.range.addEventListener('change', () => {
      const v = video();
      if (v && Number.isFinite(v.duration)) v.currentTime = (e.range.value / 1000) * v.duration;
    });
    e.follow.addEventListener('change', () => {
      follow = e.follow.checked;
      if (follow) scrollView(views[tab] || views.text, true);
    });
    // Пользователь сам листает текст — на несколько секунд не тянем прокрутку к текущей строке.
    for (const box of [e.text, e.lyrics, e.plan]) {
      for (const t of ['wheel', 'touchmove']) box.addEventListener(t, () => (userScrollAt = Date.now()), { passive: true });
      box.addEventListener('click', (ev) => {
        const line = ev.target.closest('[data-start]');
        const v = video();
        if (!line || !v) return;
        v.currentTime = Number(line.dataset.start) || 0;
        v.play().catch(() => {});
        userScrollAt = 0;
      });
    }
    const search = () => searchLyrics(e.lyricsInput.value);
    e.lyricsGo.addEventListener('click', search);
    e.lyricsInput.addEventListener('keydown', (ev) => ev.key === 'Enter' && (ev.preventDefault(), search()));
    // Клавиши — наши, а не YouTube (иначе пробел сработал бы дважды).
    e.screen.addEventListener('keydown', onKey);
    for (const t of ['keyup', 'keypress']) e.screen.addEventListener(t, (ev) => ev.stopPropagation());
    ui = { host, root, e };
    return ui;
  }

  function onKey(ev) {
    ev.stopPropagation();
    const k = ev.key;
    const onRange = ev.target && ev.target.tagName === 'INPUT' && ev.target.type === 'range';
    if (onRange && /^Arrow/.test(k)) return; // ползунок сам двигается стрелками
    if (k === ' ' || k === 'k' || k === 'K') playPause();
    else if (k === 'ArrowLeft' || k === 'j' || k === 'J') skip(-10);
    else if (k === 'ArrowRight' || k === 'l' || k === 'L') skip(10);
    else if (k === 'ArrowUp') setVolume(currentVolume() + 5);
    else if (k === 'ArrowDown') setVolume(currentVolume() - 5);
    else if (k === 'm' || k === 'M') toggleMute();
    else if (ev.shiftKey && (k === 'N' || k === 'n')) trackNav('next');
    else if (ev.shiftKey && (k === 'P' || k === 'p')) trackNav('prev');
    else if (k === 'Escape') {
      if (qOpen) setQueueOpen(false);
      else toggle(false);
    }
    else return;
    ev.preventDefault();
  }

  function playPause() {
    const v = video();
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  function skip(sec) {
    const v = video();
    if (v) v.currentTime = Math.max(0, Math.min((v.duration || Infinity) - 0.5, v.currentTime + sec));
  }

  function nextSpeed() {
    const v = video();
    if (!v) return;
    const i = SPEEDS.indexOf(v.playbackRate);
    v.playbackRate = SPEEDS[(i + 1) % SPEEDS.length];
  }

  // ---------- громкость: через API плеера, чтобы YouTube запомнил её между роликами ----------

  function currentVolume() {
    const v = video();
    return v ? Math.round(v.volume * 100) : 100;
  }

  function setVolume(n) {
    const vol = Math.max(0, Math.min(100, Math.round(n)));
    if (YFS.askPage) YFS.askPage('volume', JSON.stringify({ volume: vol, muted: vol === 0 ? true : undefined }), 2000);
    else if (video()) video().volume = vol / 100;
    if (ui) ui.e.volume.value = String(vol);
  }

  function toggleMute() {
    const v = video();
    if (!v) return;
    if (YFS.askPage) YFS.askPage('volume', JSON.stringify({ muted: !v.muted }), 2000);
    else v.muted = !v.muted;
  }

  // ---------- таймер сна ----------

  function nextSleep() {
    const i = SLEEP.indexOf(sleep.mode);
    const mode = SLEEP[(i + 1) % SLEEP.length];
    sleep = { mode, until: mode > 0 ? Date.now() + mode * 60000 : 0 };
    updateSleep();
  }

  function updateSleep() {
    if (!ui) return;
    const label = ui.e.sleep.lastChild;
    ui.e.sleep.classList.toggle('on', sleep.mode !== 0);
    if (sleep.mode === 0) label.textContent = tr('audio.sleep');
    else if (sleep.mode === -1) label.textContent = tr('audio.sleepEnd');
    else label.textContent = tr('audio.sleepLeft', { min: Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000)) });
  }

  function checkSleep(v) {
    if (sleep.mode > 0 && Date.now() >= sleep.until) {
      v.pause();
      sleep = { mode: 0, until: 0 };
    } else if (sleep.mode === -1 && Number.isFinite(v.duration) && v.duration - v.currentTime < 1.2) {
      v.pause(); // до конца трека — и не дальше по очереди
      sleep = { mode: 0, until: 0 };
    }
  }

  // ---------- синхронизация с плеером ----------

  function setIcon(btn, name) {
    btn.replaceChildren(icon(name));
  }

  function updateControls() {
    const v = video();
    if (!ui || !v) return;
    const e = ui.e;
    const playing = !v.paused;
    if (e.play.dataset.state !== String(playing)) {
      e.play.dataset.state = String(playing);
      setIcon(e.play, playing ? 'pause' : 'play');
      e.play.setAttribute('aria-label', tr(playing ? 'audio.pause' : 'audio.play'));
    }
    const muted = v.muted || v.volume === 0;
    if (e.muteBtn.dataset.state !== String(muted)) {
      e.muteBtn.dataset.state = String(muted);
      setIcon(e.muteBtn, muted ? 'mute' : 'vol');
    }
    if (ui.root.activeElement !== e.volume) e.volume.value = String(muted ? 0 : Math.round(v.volume * 100));
    e.speed.textContent = `${v.playbackRate}×`;
    const queue = inQueue();
    e.prev.disabled = !queue;
    e.next.disabled = !queue;
    const d = v.duration;
    if (Number.isFinite(d) && d > 0) {
      e.total.textContent = T.formatTime(d);
      if (ui.root.activeElement !== e.range) {
        e.range.value = String(Math.round((v.currentTime / d) * 1000));
        e.cur.textContent = T.formatTime(v.currentTime);
      }
    }
    const ch = chapters.filter((c) => c.start <= v.currentTime + 0.5).pop();
    e.chapter.textContent = ch ? ch.title : '';
    checkSleep(v);
    if (sleep.mode > 0) updateSleep();
    highlightAll(v.currentTime);
    updateFocus();
  }

  /** Номер строки для момента t (двоичный поиск по началам строк). */
  function indexAt(segs, t) {
    let lo = 0;
    let hi = segs.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= t + 0.15) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  function highlightAll(t) {
    highlightView(views.text, t);
    highlightView(views.lyrics, t);
    highlightPlan(t);
  }

  function highlightView(view, t) {
    if (!ui || !view.segs.length) return;
    const i = indexAt(view.segs, t);
    if (i === view.cur) return;
    const lines = view.box.children;
    const prev = view.cur;
    const from = Math.max(0, Math.min(i, prev));
    const to = Math.max(i, prev);
    // Перекрашиваем только изменившийся участок — строк бывает несколько тысяч.
    for (let k = from; k <= to && k < lines.length; k++) {
      lines[k].classList.toggle('now', k === i);
      lines[k].classList.toggle('past', k < i);
    }
    if (prev > i) for (let k = Math.max(0, i + 1); k <= prev && k < lines.length; k++) lines[k].classList.remove('past');
    view.cur = i;
    if (tab === view.name) scrollView(view, false);
  }

  function scrollView(view, force) {
    if (!ui || !view || view.cur < 0 || (!force && (!follow || Date.now() - userScrollAt < 4000))) return;
    const line = view.box.children[view.cur];
    if (!line) return;
    const box = view.box;
    // Текущая строка — на трети высоты списка (видно и прошлое, и то, что дальше).
    const target = box.scrollTop + (line.getBoundingClientRect().top - box.getBoundingClientRect().top) - box.clientHeight * 0.3;
    box.scrollTo({ top: Math.max(0, target), behavior: force ? 'auto' : 'smooth' });
  }

  // ---------- вкладки справа ----------

  function setTab(name, byUser) {
    if (!ui || !views || !['text', 'lyrics', 'plan'].includes(name)) return;
    tab = name;
    if (byUser) userTab = true;
    const e = ui.e;
    for (const [key, btn] of Object.entries(e.tabs)) btn.setAttribute('aria-selected', String(key === name));
    e.textPane.hidden = name !== 'text';
    e.lyricsPane.hidden = name !== 'lyrics';
    e.planPane.hidden = name !== 'plan';
    if (name === 'lyrics' && lyricsFor !== videoId && trackInfo) searchLyrics(e.lyricsInput.value, true);
    if (views[name]) setTimeout(() => scrollView(views[name], true), 30);
    if (name === 'plan') renderPlanPane();
  }

  // ---------- разметка плана СДВГ-режима: шкала, строки текста, вкладка «План» ----------

  const planSignature = (plan) => (plan ? plan.segments.map((x) => `${x.start}-${x.end}${x.action[0]}`).join(',') : '');

  function paintTextLines(plan) {
    const lines = views.text.box ? views.text.box.children : [];
    for (let i = 0; i < lines.length; i++) {
      const seg = plan && views.text.segs[i] ? plan.segments.find((x) => views.text.segs[i].start >= x.start && views.text.segs[i].start < x.end) : null;
      if (seg) lines[i].dataset.act = seg.action;
      else delete lines[i].dataset.act;
    }
  }

  function updateFocus() {
    const F = focusApi();
    if (!ui || !F) return;
    const e = ui.e;
    // Музыка: СДВГ-режим для треков не включается — ни кнопки, ни шкалы плана, ни вкладки «План».
    const track = !!musicQuery || F.isMusic;
    e.focus.parentElement.hidden = track;
    e.tabs.plan.hidden = track;
    if (track) {
      e.planbar.hidden = true;
      if (tab === 'plan') setTab('lyrics');
      planSig = '';
      return;
    }
    const plan = F.plan;
    const on = F.enabled;
    const sig = planSignature(plan) + (on ? '1' : '0');
    if (sig !== planSig) {
      planSig = sig;
      e.planbar.replaceChildren();
      if (plan && plan.segments.length) {
        for (const x of plan.segments) {
          const i = el('i', { title: `${T.formatTime(x.start)} ${PLAN_ICON[x.action]} ${x.title}` });
          i.style.flex = String(Math.max(0.01, x.end - x.start));
          i.style.background = PLAN_COLOR[x.action];
          e.planbar.append(i);
        }
      }
      e.planbar.hidden = !(plan && plan.segments.length);
      e.planbar.style.opacity = on ? '1' : '.35';
      paintTextLines(on ? plan : null);
      if (tab === 'plan') renderPlanPane();
    }
    // Кнопка и строка состояния.
    const label = e.focus.lastChild;
    const seg = plan && on ? F.current : null;
    e.focus.classList.toggle('on', !!(plan && on));
    if (F.loading) {
      label.textContent = tr('audio.focusLoading');
      e.focusLine.textContent = '';
    } else if (plan && plan.segments.length) {
      const AI = YFS.ai;
      const s = AI && AI.focusSavings ? AI.focusSavings(plan, F.prefs.rate) : null;
      label.textContent = s && s.total ? `−${Math.round((s.saved / s.total) * 100)}%` : tr('audio.focusBtn');
      e.focusLine.textContent = !on ? tr('audio.focusOff') : seg ? `${PLAN_ICON[seg.action]} ${seg.title}` : tr('audio.focusOn');
    } else {
      label.textContent = tr('audio.focusBtn');
      e.focusLine.textContent = on ? tr('audio.focusNoPlan') : tr('audio.focusOff');
    }
    if (tab === 'plan') highlightPlan(video() ? video().currentTime : 0);
  }

  function renderPlanPane() {
    const F = focusApi();
    if (!ui || !F) return;
    const box = ui.e.plan;
    const plan = F.plan;
    box.replaceChildren();
    if (!plan || !plan.segments.length) {
      const go = el('button', { className: 'pill', type: 'button' }, '⚡ ' + tr('focus.make'));
      go.addEventListener('click', () => F.togglePanel());
      box.append(el('p', { className: 'note' }, tr('audio.planEmpty')), el('div', { style: 'text-align:center' }, go));
      return;
    }
    const AI = YFS.ai;
    const s = AI && AI.focusSavings ? AI.focusSavings(plan, F.prefs.rate) : null;
    if (plan.overview) box.append(el('p', { className: 'plan-sum' }, plan.overview));
    if (s && s.total) box.append(el('p', { className: 'plan-sum' }, tr('focus.saves', { watch: T.formatTime(s.watch), total: T.formatTime(s.total), pct: Math.round((s.saved / s.total) * 100) })));
    plan.segments.forEach((x, idx) => {
      const acts = el('span', { className: 'acts', role: 'radiogroup', 'aria-label': tr('focus.changeAction') });
      for (const act of ['keep', 'fast', 'skip']) {
        const b = el('button', { className: act === x.action ? 'on' : '', type: 'button', role: 'radio', 'aria-checked': String(act === x.action), title: tr('focus.' + act) }, PLAN_ICON[act]);
        b.style.setProperty('--c', PLAN_COLOR[act]);
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          F.setAction(idx, act);
        });
        acts.append(b);
      }
      const item = el('div', { className: 'plan-item ' + x.action }, acts, el('span', { className: 'tm' }, `${T.formatTime(x.start)}–${T.formatTime(x.end)}`), el('div', {}, el('b', {}, x.title), x.summary ? el('span', { className: 'sum' }, x.summary) : null));
      item.style.setProperty('--c', PLAN_COLOR[x.action]);
      item.dataset.start = String(x.start);
      box.append(item);
    });
    highlightPlan(video() ? video().currentTime : 0);
  }

  function highlightPlan(t) {
    const F = focusApi();
    if (!ui || tab !== 'plan' || !F || !F.plan) return;
    const items = ui.e.plan.querySelectorAll('.plan-item');
    const segs = F.plan.segments;
    items.forEach((it, i) => it.classList.toggle('now', !!segs[i] && t >= segs[i].start && t < segs[i].end));
  }

  function onMedia(ev) {
    if (!ui || !(ev.target instanceof HTMLVideoElement) || ev.target !== video()) return;
    updateControls();
  }

  // ---------- текст видео ----------

  async function loadText(id) {
    views.text.segs = [];
    views.text.cur = -1;
    chapters = [];
    const box = ui.e.text;
    box.replaceChildren(el('p', { className: 'note' }, tr('text.loading')));
    try {
      const r = await YFS.fetchTranscript(id);
      if (!ui || videoId !== id) return;
      views.text.segs = (r.segments || []).slice().sort((a, b) => a.start - b.start);
      chapters = (r.chapters || []).slice().sort((a, b) => a.start - b.start);
      const frag = document.createDocumentFragment();
      for (const s of views.text.segs) {
        const line = el('div', { className: 'line' }, el('span', { className: 't' }, T.formatTime(s.start)), el('span', {}, s.text));
        line.dataset.start = String(s.start);
        frag.append(line);
      }
      box.replaceChildren(frag);
      if (!ui.e.channel.textContent && r.channel) ui.e.channel.textContent = r.channel;
      planSig = ''; // строки появились — разметку плана нужно нанести заново
      updateControls();
      if (tab === 'text') scrollView(views.text, true);
    } catch (err) {
      if (!ui || videoId !== id) return;
      box.replaceChildren(el('p', { className: 'note' }, tr(err.message === 'no-transcript' ? 'text.none' : 'text.failed')));
    }
  }

  // ---------- текст песни (LRCLIB, lyrics.ovh) ----------

  function requestLyrics(info) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'yfs:lyrics', info }, (res) => {
          void chrome.runtime.lastError;
          resolve(res && res.ok ? res.out : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  const lyricsKey = (i) => `${(i.artist || '').toLowerCase()}|${(i.track || i.query || '').toLowerCase()}|${Math.round((i.durationSec || 0) / 4)}`;

  async function cachedLyrics(key) {
    const c = (await W.store.get(LYRICS_CACHE, {})) || {};
    return c[key] ? c[key].out : null;
  }

  async function saveLyrics(key, out) {
    const c = (await W.store.get(LYRICS_CACHE, {})) || {};
    c[key] = { out, at: Date.now() };
    const keys = Object.keys(c);
    if (keys.length > 40) {
      keys.sort((a, b) => c[a].at - c[b].at);
      for (const k of keys.slice(0, keys.length - 40)) delete c[k];
    }
    await W.store.set(LYRICS_CACHE, c);
  }

  function setLyricsState(text) {
    if (ui) ui.e.lyricsState.textContent = text;
  }

  /** Строка из поля «Исполнитель — Трек» → то, что понимает поиск. */
  function parseQuery(text) {
    const q = String(text || '').trim();
    const parts = q.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) return { artist: parts[0], track: parts.slice(1).join(' '), query: parts.join(' ') };
    return { artist: trackInfo && trackInfo.artist && q === trackInfo.query ? trackInfo.artist : '', track: q, query: q };
  }

  async function searchLyrics(text, auto) {
    if (!ui || !String(text || '').trim()) return;
    const id = videoId;
    lyricsFor = id;
    const e = ui.e;
    const v = video();
    const info = { ...parseQuery(text), durationSec: (trackInfo && trackInfo.durationSec) || (v && Number.isFinite(v.duration) ? v.duration : 0) };
    views.lyrics.segs = [];
    views.lyrics.cur = -1;
    e.lyrics.replaceChildren();
    const opts = (await W.store.get('yfs_audio_opts', {})) || {};
    if (opts.lyrics === false) {
      setLyricsState(tr('audio.lyricsOff'));
      return;
    }
    setLyricsState(tr('audio.lyricsLoading'));
    const key = lyricsKey(info);
    let out = await cachedLyrics(key);
    if (!out) {
      out = await requestLyrics(info);
      if (out) saveLyrics(key, out);
    }
    if (!ui || videoId !== id) return;
    if (!out || !out.lines || !out.lines.length) {
      setLyricsState(tr('audio.lyricsNone'));
      return;
    }
    views.lyrics.segs = out.lines;
    const frag = document.createDocumentFragment();
    for (const l of out.lines) {
      const line = el('div', { className: l.text ? 'line lyr' : 'line gap' }, l.text ? el('span', {}, l.text) : null);
      if (l.text) line.dataset.start = String(l.start);
      frag.append(line);
    }
    e.lyrics.replaceChildren(frag);
    setLyricsState(tr(out.synced ? 'audio.lyricsSynced' : 'audio.lyricsApprox', { source: out.source }));
    // Нашли текст, а человек сам вкладку не выбирал — для музыки показываем его, а не расшифровку.
    if (auto && !userTab && tab !== 'lyrics') setTab('lyrics');
    else if (tab === 'lyrics') setTimeout(() => scrollView(views.lyrics, true), 30);
    updateControls();
  }

  // ---------- музыка и очередь ----------

  async function loadMusic(v) {
    const block = ui.e.music;
    block.hidden = true;
    musicQuery = '';
    trackInfo = null;
    const info = (YFS.askPage && (await YFS.askPage('music', v.id, 3000))) || {};
    if (!ui || videoId !== v.id) return;
    const title = info.title || v.title;
    const channel = info.author || v.channel;
    const isMusic = info.category === 'Music' || M.isMusic({ title, channel, durationSec: info.lengthSec, musicVideoType: info.musicVideoType });
    const t = M.parseTrack(title, channel);
    // Строка поиска текста песни есть у любого ролика — для не-музыки её можно поправить и найти вручную.
    trackInfo = { ...t, durationSec: Number(info.lengthSec) || 0 };
    ui.e.lyricsInput.value = t.artist && t.track ? `${t.artist} — ${t.track}` : t.query;
    if (isMusic) {
      searchLyrics(ui.e.lyricsInput.value, true);
      if (!userTab) setTab('lyrics'); // музыка открывается сразу с песни, а не с расшифровки
    } else setLyricsState(tr('audio.lyricsIdle'));
    if (!isMusic) return;
    musicQuery = t.query;
    const links = block.querySelector('.links');
    // Значки площадок: цвет и знак — свои, не логотипы; название — в подсказке и для скринридера.
    const BRAND = {
      spotify: ['#1db954', '#0b0b0b', 'S'],
      apple: ['#fa243c', '#fff', '♪'],
      yandex: ['#ffcc00', '#0b0b0b', 'Я'],
      ytmusic: ['#ff0033', '#fff', '▶'],
      soundcloud: ['#ff5500', '#fff', '☁'],
      deezer: ['#a238ff', '#fff', '≡'],
      vk: ['#0077ff', '#fff', 'VK'],
    };
    links.replaceChildren(
      ...M.platformLinks(t.query).map((p) => {
        const b = BRAND[p.id] || ['#ffffff22', '#fff', p.name.slice(0, 1)];
        const a = el('a', { className: 'pf', href: p.url, target: '_blank', rel: 'noopener noreferrer', title: p.name, 'aria-label': p.name }, b[2]);
        a.style.setProperty('--b', b[0]);
        a.style.setProperty('--t', b[1]);
        return a;
      }),
      (() => {
        const copy = el('button', { className: 'pf', type: 'button', title: tr('audio.copyTrack'), 'aria-label': tr('audio.copyTrack') }, '⧉');
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(t.artist && t.track ? `${t.artist} — ${t.track}` : t.query);
            copy.textContent = '✓';
            copy.title = tr('text.copied');
            setTimeout(() => {
              copy.textContent = '⧉';
              copy.title = tr('audio.copyTrack');
            }, 1500);
          } catch {
            /* без буфера обмена */
          }
        });
        return copy;
      })()
    );
    block.hidden = false;
    block.hidden = false;
  }

  // ---------- очередь треков слева от текста ----------

  let qSig = '';
  let qPos = -2;
  let qOpen = false; // выезжающая очередь открыта

  function applyQueueOpen(show) {
    const e = ui.e;
    const open = show && qOpen;
    e.qcol.classList.toggle('open', open);
    e.main.classList.toggle('qopen', open);
    e.qtoggle.classList.toggle('on', open);
    e.qtoggle.setAttribute('aria-expanded', String(open));
  }

  function setQueueOpen(on) {
    qOpen = on;
    if (!ui) return;
    qPos = -2; // при открытии список снова встаёт на текущий трек
    renderQueueColumn();
  }
  const cleanText = (x) => String((x && x.textContent) || '').replace(/\s+/g, ' ').trim();

  /** Строки очереди: своя очередь расширения или панель плейлиста YouTube (она только для чтения). */
  function queueRows() {
    const Q = YFS.queue;
    if (Q && Q.active) {
      const items = Q.items;
      return { own: true, pos: Q.pos, sig: 'o' + items.map((t) => t.id).join(','), rows: items.map((t, i) => ({ title: t.title || t.id, channel: t.channel, go: () => Q.go(i) })) };
    }
    const nodes = Array.from(document.querySelectorAll('ytd-playlist-panel-renderer #items ytd-playlist-panel-video-renderer'));
    if (nodes.length < 2) return null;
    const rows = nodes.map((n) => ({ title: cleanText(n.querySelector('#video-title')), channel: cleanText(n.querySelector('#byline')), go: () => n.querySelector('a') && n.querySelector('a').click() }));
    return { own: false, pos: nodes.findIndex((n) => n.hasAttribute('selected')), sig: 'd' + rows.map((r) => r.title).join('|'), rows };
  }

  function renderQueueColumn() {
    if (!ui) return;
    const e = ui.e;
    const r = queueRows();
    const show = !!r && r.rows.length >= 2;
    e.qcol.hidden = !show;
    e.qtoggle.hidden = !show;
    applyQueueOpen(show);
    if (!show) {
      qSig = '';
      return;
    }
    const title = tr('audio.queueTitle', { pos: r.pos + 1, total: r.rows.length });
    e.qtitle.textContent = title;
    e.qtoggle.textContent = '☰ ' + title;
    for (const b of [e.qshuffle, e.qai, e.qstop]) b.hidden = !r.own;
    if (r.sig !== qSig) {
      qSig = r.sig;
      qPos = -2;
      const frag = document.createDocumentFragment();
      r.rows.forEach((row, i) => {
        const item = el('div', { className: 'qi', role: 'listitem' }, el('span', { className: 'qn' }, String(i + 1)), el('div', { className: 'qt' }, el('b', {}, row.title), row.channel ? el('small', {}, row.channel) : null));
        item.addEventListener('click', row.go);
        frag.append(item);
      });
      e.qlist.replaceChildren(frag);
    }
    if (r.pos !== qPos) {
      const rowsEl = e.qlist.children;
      if (rowsEl[qPos]) rowsEl[qPos].classList.remove('now');
      if (rowsEl[r.pos]) {
        rowsEl[r.pos].classList.add('now');
        const box = e.qlist;
        box.scrollTo({ top: Math.max(0, rowsEl[r.pos].offsetTop - box.clientHeight * 0.3), behavior: qPos === -2 ? 'auto' : 'smooth' });
      }
      qPos = r.pos;
    }
  }

  async function reorderQueue(mode) {
    if (!ui || !YFS.queue) return;
    const e = ui.e;
    e.qshuffle.disabled = e.qai.disabled = true;
    e.qstate.textContent = tr(mode === 'ai' ? 'audio.queueAiWorking' : 'audio.queueShuffling');
    try {
      await YFS.queue.reorderRest(mode);
      e.qstate.textContent = '';
    } catch (err) {
      e.qstate.textContent = err.code === 'ai-no-key' ? tr('focus.needKey') : tr('ai.err.failed', { message: err.message || '' });
    } finally {
      e.qshuffle.disabled = e.qai.disabled = false;
    }
  }

  /** «Далее: …» — следующий ролик в панели плейлиста YouTube (когда нет своей очереди с колонкой). */
  function updateQueue() {
    if (!ui) return;
    renderQueueColumn();
    const block = ui.e.queue;
    const items = Array.from(document.querySelectorAll('ytd-playlist-panel-renderer #items ytd-playlist-panel-video-renderer'));
    const i = items.findIndex((x) => x.hasAttribute('selected'));
    const next = i >= 0 ? items[i + 1] : null;
    const title = next && (next.querySelector('#video-title') || {}).textContent;
    block.hidden = !(inQueue() && title) || !ui.e.qcol.hidden;
    if (title) block.querySelector('p').textContent = `${title.trim()}${items.length ? `  ·  ${i + 1}/${items.length}` : ''}`;
  }

  /**
   * Обложка следующего трека подменяется только после загрузки картинки: до этого видна прежняя,
   * экран не «мигает» пустым фоном. maxres есть не у всех роликов (у них YouTube отдаёт заглушку 120×90) — тогда hq.
   */
  function swapCover(id) {
    const e = ui.e;
    e.cover.dataset.id = id;
    const max = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
    const hq = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    const apply = (url) => {
      if (!ui || ui.e.cover.dataset.id !== id) return;
      ui.e.cover.style.backgroundImage = `url("${url}")`;
      ui.e.bg.style.backgroundImage = `url("${hq}")`;
    };
    const img = new Image();
    img.onload = () => apply(img.naturalWidth > 120 ? max : hq);
    img.onerror = () => apply(hq);
    img.src = max;
  }

  function showVideo() {
    const v = W.currentVideo();
    if (!ui || !v) return;
    const e = ui.e;
    if (e.cover.dataset.id !== v.id) swapCover(v.id);
    e.title.textContent = v.title || '';
    e.channel.textContent = v.channel || '';
    if (v.id !== videoId) {
      videoId = v.id;
      lyricsFor = '';
      userTab = false;
      views.lyrics.segs = [];
      views.lyrics.cur = -1;
      e.lyrics.replaceChildren();
      setLyricsState('');
      if (tab === 'lyrics') setTab('text'); // у нового ролика текст песни ещё не искали
      loadText(v.id);
      loadMusic(v);
    }
    updateQueue();
    updateSleep();
    updateControls();
  }

  // ---------- вкл/выкл ----------

  function isOn() {
    return !!(ui && ui.host.isConnected);
  }

  function remember(on) {
    try {
      if (on) sessionStorage.setItem(SESSION_KEY, '1');
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* без запоминания */
    }
  }

  function toggle(force) {
    const on = typeof force === 'boolean' ? force : !isOn();
    if (on === isOn()) return on;
    if (on && (!W.currentVideo() || location.pathname !== '/watch')) return false;
    remember(on);
    if (on) {
      W.closePanel();
      if (!ui) build();
      (document.body || document.documentElement).append(ui.host);
      document.documentElement.style.setProperty('overflow', 'hidden', 'important'); // страница под экраном не листается
      showVideo();
      ui.e.screen.focus();
      setTimeout(() => scrollView(views[tab], true), 30); // после повторного открытия список снова на текущей строке
      planSig = '';
      updateFocus();
      if (YFS.askPage) YFS.askPage('quality', 'low', 3000);
    } else {
      ui.host.remove();
      document.documentElement.style.removeProperty('overflow');
      if (YFS.askPage) YFS.askPage('quality', 'normal', 3000);
    }
    return on;
  }

  document.addEventListener('yfs:focus-change', () => isOn() && updateFocus());
  // Новый язык: экран собирается заново (подписи кнопок, вкладок, подсказки), режим остаётся включённым.
  document.addEventListener('yfs:lang-change', () => {
    if (!ui) return;
    const wasOn = isOn();
    const keepTab = tab;
    const keepUserTab = userTab;
    ui.host.remove();
    ui = null;
    videoId = '';
    planSig = '';
    qSig = '';
    if (wasOn) {
      toggle(true);
      if (keepUserTab) setTab(keepTab, true);
    }
  });
  document.addEventListener('yfs:queue-change', () => isOn() && updateQueue());
  for (const type of ['play', 'pause', 'timeupdate', 'durationchange', 'ratechange', 'seeked', 'loadedmetadata', 'volumechange']) document.addEventListener(type, onMedia, true);

  // Следующий ролик (автовоспроизведение, плейлист) — экран остаётся, содержимое обновляется.
  document.addEventListener('yt-navigate-finish', () => {
    if (!isOn()) return;
    if (location.pathname !== '/watch') return toggle(false);
    setTimeout(() => {
      showVideo();
      if (YFS.askPage) YFS.askPage('quality', 'low', 3000);
    }, 300);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || sender.id !== chrome.runtime.id || msg.type !== 'yfs:audio-toggle') return;
    YFS.i18n.init({ applyToPage: false }).then(() => sendResponse({ ok: true, on: toggle() }), () => sendResponse({ ok: false }));
    return true;
  });

  const stopLoop = YFS.loop.every(
    3000,
    () => {
      if (!W.alive()) {
        stopLoop();
        if (ui) ui.host.remove();
        document.documentElement.style.removeProperty('overflow');
        return;
      }
      if (isOn()) updateQueue(); // панель плейлиста YouTube дорисовывается не сразу
    },
    { hidden: true } // таймер сна должен сработать и в фоновой вкладке
  );

  YFS.audioMode = {
    toggle: (f) => toggle(f),
    get on() {
      return isOn();
    },
    get musicQuery() {
      return musicQuery;
    },
    get track() {
      return trackInfo;
    },
  };

  // После перезагрузки вкладки в аудио-режиме (или после «🎵 Слушать подряд») — вернуться в него.
  let wanted = false;
  try {
    wanted = sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    wanted = false;
  }
  if (wanted) {
    YFS.i18n.init({ applyToPage: false }).then(() => {
      const tryOn = (n) => (W.currentVideo() && location.pathname === '/watch' ? toggle(true) : n > 0 && setTimeout(() => tryOn(n - 1), 500));
      tryOn(10);
    });
  }
})();
