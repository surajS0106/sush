//! Sharing a session live with other people ("Sush Multiplayer").
//!
//! The host is authoritative: the run, the workspace, the sandbox and every
//! credential stay on the host's machine. Guests receive the thread as the
//! same deterministic [`Op`]s the UI applies, after [`redact`] removes what
//! they mustn't see, and they send *intents* that the host checks
//! ([`policy::authorize`]) before carrying them out through its own code.
//!
//! Messages travel through a relay that only reads a routing header and
//! forwards the body untouched (see `docs/multiplayer-plan.md`). This module
//! is the body: what the host sends ([`HostMsg`]), what a guest sends
//! ([`GuestMsg`]), the host's outbox that numbers them ([`outbox`]) and the
//! guest's copy that applies them in order ([`replica`]).
//!
//! Beyond watching, a driver steers the run and answers the approvals the
//! owner delegated; a collaborator suggests messages for the driver (or the
//! owner) to accept, and comments. What anyone did is kept in the host's
//! audit log ([`audit`]). Control changes hands by request and acceptance,
//! and the owner can step away ([`control`]).

pub mod audit;
pub mod control;
pub mod crypto;
pub mod outbox;
pub mod policy;
pub mod redact;
pub mod replica;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::agent::Author;
use crate::agent::{Op, RunStatus};
pub use control::{AwayMode, AwayPolicy, ControlRequest};

/// The protocol's major version, carried by every body as `v`.
pub const PROTOCOL_VERSION: u32 = 1;
/// The oldest version a host still speaks.
pub const MIN_VERSION: u32 = 1;

/// What someone in a share may do. Owner actions never arrive over the
/// network: the owner acts through their own app, so a remote peer is at most
/// a driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Owner,
    Driver,
    Collaborator,
    Viewer,
}

/// Someone in a share, as the host knows them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: String,
    pub name: String,
    /// A `data:` image or a built-in avatar id; never a URL to fetch.
    #[serde(default)]
    pub image: Option<String>,
    pub role: Role,
    #[serde(default)]
    pub online: bool,
}

impl Member {
    pub fn author(&self) -> Author {
        Author { user_id: self.user_id.clone(), name: self.name.clone(), image: self.image.clone() }
    }
}

/// What the owner lets guests do beyond watching.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePolicy {
    /// Guests may list the workspace and open any file in it (secret-looking ones never).
    #[serde(default)]
    pub browse_files: bool,
    /// Approvals the driver may answer for the owner (`policy::may_answer`).
    #[serde(default)]
    pub delegation: Delegation,
    /// What happens to the run while the owner is away.
    #[serde(default)]
    pub away: AwayPolicy,
    /// Keep the page open in the owner's built-in browser to themselves. Off by
    /// default: guests follow the page (its address, never its content).
    #[serde(default)]
    pub hide_browser: bool,
    /// In a notebook's chat, guests may read the passages it cites (`Intent::GetPassage`).
    /// Off by default: guests see which sources are cited, not their text.
    #[serde(default)]
    pub show_sources: bool,
}

/// The page open in the host's built-in browser, as guests follow it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPage {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub loading: bool,
    /// The host's address on its local network, so a guest can reach a page
    /// the host serves itself (`localhost` there means the guest's own machine).
    #[serde(default)]
    pub lan_host: Option<String>,
}

/// Kinds of approval the owner hands to the driver. All off by default: the
/// driver then answers only the model's questions. Reading a secret file is
/// never delegated.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delegation {
    /// File changes and commits.
    #[serde(default)]
    pub edits: bool,
    /// Commands in the sandbox, without network.
    #[serde(default)]
    pub shell: bool,
    /// Commands with network or outside the sandbox, and merges into another branch.
    #[serde(default)]
    pub escalated: bool,
    /// Connector tools, which act with the owner's accounts.
    #[serde(default)]
    pub connectors: bool,
    /// Opening a site in the built-in browser.
    #[serde(default)]
    pub browser: bool,
    /// Undoing a turn's file changes.
    #[serde(default)]
    pub undo: bool,
}

