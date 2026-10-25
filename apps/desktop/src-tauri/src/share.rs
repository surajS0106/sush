//! Live shared sessions ("Sush Multiplayer"): others watch, and redirect.
//!
//! The host is authoritative. The run, the workspace and every credential stay
//! here; guests get the thread as the same ops the UI applies, redacted
//! (`sush_core::share::redact`), and send intents, which are checked against
//! their role and what the session shows (`sush_core::share::policy`) before
//! the host carries them out through its own code: reads through its file
//! access, and a driver's messages, approvals, stops and resumes through
//! `runs.rs` like the owner's. A run a guest starts needs a config only the UI
//! can build, so the leader window is asked for one (`share-config` frame).
//! A collaborator's message waits as a suggestion for the driver or the owner.
//! Everything a guest does goes in the audit log (`share_events`).
//!
//! While anyone but the owner can steer, the owner's standing permissions ask
//! again (`Shares::steerable`, used by `runs.rs`' `Host::approval`). Answers
//! are first-wins (`HostShare::claim`), the owner's own included.
//!
//! Control changes hands on the host, one change at a time
//! (`sush_core::share::control`): a guest asks, the driver or the owner
//! accepts, the driver passes it on or gives it back, the owner takes it back.
//! When the owner steps away, the share's away policy decides: by default the
//! run pauses at its next step boundary (`Inbox::Pause`) and the owner drives
//! again; or the driver keeps going for a set time, then it pauses.
//!
//! Everything goes through a relay (`apps/server`, `/api/shares`): a room per
//! share that forwards messages without reading them. Both ends of the socket
//! are here, in Rust, so the relay account's token goes in a header and never
//! reaches the webview, and nothing the webview does can open a share.
//!
//! - Host: every frame a run sends passes `Shares::on_frame` (from `runs.rs`,
//!   under the channels lock, so it sees them in order). Frames for a shared
//!   thread or its sub-agents' threads go into the share's outbox; a flush task
//!   numbers them and sends them to everyone admitted. A guest's hello gets a
//!   snapshot taken under the same lock, so it lines up with the next op.
//! - Guest: messages from the host go into a replica, and each change goes to
//!   every window as an ordinary run frame for `shared:<share id>` (and
//!   `shared:<share id>:<call>` for sub-agents), so the UI applies it as it does
//!   any run's. The thread is never saved.
//!
//! Share state reaches every window as `share` frames.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sush_core::agent::ui::{self, new_id};
use sush_core::agent::{Op, RunAction, RunConfig, RunStatus, ToolResponse};
use sush_core::share::audit::{self, Kind};
use sush_core::share::control::{self, Actor, AwayMode, ControlRequest};
use sush_core::share::crypto::{self, Device, DeviceKeys, Direction, Seen, ShareKey};
use sush_core::share::outbox::{self, Event, Outbox};
use sush_core::share::policy::{Allowed, ApprovalClass};
use sush_core::share::replica::{Applied, Change, Replica};
use sush_core::share::{
    self as proto, policy, Author, Body, Comment, Decision, GuestMsg, HostMsg, Image, Intent, Member, Role, Room, SharePolicy, Suggestion,
    ThreadInfo, ThreadKind, ThreadState, TurnFiles,
};
use sush_core::store::ThreadMeta;
use sush_core::workspace::{looks_secret, WorkspaceFs};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::runs::{self, RunFrame};
use crate::state::AppState;
use crate::store::blocking;
use crate::{secrets, workspaces};

/// Attachments guests can fetch, at most.
const MAX_BLOB: usize = 10 * 1024 * 1024;
/// Attachments a guest keeps in memory for the webview, at most.
const BLOB_CACHE: usize = 64 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Text deltas arriving within this long go out as one message.
const FLUSH_DELAY: Duration = Duration::from_millis(40);
/// How long the leader window has to build a run's config for a guest.
const CONFIG_TIMEOUT: Duration = Duration::from_secs(20);
/// Suggestions waiting at once, at most.
const MAX_SUGGESTIONS: usize = 20;
/// Comments a share keeps, at most.
const MAX_COMMENTS: usize = proto::replica::MAX_COMMENTS;
/// One "Send now" per share in this long.
const SEND_NOW_GAP: Duration = Duration::from_secs(2);
/// The tool results the UI's cards give for a denial and a dismissed question
/// (`DENIED` in `tool-parts.tsx`, `DISMISSED` there too), so a guest's answer reads the same.
const DENIED: &str = "The user denied this tool call.";
const DISMISSED: &str = "The user dismissed the questions without answering. Continue with your best judgement.";

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// A picture others may be shown: a `data:` image or a built-in avatar, never a URL to fetch.
fn safe_image(image: Option<String>) -> Option<String> {
    image.filter(|i| {
        (i.starts_with("sush:avatar/") && i.len() < 64)
            || (["data:image/png;", "data:image/jpeg;", "data:image/webp;", "data:image/gif;"].iter().any(|p| i.starts_with(p)) && i.len() <= 64 * 1024)
    })
}

// --- the relay account --------------------------------------------------------------

/// The relay this app shares through, and its session token. Kept in the OS keyring.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    relay_url: String,
    token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayUser {
    pub id: String,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub image: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareAccount {
    relay_url: Option<String>,
    /// None when not signed in, or the session expired.
    user: Option<RelayUser>,
    /// Why the relay couldn't be asked.
    error: Option<String>,
}

fn load_account() -> AppResult<Option<Account>> {
    Ok(secrets::share_account_get()?.and_then(|s| serde_json::from_str(&s).ok()))
}

fn account() -> AppResult<Account> {
    load_account()?.ok_or_else(|| AppError::Invalid("Set up sharing first: Settings → Sharing.".into()))
}

/// `http(s)://host[:port]` of what the user typed.
fn relay_origin(input: &str) -> AppResult<String> {
    let bad = || AppError::Invalid("Enter the relay's address, like http://192.168.1.20:3000.".into());
    let url = url::Url::parse(input.trim()).map_err(|_| bad())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(bad());
    }
    Ok(url.origin().ascii_serialization())
}

fn net(e: reqwest::Error) -> AppError {
    AppError::Invalid(format!("Couldn't reach the relay: {e}"))
}

/// A relay response's JSON, or its error message.
async fn relay_json(resp: reqwest::Response) -> AppResult<Value> {
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    let message = ["error", "message"]
        .iter()
        .find_map(|k| body.get(k).and_then(Value::as_str))
        .map_or_else(|| format!("The relay answered {status}."), str::to_owned);
    Err(AppError::Invalid(message))
}

async fn relay_user(http: &reqwest::Client, account: &Account) -> AppResult<Option<RelayUser>> {
    let resp = http.get(format!("{}/api/auth/get-session", account.relay_url)).bearer_auth(&account.token).send().await.map_err(net)?;
    let body = relay_json(resp).await?;
    Ok(body.get("user").cloned().and_then(|u| serde_json::from_value(u).ok()))
}

async fn account_view(http: &reqwest::Client) -> AppResult<ShareAccount> {
    let Some(account) = load_account()? else { return Ok(ShareAccount { relay_url: None, user: None, error: None }) };
    Ok(match relay_user(http, &account).await {
        Ok(user) => ShareAccount { relay_url: Some(account.relay_url), user, error: None },
        Err(e) => ShareAccount { relay_url: Some(account.relay_url), user: None, error: Some(e.to_string()) },
    })
}

#[tauri::command]
pub async fn share_account(state: State<'_, AppState>) -> AppResult<ShareAccount> {
    account_view(&state.http).await
}

/// Sign in to a relay (or, with `name`, create an account on it).
#[tauri::command]
pub async fn share_account_sign_in(
    state: State<'_, AppState>,
    relay_url: String,
    email: String,
    password: String,
    name: Option<String>,
) -> AppResult<ShareAccount> {
    let relay = relay_origin(&relay_url)?;
    let (path, body) = match name.filter(|n| !n.trim().is_empty()) {
        Some(name) => ("sign-up/email", json!({ "email": email.trim(), "password": password, "name": name.trim() })),
        None => ("sign-in/email", json!({ "email": email.trim(), "password": password })),
    };
    let resp = state.http.post(format!("{relay}/api/auth/{path}")).json(&body).send().await.map_err(net)?;
    let header = resp.headers().get("set-auth-token").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let body = relay_json(resp).await?;
    let token = header
        .or_else(|| body.get("token").and_then(Value::as_str).map(str::to_owned))
        .ok_or_else(|| AppError::Invalid("The relay didn't start a session.".into()))?;
    secrets::share_account_set(&serde_json::to_string(&Account { relay_url: relay, token })?)?;
    account_view(&state.http).await
}

/// Share through the server this app already signs in to, with that session.
#[tauri::command]
pub async fn share_account_use_token(state: State<'_, AppState>, relay_url: String, token: String) -> AppResult<ShareAccount> {
    let account = Account { relay_url: relay_origin(&relay_url)?, token };
    let user = relay_user(&state.http, &account)
        .await?
        .ok_or_else(|| AppError::Invalid("That session has expired. Sign in again.".into()))?;
    secrets::share_account_set(&serde_json::to_string(&account)?)?;
    Ok(ShareAccount { relay_url: Some(account.relay_url), user: Some(user), error: None })
}

#[tauri::command]
pub async fn share_account_sign_out(state: State<'_, AppState>) -> AppResult<()> {
    if let Some(account) = load_account()? {
        // The token is forgotten here even if the relay can't be told.
        let _ = state.http.post(format!("{}/api/auth/sign-out", account.relay_url)).bearer_auth(&account.token).json(&json!({})).send().await;
    }
    secrets::share_account_delete()
}

// --- relay frames -------------------------------------------------------------------

/// Someone connected to a share's room, as the relay vouches for them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    peer_id: String,
    user_id: String,
    name: String,
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    is_host: bool,
    /// Only for someone knocking, so the host knows who it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    /// What a guest's invite allows ("viewer" or "collaborator"): their role when they first join.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    role_cap: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
enum RelayIn {
    Welcome {
        /// This connection, as the relay knows it.
        #[serde(default)]
        you: Option<Peer>,
        #[serde(default)]
        peers: Vec<Peer>,
        #[serde(default)]
        lobby: Vec<Peer>,
        #[serde(default)]
        host_online: bool,
        #[serde(default)]
        admitted: bool,
    },
    Recv { from: Peer, body: String },
    Knock { peer: Peer },
    PeerJoined { peer: Peer },
    PeerLeft { peer_id: String },
    Admitted,
    HostOnline,
    HostOffline,
    Closed { reason: String },
    Error { code: String },
}

fn relay_send(to: &str, body: &str) -> String {
    json!({ "t": "send", "to": to, "body": body }).to_string()
}

fn closed_reason(reason: &str) -> String {
    match reason {
        "ended" => "The host ended the session.",
        "expired" => "The session reached its time limit.",
        "kicked" => "The host removed you from the session.",
        "denied" => "The host didn't let you in.",
        "superseded" => "This session was opened somewhere else.",
        _ => "The session closed.",
    }
    .into()
}

enum ConnectError {
    /// The relay said no (signed out, not a member, share over): don't retry.
    Refused(String),
    Failed(String),
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(account: &Account, share_id: &str) -> Result<Socket, ConnectError> {
    let ws = account.relay_url.replacen("http", "ws", 1);
    let mut request = format!("{ws}/api/shares/{share_id}/ws").into_client_request().map_err(|e| ConnectError::Failed(e.to_string()))?;
    let auth = HeaderValue::from_str(&format!("Bearer {}", account.token)).map_err(|_| ConnectError::Refused("Sign in to sharing again.".into()))?;
    request.headers_mut().insert("Authorization", auth);
    match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _)) => Ok(socket),
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
            let message = match resp.status().as_u16() {
                401 => "Your sharing session expired. Sign in again in Settings → Sharing.",
                403 => "You aren't in this session any more.",
                410 => "This shared session has ended.",
                _ => return Err(ConnectError::Failed(format!("The relay answered {}.", resp.status()))),
            };
            Err(ConnectError::Refused(message.into()))
        }
        Err(e) => Err(ConnectError::Failed(format!("Couldn't reach the relay: {e}"))),
    }
}

// --- what the UI sees ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkStatus {
    Connecting,
    Live,
    /// A guest waiting for the host to let them in.
    Lobby,
    Offline,
    Ended,
}

