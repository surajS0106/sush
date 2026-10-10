//! Provider-neutral conversation model.
//!
//! Messages are made of typed parts from day one so tool calling, reasoning
//! and images don't need a model change later. The shapes mirror AI SDK
//! `UIMessage` parts closely so the UI layer can map them 1:1.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Part {
    Text { text: String },
    Reasoning { text: String },
    /// Base64-encoded image data.
    Image { media_type: String, data: String },
    /// Base64-encoded document the model reads natively (PDF).
    Document { media_type: String, data: String, #[serde(default)] name: Option<String> },
    ToolCall { id: String, name: String, input: Value },
    ToolResult { call_id: String, output: Value, #[serde(default)] is_error: bool },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub parts: Vec<Part>,
}

impl Message {
    pub fn text(role: Role, text: impl Into<String>) -> Self {
        Self { role, parts: vec![Part::Text { text: text.into() }] }
    }

    /// All text parts joined; used by wire formats that only take strings.
    pub fn joined_text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|p| match p {
                Part::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f32>,
    /// Tools the model may call. The host decides what's offered and runs
    /// (or, for UI tools, asks the user) when a call comes back.
    #[serde(default)]
    pub tools: Vec<ToolSpec>,
    /// Let the model search and read the web with the provider's own server-side
    /// tools. Only Anthropic offers these; other formats ignore the flag.
    #[serde(default)]
    pub research: bool,
}

/// A tool definition: name, what it's for, and a JSON Schema for its input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FinishReason {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSource {
    pub url: String,
    pub title: Option<String>,
}

/// One streamed event, already normalised across providers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ChatEvent {
    TextDelta { delta: String },
    ReasoningDelta { delta: String },
    /// Incremental tool call. `id`/`name` arrive on the first delta for an index.
    ToolCallDelta { index: u32, id: Option<String>, name: Option<String>, args_delta: String },
    Usage { input_tokens: Option<u64>, output_tokens: Option<u64> },
    /// The provider ran one of its own tools (e.g. web search) mid-response.
    /// Informational: the host has nothing to execute.
    ServerToolCall { id: String, name: String, input: Value },
    /// Pages a server tool returned (search results, a fetched page).
    WebSources { call_id: String, sources: Vec<WebSource> },
    Finish { reason: FinishReason },
    Error { message: String },
}
