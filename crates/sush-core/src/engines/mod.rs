//! Outside engines: a Cowork session can be driven by the user's own Claude
//! Code or Codex instead of Sush's agent loop (`crate::agent::run`). Sush
//! starts the CLI the user installed and signed in to, as published, and
//! translates its stream into the same `Op`s the UI and shared sessions
//! already consume, so watching, steering and approving work unchanged.
//!
//! Sush never sees, stores or passes on the user's Claude or ChatGPT
//! credentials: signing in happens in the CLI's own flow (`claude auth login`,
//! `codex login`), and the CLI reads its own credentials. That is what
//! Anthropic's and OpenAI's terms allow for an app like this; see
//! `docs/engines.md` before changing how an engine is started or signed in.
//!
//! - `claude`: `claude -p` with stream-json in and out. Permission prompts
//!   come to Sush (`--permission-prompt-tool stdio`) as `can_use_tool`
//!   requests and are answered from the approval card.
//! - `codex`: `codex app-server`, JSON-RPC over stdio. Approvals arrive as
//!   requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`).
//!
//! The CLI keeps its own conversation; its session id goes on each reply
//! (`metadata.engineSession`) so the next message resumes it. A thread that
//! has no session to resume (the first message, a regenerate or an edit, or
//! replies from another model in between) starts a new one with the earlier
//! conversation quoted as text.
//!
//! The CLI's tool calls show as Sush's own cards where one fits (`Bash` as
//! `shell_run`, `Edit` as `fs_edit`, `TodoWrite` as `todo_write`, ...), and
//! as `claude-code__<tool>` / `codex__<tool>` otherwise. Its commands run
//! outside Sush's sandbox (under the CLI's own rules), so they're marked
//! `unsandboxed`, which also keeps shared-session guests from approving them.
//! Sush doesn't checkpoint an engine's edits: undo is git's, or the CLI's.

mod claude;
mod codex;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent::run::{Author, Inbox, RunAction, RunConfig, RunEvent, RunHost, RunStatus, ToolResponse, ANSWERS, PAUSED, PAUSED_CALL, RESUMED};
use crate::agent::ui::{self, apply, Op, ToolCall, FOLDER_MEDIA_TYPE, STOPPED};
use crate::workspace::{tools as ws_tools, Access, Commands, EditApproval, Workspace};
use crate::Effort;

/// Metadata key on a reply: the engine's session id, which the next message resumes.
pub const SESSION: &str = "engineSession";
/// The result of a call the CLI was waiting on when it went away (the app restarted, say).
pub const ENDED: &str = "Not run: the session ended before anyone answered.";
const RESUME_PROMPT: &str = "Continue from where you left off.";
/// How much of an earlier conversation a new session is given, in characters.
const HISTORY_LIMIT: usize = 40_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    ClaudeCode,
    Codex,
}

pub const ALL: [Kind; 2] = [Kind::ClaudeCode, Kind::Codex];

impl Kind {
    /// The engine a run's `provider_id` names, if it names one.
    pub fn from_provider(id: &str) -> Option<Kind> {
        ALL.into_iter().find(|k| k.provider_id() == id)
    }

    pub fn provider_id(self) -> &'static str {
        match self {
            Kind::ClaudeCode => "engine:claude-code",
            Kind::Codex => "engine:codex",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::ClaudeCode => "Claude Code",
            Kind::Codex => "Codex",
        }
    }

    fn program(self) -> &'static str {
        match self {
            Kind::ClaudeCode => "claude",
            Kind::Codex => "codex",
        }
    }

    fn login_command(self) -> &'static str {
        match self {
            Kind::ClaudeCode => "claude auth login",
            Kind::Codex => "codex login",
        }
    }

    /// The prefix of a CLI tool that has no Sush card of its own.
    pub fn tool_prefix(self) -> &'static str {
        match self {
            Kind::ClaudeCode => "claude-code__",
            Kind::Codex => "codex__",
        }
    }

    fn models(self) -> Vec<EngineModel> {
        let list: &[(&str, &str)] = match self {
            Kind::ClaudeCode => &[("default", "Claude Code's default"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")],
            Kind::Codex => &[("default", "Codex's default")],
        };
        list.iter()
            .map(|(id, name)| EngineModel { id: (*id).into(), display_name: (*name).into(), description: None, efforts: Vec::new() })
            .collect()
    }
}

// --- status ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineModel {
    /// What the CLI takes as its model: an alias (`opus`) or a full id (`claude-fable-5-1[1m]`).
    pub id: String,
    /// With its version, as the CLI describes it ("Fable 5.1").
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The effort levels the CLI says this model takes; empty when it has none.
    pub efforts: Vec<Effort>,
}

