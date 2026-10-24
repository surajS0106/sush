---
name: multiplayer
description: Work on Sush Multiplayer, the live shared sessions where others watch, and later steer or take over, an agent run on the host's machine. Covers the protocol in sush-core (`share/`), the Tauri side (`share.rs`), the relay (`apps/server/src/share/`) and the UI (`lib/share.ts`, share dialog, watched sessions). Use when adding a guest intent, a host message, a role or permission, or building the next phase of docs/multiplayer-plan.md, and when testing a share with two app instances.
---

# Sush Multiplayer

Read `docs/multiplayer-plan.md` first. Its **Decisions** table records what the user chose. §2 is the wire protocol, §3 maps each intent to a permission check and a code path, §5 is the threat model, and §6 lists phases 2–4 file by file. Phase 1 (watch only, LAN relay) was built and tested by hand on 2026-10-25.

## The rule that must not break

**The host is authoritative.** The run, the workspace, the sandbox and every key stay on the host. Guests get redacted ops and send *intents*. The host checks each intent in `policy::authorize`, which denies by default, and carries it out through the same code the UI's own commands use. Owner actions never arrive over the network: a remote peer is at most a driver, so a compromised relay can't act as the owner.

## Where things are

| Layer | File | What it does |
|---|---|---|
| Protocol (pure, tested) | `crates/sush-core/src/share/mod.rs` | `HostMsg`, `GuestMsg`, `Intent`, `Role`, `Member`, `SharePolicy`, `Body`, `decode` (versioned `v`) |
| | `share/redact.rs` | What guests never see. Stateless per part, and keeps part indices so later ops line up |
| | `share/outbox.rs` | Host: numbers messages (`epoch`/`seq`), merges `AppendText`, builds snapshots; `touched_paths`, `blob_shas` |
| | `share/replica.rs` | Guest: applies in order, `Resync` on any gap, rewrites blob URLs for this platform |
| | `share/policy.rs` | `authorize(ctx, intent)`, `normalize(path)` |
| Tauri | `apps/desktop/src-tauri/src/share.rs` | Relay account (keyring), host and guest socket loops, `on_frame` tap, snapshots, intent handlers, all `share_*` commands |
| | `runs.rs` | `RunFrame::Share` / `ShareGone`, `Runs.shares`, the tap in `Runs::send` and `Host::emit`, `with_family` |
| | `workspaces.rs` | `turn_diff_files`, `file_view`, `FileDiff::hidden_if_secret` (shared with the intents) |
| | `store.rs` | `serve_blob` falls back to `Shares::fetch_blob` for a joined share's attachments |
| | `paths.rs` | `SUSH_PROFILE` dev profiles |
| Relay | `apps/server/src/share/db.ts`, `routes.ts`, `relay.ts` | Tables, REST (shares, invites, join, kick, end), WebSocket rooms with the lobby |
| UI | `apps/desktop/src/lib/share.ts` | Mirrors `share` frames, actions, relay account, `WatchingHost`, `safeImage` |
| | `components/share-dialog.tsx`, `shared-sessions.tsx`, `shared-files-panel.tsx`, `sharing-section.tsx` | Share dialog and relay setup; sidebar group, join dialog, header presence and `WatchingBar`; guest files panel; Settings → Sharing |
| | `chat-view.tsx` (`watching` prop), `tool-parts.tsx` (`WatchingHost`), `file-changes.tsx` (no `workspaceId` means read-only) | A watched session |
| Design note | `docs/design-notes/multiplayer.md` | Add a dated entry whenever UI changes |

## Invariants (each one was a deliberate choice)

