//! Session manager: the agent runs in flight, one per thread at most.
//!
//! Each run is a task executing `sush_core::agent::run`. Everything it does is
//! sent to the UI as `RunFrame`s on one channel for all threads, so chats keep
//! streaming whatever the UI shows. A copy of each live thread is kept here so
//! a reloaded page can pick up where it left off (`runs_subscribe`). Each
//! window subscribes and gets every frame, since each keeps its own copy of
//! every thread; tool requests go to one window only (`Runs::leader`).
//!
//! Connector tools run here. Tools the UI owns (memory, skills, artifacts) are
//! requested with a `client-tool` frame and answered with `tool_result`.
//!
//! A Cowork session's run also gets its workspace's file and shell tools.
//! Those are added here, never taken from the UI, and whether each call needs
//! approval is decided here too (`workspace::tools::approval`). Every change
//! is checkpointed first so a turn can be undone (`workspaces.rs`).
//! It gets the built-in browser's tools as well (`browser.rs`).
//!
//! A report's thread (a security review, code review or wiki, `reports.rs`)
//! is held to reading: its folder is read-only whatever the workspace allows,
//! it gets no browser and none of the UI's tools, only `sush_core::reports`'
//! own. Its results reach every window as `report` frames.
//!
//! A session's run can start sub-agents (`spawn_agent`,
//! `sush_core::agent::subagents`): each is a run of its own on a child thread
//! (`ThreadMeta::parent_id`), started here with the parent's config, which the
//! call waits for and whose final message is its result. Stopping the parent
//! stops them. One working in the background (started so, or moved there when
//! the user wrote meanwhile) brings its report back as a message of its own
//! when it's done, which joins the parent's run or starts one. A sub-agent's file changes are checkpointed under the parent's
//! turn, so undoing that turn undoes them too.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sush_core::agent::subagents;
use sush_core::agent::ui::{self, ToolCall, STOPPED};
use sush_core::agent::{self, Approval, Inbox, Op, RunAction, RunConfig, RunEvent, RunHost, RunStatus, RunTool, ToolExec};
use sush_core::browser as browser_tools;
use sush_core::provider::EventStream;
use sush_core::reports::{self, Report, ReportStatus, Role};
use sush_core::store::ThreadMeta;
use sush_core::workspace::sandbox::SandboxStatus;
use sush_core::workspace::{git, tools as ws_tools, Access, Workspace, WorkspaceFs};
use sush_core::ChatRequest;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::browser::Browser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::blocking;
use crate::workspaces::{self, UndoResult};
use crate::{commands, connectors};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum RunFrame {
    Op { thread_id: String, op: Op },
    Status { thread_id: String, status: RunStatus, error: Option<String> },
    ToolRunning { thread_id: String, call_id: String, running: bool },
    /// Run a UI-owned tool and answer with `tool_result`.
    ClientTool { thread_id: String, call_id: String, name: String, input: Value },
    /// The thread was written to disk; its metadata as stored.
    Saved { thread: ThreadMeta },
    /// A Cowork tool changed files (or may have, for shell commands).
    FilesChanged { thread_id: String, workspace_id: String },
    /// A report changed: its run started or ended, or recorded results.
    Report { report: Report },
    /// A share hosted or joined here changed: who's in it, its connection, its end (`share.rs`).
    Share { share: crate::share::ShareView },
    /// A share is gone from this app: ended here, or left.
    ShareGone { thread_id: String },
}

/// A live run's thread, for a share's snapshot.
pub(crate) struct LiveThread {
    pub thread_id: String,
    pub messages: Vec<Value>,
    pub status: RunStatus,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveRun {
    thread_id: String,
    thread: ThreadMeta,
    messages: Vec<Value>,
    status: RunStatus,
    error: Option<String>,
}

#[derive(Default)]
pub struct Runs {
    /// Each window's channel, by label. Lock order: `channels`, then a run's `state`.
    channels: Mutex<BTreeMap<String, Channel<RunFrame>>>,
    live: Mutex<HashMap<String, Arc<Live>>>,
    /// UI-owned tool calls waiting for `tool_result`, with the frame that asked for them.
    client_calls: Mutex<HashMap<String, (RunFrame, oneshot::Sender<Result<Value, String>>)>>,
    /// Starts run one at a time, so two can't race on the same thread.
    starting: tokio::sync::Mutex<()>,
    /// Incognito threads' messages: kept here instead of on disk, until the chat is closed.
    incognito: Mutex<HashMap<String, Vec<Value>>>,
    /// Sub-agents' threads working in the background, whose reports go to their parent as messages.
    /// Lock order: `detached`, then `live`.
    detached: Mutex<HashSet<String>>,
    /// Sessions shared with others or joined (`share.rs`). Every frame passes it, in order.
    pub(crate) shares: crate::share::Shares,
}

struct Live {
    state: Mutex<LiveState>,
    cancel: CancellationToken,
    inbox: mpsc::UnboundedSender<Inbox>,
    /// Becomes true once the run has saved and ended.
    done: watch::Receiver<bool>,
    cowork: Option<Cowork>,
    report: Option<ReportRun>,
    /// The config as the UI (or, for a sub-agent, the parent) sent it, before
    /// `prepare`: what this run's sub-agents start from.
    ui_config: Mutex<RunConfig>,
    /// A sub-agent's run: the parent thread and turn its file changes count under.
    checkpoint_to: Option<(String, String)>,
}

/// The report a thread works for, as it was when the run started (its scope can't change).
struct ReportRun {
    report: Report,
    role: Role,
}

/// A Cowork run's folder. The workspace settings refresh as soon as the user
/// changes them (`Runs::workspace_changed`) and when they answer mid-run; the
/// folder itself can't change.
struct Cowork {
    workspace: Mutex<Workspace>,
    fs: Arc<WorkspaceFs>,
    /// The sandbox as checked when the run started.
    sandbox: SandboxStatus,
}

struct LiveState {
    thread: ThreadMeta,
    messages: Vec<Value>,
    status: RunStatus,
    error: Option<String>,
}

impl Runs {
    /// The user changed a workspace's settings: live runs in it follow at once,
    /// and calls they hold for approval that no longer need it start. A
    /// report's run stays read-only whatever the folder allows.
    pub fn workspace_changed(&self, workspace: &Workspace) {
        for live in self.live.lock().unwrap().values() {
            let Some(cowork) = &live.cowork else { continue };
            {
                let mut current = cowork.workspace.lock().unwrap();
                if current.id != workspace.id {
                    continue;
                }
                current.approval = workspace.approval;
                if live.report.is_none() {
                    current.access = workspace.access;
                }
            }
            if !live.cancel.is_cancelled() {
                let _ = live.inbox.send(Inbox::Recheck);
            }
        }
    }