/// A share, hosted here (`role: owner`) or joined.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareView {
    thread_id: String,
    share_id: String,
    role: Role,
    status: LinkStatus,
    thread: ThreadInfo,
    members: Vec<Member>,
    /// People waiting for the host to let them in (the host's view only).
    lobby: Vec<Peer>,
    policy: SharePolicy,
    expires_at: i64,
    ended: Option<String>,
    error: Option<String>,
    /// This app's user on the relay.
    me: Option<String>,
    suggestions: Vec<Suggestion>,
    comments: Vec<Comment>,
    /// The latest entries of the audit log, oldest first.
    audit: Vec<audit::Entry>,
    /// People asking for control, oldest first.
    requests: Vec<ControlRequest>,
    /// Since when the owner is away, if they are.
    owner_away: Option<i64>,
    /// Whether the relay sees only ciphertext.
    e2e: bool,
    /// What the relay's plan lets the owner do (the host's view; guests see the defaults).
    limits: Limits,
}

/// A joined share's threads, for a page that reloads.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedThread {
    thread_id: String,
    messages: Vec<Value>,
    status: RunStatus,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharesState {
    shares: Vec<ShareView>,
    threads: Vec<SharedThread>,
    running: Vec<String>,
}

fn emit_view(app: &AppHandle, share: ShareView) {
    app.state::<AppState>().runs.send(RunFrame::Share { share });
}

// --- the shares ---------------------------------------------------------------------

/// Shares hosted here (by thread) and joined (by the thread they show as).
/// Lock order: the runs' channels, then `hosts`, then a share's own locks:
/// `outbox`, then `e2e`, then `inner`. A share's `outbox` may be held while
/// taking its `inner` (`HostShare::append`, snapshots) or its `e2e` (sealing),
/// never the other way round.
#[derive(Default)]
pub struct Shares {
    hosts: Mutex<HashMap<String, Arc<HostShare>>>,
    guests: Mutex<HashMap<String, Arc<GuestShare>>>,
    /// Configs asked of the leader window for runs guests start, by request id.
    configs: Mutex<HashMap<String, oneshot::Sender<Result<RunConfig, String>>>>,
}

pub(crate) struct HostShare {
    share_id: String,
    thread_id: String,
    account: Account,
    expires_at: i64,
    /// The owner, as guests see them.
    owner: Author,
    /// Tool calls someone answered, with who did: the first answer wins.
    claimed: Mutex<HashMap<String, String>>,
    last_send_now: Mutex<Option<Instant>>,
    outbox: Mutex<Outbox>,
    flush: Notify,
    /// A turn changed files: guests get the new list with the next flush.
    files_dirty: AtomicBool,
    out: mpsc::UnboundedSender<String>,
    inner: Mutex<HostInner>,
    /// End-to-end encryption, if the share uses it: the relay then forwards only ciphertext.
    e2e: Option<Mutex<HostE2e>>,
    /// Whether the owner agreed to report anonymous counts to the relay when the share ends.
    metrics: bool,
    /// Messages guests sent into the run (steers and accepted suggestions), for those counts.
    steers: std::sync::atomic::AtomicU32,
    /// What the relay's plan allows this owner (`GET /api/shares/limits`).
    limits: Limits,
    cancel: CancellationToken,
}

/// A share's keys and its guests' devices (`sush_core::share::crypto`).
struct HostE2e {
    /// Every key so far, the current one last. The link carries the first.
    keys: Vec<ShareKey>,
    /// Each guest connection's device keys, by peer id, with its user id. A
    /// reload is a new connection with a new device, often before the old one
    /// has left, so devices are bound per connection, never per person.
    devices: HashMap<String, (String, DeviceKeys)>,
    seen: Seen,
}

impl HostE2e {
    fn key_for(&self, generation: u32) -> Option<[u8; 32]> {
        self.keys.iter().find(|k| k.generation == generation).map(|k| k.key)
    }
}

/// What the relay's plan lets an owner do (`apps/server/src/share/plans.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Limits {
    #[serde(default = "Limits::default_guests")]
    max_guests: u32,
    /// Roles guests may have: `viewer`, `collaborator`, `driver`.
    #[serde(default = "Limits::default_roles")]
    roles: Vec<Role>,
}

impl Limits {
    fn default_guests() -> u32 {
        10
    }
    fn default_roles() -> Vec<Role> {
        vec![Role::Viewer, Role::Collaborator, Role::Driver]
    }
    fn allows(&self, role: Role) -> bool {
        self.roles.contains(&role)
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_guests: Self::default_guests(), roles: Self::default_roles() }
    }
}

struct HostInner {
    info: ThreadInfo,
    status: LinkStatus,
    /// Guests connected now, by peer id.
    peers: HashMap<String, Peer>,
    /// Everyone admitted during this share, by user id.
    members: BTreeMap<String, Member>,
    lobby: Vec<Peer>,
    policy: SharePolicy,
    /// Tool calls in flight, for a snapshot.
    running: HashSet<String>,
    suggestions: Vec<Suggestion>,
    comments: Vec<Comment>,
    /// The latest audit entries; all of them are in the store.
    audit: Vec<audit::Entry>,
    requests: Vec<ControlRequest>,
    /// Since when the owner is away, if they are.
    away: Option<i64>,
    /// Ends a driver's time alone with the run (`AwayMode::KeepGoing`).
    away_timer: Option<CancellationToken>,
    ended: Option<String>,
    error: Option<String>,
}

impl HostShare {
    fn view(&self) -> ShareView {
        let i = self.inner.lock().unwrap();
        ShareView {
            thread_id: self.thread_id.clone(),
            share_id: self.share_id.clone(),
            role: Role::Owner,
            status: i.status,
            thread: i.info.clone(),
            members: i.members.values().cloned().collect(),
            lobby: i.lobby.clone(),
            policy: i.policy.clone(),
            expires_at: self.expires_at,
            ended: i.ended.clone(),
            error: i.error.clone(),
            me: Some(self.owner.user_id.clone()),
            suggestions: i.suggestions.clone(),
            comments: i.comments.clone(),
            audit: i.audit.clone(),
            requests: i.requests.clone(),
            owner_away: i.away,
            e2e: self.e2e.is_some(),
            limits: self.limits.clone(),
        }
    }

    fn room(&self) -> Room {
        let i = self.inner.lock().unwrap();
        Room {
            members: i.members.values().cloned().collect(),
            policy: i.policy.clone(),
            suggestions: i.suggestions.clone(),
            comments: i.comments.clone(),
            audit: i.audit.clone(),
            requests: i.requests.clone(),
            owner_away: i.away,
        }
    }

    /// Whether anyone but the owner can steer the run: then standing permissions ask again.
    fn steerable(&self) -> bool {
        let i = self.inner.lock().unwrap();
        i.status != LinkStatus::Ended && i.members.values().any(|m| matches!(m.role, Role::Driver | Role::Collaborator))
    }

    /// Take the right to answer a tool call; whoever comes second is told who was first.
    fn claim(&self, call_id: &str, name: &str) -> Result<(), String> {
        let mut claimed = self.claimed.lock().unwrap();
        if let Some(first) = claimed.get(call_id) {
            return Err(format!("Already answered by {first}."));
        }
        claimed.insert(call_id.to_string(), name.to_string());
        Ok(())
    }

    /// The answer didn't go through after all.
    fn release(&self, call_id: &str) {
        self.claimed.lock().unwrap().remove(call_id);
    }

    /// Note what someone did: in the store, in the share's log, and for guests.
    fn record(&self, app: &AppHandle, actor: &Author, kind: Kind, detail: Value) {
        let entry = audit::Entry { at: now_ms(), actor_user_id: actor.user_id.clone(), actor_name: actor.name.clone(), kind, detail };
        self.append(|i| audit::push(&mut i.audit, entry.clone()), Event::Audit { entry: entry.clone() });
        let store = app.state::<AppState>().store.clone();
        let (share_id, thread_id) = (self.share_id.clone(), self.thread_id.clone());
        tauri::async_runtime::spawn(async move {
            let id = share_id.clone();
            if let Err(e) = blocking(move || Ok(store.add_share_event(&id, &thread_id, &entry)?)).await {
                eprintln!("sush: couldn't keep an audit entry for share {share_id}: {e}");
            }
        });
        emit_view(app, self.view());
    }

    /// Tell guests (and the owner's windows) which suggestions wait now.
    fn queue_changed(&self, app: &AppHandle) {
        let suggestions = self.inner.lock().unwrap().suggestions.clone();
        self.push(Event::Queue { suggestions });
        emit_view(app, self.view());
    }

    /// What the relay may count when the share ends, if the owner agreed: how
    /// many messages guests sent into the run. Never content, never who.
    fn end_stats(&self) -> Value {
        if self.metrics {
            json!({ "steers": self.steers.load(Ordering::Relaxed) })
        } else {
            json!({})
        }
    }

    /// A message as it goes on the wire: sealed with the current key in an encrypted share.
    fn wire(&self, msg: HostMsg) -> String {
        let text = Body::encode(msg);
        match &self.e2e {
            Some(e2e) => {
                let e2e = e2e.lock().unwrap();
                crypto::seal(e2e.keys.last().expect("a share has a key"), &self.share_id, Direction::ToGuests, &text)
            }
            None => text,
        }
    }

    fn send_to(&self, peer_id: &str, msg: HostMsg) {
        let _ = self.out.send(relay_send(peer_id, &self.wire(msg)));
    }

    /// Number what's waiting and send it, holding the outbox so nothing overtakes it.
    fn flush_now(&self) {
        let mut outbox = self.outbox.lock().unwrap();
        for msg in outbox.flush() {
            let _ = self.out.send(relay_send("all", &self.wire(msg)));
        }
    }

    /// Give one guest's connection the current key, sealed for its device, if
    /// it's past the one their link carries. The outer layer uses the link's
    /// key, which every member has; only their device can open what's inside.
    fn send_current_key(&self, peer_id: &str) {
        let Some(e2e) = &self.e2e else { return };
        let e2e = e2e.lock().unwrap();
        let current = e2e.keys.last().expect("a share has a key");
        if current.generation == 1 {
            return;
        }
        let Some((_, device)) = e2e.devices.get(peer_id) else { return };
        let Ok(sealed) = crypto::seal_for(&device.kx_pub, &self.share_id, current) else { return };
        let msg = Body::encode(HostMsg::Rekey { generation: current.generation, sealed });
        let _ = self.out.send(relay_send(peer_id, &crypto::seal(&e2e.keys[0], &self.share_id, Direction::ToGuests, &msg)));
    }

    /// Someone was removed: a new key for everyone else, sealed for each of
    /// their devices, so what follows is unreadable to the one removed even if
    /// a compromised relay kept forwarding to them.
    fn rekey(&self) {
        let Some(e2e) = &self.e2e else { return };
        // The outbox is held so nothing goes out under the old key once the new one is sent.
        let mut outbox = self.outbox.lock().unwrap();
        for msg in outbox.flush() {
            let _ = self.out.send(relay_send("all", &self.wire(msg)));
        }
        let peers: Vec<String> = self.inner.lock().unwrap().peers.keys().cloned().collect();
        {
            let mut e2e = e2e.lock().unwrap();
            let next = ShareKey::generate(e2e.keys.last().map_or(1, |k| k.generation + 1));
            e2e.keys.push(next);
        }
        drop(outbox);
        for peer_id in peers {
            self.send_current_key(&peer_id);
        }
    }

    /// A guest's message as the host reads it: opened and its signature checked
    /// in an encrypted share (with the device bound on its first `hello`).
    fn read_guest(&self, from: &Peer, body: &str) -> Option<String> {
        let Some(e2e) = &self.e2e else { return Some(body.to_string()) };
        // Plain text where ciphertext belongs: not from a member's app.
        let (_, nonce) = crypto::header(body)?;
        let mut e2e = e2e.lock().unwrap();
        if !e2e.seen.first(&format!("{}:{nonce}", from.user_id)) {
            return None;
        }
        let signed = crypto::open(|g| e2e.key_for(g), &self.share_id, Direction::ToHost, body).ok()?;
        let text = crypto::unsigned_text(&signed)?;
        // A hello brings the device keys that sign everything after it.
        if let Ok(GuestMsg::Hello { device: Some(device), .. }) = proto::decode::<GuestMsg>(&text) {
            let message = crypto::verify(&device.sign_pub, &signed).ok()?;
            // A connection keeps the device it first said hello with.
            if let Some((user, keys)) = e2e.devices.get(&from.peer_id) {
                if user != &from.user_id || keys != &device {
                    return None;
                }
            }
            e2e.devices.insert(from.peer_id.clone(), (from.user_id.clone(), device));
            return Some(message);
        }
        let (user, device) = e2e.devices.get(&from.peer_id)?;
        if user != &from.user_id {
            return None;
        }
        crypto::verify(&device.sign_pub, &signed).ok()
    }

