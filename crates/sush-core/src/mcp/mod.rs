//! Minimal Model Context Protocol client: connect to a server, list its tools,
//! call them. JSON-RPC 2.0 either over a local process's stdio (one message per
//! line) or over HTTP to a remote server (see `http`); sign-in for remote
//! servers lives in `oauth`.
//!
//! Only the tool surface is implemented. Requests the server makes of us
//! (roots, sampling, elicitation) are answered with "not supported", except
//! `ping` and an empty `roots/list`.

pub mod http;
pub mod oauth;

use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

pub use http::{AuthChallenge, RemoteServer, TokenSource};

const PROTOCOL_VERSION: &str = "2025-06-18";
/// First start can include `npx` downloading the server package.
const INIT_TIMEOUT: Duration = Duration::from_secs(90);
const CALL_TIMEOUT: Duration = Duration::from_secs(300);
const STDERR_TAIL: usize = 4096;

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("couldn't start `{command}`: {source}")]
    Spawn { command: String, source: std::io::Error },
    #[error("connector stopped{}", tail(.0))]
    Closed(String),
    #[error("connector timed out after {0:?}")]
    Timeout(Duration),
    #[error("connector error {code}: {message}")]
    Rpc { code: i64, message: String },
    /// The remote server wants credentials (HTTP 401); sign in and reconnect.
    #[error("this connector needs you to sign in")]
    Unauthorized(AuthChallenge),
    #[error("couldn't reach the connector: {0}")]
    Request(#[from] reqwest::Error),
    #[error("connector returned HTTP {status}{}", tail(.body))]
    Http { status: u16, body: String },
    #[error("connector sent something unexpected: {0}")]
    Protocol(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

fn tail(stderr: &str) -> String {
    let s = stderr.trim();
    if s.is_empty() { String::new() } else { format!(": {s}") }
}

/// Where a connector's server lives: a local process or a URL.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerSpec {
    Stdio(ServerCommand),
    Http(RemoteServer),
}

/// How to launch a stdio server, e.g. `npx -y @modelcontextprotocol/server-filesystem C:\notes`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCommand {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "empty_schema")]
    pub input_schema: Value,
    /// Hints like `readOnlyHint` and `destructiveHint`, passed through for the UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
}

fn empty_schema() -> Value {
    json!({ "type": "object" })
}

/// A tool result flattened to text for the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, McpError>>>>>;
type Writer = Arc<AsyncMutex<Box<dyn AsyncWrite + Send + Unpin>>>;

/// Where messages from the server go: responses to the request waiting on
/// them, server requests to an auto-reply sent back through the transport.
#[derive(Clone)]
pub(crate) struct Inbox {
    pending: Pending,
    replies: mpsc::UnboundedSender<Value>,
}

impl Inbox {
    pub(crate) fn deliver(&self, msg: Value) {
        if let Value::Array(batch) = msg {
            batch.into_iter().for_each(|m| self.deliver(m));
            return;
        }
        let id = msg.get("id").cloned();
        match (msg.get("method").and_then(Value::as_str), id) {
            // A request from the server.
            (Some(method), Some(id)) => {
                let reply = match method {
                    "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
                    "roots/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "roots": [] } }),
                    _ => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "not supported by Sush" } }),
                };
                let _ = self.replies.send(reply);
            }
            // A notification (logging, list_changed, progress): nothing to do yet.
            (Some(_), None) => {}
            // A response to one of ours.
            (None, Some(id)) => {
                let Some(id) = id.as_u64() else { return };
                let Some(tx) = self.pending.lock().unwrap().remove(&id) else { return };
                let result = match msg.get("error") {
                    Some(err) => Err(McpError::Rpc {
                        code: err["code"].as_i64().unwrap_or(0),
                        message: err["message"].as_str().unwrap_or("unknown error").to_string(),
                    }),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(result);
            }
            (None, None) => {}
        }
    }

    /// Fail one request if it's still waiting (its stream ended without a reply).
    pub(crate) fn fail(&self, id: u64, err: McpError) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(Err(err));
        }
    }

    /// The connection is gone: fail everything still waiting.
    pub(crate) fn fail_all(&self, err: impl Fn() -> McpError) {
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(err()));
        }
    }
}

enum Outbound {
    Stdio { writer: Writer, stderr: Arc<Mutex<String>> },
    Http(Box<http::HttpTransport>),
}

