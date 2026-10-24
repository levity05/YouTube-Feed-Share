# Privacy

**English** · Русский — ниже / below

YouTube Feed Share has **no server**, no analytics and no tracking. The authors receive nothing.

## What is stored, and where

Everything is kept in your browser in `chrome.storage.local` (and `sessionStorage` for the audio-mode flag). It stays there until you clear it or remove the extension.

| Data | Why | How to delete |
|---|---|---|
| Feed snapshots (video IDs, titles, channels; History also has the day and progress) | Your library in the viewer | Viewer → delete a snapshot |
| Playback positions of the last 50 videos | ⏯ Continue watching | Popup → Clear, or Settings → Data |
| AI summaries (cache) | So the quota isn’t spent twice | Settings → Data |
| Google AI Studio key, model, prompt presets | ✨ AI summaries | Settings → AI summaries |
| Shorts rules and the authors/hashtags you watched | ⚡ Shorts skip rules | Shorts settings |
| Feed filter rules (hidden channels, words, languages) | 🎛 Feed filter | Settings → Feed filter → Reset |
| ADHD-mode plans (cache) | ⚡ ADHD mode | Removing the extension |
| Learned card formats (“recipes”) | 🧠 Parser repair | Settings → AI summaries → Forget learned formats |
| Taste picks: the last ~100 watched videos (titles, channels, progress), short descriptions and keywords of up to 400 videos, your 👍 / 👎 | ⭐ Picks for your taste | Settings → Data, or removing the extension |
| Debug samples (a raw YouTube response) | Only when the parser suspects a breakage; you download them yourself | Removing the extension |

## Network requests

- **youtube.com**: the same requests your YouTube page makes (feeds, video pages, transcript, subtitles), sent from your browser with your session. To get a transcript while you are signed in, the extension signs the request the way YouTube’s own page does (a `SAPISIDHASH` header computed from your YouTube cookie). The cookie and the header never leave youtube.com.
- **i.ytimg.com**: video thumbnails.
- **youtube.com/oembed**: the viewer restores missing titles and channels.
- **generativelanguage.googleapis.com**: only if you add a Gemini key. For a summary or an ADHD-mode plan: the video title, channel, duration, URL and transcript. For parser repair (off by default): 2–3 trimmed video cards from YouTube’s response — their structure and short texts such as titles and channel names. Your key is sent in the `x-goog-api-key` header. Google’s [Gemini API terms](https://ai.google.dev/gemini-api/terms) apply.

**Picks for your taste** (⭐): the watch history is collected by opening youtube.com/feed/history in the same tab, exactly as when you open it yourself, and is kept only in the browser. The calculation is local. A short description and keywords of a video are read from its own youtube.com page (the same request as opening it). Only if you press “Refine with Gemini” and have a key, one request goes to Gemini with a short taste summary (the main words, favourite channels, typical length) and up to 24 candidate videos from the feed (id, title, channel, length, short description). The history itself is not sent.

**Mixes and jams**: to list the tracks of a mix, the extension opens the mix page on youtube.com the same way your browser would (with your cookies, as when you click it). **Queue order with Gemini** (only if you press ✨ and have a key): the titles and channel names of the tracks in the queue are sent to Gemini.

**Emoji sets in the live chat** (off by default): if you pick a set other than YouTube or System, the pictures of standard emoji are loaded from **cdn.jsdelivr.net** (by the emoji’s code, for example `1f602.svg`). Nothing else is sent.

**Emotes from websites** (live chat, off by default): when you turn on 7TV, BetterTTV, FrankerFaceZ, an event pack or your own set, the extension asks **7tv.io**, **api.betterttv.net** and **api.frankerfacez.com** for the emote lists (the request carries only the name of the set or a search word such as “halloween”; for “Emotes of this channel” and the 7TV search — the channel’s name and @handle, or the name or word you typed) and the pictures are loaded from **cdn.7tv.app**, **cdn.betterttv.net** and **cdn.frankerfacez.com**. Nothing about you or the stream is sent.

**Song lyrics** (🎧 audio mode, can be turned off in Settings → Audio mode and music): the artist, the title and the length of a music track are sent to **lrclib.net** and, if nothing is found there, to **api.lyrics.ovh**. Nothing else (no account, no watch history) is sent. Found lyrics are cached locally.

Music search links (Spotify, Apple Music, Yandex Music, SoundCloud, Deezer, VK, YouTube Music) are plain links: those sites are contacted only when you click one.

Nothing is sent anywhere else.

## Sharing

A snapshot leaves your computer only when **you** send the file, the code or the link. A link built for a hosted viewer keeps the data in the `#…` fragment, which browsers don’t send to the server. Snapshots can include your **watch history**: review them before sending (“Review and share” lets you hide videos).

## Permissions

| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | Snapshots and settings in your browser |
| `scripting` | Starts collection, and adds the page tools in tabs opened before installing |
| `declarativeNetRequestWithHostAccess` | Lets YouTube video pages load inside the extension’s **own** viewer frame. The rule applies only to frames started by the extension, never to regular browsing. |
| Host `https://www.youtube.com/*` | Content scripts on YouTube: collection, transcript, summary panel, audio mode, Shorts tools |

---

## Приватность (кратко)

- Сервера нет, аналитики и слежки нет. Авторы ничего не получают.
- Всё хранится в `chrome.storage.local` вашего браузера:
  - снимки;
  - места остановки последних 50 роликов;
  - кэш сводок;
  - ключ Gemini и пресеты;
  - правила Shorts.

  Удаляется в настройках («Данные») или вместе с расширением.
- Запросы уходят только на youtube.com (как от вашей страницы; если вы вошли в аккаунт, запрос текста подписывается заголовком `SAPISIDHASH` из вашей куки YouTube — он не покидает youtube.com), на i.ytimg.com за превью, на oEmbed YouTube и, только если вы добавили ключ, в Gemini API. В Gemini передаются название, канал, длительность, ссылка и текст ролика.
- «Подборка по вкусу» ⭐: история просмотров собирается открытием youtube.com/feed/history в той же вкладке (как если бы вы открыли её сами) и хранится только в браузере; расчёт локальный; описание ролика читается с его страницы на youtube.com. Только если вы нажмёте «Уточнить через Gemini» и у вас есть ключ, в Gemini уходит один запрос: краткая сводка вкуса и до 24 роликов-кандидатов из ленты (название, канал, длительность, мини-описание). Сама история не отправляется.
- Снимок покидает компьютер, только когда **вы** его отправляете. В нём может быть **история просмотра** — проверьте перед отправкой.