/// A message a collaborator suggests, waiting for the driver (or the owner) to send it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    pub author: Author,
    pub text: String,
    /// Image attachments, as `file` parts with blob URLs the host stored.
    #[serde(default)]
    pub files: Vec<Value>,
    pub at: i64,
}

/// A remark beside the session. Never part of the thread, never sent to the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: Author,
    pub text: String,
    /// The message it's about, if any.
    #[serde(default)]
    pub message_id: Option<String>,
    pub at: i64,
}

/// Who's in a share and what they've said, as it stands.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Room {
    pub members: Vec<Member>,
    pub policy: SharePolicy,
    pub suggestions: Vec<Suggestion>,
    pub comments: Vec<Comment>,
    pub audit: Vec<audit::Entry>,
    /// People asking for control, oldest first.
    pub requests: Vec<ControlRequest>,
    /// Since when the owner is away, if they are.
    pub owner_away: Option<i64>,
    /// The page in the owner's browser, unless they keep it to themselves.
    pub browser: Option<BrowserPage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThreadKind {
    Chat,
    Cowork,
}

/// The shared session as guests see it. The workspace's path is never sent, only its name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub title: String,
    pub kind: ThreadKind,
    #[serde(default)]
    pub workspace_name: Option<String>,
    pub host_name: String,
}

/// The files one turn changed (secret-looking paths left out).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFiles {
    pub turn_id: String,
    pub paths: Vec<String>,
}

/// One thread of the share as it stands: the session itself (`child: None`)
/// or one of its sub-agents' threads, by the call that started it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadState {
    #[serde(default)]
    pub child: Option<String>,
    pub messages: Vec<Value>,
    pub status: RunStatus,
    #[serde(default)]
    pub error: Option<String>,
}

/// From the host to guests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum HostMsg {
    /// Everything a guest needs to start from; later messages follow `seq`.
    Snapshot {
        epoch: u64,
        seq: u64,
        thread: ThreadInfo,
        /// The session first, then its sub-agents' threads.
        threads: Vec<ThreadState>,
        /// Tool calls in flight.
        running: Vec<String>,
        turns: Vec<TurnFiles>,
        members: Vec<Member>,
        policy: SharePolicy,
        #[serde(default)]
        suggestions: Vec<Suggestion>,
        #[serde(default)]
        comments: Vec<Comment>,
        /// The latest entries of the audit log, oldest first.
        #[serde(default)]
        audit: Vec<audit::Entry>,
        #[serde(default)]
        requests: Vec<ControlRequest>,
        #[serde(default)]
        owner_away: Option<i64>,
        #[serde(default)]
        browser: Option<BrowserPage>,
    },
    Op { epoch: u64, seq: u64, #[serde(default)] child: Option<String>, op: Op },
    Status { epoch: u64, seq: u64, #[serde(default)] child: Option<String>, status: RunStatus, error: Option<String> },
    ToolRunning { epoch: u64, seq: u64, call_id: String, running: bool },
    FilesChanged { epoch: u64, seq: u64, turns: Vec<TurnFiles> },
    /// Who is in the share and what they may do, who asks for control,
    /// whether the owner is away, and the page in the owner's browser, after any change.
    Members {
        epoch: u64,
        seq: u64,
        members: Vec<Member>,
        policy: SharePolicy,
        #[serde(default)]
        requests: Vec<ControlRequest>,
        #[serde(default)]
        owner_away: Option<i64>,
        #[serde(default)]
        browser: Option<BrowserPage>,
    },
    /// The title or the like changed.
    Thread { epoch: u64, seq: u64, thread: ThreadInfo },
    /// The suggestions waiting, after any change.
    Queue { epoch: u64, seq: u64, suggestions: Vec<Suggestion> },
    /// A new comment.
    Comment { epoch: u64, seq: u64, comment: Comment },
    /// A new entry in the audit log.
    Audit { epoch: u64, seq: u64, entry: audit::Entry },
    /// The answer to one intent.
    Reply {
        re: String,
        ok: bool,
        #[serde(default)]
        data: Option<Value>,
        #[serde(default)]
        error: Option<String>,
    },
    /// The guest's version is one the host can't speak.
    Incompatible { host_v: u32, min_v: u32 },
    /// A new content key, sealed for this guest's device (`crypto::seal_for`):
    /// someone was removed, or the guest came back after one was.
    Rekey { generation: u32, sealed: String },
}

impl HostMsg {
    /// `(epoch, seq)` for messages that are part of the ordered stream.
    pub fn order(&self) -> Option<(u64, u64)> {
        match self {
            HostMsg::Snapshot { epoch, seq, .. }
            | HostMsg::Op { epoch, seq, .. }
            | HostMsg::Status { epoch, seq, .. }
            | HostMsg::ToolRunning { epoch, seq, .. }
            | HostMsg::FilesChanged { epoch, seq, .. }
            | HostMsg::Members { epoch, seq, .. }
            | HostMsg::Thread { epoch, seq, .. }
            | HostMsg::Queue { epoch, seq, .. }
            | HostMsg::Comment { epoch, seq, .. }
            | HostMsg::Audit { epoch, seq, .. } => Some((*epoch, *seq)),
            HostMsg::Reply { .. } | HostMsg::Incompatible { .. } | HostMsg::Rekey { .. } => None,
        }
    }
}

/// From a guest to the host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum GuestMsg {
    /// Sent once admitted (and again after the host comes back): asks for a snapshot.
    Hello {
        min_v: u32,
        #[serde(default)]
        caps: Vec<String>,
        /// In an encrypted share, this join's device keys: the host binds them
        /// to the sender and checks every later message's signature.
        #[serde(default)]
        device: Option<crypto::DeviceKeys>,
    },
    /// The guest lost its place (a gap, or a message it couldn't read): asks for a fresh snapshot.
    Resync {
        #[serde(default)]
        last_seq: u64,
    },
    Intent { id: String, intent: Intent },
}

