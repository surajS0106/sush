//! Codex as `codex app-server`: JSON-RPC over stdio, one JSON object a line
//! (without the `"jsonrpc"` member), as the user installed it and signed in
//! to it with `codex login`. Written to the app-server's v2 protocol
//! (https://developers.openai.com/codex/app-server); not yet run against a
//! live Codex, so check it end to end before relying on it.
//!
//! - `initialize`, the `initialized` notification, then `thread/start` (or
//!   `thread/resume` with the session id) and `turn/start` with the message.
//! - Items stream as `item/started`, deltas and `item/completed`; the turn
//!   ends with `turn/completed`. Plans (`turn/plan/updated`) show as the to-do list.
//! - Approvals arrive as requests (`item/commandExecution/requestApproval`,
//!   `item/fileChange/requestApproval`) and are answered from the call's card.
//! - A message sent while a turn works waits for its end and starts the next
//!   turn; "Send now" interrupts the turn (`turn/interrupt`) first.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{effort, effort_str, prompt_text, relative, Context, EngineModel, Ending, Kind, Proc, Thread};
use crate::agent::run::{Author, Inbox, ToolResponse, INTERRUPTED};
use crate::workspace::{tools as ws_tools, Access, Commands, EditApproval};

/// An approval request waiting for the user: its JSON-RPC id, and whether it
/// came in the older (v1) form, which words its decisions differently.
struct Pending {
    rpc_id: Value,
    v1: bool,
}

struct Codex {
    proc: Proc,
    next_id: u64,
    thread_id: String,
    turn_id: Option<String>,
    /// Calls waiting for the user, by item id.
    approvals: HashMap<String, Pending>,
    denied: HashMap<String, String>,
    /// Items whose text arrived as deltas, so their completion doesn't repeat it.
    streamed: HashSet<String>,
    /// Messages for the next turn.
    queued: Vec<Value>,
    pause: bool,
    interrupt_sent: bool,
    turn_over: bool,
    plans: u64,
    error: Option<String>,
}

pub(super) async fn drive(
    t: &mut Thread<'_>,
    ctx: &Context,
    session: Option<String>,
    prompt: String,
    inbox: &mut mpsc::UnboundedReceiver<Inbox>,
    cancel: &CancellationToken,
) -> Result<Ending, String> {
    let mut c = Codex {
        proc: Proc::spawn(Kind::Codex, &["app-server".to_string()], &ctx.cwd)?,
        next_id: 0,
        thread_id: String::new(),
        turn_id: None,
        approvals: HashMap::new(),
        denied: HashMap::new(),
        streamed: HashSet::new(),
        queued: Vec::new(),
        pause: false,
        interrupt_sent: false,
        turn_over: false,
        plans: 0,
        error: None,
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Ok(Ending::Done),
        result = c.go(t, ctx, session, &prompt, inbox, cancel) => result,
    };
    c.proc.finish(true).await;
    result
}

fn client_info() -> Value {
    json!({ "name": "sush", "title": "Sush", "version": env!("CARGO_PKG_VERSION") })
}

/// The models this install offers (`model/list`), after its own default.
/// Starts the app-server without a thread, so no model is called.
pub(super) async fn models() -> Option<Vec<EngineModel>> {
    let mut proc = Proc::spawn(Kind::Codex, &["app-server".to_string()], &std::env::temp_dir()).ok()?;
    async fn response(proc: &mut Proc, id: u64) -> Option<Value> {
        while let Ok(Some(line)) = proc.lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("method").is_none() && v.get("id").and_then(Value::as_u64) == Some(id) {
                return v.get("result").cloned();
            }
        }
        None
    }
    let read = async {
        proc.send(&json!({ "id": 1, "method": "initialize", "params": { "clientInfo": client_info() } })).await.ok()?;
        response(&mut proc, 1).await?;
        proc.send(&json!({ "method": "initialized" })).await.ok()?;
        proc.send(&json!({ "id": 2, "method": "model/list", "params": {} })).await.ok()?;
        response(&mut proc, 2).await
    };
    let listed = tokio::time::timeout(std::time::Duration::from_secs(20), read).await.ok().flatten();
    proc.finish(true).await;
    let listed = listed?;
    let list = listed.get("data").or_else(|| listed.get("models")).and_then(Value::as_array)?;
    let mut models = Kind::Codex.models();
    models.extend(list.iter().filter_map(listed_model));
    Some(models)
}

