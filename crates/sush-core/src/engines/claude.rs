//! Claude Code as `claude -p`, stream-json in and out, as the user installed
//! it and signed in to it. Checked against Claude Code 2.1.
//!
//! - In: an `initialize` control request, then user messages. Messages sent
//!   while it works go in at once; it takes them at its next boundary and
//!   echoes each one back (`--replay-user-messages`), which is when the thread
//!   shows it. "Send now" is an `interrupt` control request.
//! - Out: partial messages (`stream_event`, the Messages API's own events)
//!   stream text and thinking; each whole `assistant` message gives the final
//!   tool input; `user` messages carry tool results; `result` ends a turn with
//!   its usage. A sub-agent's events (`parent_tool_use_id`) stay inside its
//!   `Task` call.
//! - Permission prompts (`--permission-prompt-tool stdio`) arrive as
//!   `can_use_tool` control requests, which the call's card answers.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{claude_tool, effort, effort_str, prompt_text, Context, EngineModel, Ending, Kind, Proc, Thread};
use crate::agent::run::{Author, Inbox, ToolResponse, INTERRUPTED};
use crate::workspace::{Access, EditApproval};

const ASK_IN_REPLY: &str =
    "Sush can't show this question. Ask it in your reply instead, then end your turn so the user can answer.";
const READ_ONLY: &str = "This folder is read-only in Sush, so nothing can be changed. Give your plan in your reply instead.";

#[derive(Clone, Copy)]
enum Block {
    Text,
    Thinking,
    Tool,
}

struct Claude {
    proc: Proc,
    /// Messages written whose echo hasn't come back: None for the first,
    /// which is already in the thread.
    echoes: VecDeque<Option<Value>>,
    /// Sent after a pause: they wait for `Resume` instead of going in.
    held: Vec<Value>,
    pause: bool,
    /// Calls waiting for the user: control request id and the input as the CLI gave it.
    approvals: HashMap<String, (String, Value)>,
    /// Calls the user denied, with the reason the card gave.
    denied: HashMap<String, String>,
    /// The streamed message's content blocks, by index.
    blocks: HashMap<u64, Block>,
    /// A turn ended (`result`) and no message has gone in since.
    turn_over: bool,
    interrupted: bool,
    error: Option<String>,
    read_only: bool,
    seq: u64,
}

pub(super) async fn drive(
    t: &mut Thread<'_>,
    ctx: &Context,
    session: Option<String>,
    prompt: String,
    inbox: &mut mpsc::UnboundedReceiver<Inbox>,
    cancel: &CancellationToken,
) -> Result<Ending, String> {
    let mode = match (ctx.access, ctx.approval) {
        (Access::ReadOnly, _) => "plan",
        (_, EditApproval::AutoEdits) => "acceptEdits",
        (_, EditApproval::Ask) => "default",
    };
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--replay-user-messages",
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        mode,
    ]
    .map(String::from)
    .to_vec();
    if !t.model.is_empty() && t.model != "default" {
        args.extend(["--model".to_string(), t.model.clone()]);
    }
    if let Some(effort) = t.effort {
        args.extend(["--effort".to_string(), effort_str(effort)]);
    }
    if let Some(id) = &session {
        args.extend(["--resume".to_string(), id.clone()]);
    }
    let mut c = Claude {
        proc: Proc::spawn(Kind::ClaudeCode, &args, &ctx.cwd)?,
        echoes: VecDeque::new(),
        held: Vec::new(),
        pause: false,
        approvals: HashMap::new(),
        denied: HashMap::new(),
        blocks: HashMap::new(),
        turn_over: false,
        interrupted: false,
        error: None,
        read_only: ctx.access == Access::ReadOnly,
        seq: 0,
    };
    let result = c.go(t, &prompt, inbox, cancel).await;
    c.proc.finish(cancel.is_cancelled() || result.is_err()).await;
    result
}

/// The models this install offers, as its `initialize` reply lists them (what
/// its own `/model` menu shows), with their versions and effort levels. Starts
/// the CLI without sending a message, so no model is called. The reply also
/// names the account; that is never read.
pub(super) async fn models() -> Option<Vec<EngineModel>> {
    let args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"].map(String::from);
    let mut proc = Proc::spawn(Kind::ClaudeCode, &args, &std::env::temp_dir()).ok()?;
    let read = async {
        let init = json!({ "type": "control_request", "request_id": "sush-models", "request": { "subtype": "initialize" } });
        proc.send(&init).await.ok()?;
        while let Ok(Some(line)) = proc.lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v["type"] == "control_response" && v["response"]["request_id"] == "sush-models" {
                return Some(v["response"]["response"]["models"].clone());
            }
        }
        None
    };
    let listed = tokio::time::timeout(Duration::from_secs(20), read).await.ok().flatten();
    proc.finish(true).await;
    Some(listed?.as_array()?.iter().filter_map(listed_model).collect())
}

