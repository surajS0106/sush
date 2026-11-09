//! Text to speech over the OpenAI-compatible `POST {base}/audio/speech`
//! endpoint: OpenAI and Azure Foundry (`gpt-4o-mini-tts`, `tts-1`), Groq, and
//! local servers that speak it (Kokoro-FastAPI, openedai-speech). Text goes in,
//! MP3 comes out. Used for notebooks' audio overviews.

use serde_json::json;

use crate::provider::{check_status, endpoint};
use crate::{ProviderConfig, ProviderError, WireFormat};

/// Longest text one request takes (OpenAI's limit is 4096 characters).
pub const MAX_TTS_CHARS: usize = 4000;

/// Speak `text` in `voice` with `model` on the provider `cfg`. `instructions`
/// steers the delivery on models that take it (`gpt-4o-mini-tts`); others ignore it.
pub async fn speak(
    cfg: &ProviderConfig,
    secret: Option<String>,
    http: &reqwest::Client,
    model: &str,
    voice: &str,
    text: &str,
    instructions: Option<&str>,
) -> Result<Vec<u8>, ProviderError> {
    if cfg.format == WireFormat::AnthropicMessages {
        return Err(ProviderError::Config(format!(
            "{}: Claude doesn't make speech. Pick an OpenAI-compatible provider for voices.",
            cfg.name
        )));
    }
    let text: String = text.chars().take(MAX_TTS_CHARS).collect();
    let mut body = json!({ "model": model, "voice": voice, "input": text, "response_format": "mp3" });
    if let Some(i) = instructions.map(str::trim).filter(|i| !i.is_empty()) {
        body["instructions"] = json!(i);
    }
    let ep = endpoint(cfg, secret)?;
    let resp = ep.apply(http.post(ep.url("audio/speech"))).json(&body).send().await.map_err(ProviderError::sending)?;
    let bytes = check_status("speech", resp).await?.bytes().await?;
    if bytes.is_empty() {
        return Err(ProviderError::Decode("the speech endpoint sent back no audio".into()));
    }
    Ok(bytes.to_vec())
}
