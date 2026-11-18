//! Sush's own tools for a session an outside engine runs (`sush_core::engines`):
//! a report's, a notebook's or a Studio output's tools, which Claude Code or
//! Codex can't have otherwise. They're served as an MCP server (streamable
//! HTTP, JSON replies only) on 127.0.0.1, started on first use. Each run gets
//! a random bearer token that names it, so a call reaches only that run's
//! tools, and runs them through the run's own `RunHost::execute`, exactly as
//! Sush's loop would. The registration ends with the run.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sush_core::agent::ui::ToolCall;
use sush_core::agent::{RunHost, RunTool};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

/// The MCP version answered when the client names none.
const PROTOCOL: &str = "2025-06-18";
/// Larger bodies are refused; tool inputs are small.
const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_HEADERS: usize = 64;

struct Entry {
    host: Arc<dyn RunHost>,
    tools: Vec<RunTool>,
    cancel: CancellationToken,
}

struct Server {
    port: u16,
    runs: Mutex<HashMap<String, Arc<Entry>>>,
    calls: AtomicU64,
}

static SERVER: OnceCell<Arc<Server>> = OnceCell::const_new();

async fn server() -> Result<Arc<Server>, String> {
    SERVER
        .get_or_try_init(|| async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("Sush's tools couldn't be offered to the engine: {e}"))?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let server = Arc::new(Server { port, runs: Mutex::default(), calls: AtomicU64::new(0) });
            let serving = server.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match listener.accept().await {
                        Ok((stream, _)) => {
                            let server = serving.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = serve(&server, stream).await;
                            });
                        }
                        Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
                    }
                }
            });
            Ok(server)
        })
        .await
        .cloned()
}

/// A run's tools on the bridge, for as long as this is kept.
pub struct Registration {
    server: Arc<Server>,
    pub token: String,
}

impl Registration {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.server.port)
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.server.runs.lock().unwrap().remove(&self.token);
    }
}

/// Offer `tools` to the engine running on `host`; a call is cancelled with `cancel` (the run's).
pub async fn register(host: Arc<dyn RunHost>, tools: Vec<RunTool>, cancel: CancellationToken) -> Result<Registration, String> {
    let server = server().await?;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    server.runs.lock().unwrap().insert(token.clone(), Arc::new(Entry { host, tools, cancel }));
    Ok(Registration { server, token })
}

async fn serve(server: &Server, stream: TcpStream) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read).take((MAX_BODY + 64 * 1024) as u64);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let mut request = line.split_whitespace();
    let (method, path) = (request.next().unwrap_or_default().to_string(), request.next().unwrap_or_default().to_string());
    let (mut length, mut token, mut origin) = (0usize, None, false);
    for _ in 0..MAX_HEADERS {
        let mut header = String::new();
        if reader.read_line(&mut header).await? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let Some((key, value)) = header.split_once(':') else { continue };
        let value = value.trim();
        match key.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = value.parse().unwrap_or(usize::MAX),
            "authorization" => token = value.strip_prefix("Bearer ").map(str::to_owned),
            "origin" => origin = true,
            _ => {}
        }
    }
    // The CLIs send no Origin; a web page does, and has no business here.
    if origin {
        return respond(&mut write, "403 Forbidden", None).await;
    }
    let entry = token.and_then(|t| server.runs.lock().unwrap().get(&t).cloned());
    let Some(entry) = entry else { return respond(&mut write, "401 Unauthorized", None).await };
    if path.split('?').next() != Some("/mcp") {
        return respond(&mut write, "404 Not Found", None).await;
    }
    // Every reply comes in its POST's response, so there's no stream to GET or session to DELETE.
    if method != "POST" {
        return respond(&mut write, "405 Method Not Allowed", None).await;
    }
    if length > MAX_BODY {
        return respond(&mut write, "413 Payload Too Large", None).await;
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return respond(&mut write, "400 Bad Request", None).await;
    };
    // Notifications, and replies to requests this server never makes.
    let (Some(id), Some(rpc)) = (message.get("id").cloned(), message.get("method").and_then(Value::as_str)) else {
        return respond(&mut write, "202 Accepted", None).await;
    };
    let reply = match handle(server, &entry, rpc, message.get("params").unwrap_or(&Value::Null)).await {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, error)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": error } }),
    };
    respond(&mut write, "200 OK", Some(reply)).await
}

async fn handle(server: &Server, entry: &Entry, method: &str, params: &Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": sush_core::engines::BRIDGE_SERVER, "title": "Sush", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({
            "tools": entry.tools.iter().map(|t| json!({
                "name": t.spec.name,
                "description": t.spec.description,
                "inputSchema": t.spec.input_schema,
            })).collect::<Vec<_>>(),
        })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
            let Some(tool) = entry.tools.iter().find(|t| t.spec.name == name) else {
                return Err((-32602, format!("No tool named {name} in this session.")));
            };
            let n = server.calls.fetch_add(1, Ordering::Relaxed);
            let input = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let call = ToolCall { id: format!("bridge-{n}"), name: name.to_string(), input };
            let (text, error) = match entry.host.execute(&call, &tool.exec, entry.cancel.child_token()).await {
                Ok(Value::String(s)) => (s, false),
                Ok(other) => (other.to_string(), false),
                Err(e) => (e, true),
            };
            Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": error }))
        }
        _ => Err((-32601, format!("Sush doesn't handle {method}."))),
    }
}

async fn respond(write: &mut OwnedWriteHalf, status: &str, body: Option<Value>) -> std::io::Result<()> {
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    write.write_all(head.as_bytes()).await?;
    write.write_all(body.as_bytes()).await?;
    write.shutdown().await
}
