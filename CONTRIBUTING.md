# Contributing

Thanks for helping! Issues and pull requests are welcome, in English or Russian.

## Setup

There are no dependencies and no build step.

1. Load the folder as an unpacked extension (`chrome://extensions` → Developer mode → **Load unpacked**).
2. After you change something, press **Reload** on the extension card and reload your YouTube tabs. Content scripts are only injected when a page loads.
3. Run the tests (Node 18+):

   ```bash
   node test/run.js
   ```

Please keep every test green: the translation test fails if a key is missing in any language.

## Code style

- Plain modern JavaScript, no frameworks and no bundler. Shared modules attach to `globalThis.YFS` and also export themselves for Node tests.
- Code comments are mostly in Russian. English comments are welcome too.
- Every string the user sees goes through i18n: `tr('key')` in JS and `data-i18n="key"` in HTML.
- Content scripts on youtube.com draw their UI in **shadow DOM** and never use `innerHTML` (YouTube enforces Trusted Types).
- Keep work on regular YouTube pages close to zero. Timers and heavy parsing run only when they are needed.

## Common tasks

### YouTube broke the collection
1. In the popup, press **Download a debug sample**. It is the raw YouTube response.
2. Put it into `test/fixtures/` and add `"expect": { "ids": ["…", "…"] }` with the video IDs you can see on the page.
3. Fix `src/shared/parse.js` until `node test/run.js` passes. The older fixtures guard against regressions.

### The transcript doesn’t load
The panel shows a details line under the error, for example `panel:none, transcript:400, player:no-url`. Please include it in your issue. The routes are tried in order in `src/content/ytfetch.js`.

### Add a language
1. Copy `src/locales/ru.json` (or translate from `src/locales/en.js`) to `src/locales/<code>.json`.
2. Add the language to `LANGUAGES` in `src/shared/i18n.js`.
3. Add `_locales/<code>/messages.json` with `extName` and `extDesc`.
4. Run the tests. They check every key, every `{placeholder}` and the plural forms (`Intl.PluralRules`).

### Add or tune a summary preset
- Prompts live in `src/shared/ai.js`: `PROMPT_BASE` (shared rules) and `PRESET_SPECS` (task and field rules for each preset, in English and Russian).
- A new preset needs the i18n key `ai.preset.<id>` in every locale, plus the id in the `DYNAMIC` list in `test/i18n-keys.js`.
- Every preset must describe all schema fields: `tags`, `summary`, `keyPoints`, `chronology`, `audience`. The tests check this.

## Pull requests

- One topic per PR. Explain what changed and how you tested it.
- For UI changes, add a screenshot.
- Don’t commit personal data: snapshots of your own history, API keys, debug samples with your account.