/// One of `initialize`'s models: `{ value, displayName, description: "Fable 5.1 · …", supportedEffortLevels }`.
fn listed_model(m: &Value) -> Option<EngineModel> {
    let id = m.get("value").and_then(Value::as_str).filter(|v| !v.is_empty())?;
    if m.get("disabled").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let description = m.get("description").and_then(Value::as_str);
    // The description leads with the version ("Sonnet 5 · Efficient for routine tasks").
    let version = description.and_then(|d| d.split(" · ").next()).map(str::trim).filter(|s| !s.is_empty());
    let display_name = match (id, version) {
        ("default", Some(version)) => format!("Default · {version}"),
        (_, Some(version)) => version.to_string(),
        _ => m.get("displayName").and_then(Value::as_str).unwrap_or(id).to_string(),
    };
    let efforts = match m.get("supportsEffort").and_then(Value::as_bool) {
        Some(true) => m["supportedEffortLevels"].as_array().into_iter().flatten().filter_map(effort).collect(),
        _ => Vec::new(),
    };
    Some(EngineModel { id: id.to_string(), display_name, description: description.map(str::to_owned), efforts })
}

fn user_line(text: &str) -> Value {
    json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
        "parent_tool_use_id": null,
    })
}

/// A tool result's content as text.
fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

