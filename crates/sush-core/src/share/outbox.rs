//! The host's side of the ordered stream: what happened to the shared thread,
//! redacted and numbered for guests.
//!
//! The host pushes each change as it happens and flushes every few dozen
//! milliseconds; text deltas arriving in between are merged, so a streamed
//! reply goes out as a few messages rather than one per token. A snapshot is
//! taken right after a flush, so it carries the number the next message follows.
//!
//! The end of each text stream is held back until no secret can be split
//! across it (`redact::Secrets::safe_cut`); the part's final `SetPart` carries
//! the whole text, redacted, so nothing held is ever sent on its own.

use std::collections::HashMap;

use serde_json::Value;

use super::{audit, redact, Comment, ControlRequest, HostMsg, Member, Room, SharePolicy, Suggestion, ThreadInfo, ThreadState, TurnFiles};
use crate::agent::{Op, RunStatus};

/// Merged text deltas stop growing past this, so one message stays small.
const MAX_MERGED: usize = 16 * 1024;

/// A change to the shared session, before it's numbered.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Op { child: Option<String>, op: Op },
    Status { child: Option<String>, status: RunStatus, error: Option<String> },
    ToolRunning { call_id: String, running: bool },
    FilesChanged { turns: Vec<TurnFiles> },
    Members { members: Vec<Member>, policy: SharePolicy, requests: Vec<ControlRequest>, owner_away: Option<i64> },
    Thread { thread: ThreadInfo },
    Queue { suggestions: Vec<Suggestion> },
    Comment { comment: Comment },
    Audit { entry: audit::Entry },
}

#[derive(Debug)]
pub struct Outbox {
    epoch: u64,
    seq: u64,
    pending: Vec<Event>,
    secrets: redact::Secrets,
    /// The unsent end of each text stream, by thread (`child`) and part index.
    held: HashMap<(Option<String>, usize), String>,
}

