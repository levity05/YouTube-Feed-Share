/*
 * Статистика и сравнение снимков. Чистые функции без DOM — работают в viewer и в Node-тестах.
 * Всё считается локально из экспортированных данных.
 */
(function (root) {
  'use strict';

  const F = root.YFS && root.YFS.feed ? root.YFS.feed : typeof require === 'function' ? require('../shared/feed.js') : null;

  function channelKey(v) {
    return v.channelUrl || (v.channel ? 'name:' + v.channel.toLowerCase() : '');
  }

  /** Сводка по списку роликов. */
  function feedStats(videos) {
    const channels = new Map();
    let totalSec = 0;
    let timed = 0;
    for (const v of videos) {
      const key = channelKey(v);
      if (key) {
        const c = channels.get(key) || { name: v.channel || '', channelUrl: v.channelUrl || '', count: 0 };
        c.count++;
        channels.set(key, c);
      }
      const sec = F.durationToSeconds(v.duration);
      if (sec !== null) {
        totalSec += sec;
        timed++;
      }
    }
    const topChannels = Array.from(channels.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
    return {
      count: videos.length,
      channels: channels.size,
      totalSec,
      avgSec: timed ? Math.round(totalSec / timed) : 0,
      shorts: videos.filter((v) => v.short).length,
      topChannels,
    };
  }

  function dayDiff(fromDay, toDay) {
    return Math.round((new Date(toDay + 'T00:00:00') - new Date(fromDay + 'T00:00:00')) / 86400000);
  }

  /** Примерное время просмотра: длительность × досмотренная доля (если доли нет — целиком). */
  function watchSeconds(v) {
    const sec = F.durationToSeconds(v.duration);
    if (sec === null) return 0;
    return Math.round((sec * (v.progress || 100)) / 100);
  }

  /** История: сегодня, последние 7 дней и разбивка по дням — относительно даты снимка. */
  function historyStats(videos, exportedAt) {
    const refDay = F.localDay(new Date(exportedAt));
    const bucket = () => ({ count: 0, watchSec: 0 });
    const today = bucket();
    const week = bucket();
    const byDay = new Map();
    let undated = 0;
    for (const v of videos) {
      if (!v.watchedDay) {
        undated++;
        continue;
      }
      const ago = dayDiff(v.watchedDay, refDay);
      const sec = watchSeconds(v);
      if (ago === 0) {
        today.count++;
        today.watchSec += sec;
      }
      if (ago >= 0 && ago <= 6) {
        week.count++;
        week.watchSec += sec;
      }
      const d = byDay.get(v.watchedDay) || { day: v.watchedDay, ...bucket() };
      d.count++;
      d.watchSec += sec;
      byDay.set(v.watchedDay, d);
    }
    return {
      today,
      week,
      undated,
      totalWatchSec: videos.reduce((n, v) => n + watchSeconds(v), 0),
      byDay: Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? 1 : -1)),
    };
  }

  /** Полная статистика снимка (скрытые ролики стоит отфильтровать до вызова). */
  function snapshotStats(snap) {
    const seen = new Set();
    const all = [];
    const feeds = {};
    for (const f of snap.feeds) {
      feeds[f.type] = feedStats(f.videos);
      for (const v of f.videos) {
        if (!seen.has(v.id)) {
          seen.add(v.id);
          all.push(v);
        }
      }
    }
    const history = snap.feeds.find((f) => f.type === 'history');
    return {
      total: feedStats(all),
      feeds,
      history: history ? historyStats(history.videos, snap.exportedAt) : null,
    };
  }

  /** Сравнение по video.id: что появилось и что исчезло. */
  function diffVideos(baseVideos, currentVideos) {
    const baseIds = new Set(baseVideos.map((v) => v.id));
    const currentIds = new Set(currentVideos.map((v) => v.id));
    return {
      added: currentVideos.filter((v) => !baseIds.has(v.id)),
      removed: baseVideos.filter((v) => !currentIds.has(v.id)),
      kept: currentVideos.length - currentVideos.filter((v) => !baseIds.has(v.id)).length,
    };
  }

  /** Сравнение снимков по одноимённым лентам. Ленты, которой нет в базе, помечаются baseMissing. */
  function diffSnapshots(base, current) {
    return current.feeds.map((f) => {
      const b = base.feeds.find((x) => x.type === f.type);
      if (!b) return { type: f.type, baseMissing: true, added: [], removed: [], kept: 0 };
      return { type: f.type, baseMissing: false, ...diffVideos(b.videos, f.videos) };
    });
  }

  /** «1,2 млн просмотров», "1.2M views", «1 234 567 просмотров» → число; непонятное → null. */
  function parseViews(text) {
    if (!text) return null;
    const t = String(text).toLowerCase().replace(/[  ]/g, ' ');
    const m = t.match(/(\d[\d\s.,]*)\s*([a-zа-яё]*)/);
    if (!m) return null;
    const unit = m[2];
    let mult = 1;
    if (/^(млрд|миллиард|b)/.test(unit)) mult = 1e9;
    else if (/^(млн|миллион|m)/.test(unit)) mult = 1e6;
    else if (/^(тыс|k)/.test(unit)) mult = 1e3;
    const raw = m[1].trim();
    const num = mult === 1 ? Number(raw.replace(/[\s.,]/g, '')) : Number(raw.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(num) ? Math.round(num * mult) : null;
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
  }

  function formatHours(sec) {
    const m = Math.round(sec / 60);
    const i18n = root.YFS && root.YFS.i18n;
    if (i18n) return m < 60 ? i18n.t('time.m', { m }) : i18n.t('time.hm', { h: Math.floor(m / 60), m: m % 60 });
    if (m < 60) return `${m} мин`;
    return `${Math.floor(m / 60)} ч ${m % 60} мин`;
  }

  const api = { feedStats, historyStats, snapshotStats, diffVideos, diffSnapshots, parseViews, formatDuration, formatHours, channelKey };
  root.YFS = root.YFS || {};
  root.YFS.analytics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
