//! What guests never see of a shared thread.
//!
//! Every op passes through here before it leaves the host. Redaction keeps
//! each part where it is (only its content changes), so later ops that name a
//! part by index still land on the right one.
//!
//! - Private tools (memory, past chats): their input and output are replaced.
//! - `fs_read` of a secret-looking file: its output is replaced.
//! - `fs_search`: matches in secret-looking files are dropped.
//! - Every tool's text output, error and input: well-known credential formats
//!   and `KEY=value` lines naming secrets are masked (`scrub`).
//! - Everything, the model's own text included: the values of secrets the
//!   thread has seen ([`Secrets`]), so the model quoting a `.env` it was
//!   allowed to read doesn't show the value either.
//!
//! This lowers the chance of a leak; it can't promise none. The model's text
//! streams in pieces, so the outbox holds back the end of each text stream
//! until no secret can be split across it (`Secrets::safe_cut`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::agent::Op;
use crate::workspace::looks_secret;
use crate::workspace::shell::is_secret_var;
use crate::workspace::tools::{FS_READ, FS_SEARCH};

pub const SECRET_FILE: &str = "[hidden from guests: secret file]";
pub const PRIVATE: &str = "[private to the host]";
pub const MASK: &str = "[redacted]";

/// Tools whose calls hold the host's own data: memory and other conversations.
const PRIVATE_TOOLS: [&str; 5] = ["memory_write", "memory_delete", "memory_save", "chats_search", "chat_read"];

/// The most secret values one share remembers.
const MAX_SECRETS: usize = 1000;

/// Secret values a shared thread's tool calls brought in: every value in a
/// secret-looking file read, and the values of secret-named `KEY=value` lines
/// in any other output. Hidden wherever they turn up later.
#[derive(Debug, Default)]
pub struct Secrets {
    /// Longest first, so a value inside another doesn't leave the rest showing.
    values: Vec<String>,
}

impl Secrets {
    pub fn learn(&mut self, op: &Op) {
        match op {
            Op::Reset { messages } => self.learn_messages(messages),
            Op::Push { message } => self.learn_messages(std::slice::from_ref(message)),
            Op::PushPart { part } | Op::SetPart { part, .. } => self.learn_part(part),
            Op::AppendText { .. } | Op::SetMetadata { .. } => {}
        }
    }

    pub fn learn_messages(&mut self, messages: &[Value]) {
        for m in messages {
            for p in crate::agent::ui::parts(m) {
                self.learn_part(p);
            }
        }
    }

    fn learn_part(&mut self, part: &Value) {
        if part.get("type").and_then(Value::as_str) != Some("dynamic-tool") {
            return;
        }
        let Some(output) = part.get("output") else { return };
        let name = part.get("toolName").and_then(Value::as_str).unwrap_or_default();
        let path = part.get("input").and_then(|i| i.get("path")).and_then(Value::as_str);
        let secret_file = name == FS_READ && path.is_some_and(looks_secret);
        let mut found = Vec::new();
        each_string(output, &mut |s| found.extend(if secret_file { file_values(s) } else { assigned_values(s) }));
        for value in found {
            if self.values.len() < MAX_SECRETS && !self.values.contains(&value) {
                self.values.push(value);
            }
        }
        self.values.sort_by_key(|v| std::cmp::Reverse(v.len()));
    }

    /// Text with every known secret value and credential masked.
    pub fn hide(&self, text: &str) -> String {
        let mut out = text.to_string();
        for value in &self.values {
            if out.contains(value.as_str()) {
                out = out.replace(value.as_str(), MASK);
            }
        }
        scrub(&out)
    }