    fn push(&self, event: Event) {
        self.outbox.lock().unwrap().push(event);
        self.flush.notify_one();
    }

    /// Add to the share's state and tell guests as one step. Guests apply an
    /// append on top of what they have, so a snapshot must hold it exactly when
    /// the message falls before it: the outbox is held throughout (then the
    /// share's state, the only place the two are held together; a snapshot reads its room the same way).
    fn append(&self, change: impl FnOnce(&mut HostInner), event: Event) {
        let mut outbox = self.outbox.lock().unwrap();
        change(&mut self.inner.lock().unwrap());
        outbox.push(event);
        drop(outbox);
        self.flush.notify_one();
    }

    /// Tell guests who's in the share now, who asks for control, and whether the owner is away.
    fn members_changed(&self) {
        let event = {
            let i = self.inner.lock().unwrap();
            Event::Members { members: i.members.values().cloned().collect(), policy: i.policy.clone(), requests: i.requests.clone(), owner_away: i.away }
        };
        self.push(event);
    }

    /// Change who drives. Everyone hears of it, it goes in the log, and the
    /// run looks again at the calls it holds: the floor may no longer apply.
    fn change_control(&self, app: &AppHandle, actor: &Actor, change: control::Change) -> Result<(), String> {
        let what = match &change {
            control::Change::Request => "requested",
            control::Change::Accept { .. } => "accepted",
            control::Change::Decline { .. } => "declined",
            control::Change::Pass { .. } => "passed",
            control::Change::Release => "released",
            control::Change::Take => "took",
        };
        let target = match &change {
            control::Change::Accept { user_id } | control::Change::Decline { user_id } | control::Change::Pass { user_id } => Some(user_id.clone()),
            _ => None,
        };
        if matches!(change, control::Change::Accept { .. } | control::Change::Pass { .. }) && !self.limits.allows(Role::Driver) {
            return Err("The relay's plan for this account doesn't let guests drive.".into());
        }
        let (outcome, author, target_name) = {
            let mut i = self.inner.lock().unwrap();
            let HostInner { members, requests, .. } = &mut *i;
            let outcome = control::apply(members, requests, actor, change, now_ms())?;
            let author = match actor {
                Actor::Owner => self.owner.clone(),
                Actor::Member(id) => i.members.get(id).map(Member::author).unwrap_or_else(|| self.owner.clone()),
            };
            let target_name = target.as_ref().and_then(|id| i.members.get(id)).map(|m| m.name.clone());
            (outcome, author, target_name)
        };
        self.members_changed();
        let detail = json!({ "action": what, "userId": target, "name": target_name, "driver": outcome.driver_after });
        self.record(app, &author, Kind::Control, detail);
        if outcome.moved() {
            app.state::<AppState>().runs.recheck_family(&self.thread_id);
        }
        Ok(())
    }
}

pub(crate) struct GuestShare {
    share_id: String,
    thread_id: String,
    account: Account,
    expires_at: i64,
    out: mpsc::UnboundedSender<String>,
    inner: Mutex<GuestInner>,
    replies: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    /// Attachments fetched from the host for the webview, never written to disk.
    blobs: Mutex<HashMap<String, (String, Vec<u8>)>>,
    /// In an encrypted share: the keys so far (from the link, then rekeys) and this join's device.
    e2e: Option<Mutex<GuestE2e>>,
    cancel: CancellationToken,
}

struct GuestE2e {
    keys: Vec<ShareKey>,
    device: Device,
}

struct GuestInner {
    replica: Replica,
    info: ThreadInfo,
    host_user: Option<String>,
    /// This app's user on the relay, from its welcome.
    me: Option<String>,
    status: LinkStatus,
    host_online: bool,
    admitted: bool,
    ended: Option<String>,
    error: Option<String>,
}

impl GuestShare {
    fn view(&self) -> ShareView {
        let i = self.inner.lock().unwrap();
        let host = Member {
            user_id: i.host_user.clone().unwrap_or_else(|| "host".into()),
            name: i.info.host_name.clone(),
            image: None,
            role: Role::Owner,
            online: i.host_online,
        };
        // As the host says; only what the host lets this guest do counts there anyway.
        let role = i
            .me
            .as_ref()
            .and_then(|me| i.replica.members.iter().find(|m| &m.user_id == me))
            .map_or(Role::Viewer, |m| if m.role == Role::Owner { Role::Viewer } else { m.role });
        ShareView {
            thread_id: self.thread_id.clone(),
            share_id: self.share_id.clone(),
            role,
            status: i.status,
            thread: i.info.clone(),
            members: std::iter::once(host).chain(i.replica.members.iter().cloned()).collect(),
            lobby: Vec::new(),
            policy: i.replica.policy.clone(),
            expires_at: self.expires_at,
            ended: i.ended.clone(),
            error: i.error.clone(),
            me: i.me.clone(),
            suggestions: i.replica.suggestions.clone(),
            comments: i.replica.comments.clone(),
            audit: i.replica.audit.clone(),
            requests: i.replica.requests.clone(),
            owner_away: i.replica.owner_away,
            e2e: self.e2e.is_some(),
            limits: Limits::default(),
        }
    }

    fn send_host(&self, msg: GuestMsg) {
        let text = Body::encode(msg);
        let body = match &self.e2e {
            // Signed by this join's device, then sealed with the newest key.
            Some(e2e) => {
                let e2e = e2e.lock().unwrap();
                crypto::seal(e2e.keys.last().expect("a share has a key"), &self.share_id, Direction::ToHost, &e2e.device.sign(&text))
            }
            None => text,
        };
        let _ = self.out.send(relay_send("host", &body));
    }

    /// A body from the host as the guest reads it: opened in an encrypted share
    /// (anything not sealed with one of its keys is dropped).
    fn read_host(&self, body: &str) -> Option<String> {
        let Some(e2e) = &self.e2e else { return Some(body.to_string()) };
        let e2e = e2e.lock().unwrap();
        crypto::open(|g| e2e.keys.iter().find(|k| k.generation == g).map(|k| k.key), &self.share_id, Direction::ToGuests, body).ok()
    }

    /// A new key the host sealed for this device.
    fn take_key(&self, generation: u32, sealed: &str) {
        let Some(e2e) = &self.e2e else { return };
        let mut e2e = e2e.lock().unwrap();
        if e2e.keys.iter().any(|k| k.generation == generation) {
            return;
        }
        if let Ok(key) = e2e.device.open_sealed(&self.share_id, generation, sealed) {
            e2e.keys.push(key);
            e2e.keys.sort_by_key(|k| k.generation);
        }
    }

    /// The hello this guest sends: with its device keys in an encrypted share.
    fn hello(&self) -> GuestMsg {
        let device = self.e2e.as_ref().map(|e2e| e2e.lock().unwrap().device.keys());
        GuestMsg::Hello { min_v: proto::MIN_VERSION, caps: Vec::new(), device }
    }

    async fn request(&self, intent: Intent) -> Result<Value, String> {
        let id = new_id();
        let (tx, rx) = oneshot::channel();
        self.replies.lock().unwrap().insert(id.clone(), tx);
        self.send_host(GuestMsg::Intent { id: id.clone(), intent });
        let answer = tokio::time::timeout(REQUEST_TIMEOUT, rx).await;
        self.replies.lock().unwrap().remove(&id);
        match answer {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The session closed.".into()),
            Err(_) => Err("The host didn't answer.".into()),
        }
    }
}

impl Shares {
    /// A frame a run (or `runs.rs`) sent, while the runs' channels are locked.
    /// Never sends frames itself: that would take the same lock again.
    pub(crate) fn on_frame(&self, frame: &RunFrame) {
        let thread_id = match frame {
            RunFrame::Op { thread_id, .. }
            | RunFrame::Status { thread_id, .. }
            | RunFrame::ToolRunning { thread_id, .. }
            | RunFrame::FilesChanged { thread_id, .. } => thread_id.as_str(),
            RunFrame::Saved { thread } => thread.id.as_str(),
            _ => return,
        };
        let Some((share, child)) = self.share_for(thread_id) else { return };
        let event = match frame {
            RunFrame::Op { op, .. } => Event::Op { child, op: op.clone() },
            RunFrame::Status { status, error, .. } => Event::Status { child, status: *status, error: error.clone() },
            RunFrame::ToolRunning { call_id, running, .. } => {
                {
                    let mut i = share.inner.lock().unwrap();
                    if *running {
                        i.running.insert(call_id.clone());
                    } else {
                        i.running.remove(call_id);
                    }
                }
                Event::ToolRunning { call_id: call_id.clone(), running: *running }
            }
            RunFrame::FilesChanged { .. } => {
                share.files_dirty.store(true, Ordering::SeqCst);
                share.flush.notify_one();
                return;
            }
            RunFrame::Saved { thread } => {
                if child.is_some() {
                    return;
                }
                let info = {
                    let mut i = share.inner.lock().unwrap();
                    if i.info.title == thread.title {
                        return;
                    }
                    i.info.title = thread.title.clone();
                    i.info.clone()
                };
                Event::Thread { thread: info }
            }
            _ => return,
        };
        share.push(event);
    }

    /// The share hosting a thread: the session itself (`None`), or one of its
    /// sub-agents' threads, `<session>:<call>` (`Some(call)`).
    fn share_for(&self, thread_id: &str) -> Option<(Arc<HostShare>, Option<String>)> {
        let hosts = self.hosts.lock().unwrap();
        if hosts.is_empty() {
            return None;
        }
        let found = match hosts.get(thread_id) {
            Some(share) => Some((share.clone(), None)),
            None => thread_id.split_once(':').and_then(|(parent, call)| hosts.get(parent).map(|s| (s.clone(), Some(call.to_string())))),
        };
        found
    }

    /// Whether others can steer this thread's session: its run's standing
    /// permissions (auto edits, sandboxed commands, allowed connectors and
    /// sites) then ask again (`Host::approval`).
    pub(crate) fn steerable(&self, thread_id: &str) -> bool {
        self.share_for(thread_id).is_some_and(|(share, _)| share.steerable())
    }

    /// The owner answers a call in their own app. In a shared session the
    /// first answer wins, so it may be too late; returns who to credit.
    pub(crate) fn claim_local(&self, thread_id: &str, call_id: &str) -> AppResult<Option<Author>> {
        let Some((share, _)) = self.share_for(thread_id) else { return Ok(None) };
        share.claim(call_id, &share.owner.name).map_err(AppError::Invalid)?;
        Ok(Some(share.owner.clone()))
    }

    /// The owner's answer didn't reach the run.
    pub(crate) fn release_local(&self, thread_id: &str, call_id: &str) {
        if let Some((share, _)) = self.share_for(thread_id) {
            share.release(call_id);
        }
    }

    fn host(&self, thread_id: &str) -> AppResult<Arc<HostShare>> {
        self.hosts.lock().unwrap().get(thread_id).cloned().ok_or_else(|| AppError::NotFound("This session isn't shared.".into()))
    }

    fn guest(&self, thread_id: &str) -> AppResult<Arc<GuestShare>> {
        self.guests.lock().unwrap().get(thread_id).cloned().ok_or_else(|| AppError::NotFound("You're no longer in that session.".into()))
    }

    /// Stop sharing a thread (it's being deleted): guests are disconnected and the relay told.
    pub(crate) fn end_host(&self, app: &AppHandle, thread_id: &str) {
        let Some(share) = self.hosts.lock().unwrap().remove(thread_id) else { return };
        share.cancel.cancel();
        let http = app.state::<AppState>().http.clone();
        tauri::async_runtime::spawn(async move {
            let url = format!("{}/api/shares/{}", share.account.relay_url, share.share_id);
            let _ = http.delete(url).bearer_auth(&share.account.token).json(&share.end_stats()).send().await;
        });
        app.state::<AppState>().runs.send(RunFrame::ShareGone { thread_id: thread_id.to_string() });
    }

