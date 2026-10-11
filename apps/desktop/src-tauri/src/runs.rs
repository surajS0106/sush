//! Session manager: the agent runs in flight, one per thread at most.
//!
//! Each run is a task executing `sush_core::agent::run`. Everything it does is
//! sent to the UI as `RunFrame`s on one channel for all threads, so chats keep
//! streaming whatever the UI shows. A copy of each live thread is kept here so
//! a reloaded page can pick up where it left off (`runs_subscribe`).
//!
//! Connector tools run here. Tools the UI owns (memory, skills, artifacts) are
//! requested with a `client-tool` frame and answered with `tool_result`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sush_core::agent::ui::{self, ToolCall, STOPPED};
use sush_core::agent::{self, Inbox, Op, RunAction, RunConfig, RunEvent, RunHost, RunStatus, ToolExec};
use sush_core::provider::EventStream;
use sush_core::store::ThreadMeta;
use sush_core::ChatRequest;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

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
    /// Lock order: `channel`, then a run's `state`.
    channel: Mutex<Option<Channel<RunFrame>>>,
    live: Mutex<HashMap<String, Arc<Live>>>,
    /// UI-owned tool calls waiting for `tool_result`, with the frame that asked for them.
    client_calls: Mutex<HashMap<String, (RunFrame, oneshot::Sender<Result<Value, String>>)>>,
    /// Starts run one at a time, so two can't race on the same thread.
    starting: tokio::sync::Mutex<()>,
}

struct Live {
    state: Mutex<LiveState>,
    cancel: CancellationToken,
    inbox: mpsc::UnboundedSender<Inbox>,
    /// Becomes true once the run has saved and ended.
    done: watch::Receiver<bool>,
}

struct LiveState {
    thread: ThreadMeta,
    messages: Vec<Value>,
    status: RunStatus,
    error: Option<String>,
}

impl Runs {
    fn send(&self, frame: RunFrame) {
        if let Some(channel) = self.channel.lock().unwrap().as_ref() {
            let _ = channel.send(frame); // the page may be reloading; it resubscribes
        }
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
        }
    }

    fn emit(&self, event: RunEvent) {
        let state = self.app.state::<AppState>();
        let channel = state.runs.channel.lock().unwrap();
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
        if let Some(channel) = channel.as_ref() {
            let _ = channel.send(frame);
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
        let store = self.app.state::<AppState>().store.clone();
        let (meta, messages) = (thread.clone(), messages.to_vec());
        match blocking(move || Ok(store.save_thread(&meta, Some(messages))?)).await {
            Ok(()) => self.app.state::<AppState>().runs.send(RunFrame::Saved { thread }),
            Err(e) => eprintln!("sush: could not save thread {}: {e}", self.thread_id),
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Receive every run's frames on `on_frame` (replacing any earlier
/// subscriber) and return the runs in flight, so a reloaded page catches up.
#[tauri::command]
pub fn runs_subscribe(state: State<'_, AppState>, on_frame: Channel<RunFrame>) -> Vec<LiveRun> {
    let runs = &state.runs;
    let mut channel = runs.channel.lock().unwrap();
    let live: Vec<_> = runs.live.lock().unwrap().iter().map(|(id, l)| (id.clone(), l.clone())).collect();
    let snapshot = live
        .into_iter()
        .map(|(thread_id, l)| {
            let s = l.state.lock().unwrap();
            LiveRun { thread_id, thread: s.thread.clone(), messages: s.messages.clone(), status: s.status, error: s.error.clone() }
        })
        .collect();
    // Tool requests the previous page never answered.
    for (frame, _) in runs.client_calls.lock().unwrap().values() {
        let _ = on_frame.send(frame.clone());
    }
    *channel = Some(on_frame);
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
    let existing = runs.live.lock().unwrap().get(&thread.id).cloned();
    if let Some(live) = existing {
        if let RunAction::Respond { call_id, response } = &action {
            let answer = Inbox { call_id: call_id.clone(), response: response.clone(), config: Some(config.clone()) };
            if !live.cancel.is_cancelled() && live.inbox.send(answer).is_ok() {
                return Ok(());
            }
        }
        runs.stop(&thread.id).await;
    }

    let store = state.store.clone();
    let id = thread.id.clone();
    let messages = blocking(move || Ok(store.messages(&id)?)).await?;

    let mut thread = thread;
    thread.target = Some(json!({ "providerId": config.provider_id, "model": config.model }));
    let (inbox, mut inbox_rx) = mpsc::unbounded_channel();
    let (done_tx, done) = watch::channel(false);
    let live = Arc::new(Live {
        state: Mutex::new(LiveState { thread: thread.clone(), messages: messages.clone(), status: RunStatus::Submitted, error: None }),
        cancel: CancellationToken::new(),
        inbox,
        done,
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