impl Outbox {
    pub fn new(epoch: u64) -> Self {
        Self { epoch, seq: 0, pending: Vec::new(), secrets: redact::Secrets::default(), held: HashMap::new() }
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// The number of the last message flushed.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Start over after the host's connection came back: guests take a fresh snapshot.
    pub fn next_epoch(&mut self) {
        self.epoch += 1;
        self.pending.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn push(&mut self, event: Event) {
        let event = match event {
            Event::Op { child, op: Op::AppendText { index, delta } } => {
                let key = (child.clone(), index);
                let mut text = self.held.remove(&key).unwrap_or_default();
                text.push_str(&delta);
                let rest = text.split_off(self.secrets.safe_cut(&text));
                if !rest.is_empty() {
                    self.held.insert(key, rest);
                }
                if text.is_empty() {
                    return;
                }
                Event::Op { child, op: redact::op(&Op::AppendText { index, delta: text }, &self.secrets) }
            }
            Event::Op { child, op } => {
                self.secrets.learn(&op);
                // The part's whole text replaces what was held, or the message is gone.
                match &op {
                    Op::SetPart { index, .. } => {
                        self.held.remove(&(child.clone(), *index));
                    }
                    Op::Push { .. } | Op::Reset { .. } => self.held.retain(|(c, _), _| c != &child),
                    _ => {}
                }
                Event::Op { op: redact::op(&op, &self.secrets), child }
            }
            other => other,
        };
        if let (Some(Event::Op { child: last_child, op: Op::AppendText { index: last, delta: text } }), Event::Op { child, op: Op::AppendText { index, delta } }) =
            (self.pending.last_mut(), &event)
        {
            if last_child == child && last == index && text.len() + delta.len() <= MAX_MERGED {
                text.push_str(delta);
                return;
            }
        }
        self.pending.push(event);
    }

    /// Number what's waiting, in order.
    pub fn flush(&mut self) -> Vec<HostMsg> {
        let epoch = self.epoch;
        std::mem::take(&mut self.pending)
            .into_iter()
            .map(|event| {
                self.seq += 1;
                let seq = self.seq;
                match event {
                    Event::Op { child, op } => HostMsg::Op { epoch, seq, child, op },
                    Event::Status { child, status, error } => HostMsg::Status { epoch, seq, child, status, error },
                    Event::ToolRunning { call_id, running } => HostMsg::ToolRunning { epoch, seq, call_id, running },
                    Event::FilesChanged { turns } => HostMsg::FilesChanged { epoch, seq, turns },
                    Event::Members { members, policy, requests, owner_away } => {
                        HostMsg::Members { epoch, seq, members, policy, requests, owner_away }
                    }
                    Event::Thread { thread } => HostMsg::Thread { epoch, seq, thread },
                    Event::Queue { suggestions } => HostMsg::Queue { epoch, seq, suggestions },
                    Event::Comment { comment } => HostMsg::Comment { epoch, seq, comment },
                    Event::Audit { entry } => HostMsg::Audit { epoch, seq, entry },
                }
            })
            .collect()
    }

    /// A thread as guests have it: without the text still held back, which
    /// later appends will bring.
    fn without_held(&self, thread: &mut ThreadState) {
        for ((child, index), tail) in &self.held {
            if child != &thread.child {
                continue;
            }
            let text = thread.messages.last_mut().and_then(|m| m.get_mut("parts")).and_then(|p| p.get_mut(*index)).and_then(|p| p.get_mut("text"));
            if let Some(Value::String(text)) = text {
                if text.ends_with(tail.as_str()) {
                    text.truncate(text.len() - tail.len());
                }
            }
        }
    }

    /// A snapshot that follows the last flushed message. Flush first: anything
    /// still pending is already part of `threads` and must not be sent again.
    pub fn snapshot(&mut self, thread: ThreadInfo, threads: Vec<ThreadState>, running: Vec<String>, turns: Vec<TurnFiles>, room: Room) -> HostMsg {
        debug_assert!(self.pending.is_empty(), "flush before taking a snapshot");
        for t in &threads {
            self.secrets.learn_messages(&t.messages);
        }
        let threads = threads
            .into_iter()
            .map(|mut t| {
                self.without_held(&mut t);
                ThreadState { messages: redact::messages(&t.messages, &self.secrets), ..t }
            })
            .collect();
        let Room { members, policy, suggestions, comments, audit, requests, owner_away } = room;
        HostMsg::Snapshot {
            epoch: self.epoch,
            seq: self.seq,
            thread,
            threads,
            running,
            turns,
            members,
            policy,
            suggestions,
            comments,
            audit,
            requests,
            owner_away,
        }
    }
}

/// Paths a thread's tool calls named: what guests may open without browsing being allowed.
pub fn touched_paths(messages: &[Value]) -> std::collections::HashSet<String> {
    let mut paths = std::collections::HashSet::new();
    for m in messages {
        for p in crate::agent::ui::parts(m) {
            if p.get("type").and_then(Value::as_str) != Some("dynamic-tool") {
                continue;
            }
            let Some(input) = p.get("input") else { continue };
            for key in ["path", "from", "to"] {
                if let Some(path) = input.get(key).and_then(Value::as_str) {
                    paths.insert(path.replace('\\', "/").trim_start_matches("./").to_string());
                }
            }
        }
    }
    paths
}

/// Blobs a thread's file parts show.
pub fn blob_shas(messages: &[Value]) -> std::collections::HashSet<String> {
    let mut shas = std::collections::HashSet::new();
    for m in messages {
        for p in crate::agent::ui::parts(m) {
            if p.get("type").and_then(Value::as_str) != Some("file") {
                continue;
            }
            if let Some(sha) = p.get("url").and_then(Value::as_str).and_then(crate::store::blob_sha) {
                shas.insert(sha.to_string());
            }
        }
    }
    shas
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(index: usize, delta: &str) -> Event {
        Event::Op { child: None, op: Op::AppendText { index, delta: delta.into() } }
    }

    #[test]
    fn text_deltas_merge_and_messages_are_numbered() {
        let mut out = Outbox::new(1);
        out.push(text(1, "Hello there big "));
        out.push(text(1, "world and more "));
        out.push(text(2, "a b c "));
        out.push(Event::Status { child: None, status: RunStatus::Ready, error: None });
        let sent = out.flush();
        assert_eq!(sent.len(), 3);
        // The last two words of each stream wait for what follows them.
        assert_eq!(sent[0], HostMsg::Op { epoch: 1, seq: 1, child: None, op: Op::AppendText { index: 1, delta: "Hello there big world and ".into() } });
        assert_eq!(sent[1], HostMsg::Op { epoch: 1, seq: 2, child: None, op: Op::AppendText { index: 2, delta: "a b ".into() } });
        assert_eq!(sent[2].order(), Some((1, 3)));
        out.push(text(1, "of it all "));
        assert_eq!(out.flush()[0].order(), Some((1, 4)));
    }

    #[test]
    fn deltas_for_different_threads_stay_apart() {
        let mut out = Outbox::new(1);
        out.push(text(1, "a b c "));
        out.push(Event::Op { child: Some("call".into()), op: Op::AppendText { index: 1, delta: "d e f ".into() } });
        assert_eq!(out.flush().len(), 2);
    }

    #[test]
    fn ops_are_redacted_on_the_way_in() {
        let mut out = Outbox::new(1);
        let part = json!({ "type": "dynamic-tool", "toolName": "chat_read", "toolCallId": "c", "state": "output-available", "input": {}, "output": "secret chat" });
        out.push(Event::Op { child: None, op: Op::SetPart { index: 0, part } });
        let HostMsg::Op { op: Op::SetPart { part, .. }, .. } = &out.flush()[0] else { panic!() };
        assert_eq!(part["output"], redact::PRIVATE);
    }

    #[test]
    fn a_secret_the_model_quotes_is_hidden_even_split_across_deltas() {
        let mut out = Outbox::new(1);
        let read = json!({ "type": "dynamic-tool", "toolName": "fs_read", "toolCallId": "c", "state": "output-available", "input": { "path": ".env" }, "output": "OPENAI_API_KEY=proj-Xy7Qa91LmZ" });
        out.push(Event::Op { child: None, op: Op::SetPart { index: 0, part: read } });
        for delta in ["Your key is proj-Xy7", "Qa91LmZ, keep it ", "safe and private. "] {
            out.push(text(1, delta));
        }
        let streamed: String = out
            .flush()
            .into_iter()
            .filter_map(|m| match m {
                HostMsg::Op { op: Op::AppendText { delta, .. }, .. } => Some(delta),
                _ => None,
            })
            .collect();
        assert!(streamed.contains("Your key is [redacted]"), "{streamed}");
        assert!(!streamed.contains("Xy7") && !streamed.contains("LmZ"), "{streamed}");
        let done = json!({ "type": "text", "text": "Your key is proj-Xy7Qa91LmZ, keep it safe and private.", "state": "done" });
        out.push(Event::Op { child: None, op: Op::SetPart { index: 1, part: done } });
        let HostMsg::Op { op: Op::SetPart { part, .. }, .. } = &out.flush()[0] else { panic!() };
        assert_eq!(part["text"], "Your key is [redacted], keep it safe and private.");
    }

    #[test]
    fn a_snapshot_follows_the_last_flush() {
        let mut out = Outbox::new(2);
        out.push(text(0, "x y z "));
        out.flush();
        let info = ThreadInfo { title: "t".into(), kind: super::super::ThreadKind::Chat, workspace_name: None, host_name: "h".into() };
        let snap = out.snapshot(info, vec![], vec![], vec![], Room::default());
        assert_eq!(snap.order(), Some((2, 1)));
        out.next_epoch();
        out.push(text(0, "and then some "));
        assert_eq!(out.flush()[0].order(), Some((3, 2)));
    }

    #[test]
    fn touched_paths_and_blobs_come_from_the_thread() {
        let messages = vec![
            json!({ "role": "user", "parts": [{ "type": "file", "mediaType": "image/png", "url": crate::store::blob_url(&"a".repeat(64)) }] }),
            json!({ "role": "assistant", "parts": [
                { "type": "dynamic-tool", "toolName": "fs_read", "input": { "path": "./src/a.rs" } },
                { "type": "dynamic-tool", "toolName": "fs_move", "input": { "from": "b.txt", "to": "c\\d.txt" } },
            ]}),
        ];
        let paths = touched_paths(&messages);
        assert!(paths.contains("src/a.rs") && paths.contains("b.txt") && paths.contains("c/d.txt"));
        assert!(blob_shas(&messages).contains(&"a".repeat(64)));
    }
}
