# Sush Multiplayer: shared, live agent sessions

Status: **draft, waiting for approval**. Nothing here is built yet.
Written 2026-10-20 against `main` at `0c15f9e` (v2.1.1).

A team watches an agent's Cowork session live, redirects it, and hands it off.
The run, the workspace, the sandbox, API keys and connector tokens stay on the
host's machine. Guests get replicated ops and frames, and they send *intents*.
The host checks each intent against the sender's role and then carries it out
through the code paths the app already uses.

---

## 0. What the code gives us, and what it doesn't

From reading `agent/run.rs`, `agent/ui.rs`, `runs.rs`, `lib/sessions.ts`, `lib/windows.ts`, `apps/server`:

**Ready to reuse**

- Every change to a thread is an `Op` (`Reset | Push | PushPart | AppendText | SetPart | SetMetadata`). The runner applies it, `Host::emit` applies it to `LiveState.messages`, and the UI applies it with `applyOp`. A guest that applies the same ops ends up with the same thread.
- A run always starts with `Op::Reset { messages }`, so a guest that falls behind can resynchronise from any later run start.
- `runs_subscribe` already solves the late joiner: it returns a snapshot of `LiveState` taken under the channels lock, then streams frames. A guest's catch-up works the same way.
- First-answer-wins is mostly in place already: `resolve()` does `waiting.remove(&call_id)` and ignores a second answer to the same call.
- Frames reach every window from Rust. If share state lives in Rust and goes out as frames, multi-window sync needs no new `broadcast` calls.

**Gaps the plan has to close**

1. **The release auth server is per install.** `auth_server.rs` runs the sidecar on `localhost:47321`, with its own SQLite file in the app data dir. Two machines therefore have two unrelated account databases, and neither can reach the other's. Multiplayer needs one **hosted** server that both machines sign in to (open question 1). In dev, both instances can point `VITE_AUTH_URL` at the same `bun run dev:server`, so Phase 1 can be tested without a deployment.
2. **Guests can't build a `RunConfig`.** Skills, connectors, memory tools, project instructions and the budget check (`budgetBlock`) all live in TS (`runConfig` in `sessions.ts`). Guest steers in Phase 2 must ask the host's leader window for a config, the same way `client-tool` frames work today (§3.3).
3. **Tool outputs carry private data.** Ops include tool parts in full: `memory_*` inputs and outputs, `chats_search`/`chat_read` results (other conversations), `fs_read` of an approved secret file, and shell output. Ops must go through a redaction pass before they leave the host (§2.4).
4. **`fs_search` reads secret files without approval** (`WorkspaceFs::search` walks every file and never checks `looks_secret`), so a search for `KEY` returns the matching `.env` lines. This is already a leak in single-player use. I propose fixing it in core as part of Phase 1 (open question 4).
5. **Standing permissions can be turned against the owner.** If the workspace auto-approves edits, connector tools are set to "Always allow", or browser sites are allowed, a driver's steer runs those actions on the owner's authority. A driver can also ask the model to repeat what memory or past-chat tools returned, which gets around output redaction. The fix is an approval floor while others can steer (§3.4).
6. **A safe pause needs a new primitive.** `Runs::stop` cancels immediately and tree-kills shell commands. Pausing at a step boundary needs a new `Inbox::Pause` (Phase 3).

---

## 1. Architecture

```
 Host machine                                  Relay (apps/server, hosted)              Guest machine
 ┌───────────────────────────────┐            ┌──────────────────────────┐          ┌─────────────────────────────┐
 │ agent::run ──RunEvent──► Host │            │ better-auth (bearer)     │          │ share.rs (guest replica)    │
 │        ▲          emit/send   │            │ /api/shares REST         │          │   seq check, resync         │
 │   Inbox│            │         │            │ /api/shares/:id/ws       │          │   re-emits as RunFrame::Op  │
 │        │      share tap       │  wss       │  rooms: route by header, │  wss     │   with threadId shared:<id> │
 │ share.rs host ◄──────┘        │◄──────────►│  body opaque (ciphertext │◄────────►│        │                    │
 │  redact → seq → coalesce      │            │  in phase 4)             │          │   runs channel → onFrame    │
 │  intents → policy → runs.rs   │            │  lobby/admit, kick, rate │          │   applyOp (unchanged)       │
 └───────────────────────────────┘            └──────────────────────────┘          └─────────────────────────────┘
```

**Decision: both ends of the socket are in Rust** (`apps/desktop/src-tauri/src/share.rs`, using `tokio-tungstenite`):

- The host side has to be in Rust anyway. Frames come from `Runs::send`/`Host::emit`, and intents must be checked next to `run_start`.
- Rust can put `Authorization: Bearer` on the WebSocket upgrade. A webview `WebSocket` can't set headers, so the token would end up in the URL, where it gets logged.
- Phase 4 encryption is one Rust implementation used by both sides.
- On the guest, incoming ops are re-emitted as ordinary `RunFrame::Op`/`Status` with `threadId = "shared:<shareId>"`. The existing `onFrame` → `applyOp` path renders them without changes.

CSP consequence: the webview never opens the socket, so `connect-src` doesn't need the `ws(s)` origin. The release CSP will need the hosted server's `https` origin once release builds sign in to it (open question 2).

