# Sush

A desktop AI harness: chat with any model (OpenAI, Anthropic, Azure Foundry, Bedrock, local models), and later run agent tools.

## Layout

- `crates/sush-core`: providers, message model, and streaming. Pure Rust with no Tauri dependency, so it can also back a future CLI/TUI.
- `apps/server`: auth server (Bun, Hono, better-auth, SQLite). Email/password accounts; the desktop app signs in against it with a bearer token.
- `apps/desktop`: Tauri 2 app. `src/` is the React UI (Vite, shadcn, AI SDK UI); `src-tauri/` is the thin Rust shell that exposes `sush-core` to the UI.

## Prerequisites

- Rust (stable, via rustup)
- Bun
- Windows: Visual Studio 2022 Build Tools with the "Desktop development with C++" workload (WebView2 ships with Windows 11)
- macOS: Xcode Command Line Tools

## Develop

```sh
bun install
bun run dev          # auth server + Ollama + desktop app, all in one terminal
bun run dev:server   # auth server only, on http://localhost:3000 (creates auth.sqlite on first run)
bun run dev:ollama   # Ollama only (skipped if it's already running)
bun run dev:app      # desktop app only, with hot reload
cargo test -p sush-core
```

### Auth server config

| Env var | Default | |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | dev fallback | **Required in production.** Generate with `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | `http://localhost:$PORT` | Public URL of the server. |
| `PORT` | `3000` | |
| `DATABASE_PATH` | `auth.sqlite` | SQLite file; tables are migrated on startup. |

The desktop app reads `VITE_AUTH_URL` (default `http://localhost:3000`). If you point it elsewhere, add that origin to `connect-src` in `apps/desktop/src-tauri/tauri.conf.json`.

## Build installers

```sh
bun run build        # .msi + setup .exe on Windows, .dmg/.app on macOS
```