    /// Send a frame to every window (a page may be reloading; it resubscribes),
    /// except a tool request, which only the leader runs, so it runs once.
    /// A shared thread's frames also go to its guests.
    pub(crate) fn send(&self, frame: RunFrame) {
        let channels = self.channels.lock().unwrap();
        self.shares.on_frame(&frame);
        if matches!(frame, RunFrame::ClientTool { .. }) {
            if let Some(channel) = Self::leader(&channels) {
                let _ = channel.send(frame);
            }
            return;
        }
        for channel in channels.values() {
            let _ = channel.send(frame.clone());
        }
    }

    /// The window that runs UI-owned tools (and automations, see `lib/windows.ts`):
    /// "main" while it's open, as labels sort.
    fn leader(channels: &BTreeMap<String, Channel<RunFrame>>) -> Option<&Channel<RunFrame>> {
        channels.values().next()
    }

    /// Tell the windows which one leads, after one subscribes or goes away.
    fn announce_leader(app: &AppHandle, channels: &BTreeMap<String, Channel<RunFrame>>) {
        if let Some(label) = channels.keys().next() {
            let _ = app.emit("sush://leader", label);
        }
    }

    /// A window is gone. If it led, the next one takes over the tool requests it never answered.
    pub fn unsubscribe(&self, app: &AppHandle, label: &str) {
        let mut channels = self.channels.lock().unwrap();
        let led = channels.keys().next().is_some_and(|l| l == label);
        if channels.remove(label).is_none() {
            return;
        }
        if led {
            if let Some(channel) = Self::leader(&channels) {
                for (frame, _) in self.client_calls.lock().unwrap().values() {
                    let _ = channel.send(frame.clone());
                }
            }
        }
        Self::announce_leader(app, &channels);
    }

    /// Stop a thread's run and wait until it has saved.
    pub async fn stop(&self, thread_id: &str) {
        let live = self.live.lock().unwrap().get(thread_id).cloned();
        if let Some(live) = live {
            live.cancel.cancel();
            let mut done = live.done.clone();
            let _ = done.wait_for(|d| *d).await;
        }
    }

    /// Bring a live run's copy of the metadata the user can change (title, pin, project)
    /// up to date, so the run's next save doesn't put the old values back.
    pub fn update_meta(&self, meta: &ThreadMeta) {
        let live = self.live.lock().unwrap().get(&meta.id).cloned();
        if let Some(live) = live {
            let thread = &mut live.state.lock().unwrap().thread;
            thread.title = meta.title.clone();
            thread.pinned = meta.pinned;
            thread.project_id = meta.project_id.clone();
        }
    }

    /// Drop an incognito thread's messages.
    pub fn forget(&self, thread_id: &str) {
        self.incognito.lock().unwrap().remove(thread_id);
    }

    /// Stop a thread's run and its sub-agents', those in the background too.
    pub async fn stop_with_agents(&self, thread_id: &str) {
        self.stop(thread_id).await;
        let prefix = subagents::child_thread_id(thread_id, "");
        let children: Vec<String> = self.live.lock().unwrap().keys().filter(|id| id.starts_with(&prefix)).cloned().collect();
        for child in children {
            self.detached.lock().unwrap().remove(&child);
            self.stop(&child).await;
        }
    }

    pub fn is_running(&self, thread_id: &str) -> bool {
        self.live.lock().unwrap().contains_key(thread_id)
    }

    /// Tell every window a report changed.
    pub fn report_changed(&self, report: Report) {
        self.send(RunFrame::Report { report });
    }