**The pure core lives in `crates/sush-core/src/share/`** and has no Tauri dependency:

| file | contents |
|---|---|
| `mod.rs` | `PROTOCOL_VERSION`, `Role`, `Member`, `SharePolicy`, `Delegation`, `HostMsg`, `GuestMsg`, `Intent`, `Reply` |
| `policy.rs` | `authorize(ctx, sender, intent) -> Result<Action, Denied>`, `classify(call, tool) -> ApprovalClass`, `approval_floor(...)` |
| `redact.rs` | `redact_part`, `redact_op`, `redact_messages`, `scrub_text` (secret patterns), `visible_path` |
| `outbox.rs` | host side: assigns `seq`, coalesces `AppendText`, snapshot under the same ordering |
| `replica.rs` | guest side: applies snapshot/ops, detects gaps (→ `NeedResync`), rejects stale epochs |
| `audit.rs` (P2) | audit entry types |
| `control.rs` (P3) | driver hand-off state machine |

Each file has inline `#[cfg(test)]` tests. Like `agent/`, they use a scripted fake: a fake host emits a recorded run's ops, and a replica plus the redactor must end up at the same messages that a filtered `ui::apply` would produce.

---

## 2. Wire protocol

### 2.1 Two layers

**Relay frames** are JSON text over WS. The relay reads the routing header and never looks at `body`.

```jsonc
// client → relay
{ "t": "send", "to": "all" | "host" | "<peerId>", "body": "<string>" }   // a guest's `to` is forced to "host"
{ "t": "admit", "userId": "…", "allow": true }                         // host only
{ "t": "kick", "userId": "…" }                                          // host only
{ "t": "ping" }

// relay → client
{ "t": "welcome", "you": Peer, "peers": Peer[], "hostOnline": true, "lobby": Peer[] /* host only */ }
{ "t": "recv", "from": Peer, "body": "<string>", "ts": 1729400000000 }
{ "t": "knock", "peer": Peer }                     // host only: someone is waiting in the lobby
{ "t": "peer-joined", "peer": Peer } | { "t": "peer-left", "peerId": "…" }
{ "t": "host-offline" } | { "t": "host-online" }
{ "t": "closed", "reason": "ended" | "kicked" | "expired" | "denied" | "superseded" }
{ "t": "error", "code": "rate-limited" | "too-large" | "bad-frame" }

Peer = { peerId, userId, name, image /* data: URL or built-in avatar id only */, isHost, connectedAt }
```

- `from` is always stamped by the relay from the authenticated session. A `from` inside a body is never trusted.
- Guests can address only the host. Guest-to-guest traffic (comments, suggestions) goes through the host, which keeps it authoritative and lets it filter.
- `to: "all"` reaches only admitted peers. Peers waiting in the lobby receive only `welcome` and `closed`.

**Bodies** are JSON (ciphertext in Phase 4). Every body carries `v`.

### 2.2 Host → guest bodies (`HostMsg`)

```jsonc
{ "v":1, "type":"snapshot", "epoch":3, "seq":120,
  "thread": { "title":"Fix login", "kind":"cowork", "workspaceName":"sush", "hostName":"Suraj" },
  "messages":[…redacted UIMessages…], "status":"streaming", "error":null,
  "running":["call_1"],                       // tool calls in flight (tool-running)
  "turns":[{ "turnId":"…", "files":[{ "path":"src/a.rs", "added":3, "removed":1 }] }],
  "members":[{ "userId":"…", "role":"viewer" }], "driver":null,
  "policy":{ "browseFiles":false, "delegation":{…} },
  "queue":[…],  "audit":[…] }                  // P2
{ "v":1, "type":"op",           "epoch":3, "seq":121, "op":{ "type":"append-text", "index":2, "delta":"…" } }
{ "v":1, "type":"status",       "epoch":3, "seq":122, "status":"awaiting", "error":null }
{ "v":1, "type":"tool-running", "epoch":3, "seq":123, "callId":"…", "running":true }
{ "v":1, "type":"files-changed","epoch":3, "seq":124, "turns":[…] }      // paths + counts, secret paths removed
{ "v":1, "type":"members",      "epoch":3, "seq":125, "members":[…], "driver":"userId|null", "policy":{…} }  // role change
{ "v":1, "type":"reply",        "re":"<intent id>", "ok":true, "data":{…} } | { …, "ok":false, "error":"…" }
{ "v":1, "type":"queue" | "audit" | "control", … }                      // P2 / P3
{ "v":1, "type":"incompatible", "hostV":1, "minV":1 }
```

### 2.3 Guest → host bodies (`GuestMsg`)

```jsonc
{ "v":1, "type":"hello", "minV":1, "caps":["coalesced-text"] }   // host answers with snapshot or incompatible
{ "v":1, "type":"resync", "lastSeq":118 }                       // gap or unknown op → fresh snapshot
{ "v":1, "type":"intent", "id":"<uuid>", "intent":{ "kind":"get-diff", "turnId":"…" } }
```

### 2.4 Ordering, catch-up, redaction

