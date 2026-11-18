//! Voice mode (`sush_core::voice`): the user's keys for the four voice
//! providers, their voices and models, and the conversations themselves.
//!
//! A realtime conversation (OpenAI, xAI) is a WebSocket held here, so the key
//! never reaches the webview: the UI streams microphone PCM in with
//! `voice_realtime_audio` and gets the model's audio and transcripts back on a
//! channel. A turn-by-turn one (Sarvam, ElevenLabs) is driven by the UI, which
//! calls `voice_transcribe`, `voice_think` and `voice_speak` for each turn.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use sush_core::voice::{cascade, realtime, VoiceEvent, VoiceInfo, VoiceModel, VoiceProvider};
use sush_core::{build_provider, ChatEvent, ChatRequest, Provider};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::commands::{provider_for, StreamFrame};
use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::state::AppState;

/// Live realtime conversations by session id: what to send down each socket.
#[derive(Default)]
pub struct VoiceSessions(Mutex<HashMap<String, mpsc::UnboundedSender<String>>>);

fn key(provider: VoiceProvider) -> AppResult<String> {
    secrets::voice_key_get(provider.id())?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| AppError::Invalid(format!("Add your {} key in Settings → Voice first.", provider.name())))
}

// --- keys ---------------------------------------------------------------------------

/// Which providers have a key.
#[tauri::command]
pub fn voice_keys() -> AppResult<Vec<VoiceProvider>> {
    let mut out = vec![];
    for p in VoiceProvider::ALL {
        if secrets::voice_key_get(p.id())?.is_some_and(|k| !k.trim().is_empty()) {
            out.push(p);
        }
    }
    Ok(out)
}

/// Save a key, after checking it where the provider has a cheap way to.
#[tauri::command]
pub async fn voice_key_set(state: State<'_, AppState>, provider: VoiceProvider, key: String) -> AppResult<()> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err(AppError::Invalid("Paste a key first.".into()));
    }
    let check = match provider {
        VoiceProvider::Openai | VoiceProvider::Xai => cascade::list_models(provider, &key, &state.http).await.map(|_| ()),
        VoiceProvider::Elevenlabs => cascade::elevenlabs_voices(&key, &state.http).await.map(|_| ()),
        // Sarvam has no free call to try a key on; the first conversation tells.
        VoiceProvider::Sarvam => Ok(()),
    };
    if let Err(sush_core::ProviderError::Http { status: 401 | 403, .. }) = check {
        return Err(AppError::Invalid(format!("{} didn't accept that key.", provider.name())));
    }
    secrets::voice_key_set(provider.id(), &key)
}

#[tauri::command]
pub fn voice_key_delete(provider: VoiceProvider) -> AppResult<()> {
    secrets::voice_key_delete(provider.id())
}

// --- voices and models --------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCatalog {
    models: Vec<VoiceModel>,
    voices: Vec<VoiceInfo>,
}

