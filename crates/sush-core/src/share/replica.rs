//! A guest's copy of a shared session: the host's messages applied in order.
//!
//! Nothing applies before a snapshot. After it, each ordered message must be
//! the next one of the same epoch; anything else (a gap, a new epoch) means
//! the copy can't be trusted, so it waits for a fresh snapshot and asks for
//! one. The copy is kept so a reloaded page can catch up, like a live run's.

use std::collections::BTreeMap;

use serde_json::Value;

use super::{audit, Comment, ControlRequest, HostMsg, Member, SharePolicy, Suggestion, ThreadInfo, ThreadState, TurnFiles};
use crate::agent::ui::{self, Op};
use crate::agent::RunStatus;

/// Comments a copy keeps, at most.
pub const MAX_COMMENTS: usize = 200;

/// What to do with a message from the host.
#[derive(Debug, Clone, PartialEq)]
pub enum Applied {
    /// It changed the copy; tell the UI.
    Changed(Change),
    /// Old, a duplicate, or before the first snapshot: nothing to do.
    Ignored,
    /// Out of order: ask the host for a snapshot.
    Resync,
}

/// A change for the UI, by thread (`None`: the session itself).
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    /// The whole copy was replaced.
    Snapshot,
    Op { child: Option<String>, op: Op },
    Status { child: Option<String>, status: RunStatus, error: Option<String> },
    ToolRunning { call_id: String, running: bool },
    FilesChanged,
    Members,
    Thread,
    Queue,
    Comment,
    Audit,
}

#[derive(Debug, Default)]
pub struct Replica {
    /// `(epoch, seq)` of the last message applied; None until a snapshot arrives.
    at: Option<(u64, u64)>,
    pub thread: Option<ThreadInfo>,
    /// The session (`None`) and its sub-agents' threads.
    pub threads: BTreeMap<Option<String>, ThreadState>,
    pub running: std::collections::BTreeSet<String>,
    pub turns: Vec<TurnFiles>,
    pub members: Vec<Member>,
    pub policy: SharePolicy,
    pub suggestions: Vec<Suggestion>,
    pub comments: Vec<Comment>,
    pub audit: Vec<audit::Entry>,
    pub requests: Vec<ControlRequest>,
    /// Since when the host is away, if they are.
    pub owner_away: Option<i64>,
}

impl Replica {
    pub fn has_snapshot(&self) -> bool {
        self.at.is_some()
    }

    /// The last message applied, for a `resync`.
    pub fn last_seq(&self) -> u64 {
        self.at.map_or(0, |(_, s)| s)
    }

    pub fn apply(&mut self, msg: HostMsg) -> Applied {
        if let HostMsg::Snapshot { epoch, seq, thread, threads, running, turns, members, policy, suggestions, comments, audit, requests, owner_away } =
            msg
        {
            self.requests = requests;
            self.owner_away = owner_away;
            self.suggestions = suggestions;
            self.comments = comments;
            self.audit = audit;
            self.at = Some((epoch, seq));
            self.thread = Some(thread);
            self.threads = threads
                .into_iter()
                .map(|t| (t.child.clone(), ThreadState { messages: t.messages.iter().map(localize_message).collect(), ..t }))
                .collect();
            self.running = running.into_iter().collect();
            self.turns = turns;
            self.members = members;
            self.policy = policy;
            return Applied::Changed(Change::Snapshot);
        }
        let Some((epoch, seq)) = msg.order() else { return Applied::Ignored };
        let Some((at_epoch, at_seq)) = self.at else { return Applied::Ignored };
        // Left over from before the host's last restart.
        if epoch < at_epoch {
            return Applied::Ignored;
        }
        if epoch > at_epoch || seq > at_seq + 1 {
            // Lost our place: nothing applies until the next snapshot.
            self.at = None;
            return Applied::Resync;
        }
        if seq <= at_seq {
            return Applied::Ignored;
        }
        self.at = Some((epoch, seq));
        let change = match msg {
            HostMsg::Op { child, op, .. } => {
                let op = localize_op(&op);
                let thread = self.thread_mut(&child);
                ui::apply(&mut thread.messages, &op);
                Change::Op { child, op }
            }
            HostMsg::Status { child, status, error, .. } => {
                let thread = self.thread_mut(&child);
                thread.status = status;
                thread.error = error.clone();
                Change::Status { child, status, error }
            }
            HostMsg::ToolRunning { call_id, running, .. } => {
                if running {
                    self.running.insert(call_id.clone());
                } else {
                    self.running.remove(&call_id);
                }
                Change::ToolRunning { call_id, running }
            }
            HostMsg::FilesChanged { turns, .. } => {
                self.turns = turns;
                Change::FilesChanged
            }
            HostMsg::Members { members, policy, requests, owner_away, .. } => {
                self.members = members;
                self.policy = policy;
                self.requests = requests;
                self.owner_away = owner_away;
                Change::Members
            }
            HostMsg::Thread { thread, .. } => {
                self.thread = Some(thread);
                Change::Thread
            }
            HostMsg::Queue { suggestions, .. } => {
                self.suggestions = suggestions;
                Change::Queue
            }
            HostMsg::Comment { comment, .. } => {
                self.comments.push(comment);
                if self.comments.len() > MAX_COMMENTS {
                    self.comments.remove(0);
                }
                Change::Comment
            }
            HostMsg::Audit { entry, .. } => {
                audit::push(&mut self.audit, entry);
                Change::Audit
            }
            HostMsg::Snapshot { .. } | HostMsg::Reply { .. } | HostMsg::Incompatible { .. } | HostMsg::Rekey { .. } => return Applied::Ignored,
        };
        Applied::Changed(change)
    }

