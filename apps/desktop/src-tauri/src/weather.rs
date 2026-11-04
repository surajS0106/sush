//! The `weather_show` card's figures. Needs no key.

use sush_core::weather::{local_weather, LocalWeather};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub async fn weather_now(state: State<'_, AppState>, place: String) -> AppResult<Option<LocalWeather>> {
    local_weather(&state.http, &place).await.map_err(AppError::Invalid)
}
