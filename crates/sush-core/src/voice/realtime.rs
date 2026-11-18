//! The realtime speech-to-speech protocol that OpenAI's Realtime API and xAI's
//! Grok Voice Agent API both speak: JSON events over one WebSocket, audio as
//! base64 PCM (24 kHz, 16-bit, mono) both ways, the server deciding when the
//! user's turn ends. I/O-free: the host opens the socket and moves the text.

use serde_json::{json, Value};

use super::{VoiceEvent, VoiceProvider};
use crate::ProviderError;

/// Client events the conversation can do without (interrupting when nothing
/// is playing, say) carry this id prefix, and the server's errors about them
/// aren't shown.
const SOFT: &str = "soft-";

/// The socket to open; the key goes in an `Authorization: Bearer` header.
pub fn url(provider: VoiceProvider, model: &str) -> Result<String, ProviderError> {
    let base = match provider {
        VoiceProvider::Openai => "wss://api.openai.com/v1/realtime",
        VoiceProvider::Xai => "wss://api.x.ai/v1/realtime",
        other => return Err(ProviderError::Config(format!("{} has no realtime voice API", other.name()))),
    };
    let model: String = model.trim().chars().filter(|c| c.is_ascii_alphanumeric() || "-._:".contains(*c)).collect();
    if model.is_empty() {
        return Err(ProviderError::Config("pick a voice model".into()));
    }
    Ok(format!("{base}?model={model}"))
}

/// The first message: voice, instructions, audio formats, turn detection and
/// transcripts of both sides.
pub fn session_update(provider: VoiceProvider, voice: &str, instructions: &str) -> Value {
    let pcm = json!({ "type": "audio/pcm", "rate": 24000 });
    match provider {
        VoiceProvider::Xai => json!({
            "type": "session.update",
            "session": {
                "voice": voice,
                "instructions": instructions,
                "turn_detection": { "type": "server_vad" },
                "audio": {
                    "input": { "format": pcm, "transcription": { "model": "grok-transcribe" } },
                    "output": { "format": pcm },
                },
            },
        }),
        _ => json!({
            "type": "session.update",
            "session": {
                "type": "realtime",
                "instructions": instructions,
                "output_modalities": ["audio"],
                "audio": {
                    "input": {
                        "format": pcm,
                        "transcription": { "model": "gpt-4o-mini-transcribe" },
                        // Ends the turn when the user sounds finished, not just at a pause.
                        "turn_detection": { "type": "semantic_vad", "eagerness": "auto", "create_response": true, "interrupt_response": true },
                        "noise_reduction": { "type": "near_field" },
                    },
                    "output": { "format": pcm, "voice": voice },
                },
            },
        }),
    }
}

/// A slice of the microphone (24 kHz 16-bit mono PCM, base64).
pub fn append_audio(base64_pcm: &str) -> String {
    json!({ "type": "input_audio_buffer.append", "audio": base64_pcm }).to_string()
}

/// The user cut in: stop the answer, and cut what the model remembers of it to
/// what was actually heard, so it doesn't think it said the rest.
pub fn interrupt(item_id: Option<&str>, audio_end_ms: u64) -> Vec<String> {
    let mut out = vec![json!({ "type": "response.cancel", "event_id": format!("{SOFT}cancel") }).to_string()];
    if let Some(item) = item_id.filter(|i| !i.is_empty()) {
        out.push(
            json!({
                "type": "conversation.item.truncate",
                "event_id": format!("{SOFT}truncate"),
                "item_id": item,
                "content_index": 0,
                "audio_end_ms": audio_end_ms,
            })
            .to_string(),
        );
    }
    out
}

