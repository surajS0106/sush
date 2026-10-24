//! One run of the agent loop on a thread: stream a model step, resolve its
//! tool calls, and repeat until the model answers without calling tools.
//!
//! Tool calls marked `Ask` wait for the user (approval cards, `ask_user`);
//! while only those remain the run reports `Awaiting` and keeps waiting on its
//! inbox, so answering continues the same run. If the app restarted in
//! between, a `Respond` action starts a fresh run that picks the calls up from
//! the saved messages.
//!
//! A message the user sends while the run works (`Steer`) joins the thread at
//! the next step boundary: after the current step's tool results, or after
//! its last step instead of ending. `Interrupt` ("Send now") has them join
//! at once: it ends the step or tool calls in progress, and the calls it cuts
//! short get an [`INTERRUPTED`] result. A stopped run marks its reply `paused`;
//! `Resume` carries on from there.
//!
//! Sub-agents (`ToolExec::Agent`) are the exception: a steer doesn't wait for
//! them, and an interrupt doesn't cut them short. The host moves them to the
//! background (`RunHost::detach`), they get a result saying so, and the
//! message joins at once; the host delivers each report later.

use std::collections::{HashMap, VecDeque};

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
    /// Answer a tool call that is waiting for the user. `by`: who answered, in
    /// a shared session (recorded on the reply, see [`ANSWERS`]).
    Respond {
        call_id: String,
        response: ToolResponse,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<Author>,
    },
    /// Add a user message to a live run at its next step boundary (with no
    /// live run, the same as `Send`).
    Steer { message: Value },
    /// Carry on with a reply that was stopped (see [`PAUSED`]).
    Resume,
}

/// Metadata key set on the reply a stop interrupted.
pub const PAUSED: &str = "paused";
/// Metadata key on the user message `Resume` adds when the reply stopped mid-text.
pub const RESUMED: &str = "resumed";
/// Metadata key on a reply: who answered its tool calls in a shared session,
/// by call id (`{ by, decision, at }`). Only answers that carry an author are recorded.
pub const ANSWERS: &str = "sushAnswers";
/// The result of a tool call that `Inbox::Interrupt` cut short.
pub const INTERRUPTED: &str = "Interrupted: the user sent a message.";
const RESUME_PROMPT: &str = "Continue from where you left off.";

/// Someone in a shared session (`crate::share`), as the host knows them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub user_id: String,
    pub name: String,
    /// A `data:` image or a built-in avatar id; never a URL to fetch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
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
    /// A report run's own tools (`crate::reports`): its diff and recording
    /// its results. Only the host adds these.
    Report,
    /// `spawn_agent`: a sub-agent's run on a thread of its own
    /// (`super::subagents`). Only the host adds it.
    Agent,
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

