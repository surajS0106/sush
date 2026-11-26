# Sush for Android

The Android app is the desktop app's crate (`apps/desktop/src-tauri`) and UI (`apps/desktop/src`), without what needs a computer. It follows Yammer's Android app (`../sush-voice`).

## Building

`bun run build:android` makes a debug APK for phones (arm64) and PC emulators (x86_64). It needs `JAVA_HOME` (Android Studio's `jbr`), `ANDROID_HOME`, `NDK_HOME` and the Rust targets `aarch64-linux-android` and `x86_64-linux-android`. If Gradle times out on Windows, set `JAVA_TOOL_OPTIONS=-Djava.net.preferIPv4Stack=true`.

The APK lands in `gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`, named "universal" whichever targets were built.

`gen/android` holds hand-written Kotlin, the manifest, icons and Gradle changes, so it's committed. Never run `tauri android init` over it. A release build is signed when `SUSH_KEYSTORE_FILE`, `SUSH_KEYSTORE_PASSWORD`, `SUSH_KEY_ALIAS` and `SUSH_KEY_PASSWORD` are set, or `gen/android/key.properties` exists; otherwise it's unsigned.

The version is `tauri.android.conf.json`'s, separate from the desktop's.

## Releasing

`release-android.yml` (Actions tab, or `gh workflow run release-android.yml`; manual only) builds a signed arm64 APK and publishes it as the `android-v<version>` release with `--latest=false`, so the desktop updater's `releases/latest` never lands on it. Its notes are that version's section of `CHANGELOG-android.md`, and the job stops without one. To release: add to `## Unreleased` there, bump `version` in `tauri.android.conf.json`, rename the heading to `## <version> — <date>`, push to main, run the workflow and approve the `release` environment.

The signing key is in the `release` environment's secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`). The environment only admits runs from main, after an approval. The backup is `~/.sush/sush-release.jks` with `~/.sush/android-signing.properties`. Losing it means installed copies can never update. For a signed build on this machine, copy that properties file to `gen/android/key.properties` (ignored by git). Never commit a `.jks`.

## What's different

- **Rust:** `cfg(desktop)` / `cfg(target_os = "android")`. Modules a phone can't have are stand-ins with the same commands, in `src/mobile/` (the built-in browser, extra windows, whisper, `sush://` links). TLS is rustls, since native-tls would need OpenSSL.
- **Files:** `files.rs` picks and saves, with dialogs on desktop and the file picker and share sheet on Android. `save` always answers false there: Android doesn't say whether the share sheet's file went anywhere.
- **Secrets:** `secrets.bin` in private storage, AES-256-GCM, its key wrapped by the Android Keystore (`Vault.kt` → `SushNative.unlock`, before Tauri starts). `allowBackup` is off.
- **Background runs:** `runs.rs` reports working, waiting and finished runs (`notify_android` → `android::runs_changed` → `RunService.kt`). A `dataSync` foreground service holds the process while anything works. Android 15 and later limits it to 6 hours a day. Tools the UI runs need the page, so they depend on the webview still running. Swiping Sush from Recents ends it, runs and all; what finished is saved.
- **Accounts:** there's no local auth server on a phone. Without `VITE_AUTH_URL` at build time (`HAS_ACCOUNTS` in `lib/auth.ts`) the app has no sign-in. With it, add the server to `connect-src` in an Android CSP. Shared sessions sign in to their relay separately, in Settings → Sharing.
- **UI:** `isAndroid` and `isPhone()` in `lib/utils.ts`; `html[data-android]` in `index.css`. A phone has no sidebar: `components/phone.tsx` is the glass dock (Home, Chats, Board, Docs, and + for a new chat), the bento Home and the chats list. A chat or a page opened from Home fills the screen with a back arrow, and Back goes toward Home. Folder work (Cowork, Folders, Security, Review, Wiki), local connectors, the updater and dictation through Yammer's desktop app aren't offered. `.side-panel` covers the chat on a phone.
- **Back:** `lib/back.ts` keeps one history entry per thing to go back from; `MainActivity.onBackPressed` uses them up, then backgrounds the app. Put `<BackCloses>` in anything new that opens over the page; `Dialog` and `Sheet` already have it.

## Not there yet

- An update check in the app, and a Play listing.
- Answering an approval from its notification (it opens the app).
- Driving a desktop Cowork session from the phone as its owner.