- **`seq`** is a counter per share, in host order. **`epoch`** goes up whenever the host's share session restarts, for example after reconnecting following an app restart. A guest drops anything older than its snapshot and asks for a `resync` when it sees a gap.
- **Snapshot consistency:** `Host::emit` already holds `runs.channels` and then the run's `state` lock. The share tap pushes the frame into the outbox inside that same critical section. The snapshot for a joiner is taken under the same two locks, so it carries the exact `seq` that the next op follows. This mirrors `runs_subscribe`.
- **No live run:** the snapshot comes from `store.messages(thread_id)`, with status `ready`.
- **Coalescing:** consecutive `AppendText` deltas for the same index are merged for up to 50 ms before sending, so a stream of tokens becomes a few frames. Order is unchanged and the result is identical.
- **Redaction** runs on every op before it gets a `seq`. It is stateless because every tool part names its own tool, and it keeps part indices, so later `SetPart`/`AppendText` still line up:
  - `fs_read` of a `looks_secret` path: `output` → `"[hidden from guests: secret file]"`.
  - `fs_search`: lines whose `path:` is secret-looking are removed (in addition to the core fix in gap 4).
  - `memory_*`, `chats_search`, `chat_read`: `input` and `output` → `"[private to the host]"`.
  - `shell_run` and every other text output: `scrub_text` masks well-known credential formats (`sk-…`, `sk-ant-…`, `AKIA…`, `ghp_…`/`github_pat_…`, `xox?-…`, `-----BEGIN … PRIVATE KEY-----` blocks, `Bearer …`, JWTs) and `KEY=value` lines whose key matches `is_secret_var`. This reduces exposure but doesn't guarantee it, and the share dialog says so.
  - `file` parts: `sushblob:` URLs are kept. Guests fetch the bytes with `get-blob`, which the host serves only for blob hashes the shared thread references.
  - Never sent at all: `RunConfig` (system prompt, tool specs, expansions), provider credentials, the workspace's absolute path (only its name), anything from other threads.

### 2.5 Versioning

- `v` is the protocol's major version. A host speaking `v` accepts a guest whose `[minV, v]` range includes it. Otherwise it replies `incompatible`, and the guest shows "Update Sush to join this session".
- Additive fields are allowed within a major version. Serde types never use `deny_unknown_fields`, and TS ignores unknown keys.
- An unknown body `type` is ignored. An unknown `intent.kind` gets `reply ok:false, error:"unsupported"`.
- `Op` is part of the protocol. A new `Op` variant needs either a `caps` flag that the host checks before sending it (otherwise it sends a fresh snapshot) or a major bump. A guest that meets an unknown op type sends `resync`.

---

## 3. Intents: permission check → existing code path

### 3.1 Roles

| | Owner (host, local UI only) | Driver (one at a time) | Collaborator | Viewer |
|---|---|---|---|---|
| watch, presence | ✓ | ✓ | ✓ | ✓ |
| get diff / touched files | ✓ | ✓ | ✓ | ✓ |
| browse files | ✓ | if `policy.browseFiles` | if `policy.browseFiles` | if `policy.browseFiles` |
| comment | ✓ | ✓ | ✓ | – |
| steer | ✓ | ✓ (direct) | → suggestion queue | – |
| accept / edit / drop a suggestion | ✓ | ✓ | – | – |
| Send now, stop, resume | ✓ | ✓ | – | – |
| answer approvals | ✓ | per delegation | – | – |
| request control | – | – | ✓ | ✓ |
| undo, unsandboxed/network approvals | ✓ | only if delegated | – | – |
| regenerate, edit a past message, "Always allow", roles, kick, policy, end | ✓ | – | – | – |

**Owner actions never arrive over the network.** The owner acts through the local UI and the existing Tauri commands. `share.rs` rejects any intent that would need the owner role, whoever it claims to come from. So even a compromised relay can never act with more than a driver's rights.

### 3.2 Mapping

Every intent first goes through `policy::authorize(ctx, sender, intent)`. `ctx` holds the sender's role (from host state, keyed by the relay-stamped `userId`), the delegation, the live thread state and the policy. A denial is sent back as `reply ok:false` and, from Phase 2, recorded in the audit log.

