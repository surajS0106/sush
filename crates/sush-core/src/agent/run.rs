//! One run of the agent loop on a thread: stream a model step, resolve its
//! tool calls, and repeat until the model answers without calling tools.
//!
//! Tool calls marked `Ask` wait for the user (approval cards, `ask_user`);
//! while only those remain the run reports `Awaiting` and keeps waiting on its
//! inbox, so answering continues the same run. If the app restarted in
//! between, a `Respond` action starts a fresh run that picks the calls up from
//! the saved messages.

use std::collections::HashMap;

use async_trait::async_trait;
use futures::stream::FuturesUnordered;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::ui::{self, apply, Op, StepBuilder, ToolCall, STOPPED};
use crate::message::{ChatRequest, ToolSpec};
use crate::provider::EventStream;

/// What the UI asks a run to do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum RunAction {
    /// Add a user message; with `replace`, it replaces that message and drops everything after it.
    Send { message: Value, replace: Option<String> },
    /// Ask again: drops the given assistant message (default: the last one) and what follows it.
    Regenerate { message_id: Option<String> },
    /// Answer a tool call that is waiting for the user.
    Respond { call_id: String, response: ToolResponse },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ToolResponse {
    /// Run the call as planned (e.g. a connector tool the user allowed).
    Approve,
    /// The user (or the UI) supplied the result, e.g. an `ask_user` answer.
    Output { output: Value },
    Error { error_text: String },
}

/// Everything a request needs besides the messages. The UI builds it (it owns
/// skills, connectors and preferences) and sends a fresh one with each action.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfig {
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub tools: Vec<RunTool>,
    #[serde(default)]
    pub research: bool,
    /// Text sent to the model in place of a user message's first text, by message id.
    #[serde(default)]
    pub expansions: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTool {
    #[serde(flatten)]
    pub spec: ToolSpec,
    pub exec: ToolExec,
    pub approval: Approval,
}

/// Where a tool runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ToolExec {
    /// An MCP connector tool, called from Rust.
    Connector { connector_id: String, tool: String },
    /// Run by the UI (memory, skills, artifacts, ...).
    Client,
    /// A file or shell tool in the thread's Cowork workspace, run in Rust.
    /// Only the host adds these; it drops any the UI sends.
    Workspace,
    /// A tool for the host's built-in browser (`crate::browser`). Like
    /// workspace tools, only the host adds these.
    Browser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Approval {
    Auto,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunStatus {
    /// Waiting for the model's first token.
    Submitted,
    Streaming,
    /// Only tool calls waiting for the user remain.
    Awaiting,
    Ready,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    Op(Op),
    Status { status: RunStatus, error: Option<String> },
    ToolRunning { call_id: String, running: bool },
}

/// A response delivered to a live run.
#[derive(Debug, Clone)]
pub struct Inbox {
    pub call_id: String,
    pub response: ToolResponse,
    /// Replaces the run's config, e.g. after "Always allow" changed a tool's approval.
    pub config: Option<RunConfig>,
}

/// What the run needs from the app.
#[async_trait]
pub trait RunHost: Send + Sync {
    /// Start a model request (resolving stored attachments first).
    async fn stream(&self, provider_id: &str, request: ChatRequest) -> Result<EventStream, String>;
    /// Run an approved tool call. Must return promptly once `cancel` fires.
    async fn execute(&self, call: &ToolCall, exec: &ToolExec, cancel: CancellationToken) -> Result<Value, String>;
    fn emit(&self, event: RunEvent);
    async fn save(&self, messages: &[Value]);
    /// Whether this call needs the user first. By default the tool's own
    /// setting; hosts can decide per call (e.g. reading a secrets file).
    fn approval(&self, _call: &ToolCall, tool: &RunTool) -> Approval {
        tool.approval
    }
}

/// Run `action` on a thread's `messages` and return them as they end up.
pub async fn run(
    host: &dyn RunHost,
    messages: Vec<Value>,
    action: RunAction,
    config: RunConfig,
    inbox: &mut mpsc::UnboundedReceiver<Inbox>,
    cancel: &CancellationToken,
) -> Vec<Value> {
    let mut r = Runner { host, messages, config, cancel: cancel.clone(), status: None };
    let mut early = Vec::new();
    let resume = match action {
        RunAction::Send { mut message, replace } => {
            if let Some(i) = replace.as_deref().and_then(|id| r.position(id)) {
                r.messages.truncate(i);
                message["id"] = json!(replace);
            }
            if message.get("id").and_then(Value::as_str).is_none() {
                message["id"] = json!(ui::new_id());
            }
            r.messages.push(message);
            false
        }
        RunAction::Regenerate { message_id } => {
            let at = match message_id.as_deref().and_then(|id| r.position(id)) {
                Some(i) if ui::role(&r.messages[i]) == Some("assistant") => Some(i),
                Some(i) => Some(i + 1),
                None => r.messages.iter().rposition(|m| ui::role(m) == Some("assistant")),
            };
            if let Some(i) = at {
                r.messages.truncate(i);
            }
            false
        }
        RunAction::Respond { call_id, response } => {
            early.push((call_id, response));
            true
        }
    };
    // The UI starts each run from exactly what the run sees.
    host.emit(RunEvent::Op(Op::Reset { messages: r.messages.clone() }));

    let outcome = r.drive(inbox, resume, early).await;
    host.save(&r.messages).await;
    match outcome {
        Ok(()) => r.status(RunStatus::Ready, None),
        Err(e) => r.status(RunStatus::Error, Some(e)),
    }
    r.messages
}

enum Resolved {
    /// Every call has a result; hand the turn back to the model.
    Done,
    /// There was nothing to resolve.
    Nothing,
    Cancelled,
}

struct Runner<'a> {
    host: &'a dyn RunHost,
    messages: Vec<Value>,
    config: RunConfig,
    cancel: CancellationToken,
    status: Option<RunStatus>,
}