/// An effort level as the CLIs write it (`low` … `max`), if Sush has it.
fn effort(v: &Value) -> Option<Effort> {
    serde_json::from_value(v.clone()).ok()
}

fn effort_str(effort: Effort) -> String {
    serde_json::to_value(effort).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

/// An engine as the model picker shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineView {
    /// The `provider_id` a run uses for it.
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    /// None when the CLI couldn't say.
    pub signed_in: Option<bool>,
    /// What to do before it can be used, if anything.
    pub detail: Option<String>,
    pub models: Vec<EngineModel>,
}

/// Whether the engine is installed and signed in. Asks the CLI itself; only
/// whether it's signed in is read, never who or with what.
pub async fn status(kind: Kind) -> EngineView {
    let mut view = EngineView {
        id: kind.provider_id().into(),
        name: kind.name().into(),
        installed: false,
        version: None,
        signed_in: None,
        detail: None,
        models: kind.models(),
    };
    let Some(program) = find_program(kind.program()) else {
        view.detail = Some(format!("Install {}, then run `{}` in a terminal.", kind.name(), kind.login_command()));
        return view;
    };
    view.installed = true;
    if let Some((_, out)) = output(&program, &["--version"]).await {
        view.version = out.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
    }
    view.signed_in = match kind {
        Kind::ClaudeCode => output(&program, &["auth", "status"])
            .await
            .and_then(|(_, out)| serde_json::from_str::<Value>(&out).ok())
            .and_then(|v| v.get("loggedIn").and_then(Value::as_bool)),
        Kind::Codex => output(&program, &["login", "status"]).await.map(|(ok, _)| ok),
    };
    if view.signed_in == Some(false) {
        view.detail = Some(format!("Run `{}` in a terminal to sign in.", kind.login_command()));
        return view;
    }
    // The models this install offers, with their versions and effort levels, as the CLI lists them.
    let listed = match kind {
        Kind::ClaudeCode => claude::models().await,
        Kind::Codex => codex::models().await,
    };
    if let Some(models) = listed.filter(|m| !m.is_empty()) {
        view.models = models;
    }
    view
}

/// Run `program args`, returning whether it succeeded and its stdout.
async fn output(program: &Path, args: &[&str]) -> Option<(bool, String)> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(crate::workspace::shell::CREATE_NO_WINDOW);
    let out = tokio::time::timeout(Duration::from_secs(15), cmd.output()).await.ok()?.ok()?;
    Some((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned()))
}

/// The program on PATH, with its Windows extension (`.exe`, `.cmd`).
fn find_program(name: &str) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into()).split(';').filter(|e| !e.is_empty()).map(str::to_owned).collect()
    } else {
        vec![String::new()]
    };
    dirs.iter().flat_map(|d| exts.iter().map(move |e| d.join(format!("{name}{e}")))).find(|p| p.is_file())
}

// --- the process ------------------------------------------------------------------------

/// The CLI, spoken to in JSON lines.
pub(crate) struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
    pub lines: Lines<BufReader<ChildStdout>>,
    stderr: tokio::task::JoinHandle<String>,
    name: &'static str,
}

impl Proc {
    fn spawn(kind: Kind, args: &[String], cwd: &Path) -> Result<Proc, String> {
        let program = find_program(kind.program())
            .ok_or_else(|| format!("{} isn't installed, or isn't on PATH. Install it, then run `{}` in a terminal.", kind.name(), kind.login_command()))?;
        let mut cmd = Command::new(program);
        cmd.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        // Sush's own secrets aren't the CLI's business; the user's environment otherwise is.
        for (key, _) in std::env::vars_os() {
            if key.to_str().is_some_and(|k| {
                let k = k.to_ascii_uppercase();
                k.starts_with("SUSH_") || k.starts_with("BETTER_AUTH")
            }) {
                cmd.env_remove(key);
            }
        }
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(windows)]
        cmd.creation_flags(crate::workspace::shell::CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {}: {e}", kind.name()))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("No output from the CLI")?;
        let stderr = tokio::spawn(crate::workspace::shell::read_capped(child.stderr.take()));
        Ok(Proc { child, stdin, lines: BufReader::new(stdout).lines(), stderr, name: kind.name() })
    }

