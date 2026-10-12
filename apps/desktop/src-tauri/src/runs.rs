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

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sush_core::agent::ui::{self, ToolCall, STOPPED};
use sush_core::agent::{self, Approval, Inbox, Op, RunAction, RunConfig, RunEvent, RunHost, RunStatus, RunTool, ToolExec};
use sush_core::browser as browser_tools;
use sush_core::provider::EventStream;
use sush_core::store::ThreadMeta;
use sush_core::workspace::sandbox::SandboxStatus;
use sush_core::workspace::{tools as ws_tools, Workspace, WorkspaceFs};
use sush_core::ChatRequest;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::browser::Browser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::blocking;
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
}

struct Live {
    state: Mutex<LiveState>,
    cancel: CancellationToken,
    inbox: mpsc::UnboundedSender<Inbox>,
    /// Becomes true once the run has saved and ended.
    done: watch::Receiver<bool>,
    cowork: Option<Cowork>,
}

/// A Cowork run's folder. The workspace settings refresh when the user
/// answers mid-run (e.g. "Allow all edits"); the folder itself can't change.
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
    /// Send a frame to every window (a page may be reloading; it resubscribes),
    /// except a tool request, which only the leader runs, so it runs once.
    fn send(&self, frame: RunFrame) {
        let channels = self.channels.lock().unwrap();
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
                // Changes are grouped by the turn (the user message) that made them, for undo.
                let turn = {
                    let live = self.live.state.lock().unwrap();
                    let user = live.messages.iter().rev().find(|m| ui::role(m) == Some("user"));
                    user.and_then(|m| m.get("id")).and_then(Value::as_str).unwrap_or_default().to_string()
                };
                let store = state.store.clone();
                let (thread_id, workspace_id) = (self.thread_id.clone(), workspace.id.clone());
                let checkpoint: ws_tools::Checkpoint = Arc::new(move |path: &str, original: Option<Vec<u8>>| {
                    store
                        .add_checkpoint(&thread_id, &turn, &workspace_id, path, original.as_deref())
                        .map_err(|e| format!("Couldn't keep a copy of {path} for undo, so it wasn't changed: {e}"))
                });
                let result =
                    ws_tools::execute(cowork.fs.clone(), &workspace, &call.name, call.input.clone(), cancel, checkpoint, &state.sandbox)
                        .await;
                if ws_tools::changes_files(&call.name) {
                    state.runs.send(RunFrame::FilesChanged { thread_id: self.thread_id.clone(), workspace_id: workspace.id });
                }
                result
            }
            ToolExec::Browser => {
                let browser = self.app.state::<Browser>();
                browser.execute(&self.app, &self.thread_id, &call.name, &call.input, cancel).await
            }
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
/// running there; an answer to a waiting tool call goes to the live run, or
/// resumes the saved thread if there is none.
#[tauri::command]
pub async fn run_start(
    app: AppHandle,
    state: State<'_, AppState>,
    thread: ThreadMeta,
    action: RunAction,
    config: RunConfig,
) -> AppResult<()> {
    let runs = &state.runs;
    let _starting = runs.starting.lock().await;
    let (config, cowork) = prepare(&state, &thread, config).await?;
    let existing = runs.live.lock().unwrap().get(&thread.id).cloned();
    if let Some(live) = existing {
        if let RunAction::Respond { call_id, response } = &action {
            if let (Some(current), Some(fresh)) = (&live.cowork, &cowork) {
                *current.workspace.lock().unwrap() = fresh.workspace.lock().unwrap().clone();
            }
            let answer = Inbox { call_id: call_id.clone(), response: response.clone(), config: Some(config.clone()) };
            if !live.cancel.is_cancelled() && live.inbox.send(answer).is_ok() {
                return Ok(());
            }
        }
        runs.stop(&thread.id).await;
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
    });
    runs.live.lock().unwrap().insert(thread.id.clone(), live.clone());

    let host = Host { app: app.clone(), thread_id: thread.id.clone(), live };
    tauri::async_runtime::spawn(async move {
        let cancel = host.live.cancel.clone();
        agent::run(&host, messages, action, config, &mut inbox_rx, &cancel).await;
        let runs = &host.app.state::<AppState>().runs;
        let mut live = runs.live.lock().unwrap();
        if live.get(&host.thread_id).is_some_and(|l| Arc::ptr_eq(l, &host.live)) {
            live.remove(&host.thread_id);
        }
        drop(live);
        let _ = done_tx.send(true);
    });
    Ok(())
}

/// The config a run gets: the UI's, minus anything posing as a workspace or
/// browser tool, plus the workspace's and the browser's tools and
/// instructions for a Cowork session.
async fn prepare(state: &AppState, thread: &ThreadMeta, mut config: RunConfig) -> AppResult<(RunConfig, Option<Cowork>)> {
    config.tools.retain(|t| {
        !matches!(t.exec, ToolExec::Workspace | ToolExec::Browser)
            && !ws_tools::is_workspace_tool(&t.spec.name)
            && !browser_tools::is_browser_tool(&t.spec.name)
    });
    // Incognito is chat only: Cowork would leave checkpoints of its edits on disk.
    if thread.incognito {
        return Ok((config, None));
    }
    let store = state.store.clone();
    let (id, claimed) = (thread.id.clone(), thread.workspace_id.clone());
    let workspace = blocking(move || {
        // A saved session keeps the workspace it was created with.
        let workspace_id = store.thread_workspace(&id)?.or(claimed);
        Ok(match workspace_id {
            Some(w) => store.workspace(&w)?,
            None => None,
        })
    })
    .await?;
    let Some(workspace) = workspace else { return Ok((config, None)) };
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
    let section = format!("{}

{}", ws_tools::system_section(&workspace, &fs, &sandbox), browser_tools::system_section());
    config.system = Some(match config.system.take() {
        Some(system) => format!("{system}\n\n---\n\n{section}"),
        None => section,
    });
    // Approval is decided per call by `Host::approval`; this is only the fallback.
    config.tools.extend(
        ws_tools::specs(workspace.access).into_iter().map(|spec| RunTool { spec, exec: ToolExec::Workspace, approval: Approval::Ask }),
    );
    config.tools.extend(
        browser_tools::specs().into_iter().map(|spec| RunTool { spec, exec: ToolExec::Browser, approval: Approval::Ask }),
    );
    Ok((config, Some(Cowork { workspace: Mutex::new(workspace), fs: Arc::new(fs), sandbox })))
}

/// Stop a thread's run: the model stream and any tool calls in flight.
#[tauri::command]
pub async fn run_cancel(state: State<'_, AppState>, thread_id: String) -> AppResult<()> {
    state.runs.stop(&thread_id).await;
    Ok(())
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
