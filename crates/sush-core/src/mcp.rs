//! Minimal Model Context Protocol client for local (stdio) servers: start the
//! server, list its tools, call them. JSON-RPC 2.0, one message per line.
//!
//! Only the tool surface is implemented. Requests the server makes of us
//! (roots, sampling, elicitation) are answered with "not supported", except
//! `ping` and an empty `roots/list`.

use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

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
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

fn tail(stderr: &str) -> String {
    let s = stderr.trim();
    if s.is_empty() { String::new() } else { format!(": {s}") }
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

pub struct McpClient {
    writer: Writer,
    pending: Pending,
    next_id: AtomicU64,
    stderr: Arc<Mutex<String>>,
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
        let pending: Pending = Arc::default();
        let writer: Writer = Arc::new(AsyncMutex::new(Box::new(writer)));
        let mut client = Self {
            writer,
            pending: pending.clone(),
            next_id: AtomicU64::new(1),
            stderr: stderr.clone(),
            _child: None,
            server_name: None,
            tools: vec![],
        };

        // Replies to server-initiated requests go out through this channel.
        let (reply_tx, mut reply_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        tokio::spawn(read_loop(reader, pending, reply_tx, stderr));

        let init = client
            .request_with_replies(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "sush", "version": env!("CARGO_PKG_VERSION") },
                }),
                INIT_TIMEOUT,
                &mut reply_rx,
            )
            .await?;
        client.server_name = init["serverInfo"]["name"].as_str().map(str::to_owned);
        write_msg(&client.writer, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await?;

        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let page = client.request_with_replies("tools/list", params, INIT_TIMEOUT, &mut reply_rx).await?;
            let tools: Vec<McpTool> = serde_json::from_value(page["tools"].clone()).unwrap_or_default();
            client.tools.extend(tools);
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }

        // From here on, answer server requests in the background.
        let writer = client.writer.clone();
        tokio::spawn(async move {
            while let Some(reply) = reply_rx.recv().await {
                if write_msg(&writer, &reply).await.is_err() {
                    break;
                }
            }
        });
        Ok(client)
    }

    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<ToolOutput, McpError> {
        let result = self.request("tools/call", json!({ "name": name, "arguments": arguments }), CALL_TIMEOUT).await?;
        Ok(flatten_result(&result))
    }

    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if write_msg(&self.writer, &msg).await.is_err() {
            // The server is gone; its stderr usually says why.
            self.pending.lock().unwrap().remove(&id);
            return Err(McpError::Closed(self.stderr.lock().unwrap().clone()));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(McpError::Closed(self.stderr.lock().unwrap().clone())),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(McpError::Timeout(timeout))
            }
        }
    }

    /// `request`, while also relaying replies to server requests that arrive
    /// before the background relay exists (some servers ask for roots during init).
    async fn request_with_replies(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    ) -> Result<Value, McpError> {
        let fut = self.request(method, params, timeout);
        tokio::pin!(fut);
        loop {
            tokio::select! {
                result = &mut fut => return result,
                Some(reply) = replies.recv() => write_msg(&self.writer, &reply).await?,
            }
        }
    }

}

async fn write_msg(writer: &Writer, msg: &Value) -> Result<(), McpError> {
    let mut line = serde_json::to_vec(msg)?;
    line.push(b'\n');
    let mut w = writer.lock().await;
    w.write_all(&line).await?;
    w.flush().await?;
    Ok(())
}

async fn read_loop(
    reader: impl AsyncRead + Unpin,
    pending: Pending,
    replies: tokio::sync::mpsc::UnboundedSender<Value>,
    stderr: Arc<Mutex<String>>,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
            continue; // servers sometimes log to stdout; skip non-JSON lines
        };
        let id = msg.get("id").cloned();
        match (msg.get("method").and_then(Value::as_str), id) {
            // A request from the server.
            (Some(method), Some(id)) => {
                let reply = match method {
                    "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
                    "roots/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "roots": [] } }),
                    _ => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "not supported by Sush" } }),
                };
                let _ = replies.send(reply);
            }
            // A notification (logging, list_changed, progress): nothing to do yet.
            (Some(_), None) => {}
            // A response to one of ours.
            (None, Some(id)) => {
                let Some(id) = id.as_u64() else { continue };
                let Some(tx) = pending.lock().unwrap().remove(&id) else { continue };
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
    // Server exited: fail everything still waiting.
    let tail = stderr.lock().unwrap().clone();
    for (_, tx) in pending.lock().unwrap().drain() {
        let _ = tx.send(Err(McpError::Closed(tail.clone())));
    }
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
    async fn server_exit_fails_pending_calls_with_its_stderr() {
        let (ours, theirs) = duplex(1024);
        drop(theirs);
        let (r, w) = split(ours);
        let stderr = Arc::new(Mutex::new("missing API key".to_string()));
        let err = McpClient::connect(r, w, stderr).await.err().unwrap();
        assert!(err.to_string().contains("missing API key"), "{err}");
    }
}
