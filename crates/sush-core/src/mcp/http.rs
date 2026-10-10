//! Remote MCP servers over HTTP.
//!
//! Streamable HTTP (2025-03-26 and later): every message is a POST to the
//! server URL, and a request's reply comes back as JSON or as an SSE stream
//! that can carry server requests first. A server that answers the first POST
//! with 400/404/405 gets the older HTTP+SSE transport (2024-11-05) instead: a
//! long-lived GET stream that names the URL to POST messages to.
//!
//! A 401 surfaces as `McpError::Unauthorized` with the server's challenge, so
//! the app can sign in (see `oauth`) and reconnect.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, WWW_AUTHENTICATE};
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use super::{Inbox, McpError};
use crate::sse::sse_events;

const SESSION_HEADER: &str = "mcp-session-id";
const VERSION_HEADER: &str = "mcp-protocol-version";
/// How long an HTTP+SSE server gets to name its message endpoint.
const ENDPOINT_TIMEOUT: Duration = Duration::from_secs(30);

/// A server reached over HTTP.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServer {
    pub url: String,
    /// A pre-registered OAuth client, for servers without dynamic registration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_client_id: Option<String>,
}

/// Supplies the bearer token for a remote server.
#[async_trait::async_trait]
pub trait TokenSource: Send + Sync {
    /// The token to send, if any. `refresh` asks for a new one because the
    /// server just rejected the last; `None` then means "sign in again".
    async fn token(&self, refresh: bool) -> Option<String>;
}

/// What a 401's `WWW-Authenticate: Bearer ...` header said.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthChallenge {
    /// Where the server's protected-resource metadata is (RFC 9728).
    pub resource_metadata: Option<String>,
    pub scope: Option<String>,
}

impl AuthChallenge {
    pub fn from_response(resp: &Response) -> Self {
        let header = resp.headers().get(WWW_AUTHENTICATE).and_then(|v| v.to_str().ok()).unwrap_or_default();
        Self { resource_metadata: auth_param(header, "resource_metadata"), scope: auth_param(header, "scope") }
    }
}

/// One parameter of a `WWW-Authenticate` header, quoted or bare.
fn auth_param(header: &str, name: &str) -> Option<String> {
    let mut rest = header;
    while let Some(pos) = rest.find(name) {
        let before = rest[..pos].chars().next_back();
        let after = &rest[pos + name.len()..];
        rest = after;
        if before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let Some(value) = after.trim_start().strip_prefix('=') else { continue };
        let value = value.trim_start();
        return Some(match value.strip_prefix('"') {
            Some(quoted) => {
                let mut out = String::new();
                let mut chars = quoted.chars();
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => out.extend(chars.next()),
                        '"' => break,
                        c => out.push(c),
                    }
                }
                out
            }
            None => value.split([',', ' ']).next().unwrap_or_default().to_string(),
        });
    }
    None
}

#[derive(Default)]
struct Session {
    id: Option<String>,
    protocol_version: Option<String>,
    /// Set once we've fallen back to HTTP+SSE: where messages are POSTed.
    legacy_endpoint: Option<Url>,
}

pub(crate) struct HttpTransport {
    http: reqwest::Client,
    url: Url,
    auth: Option<Arc<dyn TokenSource>>,
    session: Mutex<Session>,
    /// The HTTP+SSE event stream, stopped with the transport.
    legacy_stream: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl HttpTransport {
    pub(crate) fn new(http: reqwest::Client, url: &str, auth: Option<Arc<dyn TokenSource>>) -> Result<Self, McpError> {
        let url = Url::parse(url.trim()).map_err(|e| McpError::Protocol(format!("invalid URL `{url}`: {e}")))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(McpError::Protocol(format!("`{url}` isn't an http(s) URL")));
        }
        Ok(Self { http, url, auth, session: Mutex::default(), legacy_stream: Mutex::default() })
    }

    pub(crate) fn set_protocol_version(&self, version: &str) {
        self.session.lock().unwrap().protocol_version = Some(version.to_string());
    }

