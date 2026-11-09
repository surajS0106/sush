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
    Reasoning {
        text: String,
        /// The provider's own record of this reasoning, sent back as it came so the
        /// model can carry on from it across tool calls (OpenAI Responses).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item: Option<Value>,
    },
    /// Base64-encoded image data.
    Image { media_type: String, data: String },
    /// Base64-encoded document the model reads natively (PDF).
    Document { media_type: String, data: String, #[serde(default)] name: Option<String> },
    ToolCall { id: String, name: String, input: Value },
    ToolResult { call_id: String, output: Value, #[serde(default)] is_error: bool },
}

/// A tool output made of passages the model can cite: an object with these
/// passages under `SEARCH_RESULTS` and the same passages as plain text under
/// `"text"`. Anthropic gets them as `search_result` blocks, so its citations
/// point at them; every other format gets the text (`tool_output_text`).
pub const SEARCH_RESULTS: &str = "searchResults";
/// A line to the model beside the passages of a `SEARCH_RESULTS` output (it's
/// also in `"text"`); Anthropic gets it as a text block after them.
pub const SEARCH_NOTE: &str = "note";

/// One citable passage in a `SEARCH_RESULTS` tool output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchResult {
    /// What a citation of it points at (a `sushsrc:` URL).
    pub source: String,
    pub title: String,
    pub text: String,
}

/// A tool output as text, for wire formats that only take strings.
pub fn tool_output_text(output: &Value) -> String {
    if let Some(s) = output.as_str() {
        return s.to_owned();
    }
    if output.get(SEARCH_RESULTS).is_some() {
        if let Some(text) = output.get("text").and_then(Value::as_str) {
            return text.to_owned();
        }
    }
    output.to_string()
}

/// The passages of a `SEARCH_RESULTS` tool output, if it is one.
pub fn search_results(output: &Value) -> Option<Vec<SearchResult>> {
    serde_json::from_value(output.get(SEARCH_RESULTS)?.clone()).ok()
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
    /// Turn the model's thinking on or off. None keeps its default.
    #[serde(default)]
    pub thinking: Option<bool>,
    /// How hard the model works. None keeps its default. The UI only offers what
    /// the model accepts (`lib/reasoning.ts`).
    #[serde(default)]
    pub effort: Option<Effort>,
}

/// The levels both wire formats share. "Off" is `thinking: false`, not a level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
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
    /// A finished reasoning record to send back later. Not shown: its summary, if
    /// any, came as `ReasoningDelta`s.
    ReasoningItem { item: Value },
    /// Incremental tool call. `id`/`name` arrive on the first delta for an index.
    ToolCallDelta { index: u32, id: Option<String>, name: Option<String>, args_delta: String },
    /// `input_tokens` is everything the model read, cached or not; `cached_input_tokens`
    /// the part of it served from the provider's prompt cache (billed at a fraction).
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cached_input_tokens: Option<u64>,
    },
    /// The provider ran one of its own tools (e.g. web search) mid-response.
    /// Informational: the host has nothing to execute.
    ServerToolCall { id: String, name: String, input: Value },
    /// Pages a server tool returned (search results, a fetched page).
    WebSources { call_id: String, sources: Vec<WebSource> },
    /// The text streamed since the previous citation (or text start) is backed
    /// by this page, or by a notebook passage (`crate::notebooks`, a `sushsrc:`
    /// URL). Arrives right after the cited text. `quote` is the exact text
    /// cited, when the provider says.
    Citation {
        url: String,
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        quote: Option<String>,
    },
    Finish { reason: FinishReason },
    Error { message: String },
}