    /// How much of a text stream can go out now: everything before the last
    /// two words (the last may still be growing, and the one before it may be
    /// "Bearer"), before where a known secret could still be arriving, and
    /// before any credential, secret `KEY=` line or private key that isn't
    /// finished yet or would be cut in two.
    pub fn safe_cut(&self, text: &str) -> usize {
        let word_start = |end: usize| text[..end].rfind(char::is_whitespace).map_or(0, |i| i + text[i..].chars().next().map_or(1, char::len_utf8));
        let last = word_start(text.len());
        let mut cut = word_start(text[..last].trim_end().len());
        if let Some(longest) = self.values.first() {
            cut = cut.min(text.len().saturating_sub(longest.len() - 1));
        }
        if let Some(begin) = text.rfind("-----BEGIN") {
            if !text[begin..].contains("-----END") {
                cut = cut.min(begin);
            }
        }
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        // A match running across the cut goes out whole later. Moving the cut
        // back can land in an earlier match, so repeat until nothing crosses it.
        loop {
            let crossing = self
                .values
                .iter()
                .flat_map(|v| text.match_indices(v.as_str()).map(|(i, v)| (i, i + v.len())))
                .chain(TOKENS.find_iter(text).map(|m| (m.start(), m.end())))
                .chain(ASSIGNMENT.captures_iter(text).filter(|c| is_secret_var(&c[2])).map(|c| {
                    let m = c.get(0).expect("whole match");
                    (m.start(), m.end())
                }))
                .filter(|&(start, end)| start < cut && end > cut)
                .map(|(start, _)| start)
                .min();
            match crossing {
                Some(start) => cut = start,
                None => return cut,
            }
        }
    }
}

/// Every string in a tool's output.
fn each_string(value: &Value, f: &mut impl FnMut(&str)) {
    match value {
        Value::String(s) => f(s),
        Value::Array(items) => items.iter().for_each(|v| each_string(v, f)),
        Value::Object(map) => map.values().for_each(|v| each_string(v, f)),
        _ => {}
    }
}

/// A value as written: without quotes around it or a separator after it.
fn clean(value: &str) -> &str {
    value.trim().trim_end_matches([',', ';']).trim_matches(['"', '\'', '`']).trim()
}

/// Whether a value looks like a credential rather than a word: long, no
/// spaces, and mixing at least two of lowercase, uppercase, digits and symbols.
fn looks_random(value: &str) -> bool {
    let kinds = [
        value.chars().any(|c| c.is_ascii_lowercase()),
        value.chars().any(|c| c.is_ascii_uppercase()),
        value.chars().any(|c| c.is_ascii_digit()),
        value.chars().any(|c| !c.is_alphanumeric()),
    ];
    value.len() >= 8 && !value.contains(char::is_whitespace) && kinds.iter().filter(|k| **k).count() >= 2
}

/// The values of secret-named `KEY=value` lines.
fn assigned_values(text: &str) -> Vec<String> {
    ASSIGNMENT
        .captures_iter(text)
        .filter(|c| is_secret_var(&c[2]))
        .map(|c| clean(&c[4]).to_string())
        .filter(|v| v.len() >= 6 && v != MASK)
        .collect()
}

/// Everything secret-looking in a secret file: each `KEY=value` line's value
/// when it's named like a secret or looks random, and other random-looking
/// words (key bodies, JSON values, `.netrc` passwords).
fn file_values(text: &str) -> Vec<String> {
    let mut values = Vec::new();
    for line in text.lines() {
        if let Some(c) = ASSIGNMENT.captures(line) {
            let value = clean(&c[4]);
            if (is_secret_var(&c[2]) && value.len() >= 6) || looks_random(value) {
                values.push(value.to_string());
            }
            continue;
        }
        values.extend(line.split_whitespace().map(clean).filter(|w| w.len() >= 12 && looks_random(w) && !w.starts_with("-----")).map(str::to_string));
    }
    values
}

pub fn op(op: &Op, secrets: &Secrets) -> Op {
    match op {
        Op::Reset { messages: m } => Op::Reset { messages: messages(m, secrets) },
        Op::Push { message: m } => Op::Push { message: message(m, secrets) },
        Op::PushPart { part: p } => Op::PushPart { part: part(p, secrets) },
        Op::SetPart { index, part: p } => Op::SetPart { index: *index, part: part(p, secrets) },
        Op::AppendText { index, delta } => Op::AppendText { index: *index, delta: secrets.hide(delta) },
        Op::SetMetadata { .. } => op.clone(),
    }
}

pub fn messages(messages: &[Value], secrets: &Secrets) -> Vec<Value> {
    messages.iter().map(|m| message(m, secrets)).collect()
}