    pub(crate) async fn send(&self, msg: &Value, inbox: Option<&Inbox>) -> Result<(), McpError> {
        let legacy = self.session.lock().unwrap().legacy_endpoint.clone();
        if let Some(endpoint) = legacy {
            return self.post_legacy(endpoint, msg).await;
        }

        let resp = self.authorized(|token| self.with_session(self.http.post(self.url.clone()), token).json(msg)).await?;
        let status = resp.status();
        let initializing = msg["method"] == "initialize";
        if initializing && matches!(status.as_u16(), 400 | 404 | 405) {
            let Some(inbox) = inbox else { return Err(http_error(resp).await) };
            let endpoint = self.open_legacy(inbox).await?;
            return self.post_legacy(endpoint, msg).await;
        }
        if status == StatusCode::NOT_FOUND && self.session.lock().unwrap().id.is_some() {
            return Err(McpError::Closed("the server ended the session; reconnect".into()));
        }
        if !status.is_success() {
            return Err(http_error(resp).await);
        }
        if initializing {
            let id = resp.headers().get(SESSION_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
            self.session.lock().unwrap().id = id;
        }

        // Notifications and our replies get 202 with no body.
        let Some(inbox) = inbox else { return Ok(()) };
        let request_id = msg.get("method").and(msg["id"].as_u64());
        let content_type = resp.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default();
        if content_type.starts_with("text/event-stream") {
            let inbox = inbox.clone();
            tokio::spawn(async move {
                let events = sse_events(resp.bytes_stream());
                futures::pin_mut!(events);
                while let Some(Ok(ev)) = events.next().await {
                    if let Ok(msg) = serde_json::from_str::<Value>(&ev.data) {
                        inbox.deliver(msg);
                    }
                }
                if let Some(id) = request_id {
                    inbox.fail(id, McpError::Closed("the server closed the stream before replying".into()));
                }
            });
        } else if content_type.starts_with("application/json") {
            let body = resp.bytes().await?;
            if !body.is_empty() {
                inbox.deliver(serde_json::from_slice(&body)?);
            }
            if let Some(id) = request_id {
                inbox.fail(id, McpError::Protocol("the reply didn't answer the request".into()));
            }
        }
        Ok(())
    }

    /// Send a request with the current token; on 401, ask for a fresh one and
    /// try once more before giving up with the server's challenge.
    async fn authorized(&self, build: impl Fn(Option<&str>) -> RequestBuilder) -> Result<Response, McpError> {
        let mut token = match &self.auth {
            Some(auth) => auth.token(false).await,
            None => None,
        };
        let mut retried = false;
        loop {
            let resp = build(token.as_deref()).send().await?;
            if resp.status() != StatusCode::UNAUTHORIZED {
                return Ok(resp);
            }
            let challenge = AuthChallenge::from_response(&resp);
            let Some(auth) = self.auth.as_ref().filter(|_| !retried) else {
                return Err(McpError::Unauthorized(challenge));
            };
            retried = true;
            token = auth.token(true).await;
            if token.is_none() {
                return Err(McpError::Unauthorized(challenge));
            }
        }
    }

    fn with_session(&self, req: RequestBuilder, token: Option<&str>) -> RequestBuilder {
        let session = self.session.lock().unwrap();
        let mut req = req.header(ACCEPT, "application/json, text/event-stream");
        if let Some(id) = &session.id {
            req = req.header(SESSION_HEADER, id);
        }
        if let Some(v) = &session.protocol_version {
            req = req.header(VERSION_HEADER, v);
        }
        bearer(req, token)
    }

    /// HTTP+SSE: open the event stream and wait for it to name the endpoint.
    async fn open_legacy(&self, inbox: &Inbox) -> Result<Url, McpError> {
        let resp = self
            .authorized(|token| bearer(self.http.get(self.url.clone()).header(ACCEPT, "text/event-stream"), token))
            .await?;
        if !resp.status().is_success() {
            return Err(http_error(resp).await);
        }
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let inbox = inbox.clone();
        let task = tokio::spawn(async move {
            let mut tx = Some(tx);
            let events = sse_events(resp.bytes_stream());
            futures::pin_mut!(events);
            while let Some(Ok(ev)) = events.next().await {
                if ev.event.as_deref() == Some("endpoint") {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(ev.data.trim().to_string());
                    }
                } else if let Ok(msg) = serde_json::from_str::<Value>(&ev.data) {
                    inbox.deliver(msg);
                }
            }
            inbox.fail_all(|| McpError::Closed("the server closed its event stream".into()));
        });
        *self.legacy_stream.lock().unwrap() = Some(task);

        let endpoint = match tokio::time::timeout(ENDPOINT_TIMEOUT, rx).await {
            Ok(Ok(endpoint)) => endpoint,
            _ => return Err(McpError::Protocol("the server didn't say where to send messages".into())),
        };
        let endpoint = self
            .url
            .join(&endpoint)
            .map_err(|e| McpError::Protocol(format!("bad message endpoint `{endpoint}`: {e}")))?;
        // Don't let a server redirect our token somewhere else.
        if endpoint.origin() != self.url.origin() {
            return Err(McpError::Protocol(format!("message endpoint `{endpoint}` is on another site")));
        }
        self.session.lock().unwrap().legacy_endpoint = Some(endpoint.clone());
        Ok(endpoint)
    }

    /// HTTP+SSE: replies arrive on the event stream, so the response body is ignored.
    async fn post_legacy(&self, endpoint: Url, msg: &Value) -> Result<(), McpError> {
        let resp = self.authorized(|token| bearer(self.http.post(endpoint.clone()), token).json(msg)).await?;
        if !resp.status().is_success() {
            return Err(http_error(resp).await);
        }
        Ok(())
    }
}

impl Drop for HttpTransport {
    fn drop(&mut self) {
        if let Some(task) = self.legacy_stream.lock().unwrap().take() {
            task.abort();
        }
        // Tell the server we're done with the session, best effort.
        let Some(id) = self.session.lock().unwrap().id.take() else { return };
        let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
        let (http, url, auth) = (self.http.clone(), self.url.clone(), self.auth.clone());
        rt.spawn(async move {
            let token = match &auth {
                Some(a) => a.token(false).await,
                None => None,
            };
            let _ = bearer(http.delete(url).header(SESSION_HEADER, id), token.as_deref()).send().await;
        });
    }
}