    async fn send(&mut self, message: &Value) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or_else(|| format!("{} has stopped taking input.", self.name))?;
        let mut line = message.to_string();
        line.push('\n');
        stdin.write_all(line.as_bytes()).await.map_err(|e| format!("{} stopped: {e}", self.name))?;
        stdin.flush().await.map_err(|e| format!("{} stopped: {e}", self.name))
    }

    /// Why it stopped, for an error: the end of what it wrote to stderr.
    async fn exit_reason(&mut self) -> String {
        let status = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await.ok().and_then(Result::ok);
        let stderr = tokio::time::timeout(Duration::from_secs(1), &mut self.stderr).await.ok().and_then(Result::ok).unwrap_or_default();
        let tail: String = stderr.trim().lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        match (status.and_then(|s| s.code()), tail.is_empty()) {
            (_, false) => format!("{} stopped: {tail}", self.name),
            (Some(code), true) => format!("{} stopped (exit code {code}).", self.name),
            (None, true) => format!("{} stopped.", self.name),
        }
    }

    /// End it: close its input and give it a moment, then kill its whole tree.
    async fn finish(mut self, now: bool) {
        self.stdin = None;
        if !now && tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await.is_ok() {
            return;
        }
        if let Some(pid) = self.child.id() {
            crate::workspace::shell::kill_tree(pid);
        }
        let _ = self.child.kill().await;
    }
}

// --- how a session runs ------------------------------------------------------------------

/// The folder an engine works in, and the settings it's held to there.
#[derive(Debug, Clone)]
pub struct Context {
    pub cwd: PathBuf,
    pub access: Access,
    pub approval: EditApproval,
    pub commands: Commands,
}