    /// An attachment a joined share shows, fetched from its host (`store::serve_blob` asks when it doesn't have it).
    pub(crate) async fn fetch_blob(&self, sha: &str) -> Option<(String, Vec<u8>)> {
        let guests: Vec<Arc<GuestShare>> = self.guests.lock().unwrap().values().cloned().collect();
        for guest in guests {
            if let Some(hit) = guest.blobs.lock().unwrap().get(sha).cloned() {
                return Some(hit);
            }
            let shows = guest.inner.lock().unwrap().replica.threads.values().any(|t| outbox::blob_shas(&t.messages).contains(sha));
            if !shows {
                continue;
            }
            let Ok(data) = guest.request(Intent::GetBlob { sha: sha.to_string() }).await else { continue };
            let media_type = data.get("mediaType").and_then(Value::as_str).unwrap_or_default();
            // Only what the transcript shows inline; nothing a page could run.
            let media_type = match media_type {
                "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf" => media_type.to_string(),
                _ => "application/octet-stream".to_string(),
            };
            let bytes = data
                .get("data")
                .and_then(Value::as_str)
                .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())?;
            let mut cache = guest.blobs.lock().unwrap();
            if cache.values().map(|(_, b)| b.len()).sum::<usize>() + bytes.len() > BLOB_CACHE {
                cache.clear();
            }
            cache.insert(sha.to_string(), (media_type.clone(), bytes.clone()));
            return Some((media_type, bytes));
        }
        None
    }
}

// --- hosting ------------------------------------------------------------------------

/// What the relay's plan lets this account do. A relay from before plans existed allows what it always did.
async fn fetch_limits(http: &reqwest::Client, account: &Account) -> Limits {
    let resp = http.get(format!("{}/api/shares/limits", account.relay_url)).bearer_auth(&account.token).send().await;
    match resp {
        Ok(resp) if resp.status().is_success() => resp.json().await.unwrap_or_default(),
        _ => Limits::default(),
    }
}

/// Start sharing a session. Incognito sessions, reports and sub-agents' threads can't be shared.
/// `e2e` (on unless turned off): the relay forwards only ciphertext. `metrics`: report
/// anonymous counts (guests, messages; never content) to the relay when the share ends.
#[tauri::command]
pub async fn share_start(
    app: AppHandle,
    state: State<'_, AppState>,
    thread: ThreadMeta,
    e2e: Option<bool>,
    metrics: Option<bool>,
) -> AppResult<ShareView> {
    if thread.incognito {
        return Err(AppError::Invalid("Incognito sessions can't be shared.".into()));
    }
    if thread.parent_id.is_some() || proto::is_guest_thread(&thread.id) {
        return Err(AppError::Invalid("This session can't be shared.".into()));
    }
    if let Some(share) = state.runs.shares.hosts.lock().unwrap().get(&thread.id) {
        return Ok(share.view());
    }
    let account = account()?;
    let store = state.store.clone();
    let (id, claimed) = (thread.id.clone(), thread.workspace_id.clone());
    let (report, workspace) = blocking(move || {
        let workspace = match store.thread_workspace(&id)?.or(claimed) {
            Some(w) => store.workspace(&w)?,
            None => None,
        };
        Ok((store.report_for_thread(&id)?, workspace))
    })
    .await?;
    if report.is_some() {
        return Err(AppError::Invalid("Reports can't be shared.".into()));
    }
    let me = relay_user(&state.http, &account)
        .await?
        .ok_or_else(|| AppError::Invalid("Your sharing session expired. Sign in again in Settings → Sharing.".into()))?;

    let resp = state
        .http
        .post(format!("{}/api/shares", account.relay_url))
        .bearer_auth(&account.token)
        .json(&json!({ "title": thread.title, "metrics": metrics.unwrap_or(false), "e2e": e2e.unwrap_or(true) }))
        .send()
        .await
        .map_err(net)?;
    let created = relay_json(resp).await?;
    let limits = fetch_limits(&state.http, &account).await;
    let share_id = created.get("shareId").and_then(Value::as_str).ok_or_else(|| AppError::Invalid("The relay didn't start the share.".into()))?;
    let expires_at = created.get("expiresAt").and_then(Value::as_i64).unwrap_or_default();

    let host_name = if me.name.trim().is_empty() { me.email.split('@').next().unwrap_or_default().to_string() } else { me.name.clone() };
    let (out, rx) = mpsc::unbounded_channel();
    let share = Arc::new(HostShare {
        share_id: share_id.to_string(),
        thread_id: thread.id.clone(),
        account,
        expires_at,
        owner: Author { user_id: me.id.clone(), name: host_name.clone(), image: safe_image(me.image.clone()) },
        claimed: Mutex::default(),
        last_send_now: Mutex::default(),
        outbox: Mutex::new(Outbox::new(1)),
        flush: Notify::new(),
        files_dirty: AtomicBool::new(false),
        out,
        inner: Mutex::new(HostInner {
            info: ThreadInfo {
                title: thread.title.clone(),
                kind: if workspace.is_some() { ThreadKind::Cowork } else { ThreadKind::Chat },
                workspace_name: workspace.map(|w| w.name),
                host_name,
            },
            status: LinkStatus::Connecting,
            peers: HashMap::new(),
            members: BTreeMap::new(),
            lobby: Vec::new(),
            policy: SharePolicy::default(),
            running: HashSet::new(),
            suggestions: Vec::new(),
            comments: Vec::new(),
            audit: Vec::new(),
            requests: Vec::new(),
            away: None,
            away_timer: None,
            ended: None,
            error: None,
        }),
        e2e: e2e
            .unwrap_or(true)
            .then(|| Mutex::new(HostE2e { keys: vec![ShareKey::generate(1)], devices: HashMap::new(), seen: Seen::default() })),
        metrics: metrics.unwrap_or(false),
        steers: Default::default(),
        limits,
        cancel: CancellationToken::new(),
    });
    state.runs.shares.hosts.lock().unwrap().insert(thread.id.clone(), share.clone());
    tauri::async_runtime::spawn(flush_loop(app.clone(), share.clone()));
    tauri::async_runtime::spawn(host_loop(app.clone(), share.clone(), rx));
    let view = share.view();
    emit_view(&app, view.clone());
    Ok(view)
}

/// What a share's guests may know of the turns that changed files.
async fn visible_turns(app: &AppHandle, thread_id: &str) -> Vec<TurnFiles> {
    let store = app.state::<AppState>().store.clone();
    let id = thread_id.to_string();
    blocking(move || Ok(store.turn_changes(&id)?))
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|t| TurnFiles { turn_id: t.turn_id, paths: t.paths.into_iter().filter(|p| !looks_secret(p)).collect() })
        .filter(|t| !t.paths.is_empty())
        .collect()
}

async fn flush_loop(app: AppHandle, share: Arc<HostShare>) {
    loop {
        tokio::select! {
            _ = share.cancel.cancelled() => return,
            _ = share.flush.notified() => {}
        }
        // Let more of a streamed reply arrive, so it goes out in fewer messages.
        tokio::time::sleep(FLUSH_DELAY).await;
        if share.files_dirty.swap(false, Ordering::SeqCst) {
            let turns = visible_turns(&app, &share.thread_id).await;
            share.outbox.lock().unwrap().push(Event::FilesChanged { turns });
        }
        share.flush_now();
    }
}

