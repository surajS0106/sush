# Outside engines (Claude Code, Codex) — Design Notes

Last updated: 2026-11-18

## What changed

### 2026-11-18
- Plain chats can run on Claude Code or Codex. With no Cowork folder, `prepare_engine` gives the CLI an empty folder of the chat's own, `engine-chats/<thread>` in the app data dir (`chat_folder`, `apps/desktop/src-tauri/src/runs.rs:1212`). There the CLI can write, but every edit and command asks (`EditApproval::Ask`, `Commands::Sandbox`). `thread_delete` removes the folder (`forget_chat_folder`, `apps/desktop/src-tauri/src/store.rs`).
- Incognito chats can run on an engine too. `Context::ephemeral` (`crates/sush-core/src/engines/mod.rs:298`) passes `--no-session-persistence` to Claude Code and `ephemeral: true` on Codex's `thread/start`, and never resumes a CLI session (`mod.rs:436`). Each turn starts a new session with the conversation quoted as text.
- Reports (security review, code review, wiki), notebook chats and Studio outputs can run on an engine. `prepare_engine` builds them from the same `report_config`, `notebook_config` and the new `studio_config` as Sush's own loop (`runs.rs:1125`, `runs.rs:1271`), then moves their system prompt to `Context::system` and their Sush tools to `EnginePrep::tools`.
- New `apps/desktop/src-tauri/src/engine_bridge.rs` serves those tools to the CLI as an MCP server. It speaks streamable HTTP with JSON replies only, binds to 127.0.0.1 and starts on first use. Each run registers under a random 32-byte bearer token. `tools/call` runs through that run's `RunHost::execute`. The registration is dropped when the run ends.
- `Context::bridge` reaches Claude Code as `--mcp-config` and Codex as `config.mcp_servers.sush`. `Context::system` reaches them as `--append-system-prompt` and `developerInstructions`, followed by `BRIDGE_NOTE`.
- `Context::locked` is set for reports and notebooks. Claude Code runs in `default` mode instead of `plan`. Bridge tools that are `Approval::Auto` on Sush's loop are allowed at once, and any other non-bridge permission prompt is refused without asking (`claude.rs`). Codex gets a `read-only` sandbox, and its approval requests are declined (`codex.rs`).
- Bridge tool calls render as Sush's own cards. `claude_tool` strips the `mcp__sush__` prefix, and Codex's `mcpToolCall` drops the prefix for server `sush`.
- A note under the composer (`EngineChatNotice`, `apps/desktop/src/components/chat-view.tsx`) explains how an engine behaves in a plain chat. It's hidden in Cowork and notebook chats, and in an incognito chat it adds that the CLI keeps no record.

## Why

Engines were limited to Cowork because `prepare_engine` required a workspace. The engine needs only a working directory, so a plain chat gets a disposable one. A dedicated empty folder (rather than the user's home or a temp dir shared across chats) keeps one chat's files away from another's. It also gives cleanup a single place to delete.

Incognito had been refused because both CLIs write session transcripts to disk. Both can turn that off. The trade-off is losing resume: every turn re-sends the conversation as text, which costs more input tokens on long chats.

Reports and notebooks depend on Sush's own tools: `report_findings`, `wiki_write_page`, `git_diff`, the source tools and `studio_save`. The CLIs can't take tools in-process, but both load MCP servers. So the bridge exposes exactly the tools the run's config already holds, and runs them through the same `execute` path, which keeps behavior identical to Sush's loop. A plain-text "final message with JSON" protocol was rejected: wiki pages and incremental findings would not fit it, and notebook answers need source search during the turn.

Locking exists because these sessions were read-only on Sush's loop and must stay so. Claude's `plan` mode would also hold back the bridge tools, so the lock is enforced in Sush's permission handler instead.

## What makes it stand out

- One bearer token per run, so a CLI can only reach its own run's tools. Requests carrying an `Origin` header are refused, so a web page can't call the bridge even if it guesses the port.
- No new HTTP dependency. The server is about 200 lines on `tokio::net` with body and header caps.
- Approval policy carries over: tools that ask on Sush's loop still ask on their card, and auto tools don't prompt.
- Works with the CLIs as published, using only documented flags and parameters, in line with `docs/engines.md`.
- Unverified: the Codex parameters (`config`, `developerInstructions`, `ephemeral`) haven't been run against a live Codex, like the rest of that adapter.
