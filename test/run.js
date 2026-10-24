/* Запуск: node test/run.js — проверяет парсер, формат снимка и статистику без браузера. */
'use strict';

const assert = require('node:assert/strict');
const parse = require('../src/shared/parse.js');
const feed = require('../src/shared/feed.js');
const analytics = require('../src/viewer/analytics.js');
const zlib = require('node:zlib');
const fx = require('./fixtures.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('videoRenderer: все поля', () => {
  const [v] = parse.extractVideos(fx.richGrid([fx.videoRenderer()]));
  assert.equal(v.id, 'dQw4w9WgXcQ');
  assert.equal(v.title, 'Классическое видео');
  assert.equal(v.channel, 'Канал Один');
  assert.equal(v.channelUrl, '/@channel1');
  assert.equal(v.duration, '10:23');
  assert.equal(v.views, '1,2 млн просмотров');
  assert.equal(v.published, '3 дня назад');
  assert.equal(v.avatar, 'https://yt3.ggpht.com/avatar1=s68');
  assert.equal(v.watched, 40);
  assert.equal(v.live, false);
  assert.equal(v.short, false);
});

test('lockupViewModel: новый формат карточки', () => {
  const [v] = parse.extractVideos(fx.richGrid([fx.lockup()]));
  assert.equal(v.id, 'aaaaaaaaaaa');
  assert.equal(v.title, 'Новый формат');
  assert.equal(v.channel, 'Канал Два');
  assert.equal(v.channelUrl, '/@channel2');
  assert.equal(v.duration, '1:02:03');
  assert.equal(v.views, '15 тыс. просмотров');
  assert.equal(v.published, '2 недели назад');
  assert.equal(v.avatar, 'https://yt3.ggpht.com/avatar2=s68');
  assert.equal(v.watched, 100);
  assert.equal(v.upcoming, false);
});

test('lockupViewModel: реальная карточка 2026 (одна строка метаданных, соавтор)', () => {
  const [v] = parse.extractVideos(fx.richGrid([fx.lockupReal2026()]));
  assert.equal(v.id, 'pRrmQUm6Zvg');
  assert.equal(v.title, 'Превращаем логотип YouTube в монстра');
  assert.equal(v.channel, 'YouTube и Wicked Makers');
  assert.equal(v.views, '3,3 миллиона просмотров');
  assert.equal(v.published, '4 дн. назад');
  assert.equal(v.duration, '10:06');
  assert.equal(v.live, false);
  assert.equal(v.upcoming, false);
  assert.equal(v.short, false);
  assert.equal(v.watched, 0);
});

test('lockupViewModel: трансляция и премьера', () => {
  const [live, upcoming] = parse.extractVideos(
    fx.richGrid([fx.lockup({ id: 'bbbbbbbbbbb', live: true }), fx.lockup({ id: 'ccccccccccc', noDuration: true })])
  );
  assert.equal(live.live, true);
  assert.equal(live.upcoming, false);
  assert.equal(upcoming.upcoming, true);
});

test('реклама, миксы и посты пропускаются, Shorts помечаются', () => {
  const list = parse.extractVideos(
    fx.richGrid([
      fx.videoRenderer(),
      { adSlotRenderer: { fulfillmentContent: { fulfilledLayout: { inFeedAdLayoutRenderer: { renderingContent: { videoRenderer: { videoId: 'ADADADADADA' } } } } } } },
      fx.lockup({ id: 'RDxxxxxxxxx', type: 'LOCKUP_CONTENT_TYPE_PLAYLIST' }),
      { backstagePostThreadRenderer: { post: {} } },
      fx.shortsShelf(),
    ])
  );
  assert.deepEqual(list.map((v) => v.id), ['dQw4w9WgXcQ', 'sssssssssss', 'ttttttttttt']);
  assert.ok(list.slice(1).every((v) => v.short));
  assert.equal(list[1].title, 'Шорт один');
});

test('продолжение ленты и перезагрузка по чипу', () => {
  const cont = fx.continuation([fx.lockup({ id: 'ddddddddddd' })]);
  assert.deepEqual(parse.extractVideos(cont).map((v) => v.id), ['ddddddddddd']);
  assert.equal(parse.isFeedReload(cont), false);
  assert.equal(parse.isFeedReload(fx.reload([fx.lockup({ id: 'eeeeeeeeeee' })])), true);
});

test('«Посмотреть позже»: playlistVideoRenderer, удалённые ролики пропускаются', () => {
  const list = parse.extractVideos(
    fx.watchLaterPage([
      fx.playlistVideo('wlwlwlwlwl1'),
      fx.playlistVideo('wlwlwlwlwl2', { playable: false }),
      fx.playlistVideo('wlwlwlwlwl3', { lengthText: false }),
      { continuationItemRenderer: {} },
    ])
  );
  assert.deepEqual(list.map((v) => v.id), ['wlwlwlwlwl1', 'wlwlwlwlwl3']);
  const [v, noLength] = list;
  assert.equal(v.channel, 'Канал Три');
  assert.equal(v.channelUrl, '/@channel3');
  assert.equal(v.duration, '7:05');
  assert.equal(v.views, '12 тыс. просмотров');
  assert.equal(v.published, '2 года назад');
  assert.equal(noLength.duration, '7:05'); // из lengthSeconds или плашки
});

test('история: подписи дней из секций, продолжение без заголовка', () => {
  const page = parse.extractVideos(
    fx.historyPage([
      fx.historySection('Сегодня', [fx.historyVideo('hhhhhhhhhh1', 100), fx.historyVideo('hhhhhhhhhh2', 30)]),
      fx.historySection('Вчера', [fx.historyVideo('hhhhhhhhhh3', 50), fx.shortsShelf()]),
    ])
  );
  assert.deepEqual(page.map((v) => [v.id, v.dayLabel]), [
    ['hhhhhhhhhh1', 'Сегодня'],
    ['hhhhhhhhhh2', 'Сегодня'],
    ['hhhhhhhhhh3', 'Вчера'],
    ['sssssssssss', 'Вчера'],
    ['ttttttttttt', 'Вчера'],
  ]);
  assert.equal(page[1].watched, 30);
  const cont = parse.extractVideos(fx.continuation([fx.historyVideo('hhhhhhhhhh4', 10)]));
  assert.equal(cont[0].dayLabel, undefined); // день возьмём у предыдущего ролика
});

test('parseDayLabel: русский и английский интерфейс', () => {
  const now = new Date(2026, 9, 5, 15, 0); // понедельник, 5 октября 2026
  const p = (s) => parse.parseDayLabel(s, now);
  assert.equal(p('Сегодня'), '2026-10-05');
  assert.equal(p('Yesterday'), '2026-10-04');
  assert.equal(p('Суббота'), '2026-10-03');
  assert.equal(p('Пятница'), '2026-10-02');
  assert.equal(p('Monday'), '2026-09-28'); // ровно неделю назад: «сегодня» YouTube называет словом
  assert.equal(p('3 окт.'), '2026-10-03');
  assert.equal(p('15 мая'), '2026-05-15');
  assert.equal(p('12 марта'), '2026-03-12');
  assert.equal(p('25 дек. 2025 г.'), '2025-12-25');
  assert.equal(p('Oct 3'), '2026-10-03');
  assert.equal(p('Dec 25, 2025'), '2025-12-25');
  assert.equal(p('20 нояб.'), '2025-11-20'); // будущая дата без года → прошлый год
  assert.equal(p('Heute'), null);
});

test('снимок v2: несколько лент, порядок, поля истории только в истории', () => {
  const snap = feed.normalizeSnapshot({
    version: 2,
    author: 'Саша',
    feeds: [
      { type: 'shorts', videos: [{ id: 'sssssssssss', title: 'Шорт' }] },
      { type: 'unknown', videos: [{ id: 'xxxxxxxxxxx' }] },
      {
        type: 'history',
        videos: [{ id: 'hhhhhhhhhh1', title: 'Смотрел', watchedDay: '2026-10-05', progress: 42.4 }, { id: 'hhhhhhhhhh2', watchedDay: 'вчера', progress: 0 }],
      },
      { type: 'home', videos: [{ id: 'dQw4w9WgXcQ', title: 'Главная', watchedDay: '2026-10-05', progress: 50 }] },
      { type: 'watch-later', videos: [] },
    ],
  });
  assert.deepEqual(snap.feeds.map((f) => f.type), ['home', 'history', 'shorts']);
  assert.equal(snap.version, 2);
  assert.deepEqual(feed.counts(snap), { home: 1, history: 2, shorts: 1 });
  assert.equal(snap.feeds[0].videos[0].watchedDay, undefined);
  assert.equal(snap.feeds[0].videos[0].progress, undefined);
  assert.equal(snap.feeds[1].videos[0].watchedDay, '2026-10-05');
  assert.equal(snap.feeds[1].videos[0].progress, 42);
  assert.equal(snap.feeds[1].videos[1].watchedDay, undefined);
  assert.equal(snap.feeds[2].videos[0].short, true);
});

test('снимок: чистит опасные и лишние поля', () => {
  const snap = feed.normalizeSnapshot({
    videos: [
      {
        id: 'dQw4w9WgXcQ',
        title: '<img src=x onerror=alert(1)>',
        channelUrl: 'javascript:alert(1)',
        avatar: 'https://evil.example/a.png',
        duration: '10:23; drop',
        watched: 50,
      },
      { id: 'bad id' },
      { id: 'dQw4w9WgXcQ', title: 'дубликат' },
    ],
  });
  const v = snap.feeds[0].videos[0];
  assert.equal(snap.feeds[0].videos.length, 1);
  assert.equal(v.title, '<img src=x onerror=alert(1)>'); // текст оставляем, viewer выводит его через textContent
  assert.equal(v.channelUrl, undefined);
  assert.equal(v.avatar, undefined);
  assert.equal(v.duration, undefined);
  assert.equal(v.watched, undefined);
});

test('снимок: понятные ошибки', () => {
  assert.throws(() => feed.normalizeSnapshot({ format: 'other', videos: [] }), /формат/);
  assert.throws(() => feed.normalizeSnapshot({ version: 99, feeds: [] }), /новой версией/);
  assert.throws(() => feed.normalizeSnapshot({ videos: [{ id: 'x' }] }), /ни одного/);
  assert.throws(() => feed.normalizeSnapshot({ title: 'нет лент' }), /feeds/);
});

test('совместимость: JSON и код YFS1 из версии 1 открываются как «Главная»', async () => {
  const v1 = { format: 'yt-feed-share', version: 1, exportedAt: '2026-10-04T10:00:00.000Z', source: 'youtube-home', author: 'Демо', videos: fx.manyVideos(5) };
  const fromJson = await feed.decodeSnapshot(JSON.stringify(v1));
  assert.deepEqual(fromJson.feeds.map((f) => f.type), ['home']);
  assert.equal(fromJson.feeds[0].videos.length, 5);
  assert.equal(fromJson.author, 'Демо');

  const v1code = 'YFS1.' + zlib.deflateRawSync(Buffer.from(JSON.stringify(v1))).toString('base64url');
  assert.deepEqual(await feed.decodeSnapshot('https://x.github.io/viewer.html#' + v1code), fromJson);
});

