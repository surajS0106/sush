//! What guests never see of a shared thread.
//!
//! Every op passes through here before it leaves the host. Redaction keeps
//! each part where it is (only its content changes), so later ops that name a
//! part by index still land on the right one.
//!
//! - Private tools (memory, past chats): their input and output are replaced.
//! - `fs_read` of a secret-looking file: its output is replaced.
//! - `fs_search`: matches in secret-looking files are dropped.
//! - Every tool's text output and error: well-known credential formats and
//!   `KEY=value` lines naming secrets are masked (`scrub`). This lowers the
//!   chance of a leak; it can't promise none.
//!
//! The model's own text isn't scrubbed: it streams in pieces, and a secret
//! split across two of them would slip through anyway.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::agent::Op;
use crate::workspace::looks_secret;
use crate::workspace::tools::{FS_READ, FS_SEARCH};

pub const SECRET_FILE: &str = "[hidden from guests: secret file]";
pub const PRIVATE: &str = "[private to the host]";
pub const MASK: &str = "[redacted]";

/// Tools whose calls hold the host's own data: memory and other conversations.
const PRIVATE_TOOLS: [&str; 5] = ["memory_write", "memory_delete", "memory_save", "chats_search", "chat_read"];

pub fn op(op: &Op) -> Op {
    match op {
        Op::Reset { messages } => Op::Reset { messages: messages.iter().map(message).collect() },
        Op::Push { message: m } => Op::Push { message: message(m) },
        Op::PushPart { part: p } => Op::PushPart { part: part(p) },
        Op::SetPart { index, part: p } => Op::SetPart { index: *index, part: part(p) },
        Op::AppendText { .. } | Op::SetMetadata { .. } => op.clone(),
    }
}

pub fn messages(messages: &[Value]) -> Vec<Value> {
    messages.iter().map(message).collect()
}

pub fn message(message: &Value) -> Value {
    let mut out = message.clone();
    if let Some(parts) = out.get_mut("parts").and_then(Value::as_array_mut) {
        for p in parts.iter_mut() {
            *p = part(p);
        }
    }
    out
}

pub fn part(part: &Value) -> Value {
    if part.get("type").and_then(Value::as_str) != Some("dynamic-tool") {
        return part.clone();
    }
    let mut out = part.clone();
    let name = part.get("toolName").and_then(Value::as_str).unwrap_or_default();
    if PRIVATE_TOOLS.contains(&name) {
        out["input"] = json!({ "title": PRIVATE, "query": PRIVATE });
        if out.get("output").is_some() {
            out["output"] = json!(PRIVATE);
        }
        return out;
    }
    let path = part.get("input").and_then(|i| i.get("path")).and_then(Value::as_str);
    if name == FS_READ && path.is_some_and(looks_secret) {
        if out.get("output").is_some() {
            out["output"] = json!(SECRET_FILE);
        }
        return out;
    }
    if let Some(Value::String(text)) = out.get_mut("output") {
        if name == FS_SEARCH {
            *text = search_hits(text);
        }
        *text = scrub(text);
    } else if let Some(output) = out.get_mut("output") {
        scrub_strings(output);
    }
    if let Some(Value::String(text)) = out.get_mut("errorText") {
        *text = scrub(text);
    }
    out
}

/// `fs_search` output (`path:line: text`), without the lines from secret-looking files.
fn search_hits(text: &str) -> String {
    text.lines()
        .filter(|line| line.split_once(':').is_none_or(|(path, _)| !looks_secret(path)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn scrub_strings(value: &mut Value) {
    match value {
        Value::String(s) => *s = scrub(s),
        Value::Array(items) => items.iter_mut().for_each(scrub_strings),
        Value::Object(map) => map.values_mut().for_each(scrub_strings),
        _ => {}
    }
}

static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        r"|sk-ant-[A-Za-z0-9_\-]{20,}",
        r"|sk-[A-Za-z0-9_\-]{20,}",
        r"|AKIA[0-9A-Z]{16}",
        r"|gh[pousr]_[A-Za-z0-9]{30,}",
        r"|github_pat_[A-Za-z0-9_]{30,}",
        r"|xox[abposr]-[A-Za-z0-9\-]{10,}",
        r"|AIza[0-9A-Za-z_\-]{35}",
        r"|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}",
        r"|(?i:bearer)\s+[A-Za-z0-9._~+/\-]{16,}=*",
    ))
    .expect("valid regex")
});