/// One of `model/list`'s models: `{ model, displayName, description, supportedReasoningEfforts }`.
fn listed_model(m: &Value) -> Option<EngineModel> {
    let id = m.get("model").or_else(|| m.get("id")).and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let efforts = m["supportedReasoningEfforts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| effort(e.get("reasoningEffort").or_else(|| e.get("effort")).unwrap_or(e)))
        .collect();
    Some(EngineModel {
        id: id.to_string(),
        display_name: m.get("displayName").and_then(Value::as_str).unwrap_or(id).to_string(),
        description: m.get("description").and_then(Value::as_str).map(str::to_owned),
        efforts,
    })
}

/// The sandbox and approval policy that match the folder's settings in Sush.
fn settings(ctx: &Context) -> (&'static str, &'static str) {
    let sandbox = match (ctx.access, ctx.commands) {
        (Access::ReadOnly, _) => "read-only",
        (_, Commands::Desktop) => "danger-full-access",
        (_, Commands::Sandbox) => "workspace-write",
    };
    let policy = match ctx.approval {
        EditApproval::AutoEdits => "on-request",
        EditApproval::Ask => "untrusted",
    };
    (sandbox, policy)
}

fn s<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// A command as text, whether it came as a string or as argv.
fn command_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(argv) => argv.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    }
}

/// A file change as the card for it: one file added, deleted or edited.
fn file_change(changes: &Value, cwd: &std::path::Path) -> (String, Value) {
    let list = changes.as_array().cloned().unwrap_or_default();
    let first = list.first().cloned().unwrap_or(Value::Null);
    let kind = first.get("kind").map(|k| k.as_str().or_else(|| k.get("type").and_then(Value::as_str)).unwrap_or_default()).unwrap_or_default();
    let name = match (list.len(), kind) {
        (1, "add") => "fs_write",
        (1, "delete") => "fs_delete",
        _ => "fs_edit",
    };
    let paths: Vec<Value> = list.iter().map(|c| relative(c.get("path").and_then(Value::as_str), cwd)).collect();
    (name.to_string(), json!({ "path": paths.first().cloned().unwrap_or(Value::Null), "paths": paths }))
}

/// An MCP result's text, or the result itself.
fn mcp_output(result: &Value) -> Value {
    let texts: Vec<&str> = result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| c.get("text").and_then(Value::as_str))
        .collect();
    if texts.is_empty() {
        result.clone()
    } else {
        json!(texts.join("\n"))
    }
}