fn str_at<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// What one server event means for the conversation; most events mean nothing.
pub fn parse(text: &str) -> Vec<VoiceEvent> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    let item_id = || str_at(&v, "item_id").to_string();
    let event = match str_at(&v, "type") {
        "session.updated" => VoiceEvent::Ready,
        "input_audio_buffer.speech_started" => VoiceEvent::SpeechStarted,
        "input_audio_buffer.speech_stopped" => VoiceEvent::SpeechStopped { item_id: item_id() },
        "conversation.item.input_audio_transcription.delta" => {
            VoiceEvent::UserTranscript { item_id: item_id(), text: str_at(&v, "delta").into(), done: false }
        }
        // xAI sends the transcript so far in `updated` events.
        "conversation.item.input_audio_transcription.updated" => {
            let text = v.get("transcript").or_else(|| v.get("text")).and_then(Value::as_str).unwrap_or_default();
            VoiceEvent::UserTranscript { item_id: item_id(), text: text.into(), done: true }
        }
        "conversation.item.input_audio_transcription.completed" => {
            VoiceEvent::UserTranscript { item_id: item_id(), text: str_at(&v, "transcript").trim().into(), done: true }
        }
        "response.output_audio.delta" | "response.audio.delta" => {
            VoiceEvent::Audio { item_id: item_id(), data: str_at(&v, "delta").into() }
        }
        "response.output_audio_transcript.delta" | "response.audio_transcript.delta" => {
            VoiceEvent::AssistantTranscript { item_id: item_id(), text: str_at(&v, "delta").into(), done: false }
        }
        "response.output_audio_transcript.done" | "response.audio_transcript.done" => {
            VoiceEvent::AssistantTranscript { item_id: item_id(), text: str_at(&v, "transcript").into(), done: true }
        }
        "response.done" => {
            let status = v.pointer("/response/status").and_then(Value::as_str).unwrap_or("completed");
            VoiceEvent::ResponseDone { status: status.into() }
        }
        "error" => {
            let err = v.get("error").unwrap_or(&v);
            // xAI doesn't always echo the event id inside `error` or send OpenAI's
            // codes, so a cancel that found nothing to stop is also known by its text.
            let text = str_at(err, "message").to_ascii_lowercase();
            let soft = str_at(err, "event_id").starts_with(SOFT)
                || str_at(&v, "event_id").starts_with(SOFT)
                || matches!(str_at(err, "code"), "response_cancel_not_active" | "conversation_already_has_active_response")
                || text.contains("no active response")
                || text.contains("already has an active response");
            if soft {
                return vec![];
            }
            let message = err.get("message").and_then(Value::as_str).unwrap_or("The voice service reported an error");
            VoiceEvent::Error { message: message.into() }
        }
        _ => return vec![],
    };
    vec![event]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(url(VoiceProvider::Openai, "gpt-realtime").unwrap(), "wss://api.openai.com/v1/realtime?model=gpt-realtime");
        assert_eq!(url(VoiceProvider::Xai, "grok-voice-latest&x=1").unwrap(), "wss://api.x.ai/v1/realtime?model=grok-voice-latestx1");
        assert!(url(VoiceProvider::Sarvam, "x").is_err());
        assert!(url(VoiceProvider::Openai, " ").is_err());
    }

    #[test]
    fn session_shapes() {
        let o = session_update(VoiceProvider::Openai, "marin", "be brief");
        assert_eq!(o["session"]["type"], "realtime");
        assert_eq!(o["session"]["audio"]["output"]["voice"], "marin");
        assert_eq!(o["session"]["audio"]["input"]["format"]["rate"], 24000);
        let x = session_update(VoiceProvider::Xai, "eve", "be brief");
        assert_eq!(x["session"]["voice"], "eve");
        assert_eq!(x["session"]["turn_detection"]["type"], "server_vad");
    }

    #[test]
    fn reads_audio_and_transcripts() {
        assert_eq!(
            parse(r#"{"type":"response.output_audio.delta","item_id":"a","delta":"AAA="}"#),
            vec![VoiceEvent::Audio { item_id: "a".into(), data: "AAA=".into() }]
        );
        // xAI's older event names
        assert_eq!(
            parse(r#"{"type":"response.audio.delta","item_id":"a","delta":"AAA="}"#),
            vec![VoiceEvent::Audio { item_id: "a".into(), data: "AAA=".into() }]
        );
        assert_eq!(
            parse(r#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"u","transcript":" Hello there \n"}"#),
            vec![VoiceEvent::UserTranscript { item_id: "u".into(), text: "Hello there".into(), done: true }]
        );
        assert_eq!(
            parse(r#"{"type":"response.output_audio_transcript.delta","item_id":"a","delta":"Hi"}"#),
            vec![VoiceEvent::AssistantTranscript { item_id: "a".into(), text: "Hi".into(), done: false }]
        );
        assert_eq!(
            parse(r#"{"type":"response.done","response":{"status":"cancelled"}}"#),
            vec![VoiceEvent::ResponseDone { status: "cancelled".into() }]
        );
        assert_eq!(parse(r#"{"type":"input_audio_buffer.speech_started"}"#), vec![VoiceEvent::SpeechStarted]);
        assert_eq!(
            parse(r#"{"type":"input_audio_buffer.speech_stopped","item_id":"u1"}"#),
            vec![VoiceEvent::SpeechStopped { item_id: "u1".into() }]
        );
        assert!(parse(r#"{"type":"rate_limits.updated"}"#).is_empty());
        assert!(parse("not json").is_empty());
    }

    #[test]
    fn hides_errors_about_soft_events() {
        assert!(parse(r#"{"type":"error","error":{"message":"no active response","event_id":"soft-cancel"}}"#).is_empty());
        assert!(parse(r#"{"type":"error","error":{"message":"x","code":"response_cancel_not_active"}}"#).is_empty());
        // xAI: no code, no event id inside the error.
        assert!(parse(r#"{"type":"error","error":{"message":"Cancellation failed: no active response found"}}"#).is_empty());
        assert!(parse(r#"{"type":"error","event_id":"soft-cancel","error":{"message":"x"}}"#).is_empty());
        assert_eq!(
            parse(r#"{"type":"error","error":{"message":"Invalid voice"}}"#),
            vec![VoiceEvent::Error { message: "Invalid voice".into() }]
        );
    }

    #[test]
    fn interrupt_truncates_heard_audio() {
        let msgs = interrupt(Some("a1"), 1234);
        assert_eq!(msgs.len(), 2);
        let t: Value = serde_json::from_str(&msgs[1]).unwrap();
        assert_eq!(t["audio_end_ms"], 1234);
        assert_eq!(interrupt(None, 0).len(), 1);
    }
}
