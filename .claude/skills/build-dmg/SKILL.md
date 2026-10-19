---
name: build-dmg
description: Build a local macOS DMG installer of Sush (release build with the auth server sidecar) for this Mac's architecture. Only when the user explicitly asks to build a DMG or macOS installer.
disable-model-invocation: true
---

# Build a macOS DMG

Builds an unsigned release DMG on this Mac. This is not a release: nothing is tagged or pushed (that's `/release`, which has CI build every platform).

## Project location

The Sush repo lives at `~/Downloads/sush-pack/sush` (`$HOME/Downloads/sush-pack/sush`), next to its sibling projects in `~/Downloads/sush-pack/`. Every command and path below is relative to that folder; `cd` there first, whatever the current directory is.

## 1. Preconditions

- Running on macOS (`uname`). If not, stop and say so.
- The project folder exists (`test -d "$HOME/Downloads/sush-pack/sush"`). If not, stop and say so.
- Mention uncommitted changes (`git -C "$HOME/Downloads/sush-pack/sush" status --short`) if there are any. They are included in the build.

## 2. Build

Run from `~/Downloads/sush-pack/sush`, in the background (the first build compiles whisper.cpp and takes several minutes). Capture the real exit code; don't pipe the build into `tail`, which hides it.

```sh
cd "$HOME/Downloads/sush-pack/sush"
bun install
bun run build:mac > "$TMPDIR/sush-build.log" 2>&1
echo "EXIT $?"
tail -10 "$TMPDIR/sush-build.log"
```

`build:mac` (root `package.json`) does the following:

- Puts `~/.cargo/bin` on PATH, since Rust may not be on the shell's PATH.
- `bun --filter server compile` rebuilds the auth server sidecar (`src-tauri/binaries/sush-auth-<host-triple>`), which `tauri.release.conf.json` bundles.
- `MACOSX_DEPLOYMENT_TARGET=11.0`, matching `bundle.macOS.minimumSystemVersion` in `tauri.macos.conf.json`: whisper.cpp uses `std::filesystem` (macOS 10.15+), and Tauri's default target is 10.13, so the build fails without them.
- `VITE_AUTH_URL` points the UI at the sidecar's port, which the release CSP allows.
- `--bundles dmg` builds only the DMG.

`build:mac` always adds `--config src-tauri/tauri.macos-icon.conf.json`, which bundles the committed `icons/Assets.car` (the macOS 26 light/dark icon) and swaps in `Info.icon.plist` (`CFBundleIconName` plus the microphone string). Xcode is not needed: `Assets.car` is compiled by Xcode's `actool` on GitHub's macOS runners (`.github/workflows/mac-icon.yml`) and committed, with `Assets.car.stamp`, whenever `icons/AppIcon.icon` changes. Before bundling, `icons/check-mac-icon.sh` (the same config's `beforeBundleCommand`) compares that stamp with the current `AppIcon.icon` and fails the build if they differ, so a DMG can't ship a stale icon (one once shipped light-only and ignored dark mode, because the workflow's commit hadn't been pulled). If the build stops there, the icon changed and CI hasn't recompiled it yet, or its commit isn't pulled: tell the user to push (on `main` that starts the Mac icon workflow; otherwise `gh workflow run mac-icon.yml --ref <branch>`), wait for it, `git pull`, and build again. Don't bypass the check.

## 3. If it fails

Quote the first real error from the log (`grep -n "error" "$TMPDIR/sush-build.log" | head`).

- `'path' is unavailable: introduced in macOS 10.15` even with the env var set: a stale whisper CMake cache from a build without it. Run `cargo clean --release -p whisper-rs-sys` and build again.
- `cmake` or libclang missing: an environment problem (`brew install cmake`; libclang comes with the Xcode Command Line Tools), not a code failure.

## 4. Report

Give the full DMG path (`~/Downloads/sush-pack/sush/target/release/bundle/dmg/Sush_<version>_<arch>.dmg`) and size, and note:

- It runs only on this Mac's architecture (aarch64 = Apple Silicon only).
- It is unsigned. On another Mac, open it with right-click → Open, or run `xattr -cr /Applications/Sush.app` after copying it in.
- It requires macOS 11 or later.
