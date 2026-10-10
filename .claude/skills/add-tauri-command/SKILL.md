---
name: add-tauri-command
description: Add or change a Rust command the React UI calls via invoke(), keeping the Rust handler, its registration, and the TypeScript bindings in sync. Use when the UI needs new native functionality (filesystem, keyring, HTTP, processes) or when changing a command's arguments or return type.
---

# Add or change a Tauri command

A command touches three places that must agree. Nothing checks them against each other at compile time, so a mismatch only shows up at runtime as a failed `invoke`.

## 1. Rust handler: `apps/desktop/src-tauri/src/<module>.rs`

Put it in the module that owns the area (`commands.rs` for providers/chat, `library.rs` for local files and plugins, `connectors.rs` / `connector_auth.rs` for MCP, `speech.rs` / `whisper.rs` for dictation). Create a new module only for a new area, and add `mod <name>;` in `lib.rs`.

```rust
#[tauri::command]
pub async fn do_thing(state: State<'_, AppState>, thing_id: String) -> AppResult<ThingView> { ... }
```

- Return `AppResult<T>` (`crate::error`). `AppError` serialises to a plain string that the UI shows directly, so write error messages for the user. Use `AppError::NotFound` / `AppError::Invalid` for your own errors. Add a `#[from]` variant only for a new error source.
- Return structs need `#[derive(Serialize)]` with `#[serde(rename_all = "camelCase")]`. Enums use `#[serde(tag = "type", rename_all = "kebab-case")]`, like the rest of the code.
- Shared state goes on `AppState` (`state.rs`). Long-running work that the user can stop gets a `CancellationToken` stored in a map on `AppState` keyed by an id the UI generates (see `streams`, `tool_calls`, `authorizing`), plus a matching `cancel_*` command.
- Streaming results: take a `tauri::ipc::Channel<Frame>` argument and always send a final `End` frame (see `chat_stream` / `StreamFrame` in `commands.rs`).
- Secrets go through `secrets.rs` (OS keyring). Never return a secret to the webview; return a `has_key`-style bool instead.
- If the logic doesn't need Tauri (provider/HTTP/MCP/protocol work), put it in `crates/sush-core` and keep the command a thin wrapper. `sush-core` must not depend on Tauri.

## 2. Register it: `apps/desktop/src-tauri/src/lib.rs`

Add `module::do_thing` to `tauri::generate_handler![...]`. A command that isn't registered fails at runtime only.

## 3. TypeScript binding: `apps/desktop/src/lib/tauri.ts`

- Add or adjust the TS types so they mirror the serde output exactly (camelCase fields, kebab-case `type` tags, `Option<T>` → `T | null`).
- Add a method to the `api` object:

```ts
doThing: (thingId: string) => invoke<ThingView>("do_thing", { thingId }),
```

Tauri converts snake_case Rust argument names to camelCase on the JS side, so the invoke args object uses `thingId` for `thing_id`. Pass optional args as `null`, not `undefined` (see `saveProvider`).

UI code calls `api.doThing(...)` and shows failures with `errorMessage(e)`. Don't call `invoke` directly outside `tauri.ts`.

## 4. Permissions and CSP

- Commands from this crate need no capability entry. Plugin APIs (dialog, opener, ...) do: see `src-tauri/capabilities/default.json`.
- If the **webview** (not Rust) has to fetch a new origin, add it to `connect-src` in `tauri.conf.json` and `tauri.release.conf.json`. Prefer doing HTTP in Rust.

## 5. Verify

Run the `check` skill (all three commands, since this crosses the Rust/TS boundary). To exercise the command for real, launch the app (`run-app` skill).