async fn host_loop(app: AppHandle, share: Arc<HostShare>, mut rx: mpsc::UnboundedReceiver<String>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect(&share.account, &share.share_id).await {
            Ok(socket) => {
                backoff = Duration::from_secs(1);
                let (mut sink, mut stream) = socket.split();
                let mut ping = tokio::time::interval(Duration::from_secs(25));
                let ended = loop {
                    tokio::select! {
                        _ = share.cancel.cancelled() => {
                            let _ = sink.close().await;
                            return;
                        }
                        out = rx.recv() => match out {
                            Some(text) => if sink.send(Message::text(text)).await.is_err() { break false },
                            None => return,
                        },
                        msg = stream.next() => match msg {
                            Some(Ok(Message::Text(text))) => if on_host_frame(&app, &share, text.as_str()) { break true },
                            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break false,
                            Some(Ok(_)) => {}
                        },
                        _ = ping.tick() => {
                            let _ = sink.send(Message::text(json!({ "t": "ping" }).to_string())).await;
                        }
                    }
                };
                if ended {
                    return;
                }
                // Guests start over from a snapshot once the host is back.
                share.outbox.lock().unwrap().next_epoch();
                set_host_status(&app, &share, LinkStatus::Offline, Some("Reconnecting to the relay…".into()));
            }
            Err(ConnectError::Refused(message)) => {
                finish_host(&app, &share, message);
                return;
            }
            Err(ConnectError::Failed(message)) => set_host_status(&app, &share, LinkStatus::Offline, Some(message)),
        }
        // What's sent meanwhile is dropped: guests take a snapshot once back.
        let wait = tokio::time::sleep(backoff);
        tokio::pin!(wait);
        loop {
            tokio::select! {
                _ = share.cancel.cancelled() => return,
                _ = &mut wait => break,
                out = rx.recv() => if out.is_none() { return },
            }
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

fn set_host_status(app: &AppHandle, share: &HostShare, status: LinkStatus, error: Option<String>) {
    {
        let mut i = share.inner.lock().unwrap();
        i.status = status;
        i.error = error;
        for m in i.members.values_mut() {
            m.online = false;
        }
        i.peers.clear();
    }
    emit_view(app, share.view());
}

/// The share is over (ended here, by the relay, or refused): it stops and leaves the list.
fn finish_host(app: &AppHandle, share: &Arc<HostShare>, reason: String) {
    {
        let mut i = share.inner.lock().unwrap();
        i.status = LinkStatus::Ended;
        i.ended = Some(reason);
    }
    let state = app.state::<AppState>();
    let mut hosts = state.runs.shares.hosts.lock().unwrap();
    if hosts.get(&share.thread_id).is_some_and(|s| Arc::ptr_eq(s, share)) {
        hosts.remove(&share.thread_id);
    }
    drop(hosts);
    share.cancel.cancel();
    // Nobody else can steer now: calls held only for the share start.
    state.runs.recheck_family(&share.thread_id);
    emit_view(app, share.view());
}

/// Someone connected: a member from now on, first with the role their invite allows
/// (the owner can change it; driving is only ever handed over in the session).
fn upsert_member(members: &mut BTreeMap<String, Member>, peer: &Peer) {
    let member = members.entry(peer.user_id.clone()).or_insert_with(|| Member {
        user_id: peer.user_id.clone(),
        name: peer.name.clone(),
        image: None,
        role: if peer.role_cap.as_deref() == Some("collaborator") { Role::Collaborator } else { Role::Viewer },
        online: true,
    });
    member.name = peer.name.clone();
    member.image = safe_image(peer.image.clone());
    member.online = true;
}

fn peer_author(peer: &Peer) -> Author {
    Author { user_id: peer.user_id.clone(), name: peer.name.clone(), image: safe_image(peer.image.clone()) }
}

/// A frame from the relay; returns true once the share is over.
fn on_host_frame(app: &AppHandle, share: &Arc<HostShare>, text: &str) -> bool {
    let Ok(frame) = serde_json::from_str::<RelayIn>(text) else { return false };
    match frame {
        RelayIn::Welcome { peers, lobby, .. } => {
            let mut i = share.inner.lock().unwrap();
            i.status = LinkStatus::Live;
            i.error = None;
            i.peers = peers.into_iter().filter(|p| !p.is_host).map(|p| (p.peer_id.clone(), p)).collect();
            let online: Vec<Peer> = i.peers.values().cloned().collect();
            for p in &online {
                upsert_member(&mut i.members, p);
            }
            i.lobby = lobby;
        }
        RelayIn::Knock { peer } => {
            let mut i = share.inner.lock().unwrap();
            if !i.lobby.iter().any(|p| p.peer_id == peer.peer_id) {
                i.lobby.push(peer);
            }
        }
        RelayIn::PeerJoined { peer } => {
            let first = {
                let mut i = share.inner.lock().unwrap();
                i.lobby.retain(|p| p.user_id != peer.user_id);
                let first = !i.members.get(&peer.user_id).is_some_and(|m| m.online);
                upsert_member(&mut i.members, &peer);
                i.peers.insert(peer.peer_id.clone(), peer.clone());
                first
            };
            share.members_changed();
            if first {
                share.record(app, &peer_author(&peer), Kind::Joined, json!({}));
            }
        }
        RelayIn::PeerLeft { peer_id } => {
            if let Some(e2e) = &share.e2e {
                e2e.lock().unwrap().devices.remove(&peer_id);
            }
            let left = {
                let mut i = share.inner.lock().unwrap();
                i.lobby.retain(|p| p.peer_id != peer_id);
                match i.peers.remove(&peer_id) {
                    Some(gone) => {
                        let still = i.peers.values().any(|p| p.user_id == gone.user_id);
                        if let Some(m) = i.members.get_mut(&gone.user_id) {
                            m.online = still;
                        }
                        (!still).then_some(gone)
                    }
                    None => None,
                }
            };
            share.members_changed();
            if let Some(gone) = left {
                share.record(app, &peer_author(&gone), Kind::Left, json!({}));
            }
        }
        RelayIn::Recv { from, body } => {
            on_guest_message(app, share, from, &body);
            return false;
        }
        RelayIn::Closed { reason } => {
            finish_host(app, share, closed_reason(&reason));
            return true;
        }
        RelayIn::Error { code } if code == "full" => {
            share.inner.lock().unwrap().error = Some("The session is full, so nobody else can join.".into());
        }
        _ => return false,
    }
    emit_view(app, share.view());
    false
}

fn on_guest_message(app: &AppHandle, share: &Arc<HostShare>, from: Peer, body: &str) {
    // The relay only passes on admitted guests; the host checks its own list too.
    if from.is_host || !share.inner.lock().unwrap().members.contains_key(&from.user_id) {
        return;
    }
    // In an encrypted share, anything that isn't sealed and signed by the sender's device is dropped.
    let Some(body) = share.read_guest(&from, body) else { return };
    match proto::decode::<GuestMsg>(&body) {
        Ok(GuestMsg::Hello { min_v, .. }) if min_v > proto::PROTOCOL_VERSION => {
            share.send_to(&from.peer_id, HostMsg::Incompatible { host_v: proto::PROTOCOL_VERSION, min_v: proto::MIN_VERSION });
        }
        Ok(GuestMsg::Hello { .. } | GuestMsg::Resync { .. }) => {
            // Past a rekey, the guest needs the current key before the snapshot sealed with it.
            share.send_current_key(&from.peer_id);
            tauri::async_runtime::spawn(send_snapshot(app.clone(), share.clone(), from.peer_id));
        }
        Ok(GuestMsg::Intent { id, intent }) => {
            let (app, share) = (app.clone(), share.clone());
            tauri::async_runtime::spawn(async move {
                let reply = match handle_intent(&app, &share, &from, intent).await {
                    Ok(data) => HostMsg::Reply { re: id, ok: true, data: Some(data), error: None },
                    Err(error) => HostMsg::Reply { re: id, ok: false, data: None, error: Some(error) },
                };
                share.send_to(&from.peer_id, reply);
            });
        }
        Err(e) if e.starts_with("Protocol version") => {
            share.send_to(&from.peer_id, HostMsg::Incompatible { host_v: proto::PROTOCOL_VERSION, min_v: proto::MIN_VERSION });
        }
        // Something this version doesn't know; whoever sent it waits for an answer that won't come.
        Err(_) => {}
    }
}

/// Send one guest everything as it stands, lined up with the next op.
async fn send_snapshot(app: AppHandle, share: Arc<HostShare>, peer_id: String) {
    let state = app.state::<AppState>();
    let store = state.store.clone();
    let id = share.thread_id.clone();
    // As saved, for threads with no run going; read before taking the runs' lock.
    let Ok((saved, children)) = blocking(move || Ok((store.messages(&id)?, store.children(&id)?))).await else { return };
    let turns = visible_turns(&app, &share.thread_id).await;
    let info = share.inner.lock().unwrap().info.clone();
    let prefix = format!("{}:", share.thread_id);
    let thread_id = share.thread_id.clone();
    state.runs.with_family(&thread_id, move |live| {
        let running: Vec<String> = share.inner.lock().unwrap().running.iter().cloned().collect();
        let state_of = |id: &str, child: Option<String>, saved: Vec<Value>| match live.iter().find(|t| t.thread_id == id) {
            Some(t) => ThreadState { child, messages: t.messages.clone(), status: t.status, error: t.error.clone() },
            None => ThreadState { child, messages: saved, status: RunStatus::Ready, error: None },
        };
        let mut threads = vec![state_of(&share.thread_id, None, saved)];
        let mut seen = HashSet::new();
        for c in children {
            let Some(call) = c.meta.id.strip_prefix(&prefix).map(str::to_owned) else { continue };
            seen.insert(c.meta.id.clone());
            threads.push(state_of(&c.meta.id, Some(call), c.messages));
        }
        for t in &live {
            if seen.contains(&t.thread_id) {
                continue;
            }
            if let Some(call) = t.thread_id.strip_prefix(&prefix) {
                threads.push(ThreadState { child: Some(call.to_string()), messages: t.messages.clone(), status: t.status, error: t.error.clone() });
            }
        }
        // Flushed first: what's pending is already in `threads`. The room is
        // read while the outbox is held, so it matches the messages before it (`HostShare::append`).
        let mut outbox = share.outbox.lock().unwrap();
        for msg in outbox.flush() {
            let _ = share.out.send(relay_send("all", &share.wire(msg)));
        }
        let room = share.room();
        let snapshot = outbox.snapshot(info, threads, running, turns, room);
        let _ = share.out.send(relay_send(&peer_id, &share.wire(snapshot)));
    });
}

/// An intent's name, for the audit log.
fn intent_kind(intent: &Intent) -> &'static str {
    match intent {
        Intent::GetTurnChanges => "get-turn-changes",
        Intent::GetDiff { .. } => "get-diff",
        Intent::GetFile { .. } => "get-file",
        Intent::ListDir { .. } => "list-dir",
        Intent::GetBlob { .. } => "get-blob",
        Intent::Steer { .. } => "steer",
        Intent::SuggestionAccept { .. } => "suggestion-accept",
        Intent::SuggestionDrop { .. } => "suggestion-drop",
        Intent::SendNow => "send-now",
        Intent::Stop => "stop",
        Intent::Resume => "resume",
        Intent::Respond { .. } => "respond",
        Intent::Comment { .. } => "comment",
        Intent::RequestControl => "request-control",
        Intent::AcceptControl { .. } => "accept-control",
        Intent::DeclineControl { .. } => "decline-control",
        Intent::PassControl { .. } => "pass-control",
        Intent::ReleaseControl => "release-control",
        Intent::Undo { .. } => "undo",
    }
}

/// Check a guest's request against their role and what the session shows, then carry it out.
async fn handle_intent(app: &AppHandle, share: &HostShare, from: &Peer, intent: Intent) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let (member, policy_now, suggestions, running) = {
        let i = share.inner.lock().unwrap();
        let suggestions: HashSet<String> = i.suggestions.iter().map(|s| s.id.clone()).collect();
        (i.members.get(&from.user_id).cloned(), i.policy.clone(), suggestions, i.running.clone())
    };
    let store = state.store.clone();
    let id = share.thread_id.clone();
    let (saved, children, workspace, turns) = blocking(move || {
        let workspace = match store.thread_workspace(&id)? {
            Some(w) => store.workspace(&w)?,
            None => None,
        };
        Ok((store.messages(&id)?, store.children(&id)?, workspace, store.turn_changes(&id)?))
    })
    .await
    .map_err(|e| e.to_string())?;
    // What the session shows now: each thread's live copy while its run goes, else as saved.
    let live = state.runs.with_family(&share.thread_id, |live| live);
    let prefix = format!("{}:", share.thread_id);
    let current = |id: &str, saved: Vec<Value>| match live.iter().find(|t| t.thread_id == id) {
        Some(t) => (t.messages.clone(), t.status),
        None => (saved, RunStatus::Ready),
    };
    let mut threads: Vec<(Option<String>, Vec<Value>, RunStatus)> = Vec::new();
    let (messages, status) = current(&share.thread_id, saved);
    threads.push((None, messages, status));
    for c in children {
        let Some(call) = c.meta.id.strip_prefix(&prefix).map(str::to_owned) else { continue };
        let (messages, status) = current(&c.meta.id, c.messages);
        threads.push((Some(call), messages, status));
    }
    for t in &live {
        let Some(call) = t.thread_id.strip_prefix(&prefix) else { continue };
        if !threads.iter().any(|(child, ..)| child.as_deref() == Some(call)) {
            threads.push((Some(call.to_string()), t.messages.clone(), t.status));
        }
    }
    let all: Vec<Value> = threads.iter().flat_map(|(_, m, _)| m.iter().cloned()).collect();
    let touched = outbox::touched_paths(&all);
    let blobs = outbox::blob_shas(&all);
    let turn_ids: HashSet<String> = turns.iter().map(|t| t.turn_id.clone()).collect();
    // Calls waiting for an answer (not ones already running), with who may give it.
    let sandbox = state.sandbox.status().await;
    let contained = sandbox.available && sandbox.network_blocked;
    let mut waiting = HashMap::new();
    for (child, messages, _) in &threads {
        for (_, call) in ui::unresolved_calls(messages) {
            if !running.contains(&call.id) {
                let class = policy::classify(&call.name, &call.input, contained);
                waiting.insert((child.clone(), call.id), class);
            }
        }
    }
    let (session, status) = (&threads[0].1, threads[0].2);
    let idle = matches!(status, RunStatus::Ready | RunStatus::Error);
    let resumable = idle
        && session.last().is_some_and(|m| {
            ui::role(m) == Some("user") || m.get("metadata").and_then(|meta| meta.get("paused")).and_then(Value::as_bool) == Some(true)
        });
    let ctx = policy::Ctx {
        role: member.as_ref().map(|m| m.role),
        policy: &policy_now,
        cowork: workspace.is_some(),
        touched: &touched,
        turns: &turn_ids,
        blobs: &blobs,
        waiting: &waiting,
        resumable,
        suggestions: &suggestions,
    };
    let kind = intent_kind(&intent);
    let allowed = match policy::authorize(&ctx, intent) {
        Ok(allowed) => allowed,
        Err(error) => {
            if let Some(m) = &member {
                share.record(app, &m.author(), Kind::DeniedIntent, json!({ "intent": kind, "error": error }));
            }
            return Err(error);
        }
    };
    // `authorize` refuses anyone who isn't a member.
    let Some(author) = member.map(|m| m.author()) else { return Err("You're no longer in this session.".into()) };
    let intent = match allowed {
        Allowed::Suggest { text, images } => return suggest(app, share, &author, text, images).await,
        Allowed::Do(intent) => intent,
    };

    let root = workspace.map(|w| w.root);
    let open = move || -> AppResult<WorkspaceFs> {
        let root = root.ok_or_else(|| AppError::Invalid("This session has no folder.".into()))?;
        WorkspaceFs::open(Path::new(&root)).map_err(AppError::Invalid)
    };
    let store = state.store.clone();
    let thread_id = share.thread_id.clone();
    let failed = |e: AppError| e.to_string();
    match intent {
        Intent::GetTurnChanges => Ok(json!(visible_turns(app, &share.thread_id).await)),
        Intent::GetDiff { turn_id } => blocking(move || {
            let diffs = workspaces::turn_diff_files(&store, &thread_id, &turn_id)?;
            Ok(json!(diffs.into_iter().map(workspaces::FileDiff::hidden_if_secret).collect::<Vec<_>>()))
        })
        .await
        .map_err(failed),
        Intent::GetFile { path } => blocking(move || Ok(json!(workspaces::file_view(&open()?, &path)?))).await.map_err(failed),
        Intent::ListDir { path } => blocking(move || {
            let fs = open()?;
            let rel = fs.rel(&path).map_err(AppError::Invalid)?;
            Ok(json!(fs.list(&rel).map_err(AppError::Invalid)?))
        })
        .await
        .map_err(failed),
        Intent::GetBlob { sha } => blocking(move || {
            let (media_type, bytes) = store.blob(&sha)?.ok_or_else(|| AppError::NotFound("That file is no longer stored.".into()))?;
            if bytes.len() > MAX_BLOB {
                return Err(AppError::Invalid("That file is too big to share.".into()));
            }
            Ok(json!({ "mediaType": media_type, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }))
        })
        .await
        .map_err(failed),
        Intent::Steer { text, images } => {
            let files = store_images(app, images).await?;
            let message_id = steer(app, share, user_message(&text, files, &author, None), None).await?;
            share.steers.fetch_add(1, Ordering::Relaxed);
            share.record(app, &author, Kind::Steered, json!({ "messageId": message_id, "preview": audit::preview(&text) }));
            Ok(json!({ "messageId": message_id }))
        }
        Intent::SuggestionAccept { id, text } => accept(app, share, &id, text, &author, None).await,
        Intent::SuggestionDrop { id } => drop_suggestion(app, share, &id, &author).map(|()| Value::Null),
        Intent::SendNow => {
            {
                let mut last = share.last_send_now.lock().unwrap();
                if last.is_some_and(|t| t.elapsed() < SEND_NOW_GAP) {
                    return Err("Already sending.".into());
                }
                *last = Some(Instant::now());
            }
            state.runs.interrupt(&thread_id);
            share.record(app, &author, Kind::Interrupted, json!({}));
            Ok(Value::Null)
        }
        Intent::Stop => {
            state.runs.stop_with_agents(&thread_id).await;
            share.record(app, &author, Kind::Stopped, json!({}));
            Ok(Value::Null)
        }
        Intent::Resume => {
            start_with_config(app, &thread_id, RunAction::Resume, None).await?;
            share.record(app, &author, Kind::Resumed, json!({}));
            Ok(Value::Null)
        }
        Intent::Respond { child, call_id, decision, answer } => {
            let class = waiting.get(&(child.clone(), call_id.clone())).copied().unwrap_or(ApprovalClass::OwnerOnly);
            respond(app, share, &author, child, call_id, class, decision, answer).await
        }
        Intent::Comment { text, message_id } => Ok(comment(app, share, &author, &text, message_id)),
        Intent::RequestControl => control_intent(app, share, &author, control::Change::Request),
        Intent::AcceptControl { user_id } => control_intent(app, share, &author, control::Change::Accept { user_id }),
        Intent::DeclineControl { user_id } => control_intent(app, share, &author, control::Change::Decline { user_id }),
        Intent::PassControl { user_id } => control_intent(app, share, &author, control::Change::Pass { user_id }),
        Intent::ReleaseControl => control_intent(app, share, &author, control::Change::Release),
        Intent::Undo { turn_id, path } => {
            let result = undo(app, &thread_id, &turn_id, path.as_deref()).await.map_err(failed)?;
            share.record(app, &author, Kind::Undid, json!({ "turnId": turn_id, "path": path, "restored": result.restored.len() }));
            Ok(json!(result))
        }
    }
}

