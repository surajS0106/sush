//! The HTTP side of voice mode: transcribing a turn (Sarvam, ElevenLabs),
//! speaking a sentence (all four providers; OpenAI and xAI only for voice
//! previews), and asking a provider for its voices and models.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{Gender, VoiceInfo, VoiceModel, VoiceProvider};
use crate::provider::check_status;
use crate::{AuthKind, ProviderConfig, ProviderError, WireFormat};

const SARVAM: &str = "https://api.sarvam.ai";
const ELEVENLABS: &str = "https://api.elevenlabs.io/v1";

/// The languages Sarvam's Bulbul speaks; anything else is spoken in Indian English.
const SARVAM_LANGUAGES: [&str; 11] =
    ["bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN"];

/// Longest sentence spoken in one request (Bulbul v3 takes 2500 characters).
const MAX_SPEAK_CHARS: usize = 2400;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    /// The language heard, as the provider names it (`hi-IN`, `eng`), when it says.
    pub language: Option<String>,
}

/// Audio to play, in a format a browser decodes (MP3 or WAV).
#[derive(Debug, Clone)]
pub struct Speech {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

/// Transcribe one turn (a WAV clip, at most 30 seconds for Sarvam).
pub async fn transcribe(
    provider: VoiceProvider,
    key: &str,
    http: &reqwest::Client,
    wav: Vec<u8>,
    language: Option<&str>,
) -> Result<Transcript, ProviderError> {
    let file = || reqwest::multipart::Part::bytes(wav.clone()).file_name("turn.wav").mime_str("audio/wav");
    match provider {
        VoiceProvider::Sarvam => {
            let mut form = reqwest::multipart::Form::new().text("model", "saaras:v4").text("mode", "transcribe").part("file", file()?);
            if let Some(lang) = language.filter(|l| SARVAM_LANGUAGES.contains(l)) {
                form = form.text("language_code", lang.to_string());
            }
            let resp = http.post(format!("{SARVAM}/speech-to-text")).header("api-subscription-key", key).multipart(form).send().await.map_err(ProviderError::sending)?;
            let body: Value = check_status("Sarvam", resp).await?.json().await?;
            Ok(Transcript {
                text: body.get("transcript").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
                language: body.get("language_code").and_then(Value::as_str).map(str::to_owned),
            })
        }
        VoiceProvider::Elevenlabs => {
            // Scribe v2 first; accounts or regions without it fall back to v1.
            let mut last = None;
            for model in ["scribe_v2", "scribe_v1"] {
                let form = reqwest::multipart::Form::new().text("model_id", model).part("file", file()?);
                let resp = http.post(format!("{ELEVENLABS}/speech-to-text")).header("xi-api-key", key).multipart(form).send().await.map_err(ProviderError::sending)?;
                match check_status("ElevenLabs", resp).await {
                    Ok(resp) => {
                        let body: Value = resp.json().await?;
                        return Ok(Transcript {
                            text: body.get("text").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
                            language: body.get("language_code").and_then(Value::as_str).map(str::to_owned),
                        });
                    }
                    Err(e @ ProviderError::Http { status: 400 | 404 | 422, .. }) => last = Some(e),
                    Err(e) => return Err(e),
                }
            }
            Err(last.unwrap_or_else(|| ProviderError::Decode("no transcription".into())))
        }
        other => Err(ProviderError::Config(format!("{} conversations transcribe on their own", other.name()))),
    }
}

/// The Bulbul language to speak in, from what the transcriber heard.
pub fn sarvam_language(heard: Option<&str>) -> &'static str {
    let heard = heard.unwrap_or_default();
    SARVAM_LANGUAGES
        .iter()
        .find(|l| l.eq_ignore_ascii_case(heard) || (heard.len() == 2 && l[..2].eq_ignore_ascii_case(heard)))
        .copied()
        .unwrap_or("en-IN")
}

/// Speak `text` in `voice`. `model` is the speech model for Sarvam and
/// ElevenLabs; OpenAI and xAI speak through their text-to-speech models, which
/// share the realtime voices, so their previews sound like the conversation.
pub async fn speak(
    provider: VoiceProvider,
    key: &str,
    http: &reqwest::Client,
    model: &str,
    voice: &str,
    text: &str,
    language: Option<&str>,
) -> Result<Speech, ProviderError> {
    let text: String = text.chars().take(MAX_SPEAK_CHARS).collect();
    if text.trim().is_empty() {
        return Err(ProviderError::Config("nothing to say".into()));
    }
    let mp3 = |bytes: Vec<u8>| Speech { bytes, mime: "audio/mpeg" };
    match provider {
        VoiceProvider::Openai => {
            let body = json!({ "model": "gpt-4o-mini-tts", "voice": voice, "input": text, "response_format": "mp3" });
            let resp = http.post("https://api.openai.com/v1/audio/speech").bearer_auth(key).json(&body).send().await.map_err(ProviderError::sending)?;
            Ok(mp3(check_status("OpenAI", resp).await?.bytes().await?.to_vec()))
        }
        VoiceProvider::Xai => {
            let body = json!({ "text": text, "voice_id": voice, "language": "auto" });
            let resp = http.post("https://api.x.ai/v1/tts").bearer_auth(key).json(&body).send().await.map_err(ProviderError::sending)?;
            Ok(mp3(check_status("xAI", resp).await?.bytes().await?.to_vec()))
        }
        VoiceProvider::Sarvam => {
            let body = json!({
                "text": text,
                "language_code": sarvam_language(language),
                "speaker": voice,
                "model": if model.is_empty() { "bulbul:v3" } else { model },
                "speech_sample_rate": 24000,
            });
            let resp = http.post(format!("{SARVAM}/text-to-speech")).header("api-subscription-key", key).json(&body).send().await.map_err(ProviderError::sending)?;
            let body: Value = check_status("Sarvam", resp).await?.json().await?;
            let audio = body
                .pointer("/audios/0")
                .and_then(Value::as_str)
                .ok_or_else(|| ProviderError::Decode("Sarvam sent back no audio".into()))?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(audio)
                .map_err(|e| ProviderError::Decode(format!("Sarvam audio isn't base64: {e}")))?;
            Ok(Speech { bytes, mime: "audio/wav" })
        }
        VoiceProvider::Elevenlabs => {
            let voice: String = voice.chars().filter(char::is_ascii_alphanumeric).collect();
            let body = json!({ "text": text, "model_id": if model.is_empty() { "eleven_flash_v2_5" } else { model } });
            let url = format!("{ELEVENLABS}/text-to-speech/{voice}?output_format=mp3_44100_128");
            let resp = http.post(url).header("xi-api-key", key).json(&body).send().await.map_err(ProviderError::sending)?;
            Ok(mp3(check_status("ElevenLabs", resp).await?.bytes().await?.to_vec()))
        }
    }
}

