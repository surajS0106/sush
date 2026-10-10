//! Dictation: the UI records a WAV clip and sends it here to be transcribed
//! by whichever provider and model the user picked in Settings → Speech.

use base64::Engine;
use sush_core::{transcribe as stt, AuthKind, TranscribeApi};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::state::AppState;

#[tauri::command]
pub async fn transcribe(
    state: State<'_, AppState>,
    provider_id: String,
    model: String,
    api: TranscribeApi,
    audio_base64_wav: String,
) -> AppResult<String> {
    let cfg = state.provider(&provider_id).ok_or_else(|| AppError::NotFound(format!("provider {provider_id} not found")))?;
    let secret = match cfg.auth {
        AuthKind::ApiKey { .. } => secrets::get(&cfg.id)?,
        AuthKind::None => None,
    };
    let wav = base64::engine::general_purpose::STANDARD
        .decode(audio_base64_wav)
        .map_err(|e| AppError::Invalid(format!("audio is not valid base64: {e}")))?;
    Ok(stt(&cfg, secret, &state.http, &model, api, wav).await?)
}
