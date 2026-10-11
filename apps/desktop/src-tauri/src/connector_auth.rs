//! Credentials for remote connectors: a pasted access token, or OAuth tokens
//! from signing in through the browser. Kept in the OS credential store and
//! bound to the server URL they were issued for, so editing a connector's URL
//! never sends them somewhere else.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sush_core::mcp::oauth::{self, AuthServer, OAuthClient, Pkce, TokenSet};
use sush_core::mcp::TokenSource;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::state::AppState;

/// Redirect port for user-supplied OAuth clients, which must register it up front.
pub const CUSTOM_CLIENT_PORT: u16 = 33418;
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

/// Sush's GitHub OAuth app (Device Flow enabled). GitHub can't register
/// clients on the fly, so its connector signs in with this one. Client IDs
/// are public, and the device flow needs no secret.
const GITHUB_CLIENT_ID: &str = "Ov23liS0sBzUxPYaM3F2";

/// Client IDs Sush ships, by authorization server issuer.
fn builtin_client(issuer: &str) -> Option<&'static str> {
    match issuer.trim_end_matches('/') {
        "https://github.com/login/oauth" => Some(GITHUB_CLIENT_ID),
        _ => None,
    }
    .filter(|id| !id.is_empty())
}

/// The code to type into the browser during a device-flow sign-in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    user_code: String,
    verification_uri: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    url: String,
    /// An access token the user pasted; sent as-is and never refreshed.
    #[serde(default)]
    token: Option<String>,
    /// Secret for a user-supplied OAuth client.
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    oauth: Option<OAuthSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuthSession {
    issuer: String,
    token_endpoint: String,
    resource: String,
    client: OAuthClient,
    redirect_uri: String,
    tokens: TokenSet,
}

fn load(id: &str, url: &str) -> Credentials {
    secrets::connector_get(id)
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str::<Credentials>(&json).ok())
        .filter(|c| c.url == url)
        .unwrap_or_else(|| Credentials { url: url.to_string(), ..Default::default() })
}

fn save(id: &str, creds: &Credentials) -> AppResult<()> {
    secrets::connector_set(id, &serde_json::to_string(creds)?)
}

/// Whether there's a pasted token or a sign-in saved for this connector.
pub fn has_credentials(id: &str, url: &str) -> bool {
    let creds = load(id, url);
    creds.token.is_some() || creds.oauth.is_some()
}

pub fn forget(id: &str) -> AppResult<()> {
    secrets::connector_delete(id)
}

/// Bearer tokens for one connector, refreshed when they expire.
pub struct StoredTokens {
    id: String,
    url: String,
    http: reqwest::Client,
    /// One refresh at a time; refresh tokens are often single-use.
    lock: tokio::sync::Mutex<()>,
}

impl StoredTokens {
    pub fn new(id: &str, url: &str, http: reqwest::Client) -> Arc<Self> {
        Arc::new(Self { id: id.to_string(), url: url.to_string(), http, lock: Default::default() })
    }
}

#[async_trait::async_trait]
impl TokenSource for StoredTokens {
    async fn token(&self, refresh: bool) -> Option<String> {
        let _guard = self.lock.lock().await;
        let mut creds = load(&self.id, &self.url);
        if let Some(token) = creds.token {
            return (!refresh).then_some(token);
        }
        let session = creds.oauth.as_mut()?;
        if !refresh && !session.tokens.is_stale() {
            return Some(session.tokens.access_token.clone());
        }
        let refresh_token = session.tokens.refresh_token.clone()?;
        let tokens = oauth::refresh(&self.http, &session.token_endpoint, &session.resource, &session.client, &refresh_token)
            .await
            .ok()?;
        session.tokens = tokens;
        let access = session.tokens.access_token.clone();
        save(&self.id, &creds).ok()?;
        Some(access)
    }
}

/// Store (or with an empty string, clear) a pasted access token and a custom
/// OAuth client secret. `None` leaves a value as it is.
#[tauri::command]
pub fn connector_save_secrets(id: String, url: String, token: Option<String>, client_secret: Option<String>) -> AppResult<()> {
    let mut creds = load(&id, &url);
    let blank_to_none = |s: String| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(t) = token {
        creds.token = blank_to_none(t);
    }
    if let Some(s) = client_secret {
        creds.client_secret = blank_to_none(s);
    }
    save(&id, &creds)
}

