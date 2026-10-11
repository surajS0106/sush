//! OAuth 2.1 sign-in for remote MCP servers, per the MCP authorization spec:
//! find the authorization server from the server's protected-resource metadata
//! (RFC 9728), register a client on the fly where allowed (RFC 7591), then
//! authorization code + PKCE with the `resource` parameter (RFC 8707).
//! Servers that can't register clients but offer the device flow (RFC 8628),
//! such as GitHub, sign in with a client ID Sush ships instead.
//!
//! Opening the browser and catching the redirect is the app's job; this module
//! only talks HTTP.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::header::ACCEPT;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use super::http::AuthChallenge;

#[derive(Debug, thiserror::Error)]
pub enum OAuthError {
    #[error("couldn't reach the sign-in server: {0}")]
    Request(#[from] reqwest::Error),
    #[error("sign-in failed: {0}")]
    Server(String),
    #[error("{0}")]
    Unsupported(String),
}

/// Where and how to sign in for one MCP server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthServer {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    /// For signing in with a code typed into the browser (RFC 8628).
    #[serde(default)]
    pub device_authorization_endpoint: Option<String>,
    /// Space-separated scopes to ask for, if the server named any.
    pub scope: Option<String>,
    /// The MCP server's canonical URI, sent as `resource` so tokens are bound to it.
    pub resource: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthClient {
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    /// `token_endpoint_auth_method` as registered; `client_secret_basic` sends the secret as Basic auth.
    #[serde(default)]
    pub auth_method: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix seconds.
    #[serde(default)]
    pub expires_at: Option<u64>,
}

impl TokenSet {
    /// Expired, or about to be within a minute.
    pub fn is_stale(&self) -> bool {
        self.expires_at.is_some_and(|at| at <= now() + 60)
    }
}

/// Ask the server unauthenticated, to read its `WWW-Authenticate` challenge.
pub async fn challenge(http: &reqwest::Client, mcp_url: &str) -> Result<AuthChallenge, OAuthError> {
    let init = json!({
        "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "sush", "version": env!("CARGO_PKG_VERSION") } },
    });
    let resp = http
        .post(mcp_url)
        .header(ACCEPT, "application/json, text/event-stream")
        .json(&init)
        .send()
        .await?;
    if resp.status() == StatusCode::UNAUTHORIZED {
        return Ok(AuthChallenge::from_response(&resp));
    }
    // HTTP+SSE servers may only challenge the event stream.
    let resp = http.get(mcp_url).header(ACCEPT, "text/event-stream").send().await?;
    Ok(if resp.status() == StatusCode::UNAUTHORIZED { AuthChallenge::from_response(&resp) } else { AuthChallenge::default() })
}

/// Find the authorization server for `mcp_url`.
pub async fn discover(http: &reqwest::Client, mcp_url: &str, challenge: &AuthChallenge) -> Result<AuthServer, OAuthError> {
    let mcp = Url::parse(mcp_url).map_err(|e| OAuthError::Unsupported(format!("invalid URL `{mcp_url}`: {e}")))?;

    let prm_urls = match &challenge.resource_metadata {
        Some(u) => vec![u.clone()],
        None => well_known(&mcp, "oauth-protected-resource"),
    };
    let mut prm = None;
    for u in prm_urls {
        if let Some(doc) = fetch_json(http, &u).await {
            prm = Some(doc);
            break;
        }
    }

    // Servers from before protected-resource metadata are their own authorization server.
    let issuer = prm
        .as_ref()
        .and_then(|p| p["authorization_servers"][0].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| mcp.origin().ascii_serialization());
    let issuer_url = Url::parse(&issuer).map_err(|e| OAuthError::Unsupported(format!("bad authorization server `{issuer}`: {e}")))?;

    let mut meta = None;
    for u in [well_known(&issuer_url, "oauth-authorization-server"), well_known(&issuer_url, "openid-configuration"), vec![
        format!("{}/.well-known/openid-configuration", issuer.trim_end_matches('/')),
    ]]
    .concat()
    {
        if let Some(doc) = fetch_json(http, &u).await.filter(|d| d["authorization_endpoint"].is_string()) {
            meta = Some(doc);
            break;
        }
    }
    let endpoint = |key: &str, default: &str| {
        meta.as_ref()
            .and_then(|m| m[key].as_str())
            .map(str::to_owned)
            .or_else(|| (meta.is_none() && !default.is_empty()).then(|| issuer_url.join(default).ok().map(String::from)).flatten())
    };
    // 2025-03-26 servers without metadata use these default paths.
    let (Some(authorization_endpoint), Some(token_endpoint)) = (endpoint("authorization_endpoint", "/authorize"), endpoint("token_endpoint", "/token"))
    else {
        return Err(OAuthError::Unsupported(format!("{issuer} doesn't publish OAuth endpoints")));
    };

    let scope = challenge.scope.clone().or_else(|| {
        let scopes: Vec<&str> = prm.as_ref()?["scopes_supported"].as_array()?.iter().filter_map(Value::as_str).collect();
        (!scopes.is_empty()).then(|| scopes.join(" "))
    });
    let resource = prm.as_ref().and_then(|p| p["resource"].as_str()).map(str::to_owned).unwrap_or_else(|| {
        let mut u = mcp.clone();
        u.set_fragment(None);
        u.to_string()
    });

    Ok(AuthServer {
        issuer,
        authorization_endpoint,
        token_endpoint,
        registration_endpoint: endpoint("registration_endpoint", "/register"),
        device_authorization_endpoint: endpoint("device_authorization_endpoint", ""),
        scope,
        resource,
    })
}

/// RFC 8414 / RFC 9728 well-known URLs for `url`: path-inserted first, then the root.
fn well_known(url: &Url, name: &str) -> Vec<String> {
    let origin = url.origin().ascii_serialization();
    let path = url.path().trim_end_matches('/');
    let mut urls = vec![];
    if !path.is_empty() {
        urls.push(format!("{origin}/.well-known/{name}{path}"));
    }
    urls.push(format!("{origin}/.well-known/{name}"));
    urls
}

async fn fetch_json(http: &reqwest::Client, url: &str) -> Option<Value> {
    let resp = http.get(url).header(ACCEPT, "application/json").send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Value>().await.ok().filter(Value::is_object)
}

/// Dynamic client registration as a public client with a loopback redirect.
pub async fn register(http: &reqwest::Client, server: &AuthServer, redirect_uri: &str) -> Result<OAuthClient, OAuthError> {
    let Some(endpoint) = &server.registration_endpoint else {
        return Err(OAuthError::Unsupported("this server doesn't support automatic sign-in".into()));
    };
    let mut body = json!({
        "client_name": "Sush",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    if let Some(scope) = &server.scope {
        body["scope"] = json!(scope);
    }
    let resp = http.post(endpoint).header(ACCEPT, "application/json").json(&body).send().await?;
    let status = resp.status();
    let doc: Value = resp.json().await.unwrap_or_default();
    match doc["client_id"].as_str() {
        Some(id) if status.is_success() => Ok(OAuthClient {
            client_id: id.to_string(),
            client_secret: doc["client_secret"].as_str().map(str::to_owned),
            auth_method: doc["token_endpoint_auth_method"].as_str().map(str::to_owned),
        }),
        _ => Err(OAuthError::Server(format!("couldn't register Sush with the server ({})", describe(status, &doc)))),
    }
}

/// PKCE (RFC 7636), S256.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn new() -> Self {
        let verifier = random_token();
        Self { challenge: challenge_for(&verifier), verifier }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// 32 random bytes, base64url: for PKCE verifiers and `state`.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS random number generator");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The URL to open in the browser.
pub fn authorize_url(server: &AuthServer, client: &OAuthClient, redirect_uri: &str, pkce: &Pkce, state: &str) -> Result<String, OAuthError> {
    let mut url = Url::parse(&server.authorization_endpoint)
        .map_err(|e| OAuthError::Unsupported(format!("bad authorization endpoint: {e}")))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", &client.client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("code_challenge", &pkce.challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            .append_pair("resource", &server.resource);
        if let Some(scope) = &server.scope {
            q.append_pair("scope", scope);
        }
    }
    Ok(url.into())
}

/// A device-flow sign-in in progress: the user enters `user_code` at
/// `verification_uri` while we poll for the token.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// The verification page with the code already filled in, where offered.
    pub verification_uri_complete: Option<String>,
    pub interval: Duration,
    pub expires_in: Duration,
}

impl DeviceAuthorization {
    fn from_response(doc: &Value) -> Option<Self> {
        let text = |key: &str| doc[key].as_str().map(str::to_owned);
        Some(Self {
            device_code: text("device_code")?,
            user_code: text("user_code")?,
            // Some servers predate the RFC and say `verification_url`.
            verification_uri: text("verification_uri").or_else(|| text("verification_url"))?,
            verification_uri_complete: text("verification_uri_complete"),
            interval: Duration::from_secs(doc["interval"].as_u64().unwrap_or(5)),
            expires_in: Duration::from_secs(doc["expires_in"].as_u64().unwrap_or(900)),
        })
    }
}

/// Start a device-flow sign-in. Unlike the code flow this sends no `resource`:
/// GitHub binds the token to it and its MCP server then rejects the token
/// ("Token is not authorized").
pub async fn device_authorization(http: &reqwest::Client, server: &AuthServer, client: &OAuthClient) -> Result<DeviceAuthorization, OAuthError> {
    let Some(endpoint) = &server.device_authorization_endpoint else {
        return Err(OAuthError::Unsupported("this server doesn't support signing in with a code".into()));
    };
    let mut form = vec![("client_id", client.client_id.as_str())];
    if let Some(scope) = &server.scope {
        form.push(("scope", scope));
    }
    let resp = http.post(endpoint).header(ACCEPT, "application/json").form(&form).send().await?;
    let status = resp.status();
    let doc: Value = resp.json().await.unwrap_or_default();
    match DeviceAuthorization::from_response(&doc) {
        Some(device) if status.is_success() => Ok(device),
        _ => Err(OAuthError::Server(describe(status, &doc))),
    }
}

/// Poll until the user approves (or denies) the device sign-in, or its code expires.
pub async fn poll_device_token(
    http: &reqwest::Client,
    server: &AuthServer,
    client: &OAuthClient,
    device: &DeviceAuthorization,
) -> Result<TokenSet, OAuthError> {
    let deadline = Instant::now() + device.expires_in;
    let mut interval = device.interval;
    let params = [
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ("device_code", device.device_code.as_str()),
    ];
    loop {
        tokio::time::sleep(interval).await;
        if Instant::now() >= deadline {
            return Err(OAuthError::Server("the code expired before sign-in finished".into()));
        }
        let (status, doc) = post_token(http, &server.token_endpoint, client, &params).await?;
        match doc["error"].as_str() {
            Some("authorization_pending") => {}
            // RFC 8628 3.5: back off by 5 seconds; GitHub also says by how much.
            Some("slow_down") => {
                interval = doc["interval"].as_u64().map(Duration::from_secs).unwrap_or(interval + Duration::from_secs(5));
            }
            _ => return tokens_from(status, &doc, None),
        }
    }
}

pub async fn exchange_code(
    http: &reqwest::Client,
    server: &AuthServer,
    client: &OAuthClient,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<TokenSet, OAuthError> {
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
        ("resource", &server.resource),
    ];
    token_request(http, &server.token_endpoint, client, &params, None).await
}

pub async fn refresh(
    http: &reqwest::Client,
    token_endpoint: &str,
    resource: &str,
    client: &OAuthClient,
    refresh_token: &str,
) -> Result<TokenSet, OAuthError> {
    let params = [("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("resource", resource)];
    token_request(http, token_endpoint, client, &params, Some(refresh_token)).await
}

async fn token_request(
    http: &reqwest::Client,
    endpoint: &str,
    client: &OAuthClient,
    params: &[(&str, &str)],
    previous_refresh: Option<&str>,
) -> Result<TokenSet, OAuthError> {
    let (status, doc) = post_token(http, endpoint, client, params).await?;
    tokens_from(status, &doc, previous_refresh)
}

async fn post_token(
    http: &reqwest::Client,
    endpoint: &str,
    client: &OAuthClient,
    params: &[(&str, &str)],
) -> Result<(StatusCode, Value), OAuthError> {
    let mut form: Vec<(&str, &str)> = params.to_vec();
    form.push(("client_id", &client.client_id));
    let mut req = http.post(endpoint).header(ACCEPT, "application/json");
    match &client.client_secret {
        Some(secret) if client.auth_method.as_deref() == Some("client_secret_basic") => {
            req = req.basic_auth(&client.client_id, Some(secret));
        }
        Some(secret) => form.push(("client_secret", secret)),
        None => {}
    }
    let resp = req.form(&form).send().await?;
    let status = resp.status();
    Ok((status, resp.json().await.unwrap_or_default()))
}

fn tokens_from(status: StatusCode, doc: &Value, previous_refresh: Option<&str>) -> Result<TokenSet, OAuthError> {
    let Some(access_token) = doc["access_token"].as_str().filter(|_| status.is_success()) else {
        return Err(OAuthError::Server(describe(status, doc)));
    };
    Ok(TokenSet {
        access_token: access_token.to_string(),
        // Servers that don't rotate refresh tokens leave it out of the response.
        refresh_token: doc["refresh_token"].as_str().or(previous_refresh).map(str::to_owned),
        expires_at: doc["expires_in"].as_u64().map(|s| now() + s),
    })
}

/// An OAuth error response as a sentence.
fn describe(status: StatusCode, doc: &Value) -> String {
    match (doc["error"].as_str(), doc["error_description"].as_str()) {
        (_, Some(desc)) => desc.to_string(),
        (Some(code), None) => code.to_string(),
        (None, None) => format!("HTTP {}", status.as_u16()),
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_example() {
        assert_eq!(challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let p = Pkce::new();
        assert_eq!(p.verifier.len(), 43);
        assert_ne!(p.verifier, Pkce::new().verifier);
    }

    #[test]
    fn well_known_urls_insert_the_path() {
        let u = Url::parse("https://access.example.com/mcp/").unwrap();
        assert_eq!(
            well_known(&u, "oauth-authorization-server"),
            ["https://access.example.com/.well-known/oauth-authorization-server/mcp", "https://access.example.com/.well-known/oauth-authorization-server"],
        );
        let root = Url::parse("https://example.com").unwrap();
        assert_eq!(well_known(&root, "openid-configuration"), ["https://example.com/.well-known/openid-configuration"]);
    }

    #[test]
    fn authorize_url_carries_pkce_resource_and_scope() {
        let server = AuthServer {
            issuer: "https://auth.example.com".into(),
            authorization_endpoint: "https://auth.example.com/authorize?tenant=1".into(),
            token_endpoint: "https://auth.example.com/token".into(),
            registration_endpoint: None,
            device_authorization_endpoint: None,
            scope: Some("read write".into()),
            resource: "https://mcp.example.com/mcp".into(),
        };
        let client = OAuthClient { client_id: "abc".into(), client_secret: None, auth_method: None };
        let pkce = Pkce::new();
        let url = Url::parse(&authorize_url(&server, &client, "http://localhost:5000/callback", &pkce, "st").unwrap()).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["tenant"], "1");
        assert_eq!(q["client_id"], "abc");
        assert_eq!(q["code_challenge"], pkce.challenge);
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["resource"], "https://mcp.example.com/mcp");
        assert_eq!(q["scope"], "read write");
        assert_eq!(q["redirect_uri"], "http://localhost:5000/callback");
    }

    #[test]
    fn reads_device_authorization_responses() {
        // GitHub's shape: no `verification_uri_complete`.
        let doc = json!({"device_code": "dc", "user_code": "ABCD-1234", "verification_uri": "https://github.com/login/device", "expires_in": 899, "interval": 5});
        let d = DeviceAuthorization::from_response(&doc).unwrap();
        assert_eq!((d.user_code.as_str(), d.verification_uri.as_str()), ("ABCD-1234", "https://github.com/login/device"));
        assert_eq!((d.interval, d.expires_in), (Duration::from_secs(5), Duration::from_secs(899)));
        assert_eq!(d.verification_uri_complete, None);

        let legacy = json!({"device_code": "dc", "user_code": "x", "verification_url": "https://example.com/device"});
        let d = DeviceAuthorization::from_response(&legacy).unwrap();
        assert_eq!(d.verification_uri, "https://example.com/device");
        assert_eq!(d.interval, Duration::from_secs(5));

        assert_eq!(DeviceAuthorization::from_response(&json!({"error": "unauthorized_client"})), None);
    }

    #[test]
    fn device_token_errors_read_as_sentences() {
        // GitHub answers the token poll with 200 and an `error` field.
        let denied = json!({"error": "access_denied", "error_description": "The authorization request was denied."});
        let err = tokens_from(StatusCode::OK, &denied, None).unwrap_err();
        assert_eq!(err.to_string(), "sign-in failed: The authorization request was denied.");
        let ok = tokens_from(StatusCode::OK, &json!({"access_token": "gho_x", "token_type": "bearer", "scope": "repo"}), None).unwrap();
        assert_eq!((ok.access_token.as_str(), ok.refresh_token, ok.expires_at), ("gho_x", None, None));
    }

    /// Hits live servers; run with `cargo test -p sush-core -- --ignored discovers`.
    #[tokio::test]
    #[ignore]
    async fn discovers_live_servers() {
        let http = reqwest::Client::new();
        for url in ["https://mcp.notion.com/mcp", "https://mcp.atlassian.com/v1/mcp", "https://mcp.stripe.com", "https://api.githubcopilot.com/mcp/"] {
            let ch = challenge(&http, url).await.unwrap();
            let server = discover(&http, url, &ch).await.unwrap();
            println!("{url}: {server:?}");
            assert!(server.authorization_endpoint.starts_with("https://"));
        }
    }
}
