# Changelog

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
