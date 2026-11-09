---
name: multiplayer
description: Work on Sush Multiplayer, the live shared sessions where others watch, and later steer or take over, an agent run on the host's machine. Covers the protocol in sush-core (`share/`), the Tauri side (`share.rs`), the relay (`apps/server/src/share/`) and the UI (`lib/share.ts`, share dialog, watched sessions). Use when adding a guest intent, a host message, a role or permission, or building the next phase of docs/multiplayer-plan.md, and when testing a share with two app instances.
---

# Sush Multiplayer

Read `docs/multiplayer-plan.md` first. Its **Decisions** table records what the user chose. §2 is the wire protocol, §3 maps each intent to a permission check and a code path, §5 is the threat model, and §6 lists phases 2–4 file by file. Phase 1 (watch only, LAN relay) was built and tested by hand on 2026-10-25. Phase 2 (roles, steering, suggestions, approvals, comments, audit log) was built, tested by hand and pushed the same day; the plan's "Phase 2 as built" table records the choices made while building it. Phases 3 (hand off: control, pause, step away, delegated undo) and 4 (end-to-end encryption, browser viewer, usage counts, plan hooks) were built and pushed on 2026-10-25 after a hand test with two instances and the browser viewer (encryption seen as `e2e1.` on the relay, viewer, usage counts); their "as built" tables in the plan record the choices and deviations.

## The rule that must not break

**The host is authoritative.** The run, the workspace, the sandbox and every key stay on the host. Guests get redacted ops and send *intents*. The host checks each intent in `policy::authorize`, which denies by default, and carries it out through the same code the UI's own commands use. Owner actions never arrive over the network: a remote peer is at most a driver, so a compromised relay can't act as the owner.

## Where things are

| Layer | File | What it does |
|---|---|---|
| Protocol (pure, tested) | `crates/sush-core/src/share/mod.rs` | `HostMsg`, `GuestMsg`, `Intent`, `Role`, `Member`, `SharePolicy` + `Delegation`, `Suggestion`, `Comment`, `Room`, `Body`, `decode` (versioned `v`) |
| | `share/redact.rs` | What guests never see. Stateless per part, and keeps part indices so later ops line up |
| | `share/outbox.rs` | Host: numbers messages (`epoch`/`seq`), merges `AppendText`, builds snapshots; `touched_paths`, `blob_shas` |
| | `share/replica.rs` | Guest: applies in order, `Resync` on any gap, rewrites blob URLs for this platform |
| | `share/policy.rs` | `authorize(ctx, intent)` → `Allowed::Do` / `Suggest`, `ApprovalClass`, `classify`, `floored`, `may_answer`, `normalize(path)` |
| | `share/audit.rs` | `Kind`, `Entry`, `preview`, `push` (the latest `KEEP`) |
| | `share/control.rs` | `apply(members, requests, actor, change)` for request/accept/decline/pass/release/take, `forget`, `driver`, `AwayPolicy` (pause by default, or keep going N minutes) |
| | `share/crypto.rs` | `seal`/`open` (`e2e1.<gen>.<nonce>.<ct>`), `Device` (Ed25519 signs, X25519 receives rekeys), `verify`, `seal_for`, `Seen` (replays), `parse_fragment` |
| Core, outside `share/` | `agent/run.rs` | `Author`; `RunAction::Respond { by }` / `Inbox::Respond { by }` → the runner records `metadata.sushAnswers` (`ANSWERS`) |
| | `store.rs` | `share_events` (migration 6): `add_share_event`, `share_events` |
| Tauri | `apps/desktop/src-tauri/src/share.rs` | Relay account (keyring), host and guest socket loops, `on_frame` tap, snapshots, intent handlers (`handle_intent` → `steer`, `suggest`, `accept`, `respond`, `comment`), `request_config`, first-wins `claim`, `record` (audit), all `share_*` commands |
| | `runs.rs` | `RunFrame::Share` / `ShareGone` / `ShareConfig` (leader only), `Runs.shares`, the tap in `Runs::send` and `Host::emit`, `with_family`, the approval floor in `Host::approval`, `run_start`'s owner claim, `start_run`, `interrupt`, `recheck_family` |
| | `workspaces.rs` | `turn_diff_files`, `file_view`, `FileDiff::hidden_if_secret` (shared with the intents) |
| | `store.rs` | `serve_blob` falls back to `Shares::fetch_blob` for a joined share's attachments |
| | `paths.rs` | `SUSH_PROFILE` dev profiles |
| Relay | `apps/server/src/share/db.ts`, `routes.ts`, `relay.ts` | Tables, REST (shares, invites with `roleCap`, join, kick, end), WebSocket rooms with the lobby (peers carry `roleCap`) |
| Viewer | `apps/viewer/src/session.ts`, `crypto.ts`, `app.tsx` | The browser viewer: its own replica and the same encryption (`@noble`), sign-in with cookies, watch and comment |
| UI | `apps/desktop/src/lib/share.ts` | Mirrors `share` frames, actions (roles, delegation, suggestions, comments), relay account, `WatchingHost` (`{ hostName, mayAnswer }`), `safeImage` |
| | `lib/sessions.ts` | A guest's send/respond/stop/resume/"Send now" on `shared:` threads → intents (`askHost`); answers `share-config` frames (`answerShareConfig`) |
| | `components/share-dialog.tsx`, `shared-sessions.tsx`, `suggestion-queue.tsx`, `share-activity.tsx`, `shared-files-panel.tsx`, `sharing-section.tsx` | Share dialog (roles, delegation, activity) and relay setup; sidebar group, join dialog, header presence, `GuestComposer` and `WatchingBar`; suggestions above the composer; comments and the log in a sheet; guest files panel; Settings → Sharing |
| | `chat-view.tsx` (`watching` prop), `tool-parts.tsx` (`WatchingHost`, `answer` → "Approved by …"), `file-changes.tsx` (no `workspaceId` means read-only) | A watched session |
| Design note | `docs/design-notes/multiplayer.md` | Add a dated entry whenever UI changes |

