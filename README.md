# Sush

**A team can work with one AI agent together, live, while the code, keys and agent stay on one person's machine.**

Sush is a desktop agent harness. You point it at a folder and it reads, edits, runs commands and commits there, in an OS sandbox, with every change undoable. What makes it different is that the session is multiplayer. Share a link and teammates can watch the agent work as it happens, suggest what it does next, or take over steering it. Nothing leaves your machine unencrypted.

<!-- Demo: two people on two machines steering one agent, with control handed over mid-run. -->

## Shared sessions

- **Live.** Guests see the agent's replies, tool calls and file changes as they stream, through end-to-end encryption.
- **Roles.** A *viewer* watches and comments. A *collaborator* suggests messages, which the host sends on or drops. One *driver* steers: they send messages, stop, resume and answer approvals. Control passes between people with request, accept and hand back, and the host can always take it back.
- **The host stays in charge.** Guests never get your files, shell, API keys or connector tokens. They send requests, which your app checks against their role before carrying them out through the same code you use. While anyone else can steer, edits, commands, connectors and new websites ask you again. Secret files (`.env`, keys) are never shown or delegated. Values from them are also hidden if the agent quotes them, and so is anything that looks like a credential.
- **Private by design.** Messages are encrypted with XChaCha20-Poly1305 in your app. The key lives in the invite link after the `#`, which never reaches a server, so the relay only forwards ciphertext. Each guest's device signs everything it sends. When you remove someone, everyone else gets a new key.
- **An audit log** records who joined, who said what, who approved which call and who undid what.
- **Join from a browser** to watch and comment without installing anything. The desktop app is the full experience.

## The agent

- **Work in a folder.** It can read, search, edit and run commands. Commands run in an OS sandbox that only lets them write inside the folder: Seatbelt on macOS, bubblewrap on Linux, a restricted token on Windows. Edits and commands ask first unless you allow them. Every turn can be undone, a whole turn or a single file.
- **Git built in:** a live branch graph, commits, merges, worktrees for parallel work, and a pull request card.
- **Sub-agents.** The agent can hand self-contained tasks to sub-agents that run in parallel. A graph shows each one working.
- **Steer while it runs.** A new message joins at the next step, or right away with "Send now". You can pause and resume.
- **Reports:** security reviews, code reviews and codebase wikis of a folder. Fixes go through a normal Work session.
- **Any model.** OpenAI, Anthropic, Claude on Microsoft Foundry, OpenRouter, Groq, local models through Ollama or LM Studio, and any OpenAI- or Anthropic-compatible endpoint. Your keys stay in the OS keychain.
- **And more:** MCP connectors (stdio and HTTP, with OAuth), skills, memory, search across past chats, a built-in browser, image generation, and local dictation with Whisper.

## Download

Installers for Windows (`.exe` / `.msi`), macOS (`.dmg`) and Linux are attached to each [GitHub release](https://github.com/surajS0106/sush/releases).

The builds aren't code-signed yet, so the first launch shows a warning:

- **Windows:** on the SmartScreen prompt, choose **More info → Run anyway**.
- **macOS:** open the app once. When macOS blocks it, go to **System Settings → Privacy & Security** and choose **Open Anyway** next to the message about Sush.

## Sharing a session

1. Settings → Sharing: choose a relay and create an account on it. The relay only passes encrypted messages between apps.
   - **Hosted:** deploy your own to Cloudflare's free plan in a few minutes. See [apps/relay](apps/relay/README.md).
   - **On your network:** one person runs `bun run dev:relay`, and everyone uses that machine's address.
2. In a session, choose **Share live…**, then send the link. Each person waits in a lobby until you let them in.

## Layout

- `crates/sush-core`: the engine, in pure Rust with no Tauri dependency: providers, the agent loop, workspace tools and the sandbox, MCP, storage, and the shared-session protocol and encryption.
- `apps/desktop`: the Tauri 2 app. `src/` is the React UI; `src-tauri/` exposes `sush-core` to it.
- `apps/server`: the auth server (Bun, Hono, better-auth, SQLite), which is also the relay on a LAN.
- `apps/relay`: the same relay as a Cloudflare Worker, with Durable Objects and D1.
- `apps/viewer`: the browser viewer for shared sessions.

[CLAUDE.md](CLAUDE.md) describes the architecture in detail.

## Develop

Prerequisites:

- Rust (stable, via rustup) and Bun
- Windows: Visual Studio 2022 Build Tools with the "Desktop development with C++" workload (WebView2 ships with Windows 11)
- macOS: Xcode Command Line Tools
- CMake and libclang, to build the built-in Whisper dictation model (whisper.cpp). On Windows, CMake ships with the VS Build Tools (set `CMAKE` to its `cmake.exe` if it is not on PATH), and `pip install libclang` provides `libclang.dll` (point `LIBCLANG_PATH` at its `clang/native` folder) if LLVM is not installed.

```sh
bun install
bun run dev          # auth server + Ollama + desktop app, all in one terminal
bun run dev:server   # auth server only, on http://localhost:3000 (creates auth.sqlite on first run)
bun run dev:relay    # the same server on every interface, as a LAN relay
bun run dev:relay-cf # the Cloudflare relay locally (apps/relay)
bun run dev:app      # desktop app only, with hot reload
cargo test --workspace
```

To try a shared session on one machine, run a second instance with `SUSH_PROFILE=b`. It gets its own data, so it acts as a second person.

### Auth server config

| Env var | Default | |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | dev fallback | **Required when hosting the server yourself.** Generate with `openssl rand -base64 32`. The desktop app's bundled server generates its own per install. |
| `BETTER_AUTH_URL` | `http://localhost:$PORT` | Public URL of the server. |
| `PORT` | `3000` | |
| `DATABASE_PATH` | `auth.sqlite` | SQLite file; tables are migrated on startup. |

The desktop app reads `VITE_AUTH_URL` (default `http://localhost:3000`) and `VITE_RELAY_URL`, the relay a new Sharing setup suggests (default: the auth server). If you point `VITE_AUTH_URL` elsewhere, add that origin to `connect-src` in `apps/desktop/src-tauri/tauri.conf.json`. The relay needs no CSP entry, because the app connects to it from Rust.

## Build installers

```sh
bun run build        # .msi + setup .exe on Windows, .dmg/.app on macOS
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
