---
name: check
description: Run the same checks CI runs (TypeScript typecheck, desktop production build, Rust workspace tests) and report failures. Use after making changes, before committing, or when asked to verify, check, or "make sure CI passes".
---

# Run the CI checks locally

CI (`.github/workflows/ci.yml`) has two jobs. Run both from the repo root, in this order (the fast TS checks first):

```sh
bun run typecheck              # tsc in apps/desktop and apps/server
bun --filter desktop build     # tsc + vite build; catches import/bundling errors typecheck misses
cargo test --workspace         # sush-core + the Tauri crate
```

Narrow the scope when the change is clearly local:

- Only `crates/sush-core` touched: `cargo test -p sush-core` (fast, no whisper.cpp build).
- Only `apps/server` touched: `bun --filter server typecheck`.
- Only `apps/desktop/src` touched: the two bun commands. Skip cargo.
- Anything under `apps/desktop/src-tauri` or a serde type in `sush-core`: run everything. These changes also affect `apps/desktop/src/lib/tauri.ts`.

## Notes

- There are no JS tests or linter. Don't invent `bun test` or `eslint` runs.
- The Tauri crate builds whisper.cpp (`whisper-rs`). The first build is slow and needs CMake + libclang. On Windows, if the build can't find them, set `CMAKE` to the VS Build Tools `cmake.exe` and `LIBCLANG_PATH` to a folder with `libclang.dll` (see README). Report a missing toolchain as an environment problem, not a code failure.
- CI also builds Rust on Linux. If you add a platform-specific dependency or `cfg`, say that Linux/macOS weren't verified locally.

## Report

Say which commands ran and whether each passed. For failures, quote the first real error (file:line plus message), not the whole log.
