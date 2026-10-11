---
name: ship
description: Build and verify a finished feature (typecheck, desktop production build, Rust workspace tests), then commit and push it to GitHub. Only when the user explicitly asks to build, ship, or push.
disable-model-invocation: true
argument-hint: [optional commit message or branch name]
---

# Build, then push

This is the only time builds run. While a feature is being written, don't build, test, or typecheck after edits; the user runs this once the whole feature is done, right before pushing.

## 1. Look at what's going out

- `git status` and `git diff --stat` (plus `git log origin/<branch>..HEAD --oneline` for unpushed commits).
- If the working tree is clean and nothing is ahead of the remote, say there's nothing to ship and stop.

## 2. Build and verify

From the repo root, in this order, stopping at the first failure:

```sh
bun run typecheck              # tsc in apps/desktop and apps/server
bun --filter desktop build     # tsc + vite build; catches import/bundling errors typecheck misses
cargo test --workspace         # builds and tests sush-core + the Tauri crate
```

Run all three regardless of which files changed; this is the gate before GitHub, and CI runs the same set. Don't run `bun run build` (release installers); that belongs to the `release` skill.

If a step fails, quote the first real error (file:line plus message), fix it if the cause is clear, and rerun from the failed step. If the fix isn't obvious, or a missing toolchain (CMake / libclang for whisper.cpp) is the cause, stop and report instead of pushing.

## 3. Commit

- If on `main`, ask whether to push to `main` directly or to a new branch (use `$ARGUMENTS` as the branch name if it looks like one).
- Stage the feature's files by name (not `git add -A`), skipping anything that looks like secrets, local config, or build output.
- Commit message: `$ARGUMENTS` if it's a message, otherwise a short summary of the feature in the repo's existing style (`git log --oneline -10`). End it with the attribution line from the current system reminder.

## 4. Push, after the user confirms

Show the commit(s) and the target branch, and push only after the user says yes:

```sh
git push -u origin <branch>
```

## Report

Which checks ran and passed, the commit hash, and where it was pushed. If CI also builds Linux/macOS, say those weren't verified locally when the change adds platform-specific code.
