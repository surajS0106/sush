# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Bun workspace (`apps/*`) plus a Cargo workspace (`crates/sush-core`, `apps/desktop/src-tauri`).

```sh
bun install
bun run dev              # auth server + Ollama + desktop app together
bun run dev:app          # desktop app only (tauri dev, Vite on fixed port 1420)
bun run dev:server       # auth server only, http://localhost:3000
bun run typecheck        # tsc in every workspace
bun --filter desktop build   # tsc + vite build (CI runs this)
bun run build            # compile auth sidecar + release installers

cargo test --workspace                       # what CI runs (Linux/Windows/macOS)
cargo test -p sush-core                      # core only
cargo test -p sush-core <name_substring>     # single test
cargo run -p sush-core --example chat -- <openai|anthropic> <base_url> <model> "prompt"   # SUSH_API_KEY for the key
```

There are no JS tests or linter configured; `typecheck` is the TS gate. Rust tests are inline `#[cfg(test)]` modules (decoders are tested against recorded SSE streams).

Building the Tauri crate needs CMake + libclang (whisper.cpp via `whisper-rs`). On Windows, set `CMAKE` / `LIBCLANG_PATH` if they aren't on PATH (see README).

Releases: push a `v*` tag matching the version in `tauri.conf.json`; `.github/workflows/release.yml` builds every platform.

## Architecture

Three parts:

- **`crates/sush-core`**: pure Rust, no Tauri dependency (keep it that way; it is meant to back a future CLI/TUI too). Holds the message model (`message.rs`: `Message`, `Part`, `ChatEvent`, `ChatRequest`), the `Provider` trait, SSE parsing, MCP client (`mcp/`: stdio + HTTP transports and OAuth), and remote transcription.
  - A provider is *wire format × endpoint × credential*. Only two wire formats exist (`OpenaiChat`, `AnthropicMessages` in `providers/`); Azure, OpenRouter, Groq, Ollama, etc. are just `ProviderConfig` presets (`provider.rs::presets`). A new endpoint speaking an existing format needs config, not code.
  - Each format implements an I/O-free `Decoder` that turns SSE events into normalised `ChatEvent`s. Dropping the returned stream aborts the HTTP request; that is the cancellation mechanism.
- **`apps/desktop/src-tauri`** (crate `sush`): thin shell exposing core to the UI as Tauri commands (registered in `lib.rs`). `AppState` (`state.rs`) holds providers (persisted to `providers.json` in the app config dir) and cancellation tokens for in-flight streams, connector tool calls, and sign-ins. API keys and connector tokens go to the OS keyring (`secrets.rs`), never to disk or the webview. `whisper.rs` runs local dictation in-process (model downloaded on first use). `auth_server.rs` is release-only (`#[cfg(not(debug_assertions))]`): it launches the bundled auth server sidecar on port 47321. In dev you run `dev:server` yourself.
- **`apps/desktop/src`**: React 19 + Vite + Tailwind 4 + shadcn (`components/ui`) + AI SDK UI (`useChat`). Path alias `@/` → `src/`.
  - `lib/tauri.ts`: typed `invoke` bindings. Its types mirror sush-core's serde shapes (camelCase fields, kebab-case enum tags). **If you change a Rust command or serde type, update this file to match.**
  - `lib/transport.ts`: `TauriChatTransport` adapts `useChat` to Rust. Instead of HTTP it calls `chat_stream` with a Tauri `Channel` and translates `ChatEvent`s into AI SDK `UIMessageChunk`s.
  - `lib/agent.ts`: what each request carries (system prompt, tool specs) and how returned tool calls run. Most tools are client-side: `ask_user`, `memory_*`, `chats_search`/`chat_read`, `skill`/`skill_save`, `artifact_write`. Tools named `<connector>__<tool>` are forwarded to MCP connectors via Rust and need user approval.
  - State is client-side in localStorage via `lib/store.ts` (`createStore` + `useSyncExternalStore`): conversations, library (`library.ts`: skills, design systems, connectors, plugins), memory files (`memory.ts`). The comment in `store.ts` says conversations will move to SQLite on the Rust side later, so keep UI code going through that module's API.
- **`apps/server`**: Bun + Hono + better-auth (SQLite, migrated on startup). Email/password accounts. The webview is cross-origin, so auth uses the bearer plugin (`set-auth-token` header → localStorage → `Authorization: Bearer`, see `src/lib/auth.ts`) instead of cookies. In release builds it is compiled with `bun build --compile` into `src-tauri/binaries/sush-auth-<target-triple>` and shipped as a Tauri sidecar.

`apps/chat-ui.ts` is a standalone component file outside every workspace package; nothing imports it.

Project skills in `.claude/skills/` cover the common multi-file workflows: `check`, `run-app`, `add-tauri-command`, `add-agent-tool`, `add-provider`, `release`.

## Gotchas

- The CSP in `tauri.conf.json` (and `tauri.release.conf.json` for release) restricts `connect-src`. If you point `VITE_AUTH_URL` at a new origin, or the webview needs to reach a new host, add it there.
- Server env: `BETTER_AUTH_SECRET` (required in production), `BETTER_AUTH_URL`, `PORT`, `DATABASE_PATH`.