impl Runner<'_> {
    fn op(&mut self, op: Op) {
        apply(&mut self.messages, &op);
        self.host.emit(RunEvent::Op(op));
    }

    fn status(&mut self, status: RunStatus, error: Option<String>) {
        if self.status != Some(status) || error.is_some() {
            self.status = Some(status);
            self.host.emit(RunEvent::Status { status, error });
        }
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.messages.iter().position(|m| m.get("id").and_then(Value::as_str) == Some(id))
    }

    async fn drive(
        &mut self,
        inbox: &mut mpsc::UnboundedReceiver<Inbox>,
        mut resolve_first: bool,
        mut early: Vec<(String, ToolResponse)>,
    ) -> Result<(), String> {
        loop {
            if resolve_first {
                let resolved = self.resolve(inbox, std::mem::take(&mut early)).await;
                self.host.save(&self.messages).await;
                match resolved {
                    Resolved::Done => {}
                    Resolved::Nothing | Resolved::Cancelled => return Ok(()),
                }
            }
            let Some(calls) = self.step().await? else { return Ok(()) };
            self.host.save(&self.messages).await;
            if calls == 0 {
                return Ok(());
            }
            resolve_first = true;
        }
    }

    /// One model request, streamed into the last assistant message. Returns
    /// how many tool calls it made, or None if it was cancelled.
    async fn step(&mut self) -> Result<Option<usize>, String> {
        if self.cancel.is_cancelled() {
            return Ok(None);
        }
        self.status(RunStatus::Submitted, None);
        let request = ChatRequest {
            model: self.config.model.clone(),
            messages: ui::to_core(&self.messages, &self.config.expansions),
            system: self.config.system.clone(),
            max_tokens: None,
            temperature: None,
            tools: self.config.tools.iter().map(|t| t.spec.clone()).collect(),
            research: self.config.research,
        };
        // Steps after tool calls continue the same assistant message, like the AI SDK does.
        let metadata = json!({ "providerId": self.config.provider_id, "model": self.config.model });
        if self.messages.last().and_then(ui::role) == Some("assistant") {
            self.op(Op::SetMetadata { metadata });
        } else {
            // When the reply started, for usage over a period (Settings → Usage).
            let created_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64);
            let mut metadata = metadata;
            metadata["createdAt"] = json!(created_at);
            self.op(Op::Push { message: json!({ "id": ui::new_id(), "role": "assistant", "parts": [], "metadata": metadata }) });
        }
        self.op(Op::PushPart { part: json!({ "type": "step-start" }) });

        let host = self.host;
        let provider_id = self.config.provider_id.clone();
        let mut stream = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Ok(None),
            s = host.stream(&provider_id, request) => s?,
        };
        let last = self.messages.last();
        let mut builder = StepBuilder::new(last.map_or(0, |m| ui::parts(m).len())).after(last.and_then(|m| m.get("metadata")));
        loop {
            let next = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => {
                    for op in builder.end() { self.op(op); }
                    return Ok(None);
                }
                next = stream.next() => next,
            };
            match next {
                Some(Ok(event)) => {
                    self.status(RunStatus::Streaming, None);
                    for op in builder.handle(event) {
                        self.op(op);
                    }
                    if let Some(e) = builder.error.take() {
                        for op in builder.end() {
                            self.op(op);
                        }
                        return Err(e);
                    }
                }
                Some(Err(e)) => {
                    for op in builder.end() {
                        self.op(op);
                    }
                    return Err(e.to_string());
                }
                None => break,
            }
        }
        let (ops, calls) = builder.finish();
        for op in ops {
            self.op(op);
        }
        Ok(Some(calls.len()))
    }

    /// Get a result for every open tool call in the last message: run the ones
    /// that need no approval, and wait for the user on the rest.
    async fn resolve(&mut self, inbox: &mut mpsc::UnboundedReceiver<Inbox>, early: Vec<(String, ToolResponse)>) -> Resolved {
        let open = ui::unresolved_calls(&self.messages);
        if open.is_empty() {
            return Resolved::Nothing;
        }
        let host = self.host;
        let mut waiting: HashMap<String, (usize, ToolCall)> = HashMap::new();
        let mut running = FuturesUnordered::new();
        let mut in_flight: HashMap<String, (usize, ToolCall)> = HashMap::new();

        let start = |index: usize, call: ToolCall, exec: ToolExec, cancel: CancellationToken| {
            host.emit(RunEvent::ToolRunning { call_id: call.id.clone(), running: true });
            async move {
                let result = host.execute(&call, &exec, cancel).await;
                (index, call, result)
            }
        };

        for (index, call) in open {
            match self.tool(&call.name).cloned() {
                None => self.set_result(index, &call, Err(format!(
                    "Unknown tool {}. It may belong to a connector that was turned off.",
                    call.name
                ))),
                Some(t) if host.approval(&call, &t) == Approval::Auto => {
                    in_flight.insert(call.id.clone(), (index, call.clone()));
                    running.push(start(index, call, t.exec, self.cancel.child_token()));
                }
                Some(_) => {
                    waiting.insert(call.id.clone(), (index, call));
                }
            }
        }

        let mut queued: std::collections::VecDeque<Inbox> =
            early.into_iter().map(|(call_id, response)| Inbox { call_id, response, config: None }).collect();
        loop {
            // Answers first, so a resume applies its response before anything else.
            while let Some(msg) = queued.pop_front() {
                if let Some(config) = msg.config {
                    self.config = config;
                }
                let Some((index, call)) = waiting.remove(&msg.call_id) else { continue };
                match msg.response {
                    ToolResponse::Approve => match self.tool(&call.name).map(|t| t.exec.clone()) {
                        Some(exec) => {
                            in_flight.insert(call.id.clone(), (index, call.clone()));
                            running.push(start(index, call, exec, self.cancel.child_token()));
                        }
                        None => self.set_result(index, &call, Err(format!("Unknown tool {}.", call.name))),
                    },
                    ToolResponse::Output { output } => self.set_result(index, &call, Ok(output)),
                    ToolResponse::Error { error_text } => self.set_result(index, &call, Err(error_text)),
                }
            }
            // A stop wins over anything that finished at the same moment.
            if self.cancel.is_cancelled() {
                for (_, (index, call)) in in_flight.drain() {
                    self.host.emit(RunEvent::ToolRunning { call_id: call.id.clone(), running: false });
                    self.set_result(index, &call, Err(STOPPED.into()));
                }
                return Resolved::Cancelled;
            }
            if waiting.is_empty() && running.is_empty() {
                return Resolved::Done;
            }
            if running.is_empty() {
                self.status(RunStatus::Awaiting, None);
            }
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => continue,
                Some((index, call, result)) = running.next(), if !running.is_empty() => {
                    in_flight.remove(&call.id);
                    self.host.emit(RunEvent::ToolRunning { call_id: call.id.clone(), running: false });
                    self.set_result(index, &call, result);
                }
                msg = inbox.recv() => match msg {
                    Some(msg) => queued.push_back(msg),
                    // The host dropped the run's sender; nobody can answer any more.
                    None if running.is_empty() => return Resolved::Cancelled,
                    None => {}
                },
            }
        }
    }

    fn tool(&self, name: &str) -> Option<&RunTool> {
        self.config.tools.iter().find(|t| t.spec.name == name)
    }

    fn set_result(&mut self, index: usize, call: &ToolCall, result: Result<Value, String>) {
        self.op(Op::SetPart { index, part: ui::tool_result_part(call, result) });
    }
}