    /// Call `f` with the live copies of a thread and its sub-agents' threads,
    /// while no run can send a frame: what `f` sees lines up exactly with the
    /// next frame any of them sends (a share's snapshot relies on it).
    pub(crate) fn with_family<R>(&self, thread_id: &str, f: impl FnOnce(Vec<LiveThread>) -> R) -> R {
        let _channels = self.channels.lock().unwrap();
        let prefix = subagents::child_thread_id(thread_id, "");
        let lives: Vec<(String, Arc<Live>)> = self
            .live
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| *id == thread_id || id.starts_with(&prefix))
            .map(|(id, l)| (id.clone(), l.clone()))
            .collect();
        let threads = lives
            .into_iter()
            .map(|(thread_id, l)| {
                let s = l.state.lock().unwrap();
                LiveThread { thread_id, messages: s.messages.clone(), status: s.status, error: s.error.clone() }
            })
            .collect();
        f(threads)
    }
}

struct Host {
    app: AppHandle,
    thread_id: String,
    live: Arc<Live>,
}

#[async_trait]
impl RunHost for Host {
    async fn stream(&self, provider_id: &str, request: ChatRequest) -> Result<EventStream, String> {
        let state = self.app.state::<AppState>();
        let store = state.store.clone();
        // Attachments are stored as blob URLs; providers need the bytes.
        let request = blocking(move || {
            let mut request = request;
            store.resolve_blobs(&mut request)?;
            Ok(request)
        })
        .await
        .map_err(|e| e.to_string())?;
        let provider = commands::provider_for(&state, provider_id).map_err(|e| e.to_string())?;
        provider.stream_chat(request).await.map_err(|e| e.to_string())
    }

    async fn execute(&self, call: &ToolCall, exec: &ToolExec, cancel: CancellationToken) -> Result<Value, String> {
        let state = self.app.state::<AppState>();
        match exec {
            ToolExec::Connector { connector_id, tool } => {
                // Dropping the call on cancel tells the server to stop too (see `McpClient::request`).
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Err(STOPPED.into()),
                    result = connectors::call(&state, connector_id.clone(), tool.clone(), call.input.clone()) => match result {
                        Ok(out) if out.is_error => Err(if out.text.is_empty() { "The tool reported an error.".into() } else { out.text }),
                        Ok(out) => Ok(Value::String(out.text)),
                        Err(e) => Err(e.to_string()),
                    },
                }
            }
            ToolExec::Client => {
                let runs = &state.runs;
                let (reply, answer) = oneshot::channel();
                let frame = RunFrame::ClientTool {
                    thread_id: self.thread_id.clone(),
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    input: call.input.clone(),
                };
                runs.client_calls.lock().unwrap().insert(call.id.clone(), (frame.clone(), reply));
                runs.send(frame);
                let result = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Err(STOPPED.into()),
                    answer = answer => answer.unwrap_or_else(|_| Err("The tool's answer was lost.".into())),
                };
                runs.client_calls.lock().unwrap().remove(&call.id);
                result
            }
            ToolExec::Workspace => {
                let Some(cowork) = &self.live.cowork else {
                    return Err("This session's workspace folder is no longer available.".into());
                };
                let workspace = cowork.workspace.lock().unwrap().clone();
                // Changes are grouped by the turn (the user message) that made them, for undo;
                // a sub-agent's, by its parent's.
                let (owner, turn) = self.live.checkpoint_to.clone().unwrap_or_else(|| (self.thread_id.clone(), self.turn()));
                let store = state.store.clone();
                let (thread_id, workspace_id) = (owner.clone(), workspace.id.clone());
                let checkpoint: ws_tools::Checkpoint = Arc::new(move |path: &str, original: Option<Vec<u8>>| {
                    store
                        .add_checkpoint(&thread_id, &turn, &workspace_id, path, original.as_deref())
                        .map_err(|e| format!("Couldn't keep a copy of {path} for undo, so it wasn't changed: {e}"))
                });
                let result =
                    ws_tools::execute(cowork.fs.clone(), &workspace, &call.name, call.input.clone(), cancel, checkpoint, &state.sandbox)
                        .await;
                if ws_tools::changes_files(&call.name) {
                    state.runs.send(RunFrame::FilesChanged { thread_id: owner, workspace_id: workspace.id });
                }
                result
            }
            ToolExec::Browser => {
                let browser = self.app.state::<Browser>();
                browser.execute(&self.app, &self.thread_id, &call.name, &call.input, cancel).await
            }
            ToolExec::Report => {
                let (Some(run), Some(cowork)) = (&self.live.report, &self.live.cowork) else {
                    return Err("This tool is only for reports.".into());
                };
                let (input, name) = (call.input.clone(), call.name.clone());
                if name == reports::GIT_DIFF {
                    let (root, report) = (cowork.fs.root().to_path_buf(), run.report.clone());
                    return blocking(move || Ok(reports::git_diff(&root, &report, &input)))
                        .await
                        .map_err(|e| e.to_string())?
                        .map(Value::String);
                }
                let (store, id) = (state.store.clone(), run.report.id.clone());
                let (report, said) =
                    blocking(move || Ok(store.update_report(&id, |r| reports::apply_tool(r, &name, &input, now_ms()))?))
                        .await
                        .map_err(|e| e.to_string())?;
                state.runs.report_changed(report);
                Ok(Value::String(said))
            }
            ToolExec::Agent => self.spawn_agent(call, cancel).await,
        }
    }

    fn approval(&self, call: &ToolCall, tool: &RunTool) -> Approval {
        match (&tool.exec, &self.live.cowork) {
            (ToolExec::Workspace, Some(cowork)) => {
                ws_tools::approval(&cowork.workspace.lock().unwrap(), &call.name, &call.input, Some(&cowork.sandbox))
            }
            (ToolExec::Browser, _) => {
                let allowed = self.app.state::<Browser>().allowed_sites(&self.thread_id);
                browser_tools::approval(&call.name, &call.input, &allowed)
            }
            _ => tool.approval,
        }
    }

    fn detach(&self, call: &ToolCall) -> Option<Value> {
        if !subagents::is_agent_tool(&call.name) {
            return None;
        }
        let runs = &self.app.state::<AppState>().runs;
        let child_id = subagents::child_thread_id(&self.thread_id, &call.id);
        let mut detached = runs.detached.lock().unwrap();
        // One that has just finished hands its report back as the call's result, as usual.
        if !runs.live.lock().unwrap().contains_key(&child_id) {
            return None;
        }
        detached.insert(child_id);
        Some(Value::String(subagents::background_result()))
    }

    fn emit(&self, event: RunEvent) {
        let state = self.app.state::<AppState>();
        let channels = state.runs.channels.lock().unwrap();
        let frame = {
            let mut live = self.live.state.lock().unwrap();
            let thread_id = self.thread_id.clone();
            match event {
                RunEvent::Op(op) => {
                    ui::apply(&mut live.messages, &op);
                    RunFrame::Op { thread_id, op }
                }
                RunEvent::Status { status, error } => {
                    live.status = status;
                    live.error = error.clone();
                    RunFrame::Status { thread_id, status, error }
                }
                RunEvent::ToolRunning { call_id, running } => RunFrame::ToolRunning { thread_id, call_id, running },
            }
        };
        state.runs.shares.on_frame(&frame);
        for channel in channels.values() {
            let _ = channel.send(frame.clone());
        }
    }

    async fn save(&self, messages: &[Value]) {
        let thread = {
            let mut live = self.live.state.lock().unwrap();
            if live.thread.title == "New chat" {
                if let Some(title) = ui::title_from(messages) {
                    live.thread.title = title;
                }
            }
            live.thread.updated_at = now_ms();
            live.thread.clone()
        };
        let runs = &self.app.state::<AppState>().runs;
        if thread.incognito {
            runs.incognito.lock().unwrap().insert(thread.id.clone(), messages.to_vec());
            runs.send(RunFrame::Saved { thread });
            return;
        }
        let store = self.app.state::<AppState>().store.clone();
        let (meta, messages) = (thread.clone(), messages.to_vec());
        match blocking(move || Ok(store.save_thread(&meta, Some(messages))?)).await {
            Ok(()) => runs.send(RunFrame::Saved { thread }),
            Err(e) => eprintln!("sush: could not save thread {}: {e}", self.thread_id),
        }
    }
}