test('код YFS2: туда и обратно, ссылка, lite', async () => {
  const src = feed.normalizeSnapshot({
    author: 'Саша',
    feeds: [
      { type: 'home', videos: fx.manyVideos(100) },
      { type: 'history', videos: fx.manyVideos(30).map((v, i) => ({ ...v, watchedDay: '2026-10-0' + ((i % 5) + 1), progress: 50 })) },
    ],
  });
  const code = await feed.encodeSnapshot(src);
  assert.ok(code.startsWith('YFS2.'));
  assert.deepEqual(await feed.decodeSnapshot(code), src);

  const link = feed.buildShareLink(code, 'https://name.github.io/yfs/src/viewer/viewer.html#old');
  assert.ok(link.startsWith('https://name.github.io/yfs/src/viewer/viewer.html#YFS2.'));
  assert.deepEqual(await feed.decodeSnapshot(link), src);
  assert.equal(feed.buildShareLink(code, 'javascript:alert(1)'), null);

  const lite = await feed.encodeSnapshot(src, { lite: true });
  assert.ok(lite.length < code.length);
  const liteSnap = await feed.decodeSnapshot(lite);
  assert.equal(liteSnap.feeds[0].videos[0].avatar, undefined);
  assert.equal(liteSnap.feeds[1].videos[0].progress, undefined);
  assert.equal(liteSnap.feeds[1].videos[0].watchedDay, '2026-10-01');
  console.log(`      130 роликов в 2 лентах: код ${code.length} симв., короткий ${lite.length} симв.`);
});

test('decodeSnapshot: обрезанный код и мусор', async () => {
  const code = await feed.encodeSnapshot({ videos: fx.manyVideos(3) });
  await assert.rejects(feed.decodeSnapshot(code.slice(0, code.length / 2)), /повреждён/);
  await assert.rejects(feed.decodeSnapshot('просто текст'), /Не найден/);
});

test('статистика: каналы, длительность, история за сегодня и неделю', () => {
  const snap = feed.normalizeSnapshot({
    exportedAt: '2026-10-05T12:00:00',
    feeds: [
      {
        type: 'home',
        videos: [
          { id: 'aaaaaaaaaa1', channel: 'Альфа', channelUrl: '/@alpha', duration: '10:00' },
          { id: 'aaaaaaaaaa2', channel: 'Альфа', channelUrl: '/@alpha', duration: '20:00' },
          { id: 'aaaaaaaaaa3', channel: 'Бета', duration: '1:00:00' },
          { id: 'aaaaaaaaaa4', channel: 'Гамма', live: true },
        ],
      },
      {
        type: 'history',
        videos: [
          { id: 'aaaaaaaaaa1', channel: 'Альфа', channelUrl: '/@alpha', duration: '10:00', watchedDay: '2026-10-05', progress: 50 },
          { id: 'bbbbbbbbbb1', channel: 'Бета', duration: '1:00:00', watchedDay: '2026-10-01' },
          { id: 'bbbbbbbbbb2', channel: 'Бета', duration: '30:00', watchedDay: '2026-09-20', progress: 100 },
          { id: 'bbbbbbbbbb3', channel: 'Бета', duration: '5:00' },
        ],
      },
    ],
  });
  const s = analytics.snapshotStats(snap);
  assert.equal(s.feeds.home.count, 4);
  assert.equal(s.feeds.home.channels, 3);
  assert.equal(s.feeds.home.avgSec, 1800); // (600 + 1200 + 3600) / 3
  assert.deepEqual(s.feeds.home.topChannels[0], { name: 'Альфа', channelUrl: '/@alpha', count: 2 });
  assert.equal(s.total.count, 7); // aaaaaaaaaa1 в двух лентах считается один раз
  assert.deepEqual(s.history.today, { count: 1, watchSec: 300 });
  assert.deepEqual(s.history.week, { count: 2, watchSec: 3900 });
  assert.equal(s.history.undated, 1);
  assert.equal(analytics.formatHours(3900), '1 ч 5 мин');
  assert.equal(analytics.formatDuration(763), '12:43');
});

test('сравнение снимков по id', () => {
  const base = feed.normalizeSnapshot({ feeds: [{ type: 'home', videos: fx.manyVideos(5) }] });
  const next = feed.normalizeSnapshot({
    feeds: [
      { type: 'home', videos: fx.manyVideos(5).slice(2).concat([{ id: 'newnewnew01', title: 'Новое' }]) },
      { type: 'shorts', videos: [{ id: 'sssssssssss' }] },
    ],
  });
  const [home, shorts] = analytics.diffSnapshots(base, next);
  assert.deepEqual(home.added.map((v) => v.id), ['newnewnew01']);
  assert.equal(home.removed.length, 2);
  assert.equal(home.kept, 3);
  assert.equal(shorts.baseMissing, true);
});

// ---------- ID-first ----------

const enrich = require('../src/viewer/enrich.js');
const fs = require('node:fs');
const path = require('node:path');

