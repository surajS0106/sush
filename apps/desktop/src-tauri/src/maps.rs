//! The optional Google Maps key (Settings → Maps) and the details it unlocks on a
//! map card. The key stays in the keyring; the webview only learns whether there is one.

use sush_core::maps::{check_key, map_details, MapDetails, TravelMode};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::state::AppState;

#[tauri::command]
pub async fn maps_key_status() -> AppResult<bool> {
    Ok(secrets::maps_key_get()?.is_some())
}

/// Save a key and try it. Returns what's wrong with it, if anything: it's kept
/// either way, since the usual fix is enabling an API in Google's console.
#[tauri::command]
pub async fn maps_key_set(state: State<'_, AppState>, key: String) -> AppResult<Vec<String>> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::Invalid("Paste your Google Maps API key.".into()));
    }
    secrets::maps_key_set(key)?;
    Ok(check_key(&state.http, key).await)
}

#[tauri::command]
pub async fn maps_key_delete() -> AppResult<()> {
    secrets::maps_key_delete()
}

/// Details for a map card, or nothing without a key.
#[tauri::command]
pub async fn maps_details(
    state: State<'_, AppState>,
    origin: Option<String>,
    destination: String,
    mode: TravelMode,
) -> AppResult<Option<MapDetails>> {
    let Some(key) = secrets::maps_key_get()? else { return Ok(None) };
    Ok(Some(map_details(&state.http, &key, origin.as_deref(), &destination, mode).await))
}
