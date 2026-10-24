# Changelog

## 4.8.0
- **📡 More emotes from 7TV, not only event packs.** New in the chat’s ⚙ → Emoji: **“Emotes of this channel (7TV)”** — the extension looks for the stream’s channel on 7TV by its name (and @handle) and adds that channel’s own emotes; only an exact name match is taken, so a similar account is never added by mistake. And a **search on 7TV**: type a streamer’s name to add their emote set, or any word (“pepe”, “cat”) to add the most popular emotes for it; up to 10 additions, removable with one click. Channel and added emotes come first in the picker.
- **🎧 Audio mode**: “🎵 Find this track” moved to the left and folds into a row of **icons of the music services** (hover for the name); the keyboard-shortcut line is now behind a small “?” button and shows on hover.

## 4.7.0
- **⭐ Picks for your taste** (a new “For you” group on the feed-groups screen and a tile in the popup). From your last ~100 watched videos the extension builds a taste profile — words, favourite channels, typical length, language — **without AI**: a plain calculation (term weights with idf, cosine similarity, channel affinity, recency and watch-progress weights). It then finds similar videos in the feed that is already loaded on the page and shows 1–10 of them with a short description taken from each video’s own page and the reason (“same author”, “topics: …”). 👍 / 👎 teach it (👎 hides the channel). Optionally **one short Gemini request** picks the best of the found videos and writes a sentence on why each fits you (only the taste summary and 14–24 titles go out, never the whole history).
- **History for the picks** is collected separately (it does not overwrite the last snapshot): the extension opens the history page, collects up to 100 videos and brings you back; the picks start by themselves.
- **New layouts, chosen from the mock-ups**: the popup has a bottom navigation (Watch · Snapshot · Feed · Shorts) and a new **Feed** tab (filter switches and the panels); Settings are tabs on top, one section per screen; the feed filter panel is a full-height side panel by default; feed groups are two panes (groups on the left, videos on the right, no double scroll); **audio mode**: the text in the centre, the player as a strip at the bottom, the queue slides out from the right (☰); **live chat**: a narrow rail of people on the left like in Discord (round avatars, unread badges, “＋” to add a person); **chat settings** are an accordion; the stream player has **one layout button** with a menu (on/off, chat side, width S·M·L, “chat a bit taller”). The ADHD panel stays a side panel.

## 4.6.0
- **Emotes from websites** in the Twitch-style chat: 7TV, BetterTTV and FrankerFaceZ (global sets) plus **event packs** — Halloween, Easter, Christmas & New Year, Valentine’s Day, Summer, Pride (the most popular emotes of the theme found through the 7TV API), and your own 7TV emote set by link. Words from the chat become pictures; an emote picker with search is next to the emoji picker. Lists are cached for three days. Off by default (Settings of the chat → Emoji).
- **Live stream layout**: the chat can be raised up to YouTube’s top bar (“Chat a bit taller”), the chat on the left no longer sticks to the window edge; the player buttons are redrawn at the same size and alignment as YouTube’s own buttons and sit next to “Settings”.
- **Feed groups**: no more double scrollbar — the page under the groups screen does not scroll while it is open.
- **Chat settings** adapt to a narrow chat (one column, full-screen sheet).
- **Layout mock-ups** (`design/mockups.html`): empty, clickable wireframes with several variants for every window (popup, settings, feed filter, groups, audio mode, ADHD mode, live chat, chat settings, player buttons) to choose from.

## 4.5.0
- **📡 Twitch-style chat rebuilt from scratch.** The chat is no longer YouTube’s chat with a restyled skin: the extension draws its own chat (header, message list, input) and takes only the data from YouTube’s chat, which keeps working invisibly. One-line messages “HH:MM badges Name: text”, Twitch nickname colors, streamer / moderator / member / verified badges (the channel’s own member badge images are kept), Super Chats and new members as cards, deleted messages, mention highlight, “chat paused” bar with a return button while you read history, Twitch-like input with “@” nickname suggestions, emoji picker (in the chosen emoji set) and a 200-character counter.
- **Conversations**: the “mini chat” is now a set of tabs — “Chat”, “👥 Group” and one tab per person — that you switch between. Each has its own feed, unread counter and its own reply field; in a person’s tab the message starts with “@name”, in the group tab with “@name1 @name2” (can be turned off). The same tabs are in the floating mini chat of the YouTube style.
- **All messages**: YouTube’s default “Top chat” hides part of the messages; the extension switches the chat to “Live chat”, like Twitch shows everything (can be turned off).
- Settings: badges, Super Chat cards, “address the group”, “all messages” and the chat style are available in the chat’s ⚙ and in Settings → Live streams.