/// A provider's models and voices: asked of the provider where it can say,
/// else the ones it ships with.
#[tauri::command]
pub async fn voice_catalog(state: State<'_, AppState>, provider: VoiceProvider) -> AppResult<VoiceCatalog> {
    let mut models = sush_core::voice::builtin_models(provider);
    let mut voices = sush_core::voice::builtin_voices(provider);
    if let Some(key) = secrets::voice_key_get(provider.id())? {
        if let Ok(found) = cascade::list_models(provider, &key, &state.http).await {
            if !found.is_empty() {
                models = found;
            }
        }
        if provider == VoiceProvider::Elevenlabs {
            if let Ok(found) = cascade::elevenlabs_voices(&key, &state.http).await {
                // The account's voices, defaults included, in place of the built-in list.
                if !found.is_empty() {
                    voices = found;
                }
            }
        }
    }
    Ok(VoiceCatalog { models, voices })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpokenAudio {
    /// base64 audio the webview decodes with `decodeAudioData`.
    data: String,
    mime: &'static str,
}

/// Speak a sentence: a turn-by-turn conversation's answer, or a voice preview.
#[tauri::command]
pub async fn voice_speak(
    state: State<'_, AppState>,
    provider: VoiceProvider,
    model: String,
    voice: String,
    text: String,
    language: Option<String>,
) -> AppResult<SpokenAudio> {
    let key = key(provider)?;
    let speech = cascade::speak(provider, &key, &state.http, &model, &voice, &text, language.as_deref()).await?;
    Ok(SpokenAudio { data: base64::engine::general_purpose::STANDARD.encode(speech.bytes), mime: speech.mime })
}

/// Transcribe one turn of a turn-by-turn conversation.
#[tauri::command]
pub async fn voice_transcribe(
    state: State<'_, AppState>,
    provider: VoiceProvider,
    audio_base64_wav: String,
    language: Option<String>,
) -> AppResult<cascade::Transcript> {
    let key = key(provider)?;
    let wav = base64::engine::general_purpose::STANDARD
        .decode(audio_base64_wav)
        .map_err(|e| AppError::Invalid(format!("audio is not valid base64: {e}")))?;
    Ok(cascade::transcribe(provider, &key, &state.http, wav, language.as_deref()).await?)
}

/// Answer a turn: with Sarvam's own model (`provider_id` None), or with one of
/// the user's chat providers. Streams like `chat_stream`, and `cancel_stream`
/// stops it when the user cuts in.
#[tauri::command]
pub async fn voice_think(
    state: State<'_, AppState>,
    stream_id: String,
    provider_id: Option<String>,
    request: ChatRequest,
    on_event: Channel<StreamFrame>,
) -> AppResult<()> {
    let token = CancellationToken::new();
    state.streams.lock().unwrap().insert(stream_id.clone(), token.clone());
    let result = think(&state, provider_id, request, &on_event, &token).await;
    state.streams.lock().unwrap().remove(&stream_id);
    if let Err(e) = result {
        let _ = on_event.send(StreamFrame::Event { event: ChatEvent::Error { message: e.to_string() } });
    }
    let _ = on_event.send(StreamFrame::End);
    Ok(())
}

async fn think(
    state: &AppState,
    provider_id: Option<String>,
    request: ChatRequest,
    on_event: &Channel<StreamFrame>,
    token: &CancellationToken,
) -> AppResult<()> {
    let provider = match provider_id {
        Some(id) => provider_for(state, &id)?,
        None => build_provider(&cascade::sarvam_chat_config(), Some(key(VoiceProvider::Sarvam)?), state.http.clone())?,
    };
    let mut stream = tokio::select! {
        _ = token.cancelled() => return Ok(()),
        s = provider.stream_chat(request) => s?,
    };
    loop {
        let next = tokio::select! {
            _ = token.cancelled() => return Ok(()),
            next = stream.next() => next,
        };
        match next {
            Some(Ok(event)) => {
                if on_event.send(StreamFrame::Event { event }).is_err() {
                    return Ok(());
                }
            }
            Some(Err(e)) => return Err(e.into()),
            None => return Ok(()),
        }
    }
}

// --- realtime -----------------------------------------------------------------------

/// Open a realtime conversation and set it up. Returns once the socket is
/// open; everything after arrives on `on_event`, ending with `closed`.
#[tauri::command]
pub async fn voice_realtime_start(
    sessions: State<'_, VoiceSessions>,
    session_id: String,
    provider: VoiceProvider,
    model: String,
    voice: String,
    instructions: String,
    on_event: Channel<VoiceEvent>,
) -> AppResult<()> {
    let key = key(provider)?;
    let mut request = realtime::url(provider, &model)?
        .into_client_request()
        .map_err(|e| AppError::Invalid(format!("Couldn't start the conversation: {e}")))?;
    let auth = HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| AppError::Invalid(format!("Your {} key has characters a key can't have.", provider.name())))?;
    request.headers_mut().insert("Authorization", auth);
    let socket = match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _)) => socket,
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
            let body = resp.body().as_deref().map(String::from_utf8_lossy).unwrap_or_default().to_string();
            let detail = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.pointer("/error/message").or_else(|| v.get("error")).and_then(|m| m.as_str().map(str::to_owned)));
            let message = match resp.status().as_u16() {
                401 | 403 => format!("{} didn't accept your key. Check it in Settings → Voice.", provider.name()),
                404 => format!("{} doesn't have the model “{model}” for your key. Pick another in Settings → Voice.", provider.name()),
                429 => format!("{} says you're over your limit or out of credit.", provider.name()),
                s => format!("{} answered {s}{}", provider.name(), detail.map(|d| format!(": {d}")).unwrap_or_default()),
            };
            return Err(AppError::Invalid(message));
        }
        Err(e) => return Err(AppError::Invalid(format!("Couldn't reach {}: {e}", provider.name()))),
    };

    let (mut sink, mut stream) = socket.split();
    let setup = realtime::session_update(provider, &voice, &instructions).to_string();
    sink.send(Message::text(setup)).await.map_err(|e| AppError::Invalid(format!("Couldn't set up the conversation: {e}")))?;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    if let Some(old) = sessions.0.lock().unwrap().insert(session_id.clone(), tx) {
        drop(old); // a stale conversation under the same id closes on its own
    }
    tauri::async_runtime::spawn(async move {
        let reason = loop {
            tokio::select! {
                out = rx.recv() => match out {
                    Some(text) => if let Err(e) = sink.send(Message::text(text)).await { break Some(e.to_string()) },
                    // `voice_realtime_end`, or a newer conversation took the id.
                    None => { let _ = sink.close().await; break None },
                },
                msg = stream.next() => match msg {
                    Some(Ok(Message::Text(text))) => {
                        for event in realtime::parse(text.as_str()) {
                            if on_event.send(event).is_err() {
                                let _ = sink.close().await;
                                return;
                            }
                        }
                    }
                    Some(Ok(Message::Close(frame))) => break frame.map(|f| f.reason.as_str().to_string()).filter(|r| !r.is_empty()),
                    Some(Err(e)) => break Some(e.to_string()),
                    None => break None,
                    Some(Ok(_)) => {}
                },
            }
        };
        let _ = on_event.send(VoiceEvent::Closed { reason });
    });
    Ok(())
}

fn send(sessions: &VoiceSessions, session_id: &str, texts: impl IntoIterator<Item = String>) {
    if let Some(tx) = sessions.0.lock().unwrap().get(session_id) {
        for text in texts {
            let _ = tx.send(text);
        }
    }
}

/// A slice of the microphone: 24 kHz 16-bit mono PCM, base64.
#[tauri::command]
pub fn voice_realtime_audio(sessions: State<'_, VoiceSessions>, session_id: String, audio: String) {
    send(&sessions, &session_id, [realtime::append_audio(&audio)]);
}

/// The user cut in on an answer `item_id` after hearing `audio_end_ms` of it.
#[tauri::command]
pub fn voice_realtime_interrupt(sessions: State<'_, VoiceSessions>, session_id: String, item_id: Option<String>, audio_end_ms: u64) {
    send(&sessions, &session_id, realtime::interrupt(item_id.as_deref(), audio_end_ms));
}

#[tauri::command]
pub fn voice_realtime_end(sessions: State<'_, VoiceSessions>, session_id: String) {
    sessions.0.lock().unwrap().remove(&session_id);
}