impl Context {
    pub fn new(workspace: &Workspace) -> Self {
        // CLIs written in Node don't take Windows' `\\?\` form of a path.
        let root = workspace.root.strip_prefix(r"\\?\").unwrap_or(&workspace.root);
        Context { cwd: PathBuf::from(root), access: workspace.access, approval: workspace.approval, commands: workspace.commands }
    }
}

/// How a drive ended, when it didn't fail.
pub(crate) enum Ending {
    Done,
    /// `Inbox::Pause`: messages sent meanwhile that the CLI never got.
    Paused(Vec<Value>),
}

/// Run `action` on a thread with the engine and return the messages as they end up.
/// The same contract as `crate::agent::run`, which the host calls otherwise.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    host: &dyn RunHost,
    kind: Kind,
    messages: Vec<Value>,
    action: RunAction,
    config: RunConfig,
    ctx: Context,
    inbox: &mut mpsc::UnboundedReceiver<Inbox>,
    cancel: &CancellationToken,
) -> Vec<Value> {
    let mut t = Thread::new(host, kind, &config.model, config.effort, messages, ctx.cwd.clone());
    // A new session (with the conversation so far as text) instead of resuming the CLI's.
    let mut fresh = false;
    match action {
        RunAction::Send { mut message, replace } => {
            if let Some(i) = replace.as_deref().and_then(|id| t.position(id)) {
                t.messages.truncate(i);
                message["id"] = json!(replace);
                fresh = true;
            }
            t.messages.push(with_id(message));
        }
        RunAction::Steer { message } => t.messages.push(with_id(message)),
        RunAction::Regenerate { message_id } => {
            let at = match message_id.as_deref().and_then(|id| t.position(id)) {
                Some(i) if ui::role(&t.messages[i]) == Some("assistant") => Some(i),
                Some(i) => Some(i + 1),
                None => t.messages.iter().rposition(|m| ui::role(m) == Some("assistant")),
            };
            if let Some(i) = at {
                t.messages.truncate(i);
            }
            fresh = true;
        }
        RunAction::Respond { .. } => {
            // The CLI that asked is gone (the app restarted meanwhile), so the call can't run now.
            host.emit(RunEvent::Op(Op::Reset { messages: t.messages.clone() }));
            for (index, call) in ui::unresolved_calls(&t.messages) {
                t.op(Op::SetPart { index, part: ui::tool_result_part(&call, Err(ENDED.into())) });
            }
            host.save(&t.messages).await;
            t.status(RunStatus::Ready, None);
            return t.messages;
        }
        RunAction::Resume => {
            if let Some(metadata) = t.messages.last_mut().filter(|m| ui::role(m) == Some("assistant")).and_then(|m| m.get_mut("metadata")).and_then(Value::as_object_mut) {
                metadata.remove(PAUSED);
            }
            for (index, call) in ui::unresolved_calls(&t.messages) {
                if let Some(last) = t.messages.last_mut() {
                    last["parts"][index] = ui::tool_result_part(&call, Err(STOPPED.into()));
                }
            }
            t.messages.push(with_id(json!({
                "role": "user",
                "parts": [{ "type": "text", "text": RESUME_PROMPT }],
                "metadata": { RESUMED: true },
            })));
        }
    }
    host.emit(RunEvent::Op(Op::Reset { messages: t.messages.clone() }));
    if t.messages.last().and_then(ui::role) != Some("user") {
        t.status(RunStatus::Ready, None);
        return t.messages;
    }

    let last = t.messages.len() - 1;
    let session = if fresh { None } else { resumable_session(kind, &t.messages[..last]) };
    let mut prompt = prompt_text(&t.messages[last], &config.expansions);
    if session.is_none() {
        if let Some(history) = history(&t.messages[..last]) {
            prompt = format!("{history}\n\n{prompt}");
        }
    }
    t.session = session.clone();
    t.status(RunStatus::Submitted, None);

    let result = match kind {
        Kind::ClaudeCode => claude::drive(&mut t, &ctx, session, prompt, inbox, cancel).await,
        Kind::Codex => codex::drive(&mut t, &ctx, session, prompt, inbox, cancel).await,
    };
    let result = match result {
        _ if cancel.is_cancelled() => {
            t.stop_open(STOPPED);
            if t.last_is_assistant() {
                t.op(Op::SetMetadata { metadata: json!({ PAUSED: true }) });
            }
            Ok(())
        }
        Ok(Ending::Paused(held)) => {
            if held.is_empty() {
                t.stop_open(PAUSED_CALL);
                if t.last_is_assistant() {
                    t.op(Op::SetMetadata { metadata: json!({ PAUSED: true }) });
                }
            } else {
                for message in held {
                    t.push_user(message);
                }
            }
            Ok(())
        }
        Ok(Ending::Done) => {
            t.stop_open(ENDED);
            Ok(())
        }
        Err(e) => {
            t.stop_open(ENDED);
            Err(e)
        }
    };
    host.save(&t.messages).await;
    match result {
        Ok(()) => t.status(RunStatus::Ready, None),
        Err(e) => t.status(RunStatus::Error, Some(e)),
    }
    t.messages
}

fn with_id(mut message: Value) -> Value {
    if message.get("id").and_then(Value::as_str).is_none() {
        message["id"] = json!(ui::new_id());
    }
    message
}

/// The session the thread's last reply came from, if this engine wrote it.
fn resumable_session(kind: Kind, messages: &[Value]) -> Option<String> {
    let last = messages.iter().rev().find(|m| ui::role(m) == Some("assistant"))?;
    let metadata = last.get("metadata")?;
    (metadata.get("providerId").and_then(Value::as_str) == Some(kind.provider_id()))
        .then(|| metadata.get(SESSION).and_then(Value::as_str).map(str::to_owned))
        .flatten()
}

/// What the CLI is sent for a user message: its text (or the skill or
/// connector expansion the UI made of it), plus a note of what it can't get.
pub(crate) fn prompt_text(message: &Value, expansions: &HashMap<String, String>) -> String {
    let id = message.get("id").and_then(Value::as_str).unwrap_or_default();
    let mut texts = Vec::new();
    let mut expanded = false;
    for part in ui::parts(message) {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = part.get("text").and_then(Value::as_str).unwrap_or_default();
                match expansions.get(id).filter(|_| !expanded) {
                    Some(expansion) => {
                        expanded = true;
                        texts.push(expansion.clone());
                    }
                    None => texts.push(text.to_string()),
                }
            }
            Some("file") => {
                let name = part.get("filename").and_then(Value::as_str).unwrap_or("a file");
                if part.get("mediaType").and_then(Value::as_str) == Some(FOLDER_MEDIA_TYPE) {
                    texts.push(format!("(The user attached the folder {name}.)"));
                } else {
                    texts.push(format!("(The user attached {name}, which Sush can't pass on to this agent yet.)"));
                }
            }
            _ => {}
        }
    }
    texts.join("\n\n")
}