impl Host {
    /// The id of the user message the run is answering.
    fn turn(&self) -> String {
        let live = self.live.state.lock().unwrap();
        let user = live.messages.iter().rev().find(|m| ui::role(m) == Some("user"));
        user.and_then(|m| m.get("id")).and_then(Value::as_str).unwrap_or_default().to_string()
    }

    /// Run a `spawn_agent` call: start the sub-agent's run on its own thread
    /// and wait for its report. Cancelling the call stops the sub-agent.
    async fn spawn_agent(&self, call: &ToolCall, cancel: CancellationToken) -> Result<Value, String> {
        let task = subagents::parse(&call.input)?;
        let (parent, config) = {
            let s = self.live.state.lock().unwrap();
            (s.thread.clone(), self.live.ui_config.lock().unwrap().clone())
        };
        if parent.parent_id.is_some() || parent.incognito {
            return Err("Sub-agents aren't available here.".into());
        }
        let workspace_id = self.live.cowork.as_ref().map(|c| c.workspace.lock().unwrap().id.clone());
        let child = start_agent(&self.app, &self.thread_id, workspace_id, &call.id, &task, config, self.turn()).await?;
        if task.background {
            return Ok(Value::String(subagents::background_result()));
        }
        let child_id = subagents::child_thread_id(&self.thread_id, &call.id);

        let mut done = child.done.clone();
        let finished = async move {
            let _ = done.wait_for(|d| *d).await;
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                self.app.state::<AppState>().runs.stop(&child_id).await;
                return Err(STOPPED.into());
            }
            _ = finished => {}
        }
        let s = child.state.lock().unwrap();
        let report = subagents::final_text(&s.messages);
        if child.cancel.is_cancelled() {
            let so_far = report.map(|r| format!(" What it said before it stopped:\n\n{r}")).unwrap_or_default();
            return Err(format!("The user stopped this sub-agent before it finished.{so_far}"));
        }
        match s.status {
            RunStatus::Error => Err(format!("The sub-agent failed: {}", s.error.as_deref().unwrap_or("unknown error"))),
            _ => Ok(Value::String(report.unwrap_or_else(|| subagents::NO_REPORT.into()))),
        }
    }
}