impl Outbound {
    /// Send one message. `inbox` receives anything the server answers with
    /// inline; replies to server requests pass `None` and ignore answers.
    async fn send(&self, msg: &Value, inbox: Option<&Inbox>) -> Result<(), McpError> {
        match self {
            Outbound::Stdio { writer, stderr } => write_msg(writer, msg)
                .await
                // The server is gone; its stderr usually says why.
                .map_err(|_| McpError::Closed(stderr.lock().unwrap().clone())),
            Outbound::Http(t) => t.send(msg, inbox).await,
        }
    }

    fn stderr(&self) -> String {
        match self {
            Outbound::Stdio { stderr, .. } => stderr.lock().unwrap().clone(),
            Outbound::Http(_) => String::new(),
        }
    }
}

pub struct McpClient {
    out: Arc<Outbound>,
    inbox: Inbox,
    next_id: AtomicU64,
    /// Keeps the server alive; `kill_on_drop` stops it with the client.
    _child: Option<tokio::process::Child>,
    pub server_name: Option<String>,
    pub tools: Vec<McpTool>,
}

impl McpClient {
    /// Start a server process and complete the handshake.
    pub async fn spawn(cmd: &ServerCommand) -> Result<Self, McpError> {
        let mut command = platform_command(&cmd.command, &cmd.args);
        command
            .envs(&cmd.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|source| McpError::Spawn { command: cmd.command.clone(), source })?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        let tail = Arc::new(Mutex::new(String::new()));
        let sink = tail.clone();
        tokio::spawn(async move {
            let mut stderr = stderr;
            let mut buf = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut t = sink.lock().unwrap();
                t.push_str(&String::from_utf8_lossy(&buf[..n]));
                if t.len() > STDERR_TAIL {
                    let cut = t.len() - STDERR_TAIL;
                    let cut = (cut..t.len()).find(|&i| t.is_char_boundary(i)).unwrap_or(t.len());
                    t.drain(..cut);
                }
            }
        });

        let mut client = Self::connect(stdout, stdin, tail).await?;
        client._child = Some(child);
        Ok(client)
    }

    /// Handshake and list tools over an existing byte stream (used by tests).
    pub async fn connect(
        reader: impl AsyncRead + Send + Unpin + 'static,
        writer: impl AsyncWrite + Send + Unpin + 'static,
        stderr: Arc<Mutex<String>>,
    ) -> Result<Self, McpError> {
        let (inbox, replies) = new_inbox();
        tokio::spawn(read_loop(reader, inbox.clone(), stderr.clone()));
        let writer: Writer = Arc::new(AsyncMutex::new(Box::new(writer)));
        Self::start(Outbound::Stdio { writer, stderr }, inbox, replies).await
    }

    /// Connect to a remote server at `url`. `auth` supplies bearer tokens; a
    /// server that wants one we don't have fails with `McpError::Unauthorized`.
    pub async fn connect_http(
        http: reqwest::Client,
        url: &str,
        auth: Option<Arc<dyn TokenSource>>,
    ) -> Result<Self, McpError> {
        let transport = http::HttpTransport::new(http, url, auth)?;
        let (inbox, replies) = new_inbox();
        Self::start(Outbound::Http(Box::new(transport)), inbox, replies).await
    }

    async fn start(out: Outbound, inbox: Inbox, mut replies: mpsc::UnboundedReceiver<Value>) -> Result<Self, McpError> {
        let out = Arc::new(out);
        // Answer server requests in the background. Weak, so dropping the
        // client still tears the transport down.
        let relay: Weak<Outbound> = Arc::downgrade(&out);
        tokio::spawn(async move {
            while let Some(reply) = replies.recv().await {
                let Some(out) = relay.upgrade() else { break };
                if out.send(&reply, None).await.is_err() {
                    break;
                }
            }
        });

        let mut client = Self { out, inbox, next_id: AtomicU64::new(1), _child: None, server_name: None, tools: vec![] };
        let init = client
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "sush", "version": env!("CARGO_PKG_VERSION") },
                }),
                INIT_TIMEOUT,
            )
            .await?;
        client.server_name = init["serverInfo"]["name"].as_str().map(str::to_owned);
        if let (Outbound::Http(t), Some(v)) = (&*client.out, init["protocolVersion"].as_str()) {
            t.set_protocol_version(v);
        }
        client
            .out
            .send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), Some(&client.inbox))
            .await?;

        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let page = client.request("tools/list", params, INIT_TIMEOUT).await?;
            let tools: Vec<McpTool> = serde_json::from_value(page["tools"].clone()).unwrap_or_default();
            client.tools.extend(tools);
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        Ok(client)
    }

    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<ToolOutput, McpError> {
        let result = self.request("tools/call", json!({ "name": name, "arguments": arguments }), CALL_TIMEOUT).await?;
        Ok(flatten_result(&result))
    }

    /// `call_tool` with request `_meta` for a server that reads it (Plinth wants to know which thread is
    /// calling). Only send it to the server it's meant for.
    pub async fn call_tool_with_meta(&self, name: &str, arguments: Value, meta: Value) -> Result<ToolOutput, McpError> {
        let result = self.request("tools/call", json!({ "name": name, "arguments": arguments, "_meta": meta }), CALL_TIMEOUT).await?;
        Ok(flatten_result(&result))
    }

    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.inbox.pending.lock().unwrap().insert(id, tx);
        // Runs on every exit, including the caller dropping this future (Stop).
        let _unanswered = Unanswered { out: &self.out, inbox: &self.inbox, id, cancellable: method != "initialize" };
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let exchange = async {
            self.out.send(&msg, Some(&self.inbox)).await?;
            rx.await.map_err(|_| McpError::Closed(self.out.stderr()))?
        };
        match tokio::time::timeout(timeout, exchange).await {
            Ok(result) => result,
            Err(_) => Err(McpError::Timeout(timeout)),
        }
    }
}