test('регрессия: все сохранённые ответы YouTube из test/fixtures', () => {
  const dir = path.join(__dirname, 'fixtures');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const primary = parse.extractVideos(fx.data);
    const { videos } = parse.withFallback([primary], [parse.extractGeneric(fx.data)]);
    const ids = videos.map((v) => v.id);
    const positions = fx.expect.ids.map((id) => ids.indexOf(id));
    assert.ok(positions.every((p) => p !== -1), `${file}: не найдены ${fx.expect.ids.filter((id) => !ids.includes(id))}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `${file}: нарушен порядок`);
    if (fx.expect.primary) assert.ok(fx.expect.ids.every((id) => primary.some((v) => v.id === id)), `${file}: основной парсер`);
    for (const id of fx.expect.absent || []) assert.ok(!ids.includes(id), `${file}: лишний ${id}`);
  }
});

test('общий поиск: неизвестный renderer, ссылки, превью; миксы и реклама пропускаются', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/home-unknown-format.json'), 'utf8')).data;
  assert.equal(parse.extractVideos(data).length, 0); // основной парсер этот формат не знает
  const g = parse.extractGeneric(data);
  assert.deepEqual(g.map((v) => [v.id, v.source, v.title]), [
    ['NEWfmt00001', 'json-id', 'Ролик в новом формате'],
    ['NEWfmt00002', 'json-url', 'Только ссылка'],
    ['NEWfmt00003', 'json-thumb', ''],
  ]);
  assert.equal(g[1].url, '/watch?v=NEWfmt00002&pp=abc');
  const ads = parse.extractGeneric(fx.richGrid([{ adSlotRenderer: { videoRenderer: { videoId: 'ADADADADADA' } } }]));
  assert.equal(ads.length, 0);
});

test('детектор поломки: пустой основной парсер → fallback; нормальный → без него', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/home-unknown-format.json'), 'utf8')).data;
  const broken = parse.withFallback([parse.extractVideos(data)], [parse.extractGeneric(data)]);
  assert.equal(broken.health.suspicious, true);
  assert.deepEqual(broken.health.reasons, ['primary-empty']);
  assert.equal(broken.videos.length, 3);
  assert.equal(broken.health.recovered, 3);

  const ok = fx.richGrid([fx.videoRenderer(), fx.lockup()]);
  const fine = parse.withFallback([parse.extractVideos(ok)], [parse.extractGeneric(ok)]);
  assert.equal(fine.health.suspicious, false);
  assert.equal(fine.videos.length, 2);

  const links = Array.from({ length: 20 }, (_, i) => ({ id: `link${String(i).padStart(7, '0')}`, source: 'dom-link' }));
  const low = parse.assessHealth([{ id: 'dQw4w9WgXcQ', title: 'x' }], [], links);
  assert.deepEqual(low.reasons, ['primary-low']);
});

test('confidence: high / medium / low', () => {
  assert.equal(parse.confidence({ id: 'x', title: 'T', channel: 'C', source: 'renderer:videoRenderer' }), 'high');
  assert.equal(parse.confidence({ id: 'x', source: 'json-url' }), 'medium');
  assert.equal(parse.confidence({ id: 'x', title: 'T', source: 'json-thumb' }), 'medium');
  assert.equal(parse.confidence({ id: 'x', source: 'json-thumb' }), 'low');
  const [v] = parse.extractVideos(fx.richGrid([fx.lockupReal2026()]));
  assert.equal(v.source, 'renderer:lockupViewModel');
  assert.equal(v.url, '/watch?v=pRrmQUm6Zvg');
});

test('снимок только из ID валиден; url, source, position сохраняются', () => {
  const snap = feed.normalizeSnapshot({
    feeds: [
      {
        type: 'home',
        videos: [
          { id: 'bbbbbbbbbbb', position: 2, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb&pp=x', source: 'json-url', confidence: 'medium' },
          { id: 'aaaaaaaaaaa', position: 1, title: null, duration: null },
          { id: 'ccccccccccc', position: 3, url: 'javascript:alert(1)//ccccccccccc' },
        ],
      },
    ],
  });
  const vids = snap.feeds[0].videos;
  assert.deepEqual(vids.map((v) => v.id), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']); // порядок по position
  assert.deepEqual(vids[0], { id: 'aaaaaaaaaaa', title: null, position: 1 });
  assert.equal(vids[1].url, '/watch?v=bbbbbbbbbbb&pp=x');
  assert.equal(vids[1].source, 'json-url');
  assert.equal(vids[1].confidence, 'medium');
  assert.equal(vids[2].url, undefined);
});

test('восстановление: oEmbed, страница ролика, слияние без перезаписи', () => {
  const o = enrich.parseOEmbed('dQw4w9WgXcQ', { title: 'Rick', author_name: 'Rick Astley', author_url: 'https://www.youtube.com/@RickAstleyYT' });
  assert.deepEqual(o, { title: 'Rick', channel: 'Rick Astley', channelUrl: '/@RickAstleyYT' });
  const evil = enrich.parseOEmbed('dQw4w9WgXcQ', { title: 'x', author_url: 'javascript:alert(1)' });
  assert.equal(evil.channelUrl, undefined);

  const html = '<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"Never \\"Gonna\\"","lengthSeconds":"213","channelId":"UC1","viewCount":"1700000000","author":"Rick"},"microformat":{"playerMicroformatRenderer":{"ownerProfileUrl":"http://www.youtube.com/@RickAstleyYT","ownerChannelName":"Rick Astley"}}};</script>';
  const w = enrich.parseWatchHtml('dQw4w9WgXcQ', html);
  assert.equal(w.title, 'Never "Gonna"');
  assert.equal(w.duration, '3:33');
  assert.equal(w.channel, 'Rick Astley');
  assert.equal(w.channelUrl, '/@RickAstleyYT');
  assert.match(w.views, /^1\s700\s000\s000 просмотров$/);
  assert.deepEqual(enrich.parseWatchHtml('aaaaaaaaaaa', html), {}); // чужая страница — ничего не берём

  const v = { id: 'dQw4w9WgXcQ', title: 'Из снимка', duration: null };
  const m = enrich.merge(v, { title: 'Из oEmbed', channel: 'Rick', duration: '3:33' });
  assert.deepEqual(m, { id: 'dQw4w9WgXcQ', title: 'Из снимка', channel: 'Rick', duration: '3:33' });
  assert.equal(enrich.quality({ id: 'x' }), 'id');
  assert.equal(enrich.quality({ id: 'x', title: 't' }), 'partial');
  assert.equal(enrich.quality(m), 'full');
});

test('восстановление: очередь, кэш по id, удалённые ролики, порядок не трогается', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const id = decodeURIComponent(url).match(/v=([\w-]{11})/)[1];
    if (id === 'gonegonegon') return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => ({ title: 'T ' + id, author_name: 'C', author_url: 'https://www.youtube.com/@c' }) };
  };
  let saved = null;
  const updates = [];
  const e = await enrich.createEnricher({ load: async () => ({}), save: (d) => (saved = d), fetchImpl: fakeFetch, onUpdate: (id) => updates.push(id) });
  const list = [{ id: 'aaaaaaaaaaa' }, { id: 'gonegonegon' }, { id: 'ccccccccccc', title: 'есть', channel: 'есть', duration: '1:00' }];
  assert.equal(e.want(list), 2); // полный ролик не запрашиваем
  while (e.pending()) await new Promise((r) => setTimeout(r, 5));
  assert.equal(e.get('aaaaaaaaaaa').title, 'T aaaaaaaaaaa');
  assert.equal(e.get('gonegonegon').status, 'gone');
  assert.equal(enrich.merge(list[1], e.get('gonegonegon')).gone, true);
  assert.equal(e.want(list), 0); // повторно не трогаем — кэш
  assert.equal(calls.length, 2);
  assert.equal(e.refresh([list[1]]), 1); // «↻ Обновить данные»
  while (e.pending()) await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 3);
  assert.deepEqual(list.map((v) => v.id), ['aaaaaaaaaaa', 'gonegonegon', 'ccccccccccc']);
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(saved && saved.aaaaaaaaaaa);
});

test('просмотры для сортировки', () => {
  assert.equal(analytics.parseViews('1,2 млн просмотров'), 1200000);
  assert.equal(analytics.parseViews('3,3 миллиона просмотров'), 3300000);
  assert.equal(analytics.parseViews('5,4 млрд просмотров'), 5400000000);
  assert.equal(analytics.parseViews('15 тыс. просмотров'), 15000);
  assert.equal(analytics.parseViews('1,234,567 views'), 1234567);
  assert.equal(analytics.parseViews('1.2M views'), 1200000);
  assert.equal(analytics.parseViews('1 700 000 000 просмотров'), 1700000000);
  assert.equal(analytics.parseViews(''), null);
});

test('правила Shorts: длительность, автор, хештеги', () => {
  const rules = require('../src/shared/shortsrules.js');
  assert.deepEqual(rules.extractTags('Смешно #Кот #cats #кот и #мемы_2026!'), ['кот', 'cats', 'мемы_2026']);
  assert.equal(rules.authorKey('/@Some%20Name', 'x'), '@some name');
  assert.equal(rules.authorKey('', 'Канал Один'), 'name:канал один');
  const r = rules.normalizeRules({ minSec: 15, maxSec: 60, authors: { '@spam': 'Spam' }, tags: ['#Реклама', 'ads', 'ads'] });
  assert.deepEqual(r.tags, ['реклама', 'ads']);
  const base = { durationSec: 30, authorKey: '@ok', tags: ['кот'] };
  assert.equal(rules.decideSkip(base, r), null);
  assert.equal(rules.decideSkip({ ...base, durationSec: 10 }, r), 'short');
  assert.equal(rules.decideSkip({ ...base, durationSec: 90 }, r), 'long');
  assert.equal(rules.decideSkip({ ...base, durationSec: 0 }, r), null); // длительность неизвестна — не трогаем
  assert.equal(rules.decideSkip({ ...base, authorKey: '@spam' }, r), 'author');
  assert.equal(rules.decideSkip({ ...base, tags: ['кот', 'реклама'] }, r), 'tag');
  assert.equal(rules.decideSkip({ ...base, authorKey: 'constructor' }, r), null);
  assert.equal(rules.decideSkip({ durationSec: 5 }, rules.DEFAULT_RULES), null);
  let seen = null;
  seen = rules.recordSeen(seen, { authorKey: '@a', authorName: 'A', tags: ['x', 'y'] });
  seen = rules.recordSeen(seen, { authorKey: '@a', authorName: 'A', tags: ['x'] });
  assert.deepEqual(seen, { authors: { '@a': { name: 'A', count: 2 } }, tags: { x: 2, y: 1 } });
});

test('переводы: все ключи во всех языках, плейсхолдеры и формы множественного числа', () => {
  globalThis.YFS = globalThis.YFS || {};
  const i18n = require('../src/shared/i18n.js');
  require('../src/locales/en.js');
  const { usedKeys } = require('./i18n-keys.js');
  const en = i18n.dicts.en;
  const used = usedKeys();
  assert.deepEqual(used.filter((k) => !(k in en)), [], 'в en.js не хватает ключей');
  const vars = (v) => [...JSON.stringify(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((x, i, a) => a.indexOf(x) === i).sort();
  const dir = path.join(__dirname, '..', 'src', 'locales');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.includes('ru.json'));
  for (const file of files) {
    const code = file.replace('.json', '');
    const dict = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const missing = Object.keys(en).filter((k) => !(k in dict));
    assert.deepEqual(missing, [], `${file}: нет ключей`);
    const cats = new Intl.PluralRules(i18n.info(code).locale).resolvedOptions().pluralCategories;
    for (const [k, v] of Object.entries(dict)) {
      assert.ok(k in en, `${file}: лишний ключ ${k}`);
      // Плейсхолдеры те же, что в английском (кроме {language} в подсказке к промту — он и так одинаковый).
      assert.deepEqual(vars(v), vars(en[k]), `${file}: плейсхолдеры в ${k}`);
      if (en[k] && typeof en[k] === 'object') {
        assert.ok(v && typeof v === 'object', `${file}: ${k} должен быть объектом форм`);
        for (const c of cats) assert.ok(typeof v[c] === 'string', `${file}: ${k} без формы «${c}»`);
      }
    }
    assert.ok(i18n.LANGUAGES.some((l) => l.code === code), `${file}: язык не в списке`);
  }
  // Проверка поведения t(): форма по числу и подстановка.
  i18n.register('ru', JSON.parse(fs.readFileSync(path.join(dir, 'ru.json'), 'utf8')));
  i18n.setLanguage('ru');
  assert.equal(i18n.t('n.channels', { n: 1 }), '1 канал');
  assert.equal(i18n.t('n.channels', { n: 3 }), '3 канала');
  assert.equal(i18n.t('n.channels', { n: 25 }), '25 каналов');
  assert.equal(i18n.t('snap.of', { name: 'Саша' }), 'YouTube — Саша');
  assert.equal(i18n.t('нет.такого'), 'нет.такого');
  i18n.setLanguage('en');
  assert.equal(i18n.t('n.videos', { n: 1 }), '1 video');
  assert.equal(i18n.t('n.videos', { n: 2 }), '2 videos');
  delete globalThis.YFS.i18n; // остальным тестам — исходное поведение без переводов
});

test('транскрипт: панель 2026 (get_panel), старый формат, текст с тайм-кодами и без', () => {
  const T = require('../src/shared/transcript.js');
  const panelJson = {
    content: {
      engagementPanelSectionListRenderer: {
        content: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    { macroMarkersPanelItemViewModel: { item: { timelineItemViewModel: { timestamp: '0:01', contentItems: [{ transcriptSegmentViewModel: { simpleText: '[♪♪♪]', timestamp: '0:01' } }] } }, onTap: { innertubeCommand: { watchEndpoint: { videoId: 'dQw4w9WgXcQ', startTimeSeconds: 1 } } } } },
                    { macroMarkersPanelItemViewModel: { item: { timelineItemViewModel: { timestamp: '0:18', contentItems: [{ transcriptSegmentViewModel: { simpleText: "♪ We're no strangers to love ♪", timestamp: '0:18' } }] } }, onTap: { innertubeCommand: { watchEndpoint: { videoId: 'dQw4w9WgXcQ', startTimeSeconds: 18 } } } } },
                    { macroMarkersPanelItemViewModel: { item: { timelineItemViewModel: { timestamp: '1:02:03', contentItems: [{ transcriptSegmentViewModel: { simpleText: 'Финал', timestamp: '1:02:03' } }] } } } },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
  const r = T.parsePanelResponse(panelJson);
  assert.deepEqual(r.segments.map((s) => [s.start, s.text]), [[1, '[♪♪♪]'], [18, "♪ We're no strangers to love ♪"], [3723, 'Финал']]);
  assert.equal(r.segments[0].end, 18);

  const initialData = { engagementPanels: [{ x: { showEngagementPanelEndpoint: { identifier: { tag: 'PAmodern_transcript_view' }, globalConfiguration: { params: 'qgkPCgtk' } } } }] };
  assert.deepEqual(T.findPanelParams(initialData), { panelId: 'PAmodern_transcript_view', params: 'qgkPCgtk' });

  const legacy = { actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { content: { transcriptSearchPanelRenderer: { body: { transcriptSegmentListRenderer: { initialSegments: [
    { transcriptSegmentRenderer: { startMs: '0', endMs: '2500', snippet: { runs: [{ text: 'Привет' }] } } },
    { transcriptSegmentRenderer: { startMs: '6000', endMs: '8000', snippet: { runs: [{ text: 'мир' }] } } },
  ] } } } } } } } }] };
  const old = T.parseTranscriptResponse(legacy);
  assert.equal(old.segments.length, 2);
  assert.equal(T.formatTranscript(old.segments, { timestamps: true }), '[0:00] Привет\n[0:06] мир');
  assert.equal(T.formatTranscript(old.segments, { timestamps: false }), 'Привет\n\nмир'); // пауза > 2 с — новый абзац

  const html = 'x var ytInitialData = {"a":"}{\\"","b":{"c":1}}; y';
  assert.deepEqual(T.jsonAfter(html, 'ytInitialData = '), { a: '}{"', b: { c: 1 } });

  // Дорожка для текста видео: авторская на языке речи → автоматическая → первая.
  const tracks = [{ lang: 'ru', kind: '' }, { lang: 'en-US', kind: '' }, { lang: 'en', kind: 'asr' }];
  assert.deepEqual(T.pickTrack(tracks), { lang: 'en-US', kind: '' });
  assert.deepEqual(T.pickTrack([{ lang: 'ru', kind: '' }, { lang: 'de', kind: 'asr' }]), { lang: 'de', kind: 'asr' });
  assert.deepEqual(T.pickTrack([{ lang: 'fr', kind: '' }]), { lang: 'fr', kind: '' });
  assert.equal(T.pickTrack([]), null);
  // Русский ролик с двумя автоматическими дорожками (en первая): берём язык звука, а не первую.
  const two = [{ lang: 'en', kind: 'asr' }, { lang: 'ru', kind: 'asr' }];
  assert.deepEqual(T.pickTrack(two, { audioLang: 'ru' }), { lang: 'ru', kind: 'asr' });
  assert.deepEqual(T.pickTrack(two, { defaultIndex: 1 }), { lang: 'ru', kind: 'asr' });
  assert.deepEqual(T.pickTrack([{ lang: 'ru', kind: 'asr' }, { lang: 'ru', kind: '' }], { audioLang: 'ru' }), { lang: 'ru', kind: '' });
  const pr = { captions: { playerCaptionsTracklistRenderer: { defaultAudioTrackIndex: 0, audioTracks: [{ audioTrackId: 'ru.4', defaultCaptionTrackIndex: 1 }] } } };
  assert.deepEqual(T.captionHints(pr), { audioLang: 'ru', defaultIndex: 1 });
  assert.deepEqual(T.captionHints(null), {});
});

test('AI: запрос к Gemini, ответ, ошибки, выбор модели, текст сводки', async () => {
  const AI = require('../src/shared/ai.js');
  // Тексты промтов — в словарях переводов (prompt.*): берём английский и русский напрямую.
  require('../src/locales/en.js');
  const EN = require('../src/shared/i18n.js').dicts.en;
  const RU = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'ru.json'), 'utf8'));
  const req = AI.buildRequest({ video: { id: 'dQw4w9WgXcQ', title: 'Rick', channel: 'Rick Astley', duration: '3:33' }, segments: [{ start: 18, text: 'never gonna' }], language: 'Russian', prompt: AI.builtinPrompt('standard', EN) });
  assert.match(req.systemInstruction.parts[0].text, /in Russian/);
  assert.match(req.contents[0].parts[0].text, /\[0:18\] never gonna/);
  assert.equal(req.generationConfig.responseMimeType, 'application/json');
  const noText = AI.buildRequest({ video: { id: 'dQw4w9WgXcQ' }, segments: [], language: 'English' });
  assert.equal(noText.contents[0].parts[0].fileData.fileUri, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  let sent = null;
  const ok = async (url, init) => {
    sent = { url, init };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ tags: ['#музыка', 'клип'], summary: 'Песня.', keyPoints: ['Хит'], chronology: [{ time: '0:18', title: 'Куплет', details: 'Начало' }], audience: 'Всем' }) }] } }] }) };
  };
  const out = await AI.summarize({ key: 'k', model: 'gemini-x', video: { id: 'dQw4w9WgXcQ' }, segments: [{ start: 0, text: 'a' }], language: 'Russian', fetchImpl: ok });
  assert.match(sent.url, /models\/gemini-x:generateContent$/);
  assert.equal(sent.init.headers['x-goog-api-key'], 'k');
  assert.deepEqual(out.result.tags, ['музыка', 'клип']);
  assert.equal(out.usedTranscript, true);
  const text = AI.summaryToText(out.result, { id: 'dQw4w9WgXcQ', title: 'Rick' }, { tags: 'Теги', summary: 'Кратко', keyPoints: 'Главное', chronology: 'Хронология', audience: 'Кому' });
  assert.match(text, /Теги: #музыка #клип/);
  assert.match(text, /\[0:18\] Куплет — Начало/);

  const bad = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }) });
  await assert.rejects(AI.summarize({ key: 'x', video: { id: 'dQw4w9WgXcQ' }, segments: [], fetchImpl: bad }), (e) => e.code === 'ai-key-invalid');
  const quota = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(AI.summarize({ key: 'x', video: { id: 'dQw4w9WgXcQ' }, segments: [], fetchImpl: quota }), (e) => e.code === 'ai-quota');
  await assert.rejects(AI.summarize({ key: '', video: { id: 'dQw4w9WgXcQ' } }), (e) => e.code === 'ai-no-key');

  assert.equal(AI.pickModel([{ id: 'gemini-2.5-pro' }, { id: 'gemini-2.5-flash' }, { id: 'gemini-3-flash-preview' }, { id: 'gemini-3-flash' }, { id: 'gemini-2.0-flash-lite' }]), 'gemini-3-flash');
  assert.equal(AI.pickModel([]), AI.DEFAULT_MODEL);

  // Скорость: у 2.5 Flash «размышления» выключены, у 3.x — низкий уровень, у старых моделей настройки нет.
  assert.deepEqual(AI.buildRequest({ video: { id: 'dQw4w9WgXcQ' }, segments: [], model: 'gemini-2.5-flash' }).generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.deepEqual(AI.thinkingConfig('gemini-3-flash'), { thinkingLevel: 'low' });
  assert.equal(AI.thinkingConfig('gemini-2.0-flash'), null);
  // Компактный текст: фразы в пределах ~10 с склеиваются, метка — по началу.
  assert.equal(AI.transcriptText([{ start: 0, text: 'a' }, { start: 3, text: 'b' }, { start: 12, text: 'c' }]), '[0:00] a b\n[0:12] c\n');
  // Пресеты: свой промт — только для «custom».
  assert.equal(AI.promptFor('custom', 'X'), 'X');
  assert.match(AI.builtinPrompt('brief', EN), /exactly 3/);
  // Встроенные промты собираются из словаря языка: все поля схемы, {language}, все правила.
  for (const id of AI.PRESET_IDS) {
    for (const dict of [EN, RU]) {
      const p = AI.builtinPrompt(id, dict);
      for (const field of ['"tags"', '"summary"', '"keyPoints"', '"chronology"', '"audience"', '{language}']) assert.ok(p.includes(field), `${id}: ${field}`);
      assert.ok(!/prompt\.[a-z]/.test(p), `${id}: в промте остался ключ словаря`);
      assert.equal(p.split('\n- ').length - 1, AI.PROMPT_FIELDS.length + AI.PROMPT_RULES.length, `${id}: поля и правила`);
    }
  }
  assert.match(AI.builtinPrompt('study', RU), /конспект/);
  assert.notEqual(AI.builtinPrompt('study', RU), AI.builtinPrompt('study', EN)); // язык меняется — меняется и промт
  assert.equal(AI.languageName({ name: 'Русский', english: 'Russian' }), 'Русский (Russian)');
  assert.equal(AI.languageName({ name: 'English', english: 'English' }), 'English');
  // Правка встроенного — для своего языка; старая правка (overrides) — для всех; свои пресеты; старый «свой промт».
  const settings = { overridesByLang: { ru: { brief: 'МОЙ КРАТКИЙ' } }, overrides: { study: 'ALL LANGS' }, presets: [{ id: 'p1', name: 'Мой', text: 'P1' }], prompt: 'LEGACY' };
  const list = AI.presetList(settings, 'ru', RU);
  assert.deepEqual(list.map((p) => p.id), [...AI.PRESET_IDS, 'custom', 'p1']);
  assert.equal(list.find((p) => p.id === 'brief').edited, true);
  assert.equal(AI.presetText(settings, 'brief', 'ru', RU), 'МОЙ КРАТКИЙ');
  assert.equal(AI.presetText(settings, 'brief', 'en', EN), AI.builtinPrompt('brief', EN)); // на английском правки нет
  assert.equal(AI.presetText(settings, 'study', 'en', EN), 'ALL LANGS');
  assert.equal(AI.presetText(settings, 'p1', 'ru', RU), 'P1');
  assert.equal(AI.presetText(settings, 'custom', 'ru', RU), 'LEGACY');
  assert.equal(AI.presetText(settings, 'nope', 'ru', RU), AI.builtinPrompt('standard', RU));
  const patch = AI.overridePatch(settings, 'study', 'en', 'EN STUDY', EN);
  assert.deepEqual(patch.overridesByLang.en, { study: 'EN STUDY' });
  assert.equal(patch.overrides.study, undefined);
  assert.deepEqual(AI.overridePatch(settings, 'brief', 'ru', AI.builtinPrompt('brief', RU), RU).overridesByLang.ru, {}); // как встроенный — сброс
  assert.notEqual(AI.hashText('a'), AI.hashText('b'));
  assert.equal(AI.hashText('промт'), AI.hashText('промт'));
  // Порядок моделей: flash → flash-lite → pro, картинки и озвучка — мимо.
  assert.deepEqual(
    AI.rankModels(['gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-image', 'gemini-2.5-flash', 'gemini-3-flash-preview']).map((m) => m.id),
    ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']
  );

  // Балансировщик: первая модель перегружена (503 дважды) — сводку делает следующая, а первая уходит «остывать».
  AI.cooldown.clear();
  const calls = [];
  const busyFirst = async (url) => {
    calls.push(url.match(/models\/([^:]+):/)[1]);
    if (url.includes('gemini-2.5-flash:')) return { ok: false, status: 503, json: async () => ({ error: { message: 'The model is overloaded.' } }) };
    return ok(url, {});
  };
  const progress = [];
  const smart = await AI.summarizeSmart({
    key: 'k',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    video: { id: 'dQw4w9WgXcQ' },
    segments: [{ start: 0, text: 'a' }],
    fetchImpl: busyFirst,
    onProgress: (p) => progress.push(p.model),
  });
  assert.equal(smart.model, 'gemini-2.5-flash-lite');
  assert.deepEqual(calls, ['gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  assert.deepEqual(smart.tried, [{ model: 'gemini-2.5-flash', code: 'ai-server' }]);
  assert.deepEqual(progress, ['gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  // Следующий запрос сразу идёт в здоровую модель.
  assert.equal(AI.candidates(['gemini-2.5-flash', 'gemini-2.5-flash-lite'], '')[0], 'gemini-2.5-flash-lite');
  // Неверный ключ — не повод перебирать модели.
  await assert.rejects(AI.summarizeSmart({ key: 'x', models: ['gemini-2.5-flash-lite', 'gemini-2.0-flash'], video: { id: 'dQw4w9WgXcQ' }, segments: [], fetchImpl: bad }), (e) => e.code === 'ai-key-invalid');
  AI.cooldown.clear();
});

test('музыка: распознавание трека, исполнитель и название, ссылки на площадки, очередь', () => {
  const M = require('../src/shared/music.js');
  assert.deepEqual(M.parseTrack('Rick Astley - Never Gonna Give You Up (Official Music Video)', 'Rick Astley'), { artist: 'Rick Astley', track: 'Never Gonna Give You Up', query: 'Rick Astley Never Gonna Give You Up' });
  assert.equal(M.parseTrack('Never Gonna Give You Up', 'Rick Astley - Topic').artist, 'Rick Astley'); // «Topic»-канал
  assert.equal(M.parseTrack('The Weeknd - Blinding Lights (Official Video) [4K]', 'TheWeekndVEVO').track, 'Blinding Lights');
  assert.ok(M.isMusic({ title: 'Imagine Dragons x J.I.D - Enemy | Lyrics', channel: 'Lyrics Hub', durationSec: 180 }));
  assert.ok(M.isMusic({ title: 'Баста - Сансара (feat. Скриптонит) | Премьера клипа', channel: 'Баста', durationSec: 300 }));
  assert.ok(!M.isMusic({ title: 'Что стало с командой спустя 3 года?', channel: 'Эрик Шоков', durationSec: 1100 }));
  assert.ok(!M.isMusic({ title: 'Лучшие треки 2025 — 2 часа музыки', channel: 'Mix', durationSec: 7200 })); // сборник, а не трек
  assert.equal(M.musicScore({ title: 'x', musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' }), 1);
  const links = M.platformLinks('Rick Astley Never Gonna');
  assert.ok(links.length >= 6 && links.every((l) => /^https:\/\//.test(l.url) && l.url.includes('Rick%20Astley')));
  assert.equal(M.queueUrl(['dQw4w9WgXcQ', 'bad', 'dQw4w9WgXcQ', 'aircAruvnKk']), 'https://www.youtube.com/watch_videos?video_ids=dQw4w9WgXcQ,aircAruvnKk');
  assert.equal(M.queueUrl([]), '');
});

test('фильтр ленты: числа, возраст, язык, правила и сортировка', () => {
  const R = require('../src/shared/feedrules.js');
  assert.equal(R.parseCount('1,2 млн просмотров'), 1200000);
  assert.equal(R.parseCount('120 тыс.'), 120000);
  assert.equal(R.parseCount('1.2M views'), 1200000);
  assert.equal(R.parseCount('15 482 просмотра'), 15482);
  assert.equal(R.parseCount('2,3 млрд'), 2300000000);
  assert.equal(R.parseAge('3 дня назад'), 3 * 86400);
  assert.equal(R.parseAge('2 weeks ago'), 2 * 604800);
  assert.equal(R.parseAge('11 л. назад'), 11 * 31536000);
  assert.equal(R.durationToSec('1:02:03'), 3723);
  assert.equal(R.durationToSec('LIVE'), 0);
  assert.equal(R.scriptLang('Что стало с командой'), 'ru');
  assert.equal(R.scriptLang('Їжа й життя'), 'uk');
  assert.equal(R.scriptLang('한국 노래'), 'ko');
  assert.equal(R.scriptLang('ひらがなの歌'), 'ja');
  assert.equal(R.scriptLang('Never gonna give you up'), 'latin');
  assert.deepEqual(R.hashtags('Клип #музыка #Shorts'), ['#музыка', '#shorts']);

  const rules = R.normalizeRules({ enabled: true, hideShorts: true, minMin: 5, maxMin: 60, langs: ['ru'], blockChannels: { '/@spam': 'Spam' }, blockWords: ['#Реакция'], sort: 'views' });
  const card = (o) => ({ id: 'x', title: 'Видео', channel: 'Канал', channelUrl: '/@good', durationSec: 600, lang: 'ru', views: 10, ageSec: 100, music: 0, ...o });
  assert.deepEqual(R.decide(card({}), rules), { hide: false });
  assert.equal(R.decide(card({ short: true }), rules).reason, 'short');
  assert.equal(R.decide(card({ durationSec: 120 }), rules).reason, 'duration');
  assert.equal(R.decide(card({ durationSec: 0 }), rules).hide, false); // длительность неизвестна — не скрываем
  assert.equal(R.decide(card({ lang: 'en' }), rules).reason, 'lang');
  assert.equal(R.decide(card({ channelUrl: '/@spam' }), rules).reason, 'channel');
  assert.equal(R.decide(card({ title: 'Моя реакция #реакция' }), rules).reason, 'word'); // слова — без учёта регистра
  assert.equal(R.decide(card({ mix: true }), R.normalizeRules({ hideMixes: true })).reason, 'mix');
  assert.equal(R.decide(card({}), R.normalizeRules({ onlyMusic: true })).reason, 'music');
  assert.equal(R.decide(card({ music: 0.9 }), R.normalizeRules({ onlyMusic: true })).hide, false);
  const sorted = [card({ id: 'a', views: 5 }), card({ id: 'b', views: 50 }), card({ id: 'c', views: 0 })].sort((x, y) => R.sortValue(x, 'views') - R.sortValue(y, 'views'));
  assert.deepEqual(sorted.map((c) => c.id), ['b', 'a', 'c']); // без данных — в конце
  const sum = R.summarize([card({ lang: 'ru' }), card({ lang: 'en', channelUrl: '/@x', channel: 'X' }), card({ lang: 'ru' })]);
  assert.deepEqual(sum.langs, [{ code: 'ru', count: 2 }, { code: 'en', count: 1 }]);
  assert.equal(sum.channels[0].count, 2);
  assert.equal(R.normalizeRules({ sort: 'bogus', minMin: -5 }).sort, 'none');
});

test('СДВГ-режим: план без дыр, проценты, защита от «пропустить всё», запрос с балансировкой', async () => {
  const AI = require('../src/shared/ai.js');
  const plan = AI.normalizeFocus(
    {
      overview: 'Про команду.',
      segments: [
        { start: '0:00', end: '0:40', action: 'skip', interest: 1, title: 'Вступление', summary: 'Приветствие и спонсор' },
        { start: '2:00', end: '9:00', action: 'fast', interest: 3, title: 'История', summary: '' },
        { start: '0:40', end: '2:00', action: 'keep', interest: 5, title: 'Главное' },
        { start: 'oops', end: '1', action: 'keep', title: 'мусор' },
        { start: '9:00', end: '99:00', action: 'nope', title: 'Финал' },
      ],
    },
    600
  );
  assert.deepEqual(plan.segments.map((s) => [s.start, s.end, s.action]), [[0, 40, 'skip'], [40, 120, 'keep'], [120, 540, 'fast'], [540, 600, 'keep']]);
  const s = AI.focusSavings(plan, 2);
  assert.equal(s.total, 600);
  assert.equal(Math.round(s.watch), 80 + 210 + 60);
  // Модель «пропустила» почти всё — часть пропусков становится ускорением.
  const greedy = AI.normalizeFocus({ segments: [{ start: '0:00', action: 'skip', interest: 2, title: 'a' }, { start: '5:00', action: 'skip', interest: 1, title: 'b' }, { start: '9:30', action: 'keep', title: 'c' }] }, 600);
  assert.ok(greedy.segments.some((x) => x.action === 'fast'));
  assert.match(AI.focusPrompt('hard', 'Русский (Russian)'), /aggressive[\s\S]*Русский/);

  AI.cooldown.clear();
  let body = null;
  const ok = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ segments: [{ start: '0:00', end: '1:00', action: 'keep', title: 'Всё' }] }) }] } }] }) };
  };
  const out = await AI.focusPlan({ key: 'k', models: ['gemini-2.5-flash'], video: { id: 'dQw4w9WgXcQ', title: 'T' }, segments: [{ start: 0, text: 'a' }], durationSec: 60, style: 'normal', language: 'English', fetchImpl: ok });
  assert.equal(out.plan.segments.length, 1);
  assert.equal(out.model, 'gemini-2.5-flash');
  assert.deepEqual(body.generationConfig.responseSchema.properties.segments.items.properties.action.enum, ['keep', 'fast', 'skip']);
  assert.match(body.contents[0].parts[0].text, /\[0:00\] a/);
});

test('ремонт парсера: карточки нового формата → скелет → рецепт ИИ → проверка → разбор', async () => {
  const AI = require('../src/shared/ai.js');
  const P = parse;
  // Будущий формат: ключ карточки незнаком парсеру, поля лежат по-новому.
  const card = (id, title, ch, dur) => ({
    richItemRenderer: {
      content: {
        feedTileViewModel: {
          primaryCommand: { watchEndpoint: { videoId: id } },
          texts: { headline: { content: title }, owner: { runs: [{ text: ch }] } },
          badges: [{ label: '4K' }, { label: dur }],
          trackingParams: 'x'.repeat(200),
        },
      },
    },
  });
  const data = { contents: { richGridRenderer: { contents: [card('NEWfmtAAAA1', 'Первый', 'Канал А', '12:34'), card('NEWfmtAAAA2', 'Второй', 'Канал Б', '3:05'), card('NEWfmtAAAA3', 'Третий', 'Канал В', '1:00:00'), card('NEWfmtAAAA4', 'Четвёртый', 'Канал Г', '9:59')] } } };
  P.setLearned([]);
  assert.equal(P.extractVideos(data).length, 0); // основной парсер формат не знает
  const known = P.extractGeneric(data).map((v) => v.id);
  assert.equal(known.length, 4); // а общий поиск id видит
  const cards = P.findCards([data], known, 3);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].key, 'feedTileViewModel'); // не обёртка richItemRenderer
  const sk = P.skeleton(cards[0].node);
  assert.equal(sk.trackingParams, undefined); // служебное — не отправляем
  assert.ok(JSON.stringify(sk).length < 600);

  // «Ответ Gemini»: рецепт путей.
  const recipeJson = { renderer: 'feedTileViewModel', fields: { id: 'primaryCommand.watchEndpoint.videoId', title: 'texts.headline', channel: 'texts.owner', duration: 'badges[*].label', views: '', published: '' }, short: '', notes: 'Новый формат плитки' };
  let sentText = '';
  const fake = async (url, init) => {
    sentText = JSON.parse(init.body).contents[0].parts[0].text;
    return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(recipeJson) }] } }] }) };
  };
  AI.cooldown.clear();
  const out = await AI.repairRecipe({ key: 'k', models: ['gemini-2.5-flash'], page: 'home', ids: cards.map((c) => c.id), cards: cards.map((c) => ({ key: c.key, skeleton: P.skeleton(c.node) })), fetchImpl: fake });
  assert.match(sentText, /feedTileViewModel/);
  assert.equal(out.recipe.fields.title, 'texts.headline');

  // [*] — первый непустой элемент, но «4K» не похоже на длительность → следующий не берём автоматически:
  // поэтому длительность проверяем отдельно ниже; главное — id и названия.
  const check = P.validateRecipe(out.recipe, [data], known, known);
  assert.equal(check.ok, true);
  assert.equal(check.found, 4);
  assert.equal(check.titled, 4);
  // Плохой рецепт (id не туда) не принимается.
  assert.equal(P.validateRecipe({ ...out.recipe, fields: { ...out.recipe.fields, id: 'texts.headline' } }, [data], known, known).ok, false);
  // Известный ключ не перекрывается.
  assert.equal(P.validateRecipe({ ...out.recipe, renderer: 'videoRenderer' }, [data], known, known).ok, false);

  P.setLearned([out.recipe]);
  const vids = P.extractVideos(data);
  assert.deepEqual(vids.map((v) => [v.id, v.title, v.channel]), [['NEWfmtAAAA1', 'Первый', 'Канал А'], ['NEWfmtAAAA2', 'Второй', 'Канал Б'], ['NEWfmtAAAA3', 'Третий', 'Канал В'], ['NEWfmtAAAA4', 'Четвёртый', 'Канал Г']]);
  assert.ok(vids.every((v) => v.source === 'recipe:feedTileViewModel'));
  P.setLearned([]);

  // Пути рецепта.
  const node = { a: { b: [{ c: '' }, { c: { simpleText: 'да' } }] }, n: 754 };
  assert.equal(P.text(P.getPath(node, 'a.b[*].c')), 'да');
  assert.equal(P.text(P.getPath(node, 'a.b[1].c')), 'да');
  assert.equal(P.getPath(node, 'n'), 754);
  assert.equal(P.getPath(node, 'a.x.y'), undefined);
});

test('lyrics: LRC, приблизительные тайм-коды, выбор лучшего результата, цепочка источников', async () => {
  const L = require('../src/shared/lyrics.js');
  const lrc = L.parseLrc('[00:12.50] Привет\n[01:02.3]Мир\n[00:05]\n[ar: x]\nбез времени');
  assert.deepEqual(lrc.map((l) => [l.start, l.text]), [[5, ''], [12.5, 'Привет'], [62.3, 'Мир']]);

  // Обычный текст: время растёт, укладывается внутрь трека, пустые строки между куплетами схлопываются.
  const plain = L.plainLines('a\n\n\n\nb\r\nc\n\n');
  assert.deepEqual(plain, ['a', '', 'b', 'c']);
  const timed = L.spreadLines(['одна строка', 'вторая строка подлиннее', '', 'третья'], 200);
  assert.ok(timed[0].start >= 7 && timed[0].start < 12);
  assert.ok(timed.every((l, i) => i === 0 || l.start > timed[i - 1].start));
  assert.ok(timed[3].start < 200 * 0.96);

  // Лучший из поиска: исполнитель, название и длительность; чужая песня не подходит.
  const results = [
    { trackName: 'Another Song', artistName: 'Someone', duration: 200, plainLyrics: 'x\ny\nz' },
    { trackName: 'Blinding Lights', artistName: 'The Weeknd', duration: 201, plainLyrics: 'a\nb\nc', syncedLyrics: '[00:01.00] a\n[00:02.00] b\n[00:03.00] c' },
  ];
  assert.equal(L.pickBest(results, { artist: 'The Weeknd', track: 'Blinding Lights', durationSec: 200 }).trackName, 'Blinding Lights');
  assert.equal(L.pickBest(results, { artist: 'Nobody', track: 'Unknown', durationSec: 100 }), null);

  // Цепочка: точный запрос LRCLIB пуст → поиск LRCLIB → lyrics.ovh. Сетевые ошибки — это просто «нет текста».
  const calls = [];
  const info = { artist: 'The Weeknd', track: 'Blinding Lights', query: 'The Weeknd Blinding Lights', durationSec: 200 };
  const viaSearch = await L.lookup(async (url) => {
    calls.push(url);
    if (url.includes('/api/get')) return null;
    if (url.includes('/api/search')) return results;
    throw new Error('не должен дойти');
  }, info);
  assert.equal(viaSearch.source, 'LRCLIB');
  assert.equal(viaSearch.synced, true);
  assert.ok(calls[0].includes('artist_name=The%20Weeknd') && calls[0].includes('duration=200'));
  const viaOvh = await L.lookup(async (url) => {
    if (url.includes('lyrics.ovh')) return { lyrics: 'строка один\nстрока два\nстрока три\nстрока четыре' };
    if (url.includes('/search')) throw new Error('сеть');
    return null;
  }, info);
  assert.equal(viaOvh.source, 'lyrics.ovh');
  assert.equal(viaOvh.synced, false);
  assert.equal(viaOvh.lines.length, 4);
  assert.equal(await L.lookup(async () => null, info), null);
  // «инструментал» — не текст
  assert.equal(L.fromLrclib({ instrumental: true, plainLyrics: 'a\nb\nc' }, 100), null);
});

test('фильтр ленты: группировка по авторам, типу, длительности, языку и хештегам', () => {
  const R = require('../src/shared/feedrules.js');
  const card = (o) => ({ id: 'x', title: '', channel: '', channelUrl: '', durationSec: 0, lang: '', music: 0, ...o });
  const cards = [
    card({ id: 'a1', channel: 'Alpha', channelUrl: '/@alpha', durationSec: 300, lang: 'ru', title: 'Раз #джем #live' }),
    card({ id: 'a2', channel: 'Alpha', channelUrl: '/@alpha', durationSec: 5000, lang: 'ru', title: 'Два #джем' }),
    card({ id: 'b1', channel: 'Beta', channelUrl: '/@beta', durationSec: 100, lang: 'latin', short: true, title: 'Short' }),
    card({ id: 'b2', channel: 'Beta', channelUrl: '/@beta', durationSec: 200, lang: 'ru', music: 0.9, title: 'Трек' }),
    card({ id: 'c1', channel: 'Gamma', channelUrl: '/@gamma', durationSec: 0, live: true, title: 'Эфир' }),
    card({ id: 'd1', channel: '', title: 'Без канала' }),
  ];
  const ids = (g) => g.cards.map((c) => c.id).join(',');

  const byChannel = R.groupCards(cards, 'channel');
  assert.deepEqual(byChannel.map((g) => g.label || g.labelKey), ['Alpha', 'Beta', 'filter.group.other']); // Alpha и Beta по 2, одиночки — в «Остальные»
  assert.equal(ids(byChannel[0]), 'a1,a2');
  assert.deepEqual(byChannel[2].cards.map((c) => c.id).sort(), ['c1', 'd1']); // без канала и одиночка

  const byKind = R.groupCards(cards, 'kind');
  assert.deepEqual(byKind.map((g) => g.key), ['music', 'video', 'short', 'live']);
  assert.equal(R.kindOf(cards[3]), 'music');

  const byDur = R.groupCards(cards, 'duration');
  assert.deepEqual(byDur.map((g) => g.key), ['under4', 'mid', 'over60', 'unknown']);
  assert.equal(R.durationBucket(3599), 'long');

  const byLang = R.groupCards(cards, 'lang');
  assert.equal(byLang[0].key, 'ru');
  assert.equal(byLang[byLang.length - 1].labelKey, 'filter.group.other');

  const byTag = R.groupCards(cards, 'hashtag');
  assert.equal(byTag[0].label, '#джем'); // #live встретился один раз — отдельной группой не становится
  assert.equal(ids(byTag[0]), 'a1,a2');
  assert.equal(byTag[byTag.length - 1].key, '_other');

  assert.equal(R.normalizeRules({ groupBy: 'channel' }).groupBy, 'channel');
  assert.equal(R.normalizeRules({ groupBy: 'мусор' }).groupBy, 'none');
  assert.deepEqual(R.groupCards([], 'channel'), []);
  // Никто не повторяется — каждый автор получает свою группу, а не одну общую кучу.
  const singles = R.groupCards([card({ id: 's1', channel: 'Zed', channelUrl: '/@z' }), card({ id: 's2', channel: 'Ann', channelUrl: '/@a' })], 'channel');
  assert.deepEqual(singles.map((g) => g.label), ['Ann', 'Zed']);
});

test('очередь: порядок от ИИ всегда перестановка, перемешивание, треки из страницы микса', async () => {
  const A = require('../src/shared/ai.js');
  const R = require('../src/shared/feedrules.js');
  const M = require('../src/shared/music.js');
  // Мусор в ответе модели: дубли, чужие номера, пропуски — всё равно перестановка 0..4.
  assert.deepEqual(A.normalizeOrder([3, 3, 9, -1, 'x', 0], 5), [3, 0, 1, 2, 4]);
  assert.deepEqual(A.normalizeOrder(null, 3), [0, 1, 2]);
  const seq = [0.9, 0.1, 0.5, 0.3];
  let k = 0;
  const mixed = R.shuffled([1, 2, 3, 4, 5], () => seq[k++ % seq.length]);
  assert.deepEqual([...mixed].sort(), [1, 2, 3, 4, 5]);
  assert.equal(R.normalizeRules({ shuffle: 'ai' }).shuffle, 'ai');
  assert.equal(R.normalizeRules({ shuffle: 'x' }).shuffle, 'none');
  assert.equal(R.normalizeRules({}).expandMixes, true);
  assert.equal(R.normalizeRules({ expandMixes: false }).expandMixes, false);

  // orderTracks: запрос к Gemini подменён, id возвращаются в порядке модели.
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ order: [2, 0, 1] }) }] } }] }) });
  const res = await A.orderTracks({ key: 'k', model: 'gemini-2.5-flash', models: [{ id: 'gemini-2.5-flash' }], fetchImpl, tracks: [{ id: 'aaaaaaaaaaa', title: 'A' }, { id: 'bbbbbbbbbbb', title: 'B' }, { id: 'ccccccccccc', title: 'C' }] });
  assert.deepEqual(res.ids, ['ccccccccccc', 'aaaaaaaaaaa', 'bbbbbbbbbbb']);

  // Страница микса: ytInitialData со скобками и кавычками внутри строк.
  const data = { contents: { playlist: { contents: [
    { playlistPanelVideoRenderer: { videoId: 'aaaaaaaaaaa', title: { simpleText: 'Track {1} "x"' }, shortBylineText: { runs: [{ text: 'Artist' }] }, lengthText: { simpleText: '3:21' } } },
    { playlistPanelVideoRenderer: { videoId: 'bbbbbbbbbbb', title: { runs: [{ text: 'Two' }] }, shortBylineText: { runs: [{ text: 'B' }] }, lengthText: { simpleText: '1:02:03' } } },
    { playlistPanelVideoRenderer: { videoId: 'aaaaaaaaaaa', title: { simpleText: 'повтор' } } },
  ] } } };
  const html = '<script>var ytInitialData = ' + JSON.stringify(data) + ';</script><script>var other = {};</script>';
  const tracks = M.extractPlaylistTracks(html);
  assert.deepEqual(tracks.map((t) => [t.id, t.title, t.channel, t.durationSec]), [['aaaaaaaaaaa', 'Track {1} "x"', 'Artist', 201], ['bbbbbbbbbbb', 'Two', 'B', 3723]]);
  assert.deepEqual(M.extractPlaylistTracks('<html>нет данных</html>'), []);
});

test('чат трансляций: настройки, цвет ника, упоминания, скрытие, ответ в мини-чате', () => {
  const L = require('../src/shared/liverules.js');
  const d = L.normalize();
  assert.equal(d.chatWidth, 420);
  assert.equal(d.mentionSound, true);
  assert.ok(d.bots.includes('nightbot'));
  const n = L.normalize({ chatWidth: 5000, fontSize: 3, chatSide: 'left', timestamps: 'x', soundVolume: 2, aliases: ['a', 'a', ' b '], hideBots: 'yes' });
  assert.deepEqual([n.chatWidth, n.fontSize, n.chatSide, n.timestamps, n.soundVolume, n.aliases, n.hideBots], [900, 11, 'left', 'show', 1, ['a', 'b'], false]);

  // Один ник — всегда один цвет; регистр и «@» не важны.
  assert.equal(L.nameColor('@Vasya'), L.nameColor('vasya'));
  assert.notEqual(L.nameColor('vasya'), L.nameColor('petya'));
  assert.match(L.nameColor('x', false), /^hsl\(\d+ 70% 36%\)$/);

  // Упоминание: «@ник» или ник отдельным словом, но не часть другого слова.
  assert.equal(L.isMention('привет @Котик, как дела', ['Котик']), true);
  assert.equal(L.isMention('котик тут?', ['Котик']), true);
  assert.equal(L.isMention('котики милые', ['Котик']), false);
  assert.equal(L.isMention('hey @ab.c', ['ab.c']), true);
  assert.equal(L.isMention('что угодно', ['']), false);
  assert.equal(L.hasKeyword('Розыгрыш через час', ['розыгрыш']), true);

  // Скрытие: человек, бот, команда, суперчат; свои сообщения не скрываются никогда.
  const st = L.normalize({ hiddenUsers: { troll: 'Troll' }, hideBots: true, hideCommands: true, hidePaid: true });
  assert.equal(L.hideReason({ author: '@Troll', text: 'hi', type: 'text' }, st), 'user');
  assert.equal(L.hideReason({ author: 'Nightbot', text: 'hi', type: 'text' }, st), 'bot');
  assert.equal(L.hideReason({ author: 'a', text: '!discord', type: 'text' }, st), 'command');
  assert.equal(L.hideReason({ author: 'a', text: '', type: 'paid' }, st), 'paid');
  assert.equal(L.hideReason({ author: 'Troll', text: '!x', type: 'text', own: true }, st), '');
  assert.equal(L.hideReason({ author: 'a', text: 'ok', type: 'text' }, st), '');

  // Мини-чат: один собеседник — ответ сам начинается с «@ник », несколько или уже «@…» — как есть.
  assert.equal(L.replyText(' привет ', ['@Котик']), '@Котик привет');
  assert.equal(L.replyText('@кто-то да', ['Котик']), '@кто-то да');
  assert.equal(L.replyText('всем', ['a', 'b']), 'всем');
  assert.equal(L.replyText('   ', ['a']), '');
});

test('чат трансляций: вид Twitch, время без секунд, наборы смайликов', () => {
  const L = require('../src/shared/liverules.js');
  const d = L.normalize();
  assert.deepEqual([d.theme, d.emojiSet, d.timestamps, d.emojiSize], ['twitch', 'youtube', 'show', 24]);
  assert.equal(L.normalize({ theme: 'x', emojiSet: 'noto', emojiSize: 99 }).emojiSet, 'youtube');
  assert.equal(L.normalize({ emojiSize: 99 }).emojiSize, 48);
  // Время суток без секунд, 24 часа.
  assert.deepEqual(['12:07 PM', '1:05:33 AM', '9:41', '12:30 AM', '11:59 p.m.', 'вчера'].map(L.chatTime), ['12:07', '01:05', '09:41', '00:30', '23:59', '']);
  // Цвет Twitch — из 15 стандартных, всегда один и тот же для ника.
  const c = L.nameColor('Kotik', true, 'twitch');
  assert.match(c, /^#[0-9a-f]{6}$/);
  assert.equal(c, L.nameColor('@kotik', true, 'twitch'));
  // Стандартные эмодзи — да, свои смайлики канала «:_name:» и текст — нет.
  assert.equal(L.isEmoji('😂'), true);
  assert.equal(L.isEmoji('🇷🇺'), true);
  assert.equal(L.isEmoji(':_hello:'), false);
  assert.equal(L.isEmoji('a'), false);
  assert.deepEqual(L.emojiCodes('❤️'), ['2764', 'fe0f']);
  // Имена файлов наборов: FE0F убирается там, где набор так называет файлы, и есть запасной вариант.
  assert.deepEqual(L.emojiUrls('twemoji', '❤️'), ['https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/2764.svg', 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/2764-fe0f.svg']);
  assert.ok(L.emojiUrls('twemoji', '👨‍👩‍👧')[0].endsWith('/1f468-200d-1f469-200d-1f467.svg'));
  assert.equal(L.emojiUrls('apple', '❤️')[0], 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/2764-fe0f.png');
  assert.equal(L.emojiUrls('openmoji', '😂')[0], 'https://cdn.jsdelivr.net/npm/openmoji@15.1.0/color/svg/1F602.svg');
  assert.deepEqual(L.emojiUrls('youtube', '😂'), []);
  assert.deepEqual(L.emojiUrls('native', '😂'), []);
});

test('СДВГ-режим: пресеты и типы роликов в промте, «только лучшее» может пропускать больше', () => {
  const A = require('../src/shared/ai.js');
  assert.deepEqual(A.FOCUS_STYLE_IDS, ['ads', 'gentle', 'normal', 'hard', 'highlights']);
  assert.ok(A.FOCUS_KIND_IDS.includes('gaming') && A.FOCUS_KIND_IDS.includes('lecture'));
  const auto = A.focusPrompt('normal', 'Russian', '');
  assert.ok(auto.includes('First decide what kind of video') && auto.includes('- gaming:'));
  const game = A.focusPrompt('ads', 'Russian', 'gaming');
  assert.ok(game.includes('Video kind: gaming') && !game.includes('- lecture:') && game.includes('ads only'));
  // 85% «пропустить»: обычный стиль смягчает, «только лучшее» оставляет.
  const raw = { kind: 'gaming', segments: [{ start: '0:00', end: '1:30', action: 'keep' }, { start: '1:30', end: '8:00', action: 'skip', interest: 2 }, { start: '8:00', end: '10:00', action: 'skip', interest: 1 }] };
  const soft = A.normalizeFocus(JSON.parse(JSON.stringify(raw)), 600, 'normal');
  const best = A.normalizeFocus(JSON.parse(JSON.stringify(raw)), 600, 'highlights');
  assert.equal(soft.segments[1].action, 'fast');
  assert.equal(best.segments[1].action, 'skip');
  assert.equal(best.kind, 'gaming');
  assert.equal(A.normalizeFocus({ kind: 'мусор', segments: [] }, 10).kind, 'other');
});

test('чат: личные вкладки (группа и отдельные люди), текст с обращением, подсказка ников', () => {
  const L = require('../src/shared/liverules.js');
  const watch = ['Маша', 'Вася'];
  const m = (name, text, o = {}) => ({ key: L.nameKey(name), text, own: false, ...o });
  // Общий чат — всё; группа — только выбранные; человек — только он.
  assert.equal(L.inThread(m('Петя', 'x'), 'chat', watch), true);
  assert.equal(L.inThread(m('Маша', 'x'), 'group', watch), true);
  assert.equal(L.inThread(m('Петя', 'x'), 'group', watch), false);
  assert.equal(L.inThread(m('Вася', 'x'), 'маша', watch), false);
  assert.equal(L.inThread(m('Маша', 'x'), 'маша', watch), true);
  // Свои сообщения — во вкладке, откуда отправлены, или если начинаются с «@ник».
  assert.equal(L.inThread(m('Я', 'привет', { own: true, thread: 'маша' }), 'маша', watch), true);
  assert.equal(L.inThread(m('Я', 'привет', { own: true, thread: 'маша' }), 'вася', watch), false);
  assert.equal(L.inThread(m('Я', '@Маша как дела', { own: true }), 'маша', watch), true);
  assert.equal(L.inThread(m('Я', '@Машенька как дела', { own: true }), 'маша', watch), false);
  assert.equal(L.inThread(m('Я', '@Вася привет', { own: true }), 'group', watch), true);
  assert.equal(L.inThread(m('Я', 'всем привет', { own: true }), 'group', watch), false);
  // Текст: человеку — «@ник», группе — «@ник1 @ник2», уже начатое с «@» не трогаем, группе можно отключить обращение.
  assert.equal(L.composeText('привет', 'маша', watch), '@Маша привет');
  assert.equal(L.composeText('@Маша привет', 'маша', watch), '@Маша привет');
  assert.equal(L.composeText('привет', 'group', watch), '@Маша @Вася привет');
  assert.equal(L.composeText('привет', 'group', watch, false), 'привет');
  assert.equal(L.composeText('привет', 'chat', watch), 'привет');
  assert.equal(L.composeText('  ', 'group', watch), '');
  // Подсказка при наборе «@пр…».
  assert.deepEqual(L.mentionQuery('привет @Ма', 10), { start: 7, query: 'Ма' });
  assert.deepEqual(L.mentionQuery('@', 1), { start: 0, query: '' });
  assert.equal(L.mentionQuery('почта a@b.ru', 12), null);
  assert.equal(L.mentionQuery('привет @Маша ', 13), null);
  assert.deepEqual(L.suggestNames(['Ольга', 'Маша', 'машинист', 'Mark', 'Маша', 'Ромашка'], 'ма'), ['Маша', 'машинист', 'Ромашка']);
  assert.deepEqual(L.suggestNames(['a', 'b', 'c'], '', 2), ['a', 'b']);
  assert.equal(L.normalize({}).allMessages, true);
  assert.equal(L.normalize({ allMessages: false }).allMessages, false);
});

test('смайлики 7TV / BTTV / FFZ: разбор ответов, ссылка на набор, подстановка в текст', () => {
  const E = require('../src/shared/emotes.js');
  const L = require('../src/shared/liverules.js');
  // 7TV: набор и поиск. Модифицированные/скрытые и «пробельные» имена пропускаются.
  const stv = E.parseStvSet({ emotes: [{ id: '01FGH8NE3800064MEQW00DNBNG', name: 'reckH', data: { animated: false } }, { id: 'B', name: 'OMEGALUL', data: { animated: true } }, { id: 'C', name: 'bad name', data: {} }, { name: 'noid' }] });
  assert.deepEqual(stv, [['reckH', 'https://cdn.7tv.app/emote/01FGH8NE3800064MEQW00DNBNG/2x.webp', false], ['OMEGALUL', 'https://cdn.7tv.app/emote/B/2x.webp', true]]);
  const found = E.parseStvSearch({ data: { emotes: { items: [{ id: 'X1', name: 'Halloween', animated: true, listed: true }, { id: 'X2', name: 'hidden', listed: false }, { id: 'X3', name: 'pumpkin', animated: false }] } } });
  assert.deepEqual(found.map((e) => e[0]), ['Halloween', 'pumpkin']);
  assert.equal(E.parseStvSearch(null).length, 0);
  // BTTV (без модификаторов) и FFZ (адреса «//cdn…» становятся https).
  assert.deepEqual(E.parseBttv([{ id: 'a1', code: 'CiGrip', animated: false }, { id: 'a2', code: 'SoSnowy', modifier: true }]), [['CiGrip', 'https://cdn.betterttv.net/emote/a1/2x.webp', false]]);
  const ffz = E.parseFfz({ default_sets: [3], sets: { 3: { emoticons: [{ name: 'ZreknarF', urls: { 1: '//cdn.frankerfacez.com/emote/1/1', 2: '//cdn.frankerfacez.com/emote/1/2' } }, { name: 'mod', modifier: true, urls: { 1: '//x' } }] } } });
  assert.deepEqual(ffz, [['ZreknarF', 'https://cdn.frankerfacez.com/emote/1/2', false]]);
  // Ссылка или id набора 7TV.
  assert.equal(E.parseSetInput('https://7tv.app/emote-sets/01GD17VE2R000E0RPNH2V9Z16G'), '01GD17VE2R000E0RPNH2V9Z16G');
  assert.equal(E.parseSetInput('01GD17VE2R000E0RPNH2V9Z16G'), '01GD17VE2R000E0RPNH2V9Z16G');
  assert.equal(E.parseSetInput('привет'), '');
  // Слияние: раньше стоящий набор главнее, без повторов, не больше лимита.
  assert.deepEqual(E.merge([[['a', '1', false], ['b', '2', false]], [['a', '9', true], ['c', '3', false]]]).map((e) => e.join('|')), ['a|1|false', 'b|2|false', 'c|3|false']);
  assert.equal(E.merge([[['a', '1', false], ['b', '2', false]]], 1).length, 1);
  // Подстановка: целые слова, с учётом регистра, пробелы сохраняются; свой набор перекрывает 7TV.
  const map = E.buildMap(['custom:Z', '7tv-global'], { 'custom:Z': [['Kappa', 'u-custom', false]], '7tv-global': [['Kappa', 'u-7tv', false], ['OMEGALUL', 'u-o', true]] });
  assert.equal(map.get('Kappa').url, 'u-custom');
  assert.deepEqual(E.tokenize('ну OMEGALUL это  Kappa!', map), [{ t: 'text', v: 'ну ' }, { t: 'emote', name: 'OMEGALUL', url: 'u-o', animated: true }, { t: 'text', v: ' это  Kappa!' }]);
  assert.deepEqual(E.tokenize('omegalul', map), [{ t: 'text', v: 'omegalul' }]);
  assert.deepEqual(E.tokenize('Kappa', new Map()), [{ t: 'text', v: 'Kappa' }]);
  assert.ok(JSON.parse(E.stvSearchBody('halloween')).variables.q === 'halloween');
  // Настройки: список наборов очищается от мусора.
  const n = L.normalize({ emoteSets: ['7tv-global', '7tv-global', 'bad id!', 'event-halloween'], emoteCustom: '  https://7tv.app/emote-sets/x  ', emoteSize: 500 });
  assert.deepEqual([n.emoteSets, n.emoteCustom, n.emoteSize], [['7tv-global', 'event-halloween'], 'https://7tv.app/emote-sets/x', 64]);
  assert.deepEqual(L.normalize({}).emoteSets, []);
  // Добавленное из поиска 7TV: наборы по id и «популярное по слову»; мусор и повторы отбрасываются.
  const ex = L.normalize({ emoteExtra: [{ id: '01KXRH8G8P8QQ59S744TBB90T5', name: ' xQc ' }, { id: 'q:pepe', name: 'pepe' }, { id: 'bad id', name: 'x' }, { id: '01KXRH8G8P8QQ59S744TBB90T5', name: 'dup' }, { id: 'q:a', name: 'a' }], emoteChannelSet: { key: 'betboom', id: 'zz', name: 'N', count: '5' }, emoteChannel: true });
  assert.deepEqual(ex.emoteExtra, [{ id: '01KXRH8G8P8QQ59S744TBB90T5', name: 'xQc' }, { id: 'q:pepe', name: 'pepe' }]);
  assert.deepEqual(ex.emoteChannelSet, { key: 'betboom', id: '', name: 'N', count: 5 });
  assert.equal(ex.emoteChannel, true);
  assert.deepEqual([L.normalize({}).emoteExtra, L.normalize({}).emoteChannelSet, L.normalize({}).emoteChannel], [[], null, false]);
  // Набор смайликов канала на 7TV: имя совпадает точно (регистр, пробелы, точки не важны), привязанный YouTube важнее.
  const users = E.parseStvUsers({ data: { users: [
    { id: 'u1', username: 'betboom_cs_ru', display_name: 'betboom_cs_ru', connections: [{ platform: 'TWITCH', username: 'betboom_cs_ru', display_name: 'betboom_cs_ru', emote_set_id: '01KXRH8G8P8QQ59S744TBB90T5' }] },
    { id: 'u2', username: 'betboom', display_name: 'BetBoom', connections: [{ platform: 'TWITCH', username: 'betboom', display_name: 'BetBoom', emote_set_id: null }, { platform: 'YOUTUBE', username: 'betboom', display_name: 'BetBoom', emote_set_id: '01ABCDEFGHJKMNPQRSTVWXYZ12' }] },
    { id: 'u3', username: 'nosets', display_name: 'NoSets', connections: [{ platform: 'TWITCH', username: 'nosets', display_name: 'NoSets', emote_set_id: null }] },
  ] } });
  assert.deepEqual(users.map((u) => [u.user, u.platform, u.setId]), [['u1', 'TWITCH', '01KXRH8G8P8QQ59S744TBB90T5'], ['u2', 'YOUTUBE', '01ABCDEFGHJKMNPQRSTVWXYZ12']]);
  assert.equal(E.matchChannel(users, ['BetBoom']).user, 'u2');
  assert.equal(E.matchChannel(users, ['Bet Boom ']).user, 'u2');
  assert.equal(E.matchChannel(users, ['@BetBoom_CS_RU']).user, 'u1');
  assert.equal(E.matchChannel(users, ['BetBoom Poker']), null, 'похожее, но другое имя не берём');
  assert.equal(E.matchChannel(users, ['ab']), null, 'слишком короткие имена не сопоставляем');
  assert.deepEqual(E.parseStvSetInfo({ data: { emoteSetsByID: [{ id: 'a', name: ' CS3 ', emote_count: 225 }] } }), { a: { name: 'CS3', count: 225 } });
  assert.equal(JSON.parse(E.stvUsersBody('xqc')).variables.q, 'xqc');
});

test('вкус: слова, профиль из истории, ранжирование ленты без AI, мини-описание', () => {
  const T = require('../src/shared/taste.js');
  // Слова: служебные уходят, окончания срезаются, регистр не важен.
  assert.deepEqual(T.tokens('Покер: разбор раздачи — День 3 | THE Best Poker Hands'), ['покер', 'разбор', 'раздач', 'день', 'poker', 'hand']);
  assert.equal(T.stem('покера'), T.stem('покере'));
  assert.equal(T.stem('running'), T.stem('runs'));
  const hist = [
    { id: 'h1', title: 'Покер: разбор раздач турнира', channel: 'BetBoom Покер', channelUrl: '/@betboom', durationSec: 3600, progress: 100 },
    { id: 'h2', title: 'Покер турнир финал: лучшие раздачи', channel: 'BetBoom Покер', channelUrl: '/@betboom', durationSec: 4000, progress: 90 },
    { id: 'h3', title: 'Python для начинающих: функции и классы', channel: 'Код', channelUrl: '/@code', durationSec: 1500, progress: 80 },
    { id: 'h4', title: 'Рецепт борща', channel: 'Кухня', channelUrl: '/@kitchen', durationSec: 600, progress: 5 },
  ];
  const profile = T.buildProfile(hist);
  assert.equal(profile.n, 4);
  assert.ok(profile.terms.get('покер') > profile.terms.get('борщ'), 'недосмотренный борщ весит меньше');
  assert.equal(profile.channels.get('/@betboom').count, 2);
  assert.ok(profile.medianDur >= 1500 && profile.medianDur <= 4000);
  assert.deepEqual(T.summarize(profile, 2).channels[0], { name: 'BetBoom Покер', count: 2 });
  const cands = [
    { id: 'c1', title: 'Покер: финал недели, разбор раздач', channel: 'BetBoom Покер', channelUrl: '/@betboom', durationSec: 3500 },
    { id: 'c2', title: 'Разбор покерных раздач для новичков', channel: 'Школа', channelUrl: '/@school', durationSec: 2400 },
    { id: 'c3', title: 'Python: декораторы и классы подробно', channel: 'Код', channelUrl: '/@code', durationSec: 1800 },
    { id: 'c4', title: 'Рецепты десертов на неделю', channel: 'Кухня', channelUrl: '/@kitchen', durationSec: 700 },
    { id: 'c5', title: 'Покер за 30 секунд', channel: 'Клипы', channelUrl: '/@clips', durationSec: 30, short: true },
    { id: 'h1', title: 'Покер: разбор раздач турнира', channel: 'BetBoom Покер', channelUrl: '/@betboom', durationSec: 3600 },
    { id: 'c6', title: 'Покер прямой эфир', channel: 'Эфир', channelUrl: '/@live', durationSec: 0, live: true },
    { id: 'c7', title: 'Покер: ещё раздачи турнира', channel: 'BetBoom Покер', channelUrl: '/@betboom', durationSec: 3500 },
    { id: 'c8', title: 'Покер: третья раздача турнира', channel: 'BetBoom Покер', channelUrl: '/@betboom', durationSec: 3500 },
  ];
  const picks = T.rank(cands, profile, { limit: 4 });
  const ids = picks.map((p) => p.video.id);
  assert.ok(['c1', 'c7', 'c8'].includes(ids[0]), 'тот же автор и те же темы — первыми');
  assert.ok(ids.includes('c2') && ids.includes('c3'));
  assert.ok(!ids.includes('c5') && !ids.includes('h1') && !ids.includes('c6'), 'Shorts, уже просмотренное и эфир не предлагаются');
  assert.ok(ids.filter((i) => ['c1', 'c7', 'c8'].includes(i)).length <= 2, 'не больше двух роликов одного автора');
  assert.deepEqual(picks[0].reasons.channel, { name: 'BetBoom Покер', count: 2 });
  // Ссылка на канал в карточке может быть записана иначе, чем в истории — тогда автор узнаётся по названию.
  const viaName = T.rank([{ id: 'n1', title: 'Покер турнир', channel: 'BetBoom Покер', channelUrl: '/channel/UC123', durationSec: 3000 }], profile, { limit: 1 });
  assert.deepEqual(viaName[0].reasons.channel, { name: 'BetBoom Покер', count: 2 });
  // На экран слова попадают в том виде, как были в тексте, а не обрезанными основами.
  assert.deepEqual(T.tokens('Python для начинающих: классы').map(T.show), ['python', 'начинающих', 'классы']);
  assert.ok(!ids.slice(0, 2).includes('c4'), 'десерты не в начале');
  assert.ok(picks[0].reasons.terms.includes('покер'));
  assert.ok(picks[0].score > picks[picks.length - 1].score);
  // Отклонённый автор исчезает, понравившийся поднимается.
  assert.ok(!T.rank(cands, profile, { limit: 9, banned: { channels: new Set(['/@betboom']) } }).some((p) => p.video.id === 'c1'));
  assert.equal(T.rank(cands, T.buildProfile([]), { limit: 3 }).length, 0, 'без истории подбирать не по чему');
  // Страница ролика → описание и ключевые слова; мини-описание без ссылок, таймкодов и рекламы.
  const html = '..."videoId":"abc12345678"... "shortDescription":"Разбираем раздачи финала.\\nСмотрите, как играют лучшие. Вторая мысль здесь.\\n0:00 Начало\\nhttps://t.me/x\\nПодписывайтесь на канал!","keywords":["покер","турнир","BetBoom"],"category":"Sports","lengthSeconds":"3500"';
  const meta = T.parseWatchMeta(html, 'abc12345678');
  assert.deepEqual([meta.keywords, meta.category, meta.lengthSec], [['покер', 'турнир', 'BetBoom'], 'Sports', 3500]);
  assert.equal(T.parseWatchMeta(html, 'zzzzzzzzzzz'), null);
  const mini = T.miniDescription(meta);
  assert.ok(mini.startsWith('Разбираем раздачи финала.') && !/https|0:00|Подписывайтесь/.test(mini), mini);
  assert.equal(T.miniDescription({ desc: '', keywords: ['a1', 'b2'] }), 'a1, b2');
  assert.equal(T.miniDescription(null), '');
  // Ответ AI: лишние и повторяющиеся id отбрасываются, недостающее дописывается из исходного порядка.
  assert.deepEqual(T.normalizePicks({ picks: [{ id: 'c3', why: ' потому ' }, { id: 'zzz' }, { id: 'c3' }] }, ['c1', 'c2', 'c3'], 2), [{ id: 'c3', why: 'потому' }, { id: 'c1', why: '' }]);
  assert.deepEqual(T.normalizePicks(null, ['a', 'b'], 5).map((p) => p.id), ['a', 'b']);
});

test('durationToSeconds и fileName', () => {
  assert.equal(feed.durationToSeconds('10:23'), 623);
  assert.equal(feed.durationToSeconds('1:02:03'), 3723);
  assert.equal(feed.durationToSeconds('LIVE'), null);
  assert.equal(feed.fileName({}, new Date(2026, 9, 4)), 'yt_feed_2026-10-04.json');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  ✓', t.name);
    } catch (err) {
      failed++;
      console.log('  ✗', t.name, '\n   ', err.message);
    }
  }
  console.log(failed ? `\n${failed} из ${tests.length} упало` : `\nВсе ${tests.length} тестов прошли`);
  process.exitCode = failed ? 1 : 0;
})();