/// Start a sub-agent's run for the parent's call `call_id`, its file changes
/// counted under the parent's `turn`. One in the background reports back when it's done.
async fn start_agent(
    app: &AppHandle,
    parent_id: &str,
    workspace_id: Option<String>,
    call_id: &str,
    task: &subagents::Task,
    config: RunConfig,
    turn: String,
) -> Result<Arc<Live>, String> {
    let now = now_ms();
    let child_id = subagents::child_thread_id(parent_id, call_id);
    let thread = ThreadMeta {
        id: child_id.clone(),
        title: task.description.clone(),
        created_at: now,
        updated_at: now,
        target: None,
        pinned: false,
        workspace_id,
        project_id: None,
        incognito: false,
        parent_id: Some(parent_id.to_string()),
    };
    let action = RunAction::Send { message: subagents::user_message(&task.prompt), replace: None };
    let state = app.state::<AppState>();
    // Marked before it starts, so even a run that ends at once reports back.
    if task.background {
        state.runs.detached.lock().unwrap().insert(child_id.clone());
    }
    let started = start(app, thread, action, config.clone(), Some((parent_id.to_string(), turn))).await;
    let child = match started {
        Ok(Some(child)) => child,
        failed => {
            state.runs.detached.lock().unwrap().remove(&child_id);
            return Err(match failed {
                Err(e) => format!("Couldn't start the sub-agent: {e}"),
                _ => "Couldn't start the sub-agent.".into(),
            });
        }
    };
    report_when_done(app.clone(), parent_id.to_string(), child.clone(), child_id, call_id.to_string(), task.description.clone(), config);
    Ok(child)
}

/// Start a sub-agent from a session's agent graph ("Add an agent"). It works
/// in the background and its report reaches the session as a message.
#[tauri::command]
pub async fn agent_spawn(
    app: AppHandle,
    parent: ThreadMeta,
    config: RunConfig,
    call_id: String,
    turn_id: String,
    prompt: String,
) -> AppResult<()> {
    if parent.parent_id.is_some() || parent.incognito {
        return Err(AppError::Invalid("Sub-agents can't be started here.".into()));
    }
    let mut task = subagents::parse(&json!({ "prompt": prompt })).map_err(AppError::Invalid)?;
    task.background = true;
    let store = app.state::<AppState>().store.clone();
    let id = parent.id.clone();
    let workspace_id = blocking(move || Ok(store.thread_workspace(&id)?)).await?.or(parent.workspace_id.clone());
    start_agent(&app, &parent.id, workspace_id, &call_id, &task, config, turn_id).await.map_err(AppError::Invalid)?;
    Ok(())
}