/// Something delivered to a live run. A config replaces the run's, e.g. after
/// "Always allow" changed a tool's approval.
#[derive(Debug, Clone)]
pub enum Inbox {
    /// An answer to a tool call waiting for the user, and who gave it in a shared session.
    Respond { call_id: String, response: ToolResponse, config: Option<RunConfig>, by: Option<Author> },
    /// A user message, added at the next step boundary.
    Steer { message: Value, config: Option<RunConfig> },
    /// Add the steering messages now: end the current step or tool calls
    /// early. Does nothing when none are waiting.
    Interrupt,
    /// The host's approval rules changed (e.g. the user let edits run without
    /// asking): calls waiting for the user that no longer need to, start.
    Recheck,
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
    /// Move a sub-agent's call still running out of the run, which carries on
    /// without it; the host delivers its outcome later. Returns the call's
    /// result for now, or None to keep waiting (e.g. it just finished).
    fn detach(&self, _call: &ToolCall) -> Option<Value> {
        None
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
    let mut r = Runner {
        host,
        messages,
        config,
        cancel: cancel.clone(),
        status: None,
        answers: VecDeque::new(),
        steers: Vec::new(),
        interrupt: false,
        recheck: false,
    };
    let resolve_first = match action {
        RunAction::Send { mut message, replace } => {
            if let Some(i) = replace.as_deref().and_then(|id| r.position(id)) {
                r.messages.truncate(i);
                message["id"] = json!(replace);
            }
            r.push_user(message);
            false
        }
        RunAction::Steer { message } => {
            r.push_user(message);
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
        RunAction::Respond { call_id, response, by } => {
            r.answers.push_back((call_id, response, by));
            true
        }
        RunAction::Resume => r.prepare_resume(),
    };
    // The UI starts each run from exactly what the run sees.
    host.emit(RunEvent::Op(Op::Reset { messages: r.messages.clone() }));

    let outcome = r.drive(inbox, resolve_first).await;
    if cancel.is_cancelled() && r.messages.last().and_then(ui::role) == Some("assistant") {
        r.op(Op::SetMetadata { metadata: json!({ PAUSED: true }) });
    }
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
    /// Answers to calls waiting for the user (and who gave them), for the next `resolve`.
    answers: VecDeque<(String, ToolResponse, Option<Author>)>,
    /// User messages sent while the run worked, for the next step boundary.
    steers: Vec<Value>,
    /// The user asked for `steers` to join now.
    interrupt: bool,
    /// The approval rules changed; waiting calls are looked at again.
    recheck: bool,
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

    fn push_user(&mut self, mut message: Value) {
        if message.get("id").and_then(Value::as_str).is_none() {
            message["id"] = json!(ui::new_id());
        }
        self.messages.push(message);
    }

    /// Set up a `Resume`; returns whether there are calls to resolve first.
    fn prepare_resume(&mut self) -> bool {
        let Some(last) = self.messages.last_mut().filter(|m| ui::role(m) == Some("assistant")) else {
            // Stopped before the reply began: just ask again.
            return false;
        };
        if let Some(metadata) = last.get_mut("metadata").and_then(Value::as_object_mut) {
            metadata.remove(PAUSED);
        }
        // The kind of the last thing the reply got to.
        let kind = ui::parts(last)
            .iter()
            .filter_map(|p| p.get("type").and_then(Value::as_str))
            .rfind(|t| *t != "step-start")
            .map(str::to_owned);
        match kind.as_deref() {
            // Nothing arrived before the stop.
            None => {
                self.messages.pop();
                false
            }
            // Calls waiting for the user ask again; after results, the model just continues.
            Some("dynamic-tool") => !ui::unresolved_calls(&self.messages).is_empty(),
            // Cut off mid-reply. Not every provider continues a partial reply
            // in place, so ask for the rest instead.
            Some(_) => {
                self.push_user(json!({
                    "role": "user",
                    "parts": [{ "type": "text", "text": RESUME_PROMPT }],
                    "metadata": { RESUMED: true },
                }));
                false
            }
        }
    }

    fn receive(&mut self, msg: Inbox) {
        let config = match msg {
            Inbox::Respond { call_id, response, config, by } => {
                self.answers.push_back((call_id, response, by));
                config
            }
            Inbox::Steer { message, config } => {
                self.steers.push(message);
                config
            }
            Inbox::Interrupt => {
                self.interrupt = true;
                None
            }
            Inbox::Recheck => {
                self.recheck = true;
                None
            }
        };
        if let Some(config) = config {
            self.config = config;
        }
    }

    fn drain(&mut self, inbox: &mut mpsc::UnboundedReceiver<Inbox>) {
        while let Ok(msg) = inbox.try_recv() {
            self.receive(msg);
        }
    }

    /// Whether to cut the work in progress short so the steers join now.
    fn take_interrupt(&mut self) -> bool {
        std::mem::take(&mut self.interrupt) && !self.steers.is_empty()
    }

    /// Add the messages the user sent meanwhile. Only between steps: every op
    /// but `Push` targets the last message, which a step may still be writing.
    fn join_steers(&mut self, inbox: &mut mpsc::UnboundedReceiver<Inbox>) {
        self.drain(inbox);
        self.interrupt = false;
        for mut message in std::mem::take(&mut self.steers) {
            if message.get("id").and_then(Value::as_str).is_none() {
                message["id"] = json!(ui::new_id());
            }
            self.op(Op::Push { message });
        }
    }

    async fn drive(&mut self, inbox: &mut mpsc::UnboundedReceiver<Inbox>, mut resolve_first: bool) -> Result<(), String> {
        loop {
            if resolve_first {
                let resolved = self.resolve(inbox).await;
                self.host.save(&self.messages).await;
                match resolved {
                    Resolved::Done => {}
                    Resolved::Nothing | Resolved::Cancelled => return Ok(()),
                }
            }
            self.join_steers(inbox);
            let Some(calls) = self.step(inbox).await? else { return Ok(()) };
            self.host.save(&self.messages).await;
            resolve_first = calls > 0;
            if resolve_first {
                continue;
            }
            // The model is done, unless the user said more meanwhile. The inbox
            // closes before the last look so nothing can arrive unseen after it;
            // the host starts a new run for anything sent later.
            self.drain(inbox);
            if self.steers.is_empty() {
                inbox.close();
                self.drain(inbox);
            }
            if self.steers.is_empty() || self.cancel.is_cancelled() {
                return Ok(());
            }
        }
    }

    /// One model request, streamed into the last assistant message. Returns
    /// how many tool calls it made, or None if it was cancelled. An interrupt
    /// ends it early with what arrived so far, and no calls.
    async fn step(&mut self, inbox: &mut mpsc::UnboundedReceiver<Inbox>) -> Result<Option<usize>, String> {
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
        let mut inbox_open = true;
        loop {
            let next = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => {
                    for op in builder.end() { self.op(op); }
                    return Ok(None);
                }
                msg = inbox.recv(), if inbox_open => {
                    match msg {
                        Some(msg) => self.receive(msg),
                        None => inbox_open = false,
                    }
                    if self.take_interrupt() {
                        // Keep what arrived; calls it began don't run.
                        let (ops, _) = builder.finish();
                        for op in ops { self.op(op); }
                        for (index, call) in ui::unresolved_calls(&self.messages) {
                            self.set_result(index, &call, Err(INTERRUPTED.into()));
                        }
                        return Ok(Some(0));
                    }
                    continue;
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
    async fn resolve(&mut self, inbox: &mut mpsc::UnboundedReceiver<Inbox>) -> Resolved {
        let open = ui::unresolved_calls(&self.messages);
        if open.is_empty() {
            return Resolved::Nothing;
        }
        let host = self.host;
        let mut waiting: HashMap<String, (usize, ToolCall)> = HashMap::new();
        let mut running = FuturesUnordered::new();
        let mut in_flight: HashMap<String, (usize, ToolCall)> = HashMap::new();
        // Cancels the running calls on an interrupt; a stop cancels it too.
        // Sub-agents only stop on a stop: an interrupt moves them to the background.
        let interrupt = self.cancel.child_token();
        let stop = self.cancel.clone();
        let token = |exec: &ToolExec| if *exec == ToolExec::Agent { stop.child_token() } else { interrupt.child_token() };

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
                    let cancel = token(&t.exec);
                    running.push(start(index, call, t.exec, cancel));
                }
                Some(_) => {
                    waiting.insert(call.id.clone(), (index, call));
                }
            }
        }

        let mut inbox_open = true;
        loop {
            // Answers first, so a resume applies its response before anything else.
            while let Some((call_id, response, by)) = self.answers.pop_front() {
                // The first answer wins; a later one finds nothing waiting.
                let Some((index, call)) = waiting.remove(&call_id) else { continue };
                if let Some(by) = by {
                    self.record_answer(&call_id, &response, by);
                }
                match response {
                    ToolResponse::Approve => match self.tool(&call.name).map(|t| t.exec.clone()) {
                        Some(exec) => {
                            in_flight.insert(call.id.clone(), (index, call.clone()));
                            let cancel = token(&exec);
                            running.push(start(index, call, exec, cancel));
                        }
                        None => self.set_result(index, &call, Err(format!("Unknown tool {}.", call.name))),
                    },
                    ToolResponse::Output { output } => self.set_result(index, &call, Ok(output)),
                    ToolResponse::Error { error_text } => self.set_result(index, &call, Err(error_text)),
                }
            }
            if std::mem::take(&mut self.recheck) {
                let allowed: Vec<String> = waiting
                    .iter()
                    .filter(|(_, (_, call))| self.tool(&call.name).is_some_and(|t| host.approval(call, t) == Approval::Auto))
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in allowed {
                    let (index, call) = waiting.remove(&id).expect("listed above");
                    let exec = self.tool(&call.name).expect("checked above").exec.clone();
                    in_flight.insert(call.id.clone(), (index, call.clone()));
                    let cancel = token(&exec);
                    running.push(start(index, call, exec, cancel));
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
            // The user said something while sub-agents work: rather than wait for
            // them all, they carry on in the background and the message can join.
            // A background agent's report waits for the step boundary like any message.
            let from_user = |m: &Value| m.get("metadata").and_then(|meta| meta.get(super::subagents::REPORT)).is_none();
            if self.steers.iter().any(from_user) {
                let agents: Vec<String> = in_flight
                    .iter()
                    .filter(|(_, (_, call))| self.tool(&call.name).is_some_and(|t| t.exec == ToolExec::Agent))
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in agents {
                    let (index, call) = in_flight[&id].clone();
                    if let Some(result) = host.detach(&call) {
                        in_flight.remove(&id);
                        self.host.emit(RunEvent::ToolRunning { call_id: call.id.clone(), running: false });
                        self.set_result(index, &call, Ok(result));
                    }
                }
            }
            // "Send now": the calls still going or waiting give way to the user's message.
            if self.take_interrupt() {
                interrupt.cancel();
                for (_, (index, call)) in in_flight.drain() {
                    self.host.emit(RunEvent::ToolRunning { call_id: call.id.clone(), running: false });
                    self.set_result(index, &call, Err(INTERRUPTED.into()));
                }
                for (_, (index, call)) in waiting.drain() {
                    self.set_result(index, &call, Err(INTERRUPTED.into()));
                }
                return Resolved::Done;
            }
            // Calls moved to the background may still be in `running`; they're dropped here.
            if waiting.is_empty() && in_flight.is_empty() {
                return Resolved::Done;
            }
            if in_flight.is_empty() {
                if !inbox_open {
                    // Nobody can answer any more.
                    return Resolved::Cancelled;
                }
                self.status(RunStatus::Awaiting, None);
            }
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => continue,
                Some((index, call, result)) = running.next(), if !running.is_empty() => {
                    // Moved to the background: it already has its result.
                    if in_flight.remove(&call.id).is_none() {
                        continue;
                    }
                    self.host.emit(RunEvent::ToolRunning { call_id: call.id.clone(), running: false });
                    self.set_result(index, &call, result);
                }
                msg = inbox.recv(), if inbox_open => match msg {
                    Some(msg) => self.receive(msg),
                    // The host dropped the run's sender, or the inbox closed.
                    None => inbox_open = false,
                },
            }
        }
    }

    /// Note on the reply who answered a call, so everyone sees it (`ANSWERS`).
    /// The reply is the last message: answers are taken between steps.
    fn record_answer(&mut self, call_id: &str, response: &ToolResponse, by: Author) {
        let decision = match response {
            ToolResponse::Approve => "approve",
            ToolResponse::Output { .. } => "answer",
            ToolResponse::Error { .. } => "deny",
        };
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        // Metadata merges shallowly, so the whole record goes each time.
        let mut answers = self
            .messages
            .last()
            .and_then(|m| m.get("metadata"))
            .and_then(|m| m.get(ANSWERS))
            .filter(|a| a.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        answers[call_id] = json!({ "by": by, "decision": decision, "at": at });
        self.op(Op::SetMetadata { metadata: json!({ ANSWERS: answers }) });
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
        /// Messages to deliver to the run while the given step (1-based) streams.
        during: Mutex<HashMap<usize, Vec<Inbox>>>,
        tx: Mutex<Option<mpsc::UnboundedSender<Inbox>>>,
        /// Every call runs without asking, as after the user allows them all.
        allow_all: std::sync::atomic::AtomicBool,
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
                during: Mutex::default(),
                tx: Mutex::default(),
                allow_all: Default::default(),
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
            let step = {
                let mut requests = self.requests.lock().unwrap();
                requests.push(request);
                requests.len()
            };
            for msg in self.during.lock().unwrap().remove(&step).unwrap_or_default() {
                self.tx.lock().unwrap().as_ref().unwrap().send(msg).unwrap();
            }
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
        fn approval(&self, _: &ToolCall, tool: &RunTool) -> Approval {
            if self.allow_all.load(std::sync::atomic::Ordering::SeqCst) {
                Approval::Auto
            } else {
                tool.approval
            }
        }
        fn detach(&self, call: &ToolCall) -> Option<Value> {
            (call.name == "agent_tool").then(|| json!("in the background"))
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
                (spec("agent_tool"), ToolExec::Agent, Approval::Auto),
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
        tx.send(Inbox::Respond { call_id: "id-ask_tool".into(), response: ToolResponse::Approve, config: None, by: None }).unwrap();
        let messages = runner.await.unwrap();

        assert_eq!(*host.executed.lock().unwrap(), ["ask_tool"]);
        assert_eq!(ui::parts(&messages[1])[3]["text"], "thanks");
    }

    #[tokio::test]
    async fn a_recheck_starts_calls_the_new_rules_allow() {
        let host = FakeHost::new(vec![vec![call("ask_tool")], vec![text("thanks")]]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let runner = {
            let host = host.clone();
            tokio::spawn(async move { run(&*host, vec![], user("hi"), config(), &mut rx, &cancel).await })
        };
        while !host.statuses().contains(&RunStatus::Awaiting) {
            tokio::task::yield_now().await;
        }
        host.allow_all.store(true, std::sync::atomic::Ordering::SeqCst);
        tx.send(Inbox::Recheck).unwrap();
        // An approval that arrives too late is ignored, not run twice.
        tx.send(Inbox::Respond { call_id: "id-ask_tool".into(), response: ToolResponse::Approve, config: None, by: None }).unwrap();
        let messages = runner.await.unwrap();

        assert_eq!(*host.executed.lock().unwrap(), ["ask_tool"]);
        assert_eq!(ui::parts(&messages[1])[3]["text"], "thanks");
    }

    fn steer(text: &str) -> Inbox {
        Inbox::Steer { message: json!({ "id": text, "role": "user", "parts": [{ "type": "text", "text": text }] }), config: None }
    }

    #[tokio::test]
    async fn a_steer_joins_after_the_tool_results() {
        let host = FakeHost::new(vec![vec![call("ask_tool")], vec![text("ok")]]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let runner = {
            let host = host.clone();
            tokio::spawn(async move { run(&*host, vec![], user("hi"), config(), &mut rx, &CancellationToken::new()).await })
        };
        while !host.statuses().contains(&RunStatus::Awaiting) {
            tokio::task::yield_now().await;
        }
        // Sent while the call waits; it must not land between the call and its result.
        tx.send(steer("also this")).unwrap();
        tx.send(Inbox::Respond { call_id: "id-ask_tool".into(), response: ToolResponse::Approve, config: None, by: None }).unwrap();
        let messages = runner.await.unwrap();

        let roles: Vec<_> = messages.iter().map(|m| ui::role(m).unwrap()).collect();
        assert_eq!(roles, ["user", "assistant", "user", "assistant"]);
        assert_eq!(ui::parts(&messages[1])[1]["state"], "output-available");
        assert_eq!(messages[2]["id"], "also this");
        let second = &host.requests.lock().unwrap()[1];
        assert_eq!(second.messages.last().unwrap().role, crate::Role::User);
    }

    #[tokio::test]
    async fn a_steer_during_the_last_step_keeps_the_run_going() {
        let host = FakeHost::new(vec![vec![text("first")], vec![text("second")]]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        host.during.lock().unwrap().insert(1, vec![steer("wait, and")]);
        *host.tx.lock().unwrap() = Some(tx);
        let messages = run(&*host, vec![], user("hi"), config(), &mut rx, &CancellationToken::new()).await;

        assert_eq!(messages.len(), 4);
        assert_eq!(messages[2]["id"], "wait, and");
        assert_eq!(ui::parts(&messages[3])[1]["text"], "second");
        assert_eq!(host.statuses().last(), Some(&RunStatus::Ready));
        // The run closed its inbox on the way out, so a late message can't be lost.
        assert!(host.tx.lock().unwrap().as_ref().unwrap().send(steer("late")).is_err());
    }

    #[tokio::test]
    async fn an_interrupt_ends_the_step_and_the_steer_joins_at_once() {
        let host = FakeHost::new(vec![vec![text("never seen"), call("auto_tool")], vec![text("second")]]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        host.during.lock().unwrap().insert(1, vec![steer("now"), Inbox::Interrupt]);
        *host.tx.lock().unwrap() = Some(tx);
        let messages = run(&*host, vec![], user("hi"), config(), &mut rx, &CancellationToken::new()).await;

        let roles: Vec<_> = messages.iter().map(|m| ui::role(m).unwrap()).collect();
        assert_eq!(roles, ["user", "assistant", "user", "assistant"]);
        assert_eq!(messages[2]["id"], "now");
        assert_eq!(ui::parts(&messages[3])[1]["text"], "second");
        assert!(host.executed.lock().unwrap().is_empty());
        assert_eq!(host.statuses().last(), Some(&RunStatus::Ready));
    }

    #[tokio::test]
    async fn an_interrupt_cuts_running_tools_short() {
        let mut host = FakeHost::new(vec![vec![call("auto_tool")], vec![text("ok")]]);
        Arc::get_mut(&mut host).unwrap().hang_tools = true;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let runner = {
            let host = host.clone();
            tokio::spawn(async move { run(&*host, vec![], user("hi"), config(), &mut rx, &CancellationToken::new()).await })
        };
        while host.executed.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        tx.send(steer("now")).unwrap();
        tx.send(Inbox::Interrupt).unwrap();
        let messages = runner.await.unwrap();

        assert_eq!(ui::parts(&messages[1])[1]["errorText"], INTERRUPTED);
        assert_eq!(messages[2]["id"], "now");
        assert_eq!(ui::parts(&messages[3])[1]["text"], "ok");
    }

    #[tokio::test]
    async fn a_steer_moves_running_sub_agents_to_the_background() {
        let mut host = FakeHost::new(vec![vec![call("agent_tool")], vec![text("ok")]]);
        Arc::get_mut(&mut host).unwrap().hang_tools = true;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let runner = {
            let host = host.clone();
            tokio::spawn(async move { run(&*host, vec![], user("hi"), config(), &mut rx, &CancellationToken::new()).await })
        };
        while host.executed.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        // Even "Send now" leaves the sub-agent going.
        tx.send(steer("meanwhile")).unwrap();
        tx.send(Inbox::Interrupt).unwrap();
        let messages = runner.await.unwrap();

        assert_eq!(ui::parts(&messages[1])[1]["output"], "in the background");
        assert_eq!(messages[2]["id"], "meanwhile");
        assert_eq!(ui::parts(&messages[3])[1]["text"], "ok");
    }

    #[tokio::test]
    async fn a_report_waits_for_the_sub_agents_still_working() {
        let mut host = FakeHost::new(vec![vec![call("agent_tool")], vec![text("ok")]]);
        Arc::get_mut(&mut host).unwrap().hang_tools = true;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let runner = {
            let host = host.clone();
            tokio::spawn(async move { run(&*host, vec![], user("hi"), config(), &mut rx, &CancellationToken::new()).await })
        };
        while host.executed.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        let report = json!({ "id": "r", "role": "user", "parts": [], "metadata": { super::super::subagents::REPORT: {} } });
        tx.send(Inbox::Steer { message: report, config: None }).unwrap();
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        assert!(!runner.is_finished());
        assert_eq!(host.requests.lock().unwrap().len(), 1, "still waiting on the sub-agent");
        runner.abort();
    }

    #[tokio::test]
    async fn an_interrupt_with_nothing_to_send_is_ignored() {
        let host = FakeHost::new(vec![vec![text("all of it")]]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        host.during.lock().unwrap().insert(1, vec![Inbox::Interrupt]);
        *host.tx.lock().unwrap() = Some(tx);
        let messages = run(&*host, vec![], user("hi"), config(), &mut rx, &CancellationToken::new()).await;
        assert_eq!(messages.len(), 2);
        assert_eq!(ui::parts(&messages[1])[1]["text"], "all of it");
    }

    #[tokio::test]
    async fn a_stopped_reply_is_marked_paused() {
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
        assert_eq!(messages[1]["metadata"][PAUSED], true);
    }

    fn paused(parts: Value) -> Vec<Value> {
        vec![
            json!({ "id": "u", "role": "user", "parts": [{ "type": "text", "text": "hi" }] }),
            json!({ "id": "a", "role": "assistant", "parts": parts, "metadata": { PAUSED: true } }),
        ]
    }

    #[tokio::test]
    async fn resume_after_text_asks_for_the_rest() {
        let host = FakeHost::new(vec![vec![text("rest")]]);
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let saved = paused(json!([{ "type": "step-start" }, { "type": "text", "text": "par", "state": "done" }]));
        let messages = run(&*host, saved, RunAction::Resume, config(), &mut rx, &CancellationToken::new()).await;

        assert_eq!(messages.len(), 4);
        assert!(messages[1]["metadata"].get(PAUSED).is_none());
        assert_eq!(messages[2]["metadata"][RESUMED], true);
        assert_eq!(ui::parts(&messages[3])[1]["text"], "rest");
    }

    #[tokio::test]
    async fn resume_after_tool_results_continues_the_same_reply() {
        let host = FakeHost::new(vec![vec![text("carrying on")]]);
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let saved = paused(json!([
            { "type": "step-start" },
            { "type": "dynamic-tool", "toolName": "auto_tool", "toolCallId": "c1", "state": "output-error", "input": {}, "errorText": STOPPED },
        ]));
        let messages = run(&*host, saved, RunAction::Resume, config(), &mut rx, &CancellationToken::new()).await;

        assert_eq!(messages.len(), 2);
        assert_eq!(ui::parts(&messages[1])[3]["text"], "carrying on");
    }

    #[tokio::test]
    async fn resume_asks_again_for_calls_left_waiting() {
        let host = FakeHost::new(vec![vec![text("thanks")]]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let saved = paused(json!([
            { "type": "step-start" },
            { "type": "dynamic-tool", "toolName": "ask_tool", "toolCallId": "c1", "state": "input-available", "input": {} },
        ]));
        let runner = {
            let host = host.clone();
            tokio::spawn(async move { run(&*host, saved, RunAction::Resume, config(), &mut rx, &CancellationToken::new()).await })
        };
        while !host.statuses().contains(&RunStatus::Awaiting) {
            tokio::task::yield_now().await;
        }
        assert!(host.requests.lock().unwrap().is_empty(), "no step before the answer");
        tx.send(Inbox::Respond { call_id: "c1".into(), response: ToolResponse::Approve, config: None, by: None }).unwrap();
        let messages = runner.await.unwrap();
        assert_eq!(*host.executed.lock().unwrap(), ["ask_tool"]);
        assert_eq!(ui::parts(&messages[1])[3]["text"], "thanks");
    }

    #[tokio::test]
    async fn resume_before_any_reply_asks_again() {
        let host = FakeHost::new(vec![vec![text("hello")]]);
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let saved = paused(json!([{ "type": "step-start" }]));
        let messages = run(&*host, saved, RunAction::Resume, config(), &mut rx, &CancellationToken::new()).await;

        assert_eq!(messages.len(), 2);
        assert_eq!(ui::parts(&messages[1]).len(), 2);
        assert_eq!(ui::parts(&messages[1])[1]["text"], "hello");
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
        let action = RunAction::Respond { call_id: "c1".into(), response: ToolResponse::Error { error_text: "denied".into() }, by: None };
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
        let action = RunAction::Respond { call_id: "gone".into(), response: ToolResponse::Approve, by: None };
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

    fn author(name: &str) -> Author {
        Author { user_id: format!("u-{name}"), name: name.into(), image: None }
    }

    #[tokio::test]
    async fn the_first_answer_wins_and_is_recorded_on_the_reply() {
        let host = FakeHost::new(vec![vec![call("ask_tool")], vec![text("thanks")]]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let runner = {
            let host = host.clone();
            tokio::spawn(async move { run(&*host, vec![], user("hi"), config(), &mut rx, &CancellationToken::new()).await })
        };
        while !host.statuses().contains(&RunStatus::Awaiting) {
            tokio::task::yield_now().await;
        }
        let respond = |response, by| Inbox::Respond { call_id: "id-ask_tool".into(), response, config: None, by: Some(by) };
        tx.send(respond(ToolResponse::Approve, author("Shruti"))).unwrap();
        tx.send(respond(ToolResponse::Error { error_text: "no".into() }, author("Suraj"))).unwrap();
        let messages = runner.await.unwrap();

        assert_eq!(*host.executed.lock().unwrap(), ["ask_tool"]);
        let answer = &messages[1]["metadata"][ANSWERS]["id-ask_tool"];
        assert_eq!(answer["by"]["name"], "Shruti");
        assert_eq!(answer["decision"], "approve");
        assert_eq!(messages[1]["metadata"][ANSWERS].as_object().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn answers_without_an_author_leave_no_record() {
        let saved = vec![
            json!({ "id": "u", "role": "user", "parts": [{ "type": "text", "text": "hi" }] }),
            json!({ "id": "a", "role": "assistant", "parts": [
                { "type": "dynamic-tool", "toolName": "ask_tool", "toolCallId": "c1", "state": "input-available", "input": {} },
                { "type": "dynamic-tool", "toolName": "ask_tool", "toolCallId": "c2", "state": "input-available", "input": {} },
            ], "metadata": { ANSWERS: { "old": { "decision": "deny" } } }}),
        ];
        let host = FakeHost::new(vec![vec![text("ok")]]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let deny = ToolResponse::Error { error_text: "x".into() };
        tx.send(Inbox::Respond { call_id: "c2".into(), response: deny, config: None, by: Some(author("Shruti")) }).unwrap();
        let action = RunAction::Respond { call_id: "c1".into(), response: ToolResponse::Approve, by: None };
        let messages = run(&*host, saved, action, config(), &mut rx, &CancellationToken::new()).await;

        let answers = messages[1]["metadata"][ANSWERS].as_object().unwrap();
        assert!(answers.get("c1").is_none());
        assert_eq!(answers["c2"]["decision"], "deny");
        assert_eq!(answers["c2"]["by"]["name"], "Shruti");
        // Earlier answers stay: the whole record goes with each one.
        assert!(answers.contains_key("old"));
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