/// Something a guest asks the host to do: a read, or (for a driver or a
/// collaborator) a change to the session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Intent {
    /// The turns that changed files, with their paths.
    GetTurnChanges,
    /// Before and after of each file one turn changed.
    GetDiff { turn_id: String },
    /// A file's text: one the session's tool calls named, or any if the owner allows browsing.
    GetFile { path: String },
    /// One folder level, if the owner allows browsing.
    ListDir {
        #[serde(default)]
        path: String,
    },
    /// An attachment the shared thread shows.
    GetBlob { sha: String },
    /// The folder's git history, for the graph (a Cowork session).
    GitLog {
        #[serde(default)]
        limit: usize,
        #[serde(default)]
        all: bool,
    },
    /// One commit's message and changed files.
    GitCommit { sha: String },
    /// The branch against its base, for the pull request card.
    BranchStatus {
        #[serde(default)]
        base: Option<String>,
    },
    /// The branch's pull request and its CI checks (`workspace::ci`).
    PrChecks {
        #[serde(default)]
        pr: Option<u64>,
    },
    /// Why a failed CI job failed.
    CheckFailure { job: u64 },
    /// A notebook chat's notebook as guests may see it: its title, its sources'
    /// titles and its Studio outputs; never the sources' text or the owner's notes.
    GetNotebook,
    /// One cited passage's text (`sushsrc:` address), if the owner shares sources.
    GetPassage { url: String },
    /// A message for the run: a driver's joins it, a collaborator's waits as a suggestion.
    Steer {
        #[serde(default)]
        text: String,
        #[serde(default)]
        images: Vec<Image>,
    },
    /// Send a suggestion, as it is or with the driver's edits.
    SuggestionAccept {
        id: String,
        #[serde(default)]
        text: Option<String>,
    },
    SuggestionDrop { id: String },
    /// "Send now": the messages waiting join the run at once.
    SendNow,
    Stop,
    /// Carry on with a stopped reply.
    Resume,
    /// Answer a tool call waiting for approval, on the session (`child: None`)
    /// or a sub-agent's thread. `answer` only for the model's questions.
    Respond {
        #[serde(default)]
        child: Option<String>,
        call_id: String,
        decision: Decision,
        #[serde(default)]
        answer: Option<Value>,
    },
    Comment {
        text: String,
        #[serde(default)]
        message_id: Option<String>,
    },
    /// Ask the driver (or the owner) for control.
    RequestControl,
    /// The driver lets someone who asked drive.
    AcceptControl { user_id: String },
    /// The driver turns a request down.
    DeclineControl { user_id: String },
    /// The driver hands control to someone in the share.
    PassControl { user_id: String },
    /// The driver gives control back to the owner.
    ReleaseControl,
    /// Put back the files a turn changed (or one of them), if the owner lets the driver undo.
    Undo {
        turn_id: String,
        #[serde(default)]
        path: Option<String>,
    },
}