impl Codex {
    async fn request(&mut self, method: &str, params: Value) -> Result<u64, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.proc.send(&json!({ "id": id, "method": method, "params": params })).await?;
        Ok(id)
    }

    /// Send a request and wait for its response, handling whatever arrives meanwhile.
    async fn call(&mut self, t: &mut Thread<'_>, method: &str, params: Value) -> Result<Value, String> {
        let id = self.request(method, params).await?;
        loop {
            let line = match self.proc.lines.next_line().await {
                Ok(Some(line)) => line,
                _ => return Err(self.proc.exit_reason().await),
            };
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("method").is_none() && v.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = v.get("error") {
                    let message = error.get("message").and_then(Value::as_str).unwrap_or("Codex refused the request.");
                    return Err(format!("Codex: {message}"));
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
            self.handle(t, v).await?;
        }
    }

    async fn go(
        &mut self,
        t: &mut Thread<'_>,
        ctx: &Context,
        session: Option<String>,
        prompt: &str,
        inbox: &mut mpsc::UnboundedReceiver<Inbox>,
        cancel: &CancellationToken,
    ) -> Result<Ending, String> {
        let client = client_info();
        self.call(t, "initialize", json!({ "clientInfo": client })).await?;
        self.proc.send(&json!({ "method": "initialized" })).await?;

        let (sandbox, policy) = settings(ctx);
        let mut params = Map::new();
        params.insert("cwd".into(), json!(ctx.cwd.to_string_lossy()));
        params.insert("approvalPolicy".into(), json!(policy));
        params.insert("sandbox".into(), json!(sandbox));
        if !t.model.is_empty() && t.model != "default" {
            params.insert("model".into(), json!(t.model));
        }
        let resumed = match &session {
            Some(id) => {
                let mut resume = params.clone();
                resume.insert("threadId".into(), json!(id));
                self.call(t, "thread/resume", Value::Object(resume)).await.ok()
            }
            None => None,
        };
        let thread = match resumed {
            Some(thread) => thread,
            None => self.call(t, "thread/start", Value::Object(params)).await?,
        };
        self.thread_id = thread["thread"]["id"].as_str().or_else(|| thread["threadId"].as_str()).unwrap_or_default().to_string();
        if self.thread_id.is_empty() {
            return Err("Codex didn't start a session.".into());
        }
        if let Some(model) = thread["model"].as_str() {
            t.set_model(model);
        }
        t.set_session(&self.thread_id.clone());
        self.start_turn(t, prompt).await?;

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
                    Ok(Some(line)) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&line) {
                            self.handle(t, v).await?;
                        }
                    }
                    _ => return Err(self.proc.exit_reason().await),
                },
            }
            if !self.turn_over {
                continue;
            }
            if let Some(error) = self.error.take() {
                return Err(error);
            }
            if self.pause {
                return Ok(Ending::Paused(std::mem::take(&mut self.queued)));
            }
            if self.queued.is_empty() {
                // The inbox closes before the last look so nothing arrives unseen.
                inbox.close();
                inbox_open = false;
                while let Ok(msg) = inbox.try_recv() {
                    if let Some(end) = self.receive(t, msg).await? {
                        return Ok(end);
                    }
                }
            }
            if self.queued.is_empty() {
                return Ok(Ending::Done);
            }
            // What the user sent meanwhile is the next turn.
            let messages = std::mem::take(&mut self.queued);
            let text = messages.iter().map(|m| prompt_text(m, &HashMap::new())).collect::<Vec<_>>().join("\n\n");
            for message in messages {
                t.push_user(message);
            }
            self.start_turn(t, &text).await?;
        }
    }

    async fn start_turn(&mut self, t: &mut Thread<'_>, text: &str) -> Result<(), String> {
        self.turn_over = false;
        let mut params = json!({ "threadId": self.thread_id, "input": [{ "type": "text", "text": text }] });
        if let Some(effort) = t.effort {
            params["effort"] = json!(effort_str(effort));
        }
        let result = self.call(t, "turn/start", params).await?;
        if let Some(id) = result["turn"]["id"].as_str() {
            self.turn_id = Some(id.to_string());
        }
        Ok(())
    }

    async fn receive(&mut self, t: &mut Thread<'_>, msg: Inbox) -> Result<Option<Ending>, String> {
        match msg {
            Inbox::Steer { message, .. } => self.queued.push(message),
            Inbox::Respond { call_id, response, by, .. } => self.answer(t, &call_id, response, by).await?,
            Inbox::Interrupt => {
                if !self.queued.is_empty() && !self.turn_over {
                    for (id, pending) in std::mem::take(&mut self.approvals) {
                        self.decide(&pending, false).await?;
                        self.denied.insert(id, INTERRUPTED.into());
                    }
                    if let Some(turn_id) = self.turn_id.clone() {
                        self.interrupt_sent = true;
                        self.request("turn/interrupt", json!({ "threadId": self.thread_id, "turnId": turn_id })).await?;
                    }
                }
            }
            Inbox::Recheck => {}
            Inbox::Pause => {
                self.pause = true;
                if !self.approvals.is_empty() {
                    return Ok(Some(Ending::Paused(std::mem::take(&mut self.queued))));
                }
            }
        }
        Ok(None)
    }

    async fn answer(&mut self, t: &mut Thread<'_>, call_id: &str, response: ToolResponse, by: Option<Author>) -> Result<(), String> {
        let Some(pending) = self.approvals.remove(call_id) else { return Ok(()) };
        if let Some(by) = by {
            t.record_answer(call_id, &response, by);
        }
        match response {
            ToolResponse::Error { error_text } => {
                self.denied.insert(call_id.to_string(), error_text);
                self.decide(&pending, false).await?;
            }
            ToolResponse::Approve | ToolResponse::Output { .. } => {
                t.tool_approved(call_id);
                self.decide(&pending, true).await?;
            }
        }
        t.working(!self.approvals.is_empty());
        Ok(())
    }

    async fn decide(&mut self, pending: &Pending, allow: bool) -> Result<(), String> {
        let decision = match (pending.v1, allow) {
            (false, true) => "accept",
            (false, false) => "decline",
            (true, true) => "approved",
            (true, false) => "denied",
        };
        self.proc.send(&json!({ "id": pending.rpc_id, "result": { "decision": decision } })).await
    }

    async fn handle(&mut self, t: &mut Thread<'_>, v: Value) -> Result<(), String> {
        let Some(method) = v.get("method").and_then(Value::as_str) else {
            // A response to something not waited for (an interrupt, say).
            return Ok(());
        };
        let params = v.get("params").cloned().unwrap_or(Value::Null);
        match v.get("id") {
            Some(id) => self.server_request(t, id.clone(), method, &params).await,
            None => {
                self.notification(t, method, &params);
                Ok(())
            }
        }
    }

    async fn server_request(&mut self, t: &mut Thread<'_>, rpc_id: Value, method: &str, p: &Value) -> Result<(), String> {
        let (call, v1) = match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => (s(p, "itemId").to_string(), false),
            "execCommandApproval" | "applyPatchApproval" => (s(p, "callId").to_string(), true),
            _ => {
                let error = json!({ "code": -32601, "message": "Sush doesn't handle this request." });
                return self.proc.send(&json!({ "id": rpc_id, "error": error })).await;
            }
        };
        if !t.has_call(&call) {
            if method.contains("ommand") {
                let command = command_text(p.get("command").unwrap_or(&Value::Null));
                t.tool_ready(&call, ws_tools::SHELL_RUN, json!({ "command": command, "justification": p.get("reason"), "unsandboxed": true }));
            } else {
                let (name, input) = file_change(p.get("changes").unwrap_or(&Value::Null), &t.cwd);
                t.tool_ready(&call, &name, input);
            }
        }
        t.tool_waiting(&call);
        self.approvals.insert(call, Pending { rpc_id, v1 });
        t.working(true);
        Ok(())
    }

    fn notification(&mut self, t: &mut Thread<'_>, method: &str, p: &Value) {
        match method {
            "turn/started" => {
                if let Some(id) = p["turn"]["id"].as_str() {
                    self.turn_id = Some(id.to_string());
                }
                t.step();
                t.working(!self.approvals.is_empty());
            }
            "item/started" => self.item(t, &p["item"], false),
            "item/completed" => self.item(t, &p["item"], true),
            "item/agentMessage/delta" => {
                self.streamed.insert(s(p, "itemId").to_string());
                t.text_delta(s(p, "delta"));
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                self.streamed.insert(s(p, "itemId").to_string());
                t.reasoning_delta(s(p, "delta"));
            }
            "turn/plan/updated" => {
                let todos: Vec<Value> = p["plan"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|step| {
                        let status = match s(step, "status") {
                            "completed" => "completed",
                            "inProgress" | "in_progress" => "in_progress",
                            _ => "pending",
                        };
                        json!({ "content": s(step, "step"), "status": status })
                    })
                    .collect();
                if !todos.is_empty() {
                    self.plans += 1;
                    let id = format!("codex-plan-{}", self.plans);
                    t.tool_done(&id, "todo_write", json!({ "todos": todos }), json!("Updated the plan."));
                }
            }
            "thread/tokenUsage/updated" => {
                let usage = p.get("tokenUsage").or_else(|| p.get("usage")).unwrap_or(&Value::Null);
                let n = |v: &Value, key: &str| v.get(key).and_then(Value::as_u64);
                let (total, last) = (&usage["total"], &usage["last"]);
                t.usage(n(total, "inputTokens"), n(total, "outputTokens"), n(total, "cachedInputTokens"), n(last, "inputTokens"));
            }
            "turn/completed" => {
                let turn = &p["turn"];
                if s(turn, "status") == "failed" && !self.interrupt_sent {
                    let message = turn["error"]["message"].as_str().unwrap_or("Codex couldn't finish the turn.");
                    self.error = Some(message.to_string());
                }
                self.interrupt_sent = false;
                self.turn_over = true;
                self.turn_id = None;
            }
            "error" => {
                if p.get("willRetry").and_then(Value::as_bool) != Some(true) {
                    if let Some(message) = p["error"]["message"].as_str() {
                        self.error = Some(message.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    fn item(&mut self, t: &mut Thread<'_>, item: &Value, done: bool) {
        let id = s(item, "id").to_string();
        match s(item, "type") {
            "agentMessage" => {
                if done && !self.streamed.remove(&id) {
                    t.text_delta(s(item, "text"));
                }
                t.close_text();
            }
            "reasoning" => {
                if done {
                    if !self.streamed.remove(&id) {
                        let summary: Vec<&str> = item["summary"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                        t.reasoning_delta(&summary.join("\n\n"));
                    }
                    t.close_reasoning();
                }
            }
            "commandExecution" => {
                let input = json!({ "command": command_text(&item["command"]), "unsandboxed": true });
                if !t.has_call(&id) {
                    t.tool_ready(&id, ws_tools::SHELL_RUN, input);
                }
                if done {
                    let output = s(item, "aggregatedOutput").trim_end();
                    let mut text = item.get("exitCode").and_then(Value::as_i64).map(|c| format!("Exit code: {c}")).unwrap_or_default();
                    if !output.is_empty() {
                        text.push_str(&format!("\n<stdout>\n{output}\n</stdout>"));
                    }
                    let result = match self.denied.remove(&id) {
                        Some(reason) => Err(reason),
                        None if s(item, "status") == "declined" => Err("Declined.".into()),
                        None => Ok(json!(text.trim_start())),
                    };
                    t.tool_end(&id, result);
                }
            }
            "fileChange" => {
                if !t.has_call(&id) {
                    let (name, input) = file_change(&item["changes"], &t.cwd);
                    t.tool_ready(&id, &name, input);
                }
                if done {
                    let count = item["changes"].as_array().map_or(0, Vec::len);
                    let result = match self.denied.remove(&id) {
                        Some(reason) => Err(reason),
                        None if matches!(s(item, "status"), "failed" | "declined") => Err("The change wasn't applied.".into()),
                        None => Ok(json!(format!("Changed {count} file{}.", if count == 1 { "" } else { "s" }))),
                    };
                    t.tool_end(&id, result);
                }
            }
            "mcpToolCall" => {
                if !t.has_call(&id) {
                    let name = format!("{}{}.{}", Kind::Codex.tool_prefix(), s(item, "server"), s(item, "tool"));
                    t.tool_ready(&id, &name, item.get("arguments").cloned().unwrap_or_else(|| json!({})));
                }
                if done {
                    let result = match item.get("error").filter(|e| !e.is_null()) {
                        Some(error) => Err(error.get("message").and_then(Value::as_str).map_or_else(|| error.to_string(), str::to_owned)),
                        None => Ok(mcp_output(&item["result"])),
                    };
                    t.tool_end(&id, result);
                }
            }
            "webSearch" => {
                let name = format!("{}web_search", Kind::Codex.tool_prefix());
                if !t.has_call(&id) {
                    t.tool_ready(&id, &name, json!({ "query": s(item, "query") }));
                }
                if done {
                    t.tool_end(&id, Ok(json!("Searched the web.")));
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn file_changes_pick_a_card() {
        let cwd = Path::new("/w");
        let (name, input) = file_change(&json!([{ "path": "/w/new.rs", "kind": "add" }]), cwd);
        assert_eq!((name.as_str(), input["path"].clone()), ("fs_write", json!("new.rs")));
        let (name, _) = file_change(&json!([{ "path": "/w/a.rs", "kind": { "type": "update" } }, { "path": "/w/b.rs", "kind": "add" }]), cwd);
        assert_eq!(name, "fs_edit");
    }

    #[test]
    fn mcp_results_read_as_text() {
        assert_eq!(mcp_output(&json!({ "content": [{ "type": "text", "text": "ok" }] })), json!("ok"));
        assert_eq!(mcp_output(&json!({ "value": 1 })), json!({ "value": 1 }));
    }
}
