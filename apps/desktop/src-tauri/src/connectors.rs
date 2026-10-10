//! Connectors: MCP servers the UI starts on demand and calls tools on.
//! Configs live in the UI; Rust keeps the running processes, keyed by id.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use sush_core::mcp::{McpClient, McpTool, ServerCommand, ToolOutput};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorInfo {
    server_name: Option<String>,
    tools: Vec<McpTool>,
}

/// Start the connector (or reuse it if it's already running with the same
/// command) and return its tools. A changed command restarts it.
#[tauri::command]
pub async fn connector_connect(state: State<'_, AppState>, id: String, command: ServerCommand) -> AppResult<ConnectorInfo> {
    let mut running = state.connectors.lock().await;
    if let Some((cmd, client)) = running.get(&id) {
        if *cmd == command {
            return Ok(ConnectorInfo { server_name: client.server_name.clone(), tools: client.tools.clone() });
        }
    }
    running.remove(&id); // dropping the client stops the old process
    let client = McpClient::spawn(&command).await?;
    let info = ConnectorInfo { server_name: client.server_name.clone(), tools: client.tools.clone() };
    running.insert(id, (command, Arc::new(client)));
    Ok(info)
}

#[tauri::command]
pub async fn connector_call(state: State<'_, AppState>, id: String, tool: String, arguments: Value) -> AppResult<ToolOutput> {
    // Don't hold the map lock across a long tool call.
    let client = state
        .connectors
        .lock()
        .await
        .get(&id)
        .map(|(_, c)| c.clone())
        .ok_or_else(|| AppError::NotFound("connector isn't running; reconnect it in Customize → Connectors".into()))?;
    Ok(client.call_tool(&tool, arguments).await?)
}

#[tauri::command]
pub async fn connector_disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.connectors.lock().await.remove(&id);
    Ok(())
}