- **Lock order:** runs' `channels` → `Shares.hosts` → one share lock at a time. A share's `inner` and `outbox` are never held together. `on_frame` runs *under* the channels lock, so it must never call `runs.send` (that would take the same lock again). Clone what you need, drop the guard, then send.
- **Snapshots** are built inside `Runs::with_family` and flush the outbox first, so the snapshot's `seq` is exactly what the next op follows. Messages are sent while the outbox is still held, so nothing can overtake them.
- **Identity:** `from` comes from the relay, and a role comes from `HostInner.members`. Anything a message body claims about its sender is ignored. When phase 2 adds authorship, the host *overwrites* `metadata.author`.
- **Guest threads** are `shared:<share id>` (sub-agents `shared:<id>:<call>`). They're never saved, and every action in `sessions.ts` returns early for them (`isSharedThread`). Re-emitted frames go through `runs.send`, and `on_frame` ignores them.
- **Redaction:** memory and past-chat tools stay *on* in shared sessions (the user's decision), but their input and output are replaced in the stream. A secret `fs_read` output, secret paths in `fs_search`, and credential-looking text in tool output are masked too. The model's own text is not scrubbed (deltas split tokens).
- **The token never reaches the webview.** Rust holds the relay token (`secrets::share_account_*`) and does all relay HTTP and WebSocket traffic, so the CSP needs no relay origin. `share_join` refuses a link whose origin isn't the configured relay, because the token is only ever sent there.
- **Invite tokens** travel in request bodies and link fragments, never in a path or query, so logs never see them. Only their hash is stored.
- Share state is owned by Rust and reaches every window as frames, so new share state needs **no** `broadcast` in `lib/windows.ts`. Only the leader window raises toasts (`isLeader()`).

## Adding a guest intent (the phase 2 pattern)

1. `share/mod.rs`: add the `Intent` variant (`kind` is kebab-case, fields camelCase). Add a test that it round-trips through `Body::encode`/`decode`.
2. `share/policy.rs`: decide who may send it and under what conditions. Return `Err` with a message the guest can read. Add tests for the allowed and refused cases, including the `Role::Owner` claim and a non-member.
3. `share.rs` `handle_intent`: carry it out through the existing code path (`run_start`/`start` with a `RunAction`, `run_interrupt`, `Runs::stop`, `workspaces::*`). Don't write a parallel implementation. Anything that starts a run needs a `RunConfig`, which only the UI can build: add the `share-config` frame from plan §3.3 (routed to the leader like `client-tool`, answered with `runConfig(id)` plus `budgetBlock`).
4. `lib/tauri.ts`: add the variant to `ShareIntent`. Call it from the UI with `api.shareRequest(threadId, intent)`.
5. If it changes what everyone sees, it must arrive as ops from the run, not as a reply. For example, attribution goes through `Op::SetMetadata` written by the runner (plan §3.5).

## Adding a host message

Add a variant to `HostMsg` and give it an `order()` arm if it's part of the ordered stream. Add a matching `Event` in `outbox.rs` (numbered in `flush`) and an arm in `Replica::apply` with a `Change`. Map that change in `share.rs` `frames_for` to run frames or a `ShareView` change. Mirror any new `ShareView` fields in `lib/tauri.ts`. A new `Op` variant needs a `caps` flag or a version bump (plan §2.5).

## Phase 2 entry points (from plan §6)

- Core: `RunAction::Respond` / `Inbox::Respond` gain `by: Option<Author>`, and the runner records `sushAnswers` metadata where it already decides first-wins (`waiting.remove`). Add `ApprovalClass`, `classify` and the approval floor to `policy.rs`, and an `audit.rs`.
- `runs.rs`: `Host::approval` applies the floor for shared threads (standing permissions such as auto-edits, sandboxed shell, "Always allow" connectors and allowed sites ask again unless delegated). Guest steers go through `start(..., RunAction::Steer, config)`. Add a `share_events` migration in `sush_core::store`.
- Guest image attachments: the host stores the blob after checking its type and size.
- UI: the guest composer (a driver steers, a collaborator suggests), a suggestion queue, author avatars on user messages, "Approved by …" on approval cards, an audit sheet.

## Testing with two instances on one Windows machine

1. `bun run dev:server`, then `bun run dev:app` for instance A.
2. Instance B, from the repo root in PowerShell, once A has compiled (it reuses A's Vite on 1420): `$env:SUSH_PROFILE='b'; .\target\debug\sush.exe`. Its window is titled "Sush (b)" and it has its own data (`%APPDATA%\com.sush.app-b`), dev secrets and WebView2 storage, so its own login. macOS shares webview storage between instances, so use two machines there.
3. In each instance, go to Settings → Sharing or the share dialog and choose **Use the account I'm signed in with**. Then in A: session menu → **Share live…** → start and copy the link. In B: **Shared with you** → **+** → paste → Join. In A: **Let in**.
4. For two machines on a LAN, run `bun run dev:relay` (all interfaces, port 3000) on the host instead of `dev:server`. Everyone, including the host, uses `http://<host-ip>:3000`, because links carry the relay's origin.

## Gotchas met so far

- `bun --watch` children outlive the background task that started them. After stopping a task, check ports 3000 and 1420 (`netstat -ano`) and stop the leftover `bun.exe --watch src/index.ts` or Vite. Two server processes on the same `auth.sqlite` give `SQLITE_BUSY` at startup.
- `tauri dev` output has ANSI colour codes, so wait for `Finished` or `sush.exe`, not `Running .*sush`.
- `app.state::<AppState>().x.lock()` held across later lines fails with E0716 (the temporary `State` is dropped). Bind `let state = app.state::<AppState>();` first.
- A type guard that also checks a field (`isLive`) must say so in its predicate type, or TypeScript narrows the other branch to `never`.
- Server modules import `db` from `share/db.ts`, which re-exports it from `auth.ts`.

## Verify

Run the `check` skill: `cargo test -p sush-core share::` for the protocol alone, the whole workspace when `share.rs` or a serde type changed, plus typecheck and the desktop build. Then test by hand with two instances as above. Only the user can see the windows, so ask them to confirm the UI.