/// Sign in through the browser and store the tokens. Resolves once the
/// browser comes back; the UI reconnects afterwards. For servers that sign in
/// with a code instead of a redirect, the code is sent on `on_code` first.
#[tauri::command]
pub async fn connector_authorize(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    url: String,
    client_id: Option<String>,
    on_code: Channel<DeviceCode>,
) -> AppResult<()> {
    let cancel = CancellationToken::new();
    if let Some(previous) = state.authorizing.lock().unwrap().insert(id.clone(), cancel.clone()) {
        previous.cancel();
    }
    let result = tokio::select! {
        r = authorize(&app, &state.http, &id, &url, client_id, &on_code) => r,
        _ = cancel.cancelled() => Err(AppError::Invalid("Sign-in cancelled".into())),
        _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => Err(AppError::Invalid("Sign-in timed out. Try again.".into())),
    };
    // A newer attempt replaced ours (and cancelled it); leave its token alone.
    if !cancel.is_cancelled() {
        state.authorizing.lock().unwrap().remove(&id);
    }
    result
}

#[tauri::command]
pub fn connector_cancel_authorize(state: State<'_, AppState>, id: String) {
    if let Some(cancel) = state.authorizing.lock().unwrap().remove(&id) {
        cancel.cancel();
    }
}

async fn authorize(
    app: &AppHandle,
    http: &reqwest::Client,
    id: &str,
    url: &str,
    client_id: Option<String>,
    on_code: &Channel<DeviceCode>,
) -> AppResult<()> {
    let challenge = oauth::challenge(http, url).await?;
    let server = oauth::discover(http, url, &challenge).await?;
    let mut creds = load(id, url);
    // A pasted token wins over a sign-in, so signing in replaces it.
    creds.token = None;
    let client_id = client_id.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());

    if client_id.is_none() && server.registration_endpoint.is_none() && server.device_authorization_endpoint.is_some() {
        if let Some(builtin) = builtin_client(&server.issuer) {
            let client = OAuthClient { client_id: builtin.to_string(), client_secret: None, auth_method: None };
            let tokens = authorize_device(app, http, &server, &client, on_code).await?;
            creds.oauth = Some(OAuthSession {
                issuer: server.issuer,
                token_endpoint: server.token_endpoint,
                resource: server.resource,
                client,
                redirect_uri: String::new(),
                tokens,
            });
            return save(id, &creds);
        }
    }

    let previous = creds.oauth.take().filter(|s| s.issuer == server.issuer);
    let (client, callback, redirect_uri) = match client_id {
        Some(client_id) => {
            let callback = Callback::bind(CUSTOM_CLIENT_PORT).await.map_err(|e| {
                AppError::Invalid(format!("Port {CUSTOM_CLIENT_PORT} is busy, so the sign-in redirect can't be received ({e})"))
            })?;
            let client = OAuthClient { client_id, client_secret: creds.client_secret.clone(), auth_method: None };
            (client, callback, redirect_uri(CUSTOM_CLIENT_PORT))
        }
        None => match reuse_registration(previous.as_ref()).await {
            Some(reused) => reused,
            None => register(http, &server).await?,
        },
    };

    let pkce = Pkce::new();
    let state = oauth::random_token();
    let authorize_url = oauth::authorize_url(&server, &client, &redirect_uri, &pkce, &state)?;
    app.opener()
        .open_url(authorize_url, None::<&str>)
        .map_err(|e| AppError::Invalid(format!("couldn't open the browser: {e}")))?;

    let code = callback.wait(&state).await?;
    let tokens = oauth::exchange_code(http, &server, &client, &code, &redirect_uri, &pkce.verifier).await?;
    creds.oauth = Some(OAuthSession {
        issuer: server.issuer,
        token_endpoint: server.token_endpoint,
        resource: server.resource,
        client,
        redirect_uri,
        tokens,
    });
    save(id, &creds)
}

/// Show the user a code, open the page to enter it, and wait for approval.
async fn authorize_device(
    app: &AppHandle,
    http: &reqwest::Client,
    server: &AuthServer,
    client: &OAuthClient,
    on_code: &Channel<DeviceCode>,
) -> AppResult<TokenSet> {
    let device = oauth::device_authorization(http, server, client).await?;
    on_code
        .send(DeviceCode { user_code: device.user_code.clone(), verification_uri: device.verification_uri.clone() })
        .map_err(|e| AppError::Invalid(format!("couldn't show the sign-in code: {e}")))?;
    let page = device.verification_uri_complete.clone().unwrap_or_else(|| device.verification_uri.clone());
    app.opener()
        .open_url(page, None::<&str>)
        .map_err(|e| AppError::Invalid(format!("couldn't open the browser: {e}")))?;
    Ok(oauth::poll_device_token(http, server, client, &device).await?)
}