fn control_intent(app: &AppHandle, share: &HostShare, author: &Author, change: control::Change) -> Result<Value, String> {
    share.change_control(app, &Actor::Member(author.user_id.clone()), change)?;
    Ok(Value::Null)
}

/// Put back a turn's files, as the owner's own Undo does (`workspaces::undo_turn`),
/// and tell every window the files changed.
async fn undo(app: &AppHandle, thread_id: &str, turn_id: &str, path: Option<&str>) -> AppResult<workspaces::UndoResult> {
    let state = app.state::<AppState>();
    state.runs.stop(thread_id).await;
    let (store, id, turn, only) = (state.store.clone(), thread_id.to_string(), turn_id.to_string(), path.map(str::to_owned));
    let workspace = {
        let (store, id) = (store.clone(), id.clone());
        blocking(move || Ok(store.thread_workspace(&id)?)).await?
    };
    let result = blocking(move || workspaces::restore_since(&store, &id, &turn, only.as_deref())).await?;
    if let Some(workspace_id) = workspace {
        state.runs.send(RunFrame::FilesChanged { thread_id: thread_id.to_string(), workspace_id });
    }
    Ok(result)
}

/// Ask the leader window for the config a run of this thread gets, built as
/// for the owner's own actions (`runConfig` in `sessions.ts`, where budgets
/// apply too). `action`: what the run is for (`steer`, `respond`, `resume`).
async fn request_config(app: &AppHandle, thread_id: &str, action: &str) -> Result<RunConfig, String> {
    let state = app.state::<AppState>();
    if !state.runs.has_windows() {
        return Err("The host's app isn't open.".into());
    }
    let request_id = new_id();
    let (tx, rx) = oneshot::channel();
    state.runs.shares.configs.lock().unwrap().insert(request_id.clone(), tx);
    state.runs.send(RunFrame::ShareConfig { request_id: request_id.clone(), thread_id: thread_id.to_string(), action: action.to_string() });
    let answer = tokio::time::timeout(CONFIG_TIMEOUT, rx).await;
    state.runs.shares.configs.lock().unwrap().remove(&request_id);
    match answer {
        Ok(Ok(config)) => config,
        _ => Err("The host's app didn't answer.".into()),
    }
}

/// The UI's answer to a `share-config` frame: the config, or why there is none (a budget, no model).
#[tauri::command]
pub fn share_config_result(state: State<'_, AppState>, request_id: String, config: Option<RunConfig>, error: Option<String>) -> AppResult<()> {
    let Some(reply) = state.runs.shares.configs.lock().unwrap().remove(&request_id) else { return Ok(()) };
    let _ = reply.send(match (config, error) {
        (_, Some(error)) => Err(error),
        (Some(config), None) => Ok(config),
        (None, None) => Err("The host's app couldn't start a run.".into()),
    });
    Ok(())
}

/// A thread's metadata: its live run's copy, or as saved.
async fn thread_meta(app: &AppHandle, thread_id: &str) -> Result<ThreadMeta, String> {
    let state = app.state::<AppState>();
    if let Some(meta) = state.runs.live_meta(thread_id) {
        return Ok(meta);
    }
    let (store, id) = (state.store.clone(), thread_id.to_string());
    blocking(move || Ok(store.thread_meta(&id)?))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This session is gone.".into())
}