pub fn message(message: &Value, secrets: &Secrets) -> Value {
    let mut out = message.clone();
    if let Some(parts) = out.get_mut("parts").and_then(Value::as_array_mut) {
        for p in parts.iter_mut() {
            *p = part(p, secrets);
        }
    }
    out
}

pub fn part(part: &Value, secrets: &Secrets) -> Value {
    match part.get("type").and_then(Value::as_str) {
        Some("text" | "reasoning") => {
            let mut out = part.clone();
            if let Some(Value::String(text)) = out.get_mut("text") {
                *text = secrets.hide(text);
            }
            return out;
        }
        Some("dynamic-tool") => {}
        _ => return part.clone(),
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
    let secret_file = name == FS_READ && path.is_some_and(looks_secret);
    // The model can write a secret it saw into a later call's input (a command, a file).
    if let Some(input) = out.get_mut("input") {
        hide_strings(input, secrets);
    }
    if secret_file {
        if out.get("output").is_some() {
            out["output"] = json!(SECRET_FILE);
        }
        return out;
    }
    if let Some(Value::String(text)) = out.get_mut("output") {
        if name == FS_SEARCH {
            *text = search_hits(text);
        }
    }
    if let Some(output) = out.get_mut("output") {
        hide_strings(output, secrets);
    }
    if let Some(Value::String(text)) = out.get_mut("errorText") {
        *text = secrets.hide(text);
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

fn hide_strings(value: &mut Value, secrets: &Secrets) {
    match value {
        Value::String(s) => *s = secrets.hide(s),
        Value::Array(items) => items.iter_mut().for_each(|v| hide_strings(v, secrets)),
        Value::Object(map) => map.values_mut().for_each(|v| hide_strings(v, secrets)),
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
        let p = part(&tool("memory_write", json!({ "path": "me.md", "content": "my address" }), json!("saved")), &Secrets::default());
        assert_eq!(p["input"]["title"], PRIVATE);
        assert!(p["input"].get("content").is_none());
        assert_eq!(p["output"], PRIVATE);
        let p = part(&tool("chat_read", json!({ "id": "x" }), json!("the other chat")), &Secrets::default());
        assert_eq!(p["output"], PRIVATE);
    }

    #[test]
    fn secret_files_read_by_the_agent_are_hidden() {
        let p = part(&tool("fs_read", json!({ "path": "app/.env" }), json!("DB=postgres://u:pw@h")), &Secrets::default());
        assert_eq!(p["output"], SECRET_FILE);
        let p = part(&tool("fs_read", json!({ "path": ".env.example" }), json!("PORT=3000")), &Secrets::default());
        assert_eq!(p["output"], "PORT=3000");
    }

    #[test]
    fn search_hits_in_secret_files_are_dropped() {
        let out = "src/a.rs:3: let key = load();\n.env:1: STRIPE_KEY=abc\nkeys/id_rsa:1: -----BEGIN";
        let p = part(&tool("fs_search", json!({ "pattern": "key" }), json!(out)), &Secrets::default());
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
        let p = part(&p, &Secrets::default());
        assert_eq!(p["output"]["stdout"], "GITHUB_TOKEN=[redacted]");
        assert_eq!(p["errorText"], "failed with [redacted]");
    }

    #[test]
    fn ops_keep_their_place() {
        let set = Op::SetPart { index: 3, part: tool("memory_write", json!({}), json!("x")) };
        let Op::SetPart { index, part } = op(&set, &Secrets::default()) else { panic!() };
        assert_eq!(index, 3);
        assert_eq!(part["output"], PRIVATE);
        let text = Op::AppendText { index: 1, delta: "use sk-ant-0123456789abcdefghijklmn here".into() };
        assert_eq!(op(&text, &Secrets::default()), Op::AppendText { index: 1, delta: "use [redacted] here".into() });
        let reset = Op::Reset { messages: vec![json!({ "id": "a", "role": "assistant", "parts": [tool("chats_search", json!({}), json!("hits"))] })] };
        let Op::Reset { messages } = op(&reset, &Secrets::default()) else { panic!() };
        assert_eq!(messages[0]["parts"][0]["output"], PRIVATE);
        assert_eq!(messages[0]["id"], "a");
    }

    fn learned(path: &str, output: &str) -> Secrets {
        let mut secrets = Secrets::default();
        secrets.learn(&Op::SetPart { index: 0, part: tool("fs_read", json!({ "path": path }), json!(output)) });
        secrets
    }

    #[test]
    fn values_from_a_secret_file_are_hidden_in_the_models_text() {
        let secrets = learned(".env", "STRIPE_KEY=rk_live_51Habc\nDATABASE_URL=\"postgres://app:hunter22@db:5432/app\"\nNODE_ENV=production\nPORT=3000");
        let said = json!({ "type": "text", "text": "Your key is rk_live_51Habc and the DB is postgres://app:hunter22@db:5432/app in production on 3000." });
        let text = part(&said, &secrets)["text"].as_str().unwrap().to_string();
        assert!(!text.contains("rk_live") && !text.contains("hunter22"), "{text}");
        assert!(text.contains("production") && text.contains("3000"), "{text}");
        let reasoning = json!({ "type": "reasoning", "text": "the key rk_live_51Habc" });
        assert_eq!(part(&reasoning, &secrets)["text"], "the key [redacted]");
    }

    #[test]
    fn a_secret_written_into_a_later_call_is_hidden() {
        let secrets = learned("config/.env.local", "API_TOKEN=tok_9f8e7d6c5b");
        let call = tool("shell_run", json!({ "command": "curl -H 'X-Token: tok_9f8e7d6c5b' api" }), json!("ok tok_9f8e7d6c5b"));
        let p = part(&call, &secrets);
        assert_eq!(p["input"]["command"], "curl -H 'X-Token: [redacted]' api");
        assert_eq!(p["output"], "ok [redacted]");
    }

    #[test]
    fn secret_values_in_any_output_are_learned() {
        let mut secrets = Secrets::default();
        secrets.learn(&Op::SetPart { index: 0, part: tool("shell_run", json!({ "command": "cat cfg" }), json!({ "stdout": "SERVICE_PASSWORD=correcthorse\nMODE=dev" })) });
        assert_eq!(secrets.hide("it's correcthorse, mode dev"), "it's [redacted], mode dev");
    }

    #[test]
    fn key_files_are_learned_line_by_line() {
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\nAAAAC3NzaC1lZDI1NTE5AAAAIOv\n-----END OPENSSH PRIVATE KEY-----";
        let secrets = learned("keys/id_ed25519", key);
        assert_eq!(secrets.hide("first line: b3BlbnNzaC1rZXktdjEAAAAABG5vbmU"), "first line: [redacted]");
    }

    #[test]
    fn a_stream_is_cut_where_no_secret_can_be_split() {
        let none = Secrets::default();
        // The last two words wait.
        let text = "The key is here now";
        assert_eq!(&text[..none.safe_cut(text)], "The key is ");
        // A known value arriving waits until it's complete.
        let secrets = learned(".env", "STRIPE_KEY=rk_live_51Habc");
        let text = "first part goes out and then rk_li";
        assert!(!text[..secrets.safe_cut(text)].contains("rk_"));
        // A finished one isn't split by holding back its length.
        let text = "aaaa rk_live_51Habc x y";
        assert_eq!(secrets.safe_cut(text), 5);
        // A secret KEY= line waits for its end, and so does a private key.
        let text = "set this:\nexport OPENAI_API_KEY=my pass phrase still going";
        assert_eq!(&text[..none.safe_cut(text)], "set this:\n");
        let text = "here:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow IBAAKCAQ EAx and more words";
        assert_eq!(&text[..none.safe_cut(text)], "here:\n");
    }

    #[test]
    fn text_and_files_pass_unchanged() {
        let text = json!({ "type": "text", "text": "hello" });
        assert_eq!(part(&text, &Secrets::default()), text);
        let file = json!({ "type": "file", "mediaType": "image/png", "url": "sushblob://localhost/abc" });
        assert_eq!(part(&file, &Secrets::default()), file);
    }
}
