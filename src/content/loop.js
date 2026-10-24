/*
 * Общий таймер content scripts на youtube.com.
 *
 * Вместо отдельного setInterval в каждом модуле (кнопки, аудио-режим, место остановки, панель Shorts…) —
 * один таймер на 0,5 с, который сам по себе ничего не делает и раздаёт «тики» задачам по их периоду.
 * В фоновой вкладке выполняются только задачи с { hidden: true } (например, запомнить место в играющем ролике).
 * Задач нет — таймер остановлен.
 */
(function () {
  'use strict';
  const YFS = (globalThis.YFS = globalThis.YFS || {});
  if (YFS.loop) return;

  const tasks = new Set();
  let timer = 0;

  function tick() {
    const now = Date.now();
    const hidden = document.hidden;
    for (const t of tasks) {
      if (hidden && !t.hidden) continue;
      if (now - t.last < t.ms) continue;
      t.last = now;
      try {
        t.fn();
      } catch {
        /* задача не должна ронять остальные */
      }
    }
  }

  /** Вызывать fn каждые ms мс. Возвращает функцию отписки. */
  function every(ms, fn, { hidden = false } = {}) {
    const task = { ms: Math.max(500, ms), fn, hidden, last: Date.now() };
    tasks.add(task);
    if (!timer) timer = setInterval(tick, 500);
    return () => {
      tasks.delete(task);
      if (!tasks.size && timer) {
        clearInterval(timer);
        timer = 0;
      }
    };
  }

  YFS.loop = {
    every,
    get size() {
      return tasks.size;
    },
  };
})();
