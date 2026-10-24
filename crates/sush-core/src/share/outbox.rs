//! The host's side of the ordered stream: what happened to the shared thread,
//! redacted and numbered for guests.
//!
//! The host pushes each change as it happens and flushes every few dozen
//! milliseconds; text deltas arriving in between are merged, so a streamed
//! reply goes out as a few messages rather than one per token. A snapshot is
//! taken right after a flush, so it carries the number the next message follows.

use serde_json::Value;

use super::{redact, HostMsg, Member, SharePolicy, ThreadInfo, ThreadState, TurnFiles};
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
    Members { members: Vec<Member>, policy: SharePolicy },
    Thread { thread: ThreadInfo },
}

#[derive(Debug)]
pub struct Outbox {
    epoch: u64,
    seq: u64,
    pending: Vec<Event>,
}

impl Outbox {
    pub fn new(epoch: u64) -> Self {
        Self { epoch, seq: 0, pending: Vec::new() }
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
            Event::Op { child, op } => Event::Op { child, op: redact::op(&op) },
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
                    Event::Members { members, policy } => HostMsg::Members { epoch, seq, members, policy },
                    Event::Thread { thread } => HostMsg::Thread { epoch, seq, thread },
                }
            })
            .collect()
    }

    /// A snapshot that follows the last flushed message. Flush first: anything
    /// still pending is already part of `threads` and must not be sent again.
    #[allow(clippy::too_many_arguments)]
    pub fn snapshot(
        &self,
        thread: ThreadInfo,
        threads: Vec<ThreadState>,
        running: Vec<String>,
        turns: Vec<TurnFiles>,
        members: Vec<Member>,
        policy: SharePolicy,
    ) -> HostMsg {
        debug_assert!(self.pending.is_empty(), "flush before taking a snapshot");
        let threads = threads
            .into_iter()
            .map(|t| ThreadState { messages: redact::messages(&t.messages), ..t })
            .collect();
        HostMsg::Snapshot { epoch: self.epoch, seq: self.seq, thread, threads, running, turns, members, policy }
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
        out.push(text(1, "Hel"));
        out.push(text(1, "lo"));
        out.push(text(2, "!"));
        out.push(Event::Status { child: None, status: RunStatus::Ready, error: None });
        let sent = out.flush();
        assert_eq!(sent.len(), 3);
        assert_eq!(sent[0], HostMsg::Op { epoch: 1, seq: 1, child: None, op: Op::AppendText { index: 1, delta: "Hello".into() } });
        assert_eq!(sent[2].order(), Some((1, 3)));
        out.push(text(1, "more"));
        assert_eq!(out.flush()[0].order(), Some((1, 4)));
    }

    #[test]
    fn deltas_for_different_threads_stay_apart() {
        let mut out = Outbox::new(1);
        out.push(text(1, "a"));
        out.push(Event::Op { child: Some("call".into()), op: Op::AppendText { index: 1, delta: "b".into() } });
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
    fn a_snapshot_follows_the_last_flush() {
        let mut out = Outbox::new(2);
        out.push(text(0, "x"));
        out.flush();
        let info = ThreadInfo { title: "t".into(), kind: super::super::ThreadKind::Chat, workspace_name: None, host_name: "h".into() };
        let snap = out.snapshot(info, vec![], vec![], vec![], vec![], SharePolicy::default());
        assert_eq!(snap.order(), Some((2, 1)));
        out.next_epoch();
        out.push(text(0, "y"));
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
