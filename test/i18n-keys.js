/*
 * Все ключи переводов, которые использует код: статические tr('…') / t('…') / data-i18n="…"
 * плюс динамические (собираются из префикса и значения). Используется в test/run.js
 * и вручную: node test/i18n-keys.js — печатает список.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

const DYNAMIC = [
  ...['home', 'watch-later', 'history', 'shorts'].flatMap((t) => [`feed.${t}`, `feedShort.${t}`, `goal.${t}`]),
  ...['auto', 'light', 'dark'].map((t) => `theme.${t}`),
  ...['primary-empty', 'primary-low', 'titles-missing', 'drop'].map((r) => `health.${r}`),
  ...['short', 'long', 'author', 'tag'].map((r) => `skip.${r}`),
  ...Array.from({ length: 11 }, (_, i) => `pro.msg.${i}`),
  ...Array.from({ length: 8 }, (_, i) => `pro.encore.${i}`),
  ...['notSnapshot', 'unknownFormat', 'newerVersion', 'noFeeds', 'noVideos', 'tooBig', 'empty', 'badJson', 'noCode', 'codeTooLong', 'codeBroken'].map((c) => `err.${c}`),
  ...['badId', 'html5', 'removed', 'noEmbed'].map((c) => `player.err.${c}`),
  ...['noKey', 'keyInvalid', 'keyDenied', 'model', 'quota', 'server', 'blocked', 'failed'].map((c) => `ai.err.${c}`),
  ...['standard', 'brief', 'detailed', 'study', 'facts', 'clickbait', 'custom'].map((p) => `ai.preset.${p}`),
  'step.pending', 'step.cancelled',
  'time.m', 'time.hm', 'n.views',
];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      if (name !== 'locales') walk(p, out);
    } else if (/\.(js|html)$/.test(name)) out.push(p);
  }
  return out;
}

function usedKeys() {
  const keys = new Set(DYNAMIC);
  for (const file of walk(SRC)) {
    const s = fs.readFileSync(file, 'utf8');
    for (const m of s.matchAll(/\btr\(\s*'([a-zA-Z][\w.-]*)'/g)) keys.add(m[1]);
    for (const m of s.matchAll(/\btr\(\s*[\w.]+\s*\?\s*'([\w.-]+)'\s*:\s*'([\w.-]+)'/g)) keys.add(m[1]).add(m[2]);
    for (const m of s.matchAll(/\btr\(\s*\w+(?:\.\w+)*\s*\?\s*'([\w.-]+)'\s*:\s*\w+(?:\.\w+)*\s*\?\s*'([\w.-]+)'\s*:\s*'([\w.-]+)'/g)) keys.add(m[1]).add(m[2]).add(m[3]);
    for (const m of s.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria)?="([\w.-]+)"/g)) keys.add(m[1]);
    for (const m of s.matchAll(/i18n\.t\('([\w.-]+)'/g)) keys.add(m[1]);
    for (const m of s.matchAll(/'((?:ai|text|player|count|toast|share|popup|options|shortsSettings|panel|badge|collect|bg|common|stats|diff|compare)\.[\w.-]+)'/g)) keys.add(m[1]);
  }
  return [...keys].filter((k) => !k.endsWith('.')).sort();
}

module.exports = { usedKeys };
if (require.main === module) console.log(usedKeys().join('\n'));
