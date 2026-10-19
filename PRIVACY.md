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
| Debug samples (a raw YouTube response) | Only when the parser suspects a breakage; you download them yourself | Removing the extension |

## Network requests

- **youtube.com**: the same requests your YouTube page makes (feeds, video pages, transcript, subtitles), sent from your browser with your session. To get a transcript while you are signed in, the extension signs the request the way YouTube’s own page does (a `SAPISIDHASH` header computed from your YouTube cookie). The cookie and the header never leave youtube.com.
- **i.ytimg.com**: video thumbnails.
- **youtube.com/oembed**: the viewer restores missing titles and channels.
- **generativelanguage.googleapis.com**: only if you add a Gemini key and ask for a summary. What is sent: the video title, channel, duration, URL and transcript. Your key is sent in the `x-goog-api-key` header. Google’s [Gemini API terms](https://ai.google.dev/gemini-api/terms) apply.

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
- Снимок покидает компьютер, только когда **вы** его отправляете. В нём может быть **история просмотра** — проверьте перед отправкой.