/// A request we stopped waiting on (timed out or dropped) before its reply:
/// forget it and ask the server to stop working on it.
struct Unanswered<'a> {
    out: &'a Arc<Outbound>,
    inbox: &'a Inbox,
    id: u64,
    cancellable: bool,
}

impl Drop for Unanswered<'_> {
    fn drop(&mut self) {
        // Gone from `pending` means the reply (or a failure) already arrived.
        if self.inbox.pending.lock().unwrap().remove(&self.id).is_none() || !self.cancellable {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
        let out = self.out.clone();
        let msg = json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": self.id, "reason": "cancelled by the user" } });
        rt.spawn(async move {
            let _ = out.send(&msg, None).await;
        });
    }
}

fn new_inbox() -> (Inbox, mpsc::UnboundedReceiver<Value>) {
    let (replies, rx) = mpsc::unbounded_channel();
    (Inbox { pending: Arc::default(), replies }, rx)
}

async fn write_msg(writer: &Writer, msg: &Value) -> Result<(), McpError> {
    let mut line = serde_json::to_vec(msg)?;
    line.push(b'\n');
    let mut w = writer.lock().await;
    w.write_all(&line).await?;
    w.flush().await?;
    Ok(())
}

async fn read_loop(reader: impl AsyncRead + Unpin, inbox: Inbox, stderr: Arc<Mutex<String>>) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
            continue; // servers sometimes log to stdout; skip non-JSON lines
        };
        inbox.deliver(msg);
    }
    // Server exited: fail everything still waiting.
    let tail = stderr.lock().unwrap().clone();
    inbox.fail_all(|| McpError::Closed(tail.clone()));
}

/// Text content joined; other content types are summarised so the model knows
/// something was returned.
pub fn flatten_result(result: &Value) -> ToolOutput {
    let mut parts = Vec::new();
    for item in result["content"].as_array().into_iter().flatten() {
        match item["type"].as_str() {
            Some("text") => parts.push(item["text"].as_str().unwrap_or_default().to_string()),
            Some("resource") => {
                let r = &item["resource"];
                match r["text"].as_str() {
                    Some(text) => parts.push(text.to_string()),
                    None => parts.push(format!("[resource {}]", r["uri"].as_str().unwrap_or("?"))),
                }
            }
            Some("resource_link") => parts.push(format!("[link {}]", item["uri"].as_str().unwrap_or("?"))),
            Some(other) => parts.push(format!("[{other} content omitted]")),
            None => {}
        }
    }
    if parts.is_empty() {
        if let Some(structured) = result.get("structuredContent") {
            parts.push(structured.to_string());
        }
    }
    ToolOutput { text: parts.join("\n"), is_error: result["isError"].as_bool().unwrap_or(false) }
}