/// The conversation before `messages`' end as text, for a new session that
/// can't resume the old one. None when there's nothing before it.
fn history(messages: &[Value]) -> Option<String> {
    let mut turns: Vec<String> = Vec::new();
    for message in messages {
        let who = match ui::role(message) {
            Some("user") => "User",
            Some("assistant") => "Assistant",
            _ => continue,
        };
        let text: Vec<&str> = ui::parts(message)
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect();
        let text = ui::strip_citations(&text.join("\n\n"));
        if !text.trim().is_empty() {
            turns.push(format!("{who}: {}", text.trim()));
        }
    }
    if turns.is_empty() {
        return None;
    }
    // Keep the most recent turns that fit.
    let mut kept = Vec::new();
    let mut size = 0;
    for turn in turns.iter().rev() {
        size += turn.len();
        if size > HISTORY_LIMIT && !kept.is_empty() {
            break;
        }
        kept.push(turn.as_str());
    }
    kept.reverse();
    Some(format!(
        "<earlier-conversation>\n{}\n</earlier-conversation>\n\nThat conversation happened before this session started; carry on from it. The user's new message:",
        kept.join("\n\n")
    ))
}

// --- tool calls as Sush shows them ---------------------------------------------------------

/// A path the CLI gave, relative to the folder when it's inside it (as Sush's own tools write them).
pub(crate) fn relative(path: Option<&str>, cwd: &Path) -> Value {
    let Some(path) = path else { return Value::Null };
    let norm = |s: &str| s.strip_prefix(r"\\?\").unwrap_or(s).replace('\\', "/");
    let (p, root) = (norm(path), norm(&cwd.to_string_lossy()));
    let root = root.trim_end_matches('/');
    let same = |a: &str, b: &str| if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b };
    if same(&p, root) {
        return json!(".");
    }
    if let (Some(head), Some(rest)) = (p.get(..root.len()), p.get(root.len()..)) {
        if same(head, root) && rest.len() > 1 && rest.starts_with('/') {
            return json!(rest[1..]);
        }
    }
    json!(path)
}

/// One of Claude Code's tools as the card Sush shows for it.
pub(crate) fn claude_tool(name: &str, input: &Value, cwd: &Path) -> (String, Value) {
    let path = |key: &str| relative(input.get(key).and_then(Value::as_str), cwd);
    let s = |key: &str| input.get(key).cloned().unwrap_or(Value::Null);
    let (name, input) = match name {
        "Bash" | "PowerShell" => (
            ws_tools::SHELL_RUN,
            json!({ "command": s("command"), "justification": s("description"), "unsandboxed": true }),
        ),
        "Read" => ("fs_read", json!({ "path": path("file_path") })),
        "Write" => ("fs_write", json!({ "path": path("file_path"), "content": s("content") })),
        "Edit" => ("fs_edit", json!({ "path": path("file_path"), "old_string": s("old_string"), "new_string": s("new_string") })),
        "MultiEdit" => ("fs_edit", json!({ "path": path("file_path") })),
        "NotebookEdit" => ("fs_edit", json!({ "path": path("notebook_path") })),
        "Glob" => ("fs_glob", json!({ "pattern": s("pattern"), "path": path("path") })),
        "Grep" => ("fs_search", json!({ "pattern": s("pattern"), "path": path("path") })),
        "LS" => ("fs_list", json!({ "path": path("path") })),
        "TodoWrite" => ("todo_write", input.clone()),
        other => return (format!("{}{other}", Kind::ClaudeCode.tool_prefix()), input.clone()),
    };
    (name.to_string(), input)
}

// --- writing the thread ------------------------------------------------------------------------

