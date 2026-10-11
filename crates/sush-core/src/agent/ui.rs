//! The UI's message shape (AI SDK `UIMessage` JSON) and the operations a run
//! uses to change it.
//!
//! A run keeps a thread's messages as the UI's JSON so the UI can render and
//! store them as they are. Every change is an [`Op`]; the run applies it to its
//! own copy and sends it to the UI, which applies it the same way (see
//! `applyOp` in the desktop app's `sessions.ts`).

use std::collections::{BTreeMap, HashMap};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::message::{ChatEvent, Message, Part, Role};
use crate::store::blob_sha;

/// Result given for a tool call the user moved on from; providers reject a call without one.
pub const UNANSWERED: &str = "No result: the user continued the conversation instead.";
pub const STOPPED: &str = "Stopped by the user.";
/// Media type of a folder attachment: one text blob holding all its files.
pub const FOLDER_MEDIA_TYPE: &str = "text/x-sush-folder";

/// A change to a thread's messages. Everything but `Reset` and `Push` targets the last message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Op {
    Reset { messages: Vec<Value> },
    Push { message: Value },
    PushPart { part: Value },
    AppendText { index: usize, delta: String },
    SetPart { index: usize, part: Value },
    /// Shallow-merged into the message's metadata.
    SetMetadata { metadata: Value },
}

pub fn apply(messages: &mut Vec<Value>, op: &Op) {
    match op {
        Op::Reset { messages: m } => *messages = m.clone(),
        Op::Push { message } => messages.push(message.clone()),
        _ => {
            let Some(last) = messages.last_mut().and_then(Value::as_object_mut) else { return };
            match op {
                Op::PushPart { part } => {
                    if let Some(parts) = last.entry("parts").or_insert_with(|| json!([])).as_array_mut() {
                        parts.push(part.clone());
                    }
                }
                Op::AppendText { index, delta } => {
                    if let Some(Value::String(text)) = last.get_mut("parts").and_then(|p| p.get_mut(*index)).and_then(|p| p.get_mut("text")) {
                        text.push_str(delta);
                    }
                }
                Op::SetPart { index, part } => {
                    if let Some(slot) = last.get_mut("parts").and_then(|p| p.get_mut(*index)) {
                        *slot = part.clone();
                    }
                }
                Op::SetMetadata { metadata } => {
                    let target = last.entry("metadata").or_insert_with(|| json!({}));
                    if !target.is_object() {
                        *target = json!({});
                    }
                    if let (Some(target), Some(source)) = (target.as_object_mut(), metadata.as_object()) {
                        for (k, v) in source {
                            target.insert(k.clone(), v.clone());
                        }
                    }
                }
                Op::Reset { .. } | Op::Push { .. } => unreachable!(),
            }
        }
    }
}

