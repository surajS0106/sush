//! Live shared sessions ("Sush Multiplayer"), phase 1: others watch.
//!
//! The host is authoritative. The run, the workspace and every credential stay
//! here; guests get the thread as the same ops the UI applies, redacted
//! (`sush_core::share::redact`), and may only ask for reads, which are checked
//! against their role and what the session shows (`sush_core::share::policy`)
//! before the host carries them out through its own file access.
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
use std::time::Duration;

use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sush_core::agent::ui::new_id;
use sush_core::agent::{Op, RunStatus};
use sush_core::share::outbox::{self, Event, Outbox};
use sush_core::share::replica::{Applied, Change, Replica};
use sush_core::share::{
    self as proto, policy, Body, GuestMsg, HostMsg, Intent, Member, Role, SharePolicy, ThreadInfo, ThreadKind, ThreadState, TurnFiles,
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
use crate::runs::RunFrame;
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
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
enum RelayIn {
    Welcome {
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
/// Lock order: the runs' channels, then `hosts`, then a share's own locks;
/// a share's `inner` and `outbox` are never held together.
#[derive(Default)]
pub struct Shares {
    hosts: Mutex<HashMap<String, Arc<HostShare>>>,
    guests: Mutex<HashMap<String, Arc<GuestShare>>>,
}

pub(crate) struct HostShare {
    share_id: String,
    thread_id: String,
    account: Account,
    expires_at: i64,
    outbox: Mutex<Outbox>,
    flush: Notify,
    /// A turn changed files: guests get the new list with the next flush.
    files_dirty: AtomicBool,
    out: mpsc::UnboundedSender<String>,
    inner: Mutex<HostInner>,
    cancel: CancellationToken,
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
        }
    }

    fn send_to(&self, peer_id: &str, msg: HostMsg) {
        let _ = self.out.send(relay_send(peer_id, &Body::encode(msg)));
    }

    /// Number what's waiting and send it, holding the outbox so nothing overtakes it.
    fn flush_now(&self) {
        let mut outbox = self.outbox.lock().unwrap();
        for msg in outbox.flush() {
            let _ = self.out.send(relay_send("all", &Body::encode(msg)));
        }
    }

    fn push(&self, event: Event) {
        self.outbox.lock().unwrap().push(event);
        self.flush.notify_one();
    }

    /// Tell guests who's in the share now.
    fn members_changed(&self) {
        let (members, policy) = {
            let i = self.inner.lock().unwrap();
            (i.members.values().cloned().collect(), i.policy.clone())
        };
        self.push(Event::Members { members, policy });
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
    cancel: CancellationToken,
}

struct GuestInner {
    replica: Replica,
    info: ThreadInfo,
    host_user: Option<String>,
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
        ShareView {
            thread_id: self.thread_id.clone(),
            share_id: self.share_id.clone(),
            role: Role::Viewer,
            status: i.status,
            thread: i.info.clone(),
            members: std::iter::once(host).chain(i.replica.members.iter().cloned()).collect(),
            lobby: Vec::new(),
            policy: i.replica.policy.clone(),
            expires_at: self.expires_at,
            ended: i.ended.clone(),
            error: i.error.clone(),
        }
    }

    fn send_host(&self, msg: GuestMsg) {
        let _ = self.out.send(relay_send("host", &Body::encode(msg)));
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
        let (share, child) = {
            let hosts = self.hosts.lock().unwrap();
            if hosts.is_empty() {
                return;
            }
            // The session itself, or a sub-agent's thread, `<session>:<call>`.
            match hosts.get(thread_id) {
                Some(share) => (share.clone(), None),
                None => match thread_id.split_once(':').and_then(|(parent, call)| hosts.get(parent).map(|s| (s.clone(), call.to_string()))) {
                    Some((share, call)) => (share, Some(call)),
                    None => return,
                },
            }
        };
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
            let _ = http.delete(url).bearer_auth(&share.account.token).send().await;
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

/// Start sharing a session. Incognito sessions, reports and sub-agents' threads can't be shared.
#[tauri::command]
pub async fn share_start(app: AppHandle, state: State<'_, AppState>, thread: ThreadMeta) -> AppResult<ShareView> {
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
        .json(&json!({ "title": thread.title }))
        .send()
        .await
        .map_err(net)?;
    let created = relay_json(resp).await?;
    let share_id = created.get("shareId").and_then(Value::as_str).ok_or_else(|| AppError::Invalid("The relay didn't start the share.".into()))?;
    let expires_at = created.get("expiresAt").and_then(Value::as_i64).unwrap_or_default();

    let (out, rx) = mpsc::unbounded_channel();
    let share = Arc::new(HostShare {
        share_id: share_id.to_string(),
        thread_id: thread.id.clone(),
        account,
        expires_at,
        outbox: Mutex::new(Outbox::new(1)),
        flush: Notify::new(),
        files_dirty: AtomicBool::new(false),
        out,
        inner: Mutex::new(HostInner {
            info: ThreadInfo {
                title: thread.title.clone(),
                kind: if workspace.is_some() { ThreadKind::Cowork } else { ThreadKind::Chat },
                workspace_name: workspace.map(|w| w.name),
                host_name: if me.name.trim().is_empty() { me.email.split('@').next().unwrap_or_default().to_string() } else { me.name },
            },
            status: LinkStatus::Connecting,
            peers: HashMap::new(),
            members: BTreeMap::new(),
            lobby: Vec::new(),
            policy: SharePolicy::default(),
            running: HashSet::new(),
            ended: None,
            error: None,
        }),
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
    emit_view(app, share.view());
}

fn upsert_member(members: &mut BTreeMap<String, Member>, peer: &Peer) {
    let member = members.entry(peer.user_id.clone()).or_insert_with(|| Member {
        user_id: peer.user_id.clone(),
        name: peer.name.clone(),
        image: None,
        role: Role::Viewer,
        online: true,
    });
    member.name = peer.name.clone();
    member.image = peer.image.clone();
    member.online = true;
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
            {
                let mut i = share.inner.lock().unwrap();
                i.lobby.retain(|p| p.user_id != peer.user_id);
                upsert_member(&mut i.members, &peer);
                i.peers.insert(peer.peer_id.clone(), peer);
            }
            share.members_changed();
        }
        RelayIn::PeerLeft { peer_id } => {
            {
                let mut i = share.inner.lock().unwrap();
                i.lobby.retain(|p| p.peer_id != peer_id);
                if let Some(gone) = i.peers.remove(&peer_id) {
                    let still = i.peers.values().any(|p| p.user_id == gone.user_id);
                    if let Some(m) = i.members.get_mut(&gone.user_id) {
                        m.online = still;
                    }
                }
            }
            share.members_changed();
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
    match proto::decode::<GuestMsg>(body) {
        Ok(GuestMsg::Hello { min_v, .. }) if min_v > proto::PROTOCOL_VERSION => {
            share.send_to(&from.peer_id, HostMsg::Incompatible { host_v: proto::PROTOCOL_VERSION, min_v: proto::MIN_VERSION });
        }
        Ok(GuestMsg::Hello { .. } | GuestMsg::Resync { .. }) => {
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
    let (info, members, policy) = {
        let i = share.inner.lock().unwrap();
        (i.info.clone(), i.members.values().cloned().collect::<Vec<_>>(), i.policy.clone())
    };
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
        // Flushed first: what's pending is already in `threads`.
        let mut outbox = share.outbox.lock().unwrap();
        for msg in outbox.flush() {
            let _ = share.out.send(relay_send("all", &Body::encode(msg)));
        }
        let snapshot = outbox.snapshot(info, threads, running, turns, members, policy);
        let _ = share.out.send(relay_send(&peer_id, &Body::encode(snapshot)));
    });
}

/// Check a guest's request against their role and what the session shows, then carry it out.
async fn handle_intent(app: &AppHandle, share: &HostShare, from: &Peer, intent: Intent) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let (role, policy_now) = {
        let i = share.inner.lock().unwrap();
        (i.members.get(&from.user_id).map(|m| m.role), i.policy.clone())
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
    // What the session shows now: the live copies of threads with a run going, and the saved ones.
    let live = state.runs.with_family(&share.thread_id, |live| live);
    let mut all: Vec<Value> = live.into_iter().flat_map(|t| t.messages).collect();
    all.extend(saved);
    all.extend(children.into_iter().flat_map(|c| c.messages));
    let touched = outbox::touched_paths(&all);
    let blobs = outbox::blob_shas(&all);
    let turn_ids: HashSet<String> = turns.iter().map(|t| t.turn_id.clone()).collect();
    let ctx = policy::Ctx { role, policy: &policy_now, cowork: workspace.is_some(), touched: &touched, turns: &turn_ids, blobs: &blobs };
    let policy::Allowed(intent) = policy::authorize(&ctx, intent)?;

    let root = workspace.map(|w| w.root);
    let open = move || -> AppResult<WorkspaceFs> {
        let root = root.ok_or_else(|| AppError::Invalid("This session has no folder.".into()))?;
        WorkspaceFs::open(Path::new(&root)).map_err(AppError::Invalid)
    };
    let store = state.store.clone();
    let thread_id = share.thread_id.clone();
    let result = match intent {
        Intent::GetTurnChanges => return Ok(json!(visible_turns(app, &share.thread_id).await)),
        Intent::GetDiff { turn_id } => blocking(move || {
            let diffs = workspaces::turn_diff_files(&store, &thread_id, &turn_id)?;
            Ok(json!(diffs.into_iter().map(workspaces::FileDiff::hidden_if_secret).collect::<Vec<_>>()))
        })
        .await,
        Intent::GetFile { path } => blocking(move || Ok(json!(workspaces::file_view(&open()?, &path)?))).await,
        Intent::ListDir { path } => blocking(move || {
            let fs = open()?;
            let rel = fs.rel(&path).map_err(AppError::Invalid)?;
            Ok(json!(fs.list(&rel).map_err(AppError::Invalid)?))
        })
        .await,
        Intent::GetBlob { sha } => blocking(move || {
            let (media_type, bytes) = store.blob(&sha)?.ok_or_else(|| AppError::NotFound("That file is no longer stored.".into()))?;
            if bytes.len() > MAX_BLOB {
                return Err(AppError::Invalid("That file is too big to share.".into()));
            }
            Ok(json!({ "mediaType": media_type, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }))
        })
        .await,
    };
    result.map_err(|e| e.to_string())
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
pub async fn share_invite_create(state: State<'_, AppState>, thread_id: String, ttl_hours: Option<u32>, max_uses: Option<u32>) -> AppResult<InviteLink> {
    let share = state.runs.shares.host(&thread_id)?;
    let resp = state
        .http
        .post(format!("{}/api/shares/{}/invites", share.account.relay_url, share.share_id))
        .bearer_auth(&share.account.token)
        .json(&json!({ "ttlHours": ttl_hours, "maxUses": max_uses }))
        .send()
        .await
        .map_err(net)?;
    let invite = relay_json(resp).await?;
    let field = |k: &str| invite.get(k).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| AppError::Invalid("The relay didn't make an invite.".into()));
    let token = field("token")?;
    Ok(InviteLink {
        invite_id: field("inviteId")?,
        link: format!("{}/join/{}#{token}", share.account.relay_url, share.share_id),
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
    share.inner.lock().unwrap().members.remove(&user_id);
    share.members_changed();
    emit_view(&app, share.view());
    Ok(())
}

#[tauri::command]
pub fn share_set_policy(app: AppHandle, state: State<'_, AppState>, thread_id: String, policy: SharePolicy) -> AppResult<()> {
    let share = state.runs.shares.host(&thread_id)?;
    share.inner.lock().unwrap().policy = policy;
    share.members_changed();
    emit_view(&app, share.view());
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
        .send()
        .await;
    // Ended here whatever the relay said; it ends the room itself once the host is gone for long enough.
    if let Ok(resp) = resp {
        let _ = relay_json(resp).await;
    }
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
    let token = url.fragment().unwrap_or_default();
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
            status: LinkStatus::Connecting,
            host_online: false,
            admitted: false,
            ended: None,
            error: None,
        }),
        replies: Mutex::default(),
        blobs: Mutex::default(),
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
            RelayIn::Welcome { peers, host_online, admitted, .. } => {
                i.host_online = host_online;
                i.admitted = admitted;
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
                match proto::decode::<HostMsg>(&body) {
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
                            let only_frames = !matches!(change, Change::Snapshot | Change::Members | Change::Thread);
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
        guest.send_host(GuestMsg::Hello { min_v: proto::MIN_VERSION, caps: Vec::new() });
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
        Change::Members => Vec::new(),
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
