---
name: run-app
description: Launch the Sush desktop app in development (auth server, optional Ollama, Tauri + Vite) to try a change in the real app. Use when asked to run, start, or try the app, or to confirm a UI or Rust change works end to end.
---

# Run Sush in development

## Pieces and ports

| Piece | Command | Port |
| --- | --- | --- |
| Auth server (Bun/Hono/better-auth, creates `apps/server/auth.sqlite`) | `bun run dev:server` | 3000 |
| Ollama (optional, local models) | `bun run dev:ollama` | 11434 |
| Desktop app: `tauri dev`, which runs Vite via `beforeDevCommand` | `bun run dev:app` | Vite on 1420 (`strictPort`) |
| The same server on every interface, as the LAN relay for shared sessions (use instead of `dev:server`) | `bun run dev:relay` | 3000 |
| A second app instance as another person (debug build, reuses the running Vite) | `$env:SUSH_PROFILE='b'; .\target\debug\sush.exe` | none |

`bun run dev` starts all three with `concurrently`. In a background shell, prefer starting them separately so their logs stay apart.

In dev builds the app does **not** start the auth server itself (`auth_server.rs` is release-only). Without `dev:server` running, the login screen can't sign in. The UI uses `VITE_AUTH_URL`, which defaults to `http://localhost:3000`.

## Steps

1. `bun install` if `node_modules` is missing or `bun.lock` changed.
2. Start the auth server in the background: `bun run dev:server`, then wait for `/health` to return `ok`:
   `curl -s http://localhost:3000/health`
3. Start the app in the background: `bun run dev:app`. The first run compiles the Rust crate, including whisper.cpp, which takes several minutes. The output has ANSI colour codes, so wait for `Finished` or `target\debug\sush.exe` (not the regex `Running .*sush`), or for `error[`/`could not compile`. A compile error leaves `tauri dev` watching: fix the file and it rebuilds by itself.
4. If port 1420 or 3000 is already taken, an earlier dev session is probably still running. Find it and ask the user before killing it.
5. To try a shared session, start a second instance once the first has compiled (row above). It gets its own data, dev secrets and, on Windows, its own webview storage (`paths.rs`), so it signs in as a different person. Details are in the `multiplayer` skill.

## Stopping

Stopping the background task doesn't always stop its children: `bun --watch` and Vite can outlive it. Afterwards, check ports 3000 and 1420 (`netstat -ano | grep -E ":(3000|1420) .*LISTEN"`) and any `sush.exe`. Stop the leftovers you started yourself; ask before stopping ones you didn't.

## Hot reload

- `apps/desktop/src/**`: Vite HMR, instant.
- `apps/desktop/src-tauri/**` or `crates/sush-core/**`: `tauri dev` rebuilds and restarts the app automatically.
- `apps/server/src/**`: `bun --watch` restarts the server.

## Where state lives (for debugging or a clean slate)

- Providers: `providers.json` in the app config dir (identifier `com.sush.app`, e.g. `%APPDATA%\com.sush.app\` on Windows). A `SUSH_PROFILE=b` instance uses `com.sush.app-b` instead.
- The relay account for shared sessions: dev secrets / keyring entry `share:account`. Shares and invites themselves: `apps/server/auth.sqlite` (`share*` tables).
- API keys and connector tokens: OS credential store, service `com.sush.app`.
- Conversations, library, memory, auth token: the webview's localStorage (`sush.*` keys).
- Whisper model: app data dir, downloaded on first dictation.

Don't delete any of these without asking. They're the user's real data.

## Without a GUI

If a window can't be inspected, verify with what you can observe: Rust compiles and the app starts without panicking, Vite serves `http://localhost:1420`, and the auth server responds. For provider logic, the `chat` example is faster than the app: `cargo run -p sush-core --example chat -- <openai|anthropic> <base_url> <model> "prompt"`. Tell the user which parts you couldn't see.
