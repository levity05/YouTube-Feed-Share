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
  const req = AI.buildRequest({ video: { id: 'dQw4w9WgXcQ', title: 'Rick', channel: 'Rick Astley', duration: '3:33' }, segments: [{ start: 18, text: 'never gonna' }], language: 'Russian' });
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
  assert.equal(AI.promptFor('standard', 'X'), AI.DEFAULT_PROMPT);
  assert.equal(AI.promptFor('custom', 'X'), 'X');
  assert.match(AI.promptFor('brief'), /exactly 3/);
  // Встроенные промты: все поля схемы, {language}, общие правила; в русском интерфейсе — по-русски.
  for (const id of AI.PRESET_IDS) {
    for (const lang of ['en', 'ru']) {
      const p = AI.builtinPrompt(id, lang);
      for (const field of ['"tags"', '"summary"', '"keyPoints"', '"chronology"', '"audience"', '{language}']) assert.ok(p.includes(field), `${id}/${lang}: ${field}`);
    }
  }
  assert.match(AI.builtinPrompt('study', 'ru'), /конспект/);
  assert.equal(AI.builtinPrompt('study', 'de'), AI.builtinPrompt('study', 'en')); // нет перевода — английский
  // Правка встроенного, свои пресеты, старый «свой промт».
  const settings = { overrides: { brief: 'MY BRIEF' }, presets: [{ id: 'p1', name: 'Мой', text: 'P1' }], prompt: 'LEGACY' };
  const list = AI.presetList(settings, 'ru');
  assert.deepEqual(list.map((p) => p.id), [...AI.PRESET_IDS, 'custom', 'p1']);
  assert.equal(list.find((p) => p.id === 'brief').edited, true);
  assert.equal(AI.presetText(settings, 'brief', 'ru'), 'MY BRIEF');
  assert.equal(AI.presetText(settings, 'p1', 'ru'), 'P1');
  assert.equal(AI.presetText(settings, 'custom', 'ru'), 'LEGACY');
  assert.equal(AI.presetText(settings, 'nope', 'ru'), AI.builtinPrompt('standard', 'ru'));
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
