# YouTube Feed Share

**English** · [Русский](README.ru.md)

> Take a snapshot of your YouTube and share it — plus video transcripts, AI summaries, an ADHD mode that skips the filler, a feed filter, an audio-only mode with synced text and a reliable “continue watching” list.

![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
[![Release](https://img.shields.io/github/v/release/levity05/YouTube-Feed-Share?color=ff0033)](https://github.com/levity05/YouTube-Feed-Share/releases/latest)
![Languages](https://img.shields.io/badge/UI-12%20languages-2ba640)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![No server](https://img.shields.io/badge/server-none-lightgrey)

A Chrome extension that works right on youtube.com. There is no server and no account: everything stays in your browser.

---

## ✨ Features

| | |
|---|---|
| 📦 **Feed snapshots** | Collect Home, Watch later, History and Shorts into one snapshot. Send it as a JSON file or a short code. Your friend browses it in a built-in “micro-YouTube” with tabs, a player, stats and a diff between snapshots (“What’s new?”). |
| 📝 **Video text** | The transcript of any video, with or without timestamps. Copy it or download it as `Title - Channel.txt`. Click a timestamp to jump to that moment. The language matches what YouTube plays (audio track first, then the default subtitles). |
| ✨ **AI summaries** | Gemini with your own free [Google AI Studio](https://aistudio.google.com/apikey) key. You get topic tags, a summary, key points, a clickable timeline and “who it’s for”. Six presets: Standard, Brief, Detailed, Study notes, Facts & numbers, Answer the title. The built-in prompts are written in all 12 interface languages and switch with the language; you can edit them (per language) or add your own. |
| ⚡ **ADHD mode** | Gemini reads the transcript and plans the video: ▶ watch the key parts, ⏩ play slow parts at 1.5–2×, ⏭ skip the filler. The mode then runs the video for you and shows in a few words what it skipped (with “↩ Back”). A coloured plan strip under the player; Gentle / Balanced / Strict; any part can be changed by hand. |
| 🎛 **Feed filter** | Rebuild Home, Subscriptions, Search and the recommendations next to a video: hide Shorts, streams, premieres, watched videos and mixes; filter by length, title language, channels, words and #hashtags; keep only music; sort by newest, views or length. Or **show the feed grouped** — by author, type, length, language or hashtag. The extension can find all the music by itself: it switches on the “Music” and “Jams” chips, opens “More”, scrolls the feed and takes the tracks out of mixes. |
| ⭐ **Picks for your taste** | Looks at your last ~100 watched videos and finds similar ones in the loaded feed — **without AI** (a plain calculation of topics, channels, length and language), with a short description of each video and the reason it was picked. 1, 3, 5 or 10 videos; 👍 / 👎 teach it. Optionally one short Gemini request picks the best and explains why. |
| 🎵 **Music** | Spots music videos, builds a queue of the tracks on the page and plays it in a row (“▶ Play in a row” builds your own queue of up to 500 tracks — in order, shuffled or arranged by Gemini; headphone buttons switch tracks). A **“Where to listen”** button under every track finds it on Spotify, Apple Music, Yandex Music, YouTube Music, SoundCloud, Deezer and VK. |
| 🧠 **Self-repairing parser** | The parser has fallbacks (generic ID search, DOM links). Optionally, when YouTube changes its card format, Gemini looks at 2–3 trimmed cards and returns a “recipe” — paths to the fields. It is data, not code, and is checked on the same response before it is used. |
| ⚖️ **Model balancer** | If a model is overloaded or out of quota, the extension retries or switches to the next one (flash → flash-lite → pro). “Thinking” is turned off for speed. Summaries are cached per preset. |
| 🎧 **Audio mode** | Hides the player and recommendations and shows a music-app-like screen: the text in the centre, a player strip at the bottom (cover, chapters, volume, speed, sleep timer, previous / next track) and the queue sliding out from the right. The transcript is **synced with the audio**: the current line is highlighted and scrolls by itself, and clicking a line seeks there. Tabs: Transcript, **Song** (lyrics from LRCLIB / lyrics.ovh) and the **ADHD plan** (also drawn on the seek bar). Video quality drops to the minimum to save data. |
| 📡 **Live streams** | A comfortable stream layout (full-height chat with an adjustable width, left or right) and a Twitch-style live chat of its own (it draws the chat itself and takes only the messages from YouTube): one-line messages, badges, conversation tabs (group or one person) with replies, “@” suggestions, “chat paused” bar, HH:MM time, Twitch nickname colors, emoji sets (Twemoji, Apple, Google, Facebook, OpenMoji), mention highlight and sound, emotes from 7TV / BetterTTV / FrankerFaceZ (global, event packs, the stream channel’s own and any streamer found by name), click-to-reply, a mini chat with only the people you picked, hiding bots and commands, the person’s message history. |
| ⏯ **Continue watching** | Remembers where you stopped, locally (YouTube sometimes forgets). The popup shows your last 5 unfinished videos, and one click resumes from that exact moment. |
| ⚡ **Shorts tools** | Auto-scroll to the next Short. Skip rules by length, author and hashtag. Headphone and media keys work as “next Short”, even when the window isn’t focused (second monitor). |
| 🌍 **12 languages** | English, Русский, Українська, Español, Português, Français, Deutsch, Italiano, Polski, Türkçe, 日本語, 简体中文. |

## 🚀 Install

The extension is not in the Chrome Web Store yet, so it is installed in developer mode:

1. Download `youtube-feed-share-v4.6.0.zip` from the [latest release](https://github.com/levity05/YouTube-Feed-Share/releases/latest) and unzip it. Or clone the repository: `git clone https://github.com/levity05/YouTube-Feed-Share.git`.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. Pin the extension and open any YouTube video.

To update, replace the files, press **Reload** on the extension card and reload your YouTube tabs.

## 🧭 Quick start

**On a YouTube video**
- Under the video title there are three buttons: **📝 Video text**, **✨ Short summary** and **🎧 Audio mode**. The same buttons are in the popup.
- For summaries, paste a free Gemini key in **⚙ Settings → AI summaries** (or straight into the panel) and press **Check**.

**Share your feed**
1. Popup → **📦 Snapshot** tab → choose sections → **Collect a snapshot**. The extension opens the sections and scrolls them by itself.
2. **Review and share**: hide anything you don’t want to send, especially in History.
3. Send the **JSON file**. Your friend drops it into the viewer (popup → 📺) or presses Ctrl+V with a code.

**Continue watching**: popup → **▶ Watch** tab.

## ✨ AI summaries in detail

- **Your key, your quota.** The key is stored only in this browser (`chrome.storage.local`) and is sent only to `generativelanguage.googleapis.com`.
- **Presets.** The prompts are built from a shared base: the input is usually an auto-generated transcript with recognition errors; facts only; no filler; concrete numbers; opinions stated as opinions; answer the title’s question; timestamps copied from the transcript; a silent self-check. Each preset adds its own task and field rules. Edit them with ✎ in the panel or in **Settings → Summary presets**.
- **No transcript?** Gemini watches the public video by its URL instead.
- **Balancer.** On 503 the extension retries in about 1 second, then moves to the next model. On 429, 404 or a timeout it switches models right away. Busy models cool down for 2–10 minutes. You can watch progress and cancel at any time.

## 🔒 Privacy

- No server, no analytics, no tracking. Snapshots, positions, summaries and settings live in `chrome.storage.local`.
- Network requests go only to YouTube (as your own page would) and, if you add a key, to Google’s Gemini API.
- Snapshots can contain your **watch history**. Review them before sending.

Full details: [PRIVACY.md](PRIVACY.md).

## 🌐 Viewer without the extension

`src/viewer/viewer.html` is a static page, so your friend doesn’t need the extension:

1. Publish the repository with **GitHub Pages**: Settings → Pages → Deploy from branch.
2. Paste `https://<user>.github.io/<repo>/src/viewer/viewer.html` into **Settings → Sharing snapshots**.
3. **Copy** now gives a ready link. The data lives in the `#…` fragment and is never sent to a server.

Locally: `python -m http.server 8765` → <http://localhost:8765/src/viewer/viewer.html>. Opening the file with a double click (`file://`) won’t play videos (YouTube error 153).

## 🛠 How it works

| Path | Role |
|---|---|
| `src/background.js` | Runs the collection job; lets YouTube pages play inside the extension’s own viewer (DNR rule scoped to the extension); relays Gemini requests |
| `src/content/hook.js` | Page (MAIN) world: watches feed responses, talks to the YouTube player (subtitles, quality) |
| `src/content/collector.js` | Collection per page: scrolling, filters, history days, Shorts |
| `src/content/watchtools.js` | Buttons and the Text / Summary panel on youtube.com/watch |
| `src/content/audiomode.js` | 🎧 Audio mode with the synced transcript |
| `src/content/resume.js` | ⏯ Remembers playback positions |
| `src/content/focusmode.js` | ⚡ ADHD mode: the plan, playback control, the plan strip |
| `src/content/feedfilter.js`, `src/shared/feedrules.js` | 🎛 Feed filter: the panel on YouTube and the rules (pure functions) |
| `src/shared/taste.js` | ⭐ Taste: words and stems, the profile from the history, ranking of the feed cards, the mini description (pure functions) |
| `src/shared/music.js` | 🎵 Is it a track, “Artist — Track”, links to other services, the play queue |
| `src/content/livechat.js`, `src/content/livemode.js`, `src/shared/liverules.js` | 📡 Live chat features (inside the chat frame), the stream page layout and their rules |
| `src/content/loop.js` | One shared timer for all content scripts (idle in background tabs) |
| `src/content/ytfetch.js` | Gets the transcript in several ways (YouTube panel, signed subtitles, page fallback) |
| `src/shared/parse.js` | ID-first parser: known YouTube renderers, generic ID search, DOM fallback, breakage detector |
| `src/shared/ai.js` | Gemini: one JSON call with the model balancer, prompt presets (texts are `prompt.*` keys in the locale files), ADHD plan, parser-repair recipe |
| `src/shared/transcript.js` | Transcript parsers and text formatting |
| `src/shared/feed.js` | Snapshot format v2, the `YFS2.` code (deflate + base64url) |
| `src/viewer/*` | The “micro-YouTube” viewer: library, tabs, Shorts, stats, diff, player, text panel |
| `src/popup/*`, `src/options/*`, `src/shorts/*` | Popup, settings, Shorts settings |
| `src/locales/*`, `_locales/*` | Translations (`en.js` is the reference dictionary) |

<details>
<summary>Snapshot format (v2)</summary>

```json
{ "format": "yt-feed-share", "version": 2, "exportedAt": "…", "author": "…", "lang": "en-US",
  "feeds": [
    { "type": "home",        "videos": [{ "id": "…", "title": "…", "channel": "…", "duration": "10:23" }] },
    { "type": "watch-later", "videos": [] },
    { "type": "history",     "videos": [{ "id": "…", "watchedDay": "2026-10-05", "progress": 75 }] },
    { "type": "shorts",      "videos": [{ "id": "…", "short": true }] }
  ] }
```

A video is just its `id`. Missing metadata (`"title": null`) is restored in the viewer through oEmbed or the video page. Thumbnails are built from the `id`.
</details>

## 🧪 Development

```bash
node test/run.js
```

There are no dependencies and no build step: plain JavaScript loaded as-is. The tests cover the parser (on real YouTube response samples in `test/fixtures/`), the snapshot format, translations (every key, placeholder and plural form in every language), the transcript parsers and the Gemini client with the balancer.

If YouTube breaks parsing, the popup offers **Download a debug sample**. Put the sample into `test/fixtures/` with `expect: { "ids": [...] }` and fix `src/shared/parse.js` until the tests pass.

See [CONTRIBUTING.md](CONTRIBUTING.md) to add a language, a preset or a fix.

## ⚠️ Known limitations

- YouTube changes its markup and internal APIs often. The parser and transcript code have several fallbacks, but expect occasional breakage.
- History dates are parsed from day headers in Russian and English interfaces only.
- Collected Shorts count as watched for YouTube and may affect your recommendations.
- A full four-section snapshot as a code is tens of thousands of characters. Send the JSON file.

## 📜 License

[MIT](LICENSE).

YouTube is a trademark of Google LLC. This project is not affiliated with, endorsed or sponsored by YouTube or Google.