/// A random id for a new message, like the AI SDK's.
pub fn new_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("system random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

pub fn parts(message: &Value) -> &[Value] {
    message.get("parts").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// A tool call as the model made it.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// Tool calls in the last message that are waiting for a result, with their part index.
pub fn unresolved_calls(messages: &[Value]) -> Vec<(usize, ToolCall)> {
    let Some(last) = messages.last().filter(|m| role(m) == Some("assistant")) else { return Vec::new() };
    parts(last)
        .iter()
        .enumerate()
        .filter(|(_, p)| str_at(p, "type") == Some("dynamic-tool") && str_at(p, "state") == Some("input-available"))
        .map(|(i, p)| {
            let call = ToolCall {
                id: str_at(p, "toolCallId").unwrap_or_default().into(),
                name: str_at(p, "toolName").unwrap_or_default().into(),
                input: p.get("input").cloned().unwrap_or_else(|| json!({})),
            };
            (i, call)
        })
        .collect()
}

/// The part for a tool call with its result.
pub fn tool_result_part(call: &ToolCall, result: Result<Value, String>) -> Value {
    match result {
        Ok(output) => json!({
            "type": "dynamic-tool", "toolName": call.name, "toolCallId": call.id,
            "state": "output-available", "input": call.input, "output": output,
        }),
        Err(error_text) => json!({
            "type": "dynamic-tool", "toolName": call.name, "toolCallId": call.id,
            "state": "output-error", "input": call.input, "errorText": error_text,
        }),
    }
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

// --- streaming a step ---------------------------------------------------------------

/// Turns one model step's events into ops on the assistant message: opens and
/// closes text, reasoning and tool parts as events arrive.
pub struct StepBuilder {
    /// Number of parts in the message, i.e. the index the next part gets.
    len: usize,
    text: Option<(usize, String)>,
    reasoning: Option<(usize, String)>,
    /// By the provider's tool index: part index, call id, name, raw arguments.
    tools: BTreeMap<u32, (usize, String, String, String)>,
    web: HashMap<String, (usize, Value)>,
    usage: Map<String, Value>,
    seq: usize,
    /// Set once the provider reports an error.
    pub error: Option<String>,
}

impl StepBuilder {
    pub fn new(parts_len: usize) -> Self {
        Self {
            len: parts_len,
            text: None,
            reasoning: None,
            tools: BTreeMap::new(),
            web: HashMap::new(),
            usage: Map::new(),
            seq: 0,
            error: None,
        }
    }

    fn push(&mut self, ops: &mut Vec<Op>, part: Value) -> usize {
        ops.push(Op::PushPart { part });
        self.len += 1;
        self.len - 1
    }

    pub fn handle(&mut self, event: ChatEvent) -> Vec<Op> {
        let mut ops = Vec::new();
        match event {
            ChatEvent::TextDelta { delta } => {
                self.close_reasoning(&mut ops);
                if self.text.is_none() {
                    let i = self.push(&mut ops, json!({ "type": "text", "text": "", "state": "streaming" }));
                    self.text = Some((i, String::new()));
                }
                let (i, text) = self.text.as_mut().unwrap();
                text.push_str(&delta);
                ops.push(Op::AppendText { index: *i, delta });
            }
            ChatEvent::ReasoningDelta { delta } => {
                self.close_text(&mut ops);
                if self.reasoning.is_none() {
                    let i = self.push(&mut ops, json!({ "type": "reasoning", "text": "", "state": "streaming" }));
                    self.reasoning = Some((i, String::new()));
                }
                let (i, text) = self.reasoning.as_mut().unwrap();
                text.push_str(&delta);
                ops.push(Op::AppendText { index: *i, delta });
            }
            ChatEvent::ToolCallDelta { index, id, name, args_delta } => {
                if !self.tools.contains_key(&index) {
                    let id = id.unwrap_or_else(|| {
                        self.seq += 1;
                        format!("call-{}", self.seq)
                    });
                    let name = name.unwrap_or_else(|| "unknown".into());
                    let i = self.push(
                        &mut ops,
                        json!({ "type": "dynamic-tool", "toolName": name, "toolCallId": id, "state": "input-streaming" }),
                    );
                    self.tools.insert(index, (i, id, name, String::new()));
                }
                self.tools.get_mut(&index).unwrap().3.push_str(&args_delta);
            }
            ChatEvent::ServerToolCall { id, name, input } => {
                // Text after a search belongs after it, so start a new text part.
                self.close_text(&mut ops);
                self.close_reasoning(&mut ops);
                let data = json!({ "name": name, "input": input, "sources": [] });
                let i = self.push(&mut ops, json!({ "type": "data-web", "id": id, "data": data }));
                self.web.insert(id, (i, data));
            }
            ChatEvent::WebSources { call_id, sources } => {
                if let Some((i, data)) = self.web.get_mut(&call_id) {
                    if let Some(list) = data["sources"].as_array_mut() {
                        list.extend(sources.into_iter().map(|s| json!({ "url": s.url, "title": s.title })));
                    }
                    ops.push(Op::SetPart { index: *i, part: json!({ "type": "data-web", "id": call_id, "data": data }) });
                }
            }
            ChatEvent::Citation { url, title } => {
                // Cited text always comes first, so a text part is open; the marker goes right after it.
                if let Some((i, text)) = self.text.as_mut() {
                    let marker = citation_marker(&url, title.as_deref());
                    text.push_str(&marker);
                    ops.push(Op::AppendText { index: *i, delta: marker });
                }
            }
            ChatEvent::Usage { input_tokens, output_tokens } => {
                self.usage.insert("inputTokens".into(), json!(input_tokens));
                self.usage.insert("outputTokens".into(), json!(output_tokens));
            }
            ChatEvent::Finish { .. } => {}
            ChatEvent::Error { message } => self.error = Some(message),
        }
        ops
    }

    /// Normal end of the step: close open parts, hand over the tool calls and usage.
    pub fn finish(mut self) -> (Vec<Op>, Vec<ToolCall>) {
        let mut ops = Vec::new();
        self.close_text(&mut ops);
        self.close_reasoning(&mut ops);
        let mut calls = Vec::new();
        for (index, id, name, args) in std::mem::take(&mut self.tools).into_values() {
            let input = parse_args(&args);
            ops.push(Op::SetPart {
                index,
                part: json!({ "type": "dynamic-tool", "toolName": name, "toolCallId": id, "state": "input-available", "input": input }),
            });
            calls.push(ToolCall { id, name, input });
        }
        if self.usage.values().any(|v| !v.is_null()) {
            let usage: Map<String, Value> = self.usage.into_iter().filter(|(_, v)| !v.is_null()).collect();
            ops.push(Op::SetMetadata { metadata: Value::Object(usage) });
        }
        (ops, calls)
    }

    /// Stopped or failed: close open text so it renders as finished.
    pub fn end(mut self) -> Vec<Op> {
        let mut ops = Vec::new();
        self.close_text(&mut ops);
        self.close_reasoning(&mut ops);
        ops
    }

    fn close_text(&mut self, ops: &mut Vec<Op>) {
        if let Some((index, text)) = self.text.take() {
            ops.push(Op::SetPart { index, part: json!({ "type": "text", "text": text, "state": "done" }) });
        }
    }

    fn close_reasoning(&mut self, ops: &mut Vec<Op>) {
        if let Some((index, text)) = self.reasoning.take() {
            ops.push(Op::SetPart { index, part: json!({ "type": "reasoning", "text": text, "state": "done" }) });
        }
    }
}

fn parse_args(args: &str) -> Value {
    if args.is_empty() {
        return json!({});
    }
    serde_json::from_str(args).unwrap_or_else(|_| Value::String(args.into()))
}

// --- citations ------------------------------------------------------------------------

/// The markdown written into the text stream for one citation (`citations.ts` renders it).
pub fn citation_marker(url: &str, title: Option<&str>) -> String {
    let mut href = String::with_capacity(url.len());
    for c in url.chars() {
        if c.is_whitespace() || c == '(' || c == ')' {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                href.push_str(&format!("%{b:02X}"));
            }
        } else {
            href.push(c);
        }
    }
    match title {
        Some(t) => format!(" [cite]({href} \"{}\")", t.replace('"', "'")),
        None => format!(" [cite]({href})"),
    }
}

/// Text without its citation markers, for sending back to the model.
pub fn strip_citations(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("[cite](") {
        let after = &rest[at + 7..];
        match marker_len(after) {
            Some(len) => {
                let mut kept = &rest[..at];
                if let Some(c) = kept.chars().last().filter(|c| c.is_whitespace()) {
                    kept = &kept[..kept.len() - c.len_utf8()];
                }
                out.push_str(kept);
                rest = &after[len..];
            }
            None => {
                out.push_str(&rest[..at + 7]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Length of `href)` or `href "title")` at the start of `s`.
fn marker_len(s: &str) -> Option<usize> {
    let href = s.find(|c: char| c.is_whitespace() || c == ')')?;
    if href == 0 {
        return None;
    }
    let rest = &s[href..];
    if rest.starts_with(')') {
        return Some(href + 1);
    }
    let title = rest.strip_prefix(" \"")?;
    let end = title.find('"')?;
    title[end + 1..].starts_with(')').then(|| href + 2 + end + 2)
}

// --- for the model --------------------------------------------------------------------

/// UI messages as the provider sees them. `expansions` replaces the first text
/// of user messages by id: `/skill` and `@connector` expanded by the UI.
///
/// An assistant reply that took several steps (call tools, read results, go
/// on) is one UI message; it's split at each `step-start` so the model sees
/// each step's calls followed by their results, in order. Sent as one message,
/// every call of the reply would look like one parallel batch, and the model
/// loses track of which calls it already made.
pub fn to_core(messages: &[Value], expansions: &HashMap<String, String>) -> Vec<Message> {
    let mut out = Vec::new();
    for m in messages {
        let role = match role(m) {
            Some("user") => Role::User,
            Some("assistant") => Role::Assistant,
            Some("system") => Role::System,
            _ => continue,
        };
        let id = str_at(m, "id").unwrap_or_default();
        let mut first_text = true;
        let mut parts = Vec::new();
        for p in self::parts(m) {
            match str_at(p, "type") {
                Some("step-start") if role == Role::Assistant => {
                    if !parts.is_empty() {
                        out.push(Message { role, parts: std::mem::take(&mut parts) });
                    }
                }
                Some("text") => {
                    let raw = str_at(p, "text").unwrap_or_default();
                    let text = match role {
                        Role::User if first_text => expansions.get(id).cloned().unwrap_or_else(|| raw.into()),
                        Role::Assistant => strip_citations(raw),
                        _ => raw.into(),
                    };
                    first_text = false;
                    if !text.is_empty() {
                        parts.push(Part::Text { text });
                    }
                }
                Some("reasoning") => parts.push(Part::Reasoning { text: str_at(p, "text").unwrap_or_default().into() }),
                Some("file") => {
                    let url = str_at(p, "url").unwrap_or_default();
                    let media_type = str_at(p, "mediaType").unwrap_or_default();
                    if let Some(part) = file_part(url, media_type, str_at(p, "filename")) {
                        parts.push(part);
                    }
                }
                Some("dynamic-tool") => {
                    let id = str_at(p, "toolCallId").unwrap_or_default().to_string();
                    parts.push(Part::ToolCall {
                        id: id.clone(),
                        name: str_at(p, "toolName").unwrap_or_default().into(),
                        input: p.get("input").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!({})),
                    });
                    let (output, is_error) = match str_at(p, "state") {
                        Some("output-available") => (p.get("output").cloned().unwrap_or(Value::Null), false),
                        Some("output-error") => (json!(str_at(p, "errorText").unwrap_or_default()), true),
                        _ => (json!(UNANSWERED), true),
                    };
                    parts.push(Part::ToolResult { call_id: id, output, is_error });
                }
                _ => {}
            }
        }
        if !parts.is_empty() {
            out.push(Message { role, parts });
        }
    }
    out
}

/// An attachment as the model sees it: images and PDFs natively, text inline.
fn file_part(url: &str, media_type: &str, filename: Option<&str>) -> Option<Part> {
    let name = filename.unwrap_or("attachment").to_string();
    // Stored attachments stay URLs here; the host reads their bytes when sending.
    if blob_sha(url).is_some() {
        return if media_type.starts_with("image/") {
            Some(Part::Image { media_type: media_type.into(), data: url.into() })
        } else if media_type == "application/pdf" {
            Some(Part::Document { media_type: media_type.into(), data: url.into(), name: Some(name) })
        } else {
            None
        };
    }
    let (data_type, data) = url.strip_prefix("data:")?.split_once(',')?;
    let data_type = data_type.strip_suffix(";base64")?;
    if data_type.is_empty() {
        return None;
    }
    if media_type.starts_with("image/") {
        return Some(Part::Image { media_type: data_type.into(), data: data.into() });
    }
    if media_type == "application/pdf" {
        return Some(Part::Document { media_type: data_type.into(), data: data.into(), name: Some(name) });
    }
    let text = if is_text_type(media_type) { decode_text(data) } else { None };
    let Some(text) = text else {
        let kind = if media_type.is_empty() { "unknown type" } else { media_type };
        return Some(Part::Text { text: format!("[Attached {name} ({kind}): this file type can't be read.]") });
    };
    if media_type == FOLDER_MEDIA_TYPE {
        return Some(Part::Text { text });
    }
    Some(Part::Text { text: format!("<file name=\"{name}\">\n{text}\n</file>") })
}

fn is_text_type(media_type: &str) -> bool {
    const APP: [&str; 10] = ["json", "xml", "javascript", "typescript", "x-yaml", "yaml", "toml", "x-sh", "sql", "graphql"];
    media_type.is_empty()
        || media_type.starts_with("text/")
        || media_type.strip_prefix("application/").is_some_and(|sub| APP.iter().any(|a| sub.starts_with(a)))
}

/// UTF-8 text, or None for binary data.
fn decode_text(base64: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).ok()?;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// A conversation title from its first user message.
pub fn title_from(messages: &[Value]) -> Option<String> {
    let first = messages.iter().find(|m| role(m) == Some("user"))?;
    let text = parts(first).iter().find(|p| str_at(p, "type") == Some("text")).and_then(|p| str_at(p, "text"))?.trim();
    let line = text.lines().next().filter(|l| !l.is_empty())?;
    Some(if line.chars().count() > 60 { format!("{}…", line.chars().take(57).collect::<String>()) } else { line.into() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::WebSource;

    fn assistant() -> Vec<Value> {
        vec![json!({ "id": "a", "role": "assistant", "parts": [] })]
    }

    fn run(events: Vec<ChatEvent>) -> (Vec<Value>, Vec<ToolCall>) {
        let mut messages = assistant();
        let mut b = StepBuilder::new(0);
        for e in events {
            for op in b.handle(e) {
                apply(&mut messages, &op);
            }
        }
        let (ops, calls) = b.finish();
        for op in ops {
            apply(&mut messages, &op);
        }
        (messages, calls)
    }

    #[test]
    fn builds_text_reasoning_and_tool_parts() {
        let (messages, calls) = run(vec![
            ChatEvent::ReasoningDelta { delta: "think".into() },
            ChatEvent::TextDelta { delta: "Hel".into() },
            ChatEvent::TextDelta { delta: "lo".into() },
            ChatEvent::ToolCallDelta { index: 0, id: Some("c1".into()), name: Some("memory_write".into()), args_delta: "{\"pa".into() },
            ChatEvent::ToolCallDelta { index: 0, id: None, name: None, args_delta: "th\":\"profile\"}".into() },
            ChatEvent::Usage { input_tokens: Some(10), output_tokens: Some(5) },
        ]);
        assert_eq!(
            messages[0],
            json!({ "id": "a", "role": "assistant", "metadata": { "inputTokens": 10, "outputTokens": 5 }, "parts": [
                { "type": "reasoning", "text": "think", "state": "done" },
                { "type": "text", "text": "Hello", "state": "done" },
                { "type": "dynamic-tool", "toolName": "memory_write", "toolCallId": "c1", "state": "input-available", "input": { "path": "profile" } },
            ]})
        );
        assert_eq!(calls, vec![ToolCall { id: "c1".into(), name: "memory_write".into(), input: json!({ "path": "profile" }) }]);
        assert_eq!(unresolved_calls(&messages).len(), 1);
    }

    #[test]
    fn web_research_splits_text_and_cites_sources() {
        let (messages, _) = run(vec![
            ChatEvent::TextDelta { delta: "Let me look.".into() },
            ChatEvent::ServerToolCall { id: "s1".into(), name: "web_search".into(), input: json!({ "query": "rust" }) },
            ChatEvent::WebSources { call_id: "s1".into(), sources: vec![WebSource { url: "https://rust-lang.org".into(), title: None }] },
            ChatEvent::TextDelta { delta: "Rust is fast.".into() },
            ChatEvent::Citation { url: "https://rust-lang.org/a b".into(), title: Some("Say \"hi\"".into()) },
        ]);
        let parts = parts(&messages[0]);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[1]["data"]["sources"][0]["url"], "https://rust-lang.org");
        assert_eq!(parts[2]["text"], "Rust is fast. [cite](https://rust-lang.org/a%20b \"Say 'hi'\")");
        assert_eq!(strip_citations(parts[2]["text"].as_str().unwrap()), "Rust is fast.");
    }

    #[test]
    fn strip_citations_leaves_other_text_alone() {
        assert_eq!(strip_citations("a [cite](https://x.y) b [cite](u \"t\")."), "a b.");
        assert_eq!(strip_citations("see [cite]( broken"), "see [cite]( broken");
        assert_eq!(strip_citations("[link](https://x)"), "[link](https://x)");
    }

    #[test]
    fn to_core_maps_parts_and_answers_open_calls() {
        let png = base64::engine::general_purpose::STANDARD.encode(b"png");
        let txt = base64::engine::general_purpose::STANDARD.encode(b"hello");
        let messages = vec![
            json!({ "id": "u1", "role": "user", "parts": [
                { "type": "file", "mediaType": "image/png", "url": format!("data:image/png;base64,{png}") },
                { "type": "file", "mediaType": "text/plain", "filename": "a.txt", "url": format!("data:text/plain;base64,{txt}") },
                { "type": "text", "text": "/review this" },
            ]}),
            json!({ "id": "a1", "role": "assistant", "parts": [
                { "type": "step-start" },
                { "type": "text", "text": "Sure [cite](https://x)" },
                { "type": "dynamic-tool", "toolName": "t", "toolCallId": "c1", "state": "output-error", "input": { "q": 1 }, "errorText": "boom" },
                { "type": "dynamic-tool", "toolName": "t", "toolCallId": "c2", "state": "input-available", "input": null },
            ]}),
            json!({ "id": "empty", "role": "assistant", "parts": [{ "type": "step-start" }] }),
        ];
        let expansions = HashMap::from([("u1".to_string(), "Skill instructions\n\nthis".to_string())]);
        let core = to_core(&messages, &expansions);
        assert_eq!(core.len(), 2);
        assert_eq!(
            core[0].parts,
            vec![
                Part::Image { media_type: "image/png".into(), data: png },
                Part::Text { text: "<file name=\"a.txt\">\nhello\n</file>".into() },
                Part::Text { text: "Skill instructions\n\nthis".into() },
            ]
        );
        assert_eq!(
            core[1].parts,
            vec![
                Part::Text { text: "Sure".into() },
                Part::ToolCall { id: "c1".into(), name: "t".into(), input: json!({ "q": 1 }) },
                Part::ToolResult { call_id: "c1".into(), output: json!("boom"), is_error: true },
                Part::ToolCall { id: "c2".into(), name: "t".into(), input: json!({}) },
                Part::ToolResult { call_id: "c2".into(), output: json!(UNANSWERED), is_error: true },
            ]
        );
    }

    #[test]
    fn multi_step_replies_are_split_per_step() {
        let messages = vec![json!({ "id": "a", "role": "assistant", "parts": [
            { "type": "step-start" },
            { "type": "reasoning", "text": "look it up" },
            { "type": "dynamic-tool", "toolName": "search", "toolCallId": "c1", "state": "output-available", "input": {}, "output": "found" },
            { "type": "step-start" },
            { "type": "dynamic-tool", "toolName": "update", "toolCallId": "c2", "state": "output-available", "input": {}, "output": "ok" },
            { "type": "step-start" },
            { "type": "text", "text": "Done." },
        ]})];
        let core = to_core(&messages, &HashMap::new());
        let calls: Vec<Vec<&str>> = core
            .iter()
            .map(|m| {
                m.parts
                    .iter()
                    .filter_map(|p| match p {
                        Part::ToolCall { id, .. } => Some(id.as_str()),
                        Part::Text { .. } => Some("text"),
                        _ => None,
                    })
                    .collect()
            })
            .collect();
        assert_eq!(calls, vec![vec!["c1"], vec!["c2"], vec!["text"]]);
        assert!(core.iter().all(|m| m.role == Role::Assistant));
    }

    #[test]
    fn titles_come_from_the_first_user_line() {
        let long = "x".repeat(70);
        let messages = vec![json!({ "role": "user", "parts": [{ "type": "text", "text": format!("  {long}\nmore") }] })];
        assert_eq!(title_from(&messages).unwrap().chars().count(), 58);
        assert_eq!(title_from(&[json!({ "role": "user", "parts": [{ "type": "text", "text": "Hi there" }] })]).as_deref(), Some("Hi there"));
        assert_eq!(title_from(&[]), None);
    }

    #[test]
    fn metadata_merges() {
        let mut messages = assistant();
        apply(&mut messages, &Op::SetMetadata { metadata: json!({ "model": "m" }) });
        apply(&mut messages, &Op::SetMetadata { metadata: json!({ "outputTokens": 3 }) });
        assert_eq!(messages[0]["metadata"], json!({ "model": "m", "outputTokens": 3 }));
    }
}
