# What's new in Sush for Android

<!--
Written for the people who use Sush, not for us. The release-android workflow publishes the
release's section as the GitHub release notes. Android has its own versions, separate from the
desktop app's (lib/changelog.ts).

- Only list changes someone would notice: what they can now do, what works better, what no
  longer goes wrong. Leave out refactors, CI and build changes.
- One plain sentence per bullet, from the user's side ("You can now…").
- Sections are `### New`, `### Improved` and `### Fixed`; skip empty ones.
- Add to `## Unreleased` as you go. To release, rename it to `## <version> — <YYYY-MM-DD>`
  matching the version in apps/desktop/src-tauri/tauri.android.conf.json; the release-android
  workflow stops if that heading is missing.
-->

## 0.2.0 — 2026-11-26

### New

- Home's tiles each have their own sushi acting out what's inside: filling a whiteboard with notes on the Board, writing in a notebook in Docs, studying by lamplight in Binders, brewing coffee for Automations, juggling your Connectors, suited up for the CRM, haunting Incognito as a ghost, and meeting friends to join a session.

### Improved

- Sush's notifications show Sushi, and the lock screen says what happened ("Sush is done") instead of just "1 notification".
- Docs open full screen, with a back arrow to the list.
- Settings, Automations, Connectors and the New task form fit the phone's screen, without squeezed or cut-off text.
- Settings no longer mention keyboard shortcuts, folders or developer commands a phone can't use.

### Fixed

- The Back key goes back through Sush (closing menus and pickers too) instead of sometimes leaving the app from a chat.

## 0.1.0 — 2026-11-26

### New

- Sush is on Android: chat with any model on your own key, with docs, slides, the Board, Binders, CRM, automations, workflows and connectors.
- Home is a bento of everything, and a dock at the bottom moves between Home, Chats, Board and Docs.
- Replies keep going when you leave the app, and a notification tells you when Sush is done or needs your answer.
- Your API keys are encrypted with your phone's Keystore and never leave it except to their provider.
- Grok models search the web and X with xAI's own search.