/// Whether bytes start the way an image of this type does.
fn looks_like(media_type: &str, bytes: &[u8]) -> bool {
    match media_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

/// A guest's images, checked (type, size, and that the bytes are that kind of
/// image) and stored as blobs: the file parts of their message.
async fn store_images(app: &AppHandle, images: Vec<Image>) -> Result<Vec<Value>, String> {
    if images.is_empty() {
        return Ok(Vec::new());
    }
    let store = app.state::<AppState>().store.clone();
    blocking(move || {
        images
            .into_iter()
            .map(|image| {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(image.data.as_bytes())
                    .map_err(|_| AppError::Invalid("An image couldn't be read.".into()))?;
                if bytes.len() > policy::MAX_IMAGE_BYTES || !looks_like(&image.media_type, &bytes) {
                    return Err(AppError::Invalid("An image is too big, or isn't the kind of image it says.".into()));
                }
                let url = store.put_blob(&image.media_type, &bytes)?;
                let mut part = json!({ "type": "file", "mediaType": image.media_type, "url": url });
                if let Some(name) = image.filename {
                    part["filename"] = json!(name.chars().filter(|c| !c.is_control()).take(120).collect::<String>());
                }
                Ok(part)
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// A message someone in the share wrote, credited to them. It's built here, so
/// whatever author a guest might claim never counts.
fn user_message(text: &str, files: Vec<Value>, author: &Author, accepted_by: Option<&Author>) -> Value {
    let mut parts = files;
    if !text.trim().is_empty() {
        parts.push(json!({ "type": "text", "text": text }));
    }
    let mut metadata = json!({ "author": author });
    if let Some(by) = accepted_by {
        metadata["acceptedBy"] = json!(by);
    }
    json!({ "id": new_id(), "role": "user", "parts": parts, "metadata": metadata })
}

/// Send a message into the session's run, as the owner's composer does: it
/// joins at the next step, or starts a run. Returns its id.
async fn steer(app: &AppHandle, share: &HostShare, message: Value, config: Option<RunConfig>) -> Result<String, String> {
    let id = message.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    start_with_config(app, &share.thread_id, RunAction::Steer { message }, config).await?;
    Ok(id)
}

/// Start (or feed) a run on one of the shared session's threads, as the
/// owner's own action would. `config`: the owner's, if their app sent one;
/// otherwise their app is asked for it.
async fn start_with_config(app: &AppHandle, thread_id: &str, action: RunAction, config: Option<RunConfig>) -> Result<(), String> {
    let config = match config {
        Some(config) => config,
        None => {
            let what = match &action {
                RunAction::Steer { .. } => "steer",
                RunAction::Respond { .. } => "respond",
                _ => "resume",
            };
            request_config(app, thread_id, what).await?
        }
    };
    let meta = thread_meta(app, thread_id).await?;
    runs::start_run(app, meta, action, config).await.map_err(|e| e.to_string())
}

/// A collaborator's message, waiting for the driver (or the owner).
async fn suggest(app: &AppHandle, share: &HostShare, author: &Author, text: String, images: Vec<Image>) -> Result<Value, String> {
    if share.inner.lock().unwrap().suggestions.len() >= MAX_SUGGESTIONS {
        return Err("Too many suggestions are waiting. Try again once some are sent.".into());
    }
    let files = store_images(app, images).await?;
    let suggestion = Suggestion { id: new_id(), author: author.clone(), text, files, at: now_ms() };
    let (id, preview) = (suggestion.id.clone(), audit::preview(&suggestion.text));
    share.inner.lock().unwrap().suggestions.push(suggestion);
    share.queue_changed(app);
    share.record(app, author, Kind::Suggested, json!({ "suggestionId": id, "preview": preview }));
    Ok(json!({ "suggestionId": id }))
}

/// Send a suggestion (with `text` in place of its own, if edited), credited to
/// whoever wrote it and noting who sent it. `config`: the owner's, from their app.
async fn accept(app: &AppHandle, share: &HostShare, id: &str, text: Option<String>, by: &Author, config: Option<RunConfig>) -> Result<Value, String> {
    let suggestion = {
        let mut i = share.inner.lock().unwrap();
        let at = i.suggestions.iter().position(|s| s.id == id).ok_or("That suggestion is gone.")?;
        i.suggestions.remove(at)
    };
    share.queue_changed(app);
    let sent = text.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| suggestion.text.clone());
    let message = user_message(&sent, suggestion.files.clone(), &suggestion.author, Some(by));
    match steer(app, share, message, config).await {
        Ok(message_id) => {
            let detail = json!({
                "suggestionId": id,
                "messageId": message_id,
                "from": suggestion.author.name,
                "preview": audit::preview(&sent),
                "edited": sent != suggestion.text,
            });
            share.steers.fetch_add(1, Ordering::Relaxed);
            share.record(app, by, Kind::Accepted, detail);
            Ok(json!({ "messageId": message_id }))
        }
        Err(e) => {
            // It stays waiting, first in line.
            share.inner.lock().unwrap().suggestions.insert(0, suggestion);
            share.queue_changed(app);
            Err(e)
        }
    }
}

fn drop_suggestion(app: &AppHandle, share: &HostShare, id: &str, by: &Author) -> Result<(), String> {
    let suggestion = {
        let mut i = share.inner.lock().unwrap();
        let at = i.suggestions.iter().position(|s| s.id == id).ok_or("That suggestion is gone.")?;
        i.suggestions.remove(at)
    };
    share.queue_changed(app);
    let detail = json!({ "suggestionId": id, "from": suggestion.author.name, "preview": audit::preview(&suggestion.text) });
    share.record(app, by, Kind::Dropped, detail);
    Ok(())
}

/// Answer a waiting tool call for the owner. First wins: anyone later is told who answered.
#[allow(clippy::too_many_arguments)]
async fn respond(
    app: &AppHandle,
    share: &HostShare,
    by: &Author,
    child: Option<String>,
    call_id: String,
    class: ApprovalClass,
    decision: Decision,
    answer: Option<Value>,
) -> Result<Value, String> {
    let thread_id = child_thread(&share.thread_id, &child);
    let (response, kind) = match (decision, answer) {
        (Decision::Approve, Some(output)) => (ToolResponse::Output { output }, Kind::Answered),
        (Decision::Approve, None) => (ToolResponse::Approve, Kind::Approved),
        (Decision::Deny, _) => {
            let error_text = if class == ApprovalClass::AskUser { DISMISSED } else { DENIED };
            (ToolResponse::Error { error_text: error_text.into() }, Kind::Denied)
        }
    };
    share.claim(&call_id, &by.name)?;
    let action = RunAction::Respond { call_id: call_id.clone(), response, by: Some(by.clone()) };
    if let Err(e) = start_with_config(app, &thread_id, action, None).await {
        share.release(&call_id);
        return Err(e);
    }
    share.record(app, by, kind, json!({ "callId": call_id, "child": child }));
    Ok(Value::Null)
}

/// A remark beside the session, for everyone in it. Never sent to the model.
fn comment(app: &AppHandle, share: &HostShare, author: &Author, text: &str, message_id: Option<String>) -> Value {
    let comment = Comment { id: new_id(), author: author.clone(), text: text.trim().to_string(), message_id, at: now_ms() };
    share.append(
        |i| {
            i.comments.push(comment.clone());
            if i.comments.len() > MAX_COMMENTS {
                i.comments.remove(0);
            }
        },
        Event::Comment { comment: comment.clone() },
    );
    let detail = json!({ "commentId": comment.id, "text": comment.text, "messageId": comment.message_id });
    share.record(app, author, Kind::Commented, detail);
    json!({ "commentId": comment.id })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteLink {
    invite_id: String,
    /// `<relay>/join/<share>#<token>`: shown once, to copy. The token is after the `#`.
    link: String,
    expires_at: i64,
    max_uses: i64,
}

/// A new invite link to a share (viewers only, in this phase).
#[tauri::command]
pub async fn share_invite_create(
    state: State<'_, AppState>,
    thread_id: String,
    ttl_hours: Option<u32>,
    max_uses: Option<u32>,
    role_cap: Option<Role>,
) -> AppResult<InviteLink> {
    let share = state.runs.shares.host(&thread_id)?;
    // A link lets people watch or suggest; driving is only handed over in the session.
    let role_cap = if role_cap == Some(Role::Collaborator) { "collaborator" } else { "viewer" };
    let resp = state
        .http
        .post(format!("{}/api/shares/{}/invites", share.account.relay_url, share.share_id))
        .bearer_auth(&share.account.token)
        .json(&json!({ "ttlHours": ttl_hours, "maxUses": max_uses, "roleCap": role_cap }))
        .send()
        .await
        .map_err(net)?;
    let invite = relay_json(resp).await?;
    let field = |k: &str| invite.get(k).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| AppError::Invalid("The relay didn't make an invite.".into()));
    let token = field("token")?;
    // An encrypted share's key goes after the `#` too: never sent to the relay.
    let fragment = match &share.e2e {
        Some(e2e) => format!("t={token}&k={}", e2e.lock().unwrap().keys[0].to_text()),
        None => token,
    };
    Ok(InviteLink {
        invite_id: field("inviteId")?,
        link: format!("{}/join/{}#{fragment}", share.account.relay_url, share.share_id),
        expires_at: invite.get("expiresAt").and_then(Value::as_i64).unwrap_or_default(),
        max_uses: invite.get("maxUses").and_then(Value::as_i64).unwrap_or_default(),
    })
}

/// A share's invites (without their tokens).
#[tauri::command]
pub async fn share_invites_list(state: State<'_, AppState>, thread_id: String) -> AppResult<Value> {
    let share = state.runs.shares.host(&thread_id)?;
    let resp = state
        .http
        .get(format!("{}/api/shares/{}/invites", share.account.relay_url, share.share_id))
        .bearer_auth(&share.account.token)
        .send()
        .await
        .map_err(net)?;
    relay_json(resp).await
}

#[tauri::command]
pub async fn share_invite_revoke(state: State<'_, AppState>, thread_id: String, invite_id: String) -> AppResult<()> {
    let share = state.runs.shares.host(&thread_id)?;
    let resp = state
        .http
        .delete(format!("{}/api/shares/{}/invites/{}", share.account.relay_url, share.share_id, urlencode(&invite_id)))
        .bearer_auth(&share.account.token)
        .send()
        .await
        .map_err(net)?;
    relay_json(resp).await.map(|_| ())
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// Let someone in from the lobby, or turn them away.
#[tauri::command]
pub fn share_admit(app: AppHandle, state: State<'_, AppState>, thread_id: String, user_id: String, allow: bool) -> AppResult<()> {
    let share = state.runs.shares.host(&thread_id)?;
    let _ = share.out.send(json!({ "t": "admit", "userId": user_id, "allow": allow }).to_string());
    share.inner.lock().unwrap().lobby.retain(|p| p.user_id != user_id);
    emit_view(&app, share.view());
    Ok(())
}

/// Remove someone from the share; they can't come back with the same link.
#[tauri::command]
pub async fn share_kick(app: AppHandle, state: State<'_, AppState>, thread_id: String, user_id: String) -> AppResult<()> {
    let share = state.runs.shares.host(&thread_id)?;
    let resp = state
        .http
        .delete(format!("{}/api/shares/{}/members/{}", share.account.relay_url, share.share_id, urlencode(&user_id)))
        .bearer_auth(&share.account.token)
        .send()
        .await
        .map_err(net)?;
    relay_json(resp).await?;
    let removed = {
        let mut i = share.inner.lock().unwrap();
        let HostInner { members, requests, .. } = &mut *i;
        control::forget(members, requests, &user_id);
        i.members.remove(&user_id)
    };
    share.members_changed();
    // What follows is sealed with a key the one removed never gets.
    if let Some(e2e) = &share.e2e {
        e2e.lock().unwrap().devices.retain(|_, (user, _)| user != &user_id);
    }
    share.rekey();
    if let Some(m) = removed {
        share.record(&app, &share.owner, Kind::Kicked, json!({ "userId": user_id, "name": m.name }));
    }
    // Their role may have been the last that could steer: standing permissions apply again.
    state.runs.recheck_family(&thread_id);
    emit_view(&app, share.view());
    Ok(())
}

/// What the owner lets guests do. A change to what the driver may approve goes in the audit log.
#[tauri::command]
pub fn share_set_policy(app: AppHandle, state: State<'_, AppState>, thread_id: String, policy: SharePolicy) -> AppResult<()> {
    let share = state.runs.shares.host(&thread_id)?;
    let policy = SharePolicy { away: policy.away.clamped(), ..policy };
    let before = std::mem::replace(&mut share.inner.lock().unwrap().policy, policy.clone());
    share.members_changed();
    if before.delegation != policy.delegation {
        share.record(&app, &share.owner, Kind::Role, json!({ "delegation": policy.delegation }));
    }
    if before.away != policy.away {
        share.record(&app, &share.owner, Kind::Role, json!({ "away": policy.away }));
    }
    emit_view(&app, share.view());
    Ok(())
}

/// Give someone in the share another role. There's one driver at a time: a
/// new one makes the old one a collaborator. Only the owner does this, here.
#[tauri::command]
pub fn share_set_role(app: AppHandle, state: State<'_, AppState>, thread_id: String, user_id: String, role: Role) -> AppResult<()> {
    if role == Role::Owner {
        return Err(AppError::Invalid("A share has one owner.".into()));
    }
    let share = state.runs.shares.host(&thread_id)?;
    if !share.limits.allows(role) {
        return Err(AppError::Invalid("The relay's plan for this account doesn't include that role for guests.".into()));
    }
    let name = {
        let mut i = share.inner.lock().unwrap();
        if !i.members.contains_key(&user_id) {
            return Err(AppError::NotFound("They're no longer in this share.".into()));
        }
        if role == Role::Driver {
            for m in i.members.values_mut().filter(|m| m.role == Role::Driver) {
                m.role = Role::Collaborator;
            }
            i.requests.retain(|r| r.user_id != user_id);
        }
        let member = i.members.get_mut(&user_id).expect("checked above");
        member.role = role;
        member.name.clone()
    };
    share.members_changed();
    share.record(&app, &share.owner, Kind::Role, json!({ "userId": user_id, "name": name, "role": role }));
    // Nobody else may be able to steer now: calls held only for that start.
    state.runs.recheck_family(&thread_id);
    emit_view(&app, share.view());
    Ok(())
}

/// The owner answers a request for control, passes control on, or takes it back.
/// `action`: `accept`, `decline`, `pass` (with `userId`) or `take`.
#[tauri::command]
pub fn share_control(app: AppHandle, state: State<'_, AppState>, thread_id: String, action: String, user_id: Option<String>) -> AppResult<()> {
    let share = state.runs.shares.host(&thread_id)?;
    let user = || user_id.clone().ok_or_else(|| AppError::Invalid("Say who.".into()));
    let change = match action.as_str() {
        "accept" => control::Change::Accept { user_id: user()? },
        "decline" => control::Change::Decline { user_id: user()? },
        "pass" => control::Change::Pass { user_id: user()? },
        "take" => control::Change::Take,
        _ => return Err(AppError::Invalid("Unknown control action.".into())),
    };
    share.change_control(&app, &Actor::Owner, change).map_err(AppError::Invalid)?;
    emit_view(&app, share.view());
    Ok(())
}

/// The owner steps away from their shared session, or comes back. Away, the
/// share's away policy applies: pause at the next step boundary and drive
/// again (the default), or let the driver go on for a while first.
#[tauri::command]
pub fn share_step_away(app: AppHandle, state: State<'_, AppState>, thread_id: String, away: bool) -> AppResult<()> {
    let share = state.runs.shares.host(&thread_id)?;
    let policy = {
        let mut i = share.inner.lock().unwrap();
        if i.away.is_some() == away {
            return Ok(());
        }
        if let Some(timer) = i.away_timer.take() {
            timer.cancel();
        }
        i.away = away.then(now_ms);
        i.policy.away
    };
    share.members_changed();
    share.record(&app, &share.owner, Kind::Away, json!({ "away": away, "mode": policy.mode, "minutes": policy.minutes }));
    if away {
        match policy.mode {
            AwayMode::Pause => pause_for_owner(&app, &share),
            AwayMode::KeepGoing => {
                let timer = share.cancel.child_token();
                share.inner.lock().unwrap().away_timer = Some(timer.clone());
                let (app, share) = (app.clone(), share.clone());
                tauri::async_runtime::spawn(async move {
                    tokio::select! {
                        _ = timer.cancelled() => {}
                        _ = tokio::time::sleep(Duration::from_secs(u64::from(policy.minutes) * 60)) => {
                            if share.inner.lock().unwrap().away.is_some() {
                                pause_for_owner(&app, &share);
                            }
                        }
                    }
                });
            }
        }
    }
    emit_view(&app, share.view());
    Ok(())
}

/// Nobody on the host's side is there: the run finishes what it's doing and
/// pauses, and the owner drives again, so no one else's message can start more.
fn pause_for_owner(app: &AppHandle, share: &HostShare) {
    let state = app.state::<AppState>();
    if control::driver(&share.inner.lock().unwrap().members).is_some() {
        let _ = share.change_control(app, &Actor::Owner, control::Change::Take);
    }
    state.runs.pause_family(&share.thread_id);
    emit_view(app, share.view());
}

/// The owner undid a turn of a shared session in their own app: it goes in the log.
pub(crate) fn note_local_undo(app: &AppHandle, thread_id: &str, turn_id: &str, path: Option<&str>, restored: usize) {
    let shares = &app.state::<AppState>().runs.shares;
    if let Some((share, _)) = shares.share_for(thread_id) {
        share.record(app, &share.owner, Kind::Undid, json!({ "turnId": turn_id, "path": path, "restored": restored }));
    }
}

/// The owner sends a suggestion from their own app, with the config their UI built.
#[tauri::command]
pub async fn share_suggestion_accept(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    suggestion_id: String,
    text: Option<String>,
    config: RunConfig,
) -> AppResult<()> {
    let share = state.runs.shares.host(&thread_id)?;
    accept(&app, &share, &suggestion_id, text, &share.owner, Some(config)).await.map_err(AppError::Invalid)?;
    Ok(())
}

#[tauri::command]
pub fn share_suggestion_drop(app: AppHandle, state: State<'_, AppState>, thread_id: String, suggestion_id: String) -> AppResult<()> {
    let share = state.runs.shares.host(&thread_id)?;
    drop_suggestion(&app, &share, &suggestion_id, &share.owner).map_err(AppError::Invalid)
}

/// The owner's comment on their shared session.
#[tauri::command]
pub fn share_comment(app: AppHandle, state: State<'_, AppState>, thread_id: String, text: String, message_id: Option<String>) -> AppResult<()> {
    let share = state.runs.shares.host(&thread_id)?;
    if text.trim().is_empty() || text.len() > policy::MAX_COMMENT {
        return Err(AppError::Invalid("A comment is between 1 and 4,096 characters.".into()));
    }
    comment(&app, &share, &share.owner, &text, message_id);
    Ok(())
}

/// Stop sharing: everyone is disconnected and the links stop working.
#[tauri::command]
pub async fn share_end(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> AppResult<()> {
    let share = state.runs.shares.host(&thread_id)?;
    let resp = state
        .http
        .delete(format!("{}/api/shares/{}", share.account.relay_url, share.share_id))
        .bearer_auth(&share.account.token)
        .json(&share.end_stats())
        .send()
        .await;
    // Ended here whatever the relay said; it ends the room itself once the host is gone for long enough.
    if let Ok(resp) = resp {
        let _ = relay_json(resp).await;
    }
    share.record(&app, &share.owner, Kind::Ended, json!({}));
    finish_host(&app, &share, "You ended the share.".into());
    Ok(())
}

// --- joining ------------------------------------------------------------------------

/// Join a share from its invite link. The link must be for the relay set up in Settings → Sharing:
/// the relay account's token is only ever sent there.
#[tauri::command]
pub async fn share_join(app: AppHandle, state: State<'_, AppState>, link: String) -> AppResult<ShareView> {
    let account = account()?;
    let url = url::Url::parse(link.trim()).map_err(|_| AppError::Invalid("That isn't a Sush invite link.".into()))?;
    if url.origin().ascii_serialization() != account.relay_url {
        return Err(AppError::Invalid(format!(
            "This link is for another relay ({}). Set it up in Settings → Sharing to join.",
            url.origin().ascii_serialization()
        )));
    }
    let share_id = url
        .path()
        .strip_prefix("/join/")
        .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .ok_or_else(|| AppError::Invalid("That isn't a Sush invite link.".into()))?
        .to_string();
    let thread_id = proto::guest_thread_id(&share_id);
    {
        let mut guests = state.runs.shares.guests.lock().unwrap();
        if let Some(guest) = guests.get(&thread_id) {
            if guest.inner.lock().unwrap().status != LinkStatus::Ended {
                return Ok(guest.view());
            }
            // Joining again after it ended (or after being turned away): start afresh.
            guests.remove(&thread_id);
        }
    }
    let (token, key) = crypto::parse_fragment(url.fragment().unwrap_or_default());
    let key = key.map(|k| ShareKey::from_text(&k, 1)).transpose().map_err(AppError::Invalid)?;
    let resp = state
        .http
        .post(format!("{}/api/shares/{share_id}/join", account.relay_url))
        .bearer_auth(&account.token)
        .json(&json!({ "token": token }))
        .send()
        .await
        .map_err(net)?;
    let joined = relay_json(resp).await?;
    let text = |k: &str| joined.get(k).and_then(Value::as_str).unwrap_or_default().to_string();

    let (out, rx) = mpsc::unbounded_channel();
    let guest = Arc::new(GuestShare {
        share_id,
        thread_id: thread_id.clone(),
        account,
        expires_at: joined.get("expiresAt").and_then(Value::as_i64).unwrap_or_default(),
        out,
        inner: Mutex::new(GuestInner {
            replica: Replica::default(),
            info: ThreadInfo { title: text("title"), kind: ThreadKind::Chat, workspace_name: None, host_name: text("hostName") },
            host_user: None,
            me: None,
            status: LinkStatus::Connecting,
            host_online: false,
            admitted: false,
            ended: None,
            error: None,
        }),
        replies: Mutex::default(),
        blobs: Mutex::default(),
        e2e: key.map(|key| Mutex::new(GuestE2e { keys: vec![key], device: Device::generate() })),
        cancel: CancellationToken::new(),
    });
    state.runs.shares.guests.lock().unwrap().insert(thread_id, guest.clone());
    tauri::async_runtime::spawn(guest_loop(app.clone(), guest.clone(), rx));
    let view = guest.view();
    emit_view(&app, view.clone());
    Ok(view)
}

/// Stop watching a share. Its copy here is dropped.
#[tauri::command]
pub fn share_leave(state: State<'_, AppState>, thread_id: String) -> AppResult<()> {
    let guest = state.runs.shares.guests.lock().unwrap().remove(&thread_id);
    if let Some(guest) = guest {
        guest.cancel.cancel();
    }
    state.runs.send(RunFrame::ShareGone { thread_id });
    Ok(())
}

/// Ask the host of a joined share for something (a diff, a file, a folder listing).
#[tauri::command]
pub async fn share_request(state: State<'_, AppState>, thread_id: String, intent: Intent) -> AppResult<Value> {
    let guest = state.runs.shares.guest(&thread_id)?;
    guest.request(intent).await.map_err(AppError::Invalid)
}

/// Every share hosted or joined, and joined shares' threads, so a reloaded page catches up.
#[tauri::command]
pub fn shares_state(state: State<'_, AppState>) -> SharesState {
    let shares = &state.runs.shares;
    let mut views: Vec<ShareView> = shares.hosts.lock().unwrap().values().map(|s| s.view()).collect();
    let mut threads = Vec::new();
    let mut running = Vec::new();
    for guest in shares.guests.lock().unwrap().values() {
        views.push(guest.view());
        let i = guest.inner.lock().unwrap();
        for (child, t) in &i.replica.threads {
            threads.push(SharedThread {
                thread_id: child_thread(&guest.thread_id, child),
                messages: t.messages.clone(),
                status: t.status,
                error: t.error.clone(),
            });
        }
        running.extend(i.replica.running.iter().cloned());
    }
    SharesState { shares: views, threads, running }
}

fn child_thread(thread_id: &str, child: &Option<String>) -> String {
    match child {
        Some(call) => format!("{thread_id}:{call}"),
        None => thread_id.to_string(),
    }
}

async fn guest_loop(app: AppHandle, guest: Arc<GuestShare>, mut rx: mpsc::UnboundedReceiver<String>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect(&guest.account, &guest.share_id).await {
            Ok(socket) => {
                backoff = Duration::from_secs(1);
                let (mut sink, mut stream) = socket.split();
                let mut ping = tokio::time::interval(Duration::from_secs(25));
                let ended = loop {
                    tokio::select! {
                        _ = guest.cancel.cancelled() => {
                            let _ = sink.close().await;
                            return;
                        }
                        out = rx.recv() => match out {
                            Some(text) => if sink.send(Message::text(text)).await.is_err() { break false },
                            None => return,
                        },
                        msg = stream.next() => match msg {
                            Some(Ok(Message::Text(text))) => if on_guest_frame(&app, &guest, text.as_str()) { break true },
                            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break false,
                            Some(Ok(_)) => {}
                        },
                        _ = ping.tick() => {
                            let _ = sink.send(Message::text(json!({ "t": "ping" }).to_string())).await;
                        }
                    }
                };
                if ended {
                    return;
                }
                set_guest_status(&app, &guest, LinkStatus::Offline, Some("Reconnecting to the relay…".into()));
            }
            Err(ConnectError::Refused(message)) => {
                finish_guest(&app, &guest, message);
                return;
            }
            Err(ConnectError::Failed(message)) => set_guest_status(&app, &guest, LinkStatus::Offline, Some(message)),
        }
        let wait = tokio::time::sleep(backoff);
        tokio::pin!(wait);
        loop {
            tokio::select! {
                _ = guest.cancel.cancelled() => return,
                _ = &mut wait => break,
                out = rx.recv() => if out.is_none() { return },
            }
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

fn set_guest_status(app: &AppHandle, guest: &GuestShare, status: LinkStatus, error: Option<String>) {
    {
        let mut i = guest.inner.lock().unwrap();
        i.status = status;
        i.error = error;
    }
    emit_view(app, guest.view());
}

/// The share is over for this guest. Its copy stays on screen, marked ended, until they leave it.
fn finish_guest(app: &AppHandle, guest: &GuestShare, reason: String) {
    {
        let mut i = guest.inner.lock().unwrap();
        i.status = LinkStatus::Ended;
        i.ended = Some(reason);
    }
    guest.cancel.cancel();
    // Whatever was asked won't be answered.
    guest.replies.lock().unwrap().clear();
    emit_view(app, guest.view());
}

/// A frame from the relay; returns true once the share is over.
fn on_guest_frame(app: &AppHandle, guest: &GuestShare, text: &str) -> bool {
    let Ok(frame) = serde_json::from_str::<RelayIn>(text) else { return false };
    let mut hello = false;
    let mut frames = Vec::new();
    {
        let mut i = guest.inner.lock().unwrap();
        match frame {
            RelayIn::Welcome { you, peers, host_online, admitted, .. } => {
                i.host_online = host_online;
                i.admitted = admitted;
                if let Some(you) = you {
                    i.me = Some(you.user_id);
                }
                if let Some(host) = peers.iter().find(|p| p.is_host) {
                    i.host_user = Some(host.user_id.clone());
                }
                i.status = if !admitted { LinkStatus::Lobby } else if host_online { LinkStatus::Live } else { LinkStatus::Offline };
                i.error = None;
                hello = admitted && host_online;
            }
            RelayIn::Admitted => {
                i.admitted = true;
                i.status = if i.host_online { LinkStatus::Live } else { LinkStatus::Offline };
                hello = i.host_online;
            }
            RelayIn::HostOnline => {
                i.host_online = true;
                if i.admitted {
                    i.status = LinkStatus::Live;
                    i.error = None;
                    hello = true;
                }
            }
            RelayIn::HostOffline => {
                i.host_online = false;
                if i.admitted {
                    i.status = LinkStatus::Offline;
                    i.error = Some(format!("{} is offline. Waiting for them to come back…", i.info.host_name));
                }
            }
            RelayIn::Recv { from, body } if from.is_host => {
                i.host_user = Some(from.user_id.clone());
                let Some(body) = guest.read_host(&body) else {
                    // Sealed with a key this guest missed (a rekey went by): the host sends it with a fresh snapshot.
                    if crypto::header(&body).is_some_and(|(g, _)| guest.e2e.as_ref().is_some_and(|e| !e.lock().unwrap().keys.iter().any(|k| k.generation == g))) {
                        let last_seq = i.replica.last_seq();
                        drop(i);
                        guest.send_host(GuestMsg::Resync { last_seq });
                    }
                    return false;
                };
                match proto::decode::<HostMsg>(&body) {
                    Ok(HostMsg::Rekey { generation, sealed }) => {
                        drop(i);
                        guest.take_key(generation, &sealed);
                        return false;
                    }
                    Ok(HostMsg::Reply { re, ok, data, error }) => {
                        drop(i);
                        if let Some(tx) = guest.replies.lock().unwrap().remove(&re) {
                            let _ = tx.send(if ok { Ok(data.unwrap_or(Value::Null)) } else { Err(error.unwrap_or_else(|| "The host said no.".into())) });
                        }
                        return false;
                    }
                    Ok(HostMsg::Incompatible { .. }) => {
                        i.error = Some("The host's Sush is a different version. Update Sush on both machines.".into());
                    }
                    Ok(msg) => match i.replica.apply(msg) {
                        Applied::Changed(change) => {
                            let only_frames = !matches!(
                                change,
                                Change::Snapshot | Change::Members | Change::Thread | Change::Queue | Change::Comment | Change::Audit
                            );
                            frames = frames_for(&guest.thread_id, &mut i, change);
                            if only_frames {
                                drop(i);
                                for frame in frames {
                                    app.state::<AppState>().runs.send(frame);
                                }
                                return false;
                            }
                        }
                        Applied::Ignored => return false,
                        Applied::Resync => {
                            let last_seq = i.replica.last_seq();
                            drop(i);
                            guest.send_host(GuestMsg::Resync { last_seq });
                            return false;
                        }
                    },
                    // A message this version can't read: start over from a snapshot.
                    Err(_) => {
                        drop(i);
                        guest.send_host(GuestMsg::Resync { last_seq: 0 });
                        return false;
                    }
                }
            }
            RelayIn::Closed { reason } => {
                drop(i);
                finish_guest(app, guest, closed_reason(&reason));
                return true;
            }
            _ => return false,
        }
    }
    if hello {
        guest.send_host(guest.hello());
    }
    for frame in frames {
        app.state::<AppState>().runs.send(frame);
    }
    emit_view(app, guest.view());
    false
}

/// The run frames that show a replica's change, for its threads `shared:<id>[:<call>]`.
fn frames_for(thread_id: &str, i: &mut GuestInner, change: Change) -> Vec<RunFrame> {
    let id = |child: &Option<String>| child_thread(thread_id, child);
    match change {
        Change::Snapshot => {
            if let Some(info) = i.replica.thread.clone() {
                i.info = info;
            }
            let mut frames = Vec::new();
            for (child, t) in &i.replica.threads {
                frames.push(RunFrame::Op { thread_id: id(child), op: Op::Reset { messages: t.messages.clone() } });
                frames.push(RunFrame::Status { thread_id: id(child), status: t.status, error: t.error.clone() });
            }
            for call_id in &i.replica.running {
                frames.push(RunFrame::ToolRunning { thread_id: thread_id.to_string(), call_id: call_id.clone(), running: true });
            }
            frames.push(RunFrame::FilesChanged { thread_id: thread_id.to_string(), workspace_id: SHARED_WORKSPACE.into() });
            frames
        }
        Change::Op { child, op } => vec![RunFrame::Op { thread_id: id(&child), op }],
        Change::Status { child, status, error } => vec![RunFrame::Status { thread_id: id(&child), status, error }],
        Change::ToolRunning { call_id, running } => vec![RunFrame::ToolRunning { thread_id: thread_id.to_string(), call_id, running }],
        Change::FilesChanged => vec![RunFrame::FilesChanged { thread_id: thread_id.to_string(), workspace_id: SHARED_WORKSPACE.into() }],
        // Shown through the share's view, which goes out after these.
        Change::Members | Change::Queue | Change::Comment | Change::Audit => Vec::new(),
        Change::Thread => {
            if let Some(info) = i.replica.thread.clone() {
                i.info = info;
            }
            Vec::new()
        }
    }
}

/// The workspace id `files-changed` frames carry for a joined share: it has no folder here.
const SHARED_WORKSPACE: &str = "shared";