/// GUI apps on Windows: resolve `npx`/`uvx`-style `.cmd` shims via `cmd /C`
/// and don't flash a console window per server.
fn platform_command(program: &str, args: &[String]) -> tokio::process::Command {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(program).args(args).creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = tokio::process::Command::new(program);
        c.args(args);
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, split};

    /// Plays a tiny MCP server on the other end of an in-memory pipe.
    async fn fake_server(io: tokio::io::DuplexStream) {
        let (r, mut w) = split(io);
        let mut lines = BufReader::new(r).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let msg: Value = serde_json::from_str(&line).unwrap();
            // Skip notifications and our replies to the server's own requests.
            let (Some(id), Some(method)) = (msg.get("id").cloned(), msg["method"].as_str()) else { continue };
            let result = match method {
                "initialize" => {
                    // Ask the client something mid-handshake, like some servers do.
                    w.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"srv-1\",\"method\":\"roots/list\"}\n").await.unwrap();
                    json!({ "protocolVersion": PROTOCOL_VERSION, "serverInfo": { "name": "fake" }, "capabilities": {} })
                }
                "tools/list" if msg["params"]["cursor"].is_null() => json!({
                    "tools": [{ "name": "echo", "description": "Echo", "inputSchema": { "type": "object" } }],
                    "nextCursor": "p2",
                }),
                "tools/list" => json!({ "tools": [{ "name": "fail" }] }),
                "tools/call" if msg["params"]["name"] == "echo" => json!({
                    "content": [{ "type": "text", "text": msg["params"]["arguments"]["say"] }, { "type": "image", "data": "..." }],
                }),
                "tools/call" => json!({ "content": [{ "type": "text", "text": "boom" }], "isError": true }),
                _ => continue,
            };
            let reply = json!({ "jsonrpc": "2.0", "id": id, "result": result });
            w.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
        }
    }

    #[tokio::test]
    async fn handshakes_lists_paginated_tools_and_calls_them() {
        let (ours, theirs) = duplex(64 * 1024);
        tokio::spawn(fake_server(theirs));
        let (r, w) = split(ours);
        let client = McpClient::connect(r, w, Arc::default()).await.unwrap();

        assert_eq!(client.server_name.as_deref(), Some("fake"));
        let names: Vec<_> = client.tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["echo", "fail"]);
        assert_eq!(client.tools[1].input_schema, json!({ "type": "object" }));

        let out = client.call_tool("echo", json!({ "say": "hi" })).await.unwrap();
        assert_eq!(out, ToolOutput { text: "hi\n[image content omitted]".into(), is_error: false });
        let out = client.call_tool("fail", json!({})).await.unwrap();
        assert!(out.is_error);
    }

    #[tokio::test]
    async fn dropping_a_call_tells_the_server_to_cancel_it() {
        let (ours, theirs) = duplex(64 * 1024);
        let (cancelled_tx, cancelled_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (r, mut w) = split(theirs);
            let mut lines = BufReader::new(r).lines();
            let mut cancelled_tx = Some(cancelled_tx);
            while let Ok(Some(line)) = lines.next_line().await {
                let msg: Value = serde_json::from_str(&line).unwrap();
                let result = match msg["method"].as_str() {
                    Some("initialize") => json!({ "protocolVersion": PROTOCOL_VERSION, "serverInfo": { "name": "slow" } }),
                    Some("tools/list") => json!({ "tools": [{ "name": "slow" }] }),
                    Some("notifications/cancelled") => {
                        if let Some(tx) = cancelled_tx.take() {
                            let _ = tx.send(msg["params"]["requestId"].clone());
                        }
                        continue;
                    }
                    _ => continue, // never answer tools/call
                };
                let reply = json!({ "jsonrpc": "2.0", "id": msg["id"], "result": result });
                w.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
            }
        });
        let (r, w) = split(ours);
        let client = McpClient::connect(r, w, Arc::default()).await.unwrap();

        let call = client.call_tool("slow", json!({}));
        assert!(tokio::time::timeout(Duration::from_millis(50), call).await.is_err());
        let id = tokio::time::timeout(Duration::from_secs(5), cancelled_rx).await.unwrap().unwrap();
        assert_eq!(id, json!(3)); // after initialize (1) and tools/list (2)
        assert!(client.inbox.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn server_exit_fails_pending_calls_with_its_stderr() {
        let (ours, theirs) = duplex(1024);
        drop(theirs);
        let (r, w) = split(ours);
        let stderr = Arc::new(Mutex::new("missing API key".to_string()));
        let err = McpClient::connect(r, w, stderr).await.err().unwrap();
        assert!(err.to_string().contains("missing API key"), "{err}");
    }
}