/// The thread as an engine run writes it: opens a reply when output starts,
/// streams text and reasoning into parts, and tracks the reply's tool calls.
pub(crate) struct Thread<'a> {
    host: &'a dyn RunHost,
    kind: Kind,
    /// The model as picked: what the CLI is started with.
    model: String,
    effort: Option<Effort>,
    /// The model the CLI says it ran (an alias like `opus` resolves to a version), for the replies.
    resolved: Option<String>,
    pub messages: Vec<Value>,
    pub cwd: PathBuf,
    /// The CLI's session id, once known; every reply records it.
    pub session: Option<String>,
    text: Option<(usize, String)>,
    reasoning: Option<(usize, String)>,
    /// The last reply's calls without a result: part index and the call as shown.
    calls: HashMap<String, (usize, ToolCall)>,
    running: HashSet<String>,
    status: Option<RunStatus>,
}

impl<'a> Thread<'a> {
    fn new(host: &'a dyn RunHost, kind: Kind, model: &str, effort: Option<Effort>, messages: Vec<Value>, cwd: PathBuf) -> Self {
        Thread {
            host,
            kind,
            model: model.to_string(),
            effort,
            resolved: None,
            messages,
            cwd,
            session: None,
            text: None,
            reasoning: None,
            calls: HashMap::new(),
            running: HashSet::new(),
            status: None,
        }
    }

    fn op(&mut self, op: Op) {
        apply(&mut self.messages, &op);
        self.host.emit(RunEvent::Op(op));
    }

    pub fn status(&mut self, status: RunStatus, error: Option<String>) {
        if self.status != Some(status) || error.is_some() {
            self.status = Some(status);
            self.host.emit(RunEvent::Status { status, error });
        }
    }

    /// Streaming, unless calls wait for the user.
    pub fn working(&mut self, awaiting: bool) {
        self.status(if awaiting { RunStatus::Awaiting } else { RunStatus::Streaming }, None);
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.messages.iter().position(|m| m.get("id").and_then(Value::as_str) == Some(id))
    }

    fn last_is_assistant(&self) -> bool {
        self.messages.last().and_then(ui::role) == Some("assistant")
    }

    fn len(&self) -> usize {
        self.messages.last().map_or(0, |m| ui::parts(m).len())
    }

    /// Make sure the last message is a reply to write into.
    fn reply(&mut self) {
        if self.last_is_assistant() {
            return;
        }
        let created_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let model = self.resolved.as_ref().unwrap_or(&self.model);
        let mut metadata = json!({ "providerId": self.kind.provider_id(), "model": model, "createdAt": created_at });
        if let Some(session) = &self.session {
            metadata[SESSION] = json!(session);
        }
        self.op(Op::Push { message: json!({ "id": ui::new_id(), "role": "assistant", "parts": [], "metadata": metadata }) });
        self.text = None;
        self.reasoning = None;
        self.calls.clear();
    }

    /// A model request began: the UI times stretches of work from these.
    pub fn step(&mut self) {
        self.reply();
        self.close_text();
        self.close_reasoning();
        self.op(Op::PushPart { part: json!({ "type": "step-start", "at": now_ms() }) });
    }

    /// The model the CLI ran, once it says: the replies show it rather than the alias picked.
    pub fn set_model(&mut self, model: &str) {
        if model.is_empty() || self.resolved.as_deref() == Some(model) {
            return;
        }
        self.resolved = Some(model.to_string());
        if self.last_is_assistant() {
            self.op(Op::SetMetadata { metadata: json!({ "model": model }) });
        }
    }

    pub fn set_session(&mut self, id: &str) {
        if id.is_empty() || self.session.as_deref() == Some(id) {
            return;
        }
        self.session = Some(id.to_string());
        if self.last_is_assistant() {
            self.op(Op::SetMetadata { metadata: json!({ SESSION: id }) });
        }
    }

    pub fn text_delta(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        self.reply();
        self.close_reasoning();
        if self.text.is_none() {
            let index = self.len();
            self.op(Op::PushPart { part: json!({ "type": "text", "text": "", "state": "streaming" }) });
            self.text = Some((index, String::new()));
        }
        let (index, text) = self.text.as_mut().expect("opened above");
        text.push_str(delta);
        let index = *index;
        self.op(Op::AppendText { index, delta: delta.to_string() });
    }

    pub fn close_text(&mut self) {
        if let Some((index, text)) = self.text.take() {
            self.op(Op::SetPart { index, part: json!({ "type": "text", "text": text, "state": "done" }) });
        }
    }

