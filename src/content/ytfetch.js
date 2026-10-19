/*
 * Текст видео (транскрипт) от имени страницы youtube.com.
 * Общий для фрейма просмотрщика (frame.js) и обычной страницы ролика (watchtools.js):
 * запросы идут с youtube.com с куками пользователя — так же, как кнопка «Показать текст видео».
 *
 * YouTube часто меняет, как отдаёт текст, и у разных людей включены разные эксперименты.
 * Поэтому способов несколько, от быстрых к «тяжёлым»; если не сработал ни один —
 * в ошибке есть .details: что именно ответил каждый способ (видно в панели мелким шрифтом).
 */
(function () {
  'use strict';
  const YFS = (globalThis.YFS = globalThis.YFS || {});
  if (YFS.fetchTranscript) return;
  const T = YFS.transcript;
  const ORIGIN = 'https://www.youtube.com';

  // ---------- запросы к странице и плееру YouTube (hook.js в MAIN world) ----------

  let seq = 0;
  const pending = new Map();
  // Свой канал с номером версии hook.js (HOOK_VERSION): старые копии во вкладке на него не отвечают.
  const HOOK_CHANNEL = 'yfs:tx-v5';
  document.addEventListener(HOOK_CHANNEL + '-response', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg.result);
    }
  });

  function askHook(what, kind, timeout) {
    return new Promise((resolve) => {
      const id = 'tx' + ++seq;
      pending.set(id, resolve);
      setTimeout(() => pending.delete(id) && resolve(null), timeout);
      document.dispatchEvent(new CustomEvent(HOOK_CHANNEL + '-request', { detail: JSON.stringify({ id, what, kind }) }));
    });
  }

  /** Ответ YouTube на «Показать текст видео» (get_transcript / get_panel или текст с экрана) → сегменты. */
  function parseCaptured(hit) {
    if (!hit || !hit.body) return null;
    const json = JSON.parse(hit.body);
    if (hit.kind === 'dom') return { segments: json.filter((x) => x && typeof x.text === 'string'), chapters: [], languages: [] };
    return hit.kind === 'panel' ? T.parsePanelResponse(json) : T.parseTranscriptResponse(json);
  }

  /**
   * Субтитры ролика по ссылке, которую подписал сам плеер (токен pot).
   * Работает, когда панель «Показать текст видео» у YouTube не грузится (ошибка 400).
   */
  async function viaPlayer(videoId, log) {
    const info = await askHook('captions', videoId, 9000);
    if (!info) return log('player:no-answer'), { segments: [], tracks: null };
    if (!info.url) return log(info.tracks && info.tracks.length ? 'player:no-url' : 'player:no-tracks'), { segments: [], tracks: info.tracks };
    // Дорожку (язык звука → по умолчанию → прочее) выбрал hook.js, и ссылка подписана плеером именно для неё:
    // язык в ней менять нельзя — токен привязан к дорожке, иначе ответ пустой.
    const u = new URL(info.url, ORIGIN);
    u.searchParams.set('fmt', 'json3');
    const res = await fetch(u.href, { credentials: 'include' });
    const body = res.ok ? await res.text() : '';
    const segments = body ? T.parseJson3(JSON.parse(body)) : [];
    if (!segments.length) log(`player:${res.ok ? 'empty' : res.status}`);
    return { segments, tracks: info.tracks };
  }

  // ---------- вход в аккаунт: подпись запросов, как у самой страницы YouTube ----------

  function cookie(name) {
    for (const part of document.cookie.split('; ')) {
      const i = part.indexOf('=');
      if (part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
    }
    return '';
  }

  async function sha1hex(s) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Заголовки входа в аккаунт. Без них запросы текста от вошедшего пользователя
   * YouTube отклоняет (400 FAILED_PRECONDITION), хотя на самой странице текст открывается.
   */
  async function authHeaders(cfg) {
    const ts = Math.floor(Date.now() / 1000);
    const parts = [];
    // DATASYNC_ID: «user||» у основного канала, «channel||user» у второго — нужен user.
    const sync = String(cfg.DATASYNC_ID || '').split('||');
    const user = sync[1] || sync[0] || '';
    const schemes = [
      ['SAPISIDHASH', cookie('SAPISID') || cookie('__Secure-3PAPISID')],
      ['SAPISID1PHASH', cookie('__Secure-1PAPISID')],
      ['SAPISID3PHASH', cookie('__Secure-3PAPISID')],
    ];
    for (const [scheme, sid] of schemes) {
      if (!sid) continue;
      parts.push(
        user
          ? `${scheme} ${ts}_${await sha1hex(`${user} ${ts} ${sid} ${ORIGIN}`)}_u`
          : `${scheme} ${ts}_${await sha1hex(`${ts} ${sid} ${ORIGIN}`)}`
      );
    }
    if (!parts.length) return {};
    const h = {
      Authorization: parts.join(' '),
      'X-Origin': ORIGIN,
      'X-Goog-AuthUser': String(cfg.SESSION_INDEX != null ? cfg.SESSION_INDEX : 0),
      'X-Youtube-Bootstrap-Logged-In': 'true',
    };
    if (cfg.DELEGATED_SESSION_ID) h['X-Goog-PageId'] = String(cfg.DELEGATED_SESSION_ID);
    return h;
  }

  // ---------- данные страницы ролика ----------

  /** Текст встроенных скриптов страницы, где лежат ytInitialData, ytInitialPlayerResponse и ytcfg. */
  function inlineScriptsText() {
    return Array.from(document.scripts)
      .map((s) => s.textContent || '')
      .filter((t) => /ytInitialData|ytInitialPlayerResponse|ytcfg\.set/.test(t))
      .join('\n;\n');
  }

  function playerResponseFrom(text) {
    return T.jsonAfter(text, 'ytInitialPlayerResponse = ') || T.jsonAfter(text, 'ytInitialPlayerResponse"] = ');
  }

  function initialDataFrom(text) {
    return T.jsonAfter(text, 'ytInitialData = ') || T.jsonAfter(text, 'ytInitialData"] = ');
  }

  /** Настройки клиента YouTube (ytcfg) — нужны для запроса текста видео от имени этой страницы. */
  function cfgFrom(text) {
    for (let i = text.indexOf('ytcfg.set({'); i >= 0; i = text.indexOf('ytcfg.set({', i + 10)) {
      // Объект настроек бывает ~750 КБ — не обрезаем.
      const o = T.jsonAfter(text.slice(i), 'ytcfg.set(');
      if (o && o.INNERTUBE_CONTEXT) return o;
    }
    return null;
  }

  async function innertube(path, cfg, body) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': String(cfg.INNERTUBE_CONTEXT_CLIENT_NAME || 1),
      'X-Youtube-Client-Version': String(cfg.INNERTUBE_CLIENT_VERSION || (cfg.INNERTUBE_CONTEXT.client || {}).clientVersion || ''),
      'X-Goog-Visitor-Id': String((cfg.INNERTUBE_CONTEXT.client || {}).visitorData || ''),
      ...(await authHeaders(cfg)),
    };
    const res = await fetch(`/youtubei/v1/${path}?prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context: cfg.INNERTUBE_CONTEXT, ...body }),
    });
    return { status: res.status, json: res.ok ? await res.json() : null };
  }

  async function fetchTranscript(videoId, params) {
    const diag = [];
    const log = (s) => diag.push(s);
    const result = (r, source) => ({ chapters: [], languages: [], ...r, title, channel, lengthSec, source });

    // 0. YouTube уже показывал текст этого ролика (пользователь открывал панель) — берём готовый ответ.
    let title = '';
    let channel = '';
    let lengthSec = 0;
    try {
      const r = parseCaptured(await askHook('ytpanel', videoId, 1500));
      if (r && r.segments.length) return result(r, 'youtube');
    } catch {
      /* дальше */
    }

    let text = inlineScriptsText();
    let pr = playerResponseFrom(text);
    // Встроенные данные относятся к первому открытому ролику. После перехода внутри YouTube
    // (страница не перезагружается) они устаревают — тогда берём свежую страницу нужного ролика.
    if (!pr || !pr.videoDetails || pr.videoDetails.videoId !== videoId) {
      try {
        const res = await fetch('/watch?v=' + encodeURIComponent(videoId), { credentials: 'include' });
        text = await res.text();
        pr = playerResponseFrom(text);
      } catch (err) {
        log('page:' + err.message);
      }
    }
    const data = initialDataFrom(text);
    const cfg = cfgFrom(text);
    title = (pr && pr.videoDetails && pr.videoDetails.title) || '';
    channel = (pr && pr.videoDetails && pr.videoDetails.author) || '';
    lengthSec = Number(pr && pr.videoDetails && pr.videoDetails.lengthSeconds) || 0;
    if (!cfg) log('cfg:none');

    // 1. Как кнопка «Показать текст видео» на YouTube (формат 2026: панель get_panel).
    const panel = data && T.findPanelParams(data);
    if (!panel) log('panel:none');
    else if (cfg) {
      try {
        const { status, json } = await innertube('get_panel', cfg, { panelId: panel.panelId, params: panel.params });
        const r = json ? T.parsePanelResponse(json) : null;
        if (r && r.segments.length) return result(r, 'panel');
        log(`panel:${json ? 'empty' : status}`);
      } catch (err) {
        log('panel:' + err.message);
      }
    }

    // 2. Старый способ (get_transcript) — для роликов, где YouTube его ещё отдаёт.
    const p = params || (data && T.findTranscriptParams(data));
    if (!p) log('transcript:none');
    else if (cfg) {
      try {
        const { status, json } = await innertube('get_transcript', cfg, { params: p });
        const r = json ? T.parseTranscriptResponse(json) : null;
        if (r && r.segments.length) return result(r, 'transcript');
        log(`transcript:${json ? 'empty' : status}`);
      } catch (err) {
        log('transcript:' + err.message);
      }
    }

    // 3. Субтитры через плеер — ссылка с токеном pot (как кнопка «Субтитры» в плеере).
    let playerTracks = null;
    try {
      const r = await viaPlayer(videoId, log);
      playerTracks = r.tracks;
      if (r.segments.length) return result({ segments: r.segments }, 'player');
    } catch (err) {
      log('player:' + err.message);
    }

    // 4. Открыть панель «Показать текст видео» самой страницы на мгновение и взять её ответ:
    //    YouTube подписывает этот запрос сам, поэтому способ работает там, где у пользователя открывается текст.
    try {
      const hit = await askHook('ytpanel-open', videoId, 14000);
      const r = parseCaptured(hit);
      if (r && r.segments.length) return result(r, 'youtube');
      log('ytpanel:' + ((hit && hit.error) || (hit ? 'empty' : 'no-answer')));
    } catch (err) {
      log('ytpanel:' + err.message);
    }

    // 5. Запасной путь — ссылка на субтитры из данных страницы (без токена YouTube часто отдаёт пусто).
    const tracks = T.captionTracks(pr);
    const track = T.pickTrack(
      tracks.map((t) => ({ ...t, kind: t.auto ? 'asr' : '' })),
      T.captionHints(pr)
    );
    if (track) {
      try {
        const res = await fetch(track.url + '&fmt=json3', { credentials: 'include' });
        const body = await res.text();
        const segments = body ? T.parseJson3(JSON.parse(body)) : [];
        if (segments.length) return result({ segments }, 'captions');
        log(`captions:${res.ok ? 'empty' : res.status}`);
      } catch (err) {
        log('captions:' + err.message);
      }
    }
    // «Текста нет» — только если у ролика правда нет субтитров; иначе это сбой, и его стоит повторить.
    const hasCaptions = tracks.length > 0 || (playerTracks && playerTracks.length > 0) || !!panel || !!p;
    throw Object.assign(new Error(hasCaptions ? 'transcript-failed' : 'no-transcript'), { details: diag.join(', ') });
  }

  YFS.fetchTranscript = fetchTranscript;
  YFS.askPage = askHook; // команды плееру (hook.js): аудио-режим просит снизить качество видео
})();
