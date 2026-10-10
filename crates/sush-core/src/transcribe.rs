//! Speech-to-text. Audio goes in as a WAV file and plain text comes out.
//!
//! There's no single wire format for this, so the caller picks one:
//! `/audio/transcriptions` (OpenAI, Azure Foundry, Groq: whisper and
//! gpt-4o-transcribe models), or Ollama's native chat with an audio-capable
//! model such as `gemma4:e4b`. Anthropic models don't take audio input.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::provider::{check_status, endpoint};
use crate::{ProviderConfig, ProviderError, WireFormat};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranscribeApi {
    /// `POST {base}/audio/transcriptions`, multipart.
    Transcriptions,
    /// `POST {root}/api/chat` on Ollama with the audio attached. Ollama carries
    /// audio in the `images` field.
    OllamaChat,
}

const PROMPT: &str = "Transcribe this audio verbatim. Output only the transcription, with punctuation. \
If there is no speech, output nothing.";

/// Transcribe a WAV clip with `model` on the provider `cfg`.
pub async fn transcribe(
    cfg: &ProviderConfig,
    secret: Option<String>,
    http: &reqwest::Client,
    model: &str,
    api: TranscribeApi,
    wav: Vec<u8>,
) -> Result<String, ProviderError> {
    if cfg.format == WireFormat::AnthropicMessages {
        return Err(ProviderError::Config(format!(
            "{}: Claude models don't accept audio input. Pick an OpenAI-compatible or Ollama provider for speech.",
            cfg.name
        )));
    }
    let ep = endpoint(cfg, secret)?;
    let text = match api {
        TranscribeApi::Transcriptions => {
            let file = reqwest::multipart::Part::bytes(wav).file_name("audio.wav").mime_str("audio/wav")?;
            let form = reqwest::multipart::Form::new()
                .text("model", model.to_string())
                .text("response_format", "json")
                .part("file", file);
            let resp = ep.apply(http.post(ep.url("audio/transcriptions"))).multipart(form).send().await.map_err(ProviderError::sending)?;
            let body: serde_json::Value = check_status("transcription", resp).await?.json().await?;
            body.get("text")
                .and_then(|t| t.as_str())
                .ok_or_else(|| ProviderError::Decode("transcription response has no `text`".into()))?
                .to_string()
        }
        TranscribeApi::OllamaChat => {
            let audio = base64::engine::general_purpose::STANDARD.encode(&wav);
            let body = json!({
                "model": model,
                "stream": false,
                // Gemma 4 thinks by default, which wastes time and garbles transcripts.
                "think": false,
                "options": { "temperature": 0 },
                "messages": [{ "role": "user", "content": PROMPT, "images": [audio] }],
            });
            let url = format!("{}/api/chat", ollama_root(&ep.base_url));
            let resp = ep.apply(http.post(url)).json(&body).send().await.map_err(ProviderError::sending)?;
            let body: serde_json::Value = check_status("Ollama", resp).await?.json().await?;
            body.pointer("/message/content")
                .and_then(|t| t.as_str())
                .ok_or_else(|| ProviderError::Decode("Ollama response has no message content".into()))?
                .to_string()
        }
    };
    Ok(text.trim().to_string())
}

/// Ollama providers are configured with the OpenAI-compatible `/v1` URL; the
/// native API lives at the server root.
fn ollama_root(base_url: &str) -> &str {
    let base = base_url.trim_end_matches('/');
    base.strip_suffix("/v1").unwrap_or(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_root_strips_openai_suffix() {
        assert_eq!(ollama_root("http://localhost:11434/v1"), "http://localhost:11434");
        assert_eq!(ollama_root("http://localhost:11434/v1/"), "http://localhost:11434");
        assert_eq!(ollama_root("http://localhost:11434"), "http://localhost:11434");
    }

    #[test]
    fn api_serialises_kebab_case() {
        assert_eq!(serde_json::to_value(TranscribeApi::OllamaChat).unwrap(), "ollama-chat");
        assert_eq!(serde_json::to_value(TranscribeApi::Transcriptions).unwrap(), "transcriptions");
    }
}
