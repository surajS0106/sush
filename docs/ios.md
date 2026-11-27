# Sush for iOS

The iOS app is the same crate and UI as Android's (`docs/android.md`): phone layout, no folders, shell, extra windows or local programs. It is built on a Mac with Xcode and installed from Xcode onto a plugged-in iPhone with a free Apple ID. No App Store, no TestFlight, no paid developer account.

## One-time setup on the Mac

1. Install Xcode from the App Store, open it once, and let it install its components. Then `xcode-select --install` if `xcode-select -p` prints nothing.
2. Install Rust (`curl https://sh.rustup.rs -sSf | sh`), then the iPhone target:
   `rustup target add aarch64-apple-ios`
3. Install Bun (`curl -fsSL https://bun.sh/install | bash`) and CocoaPods (`brew install cocoapods`).
4. Clone the repo and run `bun install` at its root.
5. Xcode → Settings → Accounts → **+** → Apple ID: sign in with the Apple ID that will own the app. It shows up as a "Personal Team".
6. On the iPhone: Settings → Privacy & Security → Developer Mode → on (it restarts). Plug the phone into the Mac and tap **Trust**.
7. Generate the Xcode project, from `apps/desktop`:
   `bunx tauri ios init`
   This writes `src-tauri/gen/apple`. Unlike `gen/android` it is generated, not hand-edited, so it can be re-created at any time.

## Building and installing

From `apps/desktop`:

```sh
open src-tauri/gen/apple/*.xcodeproj
```

Then, in Xcode:

1. Select the app's `_iOS` target → **Signing & Capabilities** → tick "Automatically manage signing" and pick the Personal Team.
2. Product → Scheme → Edit Scheme → Run → Build Configuration: **Release**. A Debug build loads the page from the Vite dev server on the Mac and is blank without it; Release bundles the page into the app.
3. Pick the iPhone at the top of the window and press **Run** (▶). The first build compiles all the Rust and takes a while.
4. The first time, the phone refuses to open it: Settings → General → VPN & Device Management → the Apple ID → **Trust**.

For development with live reload instead: `bunx tauri ios dev` (phone and Mac on the same Wi-Fi; pick the phone from the list).

If Xcode says the bundle identifier can't be registered, someone else already has `com.sush.app` on Apple's side. Add an `"identifier": "com.<something-unique>.sush"` to `src-tauri/tauri.ios.conf.json` and run `bunx tauri ios init` again.

## Limits of a free Apple ID

- **The app stops opening after 7 days.** Plug the phone in and press Run again; chats and keys are kept.
- At most 3 apps installed this way per phone at a time.
- No in-app updates: `lib/updater.ts` does nothing on iOS. A new version is a new Run from Xcode.

## What's different from Android

- **Rust:** `cfg(mobile)` covers both phones; `cfg(target_os = "android")` is Android only (the Kotlin plugin, the background service, the APK updater). iOS has none of `android.rs`.
- **Secrets:** the iOS Keychain through `keyring` (`apple-native`), in debug and release builds alike (`secrets.rs`).
- **Files:** `files.rs` has no picker on iOS yet (no Swift plugin): `pick` says so; `save` writes to the app's Documents folder, which the Files app shows under On My iPhone → Sush (`UIFileSharingEnabled` in `Info.ios.plist`). Attachments in the composer use the webview's own file input, which works.
- **Permissions:** `src-tauri/Info.ios.plist` (merged into the app's Info.plist by the Tauri CLI) holds the microphone, location, camera and photo prompts. Location goes through `navigator.geolocation` in the webview.
- **UI:** `isMobile` (Android or iOS) for the phone layout and what a phone can't do, `isIOS` and `isAndroid` for the rest; `html[data-mobile]` and `html[data-ios]` in `index.css`. An iPhone's user agent says "like Mac OS X", so Mac checks use `isMac` from `lib/utils.ts`, never the raw user agent. iOS has no Back key; the phone pages' back arrows do that job. The page pads itself clear of the notch and home indicator (`viewport-fit=cover`, `env(safe-area-inset-*)`).
- **Background runs:** iOS suspends an app shortly after it leaves the screen, so a run only carries on while Sush is open. What finished is saved.