## 4.4.0
- **🔎 Feed scrolling** for groups and “Find all music” reworked: the page is walked screen by screen instead of jumping to the bottom, so shelves that draw their cards only when visible are no longer skipped, and every “More” button on the way is pressed (also after switching to the “Music” / “Jams” chips).
- **📡 Live chat, Twitch style** (default): one line per message — “HH:MM badges Name: text”, no avatars, the 15 Twitch nickname colors, Twitch-like message box and purple Send button; the YouTube look is one click away.
- **Emoji sets**: standard emoji (😂 ❤️ 🔥) can be drawn as Twemoji, Apple, Google (Noto), Facebook, OpenMoji or the system font; adjustable size. Channel emotes are not touched. Off by default (pictures come from cdn.jsdelivr.net).
- Message time **without seconds** (24-hour HH:MM).
- Chat settings redesigned: tabs (Look · Emoji · Mentions · Hide · Stream page), style cards with a live preview, emoji set cards with samples; the ⚙ and 💬 buttons are now icons next to the Send button instead of the chat header.
- **Player buttons** on live streams: “comfortable layout on/off” and “move the chat to the other side”, styled like YouTube’s own player buttons.

## 4.3.0
- **📡 Live streams**: a comfortable layout (the chat at full height that stays in place, chat width set by dragging its edge, chat on the left or right, recommendations and comments can be hidden) and a better live chat in the spirit of 7TV / BetterTTV, without emotes: colored nicknames, mention highlight and a sound when you are tagged, click a nickname to reply (Ctrl+click copies it), hover buttons (reply, copy, mini chat, the person’s messages, hide), a **mini chat** that shows only the people you picked and sends to the main chat (“@name ” is added for one person), hiding bots, “!” commands, Super Chats, members and system messages, font size, timestamps, stripes, compact mode.
- **⚡ ADHD mode**: five presets (Ads only, Gentle, Balanced, Strict, Best moments), **video types** with their own skip rules (gaming, lecture, podcast, review, news, vlog, stream recording — or detected automatically, shown as a badge on the plan), a model picker, and no ADHD mode for music tracks.
- **🎛 Feed filter** redesigned: tabs (Hide · Groups · Music · Channels), the button can be **dragged anywhere** and snaps to the nearest edge (the spot is remembered), the panel opens towards the centre of the screen or as a full-height side panel.
- **🎧 Audio mode**: no more flashing when the next track starts — the next track opens inside YouTube without reloading the page, half a second before the end (so YouTube’s autoplay doesn’t interfere), and the cover changes only after the new picture has loaded.
- Language switching now updates the panels already open on YouTube (audio mode, ADHD mode, feed filter, groups, text panel) without reloading; “Yandex Music” and “VK Music” are translated.

## 4.2.0
- **🔎 Find all music** now works like a person would: on Home it switches on the “Music” and “Jams” chips, presses “More” on the shelves (“Recently listened” and so on), scrolls the feed down and collects the tracks. Tracks inside **mixes and jams** are taken from the mix pages.
- **No more 50-track limit**: “▶ Play in a row” builds the extension’s own queue (up to 500 tracks) instead of a YouTube temporary playlist. It survives page loads; the next track opens when one ends.
- **Queue order**: as found, 🔀 random, or ✨ **arranged by Gemini** (varied energy, no artist twice in a row). The same buttons are in the audio mode to reshuffle what is left.
- **🎧 Audio mode**: the queue is shown to the left of the text (click a track to jump, ✕ to close the queue); music opens straight on the “Song” tab.
- **⚡ ADHD plan**: every part has three icons — ▶ watch / ⏩ faster / ⏭ skip — instead of click-to-cycle, in the panel and in the audio mode.

## 4.1.0
- **🎧 Audio mode**: three tabs on the right — Transcript, **🎵 Song** (lyrics from the open services LRCLIB and lyrics.ovh: synced when the source has timestamps, otherwise scrolled along the length of the track) and **⚡ Plan**. The ADHD plan is drawn on the seek bar and next to the transcript lines; a ⚡ button shows the saving and the current part; “skipped” notes appear over the audio screen.
- **⚡ ADHD mode**: settings redone — strictness cards with a short explanation, changing strictness no longer fires a request (a ready plan is shown, a new one is made by the button), options “plan every video automatically”, “notes about skipped parts” and “plan strip” (also in Settings → ADHD mode).
- **🎵 “Where to listen”** button under any music video (not only in audio mode): Spotify, Apple Music, Yandex Music, YouTube Music, SoundCloud, Deezer, VK, copy “Artist — Track”.
- **🔎 Find all music**: the feed filter scrolls Home / Subscriptions / Search down by itself and loads recommendations until up to 50 tracks are found; “▶ Play in a row” does it first, with a progress bar and a Stop button.
- **🗂 Feed by groups** instead of hiding: group the loaded cards by author, type, length, language or hashtag; collapsible groups, thumbnails, “play the tracks of this group”.
- **Settings page** redesigned: switches fixed (a style clash had shifted the knob), rows with a title and a hint, section icons; new sections “ADHD mode” and “Audio mode and music”.
- New host permissions: lrclib.net and api.lyrics.ovh (lyrics only; can be turned off in Settings).

