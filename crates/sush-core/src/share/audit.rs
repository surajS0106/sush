//! What happened in a shared session, and who did it: the host's audit log.
//!
//! The host writes an entry for everything a guest (or the owner, on a shared
//! session) does that changes it, and for intents it refused. Entries are kept
//! in the host's `sush.db` (`Store::add_share_event`) and sent to members; the
//! relay never sees them in the clear any more than it sees the rest. Details
//! hold ids and short previews, never whole messages (comments aside, which
//! are short by rule).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Entries a snapshot carries, and a share keeps in memory, at most.
pub const KEEP: usize = 100;
/// Characters of a message kept in an entry.
const PREVIEW: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Joined,
    Left,
    Steered,
    Suggested,
    Accepted,
    Dropped,
    Approved,
    Denied,
    Answered,
    Interrupted,
    Stopped,
    Resumed,
    Commented,
    /// The owner changed someone's role, or what the driver may approve.
    Role,
    Kicked,
    /// The host refused something a guest asked for.
    DeniedIntent,
    Ended,
    /// Files a turn changed were put back.
    Undid,
    /// Control was asked for, handed over, declined or taken back.
    Control,
    /// The owner stepped away, or came back.
    Away,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Joined => "joined",
            Kind::Left => "left",
            Kind::Steered => "steered",
            Kind::Suggested => "suggested",
            Kind::Accepted => "accepted",
            Kind::Dropped => "dropped",
            Kind::Approved => "approved",
            Kind::Denied => "denied",
            Kind::Answered => "answered",
            Kind::Interrupted => "interrupted",
            Kind::Stopped => "stopped",
            Kind::Resumed => "resumed",
            Kind::Commented => "commented",
            Kind::Role => "role",
            Kind::Kicked => "kicked",
            Kind::DeniedIntent => "denied-intent",
            Kind::Ended => "ended",
            Kind::Undid => "undid",
            Kind::Control => "control",
            Kind::Away => "away",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        serde_json::from_value(Value::String(s.to_string())).ok()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub at: i64,
    pub actor_user_id: String,
    pub actor_name: String,
    pub kind: Kind,
    #[serde(default)]
    pub detail: Value,
}

/// The start of a message, for an entry's detail.
pub fn preview(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(PREVIEW) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

/// Add an entry to a share's in-memory log, keeping the latest `KEEP`.
pub fn push(log: &mut Vec<Entry>, entry: Entry) {
    log.push(entry);
    if log.len() > KEEP {
        let extra = log.len() - KEEP;
        log.drain(..extra);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn previews_are_short_and_cut_on_characters() {
        assert_eq!(preview("  hi  "), "hi");
        let long = "é".repeat(200);
        let p = preview(&long);
        assert_eq!(p.chars().count(), PREVIEW + 1);
        assert!(p.ends_with('…'));
    }

    #[test]
    fn kinds_have_stable_names() {
        for kind in [Kind::DeniedIntent, Kind::Steered, Kind::Role] {
            assert_eq!(Kind::parse(kind.as_str()), Some(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.as_str()));
        }
        assert_eq!(Kind::parse("nope"), None);
    }

    #[test]
    fn the_log_keeps_the_latest() {
        let mut log = Vec::new();
        for i in 0..(KEEP + 5) {
            push(&mut log, Entry { at: i as i64, actor_user_id: "u".into(), actor_name: "U".into(), kind: Kind::Steered, detail: Value::Null });
        }
        assert_eq!(log.len(), KEEP);
        assert_eq!(log[0].at, 5);
    }
}