fn redirect_uri(port: u16) -> String {
    format!("http://localhost:{port}/callback")
}

/// The client Sush registered last time, if its redirect port is free again.
async fn reuse_registration(previous: Option<&OAuthSession>) -> Option<(OAuthClient, Callback, String)> {
    let previous = previous?;
    let port = url::Url::parse(&previous.redirect_uri).ok()?.port()?;
    let callback = Callback::bind(port).await.ok()?;
    Some((previous.client.clone(), callback, previous.redirect_uri.clone()))
}

async fn register(http: &reqwest::Client, server: &AuthServer) -> AppResult<(OAuthClient, Callback, String)> {
    if server.registration_endpoint.is_none() {
        return Err(AppError::Invalid(
            "This server doesn't support automatic sign-in. Add an OAuth client ID or an access token in the connector's settings.".into(),
        ));
    }
    let callback = Callback::bind(0).await?;
    let redirect = redirect_uri(callback.port);
    let client = oauth::register(http, server, &redirect).await?;
    Ok((client, callback, redirect))
}

/// A one-shot loopback HTTP server that catches the OAuth redirect. Listens on
/// IPv4 and, where it can, IPv6, since browsers resolve `localhost` either way.
struct Callback {
    v4: TcpListener,
    v6: Option<TcpListener>,
    port: u16,
}

impl Callback {
    async fn bind(port: u16) -> std::io::Result<Self> {
        let v4 = TcpListener::bind(("127.0.0.1", port)).await?;
        let port = v4.local_addr()?.port();
        let v6 = TcpListener::bind(("::1", port)).await.ok();
        Ok(Self { v4, v6, port })
    }

    async fn accept(&self) -> std::io::Result<TcpStream> {
        let (stream, _) = match &self.v6 {
            Some(v6) => tokio::select! { r = self.v4.accept() => r, r = v6.accept() => r },
            None => self.v4.accept().await,
        }?;
        Ok(stream)
    }

    /// Wait for `/callback?code=…&state=…`; other requests (favicons, a
    /// mismatched state) are answered and ignored.
    async fn wait(&self, state: &str) -> AppResult<String> {
        loop {
            let mut stream = self.accept().await?;
            let Some(target) = read_request_target(&mut stream).await else { continue };
            let Ok(url) = url::Url::parse(&format!("http://localhost{target}")) else { continue };
            if url.path() != "/callback" {
                respond(&mut stream, "404 Not Found", "").await;
                continue;
            }
            let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
            if param("state").as_deref() != Some(state) {
                respond(&mut stream, "400 Bad Request", &page("This sign-in link has expired", "Start again from Sush.")).await;
                continue;
            }
            if let Some(error) = param("error") {
                let detail = param("error_description").unwrap_or(error);
                respond(&mut stream, "200 OK", &page("Sign-in didn’t finish", &detail)).await;
                return Err(AppError::Invalid(format!("Sign-in failed: {detail}")));
            }
            let Some(code) = param("code") else { continue };
            respond(&mut stream, "200 OK", &page("You’re signed in", "You can close this tab and go back to Sush.")).await;
            return Ok(code);
        }
    }
}

/// The path and query of an HTTP request line.
async fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 * 1024 {
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk)).await.ok()?.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf);
    let mut parts = head.lines().next()?.split_whitespace();
    (parts.next()? == "GET").then_some(())?;
    parts.next().map(str::to_owned)
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn page(title: &str, detail: &str) -> String {
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        r#"<!doctype html><meta charset="utf-8"><title>Sush</title>
<style>body{{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#18181b;background:#fafafa}}
@media(prefers-color-scheme:dark){{body{{color:#fafafa;background:#18181b}}}}main{{text-align:center;max-width:28rem;padding:1rem}}h1{{font-size:20px;margin:0 0 .5rem}}p{{opacity:.7;margin:0}}</style>
<main><h1>{}</h1><p>{}</p></main>"#,
        escape(title),
        escape(detail)
    )
}