fn bearer(req: RequestBuilder, token: Option<&str>) -> RequestBuilder {
    match token {
        Some(t) => req.header(AUTHORIZATION, format!("Bearer {t}")),
        None => req,
    }
}

async fn http_error(resp: Response) -> McpError {
    let status = resp.status().as_u16();
    let mut body = resp.text().await.unwrap_or_default();
    if body.len() > 300 {
        let cut = (300..body.len()).find(|&i| body.is_char_boundary(i)).unwrap_or(body.len());
        body.truncate(cut);
    }
    McpError::Http { status, body }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::McpClient;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn parses_bearer_challenges() {
        let h = r#"Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="read write""#;
        assert_eq!(auth_param(h, "resource_metadata").as_deref(), Some("https://mcp.example.com/.well-known/oauth-protected-resource"));
        assert_eq!(auth_param(h, "scope").as_deref(), Some("read write"));
        assert_eq!(auth_param(h, "realm"), None);
        assert_eq!(auth_param("Bearer realm=x, scope=files", "scope").as_deref(), Some("files"));
        // `scope` inside another parameter's name doesn't count.
        assert_eq!(auth_param(r#"Bearer xscope="no""#, "scope"), None);
    }

    struct Fixed(&'static str);

    #[async_trait::async_trait]
    impl TokenSource for Fixed {
        async fn token(&self, refresh: bool) -> Option<String> {
            (!refresh).then(|| self.0.to_string())
        }
    }

    /// A one-request-per-connection Streamable HTTP server: SSE for
    /// `initialize` (with a session), JSON for the rest, 401 without the token.
    async fn serve(listener: TcpListener) {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let len = head
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        if body.len() >= len {
                            break (head.to_ascii_lowercase(), body.to_string());
                        }
                    }
                };
                let reply = |status: &str, ctype: &str, extra: &str, body: &str| {
                    format!("HTTP/1.1 {status}\r\ncontent-type: {ctype}\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
                };
                let out = if !head.contains("authorization: bearer secret") {
                    reply("401 Unauthorized", "text/plain", "www-authenticate: Bearer resource_metadata=\"http://x/prm\"\r\n", "")
                } else {
                    let msg: Value = serde_json::from_str(&body).unwrap();
                    match msg["method"].as_str() {
                        Some("initialize") => {
                            let res = json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "protocolVersion": "2025-06-18", "serverInfo": { "name": "remote" } } });
                            reply("200 OK", "text/event-stream", "mcp-session-id: s1\r\n", &format!("event: message\ndata: {res}\n\n"))
                        }
                        _ if !head.contains("mcp-session-id: s1") => reply("400 Bad Request", "text/plain", "", "no session"),
                        Some("tools/list") => {
                            let res = json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "tools": [{ "name": "search" }] } });
                            reply("200 OK", "application/json", "", &res.to_string())
                        }
                        Some("tools/call") => {
                            let res = json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "content": [{ "type": "text", "text": "found" }] } });
                            reply("200 OK", "application/json", "", &res.to_string())
                        }
                        _ => reply("202 Accepted", "text/plain", "", ""),
                    }
                };
                sock.write_all(out.as_bytes()).await.unwrap();
            });
        }
    }

    #[tokio::test]
    async fn streamable_http_with_sessions_and_auth() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        tokio::spawn(serve(listener));
        let http = reqwest::Client::new();

        let err = McpClient::connect_http(http.clone(), &url, None).await.err().unwrap();
        let McpError::Unauthorized(challenge) = err else { panic!("{err}") };
        assert_eq!(challenge.resource_metadata.as_deref(), Some("http://x/prm"));

        let client = McpClient::connect_http(http, &url, Some(Arc::new(Fixed("secret")))).await.unwrap();
        assert_eq!(client.server_name.as_deref(), Some("remote"));
        assert_eq!(client.tools[0].name, "search");
        let out = client.call_tool("search", json!({})).await.unwrap();
        assert_eq!(out.text, "found");
    }
    /// Hits live servers; run with `cargo test -p sush-core -- --ignored live_`.
    #[tokio::test]
    #[ignore]
    async fn live_public_servers() {
        let http = reqwest::Client::new();
        for url in ["https://mcp.deepwiki.com/mcp", "https://learn.microsoft.com/api/mcp", "https://huggingface.co/mcp", "https://knowledge-mcp.global.api.aws"] {
            let client = McpClient::connect_http(http.clone(), url, None).await.unwrap_or_else(|e| panic!("{url}: {e}"));
            println!("{url}: {:?} {} tools", client.server_name, client.tools.len());
            assert!(!client.tools.is_empty());
        }
        let err = McpClient::connect_http(http, "https://mcp.notion.com/mcp", None).await.err().unwrap();
        assert!(matches!(err, McpError::Unauthorized(_)), "{err}");
    }
}