/// Once a sub-agent's run ends, if it was working in the background, send its
/// report to the parent: into the live run, or starting one. Nothing is sent
/// for a sub-agent the user stopped.
fn report_when_done(app: AppHandle, parent_id: String, child: Arc<Live>, child_id: String, call_id: String, description: String, config: RunConfig) {
    tauri::async_runtime::spawn(async move {
        let mut done = child.done.clone();
        let _ = done.wait_for(|d| *d).await;
        let state = app.state::<AppState>();
        let was_detached = state.runs.detached.lock().unwrap().remove(&child_id);
        if !was_detached || child.cancel.is_cancelled() {
            return;
        }
        let message = {
            let s = child.state.lock().unwrap();
            let outcome = match s.status {
                RunStatus::Error => Err(s.error.clone().unwrap_or_else(|| "unknown error".into())),
                _ => Ok(subagents::final_text(&s.messages)),
            };
            subagents::report_message(&call_id, &description, outcome)
        };
        // The parent as it is now: the user may have renamed it, or changed its tools.
        let live = state.runs.live.lock().unwrap().get(&parent_id).cloned();
        let current = live.map(|l| (l.state.lock().unwrap().thread.clone(), l.ui_config.lock().unwrap().clone()));
        let (thread, config) = match current {
            Some((thread, config)) => (Some(thread), config),
            None => {
                let (store, id) = (state.store.clone(), parent_id.clone());
                (blocking(move || Ok(store.thread_meta(&id)?)).await.ok().flatten(), config)
            }
        };
        let Some(thread) = thread else { return };
        if let Err(e) = start(&app, thread, RunAction::Steer { message }, config, None).await {
            eprintln!("sush: couldn't deliver a sub-agent's report to {parent_id}: {e}");
        }
    });
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Receive every run's frames on `on_frame` (replacing the window's earlier
/// subscription) and return the runs in flight, so a reloaded page catches up.
#[tauri::command]
pub fn runs_subscribe(app: AppHandle, window: Window, state: State<'_, AppState>, on_frame: Channel<RunFrame>) -> Vec<LiveRun> {
    let runs = &state.runs;
    let mut channels = runs.channels.lock().unwrap();
    let live: Vec<_> = runs.live.lock().unwrap().iter().map(|(id, l)| (id.clone(), l.clone())).collect();
    let snapshot = live
        .into_iter()
        .map(|(thread_id, l)| {
            let s = l.state.lock().unwrap();
            LiveRun { thread_id, thread: s.thread.clone(), messages: s.messages.clone(), status: s.status, error: s.error.clone() }
        })
        .collect();
    channels.insert(window.label().to_string(), on_frame);
    // Tool requests the previous page never answered, if this window is the one to answer them.
    if channels.keys().next().is_some_and(|l| l == window.label()) {
        if let Some(channel) = Runs::leader(&channels) {
            for (frame, _) in runs.client_calls.lock().unwrap().values() {
                let _ = channel.send(frame.clone());
            }
        }
    }
    Runs::announce_leader(&app, &channels);
    snapshot
}

/// Start a run on a thread. A new message or regenerate replaces whatever is
/// running there; an answer to a waiting tool call or a steering message goes
/// to the live run, or starts from the saved thread if there is none.
#[tauri::command]
pub async fn run_start(app: AppHandle, thread: ThreadMeta, action: RunAction, config: RunConfig) -> AppResult<()> {
    start(&app, thread, action, config, None).await.map(|_| ())
}

/// `run_start`, also for a sub-agent's run (`checkpoint_to`: its parent's
/// thread and turn). Returns the new run, or None if a live run took the action.
async fn start(
    app: &AppHandle,
    thread: ThreadMeta,
    action: RunAction,
    config: RunConfig,
    checkpoint_to: Option<(String, String)>,
) -> AppResult<Option<Arc<Live>>> {
    let state = app.state::<AppState>();
    let runs = &state.runs;
    let mut starting = runs.starting.lock().await;
    let ui_config = config.clone();
    let (config, cowork, report) = prepare(&state, &thread, config).await?;
    loop {
        let existing = runs.live.lock().unwrap().get(&thread.id).cloned();
        let Some(live) = existing else { break };
        match &action {
            RunAction::Respond { call_id, response } => {
                if let (Some(current), Some(fresh)) = (&live.cowork, &cowork) {
                    *current.workspace.lock().unwrap() = fresh.workspace.lock().unwrap().clone();
                }
                let answer = Inbox::Respond { call_id: call_id.clone(), response: response.clone(), config: Some(config.clone()) };
                if !live.cancel.is_cancelled() && live.inbox.send(answer).is_ok() {
                    *live.ui_config.lock().unwrap() = ui_config;
                    return Ok(None);
                }
            }
            RunAction::Steer { message } if !live.cancel.is_cancelled() => {
                let steer = Inbox::Steer { message: message.clone(), config: Some(config.clone()) };
                if live.inbox.send(steer).is_ok() {
                    *live.ui_config.lock().unwrap() = ui_config;
                    return Ok(None);
                }
                // The run is finishing and takes no more messages. Let it end
                // (it may need other starts to answer it, so don't hold them
                // up), then look again: this message starts the next run.
                drop(starting);
                let mut done = live.done.clone();
                let _ = done.wait_for(|d| *d).await;
                starting = runs.starting.lock().await;
                continue;
            }
            _ => {}
        }
        runs.stop(&thread.id).await;
        break;
    }

    let messages = if thread.incognito {
        runs.incognito.lock().unwrap().get(&thread.id).cloned().unwrap_or_default()
    } else {
        let store = state.store.clone();
        let id = thread.id.clone();
        blocking(move || Ok(store.messages(&id)?)).await?
    };

    let mut thread = thread;
    thread.target = Some(json!({ "providerId": config.provider_id, "model": config.model }));
    let (inbox, mut inbox_rx) = mpsc::unbounded_channel();
    let (done_tx, done) = watch::channel(false);
    let live = Arc::new(Live {
        state: Mutex::new(LiveState { thread: thread.clone(), messages: messages.clone(), status: RunStatus::Submitted, error: None }),
        cancel: CancellationToken::new(),
        inbox,
        done,
        cowork,
        report,
        ui_config: Mutex::new(ui_config),
        checkpoint_to,
    });
    runs.live.lock().unwrap().insert(thread.id.clone(), live.clone());

    let report = live.report.as_ref().filter(|r| r.role == Role::Run).map(|r| r.report.id.clone());
    if let Some(id) = &report {
        set_report_status(&state, id, &thread.id, ReportStatus::Running, None).await;
    }

    let host = Host { app: app.clone(), thread_id: thread.id.clone(), live: live.clone() };
    tauri::async_runtime::spawn(async move {
        let cancel = host.live.cancel.clone();
        agent::run(&host, messages, action, config, &mut inbox_rx, &cancel).await;
        if let Some(id) = &report {
            let (status, error) = {
                let s = host.live.state.lock().unwrap();
                match (cancel.is_cancelled(), s.status) {
                    (true, _) => (ReportStatus::Stopped, None),
                    (false, RunStatus::Error) => (ReportStatus::Failed, s.error.clone()),
                    _ => (ReportStatus::Done, None),
                }
            };
            set_report_status(&host.app.state::<AppState>(), id, &host.thread_id, status, error).await;
        }
        let runs = &host.app.state::<AppState>().runs;
        let mut live = runs.live.lock().unwrap();
        if live.get(&host.thread_id).is_some_and(|l| Arc::ptr_eq(l, &host.live)) {
            live.remove(&host.thread_id);
        }
        drop(live);
        let _ = done_tx.send(true);
    });
    Ok(Some(live))
}

/// The config a run gets: the UI's, minus anything posing as a workspace,
/// browser, report or sub-agent tool, plus the workspace's and the browser's
/// tools and instructions for a Cowork session, and `spawn_agent` (or, on a
/// sub-agent's thread, its instructions). A report's thread gets its own (`report_config`).
async fn prepare(state: &AppState, thread: &ThreadMeta, mut config: RunConfig) -> AppResult<(RunConfig, Option<Cowork>, Option<ReportRun>)> {
    config.tools.retain(|t| {
        !matches!(t.exec, ToolExec::Workspace | ToolExec::Browser | ToolExec::Report | ToolExec::Agent)
            && !ws_tools::is_workspace_tool(&t.spec.name)
            && !browser_tools::is_browser_tool(&t.spec.name)
            && !reports::is_report_tool(&t.spec.name)
            && !subagents::is_agent_tool(&t.spec.name)
    });
    // Incognito is chat only: Cowork would leave checkpoints of its edits on disk.
    if thread.incognito {
        return Ok((config, None, None));
    }
    let store = state.store.clone();
    let (id, claimed) = (thread.id.clone(), thread.workspace_id.clone());
    let (workspace, report) = blocking(move || {
        // A saved session keeps the workspace it was created with.
        let workspace_id = store.thread_workspace(&id)?.or(claimed);
        let workspace = match workspace_id {
            Some(w) => store.workspace(&w)?,
            None => None,
        };
        Ok((workspace, store.report_for_thread(&id)?))
    })
    .await?;
    if let Some(report) = report {
        let workspace = workspace.ok_or_else(|| AppError::Invalid("This report's folder was removed, so it can't run.".into()))?;
        let role = report.role_of(&thread.id).unwrap_or(Role::Ask);
        let (config, cowork) = report_config(config, &report, role, workspace)?;
        return Ok((config, Some(cowork), Some(ReportRun { report, role })));
    }
    let Some(workspace) = workspace else {
        add_subagents(&mut config, thread);
        return Ok((config, None, None));
    };
    let fs = WorkspaceFs::open(Path::new(&workspace.root)).map_err(AppError::Invalid)?;
    let mut sandbox = state.sandbox.status().await;
    if sandbox.available {
        // On Windows this grants the folder to the sandbox (once; it can take a while).
        if let Err(e) = state.sandbox.prepare(Path::new(&workspace.root)).await {
            sandbox.available = false;
            sandbox.network_blocked = false;
            sandbox.detail = format!("The sandbox couldn't be set up for this folder, so every command asks first: {e}");
        }
    }
    let root = workspace.root.clone();
    let git = blocking(move || Ok(git::info(Path::new(&root)))).await?;
    let section = format!("{}

{}", ws_tools::system_section(&workspace, &fs, &sandbox, git.as_ref()), browser_tools::system_section());
    config.system = Some(match config.system.take() {
        Some(system) => format!("{system}\n\n---\n\n{section}"),
        None => section,
    });
    // Approval is decided per call by `Host::approval`; this is only the fallback.
    config.tools.extend(
        ws_tools::specs(workspace.access, git.is_some()).into_iter().map(|spec| RunTool { spec, exec: ToolExec::Workspace, approval: Approval::Ask }),
    );
    config.tools.extend(
        browser_tools::specs().into_iter().map(|spec| RunTool { spec, exec: ToolExec::Browser, approval: Approval::Ask }),
    );
    add_subagents(&mut config, thread);
    Ok((config, Some(Cowork { workspace: Mutex::new(workspace), fs: Arc::new(fs), sandbox }), None))
}

/// A session's run can start sub-agents; a sub-agent's gets their instructions instead.
fn add_subagents(config: &mut RunConfig, thread: &ThreadMeta) {
    if thread.parent_id.is_some() {
        let section = subagents::system_section();
        config.system = Some(match config.system.take() {
            Some(system) => format!("{system}\n\n---\n\n{section}"),
            None => section.to_string(),
        });
    } else {
        config.tools.push(RunTool { spec: subagents::spec(), exec: ToolExec::Agent, approval: Approval::Auto });
    }
}

/// A report thread's config: the folder read-only whatever the workspace
/// allows, the report's own tools and instructions in place of the UI's, and
/// of the UI's tools only connector ones, for a pull request's run.
fn report_config(mut config: RunConfig, report: &Report, role: Role, mut workspace: Workspace) -> AppResult<(RunConfig, Cowork)> {
    workspace.access = Access::ReadOnly;
    let pull_request = role == Role::Run && matches!(report.scope, reports::Scope::PullRequest { .. });
    config.tools.retain(|t| pull_request && matches!(t.exec, ToolExec::Connector { .. }));
    config.research = false;
    let fs = WorkspaceFs::open(Path::new(&workspace.root)).map_err(AppError::Invalid)?;
    // No commands run, so the sandbox doesn't come into it.
    let sandbox = SandboxStatus { mechanism: String::new(), available: false, network_blocked: false, detail: String::new() };
    config.system = Some(format!(
        "{}\n\n---\n\n{}",
        reports::system_prompt(report, role, &workspace.name),
        ws_tools::system_section(&workspace, &fs, &sandbox, None)
    ));
    config.tools.extend(
        ws_tools::specs(Access::ReadOnly, false).into_iter().map(|spec| RunTool { spec, exec: ToolExec::Workspace, approval: Approval::Ask }),
    );
    config.tools.extend(
        reports::specs(report, role).into_iter().map(|spec| RunTool { spec, exec: ToolExec::Report, approval: Approval::Auto }),
    );
    Ok((config, Cowork { workspace: Mutex::new(workspace), fs: Arc::new(fs), sandbox }))
}

/// Set a report's run status, if `thread_id` still runs it (a wiki's regeneration moves it to a new thread).
async fn set_report_status(state: &AppState, id: &str, thread_id: &str, status: ReportStatus, error: Option<String>) {
    let (store, id, thread_id) = (state.store.clone(), id.to_string(), thread_id.to_string());
    let updated = blocking(move || {
        Ok(store.update_report(&id, |r| {
            if r.thread_id != thread_id {
                return Err("Another run took over.".to_string());
            }
            match status {
                ReportStatus::Running => {
                    r.status = status;
                    r.error = None;
                }
                _ => r.finish(status, error, now_ms()),
            }
            Ok(())
        })?)
    })
    .await;
    if let Ok((report, ())) = updated {
        state.runs.report_changed(report);
    }
}

/// Stop a thread's run: the model stream and any tool calls in flight.
#[tauri::command]
pub async fn run_cancel(state: State<'_, AppState>, thread_id: String) -> AppResult<()> {
    state.runs.stop_with_agents(&thread_id).await;
    Ok(())
}

/// Restore a checkpoint: take a session back to just before `message_id`, one
/// of its user messages. Its run stops, every file changed from that turn on is
/// put back as it was (as Undo does, sub-agents' changes included), and that
/// message and everything after it are dropped. Every window gets the shorter
/// thread as a `reset`.
#[tauri::command]
pub async fn thread_rewind(state: State<'_, AppState>, thread: ThreadMeta, message_id: String) -> AppResult<UndoResult> {
    let runs = &state.runs;
    // No run may start (or still be going) while the thread and its files change.
    let _starting = loop {
        let starting = runs.starting.lock().await;
        if !runs.is_running(&thread.id) {
            break starting;
        }
        drop(starting);
        runs.stop_with_agents(&thread.id).await;
    };
    let mut thread = thread;
    thread.updated_at = now_ms();
    let messages = if thread.incognito {
        runs.incognito.lock().unwrap().get(&thread.id).cloned().unwrap_or_default()
    } else {
        let store = state.store.clone();
        let id = thread.id.clone();
        blocking(move || Ok(store.messages(&id)?)).await?
    };
    let id_of = |m: &Value| m.get("id").and_then(Value::as_str).map(str::to_owned);
    let at = messages
        .iter()
        .position(|m| ui::role(m) == Some("user") && id_of(m).as_deref() == Some(message_id.as_str()))
        .ok_or_else(|| AppError::NotFound("That message is no longer in this session.".into()))?;
    let kept = messages[..at].to_vec();

    let (result, workspace_id) = if thread.incognito {
        // Incognito sessions have no workspace, so no files to put back.
        runs.incognito.lock().unwrap().insert(thread.id.clone(), kept.clone());
        (UndoResult::default(), None)
    } else {
        // Turns are keyed by the user message that started them; the earliest
        // dropped one that changed files is where the files go back to.
        let dropped: HashSet<String> = messages[at..].iter().filter(|m| ui::role(m) == Some("user")).filter_map(id_of).collect();
        let store = state.store.clone();
        let (meta, kept) = (thread.clone(), kept.clone());
        blocking(move || {
            let first = store.turn_changes(&meta.id)?.into_iter().find(|t| dropped.contains(&t.turn_id));
            let result = match first {
                Some(turn) => workspaces::restore_since(&store, &meta.id, &turn.turn_id, None)?,
                None => UndoResult::default(),
            };
            store.save_thread(&meta, Some(kept))?;
            Ok((result, store.thread_workspace(&meta.id)?.or(meta.workspace_id.clone())))
        })
        .await?
    };

    runs.send(RunFrame::Op { thread_id: thread.id.clone(), op: Op::Reset { messages: kept } });
    runs.send(RunFrame::Saved { thread: thread.clone() });
    if let Some(workspace_id) = workspace_id.filter(|_| !result.restored.is_empty() || !result.failed.is_empty()) {
        runs.send(RunFrame::FilesChanged { thread_id: thread.id, workspace_id });
    }
    Ok(result)
}

/// "Send now": the messages steering a thread's run join it at once, ending
/// its current step or tool calls early. Nothing happens if no run takes them.
#[tauri::command]
pub fn run_interrupt(state: State<'_, AppState>, thread_id: String) {
    let live = state.runs.live.lock().unwrap().get(&thread_id).cloned();
    if let Some(live) = live.filter(|l| !l.cancel.is_cancelled()) {
        let _ = live.inbox.send(Inbox::Interrupt);
    }
}

/// The UI's answer to a `client-tool` frame.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientToolResult {
    #[serde(default)]
    output: Option<Value>,
    #[serde(default)]
    error_text: Option<String>,
}

#[tauri::command]
pub fn tool_result(state: State<'_, AppState>, call_id: String, result: ClientToolResult) -> AppResult<()> {
    let pending = state.runs.client_calls.lock().unwrap().remove(&call_id);
    let Some((_, reply)) = pending else {
        // Stopped meanwhile, or answered twice.
        return Ok(());
    };
    let result = match (result.error_text, result.output) {
        (Some(error), _) => Err(error),
        (None, Some(output)) => Ok(output),
        (None, None) => return Err(AppError::Invalid("A tool result needs output or errorText.".into())),
    };
    let _ = reply.send(result);
    Ok(())
}