| Intent (phase) | Check | Existing code path |
|---|---|---|
| `get-turn-changes` (1) | any member | `turn_changes` body, factored out of `workspaces.rs`; secret paths removed |
| `get-diff {turnId}` (1) | any member; `turnId` belongs to this thread | `turn_diff` body; a `looks_secret` file → `{ path, hidden: true }`; per-file cap 512 KB |
| `get-file {path}` (1) | the path appears in this thread's tool calls, or `policy.browseFiles` | `WorkspaceFs::open(root).read(path)` (cap_std: `..`, absolute paths and symlinks fail); refuse `looks_secret`; 512 KB cap |
| `list-dir {path}` (1) | `policy.browseFiles` | `workspace_tree` body; secret-looking entries shown but not openable |
| `get-blob {sha}` (1) | the sha is referenced by a `file` part in the shared thread | `Store` blob read (as `serve_blob`), 10 MB cap |
| `steer {text}` (2) | driver: direct. collaborator: → queue. viewer: deny | host stamps `metadata.author = { userId, name, image }` (any author the guest sent is overwritten), asks the leader for a config (§3.3), then `run_start(thread, RunAction::Steer{…}, config)`. That joins at the next boundary, or starts a run from the saved thread. |
| `suggestion-accept {id, text?}` (2) | driver | same as `steer`, authored by the collaborator and `acceptedBy` the driver |
| `suggestion-drop {id}` (2) | driver | removes it from the host-held queue → `queue` message |
| `send-now` (2) | driver; something is queued; no Send now in the last 2 s | `run_interrupt(thread_id)` (`Inbox::Interrupt`) |
| `stop` (2) | driver | `Runs::stop` |
| `resume` (2) | driver; the last reply is `paused` | `run_start(RunAction::Resume, config)` |
| `respond {callId, decision, answer?}` (2) | the call is unresolved in `LiveState.messages`; the sender may answer its `ApprovalClass` (§3.4); `decision` is `approve`/`deny` only, and `answer` is allowed only for `ask_user` (validated against the card's options). A guest never sends a raw `ToolResponse`, so it can't make up a tool result. | `run_start(RunAction::Respond{ Approve \| Error{"Denied by <name>"} \| Output{answer} })`, carrying `by: Author` (§3.5) |
| `comment {text, messageId?}` (2) | collaborator or above; ≤ 4 KB | host appends to `share_events` and rebroadcasts. Not in the thread, never sent to the model. |
| `undo {turnId, path?}` (3) | owner, or driver with `delegation.undo` | `undo_turn` body |
| `request-control` (3) | collaborator or viewer | `control` state machine → owner/driver sees "Shruti asks for control" |
| `accept-control-request {userId}` / `pass-control {userId}` (3) | current driver | `control::pass`; the old driver becomes a collaborator; `members` message |
| `release-control` (3) | driver | the driver role goes back to the owner |

Owner-only local commands (Tauri, not intents): `share_set_role`, `share_set_delegation`, `share_kick`, `share_admit`, `share_set_policy`, `share_end`, `share_invite_*`. The owner's own approve, undo and steer keep using the existing commands. The existing `run_start` gains a hook so the owner's local answer goes through the same first-wins claim (§3.5).

### 3.3 Config for runs that guests trigger

When a guest intent needs a run, `share.rs` sends a `share-config { requestId, threadId, actionType }` frame to the leader window only, routed like `client-tool`. The UI answers through `share_config_result` with `runConfig(id, messages)`, or with an error if `budgetBlock` refuses. This reuses the same skills, connectors and budget code, and the spending stays on the owner's account under the owner's limits. If no window is subscribed, the intent fails with "The host's app isn't open". For a shared thread, `runConfig` also applies §3.4.

### 3.4 The approval floor while others can steer

As long as a driver or collaborator holds a role (or a viewer could be handed control), the host applies these rules in `Host::approval` and `runConfig`:

- **Memory and past-chat tools are not offered** to a shared thread (as with incognito), so a steer can't get the model to paste them into its answer. The owner can turn them back on per share.
- **Standing permissions turn into fresh approvals.** These now ask: workspace auto-edits, sandboxed auto shell, connector tools set to "Always allow", and allowed browser sites. Each is decided by the delegation:

| `ApprovalClass` (`policy::classify`) | who may answer | delegable? |
|---|---|---|
| `Edit` (fs_write/edit/move/delete) | owner; driver if `delegation.edits` | ✓ |
| `Shell` (sandboxed, no network) | owner; driver if `delegation.shell` | ✓ |
| `ShellEscalated` (`network`/`unsandboxed`, or no sandbox) | owner; driver if `delegation.escalated` | ✓ (off by default, with a warning) |
| `Connector` (uses the owner's tokens) | owner; driver if `delegation.connectors` | ✓ (off by default) |
| `Browser` | owner; driver if `delegation.browser` | ✓ |
| `SecretRead` (`fs_read` of a `looks_secret` path) | **owner only** | ✗: once the model has read it, a driver could steer it into a file or a command |
| `AskUser` | owner, driver | n/a |

  If the owner delegates edits (and shell), a steer by the driver works like single-player auto-approval again. This is opt-in, per share.
- Read-only workspace tools stay `Auto`.

### 3.5 Conflict rules

- **Approvals, first wins.** In core, `Inbox::Respond` and `RunAction::Respond` gain `by: Option<Author>`. When `resolve()` takes an answer out of `waiting`, it emits `Op::SetMetadata { sushAnswers: { …all so far…, [callId]: { by, decision, at } } }` on the reply. The runner already decides who wins (`waiting.remove`), so the record of who answered comes from the same place and reaches every guest as an op. The card shows "Approved by Shruti". A losing answer gets `reply ok:false, error:"Already answered by Suraj"`. For single-player answers `by` is `None`, so no metadata is written and current behaviour is unchanged.
- **Send now:** one per thread per 2 s on the host. Later ones get "Already sending". `take_interrupt` already ignores an interrupt when nothing is queued.
- **Steers** keep arrival order on the host. Their ids are minted by the host, so a guest can't collide with or replace an existing message.
- **Driver changes** are serialised in `control.rs` (a single owner of the state on the host). Two `pass-control` calls racing each other: the second fails because its sender is no longer the driver.

### 3.6 Audit log (Phase 2)

On the host, in `sush.db`: `share_events(share_id, thread_id, at, actor_user_id, actor_name, kind, detail_json)`. `kind` is one of `joined | left | steered | suggested | accepted | dropped | approved | denied | answered | interrupted | stopped | resumed | undid | control | kicked | denied-intent | ended`. `detail_json` holds ids and short previews (the first 120 characters of a steer). It is stored locally and sent to members in the snapshot and as `audit` messages. The relay never stores it.

---

## 4. Relay: API, auth, invites

The relay lives in `apps/server`, Hono + better-auth. It gets three new tables, created with `CREATE TABLE IF NOT EXISTS` next to better-auth's migrations:

```
share        (id, owner_user_id, title, created_at, expires_at, ended_at, max_guests)
share_invite (id, share_id, token_sha256, role_cap, created_at, expires_at, max_uses, uses, revoked_at)
share_member (share_id, user_id, role_cap, joined_at, kicked_at, admitted)
```

**REST** (`Authorization: Bearer`, resolved with `auth.api.getSession({ headers })`):

| | |
|---|---|
| `POST /api/shares` `{ title, ttlHours ≤ 24 }` | owner creates a share → `{ shareId }` |
| `POST /api/shares/:id/invites` `{ roleCap: "viewer" (P1) \| "collaborator", ttlHours ≤ 72, maxUses ≤ 25 }` | → `{ inviteId, token }`; only `sha256(token)` is stored |
| `GET /api/shares/:id/invites` | list; no tokens |
| `DELETE /api/shares/:id/invites/:inviteId` | revoke: no new redemptions; existing members keep access |
| `POST /api/shares/:id/join` `{ token }` | redeem → member row (`admitted = false`) |
| `DELETE /api/shares/:id/members/:userId` | kick: closes their socket, blocks reconnecting |
| `DELETE /api/shares/:id` | end: closes the room for everyone, all invites dead |
| `GET /api/shares/limits` | gating hook (§7) |

**WS:** `GET /api/shares/:id/ws` with the bearer on the upgrade request. Only the owner or a non-kicked member is accepted. Built on `upgradeWebSocket` from `hono/bun`, with `index.ts` exporting Bun's `websocket` handler.
**Rooms** live in memory, keyed by share id: the host socket, admitted peers and the lobby. Limits: 1 MB per frame; a guest may send at most 10 frames/s with a burst of 30, and the host is not limited. A guest that falls behind (send buffer over 4 MB) is closed with `superseded`; its app reconnects and resyncs. If the host drops, the room stays for 5 minutes and guests see "Host offline". After that the share ends.

**The invite link** is `https://<relay>/join/<shareId>#<token>`. The token sits in the **fragment**, which browsers never send to servers, so it doesn't show up in access logs. In Phase 4 the fragment also carries the encryption key. In Phase 1 the guest pastes the link into "Join shared session…"; registering a `sush://` deep link can come later. The token travels only in the body of `POST …/join`. Hono's `logger()` logs method and path only, and neither Rust nor TS ever prints the link or the token.

**Lifecycle:** created → redeemed (`uses++`) → member waiting in the lobby → host admits (or denies) → admitted. An invite dies when it expires, reaches `maxUses`, is revoked, or the share ends. A member loses access when kicked or when the share ends. **The lobby is on by default**: every first join shows the host "Shruti (shruti@…) wants to watch · Admit / Deny". The owner can turn on "Admit people I've admitted before" for reconnects within the same share.

**The relay account in Phase 1:** the bearer the app already holds (`lib/auth.ts`, in localStorage) is handed to `share_*` commands for each call and kept in memory only for the socket's lifetime. It is never written to disk by Rust (see open question 1 for release).

---

## 5. Threat model

### Malicious guest
| Attack | Handling |
|---|---|
| Pretends to be someone else or claims a higher role | `from` is stamped by the relay. Roles come from host state. Any `author` in a body is overwritten. Owner actions are never accepted from the network. |
| Sends intents beyond its role | `policy::authorize` with deny-by-default, `reply ok:false`, audited. Unknown kinds are rejected. |
| Path traversal or symlink escape via `get-file`/`list-dir` | `WorkspaceFs` (cap_std) is the only file access. Secret paths are refused. Files open only if the thread touched them or the owner allowed browsing. Size caps. |
| Reads secrets through the agent | Approval floor (§3.4): `SecretRead` is owner-only. Memory and past-chat tools are off. Connectors ask. Outputs are redacted. `fs_search` stops returning secret files. |
| Prompt injection through a steer | A driver is trusted to steer by definition. A collaborator's text goes through the queue and needs the driver to accept it. Nothing a steer causes gets past host-side approvals (§3.4). |
| Makes up tool results | Guests send only `approve`/`deny`. `answer` is accepted only for `ask_user`. |
| Answers a stale or unrelated call id | The call must be unresolved in `LiveState`. The runner also drops answers that aren't waiting. |
| Floods steers or Send now | Relay rate limit, host queue cap (20), Send now debounce, budget check via §3.3. |
| Spends the owner's API credit | Budgets are enforced by the host's `budgetBlock` (§3.3). The owner can stop or kick at any time. |
| Malicious name or avatar | Avatars are limited to `data:` URLs (≤ 64 KB, image MIME) and built-in avatar ids, never remote URLs, so the webview never fetches one (no IP or tracking leak). Names are plain text. Comments render with the same markdown pipeline as model output. |

### Compromised relay (Phases 1–3)
| Attack | Handling |
|---|---|
| Reads session content | Until Phase 4 it can, apart from what redaction removes. The share dialog says plainly: "The relay can see this session." The relay is open source and can be self-hosted. TLS (`wss`) in release. |
| Forges a guest's intents | Limited to that guest's role. It can never act as the owner, because owner actions are local only. Phase 4 adds signatures on intents. |
| Forges host frames to guests | Guests may be shown false content. The guest app treats all shared content as untrusted display data: it never runs it, never applies it to the guest's own workspace, and gives it no tools. Phase 4 AEAD fixes the forgery. |
| Replays or reorders | `epoch`/`seq` checks on guests. Duplicate intent ids are ignored on the host. Phase 4 nonces. |
| Drops or delays | Availability only. The run keeps going safely on the host. |

### Leaked link
- On its own a leaked link gets nobody in. Redeeming needs a signed-in account, and the lobby then shows the owner who is knocking.
- Invites expire (default 24 h), have a `maxUses` limit, can be revoked individually, and die when the share ends. Links can only grant viewer (Phase 1) or collaborator. **Driver is never granted by a link**, only in-session by the owner.
- Tokens are 32 random bytes, stored only as SHA-256, never placed in a path or query, and never logged.
- Phase 4: the fragment also carries the content key, so a leaked link that gets through the lobby can read. That is why the lobby stays on by default.

### The host's own machine
Guest data that reaches the host: steer text (sent to the model, like the owner's own messages), comments (rendered, never sent to the model), and names and avatars (above). Guests never reach a host command except through `share.rs`'s intent handler.

---

## 6. Phases: what changes where

### Phase 1: live share, watch only (to build after approval)

**Core (`crates/sush-core`)**
- `src/share/{mod,policy,redact,outbox,replica}.rs` (new) with tests: redaction of each private tool, secret paths and scrubbing; outbox coalescing and seq; replica gap → resync, stale epoch, an unknown op → resync; `authorize` for the five Phase 1 read intents, including traversal and secret refusals.
- `src/lib.rs`: `pub mod share;`
- `src/workspace/mod.rs`: `search` skips `looks_secret` files, plus a test (gap 4, pending open question 4).

**Tauri (`apps/desktop/src-tauri`)**
- `src/share.rs` (new): `Shares` with `host: HashMap<thread_id, HostShare>` (relay task, outbox, roster, lobby, policy) and `guest: HashMap<share_id, GuestReplica>`. Commands, added with the `add-tauri-command` skill:
  - host: `share_start(threadId, auth)`, `share_invite_create(shareId, ttlHours, maxUses)`, `share_invites_list`, `share_invite_revoke`, `share_admit(shareId, userId, allow)`, `share_kick`, `share_set_policy(browseFiles)`, `share_end`
  - guest: `share_join(link, auth) -> threadId`, `share_leave`, `share_request(threadId, intent) -> Reply`
  - both: `shares_state() -> SharesState` (for a page reload, like `runs_subscribe`)
  - It refuses incognito threads (and report threads) in Rust, not only in the UI.
- `src/runs.rs`: one tap, `state.shares.on_frame(&frame)`, inside `Host::emit`'s critical section and in `Runs::send` (for `Saved`, `FilesChanged`). New `RunFrame::Share { threadId, share: ShareView }` for roster, lobby and knocks, sent to every window. The guest re-emits `RunFrame::Op`/`Status`/`ToolRunning` for `shared:<id>` threads. `runs_subscribe` also returns guest replicas as `LiveRun`s.
- `src/workspaces.rs`: factor the bodies of `turn_changes`, `turn_diff`, `workspace_tree` and `workspace_read_file` into plain fns that `share.rs` can call with a thread's workspace.
- `src/state.rs`: `pub shares: crate::share::Shares`. `src/lib.rs`: register the commands; on exit, `share_end` all shares.
- `Cargo.toml`: `tokio-tungstenite` (rustls feature, matching reqwest's TLS).
- **Dev profiles** (debug only): `SUSH_PROFILE=b` adds `-b` to the app data and config dirs. On Windows it also sets `WEBVIEW2_USER_DATA_FOLDER`, so localStorage (and so the signed-in account) is separate. All `app_data_dir()` call sites (`lib.rs`, `whisper.rs`, `workspaces.rs`) move behind one helper. A second instance runs `target/debug/sush.exe` against the first instance's Vite on 1420.

**Desktop UI (`apps/desktop/src`)**
- `lib/tauri.ts`: `ShareView`, `SharesState`, `Intent`, `Reply`, the `share` frame, and the new commands.
- `lib/share.ts` (new): mirrors `share` frames (host shares by thread, guest sessions), `startShare`, `createInvite`, `joinFromLink`, `requestDiff`/`requestFile`, `useShare(threadId)`, `usePresence(threadId)`, `isRemote(id)`. Everything is owned by Rust and arrives as frames in every window, so nothing needs `broadcast`.
- `lib/sessions.ts`: `sendMessage`/`respond`/`regenerate`/`resume`/`stop` do nothing for `isRemote(id)` (read-only in Phase 1). Remote threads never reach `store.ts`, so they're never saved.
- `components/session-actions.tsx`: "Share session…" (hidden for incognito and report threads) → `components/share-dialog.tsx` (new): create and copy a link, "Guests can browse files", lobby (Admit/Deny), members (Remove), invites (Revoke), End share, the relay-visibility notice.
- `components/share-presence.tsx` (new): avatar stack (`UserAvatar`) in the session header next to `WorkspaceChip`, and join/leave toasts (sonner).
- `components/join-session-dialog.tsx` (new), plus a sidebar entry "Join shared session…" and a "Shared with you" group.
- `chat-view.tsx`: for a remote thread, the composer is replaced by a "Watching Suraj's session" bar (with Sushi), and approval cards are inert ("Waiting for Suraj").
- `file-changes.tsx`, `workspace-panel.tsx`: for a remote thread, diffs and the file viewer read through `share_request`. They are read-only, with no Undo and no terminal. The tree appears only if browsing is allowed.
- `docs/design-notes/multiplayer.md` (new), with a dated entry for the share dialog, presence and the guest view.

**Server (`apps/server`)**
- `src/share/{db,routes,relay}.ts` (new); `src/index.ts` mounts the routes and exports `websocket`.

**Config and docs**
- `tauri.conf.json`: no change needed for dev (the relay is the auth server on `localhost:3000`, already allowed). For release, see open question 2.
- `CLAUDE.md`: architecture paragraphs for `share/`, `share.rs` and the relay.

**Done means:** two instances (two machines, or two dev profiles) signed in to the same server. A owns a Cowork session and shares it. B joins through the link and is admitted. B sees the existing transcript and then live streaming, tool cards, status and file changes. B opens a diff. A secret file and a memory tool's output appear redacted on B. Presence and join/leave show on both. Revoke, kick and end take effect at once. A late joiner, a reload of B, and a network drop (resync) all end up identical to A.

### Phase 2: redirect together
- Core: `RunAction::Respond`/`Inbox::Respond` get `by: Option<Author>` and the runner records `sushAnswers` (with tests: first wins, attribution, `None` unchanged). `share/policy.rs`: `ApprovalClass`, `classify`, the approval floor, and Phase 2 intents. `share/audit.rs`.
- `runs.rs`: `Host::approval` applies the floor for shared threads. The `share-config` frame plus `share_config_result`. Steer and respond intents go through `run_start`. `store.rs` migration: `share_events`.
- UI: `lib/agent.ts` (no memory or past-chat tools for shared threads), the guest composer (driver: steer; collaborator: suggest), `components/suggestion-queue.tsx` (accept, edit, drop) above the composer next to the existing queue, author avatars on user messages (`metadata.author`), "Approved by …" on `tool-approval-card.tsx`, a comments rail, and an audit sheet in the share dialog.

### Phase 3: hand off
- Core: `share/control.rs` (request/accept/pass/release state machine and tests). `Inbox::Pause` (finish the current step and its tool calls, then end with `paused`; tests next to the interrupt tests).
- `share.rs`: delegation settings, owner presence (online/away), the "when I leave" policy.
- UI: a "Suraj is driving / You're driving" banner, Take/Pass control, a delegation panel in the share dialog, "Step away".

**When the owner leaves.** Leaving means clicking "Step away", closing the share's session, or the host losing the relay for more than 60 s. Two options:
- **A. Pause safely (default).** The host sends `Inbox::Pause`: the run finishes what it is doing (no half-killed shell command) and stops at the next step boundary, marked `paused`. The driver role goes back to the owner, and delegations are suspended. Guests keep watching and can comment or suggest. Nothing new happens on the owner's machine, keys or credit while nobody is accountable for it.
- **B. Keep going with the driver.** The run continues. The driver keeps only the delegations the owner already granted. Owner-only approvals (secret reads, undo unless delegated, escalated shell) wait as `Awaiting` with an OS notification to the owner. There is an optional cap on unattended time (default 30 min), after which it behaves like A.

  The trade-off: B keeps work moving across time zones, but it lets someone else spend the owner's credit and change the owner's files unwatched. A keeps the guarantee that a person on the host side is always accountable. A is the default, and B is a per-share opt-in that warns when chosen.

**Cross-machine hand-off (design only).** It moves the work, not the run:
1. The owner (or a driver with `delegation.shell`) chooses "Hand off to Shruti". The host commits the session's worktree to its `sush/…` branch (uncommitted changes go into a `wip(sush): handoff` commit) and pushes to the workspace's remote. This is an escalated shell action with network access, so it always needs the owner's approval.
2. The host sends a `handoff` message with the remote URL (no credentials), branch, commit, and a redacted transcript.
3. On the guest's machine, Sush asks them to pick their local clone (folder dialog in Rust, as today), fetches the branch, creates a worktree with `worktree_create`, and opens a new Cowork session seeded with the transcript (like `forkConversation`), with a note that it continues another person's session. It uses the guest's own providers, keys and approvals.
4. Things that don't carry over: undo checkpoints (they stay on the host), connector state and secrets. A non-git workspace can't be handed off, and the menu says so.

### Phase 4: later (design now)
- **End-to-end encryption.** The host generates a 256-bit content key K per share and puts it in the link fragment (`#t=<token>&k=<K>`). Bodies use XChaCha20-Poly1305 with K, with associated data `shareId|epoch|seq|direction`, so a forged, replayed or reordered frame fails to decrypt. Each guest generates an Ed25519 key pair per device and sends its public key inside its first encrypted `hello`. The host binds `userId → pubkey` and requires every intent to be signed. A compromised relay then can't read or forge frames, or forge intents. On kick, the host rotates K and sends K′ to the remaining members (X25519 key agreement with their device keys). This is a protocol major bump to `v: 2`. The relay is unchanged, because it already ignores `body`.
- **Browser viewer.** `apps/viewer` (Vite + React), served by the relay at `/join/:shareId`. It reuses the message rendering by moving `components/ai-elements` and the thread view into a package with no Tauri dependency (`@sush/thread-view`), with `applyOp` moved alongside. Watch and comment only. Sign-in through the relay's better-auth with cookies (same origin). The owner can allow "anyone with the link (named guest)", which still goes through the lobby. It speaks protocol v2, so the decryption key comes from the fragment.
- **Usage counters** (opt-in, set by the host when creating a share and default off). Weekly buckets on the relay: `shares_created`, `guests_per_share` (histogram), `steers_per_share` (histogram, counted from intent-type metadata that the host reports at share end). No user ids in the metrics table, no message content, nothing from bodies. Exposed only as aggregates through `GET /api/metrics/weekly` (admin).
- **Seat and plan hooks.** `GET /api/shares/limits` returns `{ maxGuests, roles: [...], maxTtlHours, e2e }` from a `plan_for(userId)` stub (free: 1 guest, viewer and collaborator; team: 10, all roles). It is enforced at four points: `POST /api/shares` (TTL), `POST …/invites` (role cap), `POST …/join` and `admit` (guest count, enforced by the relay), and `share_set_role` (the host checks the limits it was given and the relay re-checks on `admit`). No billing integration.

---

## 7. Phase 1 test plan (summary; full steps come with the build)

1. `bun run dev:server`, reachable from both instances (`localhost` for two profiles on one machine, or `--hostname 0.0.0.0` plus the LAN IP for two machines, with `VITE_AUTH_URL` and `connect-src` set to that IP).
2. Instance A: `bun run dev:app`. Instance B: `SUSH_PROFILE=b` running `target/debug/sush.exe` on the same machine, or a second machine. Sign up two accounts.
3. In A, open a Cowork session, choose Share session…, create a link and copy it. In B, choose Join shared session… and paste it. In A, click Admit.
4. In A, ask for a multi-step task that reads a `.env` (approve it), searches, edits and runs a command. Check B against the done criteria above.
5. Edge cases: B reloads; C joins mid-stream; B's network drops for 20 s; revoke the invite and try a second redemption; kick B; end the share; an incognito session has no Share entry, and `share_start` refuses one through devtools.
6. Then `/check` (cargo tests incl. `share::*`, typecheck, desktop build).

---

## 8. Open questions for you

1. **A hosted relay for release.** Release builds use a local auth sidecar, so there's no shared account system. Options: (a) release builds sign in to a hosted Sush server for everything (accounts move off the device, with the sidecar kept for offline or self-host); (b) keep local accounts and add a separate "Sharing account" sign-in that only multiplayer uses; (c) a relay URL in Settings, so teams self-host. I recommend **(c) with a default hosted URL**, and storing that account's token in the OS keyring through Rust rather than localStorage. Who runs the hosted relay, and on what domain?
2. **CSP.** Because the socket lives in Rust (§1), I'd add no `ws(s)` origin to `connect-src`, only the hosted relay's `https` origin to the release CSP once open question 1 is settled. Your brief asked for the `ws/wss` origin to be added; is the Rust-side socket acceptable instead?
3. **Should guests keep a copy after a share ends?** I propose no for Phase 1 (the replica is in memory only, like incognito), and later a "Let guests save a copy" option for the owner.
4. **May the `fs_search`-skips-secret-files fix also change single-player behaviour?** I think it should, since it's a hole in the existing approval gate.
5. **Lobby on by default** for every new joiner?
6. **Approval floor (§3.4):** while others can steer, auto-edits, sandboxed auto shell, "Always allow" connectors and allowed sites all ask again unless delegated. Is that UX cost acceptable?
7. **Memory and past-chat tools off in shared sessions** by default?
8. **Scope of Phase 1:** plain Chat sessions as well as Cowork? They're a subset with no workspace, so I'd include them. Report threads: not shareable, OK?
9. **Guest attachments in steers (Phase 2):** text only at first, or images too? Images mean the host stores guest blobs, with type and size checks.
10. **Dev profiles on macOS:** WKWebView storage follows the bundle id, so `SUSH_PROFILE` gives separate localStorage only on Windows (via `WEBVIEW2_USER_DATA_FOLDER`). On macOS, two machines or two OS users are needed. Is that acceptable for testing?
11. **Defaults:** share TTL 12 h (max 24), invite TTL 24 h (max 72), max uses 10, max guests 10 in dev. Any changes?