    pub fn reasoning_delta(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        self.reply();
        self.close_text();
        if self.reasoning.is_none() {
            let index = self.len();
            self.op(Op::PushPart { part: json!({ "type": "reasoning", "text": "", "state": "streaming" }) });
            self.reasoning = Some((index, String::new()));
        }
        let (index, text) = self.reasoning.as_mut().expect("opened above");
        text.push_str(delta);
        let index = *index;
        self.op(Op::AppendText { index, delta: delta.to_string() });
    }

    pub fn close_reasoning(&mut self) {
        if let Some((index, text)) = self.reasoning.take() {
            self.op(Op::SetPart { index, part: json!({ "type": "reasoning", "text": text, "state": "done" }) });
        }
    }

    /// A call whose input is still arriving.
    pub fn tool_streaming(&mut self, id: &str, name: &str) {
        if self.calls.contains_key(id) {
            return;
        }
        self.reply();
        self.close_text();
        self.close_reasoning();
        let index = self.len();
        self.op(Op::PushPart { part: json!({ "type": "dynamic-tool", "toolName": name, "toolCallId": id, "state": "input-streaming" }) });
        self.calls.insert(id.to_string(), (index, ToolCall { id: id.to_string(), name: name.to_string(), input: json!({}) }));
    }

    /// A call the CLI is running (or about to ask about).
    pub fn tool_ready(&mut self, id: &str, name: &str, input: Value) {
        let part = json!({ "type": "dynamic-tool", "toolName": name, "toolCallId": id, "state": "input-available", "input": input });
        let call = ToolCall { id: id.to_string(), name: name.to_string(), input };
        match self.calls.get(id).map(|(index, _)| *index) {
            Some(index) => {
                self.op(Op::SetPart { index, part });
                self.calls.insert(id.to_string(), (index, call));
            }
            None => {
                self.reply();
                self.close_text();
                self.close_reasoning();
                let index = self.len();
                self.op(Op::PushPart { part });
                self.calls.insert(id.to_string(), (index, call));
            }
        }
        if self.running.insert(id.to_string()) {
            self.host.emit(RunEvent::ToolRunning { call_id: id.to_string(), running: true });
        }
    }

    pub fn has_call(&self, id: &str) -> bool {
        self.calls.contains_key(id)
    }

    /// The CLI asks before running it: the card shows Approve / Deny.
    pub fn tool_waiting(&mut self, id: &str) {
        if self.running.remove(id) {
            self.host.emit(RunEvent::ToolRunning { call_id: id.to_string(), running: false });
        }
    }

    /// Approved: it runs.
    pub fn tool_approved(&mut self, id: &str) {
        if self.calls.contains_key(id) && self.running.insert(id.to_string()) {
            self.host.emit(RunEvent::ToolRunning { call_id: id.to_string(), running: true });
        }
    }

    pub fn tool_end(&mut self, id: &str, result: Result<Value, String>) {
        let Some((index, call)) = self.calls.remove(id) else { return };
        if self.running.remove(id) {
            self.host.emit(RunEvent::ToolRunning { call_id: id.to_string(), running: false });
        }
        self.op(Op::SetPart { index, part: ui::tool_result_part(&call, result) });
        if ws_tools::changes_files(&call.name) {
            self.host.files_changed();
        }
    }

    /// A call that ends with its result right away (a plan update, say).
    pub fn tool_done(&mut self, id: &str, name: &str, input: Value, output: Value) {
        self.tool_ready(id, name, input);
        self.tool_end(id, Ok(output));
    }

    /// Close what's open: text renders finished, calls get `reason` as their result.
    pub fn stop_open(&mut self, reason: &str) {
        self.close_text();
        self.close_reasoning();
        let mut open: Vec<String> = self.calls.keys().cloned().collect();
        open.sort_by_key(|id| self.calls[id].0);
        for id in open {
            self.tool_end(&id, Err(reason.to_string()));
        }
    }

    /// A user message the CLI took in: it joins the thread, and output after it is a new reply.
    pub fn push_user(&mut self, message: Value) {
        self.stop_open(crate::agent::run::INTERRUPTED);
        self.op(Op::Push { message: with_id(message) });
    }

    pub fn usage(&mut self, input: Option<u64>, output: Option<u64>, cached: Option<u64>, context: Option<u64>) {
        if !self.last_is_assistant() {
            return;
        }
        let mut metadata = serde_json::Map::new();
        for (key, value) in [("inputTokens", input), ("outputTokens", output), ("cachedInputTokens", cached), ("contextTokens", context)] {
            if let Some(value) = value {
                metadata.insert(key.into(), json!(value));
            }
        }
        if !metadata.is_empty() {
            self.op(Op::SetMetadata { metadata: Value::Object(metadata) });
        }
    }