/// An image a guest attaches to a message, base64 encoded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub media_type: String,
    pub data: String,
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    Approve,
    Deny,
}

/// A message body with its version: `{ "v": 1, "type": …, … }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Body<T> {
    pub v: u32,
    #[serde(flatten)]
    pub msg: T,
}

impl<T: Serialize> Body<T> {
    pub fn encode(msg: T) -> String {
        serde_json::to_string(&Body { v: PROTOCOL_VERSION, msg }).expect("share messages serialize")
    }
}

/// Read a body. `Err` for a malformed one or one of a version this side can't read.
pub fn decode<T: for<'de> Deserialize<'de>>(text: &str) -> Result<T, String> {
    let body: Body<Value> = serde_json::from_str(text).map_err(|e| format!("Unreadable message: {e}"))?;
    if body.v < MIN_VERSION || body.v > PROTOCOL_VERSION {
        return Err(format!("Protocol version {} isn't supported (this app speaks {MIN_VERSION}–{PROTOCOL_VERSION}).", body.v));
    }
    serde_json::from_value(body.msg).map_err(|e| format!("Unreadable message: {e}"))
}

/// The thread id a guest shows a share under, and its sub-agents' threads under.
pub fn guest_thread_id(share_id: &str) -> String {
    format!("shared:{share_id}")
}