## Invariants (each one was a deliberate choice)

- **Lock order:** runs' `channels` → `Shares.hosts` → a share's locks. A share's `outbox` may be held while taking its `inner` (`HostShare::append`, and a snapshot reading its room), **never** `inner` then `outbox`: release `inner` before `push`. Appends (comments, audit entries) change `inner` and push their message as one step, so a snapshot has each exactly when its message falls before it. Never call `emit_view` (or `record`, which calls it) while holding `inner`: `view()` takes it again. `on_frame` runs *under* the channels lock, so it must never call `runs.send` (that would take the same lock again). Clone what you need, drop the guard, then send.
- **Snapshots** are built inside `Runs::with_family` and flush the outbox first, so the snapshot's `seq` is exactly what the next op follows. Messages are sent while the outbox is still held, so nothing can overtake them.
- **Identity:** `from` comes from the relay, and a role comes from `HostInner.members`. Anything a message body claims about its sender is ignored. Guest messages are built on the host (`user_message`) with `metadata.author` from the member list, so a claimed author never counts.
- **Guest threads** are `shared:<share id>` (sub-agents `shared:<id>:<call>`). They're never saved. In `sessions.ts`, send, respond, stop, resume and "Send now" become intents for them and the rest (edit, regenerate, rewind, add agent) return early (`isSharedThread`). Re-emitted frames go through `runs.send`, and `on_frame` ignores them.
- **Redaction:** memory and past-chat tools stay *on* in shared sessions (the user's decision), but their input and output are replaced in the stream. A secret `fs_read` output, secret paths in `fs_search`, and credential-looking text in tool output are masked too. The model's own text is not scrubbed (deltas split tokens).
- **The token never reaches the webview.** Rust holds the relay token (`secrets::share_account_*`) and does all relay HTTP and WebSocket traffic, so the CSP needs no relay origin. `share_join` refuses a link whose origin isn't the configured relay, because the token is only ever sent there.
- **Invite tokens** travel in request bodies and link fragments, never in a path or query, so logs never see them. Only their hash is stored.
- **The approval floor** applies while any member is a driver or collaborator (`Shares::steerable`). Whenever that can change (a role change, a kick, the share ending), call `runs.recheck_family` so held calls that no longer need asking start.
- **First answer wins**, per call id, for guests and the owner alike (`HostShare::claim`; `run_start` claims for the owner and credits them). Release the claim if the run can't take the answer.
- **A guest never makes up a tool result:** they send `approve`/`deny`, and an `answer` only for `ask_user` (shape-checked). Deny uses the UI's own `DENIED`/`DISMISSED` text so cards render the same.
- Share state is owned by Rust and reaches every window as frames, so new share state needs **no** `broadcast` in `lib/windows.ts`. Only the leader window raises toasts (`isLeader()`).

## Adding a guest intent (the phase 2 pattern)

1. `share/mod.rs`: add the `Intent` variant (`kind` is kebab-case, fields camelCase). Add a test that it round-trips through `Body::encode`/`decode`.
2. `share/policy.rs`: decide who may send it and under what conditions. Return `Err` with a message the guest can read. Add tests for the allowed and refused cases, including the `Role::Owner` claim and a non-member.
3. `share.rs` `handle_intent`: carry it out through the existing code path (`run_start`/`start` with a `RunAction`, `run_interrupt`, `Runs::stop`, `workspaces::*`). Don't write a parallel implementation. Anything that starts a run needs a `RunConfig`, which only the UI can build: add the `share-config` frame from plan §3.3 (routed to the leader like `client-tool`, answered with `runConfig(id)` plus `budgetBlock`).
4. `lib/tauri.ts`: add the variant to `ShareIntent`. Call it from the UI with `api.shareRequest(threadId, intent)`.
5. If it changes what everyone sees, it must arrive as ops from the run, not as a reply. For example, attribution goes through `Op::SetMetadata` written by the runner (plan §3.5).

## Adding a host message

Add a variant to `HostMsg` and give it an `order()` arm if it's part of the ordered stream. Add a matching `Event` in `outbox.rs` (numbered in `flush`) and an arm in `Replica::apply` with a `Change`. Map that change in `share.rs` `frames_for` to run frames or a `ShareView` change. Mirror any new `ShareView` fields in `lib/tauri.ts`. A new `Op` variant needs a `caps` flag or a version bump (plan §2.5).

## Phases 3 and 4 (built 2026-10-25)

- Control: intents `request-control`, `accept-control`, `decline-control`, `pass-control`, `release-control`; the owner's `share_control`. All go through `HostShare::change_control`. UI: `components/control-banner.tsx`.
- Away: `share_step_away`; `SharePolicy.away`; `Inbox::Pause` via `Runs::pause_family`. Only the button triggers it.
- Undo: the `undo` intent with `delegation.undo`; `file-changes.tsx` shows Undo for such a driver.
- Encryption: `HostShare::wire` / `read_guest` / `send_current_key` / `rekey`, and `GuestShare::send_host` / `read_host` / `take_key` / `hello`. Lock order inside a host share: `outbox` → `e2e` → `inner`; inside a guest share: `inner` → `e2e`. Anything new that sends to guests must go through `wire`, never `Body::encode` alone.
- Relay: `share/plans.ts` (`SUSH_PLANS`, `SUSH_TEAM_EMAILS`), `share/metrics.ts` (`SUSH_ADMIN_EMAILS`), the viewer at `/join/:id` (`SUSH_VIEWER_DIR`).
- Still design only: cross-machine hand-off (plan §6, phase 3).

## Room, history, git graph, browser (2026-11-01, see the plan's table)

- Everyone chats (`comment` has no role check beyond membership). UI: `RoomView` in `share-activity.tsx` (header sheet, and a tab of the guest's `SharedPanel` in `shared-files-panel.tsx`).
- Intents `git-log` / `git-commit` (Cowork shares, any member); `GitGraph` in `git-graph-pane.tsx` takes a `GitSource`.
- `BrowserPage` rides in `members` and the snapshot (serde default). `browser.rs` `update_page` calls `Shares::browser_changed`; `SharePolicy.hide_browser` turns it off. A new field in `Room`/`Members`/`Snapshot` means updating `outbox.rs` and `replica.rs` destructurings too.
- History: `sush.shareHistory` in `lib/share.ts` (leader writes), invite links in the keyring (`secrets::share_link_*`, `share_rejoin`, `share_forget`).
- Hand checks: a viewer posts in the room (desktop and browser viewer); a guest's Graph tab shows the host's history and a commit's files (no email); the host opens `http://localhost:3001` in the built-in browser and the guest's Browser tab opens it at the host's network address; leave a share, then "rejoin" from History; the guest panel drags wider and remembers it.

## Notebook chats (2026-11-09, not yet tested by hand)

- A notebook's chat is shared like any session (the notebook menu's "Share this chat live…"). `policy::Ctx.notebook` says the thread is one (`store.notebook_for_thread`).
- **Redaction:** `source_search`/`source_read` outputs reach guests with each passage's title and `sushsrc:` address but its text replaced (`SOURCE_TEXT`). Passage citations lose their `?q=` quote (`strip_passage_quotes`, in `AppendText` deltas and text parts), because the quote is source text.
- **Intents:**
  - `get-notebook` (any member; title, source titles, finished Studio outputs without audio clips, never the owner's notes; `notebooks::guest_view`).
  - `get-passage` (only with `SharePolicy.show_sources`, off by default, and only a passage of that notebook's own sources; `notebooks::guest_passage`).
- **UI:** the guest's side panel gets a Notebook tab (`components/shared-notebook.tsx`), which opens on a citation click. The share dialog's "Let them read cited passages" toggle shows only for notebook chats.
- **Hand checks to run:**
  - A guest sees the chat's citations with source titles but no source text in the activity rows.
  - With the toggle off, opening a citation says the host keeps sources to themselves; turning it on makes the passage open.
  - A `get-passage` for another notebook's passage is refused.
  - The guest's Notebook tab lists Studio outputs, and a quiz is playable.

## Testing with two instances on one Windows machine

1. `bun run dev:server`, then `bun run dev:app` for instance A.
2. Instance B, from the repo root in PowerShell, once A has compiled (it reuses A's Vite on 1420): `$env:SUSH_PROFILE='b'; .\target\debug\sush.exe`. Its window is titled "Sush (b)" and it has its own data (`%APPDATA%\com.sush.app-b`), dev secrets and WebView2 storage, so its own login. macOS shares webview storage between instances, so use two machines there.
3. In each instance, go to Settings → Sharing or the share dialog and choose **Use the account I'm signed in with**. Then in A: session menu → **Share live…** → start and copy the link. In B: **Shared with you** → **+** → paste → Join. In A: **Let in**.
4. For two machines on a LAN, run `bun run dev:relay` (all interfaces, port 3000) on the host instead of `dev:server`. Everyone, including the host, uses `http://<host-ip>:3000`, because links carry the relay's origin.
5. Phase 2 checks (all passed by hand on 2026-10-25). Give A's Cowork session auto-edits, and use a folder with a `.env`. Join B with **Link to suggest**:
   - B's suggestion reaches A's queue. A sends it on (edited); the message shows B's avatar and "sent by A".
   - An edit asks A despite auto-edits (the floor). B sees "Waiting for A".
   - Make B **Drives**. B's messages steer; mid-run they queue and "Send now" works. B can pause and resume, and answers `ask_user` ("Answered by B").
   - Edits wait for A until **File changes** is delegated, then B gets the card ("Approved by B"). Two clicks on one card: the second gets "Already answered by …". `.env` reads stay A's.
   - B's images go through; other files and ones over 2 MB are refused.
   - Comments show on both sides; a viewer can't comment. The Activity log lists it all.
   - Removing B (or ending the share) with an edit card waiting lets the edit run by itself.
   - B reloads and catches up.

6. Phase 3 checks. With B driving: B's **Pass control** to C, C's **Give back**; B (as a viewer) **Ask to drive**, A lets them from the banner or the toast. A **Take control** mid-run. A **Step away** (pause): the run finishes its tool call and stops, marked paused; B is back to collaborator. Set "Let the driver carry on" for 1 minute and step away: B keeps steering, and after a minute the run pauses. Hand over **Undoing changes**: B's Undo puts files back on A's machine and the Activity log says so.
7. Phase 4 checks. Start a share with encryption on: the link has `#t=…&k=…`; watch the relay's traffic (or log `body` in `relay.ts` for a moment) and see only `e2e1.` strings. Kick C while B stays: B keeps following (rekey), C's old key reads nothing new. Encryption off: the old token-only link still works. Browser viewer: `bun run build:viewer`, restart the relay, open the invite link in a browser, sign up, get let in, watch, and comment with a "to suggest" link. Plans: `SUSH_PLANS=on` on the relay with no `SUSH_TEAM_EMAILS`: a second guest can't join, Drives is greyed out, "Link to suggest" works but driving doesn't. Counts: turn on Settings → Sharing → Usage counts, share, end it, then `GET /api/metrics/weekly` as an admin.

## Gotchas met so far

- `bun --watch` children outlive the background task that started them. After stopping a task, check ports 3000 and 1420 (`netstat -ano`) and stop the leftover `bun.exe --watch src/index.ts` or Vite. Two server processes on the same `auth.sqlite` give `SQLITE_BUSY` at startup.
- `tauri dev` output has ANSI colour codes, so wait for `Finished` or `sush.exe`, not `Running .*sush`.
- `app.state::<AppState>().x.lock()` held across later lines fails with E0716 (the temporary `State` is dropped). Bind `let state = app.state::<AppState>();` first.
- A type guard that also checks a field (`isLive`) must say so in its predicate type, or TypeScript narrows the other branch to `never`.
- Server modules import `db` from `share/db.ts`, which re-exports it from `auth.ts`.
- A `String` moved into a `blocking(move || …)` closure can't be printed afterwards in the same task (E0382). Clone it for the closure first.
- The relay drops guest frames over its cap (8 MB) with `too-large`. Anything bigger a guest sends needs chunking, not a higher cap.
- After a Rust fix, instance B keeps the old binary until restarted by hand.
- Devices are bound per connection (`HostE2e.devices` by peer id), never per person: a reloaded browser page connects again before its old connection has left, and a per-person binding silently dropped its hello (an empty viewer).
- In the viewer, an effect must not return a value: newer Chrome's `scrollIntoView` returns a promise, which React then calls as a cleanup (`l is not a function`). Use braces.

## Verify

Run the `check` skill: `cargo test -p sush-core share::` for the protocol alone, the whole workspace when `share.rs` or a serde type changed, plus typecheck and the desktop build. Then test by hand with two instances as above. Only the user can see the windows, so ask them to confirm the UI.

## Where it lives (moved from CLAUDE.md)

The detailed map of shared sessions across core, the Tauri shell and the UI, kept here so it loads only when you work on them.

- `share/`: live shared sessions (see `docs/multiplayer-plan.md`). The host is authoritative: guests get a thread as the same `Op`s the UI applies, after `redact` (private tools' input and output, secret files' content, credential-looking text in tool output), and send only `Intent`s, which `policy::authorize` checks against the sender's role and what the session shows (deny by default, secret paths never, owner actions never from the network). Roles: a viewer reads; a collaborator's message becomes a `Suggestion`; everyone, viewers too, chats in the room (comments, never sent to the model); the one driver steers, stops, resumes, "Send now"s and answers the approvals `policy::may_answer` allows (questions, plus the `Delegation` the owner set; secret reads never). `policy::classify` gives each call an `ApprovalClass`, and `floored` says which ones ask again while others can steer. `audit` is the log's entry type (`share_events` in the store). `outbox` numbers the host's messages (`epoch`/`seq`) and merges text deltas. `replica` is a guest's copy, which asks for a snapshot on any gap. Message bodies are versioned (`v`). The relay never reads them. Who answered a tool call is recorded by the runner itself (`RunAction::Respond { by }` → `metadata.sushAnswers`), where it already decides first-wins. `control` moves the driver role (request, accept, decline, pass, release, take; one change at a time on the host) and holds the away policy (pause by default, or the driver keeps going for N minutes). `crypto` is end-to-end encryption (on by default): XChaCha20-Poly1305 bodies (`e2e1.<gen>.<nonce>.<ct>`, bound to share, generation and direction) with the first key in the link fragment, each guest's per-join device (Ed25519 signs everything it sends, bound on its hello; X25519 receives the new key sealed for it after a kick). The browser viewer implements the same formats; keep them in step.

- `lib/share.ts`: shared sessions. It mirrors `share` frames (Rust owns the state and every window gets the frames, so nothing is broadcast; a `ShareView` carries roles, suggestions, comments and the audit log), runs the share/join/admit/kick/role/delegation/suggestion/comment actions, holds the relay account, and decides which waiting cards a driver may answer (`mayAnswer`, mirroring `policy::classify`). `components/share-dialog.tsx` (Share live…, relay setup, encryption, roles, delegation, away policy, activity), `components/control-banner.tsx` (who drives, asking for and passing control, Step away), `components/shared-sessions.tsx` (the sidebar's "Shared with you", join dialog, header presence, `GuestComposer` for a driver or collaborator, the viewer's bar), `components/suggestion-queue.tsx`, `components/share-activity.tsx` (comments and the log, from the header) and `components/shared-files-panel.tsx` are its UI. A joined share opens on the `shared` page in `ChatView` with `watching` set. In `sessions.ts`, a guest's send, respond, stop, resume and "Send now" on a `shared:` thread become intents (`share_request`); edit, regenerate and rewind stay no-ops. Tool cards read `WatchingHost` (`{ hostName, mayAnswer }`) to show "Waiting for … to approve" on the rest, and `metadata.sushAnswers` for "Approved by …".

`share.rs` is shared sessions over the relay (`apps/server` `/api/shares`). Both ends of the WebSocket are in Rust (`tokio-tungstenite`, bearer on the upgrade). The relay account (URL + token) is in the keyring (`secrets::share_account_*`). Host: every frame passes `Runs.shares.on_frame` under the channels lock (from `Runs::send` and `Host::emit`), and the frames of a shared thread or its sub-agents go into that share's outbox. A guest's hello gets a snapshot taken in `Runs::with_family` (same lock), so it lines up with the next op. Intents run through the same code as the UI's commands (`workspaces::turn_diff_files`, `file_view`, the store's blobs, and `runs::start_run` / `Runs::interrupt` / `stop_with_agents` for a driver's steer, respond, resume, "Send now" and stop). A run a guest starts needs the UI's config: a `share-config` frame goes to the leader window (like `client-tool`), which answers `share_config_result` with `runConfig` (budgets apply). Guest messages are built on the host, credited in `metadata.author` (any author a guest claims never counts), and their images are checked and stored as blobs. While a driver or collaborator is in, `Host::approval` asks again for standing permissions (`Shares::steerable`); role changes send `Inbox::Recheck`. Answers are first-wins per call (`HostShare::claim`), the owner's own too (`run_start` → `claim_local`, credited to the owner). Owner-only commands: `share_set_role`, `share_set_policy` (browsing, delegation, away policy), `share_control` (accept, decline, pass, take), `share_step_away`, `share_suggestion_accept` / `_drop`, `share_comment`. Control moves go through `HostShare::change_control` (audit, `members` message, recheck). Stepping away with the pause policy takes control back and sends `Runs::pause_family`. A driver's `undo` intent (with `delegation.undo`) runs `workspaces::restore_since`. In an encrypted share, `HostShare::wire` seals everything sent, `read_guest` opens and verifies what arrives (dropping anything unsealed, replayed or not signed by the sender's bound device), and `share_kick` rekeys. The relay's plan (`GET /api/shares/limits`) gates who may drive. Everything goes in the audit log (`HostShare::record` → `share_events`). Guests also read the folder's git history (`git-log`/`git-commit` intents, no emails or secret paths) and follow the host's built-in browser (`BrowserPage` in the `members` message, from `Shares::browser_changed`; `localhost` swapped for the host's network address); a joined share's invite link is kept in the keyring for `share_rejoin` (the UI's history in `lib/share.ts` holds no transcripts). Guest: host messages go into a `Replica` and come out as ordinary `RunFrame`s for `shared:<share id>` (`…:<call id>` for sub-agents), never saved. `store::serve_blob` fetches a joined share's attachments from its host.