/// `NAME=value` (or `export NAME=value`, `NAME: value`) at the start of a line.
static ASSIGNMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*[=:]\s*)(\S.*)$").expect("valid regex"));

/// Mask credentials in text a tool produced.
pub fn scrub(text: &str) -> String {
    let masked = TOKENS.replace_all(text, MASK);
    ASSIGNMENT
        .replace_all(&masked, |c: &regex::Captures| {
            if crate::workspace::shell::is_secret_var(&c[2]) {
                format!("{}{}{}{MASK}", &c[1], &c[2], &c[3])
            } else {
                c[0].to_string()
            }
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, input: Value, output: Value) -> Value {
        json!({ "type": "dynamic-tool", "toolName": name, "toolCallId": "c", "state": "output-available", "input": input, "output": output })
    }

    #[test]
    fn private_tools_are_hidden() {
        let p = part(&tool("memory_write", json!({ "path": "me.md", "content": "my address" }), json!("saved")));
        assert_eq!(p["input"]["title"], PRIVATE);
        assert!(p["input"].get("content").is_none());
        assert_eq!(p["output"], PRIVATE);
        let p = part(&tool("chat_read", json!({ "id": "x" }), json!("the other chat")));
        assert_eq!(p["output"], PRIVATE);
    }

    #[test]
    fn secret_files_read_by_the_agent_are_hidden() {
        let p = part(&tool("fs_read", json!({ "path": "app/.env" }), json!("DB=postgres://u:pw@h")));
        assert_eq!(p["output"], SECRET_FILE);
        let p = part(&tool("fs_read", json!({ "path": ".env.example" }), json!("PORT=3000")));
        assert_eq!(p["output"], "PORT=3000");
    }

    #[test]
    fn search_hits_in_secret_files_are_dropped() {
        let out = "src/a.rs:3: let key = load();\n.env:1: STRIPE_KEY=abc\nkeys/id_rsa:1: -----BEGIN";
        let p = part(&tool("fs_search", json!({ "pattern": "key" }), json!(out)));
        assert_eq!(p["output"], "src/a.rs:3: let key = load();");
    }

    #[test]
    fn credentials_in_output_are_masked() {
        let out = "export OPENAI_API_KEY=sk-abc\nPORT=3000\ntoken ghp_0123456789abcdefghijklmnopqrstuvwxyz used\nAuthorization: Bearer abcdefghijklmnop1234";
        let scrubbed = scrub(out);
        assert!(scrubbed.contains("export OPENAI_API_KEY=[redacted]"), "{scrubbed}");
        assert!(scrubbed.contains("PORT=3000"));
        assert!(!scrubbed.contains("ghp_"), "{scrubbed}");
        assert!(!scrubbed.contains("abcdefghijklmnop1234"), "{scrubbed}");
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
        assert_eq!(scrub(key), MASK);
    }

    #[test]
    fn errors_and_structured_output_are_scrubbed() {
        let mut p = tool("shell_run", json!({ "command": "env" }), json!({ "stdout": "GITHUB_TOKEN=xyz" }));
        p["errorText"] = json!("failed with sk-ant-0123456789abcdefghijklmn");
        let p = part(&p);
        assert_eq!(p["output"]["stdout"], "GITHUB_TOKEN=[redacted]");
        assert_eq!(p["errorText"], "failed with [redacted]");
    }

    #[test]
    fn ops_keep_their_place() {
        let set = Op::SetPart { index: 3, part: tool("memory_write", json!({}), json!("x")) };
        let Op::SetPart { index, part } = op(&set) else { panic!() };
        assert_eq!(index, 3);
        assert_eq!(part["output"], PRIVATE);
        let text = Op::AppendText { index: 1, delta: "sk-ant-this-stays-as-the-model-said-it".into() };
        assert_eq!(op(&text), text);
        let reset = Op::Reset { messages: vec![json!({ "id": "a", "role": "assistant", "parts": [tool("chats_search", json!({}), json!("hits"))] })] };
        let Op::Reset { messages } = op(&reset) else { panic!() };
        assert_eq!(messages[0]["parts"][0]["output"], PRIVATE);
        assert_eq!(messages[0]["id"], "a");
    }

    #[test]
    fn text_and_files_pass_unchanged() {
        let text = json!({ "type": "text", "text": "hello" });
        assert_eq!(part(&text), text);
        let file = json!({ "type": "file", "mediaType": "image/png", "url": "sushblob://localhost/abc" });
        assert_eq!(part(&file), file);
    }
}
