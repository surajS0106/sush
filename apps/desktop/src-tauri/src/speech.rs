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

/// Speak `text` with the provider's `/audio/speech` endpoint (`sush_core::tts`)
/// and store the MP3 as a blob. Returns its URL, for the audio overview player.
#[tauri::command]
pub async fn tts_speak(
    state: State<'_, AppState>,
    provider_id: String,
    model: String,
    voice: String,
    text: String,
    instructions: Option<String>,
) -> AppResult<String> {
    let cfg = state.provider(&provider_id).ok_or_else(|| AppError::NotFound(format!("provider {provider_id} not found")))?;
    let secret = match cfg.auth {
        AuthKind::ApiKey { .. } => secrets::get(&cfg.id)?,
        AuthKind::None => None,
    };
    let audio = sush_core::tts::speak(&cfg, secret, &state.http, &model, &voice, &text, instructions.as_deref()).await?;
    let store = state.store.clone();
    crate::store::blocking(move || Ok(store.put_blob("audio/mpeg", &audio)?)).await
}
