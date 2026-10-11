//! Connectors: MCP servers the UI starts on demand and calls tools on, either
//! local processes or remote URLs. Configs live in the UI; Rust keeps the
//! running clients, keyed by id. Sign-in for remote ones is in connector_auth.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use sush_core::mcp::{McpClient, McpError, McpTool, ServerSpec, ToolOutput};
use tauri::State;

use crate::connector_auth::{self, StoredTokens};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ConnectOutcome {
    #[serde(rename_all = "camelCase")]
    Ready { server_name: Option<String>, tools: Vec<McpTool> },
    /// A remote server wants a sign-in (or a fresh one) before it'll talk.
    /// `rejected` says why, when it turned down credentials we already had.
    NeedsAuth { rejected: Option<String> },
}

fn ready(client: &McpClient) -> ConnectOutcome {
    ConnectOutcome::Ready { server_name: client.server_name.clone(), tools: client.tools.clone() }
}

/// Start the connector (or reuse it if it's already running for the same
/// server) and return its tools. A changed server restarts it.
#[tauri::command]
pub async fn connector_connect(state: State<'_, AppState>, id: String, server: ServerSpec) -> AppResult<ConnectOutcome> {
    let mut running = state.connectors.lock().await;
    if let Some((spec, client)) = running.get(&id) {
        if *spec == server {
            return Ok(ready(client));
        }
    }
    running.remove(&id); // dropping the client stops the old process or session
    let client = match &server {
        ServerSpec::Stdio(command) => McpClient::spawn(command).await?,
        ServerSpec::Http(remote) => {
            let tokens = StoredTokens::new(&id, &remote.url, state.http.clone());
            match McpClient::connect_http(state.http.clone(), &remote.url, Some(tokens)).await {
                Err(McpError::Unauthorized(challenge)) => {
                    let rejected = connector_auth::has_credentials(&id, &remote.url)
                        .then(|| challenge.reason.unwrap_or_else(|| "the server turned down the saved sign-in".into()));
                    return Ok(ConnectOutcome::NeedsAuth { rejected });
                }
                result => result?,
            }
        }
    };
    let outcome = ready(&client);
    running.insert(id, (server, Arc::new(client)));
    Ok(outcome)
}

/// Call a tool on a running connector (agent runs do, see `runs.rs`).
pub(crate) async fn call(state: &AppState, id: String, tool: String, arguments: Value) -> AppResult<ToolOutput> {
    // Don't hold the map lock across a long tool call.
    let client = state
        .connectors
        .lock()
        .await
        .get(&id)
        .map(|(_, c)| c.clone())
        .ok_or_else(|| AppError::NotFound("connector isn't running; reconnect it in Customize → Connectors".into()))?;
    match client.call_tool(&tool, arguments).await {
        // Signed out or revoked mid-session: drop it so the next connect asks to sign in.
        Err(e @ McpError::Unauthorized(_)) => {
            state.connectors.lock().await.remove(&id);
            Err(e.into())
        }
        result => Ok(result?),
    }
}

#[tauri::command]
pub async fn connector_disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.connectors.lock().await.remove(&id);
    Ok(())
}

/// Disconnect and delete stored credentials: for sign-out and deleted connectors.
#[tauri::command]
pub async fn connector_forget(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.connectors.lock().await.remove(&id);
    connector_auth::forget(&id)
}