    /// Who answered a call, in a shared session (as `crate::agent::run` records it).
    pub fn record_answer(&mut self, call_id: &str, response: &ToolResponse, by: Author) {
        let decision = match response {
            ToolResponse::Approve => "approve",
            ToolResponse::Output { .. } => "answer",
            ToolResponse::Error { .. } => "deny",
        };
        let mut answers = self
            .messages
            .last()
            .and_then(|m| m.get("metadata"))
            .and_then(|m| m.get(ANSWERS))
            .filter(|a| a.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        answers[call_id] = json!({ "by": by, "decision": decision, "at": now_ms() });
        self.op(Op::SetMetadata { metadata: json!({ ANSWERS: answers }) });
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engines_are_named_by_provider_id() {
        assert_eq!(Kind::from_provider("engine:claude-code"), Some(Kind::ClaudeCode));
        assert_eq!(Kind::from_provider("engine:codex"), Some(Kind::Codex));
        assert_eq!(Kind::from_provider("anthropic"), None);
    }

    #[test]
    fn paths_inside_the_folder_become_relative() {
        let cwd = if cfg!(windows) { Path::new(r"C:\work\app") } else { Path::new("/work/app") };
        let inside = if cfg!(windows) { r"C:\Work\app\src\main.rs" } else { "/work/app/src/main.rs" };
        let outside = if cfg!(windows) { r"C:\work\other.rs" } else { "/work/other.rs" };
        // On Windows the case of the folder doesn't matter.
        assert_eq!(relative(Some(inside), cwd), json!("src/main.rs"));
        assert_eq!(relative(Some(outside), cwd), json!(outside));
        assert_eq!(relative(Some("src/lib.rs"), cwd), json!("src/lib.rs"));
        assert_eq!(relative(None, cwd), Value::Null);
    }

    #[test]
    fn claude_tools_map_to_sush_cards() {
        let cwd = Path::new("/w");
        let (name, input) = claude_tool("Bash", &json!({ "command": "ls", "description": "List" }), cwd);
        assert_eq!(name, "shell_run");
        assert_eq!(input["unsandboxed"], json!(true));
        let (name, input) = claude_tool("Edit", &json!({ "file_path": "/w/a.rs", "old_string": "x", "new_string": "y" }), cwd);
        assert_eq!((name.as_str(), input["path"].clone()), ("fs_edit", json!("a.rs")));
        assert_eq!(claude_tool("Task", &json!({}), cwd).0, "claude-code__Task");
    }

    #[test]
    fn prompts_take_expansions_and_note_attachments() {
        let message = json!({ "id": "m", "role": "user", "parts": [
            { "type": "text", "text": "/review" },
            { "type": "file", "filename": "shot.png", "mediaType": "image/png", "url": "sushblob://x" },
        ]});
        let expansions = HashMap::from([("m".to_string(), "Review the diff.".to_string())]);
        let text = prompt_text(&message, &expansions);
        assert!(text.starts_with("Review the diff."));
        assert!(text.contains("shot.png"));
    }

    #[test]
    fn only_this_engines_last_reply_resumes() {
        let reply = |provider: &str| json!({ "role": "assistant", "parts": [], "metadata": { "providerId": provider, SESSION: "s1" } });
        let user = json!({ "role": "user", "parts": [] });
        assert_eq!(resumable_session(Kind::ClaudeCode, &[user.clone(), reply("engine:claude-code")]), Some("s1".into()));
        assert_eq!(resumable_session(Kind::ClaudeCode, &[reply("engine:claude-code"), user.clone(), reply("openai")]), None);
        assert_eq!(resumable_session(Kind::Codex, &[user, reply("engine:claude-code")]), None);
    }

    #[test]
    fn history_quotes_the_conversation() {
        let messages = [
            json!({ "role": "user", "parts": [{ "type": "text", "text": "hi" }] }),
            json!({ "role": "assistant", "parts": [{ "type": "text", "text": "hello" }] }),
        ];
        let h = history(&messages).unwrap();
        assert!(h.contains("User: hi") && h.contains("Assistant: hello"));
        assert_eq!(history(&[]), None);
    }
}