    fn thread_mut(&mut self, child: &Option<String>) -> &mut ThreadState {
        self.threads.entry(child.clone()).or_insert_with(|| ThreadState {
            child: child.clone(),
            messages: Vec::new(),
            status: RunStatus::Ready,
            error: None,
        })
    }
}

/// Blob URLs in the form this platform's webview loads (the host's may differ).
pub fn localize_op(op: &Op) -> Op {
    match op {
        Op::Reset { messages } => Op::Reset { messages: messages.iter().map(localize_message).collect() },
        Op::Push { message } => Op::Push { message: localize_message(message) },
        Op::PushPart { part } => Op::PushPart { part: localize_part(part) },
        Op::SetPart { index, part } => Op::SetPart { index: *index, part: localize_part(part) },
        Op::AppendText { .. } | Op::SetMetadata { .. } => op.clone(),
    }
}

fn localize_message(message: &Value) -> Value {
    let mut out = message.clone();
    if let Some(parts) = out.get_mut("parts").and_then(Value::as_array_mut) {
        for p in parts.iter_mut() {
            *p = localize_part(p);
        }
    }
    out
}

fn localize_part(part: &Value) -> Value {
    let mut out = part.clone();
    if part.get("type").and_then(Value::as_str) == Some("file") {
        if let Some(sha) = part.get("url").and_then(Value::as_str).and_then(crate::store::blob_sha) {
            out["url"] = Value::String(crate::store::blob_url(sha));
        } else if part.get("url").and_then(Value::as_str).is_some_and(|u| !u.starts_with("data:")) {
            // Anything else would have the guest's webview fetch from wherever the host pointed it.
            out["url"] = Value::String(String::new());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::share::{outbox::Event, outbox::Outbox, Author, Room, ThreadKind};
    use serde_json::json;

    fn info() -> ThreadInfo {
        ThreadInfo { title: "t".into(), kind: ThreadKind::Cowork, workspace_name: Some("sush".into()), host_name: "Suraj".into() }
    }

    fn snapshot(out: &Outbox, messages: Vec<Value>) -> HostMsg {
        let threads = vec![ThreadState { child: None, messages, status: RunStatus::Streaming, error: None }];
        out.snapshot(info(), threads, vec![], vec![], Room::default())
    }

    #[test]
    fn suggestions_comments_and_the_log_follow_the_host() {
        let mut out = Outbox::new(1);
        let mut guest = Replica::default();
        guest.apply(snapshot(&out, vec![]));
        let author = Author { user_id: "u".into(), name: "Shruti".into(), image: None };
        let suggestion = Suggestion { id: "s".into(), author: author.clone(), text: "try tabs".into(), files: vec![], at: 1 };
        out.push(Event::Queue { suggestions: vec![suggestion.clone()] });
        out.push(Event::Comment { comment: Comment { id: "c".into(), author, text: "nice".into(), message_id: None, at: 2 } });
        let entry = audit::Entry { at: 3, actor_user_id: "u".into(), actor_name: "Shruti".into(), kind: audit::Kind::Suggested, detail: json!({}) };
        out.push(Event::Audit { entry: entry.clone() });
        let changes: Vec<Applied> = out.flush().into_iter().map(|m| guest.apply(m)).collect();
        assert_eq!(changes, [Applied::Changed(Change::Queue), Applied::Changed(Change::Comment), Applied::Changed(Change::Audit)]);
        assert_eq!(guest.suggestions, [suggestion]);
        assert_eq!(guest.comments[0].text, "nice");
        assert_eq!(guest.audit, [entry]);
    }

    /// The host's thread, as Rust applies the run's ops, and the guest's copy must end up the same.
    #[test]
    fn a_replica_follows_the_host() {
        let mut host = vec![json!({ "id": "u", "role": "user", "parts": [{ "type": "text", "text": "hi" }] })];
        let mut out = Outbox::new(1);
        let mut guest = Replica::default();
        assert_eq!(guest.apply(snapshot(&out, host.clone())), Applied::Changed(Change::Snapshot));

        let ops = [
            Op::Push { message: json!({ "id": "a", "role": "assistant", "parts": [] }) },
            Op::PushPart { part: json!({ "type": "text", "text": "", "state": "streaming" }) },
            Op::AppendText { index: 0, delta: "Hel".into() },
            Op::AppendText { index: 0, delta: "lo".into() },
            Op::SetMetadata { metadata: json!({ "model": "m" }) },
        ];
        for op in ops {
            ui::apply(&mut host, &op);
            out.push(Event::Op { child: None, op });
        }
        out.push(Event::Status { child: None, status: RunStatus::Ready, error: None });
        for msg in out.flush() {
            assert!(matches!(guest.apply(msg), Applied::Changed(_)));
        }
        assert_eq!(guest.threads[&None].messages, host);
        assert_eq!(guest.threads[&None].status, RunStatus::Ready);
    }

    #[test]
    fn nothing_applies_before_a_snapshot_and_duplicates_are_ignored() {
        let mut out = Outbox::new(1);
        let mut guest = Replica::default();
        out.push(Event::ToolRunning { call_id: "c".into(), running: true });
        let early = out.flush();
        assert_eq!(guest.apply(early[0].clone()), Applied::Ignored);
        guest.apply(snapshot(&out, vec![]));
        // Sent before the snapshot was taken, so already part of it.
        assert_eq!(guest.apply(early[0].clone()), Applied::Ignored);
    }

    #[test]
    fn a_gap_or_a_new_epoch_asks_for_a_snapshot() {
        let mut out = Outbox::new(1);
        let mut guest = Replica::default();
        guest.apply(snapshot(&out, vec![]));
        out.push(Event::ToolRunning { call_id: "a".into(), running: true });
        out.push(Event::ToolRunning { call_id: "b".into(), running: true });
        let sent = out.flush();
        assert_eq!(guest.apply(sent[1].clone()), Applied::Resync);
        // Until the next snapshot, nothing applies.
        assert_eq!(guest.apply(sent[0].clone()), Applied::Ignored);
        guest.apply(snapshot(&out, vec![]));
        out.next_epoch();
        out.push(Event::ToolRunning { call_id: "c".into(), running: true });
        assert_eq!(guest.apply(out.flush().remove(0)), Applied::Resync);
    }

    #[test]
    fn sub_agents_threads_are_kept_apart() {
        let mut out = Outbox::new(1);
        let mut guest = Replica::default();
        guest.apply(snapshot(&out, vec![]));
        out.push(Event::Op { child: Some("call1".into()), op: Op::Push { message: json!({ "id": "x", "role": "user", "parts": [] }) } });
        guest.apply(out.flush().remove(0));
        assert_eq!(guest.threads[&Some("call1".to_string())].messages.len(), 1);
        assert!(guest.threads[&None].messages.is_empty());
    }

    #[test]
    fn blob_urls_are_rewritten_for_this_platform_and_others_dropped() {
        let sha = "b".repeat(64);
        let op = Op::PushPart { part: json!({ "type": "file", "mediaType": "image/png", "url": format!("sushblob://localhost/{sha}") }) };
        let Op::PushPart { part } = localize_op(&op) else { panic!() };
        assert_eq!(part["url"], crate::store::blob_url(&sha));
        let op = Op::PushPart { part: json!({ "type": "file", "mediaType": "image/png", "url": "https://tracker.example/pixel.png" }) };
        let Op::PushPart { part } = localize_op(&op) else { panic!() };
        assert_eq!(part["url"], "");
    }
}
