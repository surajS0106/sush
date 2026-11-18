//! Voice mode: a hands-free spoken conversation with a model, on the user's
//! own key for one of four voice providers.
//!
//! Two kinds of conversation:
//! - **Realtime** (OpenAI, xAI Grok): one speech-to-speech model over a
//!   WebSocket. Both speak the same event protocol (`realtime.rs`), with the
//!   server detecting turns and the user interrupting by talking. The host
//!   owns the socket; this module only builds and reads its JSON.
//! - **Turn by turn** (Sarvam, ElevenLabs): the host detects the end of the
//!   user's turn, then the clip is transcribed, a chat model answers, and the
//!   answer is spoken sentence by sentence (`cascade.rs`).

pub mod cascade;
pub mod realtime;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceProvider {
    Openai,
    Xai,
    Sarvam,
    Elevenlabs,
}

impl VoiceProvider {
    pub const ALL: [VoiceProvider; 4] = [Self::Openai, Self::Xai, Self::Sarvam, Self::Elevenlabs];

    pub fn id(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Xai => "xai",
            Self::Sarvam => "sarvam",
            Self::Elevenlabs => "elevenlabs",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Openai => "OpenAI",
            Self::Xai => "xAI",
            Self::Sarvam => "Sarvam",
            Self::Elevenlabs => "ElevenLabs",
        }
    }

    /// Speech to speech over one socket, or transcribe → answer → speak.
    pub fn realtime(self) -> bool {
        matches!(self, Self::Openai | Self::Xai)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Gender {
    Female,
    Male,
    Neutral,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub gender: Gender,
    /// A few words on how it sounds.
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModel {
    pub id: String,
    pub name: String,
    pub description: String,
}

fn voice(id: &str, name: &str, gender: Gender, description: &str) -> VoiceInfo {
    VoiceInfo { id: id.into(), name: name.into(), gender, description: description.into() }
}

fn model(id: &str, name: &str, description: &str) -> VoiceModel {
    VoiceModel { id: id.into(), name: name.into(), description: description.into() }
}

/// The voices each provider ships with. ElevenLabs adds the account's own
/// voices on top (`cascade::elevenlabs_voices`).
pub fn builtin_voices(provider: VoiceProvider) -> Vec<VoiceInfo> {
    use Gender::*;
    match provider {
        VoiceProvider::Openai => vec![
            voice("marin", "Marin", Female, "Natural, clear, the most lifelike"),
            voice("cedar", "Cedar", Male, "Natural, warm, the most lifelike"),
            voice("coral", "Coral", Female, "Bright and friendly"),
            voice("sage", "Sage", Female, "Calm and thoughtful"),
            voice("shimmer", "Shimmer", Female, "Soft and gentle"),
            voice("ash", "Ash", Male, "Confident and direct"),
            voice("ballad", "Ballad", Male, "Expressive, British"),
            voice("echo", "Echo", Male, "Even and steady"),
            voice("verse", "Verse", Male, "Lively and versatile"),
            voice("alloy", "Alloy", Neutral, "Balanced and neutral"),
        ],
        VoiceProvider::Xai => vec![
            voice("ara", "Ara", Female, "Warm and friendly"),
            voice("atlas", "Atlas", Male, "Kind and gentle"),
            voice("aurora", "Aurora", Female, "Bright and intelligent"),
            voice("carina", "Carina", Female, "Cheery and calm"),
            voice("eve", "Eve", Female, "Energetic and upbeat"),
            voice("leo", "Leo", Male, "Authoritative and strong"),
            voice("naksh", "Naksh", Male, "Mellow and steady"),
            voice("rex", "Rex", Male, "Confident and clear"),
            voice("sal", "Sal", Neutral, "Smooth and balanced"),
        ],
        // Bulbul v3 speakers. Sarvam doesn't label them; these follow the names.
        VoiceProvider::Sarvam => {
            let female = [
                "ritu", "priya", "neha", "pooja", "simran", "kavya", "ishita", "shreya", "roopa", "tanya", "shruti", "suhani",
                "kavitha", "rupali",
            ];
            let male = [
                "shubh", "aditya", "rahul", "rohan", "amit", "dev", "ratan", "varun", "manan", "sumit", "kabir", "aayan",
                "ashutosh", "advait", "anand", "tarun", "sunny", "mani", "gokul", "vijay", "mohit", "rehan", "soham",
            ];
            let title = |s: &str| s[..1].to_uppercase() + &s[1..];
            let mut out = vec![voice("shubh", "Shubh", Male, "Sarvam's default, Indian English and Hindi")];
            out.extend(female.iter().map(|s| voice(s, &title(s), Female, "Indian, speaks 11 languages")));
            out.extend(male.iter().skip(1).map(|s| voice(s, &title(s), Male, "Indian, speaks 11 languages")));
            out
        }
        // ElevenLabs' default voices, there for every account.
        VoiceProvider::Elevenlabs => vec![
            voice("EXAVITQu4vr4xnSDxMaL", "Sarah", Female, "Soft, young, American"),
            voice("FGY2WhTYpPnrIDTdsKH5", "Laura", Female, "Upbeat, American"),
            voice("Xb7hH8MSUJpSbSDYk0k2", "Alice", Female, "Confident, British"),
            voice("XrExE9yKIg1WjnnlVkGX", "Matilda", Female, "Friendly, American"),
            voice("cgSgspJ2msm6clMCkdW9", "Jessica", Female, "Expressive, American"),
            voice("pFZP5JQG7iQjIQuC4Bku", "Lily", Female, "Warm, British"),
            voice("JBFqnCBsd6RMkjVDRZzb", "George", Male, "Warm, British"),
            voice("CwhRBWXzGAHq8TQ4Fs17", "Roger", Male, "Confident, American"),
            voice("IKne3meq5aSn9XLyUdCD", "Charlie", Male, "Natural, Australian"),
            voice("TX3LPaxmHKxFdv7VOQHJ", "Liam", Male, "Articulate, American"),
            voice("nPczCjzI2devNBz1zQrb", "Brian", Male, "Deep, American"),
            voice("onwK4e9ZLuTAKqWW03F9", "Daniel", Male, "Authoritative, British"),
            voice("SAz9YHcvj6GT2YYXdXww", "River", Neutral, "Relaxed, American"),
        ],
    }
}

/// The models offered when the provider can't be asked for its own list.
/// For realtime providers it's the conversation model; for the others, the
/// speech (text to speech) model.
pub fn builtin_models(provider: VoiceProvider) -> Vec<VoiceModel> {
    match provider {
        VoiceProvider::Openai => vec![
            model("gpt-realtime", "GPT Realtime", "OpenAI's speech-to-speech model"),
            model("gpt-realtime-mini", "GPT Realtime mini", "Faster and cheaper"),
        ],
        VoiceProvider::Xai => vec![
            model("grok-voice-latest", "Grok Voice", "xAI's newest voice agent"),
            model("grok-voice-3.0", "Grok Voice 3.0", "Pinned, doesn't change under you"),
        ],
        VoiceProvider::Sarvam => vec![model("bulbul:v3", "Bulbul v3", "11 languages: 10 Indian, plus English")],
        VoiceProvider::Elevenlabs => vec![
            model("eleven_flash_v2_5", "Flash v2.5", "Fastest replies, 32 languages"),
            model("eleven_turbo_v2_5", "Turbo v2.5", "Fast, a little richer"),
            model("eleven_multilingual_v2", "Multilingual v2", "Most natural, slower"),
            model("eleven_v3", "Eleven v3", "Most expressive, slowest"),
        ],
    }
}

/// Sarvam's own chat models, for a Sarvam conversation that thinks with Sarvam.
pub const SARVAM_CHAT_MODEL: &str = "sarvam-105b";

/// What a realtime conversation tells the host, which passes it on to the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum VoiceEvent {
    /// The session is set up; audio can flow.
    Ready,
    /// The server heard the user start talking: stop playing the answer.
    SpeechStarted,
    /// The user stopped talking; an answer is coming. `item_id` is the item
    /// their words will be transcribed into, when the server says (empty if not).
    SpeechStopped { item_id: String },
    /// What the user said, as it's transcribed (`done` once it's final).
    UserTranscript { item_id: String, text: String, done: bool },
    /// A slice of the answer's audio: 24 kHz 16-bit mono PCM, base64.
    Audio { item_id: String, data: String },
    /// More of the answer's words (`text` is a delta unless `done`, when it's the whole).
    AssistantTranscript { item_id: String, text: String, done: bool },
    /// The answer finished: `completed`, or `cancelled` when the user cut in.
    ResponseDone { status: String },
    Error { message: String },
    /// The connection closed.
    Closed { reason: Option<String> },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_has_voices_and_models() {
        for p in VoiceProvider::ALL {
            assert!(!builtin_voices(p).is_empty(), "{p:?}");
            assert!(!builtin_models(p).is_empty(), "{p:?}");
        }
    }

    #[test]
    fn sarvam_voices_are_unique() {
        let voices = builtin_voices(VoiceProvider::Sarvam);
        let mut ids: Vec<_> = voices.iter().map(|v| v.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), voices.len());
    }

    #[test]
    fn event_serialises_for_the_ui() {
        let e = VoiceEvent::UserTranscript { item_id: "i".into(), text: "hi".into(), done: true };
        assert_eq!(serde_json::to_value(e).unwrap(), serde_json::json!({ "type": "user-transcript", "itemId": "i", "text": "hi", "done": true }));
        assert_eq!(serde_json::to_value(VoiceProvider::Elevenlabs).unwrap(), "elevenlabs");
    }
}