fn gender_of(label: &str) -> Gender {
    match label.to_ascii_lowercase().as_str() {
        "female" | "woman" => Gender::Female,
        "male" | "man" => Gender::Male,
        _ => Gender::Neutral,
    }
}

/// The ElevenLabs account's voices: the defaults plus any it made or added.
pub async fn elevenlabs_voices(key: &str, http: &reqwest::Client) -> Result<Vec<VoiceInfo>, ProviderError> {
    let resp = http.get(format!("{ELEVENLABS}/voices")).header("xi-api-key", key).send().await.map_err(ProviderError::sending)?;
    let body: Value = check_status("ElevenLabs", resp).await?.json().await?;
    Ok(parse_elevenlabs_voices(&body))
}

fn parse_elevenlabs_voices(body: &Value) -> Vec<VoiceInfo> {
    let label = |v: &Value, k: &str| v.pointer(&format!("/labels/{k}")).and_then(Value::as_str).unwrap_or_default().to_string();
    body.get("voices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| {
            let id = v.get("voice_id")?.as_str()?.to_string();
            let name = v.get("name")?.as_str()?.split(" - ").next().unwrap_or_default().trim().to_string();
            let words: Vec<String> = [label(v, "description"), label(v, "descriptive"), label(v, "age"), label(v, "accent")]
                .into_iter()
                .filter(|w| !w.is_empty())
                .map(|w| w.replace('_', " "))
                .collect();
            let description = if words.is_empty() { "Your voice".to_string() } else { capitalise(&words.join(", ")) };
            Some(VoiceInfo { id, name, gender: gender_of(&label(v, "gender")), description })
        })
        .collect()
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

/// The provider's own list of conversation models (OpenAI's realtime models,
/// xAI's voice models), newest names first.
pub async fn list_models(provider: VoiceProvider, key: &str, http: &reqwest::Client) -> Result<Vec<VoiceModel>, ProviderError> {
    let (url, keep): (&str, fn(&str) -> bool) = match provider {
        VoiceProvider::Openai => ("https://api.openai.com/v1/models", |id| id.contains("realtime") && !id.contains("transcri")),
        VoiceProvider::Xai => ("https://api.x.ai/v1/models", |id| id.contains("voice")),
        _ => return Ok(super::builtin_models(provider)),
    };
    let resp = http.get(url).bearer_auth(key).send().await.map_err(ProviderError::sending)?;
    let body: Value = check_status(provider.name(), resp).await?.json().await?;
    let mut ids: Vec<String> = body
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .filter(|id| keep(id))
        .map(str::to_owned)
        .collect();
    ids.sort_by(|a, b| b.cmp(a));
    let known = super::builtin_models(provider);
    Ok(ids
        .into_iter()
        .map(|id| known.iter().find(|m| m.id == id).cloned().unwrap_or_else(|| VoiceModel { name: id.clone(), id, description: String::new() }))
        .collect())
}

/// Sarvam's chat models speak the OpenAI chat format, so a Sarvam
/// conversation thinks through the ordinary provider code.
pub fn sarvam_chat_config() -> ProviderConfig {
    ProviderConfig {
        id: "voice:sarvam".into(),
        name: "Sarvam".into(),
        format: WireFormat::OpenaiChat,
        base_url: format!("{SARVAM}/v1"),
        auth: AuthKind::ApiKey { header: None },
        headers: Default::default(),
        models: vec![super::SARVAM_CHAT_MODEL.into()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_a_sarvam_language() {
        assert_eq!(sarvam_language(Some("hi-IN")), "hi-IN");
        assert_eq!(sarvam_language(Some("ta")), "ta-IN");
        assert_eq!(sarvam_language(Some("fr-FR")), "en-IN");
        assert_eq!(sarvam_language(None), "en-IN");
    }

    #[test]
    fn reads_elevenlabs_voices() {
        let body = json!({ "voices": [
            { "voice_id": "abc", "name": "Sarah - Mature, Reassuring", "labels": { "gender": "female", "accent": "american", "age": "young", "description": "soft" } },
            { "voice_id": "def", "name": "Clone", "labels": {} },
            { "name": "no id" },
        ]});
        let voices = parse_elevenlabs_voices(&body);
        assert_eq!(voices.len(), 2);
        assert_eq!(voices[0].name, "Sarah");
        assert_eq!(voices[0].gender, Gender::Female);
        assert_eq!(voices[0].description, "Soft, young, american");
        assert_eq!(voices[1].gender, Gender::Neutral);
    }
}
