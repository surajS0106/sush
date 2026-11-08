//! The `web_search` and `web_fetch` tools for models without search of their own
//! (`sush_core::web`), and the Ollama key behind them (Settings → Search). The key is
//! the user's own from Settings → Search, or else the key of a provider pointed at
//! Ollama's cloud, which is the same kind of key. It stays in the keyring; the
//! webview only learns where it comes from.

use serde::Serialize;
use sush_core::web::{check_key, fetch, search, SearchResult, WebPage};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WebKeySource {
    /// Pasted in Settings → Search.
    Own,
    /// An Ollama Cloud provider's key.
    Provider,
    None,
}

/// A provider on ollama.com whose key can search too.
fn provider_key(state: &AppState) -> AppResult<Option<String>> {
    let ids: Vec<String> = state
        .providers
        .read()
        .unwrap()
        .iter()
        .filter(|p| reqwest::Url::parse(&p.base_url).ok().and_then(|u| u.host_str().map(|h| h == "ollama.com" || h.ends_with(".ollama.com"))).unwrap_or(false))
        .map(|p| p.id.clone())
        .collect();
    for id in ids {
        if let Some(key) = secrets::get(&id)? {
            return Ok(Some(key));
        }
    }
    Ok(None)
}

fn key(state: &AppState) -> AppResult<(WebKeySource, Option<String>)> {
    if let Some(key) = secrets::web_key_get()? {
        return Ok((WebKeySource::Own, Some(key)));
    }
    Ok(match provider_key(state)? {
        Some(key) => (WebKeySource::Provider, Some(key)),
        None => (WebKeySource::None, None),
    })
}

#[tauri::command]
pub async fn web_key_status(state: State<'_, AppState>) -> AppResult<WebKeySource> {
    Ok(key(&state)?.0)
}

/// Save a key and try it. Returns what's wrong with it, if anything: it's kept
/// either way, so a network failure doesn't lose what was pasted.
#[tauri::command]
pub async fn web_key_set(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::Invalid("Paste your Ollama API key.".into()));
    }
    secrets::web_key_set(key)?;
    Ok(check_key(&state.http, key).await)
}

#[tauri::command]
pub async fn web_key_delete() -> AppResult<()> {
    secrets::web_key_delete()
}

#[tauri::command]
pub async fn web_search(state: State<'_, AppState>, query: String, max_results: Option<u32>) -> AppResult<Vec<SearchResult>> {
    let Some(key) = key(&state)?.1 else {
        return Err(AppError::Invalid(
            "web search needs an Ollama API key, which the user adds in Settings → Search (free with an Ollama account)".into(),
        ));
    };
    search(&state.http, &key, &query, max_results).await.map_err(AppError::Invalid)
}

/// Reads through Ollama with a key, else from this machine (public addresses only).
#[tauri::command]
pub async fn web_fetch(state: State<'_, AppState>, url: String, offset: Option<usize>) -> AppResult<WebPage> {
    let key = key(&state)?.1;
    fetch(&state.http, key.as_deref(), &url, offset.unwrap_or(0)).await.map_err(AppError::Invalid)
}