/// Whether a thread id is one of a share this app joined.
pub fn is_guest_thread(thread_id: &str) -> bool {
    thread_id.starts_with("shared:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bodies_carry_their_version_and_tag() {
        let text = Body::encode(GuestMsg::Intent { id: "i1".into(), intent: Intent::GetDiff { turn_id: "t".into() } });
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value, json!({ "v": 1, "type": "intent", "id": "i1", "intent": { "kind": "get-diff", "turnId": "t" } }));
        let back: GuestMsg = decode(&text).unwrap();
        assert_eq!(back, GuestMsg::Intent { id: "i1".into(), intent: Intent::GetDiff { turn_id: "t".into() } });
    }

    #[test]
    fn other_versions_and_unknown_types_are_refused() {
        assert!(decode::<GuestMsg>(r#"{ "v": 99, "type": "hello", "minV": 1 }"#).is_err());
        assert!(decode::<GuestMsg>(r#"{ "v": 1, "type": "take-over-the-host" }"#).is_err());
        assert!(decode::<GuestMsg>(r#"{ "v": 1, "type": "intent", "id": "x", "intent": { "kind": "run-shell" } }"#).is_err());
        // Fields added later within a version are ignored.
        assert!(decode::<GuestMsg>(r#"{ "v": 1, "type": "hello", "minV": 1, "future": true }"#).is_ok());
    }

    #[test]
    fn phase_two_intents_round_trip() {
        let intents = [
            (json!({ "kind": "steer", "text": "try again" }), Intent::Steer { text: "try again".into(), images: vec![] }),
            (
                json!({ "kind": "respond", "callId": "c", "decision": "approve" }),
                Intent::Respond { child: None, call_id: "c".into(), decision: Decision::Approve, answer: None },
            ),
            (json!({ "kind": "suggestion-accept", "id": "s" }), Intent::SuggestionAccept { id: "s".into(), text: None }),
            (json!({ "kind": "send-now" }), Intent::SendNow),
            (json!({ "kind": "comment", "text": "nice" }), Intent::Comment { text: "nice".into(), message_id: None }),
            (json!({ "kind": "request-control" }), Intent::RequestControl),
            (json!({ "kind": "pass-control", "userId": "u" }), Intent::PassControl { user_id: "u".into() }),
            (json!({ "kind": "accept-control", "userId": "u" }), Intent::AcceptControl { user_id: "u".into() }),
            (json!({ "kind": "release-control" }), Intent::ReleaseControl),
            (json!({ "kind": "undo", "turnId": "t", "path": "a.rs" }), Intent::Undo { turn_id: "t".into(), path: Some("a.rs".into()) }),
            (json!({ "kind": "git-log", "limit": 200, "all": true }), Intent::GitLog { limit: 200, all: true }),
            (json!({ "kind": "git-commit", "sha": "abc1234" }), Intent::GitCommit { sha: "abc1234".into() }),
            (json!({ "kind": "branch-status" }), Intent::BranchStatus { base: None }),
            (json!({ "kind": "pr-checks", "pr": 128 }), Intent::PrChecks { pr: Some(128) }),
            (json!({ "kind": "check-failure", "job": 42 }), Intent::CheckFailure { job: 42 }),
            (json!({ "kind": "get-notebook" }), Intent::GetNotebook),
            (json!({ "kind": "get-passage", "url": "sushsrc:s1/7" }), Intent::GetPassage { url: "sushsrc:s1/7".into() }),
        ];
        for (wire, intent) in intents {
            let text = Body::encode(GuestMsg::Intent { id: "i".into(), intent: intent.clone() });
            let value: Value = serde_json::from_str(&text).unwrap();
            for (k, v) in wire.as_object().unwrap() {
                assert_eq!(&value["intent"][k], v, "{k}");
            }
            assert_eq!(decode::<GuestMsg>(&text).unwrap(), GuestMsg::Intent { id: "i".into(), intent });
        }
    }

    #[test]
    fn a_phase_one_snapshot_still_reads() {
        let old = json!({ "v": 1, "type": "snapshot", "epoch": 1, "seq": 0,
            "thread": { "title": "t", "kind": "chat", "hostName": "h" },
            "threads": [], "running": [], "turns": [], "members": [], "policy": { "browseFiles": true } });
        let HostMsg::Snapshot { policy, suggestions, requests, owner_away, .. } = decode::<HostMsg>(&old.to_string()).unwrap() else { panic!() };
        assert!(policy.browse_files && !policy.delegation.edits && suggestions.is_empty());
        assert!(requests.is_empty() && owner_away.is_none() && !policy.delegation.undo);
        assert_eq!(policy.away.mode, AwayMode::Pause);
        assert!(!policy.hide_browser);
    }

    #[test]
    fn members_carry_the_hosts_browser_page_and_older_ones_still_read() {
        let page = BrowserPage { url: "http://localhost:3001/".into(), title: "App".into(), loading: false, lan_host: Some("192.168.1.11".into()) };
        let msg = HostMsg::Members { epoch: 1, seq: 3, members: vec![], policy: SharePolicy::default(), requests: vec![], owner_away: None, browser: Some(page.clone()) };
        let value: Value = serde_json::from_str(&Body::encode(msg.clone())).unwrap();
        assert_eq!(value["browser"], json!({ "url": "http://localhost:3001/", "title": "App", "loading": false, "lanHost": "192.168.1.11" }));
        assert_eq!(decode::<HostMsg>(&value.to_string()).unwrap(), msg);
        let old = json!({ "v": 1, "type": "members", "epoch": 1, "seq": 3, "members": [], "policy": {} });
        let HostMsg::Members { browser, .. } = decode::<HostMsg>(&old.to_string()).unwrap() else { panic!() };
        assert!(browser.is_none());
    }

    #[test]
    fn ops_go_out_in_the_shape_the_ui_applies() {
        let msg = HostMsg::Op { epoch: 1, seq: 2, child: None, op: Op::AppendText { index: 1, delta: "hi".into() } };
        let value: Value = serde_json::from_str(&Body::encode(msg)).unwrap();
        assert_eq!(value["op"], json!({ "type": "append-text", "index": 1, "delta": "hi" }));
    }
}