/// A config with these tools, for tests and simple hosts.
pub fn tools(specs: impl IntoIterator<Item = (ToolSpec, ToolExec, Approval)>) -> Vec<RunTool> {
    specs.into_iter().map(|(spec, exec, approval)| RunTool { spec, exec, approval }).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::message::ChatEvent;

    /// Replays one scripted response per model step and records what happened.
    struct FakeHost {
        steps: Mutex<Vec<Vec<ChatEvent>>>,
        requests: Mutex<Vec<ChatRequest>>,
        events: Mutex<Vec<RunEvent>>,
        executed: Mutex<Vec<String>>,
        saves: Mutex<usize>,
        /// Tool calls never finish, to test cancelling.
        hang_tools: bool,
    }

    impl FakeHost {
        fn new(steps: Vec<Vec<ChatEvent>>) -> Arc<Self> {
            Arc::new(Self {
                steps: Mutex::new(steps.into_iter().rev().collect()),
                requests: Mutex::default(),
                events: Mutex::default(),
                executed: Mutex::default(),
                saves: Mutex::default(),
                hang_tools: false,
            })
        }

        fn statuses(&self) -> Vec<RunStatus> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    RunEvent::Status { status, .. } => Some(*status),
                    _ => None,
                })
                .collect()
        }
    }

    #[async_trait]
    impl RunHost for FakeHost {
        async fn stream(&self, _: &str, request: ChatRequest) -> Result<EventStream, String> {
            self.requests.lock().unwrap().push(request);
            let events = self.steps.lock().unwrap().pop().ok_or("no more scripted steps")?;
            Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
        }
        async fn execute(&self, call: &ToolCall, _: &ToolExec, cancel: CancellationToken) -> Result<Value, String> {
            self.executed.lock().unwrap().push(call.name.clone());
            if self.hang_tools {
                cancel.cancelled().await;
                return Err(STOPPED.into());
            }
            Ok(json!(format!("ran {}", call.name)))
        }
        fn emit(&self, event: RunEvent) {
            self.events.lock().unwrap().push(event);
        }
        async fn save(&self, _: &[Value]) {
            *self.saves.lock().unwrap() += 1;
        }
    }

    fn spec(name: &str) -> ToolSpec {
        ToolSpec { name: name.into(), description: String::new(), input_schema: json!({ "type": "object" }) }
    }

    fn config() -> RunConfig {
        RunConfig {
            provider_id: "p".into(),
            model: "m".into(),
            tools: tools([
                (spec("auto_tool"), ToolExec::Client, Approval::Auto),
                (spec("ask_tool"), ToolExec::Connector { connector_id: "c".into(), tool: "t".into() }, Approval::Ask),
            ]),
            ..Default::default()
        }
    }

    fn user(text: &str) -> RunAction {
        RunAction::Send { message: json!({ "role": "user", "parts": [{ "type": "text", "text": text }] }), replace: None }
    }

    fn call(name: &str) -> ChatEvent {
        ChatEvent::ToolCallDelta { index: 0, id: Some(format!("id-{name}")), name: Some(name.into()), args_delta: "{}".into() }
    }

    fn text(t: &str) -> ChatEvent {
        ChatEvent::TextDelta { delta: t.into() }
    }

    #[tokio::test]
    async fn auto_tools_run_and_the_model_continues_in_the_same_message() {
        let host = FakeHost::new(vec![vec![call("auto_tool")], vec![text("done")]]);
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let messages = run(&*host, vec![], user("hi"), config(), &mut rx, &CancellationToken::new()).await;

        assert_eq!(messages.len(), 2);
        let parts = ui::parts(&messages[1]);
        let types: Vec<_> = parts.iter().map(|p| p["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["step-start", "dynamic-tool", "step-start", "text"]);
        assert_eq!(parts[1]["output"], "ran auto_tool");
        assert_eq!(*host.executed.lock().unwrap(), ["auto_tool"]);
        // The second request carries the tool result.
        let second = &host.requests.lock().unwrap()[1];
        assert!(matches!(second.messages[1].parts[1], crate::Part::ToolResult { .. }));
        assert_eq!(host.statuses().last(), Some(&RunStatus::Ready));
        assert!(*host.saves.lock().unwrap() >= 2);
    }

    #[tokio::test]
    async fn ask_tools_wait_for_the_user_then_continue() {
        let host = FakeHost::new(vec![vec![call("ask_tool")], vec![text("thanks")]]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let runner = {
            let host = host.clone();
            tokio::spawn(async move { run(&*host, vec![], user("hi"), config(), &mut rx, &cancel).await })
        };
        // Wait until the run reports it's waiting on the user.
        while !host.statuses().contains(&RunStatus::Awaiting) {
            tokio::task::yield_now().await;
        }
        tx.send(Inbox { call_id: "id-ask_tool".into(), response: ToolResponse::Approve, config: None }).unwrap();
        let messages = runner.await.unwrap();

        assert_eq!(*host.executed.lock().unwrap(), ["ask_tool"]);
        assert_eq!(ui::parts(&messages[1])[3]["text"], "thanks");
    }

    #[tokio::test]
    async fn respond_resumes_a_saved_thread() {
        let saved = vec![
            json!({ "id": "u", "role": "user", "parts": [{ "type": "text", "text": "hi" }] }),
            json!({ "id": "a", "role": "assistant", "parts": [
                { "type": "dynamic-tool", "toolName": "ask_tool", "toolCallId": "c1", "state": "input-available", "input": {} },
            ]}),
        ];
        let host = FakeHost::new(vec![vec![text("ok")]]);
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let action = RunAction::Respond { call_id: "c1".into(), response: ToolResponse::Error { error_text: "denied".into() } };
        let messages = run(&*host, saved, action, config(), &mut rx, &CancellationToken::new()).await;

        let parts = ui::parts(&messages[1]);
        assert_eq!(parts[0]["state"], "output-error");
        assert_eq!(parts[0]["errorText"], "denied");
        assert_eq!(parts[2]["text"], "ok");
        assert!(host.executed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn respond_to_nothing_does_not_call_the_model() {
        let host = FakeHost::new(vec![]);
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let action = RunAction::Respond { call_id: "gone".into(), response: ToolResponse::Approve };
        let saved = vec![json!({ "id": "u", "role": "user", "parts": [{ "type": "text", "text": "hi" }] })];
        run(&*host, saved, action, config(), &mut rx, &CancellationToken::new()).await;
        assert!(host.requests.lock().unwrap().is_empty());
        assert_eq!(host.statuses(), [RunStatus::Ready]);
    }

    #[tokio::test]
    async fn unknown_tools_get_an_error_result() {
        let host = FakeHost::new(vec![vec![call("nope")], vec![text("sorry")]]);
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let messages = run(&*host, vec![], user("hi"), config(), &mut rx, &CancellationToken::new()).await;
        assert_eq!(ui::parts(&messages[1])[1]["state"], "output-error");
    }

    #[tokio::test]
    async fn cancelling_stops_running_tools() {
        let mut host = FakeHost::new(vec![vec![call("auto_tool")]]);
        Arc::get_mut(&mut host).unwrap().hang_tools = true;
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let runner = {
            let (host, cancel) = (host.clone(), cancel.clone());
            tokio::spawn(async move { run(&*host, vec![], user("hi"), config(), &mut rx, &cancel).await })
        };
        while host.executed.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        cancel.cancel();
        let messages = runner.await.unwrap();
        assert_eq!(ui::parts(&messages[1])[1]["errorText"], STOPPED);
        assert_eq!(host.requests.lock().unwrap().len(), 1, "no step after a stop");
    }

    #[tokio::test]
    async fn provider_errors_end_the_run_with_an_error() {
        let host = FakeHost::new(vec![vec![text("par"), ChatEvent::Error { message: "overloaded".into() }]]);
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let messages = run(&*host, vec![], user("hi"), config(), &mut rx, &CancellationToken::new()).await;
        let last = host.events.lock().unwrap().last().cloned();
        assert_eq!(last, Some(RunEvent::Status { status: RunStatus::Error, error: Some("overloaded".into()) }));
        assert_eq!(ui::parts(&messages[1])[1], json!({ "type": "text", "text": "par", "state": "done" }));
    }

    #[tokio::test]
    async fn edit_and_regenerate_trim_the_thread() {
        let thread = vec![
            json!({ "id": "u1", "role": "user", "parts": [{ "type": "text", "text": "one" }] }),
            json!({ "id": "a1", "role": "assistant", "parts": [{ "type": "text", "text": "1" }] }),
            json!({ "id": "u2", "role": "user", "parts": [{ "type": "text", "text": "two" }] }),
            json!({ "id": "a2", "role": "assistant", "parts": [{ "type": "text", "text": "2" }] }),
        ];
        let (_tx, mut rx) = mpsc::unbounded_channel();

        let host = FakeHost::new(vec![vec![text("again")]]);
        let action = RunAction::Regenerate { message_id: None };
        let messages = run(&*host, thread.clone(), action, config(), &mut rx, &CancellationToken::new()).await;
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[2]["id"], "u2");

        let host = FakeHost::new(vec![vec![text("edited")]]);
        let action = RunAction::Send {
            message: json!({ "role": "user", "parts": [{ "type": "text", "text": "ONE" }] }),
            replace: Some("u1".into()),
        };
        let messages = run(&*host, thread, action, config(), &mut rx, &CancellationToken::new()).await;
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["id"], "u1");
        assert_eq!(messages[0]["parts"][0]["text"], "ONE");
    }
}