## 4.0.0
- **⚡ ADHD mode**: Gemini plans the video from its transcript — watch / faster / skip. The mode runs the video, shows what was skipped (with “↩ Back”), draws a plan strip under the player; Gentle / Balanced / Strict, 1.5–2×, any part editable.
- **🎛 Feed filter** on Home, Subscriptions, Search and next to a video: hide Shorts, streams, premieres, watched, mixes; length, title language, channels, words and #hashtags; only music; sorting.
- **🎵 Music**: track detection, “▶ Play in a row” from the tracks on the page, links to Spotify, Apple Music, Yandex Music, YouTube Music, SoundCloud, Deezer, VK.
- **🎧 Audio mode** redesigned: two columns, cover, chapters, volume (also ↑/↓, M), sleep timer, previous / next track and “Up next” in a queue.
- **Prompts in all 12 languages**: built-in summary presets switch with the interface language; edits of built-in presets are kept per language. Prompt rules reworked (plain text, speakers, timestamp format, length self-check).
- **🧠 Parser repair with AI** (optional): when YouTube changes its card format, Gemini returns a field-path recipe, which is validated on the same response and saved.
- **Optimization**: one shared timer for all content scripts instead of separate intervals, nothing ticks in background tabs except saving the playback position; feed data from YouTube is forwarded only while the feed filter is on.
- Fixed the missing space in Spanish plural forms (“{n} vídeos”).

## 3.5.0
- New popup with tabs: **▶ Watch** (current video and continue watching), **📦 Snapshot**, **⚡ Shorts**.
- Settings got a section menu: language · AI summaries · summary presets · Shorts · sharing snapshots · data.
- The signature for your friend and the hosted viewer address moved from the popup to Settings → Sharing snapshots.
- The popup no longer stops working when one of its elements is missing.

## 3.4.0
- **⏯ Continue watching**: playback positions are remembered locally. The popup lists the last 5 unfinished videos, and a “Continue from 12:34” prompt appears when YouTube starts a video from zero.
- **🎧 Audio mode**: a podcast-like screen with a transcript synced to the audio, custom controls and lower video quality to save data.

## 3.3.0
- Rewritten summary prompts: a shared base and rules for each preset, in English and Russian. New presets: **Facts & numbers** and **Answer the title**.
- Edit a preset’s prompt right in the summary panel (✎). Full preset management in Settings: edit, restore built-in, create, duplicate, rename, delete, make default.

## 3.2.0
- Gemini model balancer: retries on 503, then switches models; cool-down for busy models; cancel.
- Faster summaries: thinking turned off on 2.5 Flash and set to low on 3.x; compact transcript.
- Prompt presets and model choice right in the summary panel.

## 3.1.x
- 📝 Video text and ✨ summary buttons on the regular youtube.com video page and in the popup.
- Text files are named `Title - Channel.txt`.
- Transcript with several routes: YouTube’s panel, subtitles signed by the player, signed requests when you are signed in, YouTube’s own panel as a fallback. A details line explains failures.
- The transcript language follows the audio track and the default subtitles.
- After an extension update, stale copies of scripts left in open tabs are replaced.

## 3.0.0
- Video text with or without timestamps, AI summaries with Gemini (your AI Studio key), system prompt settings.
- 12 interface languages.
- Optimization: lazy parsing, timers only on Shorts, `content-visibility` in the viewer.

## 2.x
- Multi-feed snapshots (Home, Watch later, History, Shorts), viewer tabs, stats, snapshot diff (“What’s new?”), vertical Shorts viewer.
- ID-first parser with fallbacks, confidence, a breakage detector and regression fixtures. The viewer restores missing metadata.
- The viewer plays videos inside the extension without errors 152/153.
- PRO: Shorts auto-scroll, skip rules, headphone and media keys, on-page settings panel.

## 1.0.0
- First version: collect the Home feed and share it with a friend as a file or code.
