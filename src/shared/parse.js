/*
 * Извлечение роликов из внутренних JSON-ответов YouTube (ytInitialData,
 * /youtubei/v1/browse, .data у элементов ленты) и запасной разбор DOM.
 *
 * YouTube отдаёт карточки в нескольких форматах:
 *   - videoRenderer            — классический формат (главная, история);
 *   - playlistVideoRenderer    — строки плейлиста («Посмотреть позже»);
 *   - lockupViewModel          — новый формат (с 2025 года);
 *   - reelItemRenderer / shortsLockupViewModel — Shorts.
 * Рекламу, миксы, плейлисты и посты парсер пропускает.
 * В истории ролики сгруппированы по дням: подпись секции попадает в dayLabel.
 */
(function (root) {
  'use strict';

  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const DURATION_RE = /^\d+(:\d{1,2}){1,2}$/;
  const SKIP_KEY_RE =
    /^(adSlotRenderer|promoted\w*Renderer|\w*AdLayout\w*|bannerPromoRenderer|statementBannerRenderer|brandVideo\w*Renderer|primetimePromoRenderer|mealbarPromoRenderer|masthead|frameworkUpdates|responseContext|topbar|header|menu|loggingDirectives)$/;

  function text(t) {
    if (!t) return '';
    if (typeof t === 'string') return t.trim();
    if (typeof t.simpleText === 'string') return t.simpleText.trim();
    if (typeof t.content === 'string') return t.content.trim();
    if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || '').join('').trim();
    return '';
  }

  /** Первый объект под ключом `key` (поиск в глубину), прошедший проверку `test`. */
  function find(node, key, test, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 25) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = find(item, key, test, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (!v || typeof v !== 'object') continue;
      if (k === key && (!test || test(v))) return v;
      const hit = find(v, key, test, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  function findAll(node, key, out = [], depth = 0) {
    if (!node || typeof node !== 'object' || depth > 25) return out;
    if (Array.isArray(node)) {
      for (const item of node) findAll(item, key, out, depth + 1);
      return out;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (!v || typeof v !== 'object') continue;
      if (k === key) out.push(v);
      else findAll(v, key, out, depth + 1);
    }
    return out;
  }

  /** Из списка картинок берём ближайшую к размеру аватара (~68px). */
  function pickImage(list) {
    if (!Array.isArray(list) || !list.length) return '';
    const best = list
      .filter((i) => i && i.url)
      .sort((a, b) => Math.abs((a.width || 68) - 68) - Math.abs((b.width || 68) - 68))[0];
    if (!best) return '';
    return best.url.startsWith('//') ? 'https:' + best.url : best.url;
  }

  function channelPath(endpoint) {
    if (!endpoint) return '';
    if (endpoint.canonicalBaseUrl) return endpoint.canonicalBaseUrl;
    return endpoint.browseId ? '/channel/' + endpoint.browseId : '';
  }

  function fromVideoRenderer(r) {
    if (!ID_RE.test(r.videoId || '')) return null;
    let watched = 0;
    let timeStatus = null;
    for (const o of r.thumbnailOverlays || []) {
      if (o.thumbnailOverlayResumePlaybackRenderer) {
        watched = Number(o.thumbnailOverlayResumePlaybackRenderer.percentDurationWatched) || 0;
      }
      if (o.thumbnailOverlayTimeStatusRenderer) timeStatus = o.thumbnailOverlayTimeStatusRenderer;
    }
    const badgeStyles = (r.badges || []).map((b) => (b.metadataBadgeRenderer && b.metadataBadgeRenderer.style) || '');
    const live = badgeStyles.some((s) => /LIVE/.test(s)) || (timeStatus && timeStatus.style === 'LIVE') || false;
    const upcoming = !!r.upcomingEventData || (timeStatus && timeStatus.style === 'UPCOMING') || false;
    const nav = r.navigationEndpoint || {};
    const url = (nav.commandMetadata && nav.commandMetadata.webCommandMetadata && nav.commandMetadata.webCommandMetadata.url) || '';
    const short = !!nav.reelWatchEndpoint || url.startsWith('/shorts/') || (timeStatus && timeStatus.style === 'SHORTS') || false;
    const owner = r.ownerText || r.longBylineText || r.shortBylineText;
    const ownerEndpoint = find(owner, 'browseEndpoint');
    const statusText = timeStatus ? text(timeStatus.text) : '';
    const thumbs = r.channelThumbnailSupportedRenderers && r.channelThumbnailSupportedRenderers.channelThumbnailWithLinkRenderer;

    return {
      id: r.videoId,
      title: text(r.title),
      channel: text(owner),
      channelUrl: channelPath(ownerEndpoint),
      avatar: pickImage(thumbs && thumbs.thumbnail && thumbs.thumbnail.thumbnails),
      duration: text(r.lengthText) || (DURATION_RE.test(statusText) ? statusText : ''),
      views: text(r.shortViewCountText) || text(r.viewCountText),
      published: text(r.publishedTimeText),
      live,
      upcoming,
      short,
      watched,
    };
  }

  const VIEWS_RE = /(просмотр|зрител|смотрят|переглянут|view|watching)/i;

  /**
   * Строки метаданных lockup бывают в двух видах:
   *   [канал] / [просмотры, дата]                      — две строки;
   *   [канал, «и соавтор», «3,3 млн» ▶, «4 дн. назад»] — одна строка (2026).
   * Поэтому ищем часть с просмотрами (иконка PLAY_ARROW или слово «просмотров»),
   * всё до неё — канал (с соавторами), первая часть после — дата.
   */
  function lockupMetadata(meta) {
    const rows = (meta.metadata && meta.metadata.contentMetadataViewModel && meta.metadata.contentMetadataViewModel.metadataRows) || [];
    const parts = [];
    for (const row of rows) {
      for (const p of row.metadataParts || []) {
        const t = text(p.text);
        if (!t) continue;
        parts.push({ text: t, label: p.accessibilityLabel || '', icon: (p.leadingIcon && p.leadingIcon.name) || '' });
      }
    }
    if (!parts.length) return { channel: '', views: '', published: '' };

    const vi = parts.findIndex((p) => /^PLAY_ARROW/.test(p.icon) || VIEWS_RE.test(p.text) || VIEWS_RE.test(p.label));
    if (vi > 0) {
      const v = parts[vi];
      return {
        channel: parts.slice(0, vi).map((p) => p.text).join(' '),
        // «3,3 млн» с иконкой вместо слова → берём полную подпись «3,3 миллиона просмотров»
        views: v.icon && v.label ? v.label : v.text,
        published: parts[vi + 1] ? parts[vi + 1].text : '',
      };
    }
    return {
      channel: parts[0].text,
      views: '',
      published: parts.length > 1 ? parts[parts.length - 1].text : '',
    };
  }

  function isLiveBadge(badge) {
    return /LIVE/.test(badge.badgeStyle || '') || /"(imageName|iconName|name)":"LIVE/.test(JSON.stringify(badge));
  }

  function fromLockup(l) {
    const type = l.contentType || '';
    if (type && type !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null; // миксы, плейлисты, подкасты
    const cmd = (l.rendererContext && l.rendererContext.commandContext && l.rendererContext.commandContext.onTap &&
      l.rendererContext.commandContext.onTap.innertubeCommand) || {};
    const url = (cmd.commandMetadata && cmd.commandMetadata.webCommandMetadata && cmd.commandMetadata.webCommandMetadata.url) || '';
    const id = (cmd.watchEndpoint && cmd.watchEndpoint.videoId) || (cmd.reelWatchEndpoint && cmd.reelWatchEndpoint.videoId) || l.contentId;
    if (!ID_RE.test(id || '')) return null;

    const meta = (l.metadata && l.metadata.lockupMetadataViewModel) || {};
    const info = lockupMetadata(meta);
    const channelEndpoint = find(meta, 'browseEndpoint', (e) => /^UC/.test(e.browseId || ''));
    const avatarVm = find(meta.image, 'avatarViewModel');

    const thumb = (l.contentImage && l.contentImage.thumbnailViewModel) || {};
    let duration = '';
    let live = false;
    for (const badge of findAll(thumb, 'thumbnailBadgeViewModel')) {
      const t = text(badge.text);
      if (isLiveBadge(badge)) live = true;
      else if (DURATION_RE.test(t)) duration = t;
    }
    const progress = find(thumb, 'thumbnailOverlayProgressBarViewModel');
    const short = !!cmd.reelWatchEndpoint || url.startsWith('/shorts/');

    return {
      id,
      title: text(meta.title),
      channel: info.channel,
      channelUrl: channelPath(channelEndpoint),
      avatar: pickImage(avatarVm && avatarVm.image && avatarVm.image.sources),
      duration,
      views: info.views,
      published: info.published,
      live,
      // На главной у обычного ролика всегда есть плашка длительности;
      // её нет только у трансляций и запланированных премьер.
      upcoming: !duration && !live && !short,
      short,
      watched: progress ? Number(progress.startPercent) || 0 : 0,
    };
  }

  function fromReelItem(r) {
    if (!ID_RE.test(r.videoId || '')) return null;
    return {
      id: r.videoId,
      title: text(r.headline),
      views: text(r.viewCountText),
      short: true,
    };
  }

  function fromShortsLockup(s) {
    const cmd = (s.onTap && s.onTap.innertubeCommand) || {};
    const id = (cmd.reelWatchEndpoint && cmd.reelWatchEndpoint.videoId) || String(s.entityId || '').replace(/^shorts-shelf-item-/, '');
    if (!ID_RE.test(id || '')) return null;
    const overlay = s.overlayMetadata || {};
    return {
      id,
      title: text(overlay.primaryText) || text(s.accessibilityText),
      views: text(overlay.secondaryText),
      short: true,
    };
  }

  function formatSeconds(total) {
    const s = Math.round(Number(total));
    if (!(s > 0)) return '';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  /** Строка плейлиста («Посмотреть позже»): почти videoRenderer, но просмотры и дата лежат в videoInfo. */
  function fromPlaylistVideo(r) {
    if (r.isPlayable === false) return null; // «Видео удалено», «Видео скрыто»
    const v = fromVideoRenderer(r);
    if (!v) return null;
    const info = ((r.videoInfo && r.videoInfo.runs) || []).map((x) => (x.text || '').trim()).filter((t) => t && t !== '•');
    if (!v.views) v.views = info[0] || '';
    if (!v.published) v.published = info[1] || '';
    if (!v.duration) v.duration = formatSeconds(r.lengthSeconds);
    return v;
  }

  const PARSERS = {
    videoRenderer: fromVideoRenderer,
    gridVideoRenderer: fromVideoRenderer,
    compactVideoRenderer: fromVideoRenderer, // боковая колонка рекомендаций (старый формат)
    playlistVideoRenderer: fromPlaylistVideo,
    lockupViewModel: fromLockup,
    reelItemRenderer: fromReelItem,
    shortsLockupViewModel: fromShortsLockup,
  };

  // ---------- 🧠 выученные «рецепты»: ремонт парсера с помощью ИИ ----------
  //
  // Если YouTube ввёл новый формат карточек, общий поиск (extractGeneric) всё равно находит id, а основной
  // парсер — нет. Тогда Gemini получает обрезанный «скелет» таких карточек и возвращает рецепт:
  // ключ карточки и пути к полям. Это данные, а не код: рецепт исполняет getPath ниже, и прежде чем
  // его принять, validateRecipe проверяет его на тех же ответах YouTube.

  const learned = new Map(); // ключ карточки → рецепт

  /** Подключить выученные рецепты (из chrome.storage). Известные форматы ими не перекрываются. */
  function setLearned(list) {
    learned.clear();
    for (const r of list || []) if (r && r.renderer && !PARSERS[r.renderer] && r.fields && r.fields.id) learned.set(r.renderer, r);
    return learned.size;
  }

  /** «a.b[0].c[*].d» → ['a', 'b', 0, 'c', '*', 'd']. */
  function parsePath(path) {
    const out = [];
    for (const part of String(path || '').split('.')) {
      const m = part.match(/^([^[\]]*)((?:\[(?:\d+|\*)\])*)$/);
      if (!m) return null;
      if (m[1]) out.push(m[1]);
      for (const ix of m[2].match(/\[(\d+|\*)\]/g) || []) out.push(ix === '[*]' ? '*' : Number(ix.slice(1, -1)));
    }
    return out;
  }

  function valueText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    return text(v);
  }

  /** Значение по пути рецепта; [*] — первый элемент массива, для которого остаток пути не пуст. */
  function getPath(node, path) {
    const tokens = parsePath(path);
    if (!tokens || !tokens.length) return undefined;
    const go = (n, i) => {
      if (i === tokens.length) return n;
      if (n === null || n === undefined || typeof n !== 'object') return undefined;
      const tk = tokens[i];
      if (tk === '*') {
        if (!Array.isArray(n)) return undefined;
        for (const x of n) {
          const v = go(x, i + 1);
          if (valueText(v)) return v;
        }
        return undefined;
      }
      if (typeof tk === 'number') return Array.isArray(n) ? go(n[tk], i + 1) : undefined;
      return go(n[tk], i + 1);
    };
    return go(node, 0);
  }

  function fromRecipe(node, recipe) {
    const f = recipe.fields || {};
    const val = (p) => (p ? valueText(getPath(node, p)) : '');
    const id = val(f.id);
    if (!ID_RE.test(id)) return null;
    let duration = val(f.duration);
    if (/^\d+$/.test(duration)) duration = formatSeconds(duration);
    if (duration && !DURATION_RE.test(duration)) duration = '';
    return {
      id,
      title: val(f.title),
      channel: val(f.channel),
      duration,
      views: val(f.views),
      published: val(f.published),
      short: !!(recipe.short && getPath(node, recipe.short) !== undefined),
    };
  }

  const CARD_KEY_RE = /(Renderer|ViewModel)$/;
  // Обёртки списков и полок: карточкой они не бывают, даже если внутри один ролик.
  const WRAPPER_KEYS = new Set(['richItemRenderer', 'richSectionRenderer', 'itemSectionRenderer', 'sectionListRenderer', 'shelfRenderer', 'richShelfRenderer',
    'gridRenderer', 'horizontalListRenderer', 'expandedShelfContentsRenderer', 'reelShelfRenderer', 'twoColumnBrowseResultsRenderer', 'tabRenderer',
    'richGridRenderer', 'continuationItemRenderer', 'appendContinuationItemsAction', 'reloadContinuationItemsCommand', 'thumbnailViewModel',
    'contentImage', 'thumbnailOverlayViewModel', 'avatarViewModel', 'decoratedAvatarViewModel']);

  /** Разные id роликов в поддереве (до limit). */
  function idsIn(node, limit = 3, out = new Set(), depth = 0) {
    if (!node || typeof node !== 'object' || depth > 30 || out.size >= limit) return out;
    if (Array.isArray(node)) {
      for (const x of node) idsIn(x, limit, out, depth + 1);
      return out;
    }
    if (typeof node.videoId === 'string' && ID_RE.test(node.videoId)) out.add(node.videoId);
    if (node.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && ID_RE.test(node.contentId || '')) out.add(node.contentId);
    for (const k of Object.keys(node)) if (out.size < limit) idsIn(node[k], limit, out, depth + 1);
    return out;
  }

  /**
   * Карточки нового формата вокруг id, которые основной парсер не нашёл: для каждого id — самый внешний
   * объект с ключом «…Renderer» / «…ViewModel», внутри которого только этот ролик (не обёртка списка).
   * Ответ: до max карточек одного, самого частого ключа: [{ key, node, id }].
   */
  function findCards(datas, ids, max = 3) {
    const want = new Set(ids || []);
    const found = [];
    const seen = new Set();
    const visit = (node, stack, depth) => {
      if (!node || typeof node !== 'object' || depth > 60) return;
      if (Array.isArray(node)) {
        for (const x of node) visit(x, stack, depth + 1);
        return;
      }
      const vid = typeof node.videoId === 'string' ? node.videoId : node.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' ? node.contentId : '';
      if (vid && want.has(vid) && !seen.has(vid)) {
        for (const entry of stack) {
          if (!CARD_KEY_RE.test(entry.key) || WRAPPER_KEYS.has(entry.key) || PARSERS[entry.key]) continue;
          if (idsIn(entry.node).size <= 1) {
            seen.add(vid);
            found.push({ key: entry.key, node: entry.node, id: vid });
            break;
          }
        }
      }
      for (const k of Object.keys(node)) {
        if (SKIP_KEY_RE.test(k)) continue;
        const v = node[k];
        if (v && typeof v === 'object') {
          stack.push({ key: k, node: v });
          visit(v, stack, depth + 1);
          stack.pop();
        }
      }
    };
    for (const d of datas || []) visit(d, [], 0);
    const byKey = new Map();
    for (const c of found) byKey.set(c.key, [...(byKey.get(c.key) || []), c]);
    const best = Array.from(byKey.values()).sort((a, b) => b.length - a.length)[0] || [];
    return best.slice(0, max);
  }

  const SKELETON_DROP = /^(trackingParams|clickTrackingParams|loggingDirectives|loggingContext|visibleTrackingParams|impressionLoggingInfo|serializedShareEntity|accessibilityContext)$/;

  /** Обрезанная копия карточки для модели: строки до 60 знаков, массивы до 3 элементов, без служебных полей. */
  function skeleton(node, depth = 0, budget = { n: 0 }) {
    if (budget.n > 7000) return '…';
    if (typeof node === 'string') {
      budget.n += Math.min(node.length, 60) + 4;
      return node.length > 60 ? node.slice(0, 57) + '…' : node;
    }
    if (!node || typeof node !== 'object') return node;
    if (depth > 18) return '…';
    if (Array.isArray(node)) return node.slice(0, 3).map((x) => skeleton(x, depth + 1, budget));
    const out = {};
    for (const k of Object.keys(node)) {
      if (SKELETON_DROP.test(k)) continue;
      budget.n += k.length + 3;
      out[k] = skeleton(node[k], depth + 1, budget);
    }
    return out;
  }

  /**
   * Проверить рецепт на тех же ответах YouTube: находит ли он пропавшие ролики (missing), есть ли названия,
   * не тащит ли лишнего (всё найденное должно быть среди id общего поиска — known).
   * Ответ: { ok, found, total, produced, titled, videos }.
   */
  function validateRecipe(recipe, datas, missing, known) {
    if (!recipe || !recipe.renderer || !recipe.fields || !recipe.fields.id || PARSERS[recipe.renderer]) return { ok: false, found: 0, total: (missing || []).length, produced: 0, titled: 0, videos: [] };
    const saved = new Map(learned);
    learned.clear();
    learned.set(recipe.renderer, recipe);
    const videos = [];
    try {
      for (const d of datas || []) videos.push(...extractVideos(d).filter((v) => v.source === 'recipe:' + recipe.renderer));
    } finally {
      learned.clear();
      for (const [k, v] of saved) learned.set(k, v);
    }
    const ids = new Set(videos.map((v) => v.id));
    const want = new Set(missing || []);
    const allowed = new Set([...(known || []), ...want]);
    const found = [...want].filter((id) => ids.has(id)).length;
    const titled = videos.filter((v) => v.title).length;
    const stray = [...ids].filter((id) => !allowed.has(id)).length;
    const ok = want.size > 0 && found >= Math.min(3, want.size) && found >= want.size * 0.5 && titled >= videos.length * 0.7 && stray <= Math.max(1, ids.size * 0.1);
    return { ok, found, total: want.size, produced: ids.size, titled, videos };
  }

  /** Подпись секции истории («Сегодня», «Вчера», «3 окт.») — ищем первое поле title в заголовке. */
  function headerLabel(header, depth = 0) {
    if (!header || typeof header !== 'object' || depth > 8) return '';
    for (const k of Object.keys(header)) {
      const v = header[k];
      if (k === 'title') {
        const t = typeof v === 'string' ? v.trim() : text(v);
        if (t) return t;
      }
      if (v && typeof v === 'object') {
        const t = headerLabel(v, depth + 1);
        if (t) return t;
      }
    }
    return '';
  }

  function walk(node, out, depth, day) {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, out, depth + 1, day);
      return;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (!value || typeof value !== 'object' || SKIP_KEY_RE.test(key)) continue;
      const recipe = !PARSERS[key] && learned.get(key);
      const parser = PARSERS[key] || (recipe ? (v) => fromRecipe(v, recipe) : null);
      if (parser) {
        const video = parser(value);
        if (video) {
          if (day) video.dayLabel = day;
          video.source = (recipe ? 'recipe:' : 'renderer:') + key;
          video.url = rawUrl(value, video.id) || canonicalPath(video);
          out.push(video);
        }
        continue;
      }
      // В истории каждая секция — один день, его название в заголовке секции.
      const sectionDay = key === 'itemSectionRenderer' ? headerLabel(value.header) || day : day;
      walk(value, out, depth + 1, sectionDay);
    }
  }

  /** Все ролики из JSON-ответа YouTube в порядке ленты (дубликаты не убираются). */
  function extractVideos(data) {
    const out = [];
    walk(data, out, 0, '');
    return out;
  }

  // ---------- ID-first: общий поиск, если известные форматы сломались ----------

  const WATCH_URL_RE = /(?:[?&]v=|\/shorts\/|youtu\.be\/|\/embed\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;
  const THUMB_URL_RE = /i\.ytimg\.com\/(?:vi|vi_webp)\/([A-Za-z0-9_-]{11})\//;
  // Миксы и плейлисты содержат videoId первого ролика — в общем поиске их пропускаем.
  const GENERIC_SKIP_RE = /^(radioRenderer|compactRadioRenderer|playlistRenderer|gridPlaylistRenderer|compactPlaylistRenderer|playlistEditEndpoint|addToPlaylistCommand|thumbnailHoverOverlayToggleActionsViewModel)$/;

  function canonicalPath(v) {
    return v.short ? `/shorts/${v.id}` : `/watch?v=${v.id}`;
  }

  /** Исходная ссылка на ролик из самого объекта (navigationEndpoint и т. п.). */
  function rawUrl(node, id, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8) return '';
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (k === 'url' && typeof v === 'string' && (v.startsWith('/watch') || v.startsWith('/shorts/')) && v.includes(id)) return v;
      if (v && typeof v === 'object' && !SKIP_KEY_RE.test(k)) {
        const hit = rawUrl(v, id, depth + 1);
        if (hit) return hit;
      }
    }
    return '';
  }

  /** Название рядом с найденным id: у самого объекта или у ближайших предков в пределах одной карточки. */
  function nearbyTitle(stack) {
    for (let i = stack.length - 1, steps = 0; i >= 0 && steps < 8; i--, steps++) {
      const o = stack[i];
      if (o === LIST_BOUNDARY) break; // выше — уже список карточек или полка
      const t =
        text(o.title) ||
        text(o.headline) ||
        text(o.metadata && o.metadata.lockupMetadataViewModel && o.metadata.lockupMetadataViewModel.title) ||
        text(o.overlayMetadata && o.overlayMetadata.primaryText);
      if (t) return t;
    }
    return '';
  }

  const LIST_BOUNDARY = {};

  /**
   * Общий извлекатель: не зависит от имён renderer'ов. Ищет признаки ролика —
   * поле videoId, contentId видео, ссылки /watch?v= и /shorts/, превью i.ytimg.com/vi/ID.
   * Порядок — по первому появлению в JSON.
   */
  function extractGeneric(data) {
    const byId = new Map();
    const out = [];
    const add = (id, props) => {
      if (!ID_RE.test(id)) return;
      let v = byId.get(id);
      if (!v) {
        v = { id, title: '', url: '', source: props.source };
        byId.set(id, v);
        out.push(v);
      }
      if (!v.title && props.title) v.title = props.title;
      if (!v.url && props.url) v.url = props.url;
      if (props.short) v.short = true;
      // Более надёжный признак повышает источник: thumb < url < id.
      const rank = { 'json-thumb': 0, 'json-url': 1, 'json-id': 2 };
      if (rank[props.source] > rank[v.source]) v.source = props.source;
    };

    const visit = (node, stack, key, depth) => {
      if (depth > 60 || !node) return;
      if (typeof node === 'string') {
        if (node.length > 2000) return;
        let m = node.match(WATCH_URL_RE);
        if (m && /youtube|^\/(watch|shorts)|youtu\.be/.test(node)) {
          add(m[1], { source: 'json-url', url: node.startsWith('/') ? node : '', short: node.includes('/shorts/'), title: nearbyTitle(stack) });
        } else if ((m = node.match(THUMB_URL_RE))) {
          add(m[1], { source: 'json-thumb' });
        }
        return;
      }
      if (typeof node !== 'object') return;
      if (Array.isArray(node)) {
        stack.push(LIST_BOUNDARY);
        for (const item of node) visit(item, stack, key, depth + 1);
        stack.pop();
        return;
      }
      if (node.contentType && node.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' && /^LOCKUP_CONTENT_TYPE_/.test(node.contentType)) return;
      stack.push(node);
      if (typeof node.videoId === 'string' && ID_RE.test(node.videoId)) {
        add(node.videoId, { source: 'json-id', title: nearbyTitle(stack), short: key === 'reelWatchEndpoint' });
      } else if (node.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && ID_RE.test(node.contentId || '')) {
        add(node.contentId, { source: 'json-id', title: nearbyTitle(stack) });
      }
      for (const k of Object.keys(node)) {
        if (SKIP_KEY_RE.test(k) || GENERIC_SKIP_RE.test(k)) continue;
        visit(node[k], stack, k, depth + 1);
      }
      stack.pop();
    };
    visit(data, [], '', 0);
    return out;
  }

  /** Объединяет списки по id: порядок — по первому появлению, пустые поля дополняются из следующих списков. */
  function mergeVideos(lists) {
    const byId = new Map();
    for (const list of lists) {
      for (const v of list || []) {
        if (!v || !ID_RE.test(v.id || '')) continue;
        const prev = byId.get(v.id);
        if (!prev) {
          byId.set(v.id, { ...v });
          continue;
        }
        for (const key of ['title', 'channel', 'channelUrl', 'avatar', 'duration', 'views', 'published', 'dayLabel', 'url']) {
          if (!prev[key] && v[key]) prev[key] = v[key];
        }
        prev.short = !!(prev.short || v.short);
        prev.watched = Math.max(prev.watched || 0, v.watched || 0);
      }
    }
    return Array.from(byId.values());
  }

  /**
   * Насколько уверены, что это действительно ролик ленты:
   *   high   — id + название + канал (превью строится из id);
   *   medium — id из явного поля или ссылки;
   *   low    — только подозрительная ссылка или превью.
   */
  function confidence(v) {
    if (v.title && v.channel) return 'high';
    if (v.title || /^(renderer:|json-id|json-url|dom-link)/.test(v.source || '')) return 'medium';
    return 'low';
  }

  /**
   * Детектор поломки: сравниваем основной парсер с общим поиском и ссылками на странице.
   * suspicious → собираем всё, что нашли, хотя бы по ID.
   */
  function assessHealth(primary, generic, links) {
    const p = primary.length;
    const ref = Math.max(generic.length, links.length);
    const noTitle = primary.filter((v) => !v.title).length;
    const reasons = [];
    if (p === 0 && ref > 0) reasons.push('primary-empty');
    else if (ref >= 8 && p < ref * 0.5) reasons.push('primary-low');
    if (p >= 5 && noTitle / p > 0.3) reasons.push('titles-missing');
    return { primary: p, generic: generic.length, links: links.length, noTitle, suspicious: reasons.length > 0, reasons };
  }

  /** Основной результат, а при подозрении на поломку — объединение со всеми запасными стратегиями. */
  function withFallback(primaryLists, genericLists, links = []) {
    const primary = mergeVideos(primaryLists);
    const generic = mergeVideos(genericLists);
    const health = assessHealth(primary, generic, links);
    const videos = health.suspicious ? mergeVideos([primary, generic, links]) : primary;
    health.recovered = videos.length - primary.length;
    return { videos, health };
  }

  // ---------- Даты в истории ----------

  const MONTHS = [/^(янв|jan)/, /^(фев|feb)/, /^(мар|mar)/, /^(апр|apr)/, /^(ма[йя]|may)/, /^(июн|jun)/,
    /^(июл|jul)/, /^(авг|aug)/, /^(сен|sep)/, /^(окт|oct)/, /^(ноя|nov)/, /^(дек|dec)/];
  const WEEKDAYS = [/^(воскр|sun)/, /^(понед|mon)/, /^(вторн|tue)/, /^(сред|wed)/, /^(четв|thu)/, /^(пятн|fri)/, /^(субб|sat)/];

  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * Заголовок дня из истории → "YYYY-MM-DD" (локальная дата) или null.
   * Понимает русский и английский интерфейс: «Сегодня», «Вчера», «Понедельник»,
   * «3 окт.», «3 октября 2025 г.», "Oct 3", "Oct 3, 2025".
   */
  function parseDayLabel(label, now = new Date()) {
    const s = String(label || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return null;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysAgo = (n) => {
      const d = new Date(today);
      d.setDate(d.getDate() - n);
      return ymd(d);
    };
    if (/^(сегодня|today)$/.test(s)) return daysAgo(0);
    if (/^(вчера|yesterday)$/.test(s)) return daysAgo(1);
    if (!/\d/.test(s)) {
      const wd = WEEKDAYS.findIndex((re) => re.test(s));
      if (wd === -1) return null;
      let diff = (today.getDay() - wd + 7) % 7;
      if (diff < 2) diff += 7; // «Сегодня» и «Вчера» YouTube называет словами
      return daysAgo(diff);
    }
    let day;
    let mon;
    let year;
    let m = s.match(/^(\d{1,2})\s+([a-zа-яё]+)\.?(?:\s+(\d{4}))?/);
    if (m) [, day, mon, year] = m;
    else if ((m = s.match(/^([a-zа-яё]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/))) [, mon, day, year] = m;
    else return null;
    const month = MONTHS.findIndex((re) => re.test(mon));
    if (month === -1 || +day < 1 || +day > 31) return null;
    let d = new Date(year ? +year : today.getFullYear(), month, +day);
    if (!year && d > today) d = new Date(today.getFullYear() - 1, month, +day);
    return ymd(d);
  }

  /** Ответ продолжения, который полностью заменяет ленту (например, выбран чип-категория). */
  function isFeedReload(data) {
    return !!find(data, 'reloadContinuationItemsCommand', (c) => c.slot === 'RELOAD_CONTINUATION_SLOT_BODY');
  }

  // ---------- Запасной вариант: разбор DOM ----------

  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function scrapeDom(scope) {
    const out = [];
    for (const item of scope.querySelectorAll('ytd-rich-item-renderer')) {
      if (item.querySelector('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer')) continue;
      const link = item.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]');
      if (!link) continue;
      const href = link.getAttribute('href') || '';
      const m = href.match(/[?&]v=([A-Za-z0-9_-]{11})/) || href.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
      if (!m) continue;
      // Ссылки на миксы и плейлисты тоже ведут на /watch, но с &list=
      if (/[?&]list=/.test(href) && item.querySelector('yt-collection-thumbnail-view-model, ytd-playlist-thumbnail')) continue;

      const titleEl = item.querySelector(
        '#video-title, h3 [title], [class*="lockup-metadata-view-model"][class*="title"], [class*="ShortsLockupViewModelHostMetadataTitle"], h3'
      );
      const channelLink = Array.from(
        item.querySelectorAll('a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"]')
      ).find((a) => clean(a.textContent));
      const channel = clean(channelLink && channelLink.textContent);
      const avatarImg = item.querySelector('#avatar-link img, [class*="avatar"] img');
      const badges = Array.from(
        item.querySelectorAll('badge-shape, [class*="badge-shape"], ytd-thumbnail-overlay-time-status-renderer')
      ).map((e) => clean(e.textContent));
      const live = !!item.querySelector(
        '[overlay-style="LIVE"], .badge-style-type-live-now-alternate, [class*="thumbnail-live"], [class*="ThumbnailLive"]'
      );
      const stats = Array.from(item.querySelectorAll('#metadata-line span, [class*="metadata-text"]'))
        .map((e) => clean(e.textContent))
        .filter((t) => t && t !== '•' && t !== channel);
      const progressEl = item.querySelector(
        'ytd-thumbnail-overlay-resume-playback-renderer #progress, [class*="ProgressBarSegment"], [class*="progress-bar-segment"]'
      );
      const duration = badges.find((t) => DURATION_RE.test(t)) || '';
      const short = href.startsWith('/shorts/');

      out.push({
        id: m[1],
        title: clean((titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || link.getAttribute('title') || ''),
        channel,
        channelUrl: channelLink ? (channelLink.getAttribute('href') || '').split('?')[0] : '',
        avatar: avatarImg && /^https:/.test(avatarImg.src) ? avatarImg.src : '',
        duration,
        views: stats[0] || '',
        published: stats[1] || '',
        live,
        upcoming: !duration && !live && !short,
        short,
        watched: progressEl ? parseFloat(progressEl.style.width) || 0 : 0,
        source: 'dom-card',
        url: href,
      });
    }
    return out;
  }

  /**
   * Самый общий запасной путь: все ссылки на ролики в области страницы, в порядке DOM.
   * Не знает ничего о карточках — только href, а название берёт из title/aria-label/текста ссылки.
   */
  function scrapeLinks(scope) {
    const byId = new Map();
    for (const a of scope.querySelectorAll('a[href*="/watch?v="], a[href^="/shorts/"]')) {
      if (a.closest('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-playlist-thumbnail, yt-collection-thumbnail-view-model')) continue;
      const href = a.getAttribute('href') || '';
      if (/[?&]list=RD/.test(href)) continue; // миксы
      const m = href.match(WATCH_URL_RE);
      if (!m) continue;
      const label = clean(a.getAttribute('title') || a.getAttribute('aria-label') || a.textContent);
      // Текст ссылки-превью — это обычно длительность, а не название.
      const title = label && !DURATION_RE.test(label) && label.length > 2 ? label : '';
      const prev = byId.get(m[1]);
      if (prev) {
        if (!prev.title && title) prev.title = title;
        continue;
      }
      byId.set(m[1], { id: m[1], title, url: href, short: href.startsWith('/shorts/'), source: 'dom-link' });
    }
    return Array.from(byId.values());
  }

  const api = {
    extractVideos,
    extractGeneric,
    mergeVideos,
    withFallback,
    assessHealth,
    confidence,
    isFeedReload,
    scrapeDom,
    scrapeLinks,
    parseDayLabel,
    text,
    setLearned,
    getPath,
    findCards,
    skeleton,
    validateRecipe,
    get learnedCount() {
      return learned.size;
    },
  };
  root.YFS = root.YFS || {};
  root.YFS.parse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
