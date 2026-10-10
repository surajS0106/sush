//! Commands invoked from the UI via `invoke()`.

use futures::StreamExt;
use serde::Serialize;
use sush_core::provider::presets;
use sush_core::{build_provider, AuthKind, ChatEvent, ChatRequest, ModelInfo, Provider, ProviderConfig};
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    #[serde(flatten)]
    config: ProviderConfig,
    has_key: bool,
}

/// What the UI receives on a chat stream's channel. `End` is always the last
/// frame, so the UI never has to race the command's own promise against
/// in-flight channel messages.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum StreamFrame {
    Event { event: ChatEvent },
    End,
}

fn view(config: ProviderConfig) -> AppResult<ProviderView> {
    let has_key = matches!(config.auth, AuthKind::ApiKey { .. }) && secrets::get(&config.id)?.is_some();
    Ok(ProviderView { config, has_key })
}

fn provider_for(state: &AppState, id: &str) -> AppResult<std::sync::Arc<dyn Provider>> {
    let cfg = state.provider(id).ok_or_else(|| AppError::NotFound(format!("provider {id} not found")))?;
    let secret = match cfg.auth {
        AuthKind::ApiKey { .. } => secrets::get(&cfg.id)?,
        AuthKind::None => None,
    };
    Ok(build_provider(&cfg, secret, state.http.clone())?)
}

#[tauri::command]
pub fn list_presets() -> Vec<ProviderConfig> {
    presets()
}

#[tauri::command]
pub fn list_providers(state: State<'_, AppState>) -> AppResult<Vec<ProviderView>> {
    let providers = state.providers.read().unwrap().clone();
    providers.into_iter().map(view).collect()
}

/// Create or update a provider. `api_key` is only written when non-empty, so
/// editing other fields doesn't require re-entering the key.
#[tauri::command]
pub fn save_provider(
    state: State<'_, AppState>,
    config: ProviderConfig,
    api_key: Option<String>,
) -> AppResult<ProviderView> {
    if let Some(key) = api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        secrets::set(&config.id, key)?;
    }
    {
        let mut providers = state.providers.write().unwrap();
        match providers.iter_mut().find(|p| p.id == config.id) {
            Some(existing) => *existing = config.clone(),
            None => providers.push(config.clone()),
        }
    }
    state.persist()?;
    view(config)
}

#[tauri::command]
pub fn delete_provider(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.providers.write().unwrap().retain(|p| p.id != id);
    state.persist()?;
    secrets::delete(&id)
}

/// Pinned models first, then whatever the endpoint reports. If listing fails
/// but the user pinned models (typical for Azure deployments), those are enough.
#[tauri::command]
pub async fn list_models(state: State<'_, AppState>, provider_id: String) -> AppResult<Vec<ModelInfo>> {
    let pinned: Vec<ModelInfo> = state
        .provider(&provider_id)
        .map(|p| p.models)
        .unwrap_or_default()
        .into_iter()
        .map(|id| ModelInfo { id, display_name: None })
        .collect();
    let fetched = match provider_for(&state, &provider_id)?.list_models().await {
        Ok(models) => models,
        Err(_) if !pinned.is_empty() => vec![],
        Err(e) => return Err(e.into()),
    };
    let mut models = pinned;
    for m in fetched {
        if !models.iter().any(|p| p.id == m.id) {
            models.push(m);
        }
    }
    Ok(models)
}

/// Stream a completion to `on_event`. Errors arrive as a `ChatEvent::Error`
/// frame; every stream, including cancelled ones, closes with `End`.
#[tauri::command]
pub async fn chat_stream(
    state: State<'_, AppState>,
    stream_id: String,
    provider_id: String,
    request: ChatRequest,
    on_event: Channel<StreamFrame>,
) -> AppResult<()> {
    let token = CancellationToken::new();
    state.streams.lock().unwrap().insert(stream_id.clone(), token.clone());
    let result = run_stream(&state, &provider_id, request, &on_event, &token).await;
    state.streams.lock().unwrap().remove(&stream_id);
    if let Err(e) = result {
        let _ = on_event.send(StreamFrame::Event { event: ChatEvent::Error { message: e.to_string() } });
    }
    let _ = on_event.send(StreamFrame::End);
    Ok(())
}

async fn run_stream(
    state: &AppState,
    provider_id: &str,
    request: ChatRequest,
    on_event: &Channel<StreamFrame>,
    token: &CancellationToken,
) -> AppResult<()> {
    let provider = provider_for(state, provider_id)?;
    let mut stream = tokio::select! {
        _ = token.cancelled() => return Ok(()),
        s = provider.stream_chat(request) => s?,
    };
    loop {
        // Dropping `stream` on cancel aborts the HTTP request.
        let next = tokio::select! {
            _ = token.cancelled() => return Ok(()),
            next = stream.next() => next,
        };
        match next {
            Some(Ok(ev)) => {
                if on_event.send(StreamFrame::Event { event: ev }).is_err() {
                    return Ok(()); // webview went away
                }
            }
            Some(Err(e)) => return Err(e.into()),
            None => return Ok(()),
        }
    }
}

#[tauri::command]
pub fn cancel_stream(state: State<'_, AppState>, stream_id: String) {
    if let Some(token) = state.streams.lock().unwrap().remove(&stream_id) {
        token.cancel();
    }
}
