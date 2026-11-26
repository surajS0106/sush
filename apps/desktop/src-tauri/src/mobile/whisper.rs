//! whisper.cpp isn't built for Android, where speech uses a cloud engine (`whisper.rs` on desktop).

use serde_json::Value;
use tauri::ipc::Channel;

use crate::error::{AppError, AppResult};

const UNAVAILABLE: &str = "On-device speech isn't available on this phone. Pick a cloud engine in Settings → Speech.";

#[derive(Default)]
pub struct Whisper;

#[tauri::command]
pub fn whisper_model_status() -> AppResult<Value> {
    Err(AppError::Invalid(UNAVAILABLE.into()))
}

#[tauri::command]
pub async fn whisper_model_download(on_progress: Channel<Value>) -> AppResult<()> {
    let _ = on_progress;
    Err(AppError::Invalid(UNAVAILABLE.into()))
}

#[tauri::command]
pub async fn transcribe_local() -> AppResult<String> {
    Err(AppError::Invalid(UNAVAILABLE.into()))
}