impl Claude {
    async fn go(
        &mut self,
        t: &mut Thread<'_>,
        prompt: &str,
        inbox: &mut mpsc::UnboundedReceiver<Inbox>,
        cancel: &CancellationToken,
    ) -> Result<Ending, String> {
        self.proc.send(&json!({ "type": "control_request", "request_id": "sush-init", "request": { "subtype": "initialize" } })).await?;
        self.proc.send(&user_line(prompt)).await?;
        self.echoes.push_back(None);
        let mut inbox_open = true;
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Ok(Ending::Done),
                msg = inbox.recv(), if inbox_open => match msg {
                    Some(msg) => {
                        if let Some(end) = self.receive(t, msg).await? {
                            return Ok(end);
                        }
                    }
                    None => inbox_open = false,
                },
                line = self.proc.lines.next_line() => match line {
                    Ok(Some(line)) => self.handle(t, &line).await?,
                    _ if self.turn_over && self.echoes.is_empty() => return Ok(Ending::Done),
                    _ => return Err(self.proc.exit_reason().await),
                },
            }
            if !(self.turn_over && self.echoes.is_empty()) {
                continue;
            }
            if let Some(error) = self.error.take() {
                return Err(error);
            }
            if self.pause {
                return Ok(Ending::Paused(std::mem::take(&mut self.held)));
            }
            // Done, unless the user said more meanwhile. The inbox closes before
            // the last look so nothing arrives unseen; later messages start a new run.
            inbox.close();
            inbox_open = false;
            while let Ok(msg) = inbox.try_recv() {
                if let Some(end) = self.receive(t, msg).await? {
                    return Ok(end);
                }
            }
            if self.echoes.is_empty() {
                return Ok(Ending::Done);
            }
        }
    }

    /// Something from the app. Returns how the run ends, when it ends now.
    async fn receive(&mut self, t: &mut Thread<'_>, msg: Inbox) -> Result<Option<Ending>, String> {
        match msg {
            Inbox::Steer { message, .. } if self.pause => self.held.push(message),
            Inbox::Steer { message, .. } => {
                self.proc.send(&user_line(&prompt_text(&message, &HashMap::new()))).await?;
                self.echoes.push_back(Some(message));
                self.turn_over = false;
            }
            Inbox::Respond { call_id, response, by, .. } => self.answer(t, &call_id, response, by).await?,
            Inbox::Interrupt => {
                if self.echoes.iter().any(Option::is_some) {
                    for (id, (request_id, _)) in std::mem::take(&mut self.approvals) {
                        self.reply(&request_id, json!({ "behavior": "deny", "message": INTERRUPTED })).await?;
                        self.denied.insert(id, INTERRUPTED.into());
                    }
                    self.interrupted = true;
                    self.seq += 1;
                    let request_id = format!("sush-interrupt-{}", self.seq);
                    self.proc.send(&json!({ "type": "control_request", "request_id": request_id, "request": { "subtype": "interrupt" } })).await?;
                }
            }
            Inbox::Recheck => {}
            Inbox::Pause => {
                self.pause = true;
                // Only calls waiting for the user are left: nothing to finish first.
                if !self.approvals.is_empty() {
                    return Ok(Some(Ending::Paused(std::mem::take(&mut self.held))));
                }
            }
        }
        Ok(None)
    }

    async fn answer(&mut self, t: &mut Thread<'_>, call_id: &str, response: ToolResponse, by: Option<Author>) -> Result<(), String> {
        let Some((request_id, input)) = self.approvals.remove(call_id) else { return Ok(()) };
        if let Some(by) = by {
            t.record_answer(call_id, &response, by);
        }
        match response {
            ToolResponse::Error { error_text } => {
                self.denied.insert(call_id.to_string(), error_text.clone());
                self.reply(&request_id, json!({ "behavior": "deny", "message": error_text })).await?;
            }
            ToolResponse::Approve | ToolResponse::Output { .. } => {
                t.tool_approved(call_id);
                self.reply(&request_id, json!({ "behavior": "allow", "updatedInput": input })).await?;
            }
        }
        t.working(!self.approvals.is_empty());
        Ok(())
    }

    async fn reply(&mut self, request_id: &str, response: Value) -> Result<(), String> {
        self.proc
            .send(&json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } }))
            .await
    }

    async fn handle(&mut self, t: &mut Thread<'_>, line: &str) -> Result<(), String> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Ok(()) };
        if let Some(session) = v.get("session_id").and_then(Value::as_str) {
            t.set_session(session);
        }
        // A sub-agent's own work: its `Task` call stands for it.
        if v.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
            return Ok(());
        }
        match v.get("type").and_then(Value::as_str).unwrap_or_default() {
            "stream_event" => self.stream_event(t, &v["event"]),
            "assistant" => {
                if let Some(model) = v["message"]["model"].as_str() {
                    t.set_model(model);
                }
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                        let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                        let name = block.get("name").and_then(Value::as_str).unwrap_or_default();
                        let (name, input) = claude_tool(name, &block["input"], &t.cwd);
                        t.tool_ready(id, &name, input);
                    }
                }
            }
            "user" => self.user(t, &v),
            "control_request" => self.control(t, &v).await?,
            "result" => self.result(t, &v),
            _ => {}
        }
        Ok(())
    }

    fn stream_event(&mut self, t: &mut Thread<'_>, event: &Value) {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                self.blocks.clear();
                t.step();
                t.working(!self.approvals.is_empty());
            }
            Some("content_block_start") => {
                let block = &event["content_block"];
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        self.blocks.insert(index, Block::Text);
                    }
                    Some("thinking") => {
                        self.blocks.insert(index, Block::Thinking);
                    }
                    Some("tool_use") => {
                        let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                        let name = block.get("name").and_then(Value::as_str).unwrap_or_default();
                        let (name, _) = claude_tool(name, &json!({}), &t.cwd);
                        t.tool_streaming(id, &name);
                        self.blocks.insert(index, Block::Tool);
                    }
                    _ => {}
                }
            }
            Some("content_block_delta") => {
                let delta = &event["delta"];
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => t.text_delta(delta.get("text").and_then(Value::as_str).unwrap_or_default()),
                    Some("thinking_delta") => t.reasoning_delta(delta.get("thinking").and_then(Value::as_str).unwrap_or_default()),
                    _ => {}
                }
            }
            Some("content_block_stop") => match self.blocks.get(&index) {
                Some(Block::Text) => t.close_text(),
                Some(Block::Thinking) => t.close_reasoning(),
                _ => {}
            },
            _ => {}
        }
    }

    fn user(&mut self, t: &mut Thread<'_>, v: &Value) {
        if v.get("isReplay").and_then(Value::as_bool) == Some(true) {
            // The echo of a message Sush wrote: it's in the conversation now.
            if let Some(Some(message)) = self.echoes.pop_front() {
                t.push_user(message);
                self.turn_over = false;
            }
            return;
        }
        for block in v["message"]["content"].as_array().into_iter().flatten() {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let id = block.get("tool_use_id").and_then(Value::as_str).unwrap_or_default();
            let text = result_text(&block["content"]);
            let result = match self.denied.remove(id) {
                Some(reason) => Err(reason),
                None if block.get("is_error").and_then(Value::as_bool) == Some(true) => Err(text),
                None => Ok(json!(text)),
            };
            t.tool_end(id, result);
        }
    }

    async fn control(&mut self, t: &mut Thread<'_>, v: &Value) -> Result<(), String> {
        let request_id = v.get("request_id").and_then(Value::as_str).unwrap_or_default().to_string();
        let request = &v["request"];
        if request.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
            let response = json!({ "subtype": "error", "request_id": request_id, "error": "Sush doesn't handle this request." });
            return self.proc.send(&json!({ "type": "control_response", "response": response })).await;
        }
        let tool = request.get("tool_name").and_then(Value::as_str).unwrap_or_default();
        let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
        let id = match request.get("tool_use_id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => {
                self.seq += 1;
                format!("claude-permission-{}", self.seq)
            }
        };
        if tool == "AskUserQuestion" {
            return self.reply(&request_id, json!({ "behavior": "deny", "message": ASK_IN_REPLY })).await;
        }
        if tool == "ExitPlanMode" && self.read_only {
            return self.reply(&request_id, json!({ "behavior": "deny", "message": READ_ONLY })).await;
        }
        if !t.has_call(&id) {
            let (name, shown) = claude_tool(tool, &input, &t.cwd);
            t.tool_ready(&id, &name, shown);
        }
        t.tool_waiting(&id);
        self.approvals.insert(id, (request_id, input));
        t.working(true);
        Ok(())
    }

    fn result(&mut self, t: &mut Thread<'_>, v: &Value) {
        self.turn_over = true;
        let n = |v: &Value, key: &str| v.get(key).and_then(Value::as_u64);
        let usage = &v["usage"];
        if usage.is_object() {
            let cached = n(usage, "cache_read_input_tokens");
            let input = n(usage, "input_tokens").unwrap_or(0) + n(usage, "cache_creation_input_tokens").unwrap_or(0) + cached.unwrap_or(0);
            let context = usage["iterations"].as_array().and_then(|i| i.last()).map(|i| {
                n(i, "input_tokens").unwrap_or(0) + n(i, "cache_read_input_tokens").unwrap_or(0) + n(i, "cache_creation_input_tokens").unwrap_or(0)
            });
            t.usage(Some(input), n(usage, "output_tokens"), cached, context);
        }
        let failed = v.get("is_error").and_then(Value::as_bool) == Some(true)
            || v.get("subtype").and_then(Value::as_str).is_some_and(|s| s != "success");
        // An interrupt ends the turn with an error by design.
        if failed && !std::mem::take(&mut self.interrupted) {
            let errors = v.get("errors").and_then(Value::as_array).map(|e| e.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n"));
            let text = v.get("result").and_then(Value::as_str).map(str::to_owned).filter(|s| !s.is_empty()).or(errors.filter(|s| !s.is_empty()));
            self.error = Some(text.unwrap_or_else(|| "Claude Code ran into an error.".into()));
        }
        self.interrupted = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Effort;

    #[test]
    fn listed_models_show_their_versions_and_efforts() {
        // As Claude Code 2.1.268's `initialize` reply lists them.
        let fable = json!({
            "value": "claude-fable-5-1[1m]", "resolvedModel": "claude-fable-5-1", "displayName": "Fable",
            "description": "Fable 5.1 · Most capable for your hardest and longest-running tasks",
            "supportsEffort": true, "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
        });
        let model = listed_model(&fable).unwrap();
        assert_eq!((model.id.as_str(), model.display_name.as_str()), ("claude-fable-5-1[1m]", "Fable 5.1"));
        assert_eq!(model.efforts, vec![Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh, Effort::Max]);

        let default = json!({ "value": "default", "displayName": "Default (recommended)", "description": "Sonnet 5 · Efficient for routine tasks" });
        assert_eq!(listed_model(&default).unwrap().display_name, "Default · Sonnet 5");

        let haiku = json!({ "value": "haiku", "displayName": "Haiku", "description": "Haiku 4.5 · Fastest for quick answers" });
        assert!(listed_model(&haiku).unwrap().efforts.is_empty());

        let disabled = json!({ "value": "cc-update-required-1", "displayName": "Opus 5.5 (disabled)", "disabled": true });
        assert!(listed_model(&disabled).is_none());
    }
}
