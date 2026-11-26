//! One window on a phone: no tabs to tear off (`windows.rs` on desktop).

use tauri::{Manager, Window};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub fn tab_hover() -> bool {
    false
}

#[tauri::command]
pub async fn tab_drop() -> &'static str {
    "stayed"
}

#[tauri::command]
pub async fn session_window() -> AppResult<()> {
    Err(AppError::Invalid("A phone shows one session at a time.".into()))
}

pub fn closing(_window: &Window) {}

pub fn destroyed(window: &Window) {
    window.state::<AppState>().runs.unsubscribe(window.app_handle(), window.label());
}
