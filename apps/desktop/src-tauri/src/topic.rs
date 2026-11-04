//! The `topic_lookup` card's photos and articles. Needs no key.

use sush_core::topic::{lookup, Topic};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub async fn topic_lookup(state: State<'_, AppState>, query: String) -> AppResult<Option<Topic>> {
    lookup(&state.http, &query).await.map_err(AppError::Invalid)
}
