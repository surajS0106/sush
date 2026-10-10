//! Anthropic Messages wire format.
//!
//! Spoken by Anthropic directly and by Claude on Microsoft Foundry.

use std::collections::HashMap;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::provider::{check_status, decode_response, Decoder, Endpoint, EventStream, ModelInfo, Provider};
use crate::sse::SseEvent;
use crate::{ChatEvent, ChatRequest, FinishReason, Part, ProviderError, Role, WebSource};

const NAME: &str = "Anthropic";
const API_VERSION: &str = "2023-06-01";
/// `max_tokens` is required by the Messages API.
const DEFAULT_MAX_TOKENS: u32 = 8192;

pub struct AnthropicProvider {
    endpoint: Endpoint,
    http: reqwest::Client,
}

impl AnthropicProvider {
    pub(crate) fn new(endpoint: Endpoint, http: reqwest::Client) -> Self {
        Self { endpoint, http }
    }

    fn request(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        self.endpoint.apply(rb.header("anthropic-version", API_VERSION))
    }
}

#[async_trait]
impl Provider for AnthropicProvider {
    async fn stream_chat(&self, req: ChatRequest) -> Result<EventStream, ProviderError> {
        let body = request_body(&req);
        let resp = self.request(self.http.post(self.endpoint.url("messages")).json(&body)).send().await?;
        let resp = check_status(NAME, resp).await?;
        Ok(decode_response(resp, AnthropicDecoder::default()))
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let resp = self.request(self.http.get(self.endpoint.url("models?limit=1000"))).send().await?;
        let v: Value = check_status(NAME, resp).await?.json().await?;
        Ok(v["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| {
                        Some(ModelInfo {
                            id: m["id"].as_str()?.to_string(),
                            display_name: m["display_name"].as_str().map(str::to_owned),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
}

pub(crate) fn request_body(req: &ChatRequest) -> Value {
    // System prompts live outside `messages`; fold any system-role messages in.
    let mut system: Vec<String> = req.system.iter().filter(|s| !s.is_empty()).cloned().collect();
    let mut messages: Vec<(Role, Vec<Value>)> = Vec::new();

    let mut push = |role: Role, blocks: Vec<Value>| {
        if blocks.is_empty() {
            return;
        }
        // The API wants alternating turns; merge consecutive same-role messages.
        match messages.last_mut() {
            Some((r, existing)) if *r == role => existing.extend(blocks),
            _ => messages.push((role, blocks)),
        }
    };

    for m in &req.messages {
        if m.role == Role::System {
            system.push(m.joined_text());
            continue;
        }
        let mut blocks = Vec::new();
        let mut results = Vec::new();
        for p in &m.parts {
            match p {
                Part::Text { text } if !text.is_empty() => blocks.push(json!({ "type": "text", "text": text })),
                Part::Image { media_type, data } => blocks.push(json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": media_type, "data": data },
                })),
                Part::Document { media_type, data, name } => {
                    let mut block = json!({
                        "type": "document",
                        "source": { "type": "base64", "media_type": media_type, "data": data },
                    });
                    if let Some(name) = name {
                        block["title"] = json!(name);
                    }
                    blocks.push(block)
                }
                Part::ToolCall { id, name, input } => {
                    blocks.push(json!({ "type": "tool_use", "id": id, "name": name, "input": input }))
                }
                Part::ToolResult { call_id, output, is_error } => {
                    let content = output.as_str().map(str::to_owned).unwrap_or_else(|| output.to_string());
                    let block = json!({ "type": "tool_result", "tool_use_id": call_id, "content": content, "is_error": is_error });
                    // Tool results must be sent from the user side.
                    if m.role == Role::User { blocks.push(block) } else { results.push(block) }
                }
                // Thinking blocks need their signature to be replayed; drop them.
                _ => {}
            }
        }
        push(m.role, blocks);
        push(Role::User, results);
    }

    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "stream": true,
        "messages": messages
            .into_iter()
            .map(|(role, content)| json!({ "role": role, "content": content }))
            .collect::<Vec<_>>(),
    });
    if !system.is_empty() {
        body["system"] = json!(system.join("\n\n"));
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    // These models think on every request but stream empty thinking text
    // unless asked for a summary. Requesting it changes visibility only, not
    // how much they think. Older models are left alone: there, sending
    // `thinking` would switch it on or be rejected.
    if thinks_by_default(&req.model) {
        body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
    }
    let mut tools: Vec<Value> = req
        .tools
        .iter()
        .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.input_schema }))
        .collect();
    if req.research {
        // The 20260209 versions filter results with code before they reach the
        // context window; models without dynamic filtering get the basic ones.
        let (search, fetch) = if has_dynamic_web_tools(&req.model) {
            ("web_search_20260209", "web_fetch_20260209")
        } else {
            ("web_search_20250305", "web_fetch_20250910")
        };
        tools.push(json!({ "type": search, "name": "web_search" }));
        tools.push(json!({ "type": fetch, "name": "web_fetch" }));
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    body
}

/// `(family, major, minor)` from ids like `claude-opus-4-6` or Bedrock's
/// `anthropic.claude-opus-5-5`. Minor is 0 when absent (`claude-opus-5`) or a date.
fn claude_version(model: &str) -> Option<(&str, u32, u32)> {
    let rest = &model[model.find("claude-")? + "claude-".len()..];
    let mut parts = rest.split('-');
    let family = parts.next()?;
    if !matches!(family, "opus" | "sonnet" | "haiku" | "fable" | "mythos") {
        return None;
    }
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|m| m.parse().ok()).filter(|&m| m < 100).unwrap_or(0);
    Some((family, major, minor))
}

/// Claude generation 5 and later (`claude-opus-5-5`, `claude-haiku-5-5`, ...)
/// always think.
fn thinks_by_default(model: &str) -> bool {
    claude_version(model).is_some_and(|(_, major, _)| major >= 5)
}

/// Opus/Sonnet 4.6+ and Fable/Mythos support the dynamic-filtering web tools.
fn has_dynamic_web_tools(model: &str) -> bool {
    match claude_version(model) {
        Some(("opus" | "sonnet", major, minor)) => (major, minor) >= (4, 6),
        Some(("fable" | "mythos", _, _)) => true,
        _ => false,
    }
}

#[derive(Default)]
pub(crate) struct AnthropicDecoder {
    input_tokens: Option<u64>,
    /// Content-block index -> our tool-call index.
    tool_blocks: HashMap<u64, u32>,
    /// Content-block index -> (id, name, input JSON so far) for server-run tools.
    server_blocks: HashMap<u64, (String, String, String)>,
    finished: bool,
    done: bool,
}

impl Decoder for AnthropicDecoder {
    fn on_event(&mut self, ev: SseEvent) -> Result<Vec<ChatEvent>, ProviderError> {
        if ev.data.trim().is_empty() {
            return Ok(vec![]);
        }
        let v: Value = serde_json::from_str(&ev.data)?;
        let mut out = Vec::new();
        match v["type"].as_str().unwrap_or_default() {
            "message_start" => self.input_tokens = v["message"]["usage"]["input_tokens"].as_u64(),
            "content_block_start" => {
                let block = &v["content_block"];
                match block["type"].as_str() {
                    Some("tool_use") => {
                        let index = self.tool_blocks.len() as u32;
                        self.tool_blocks.insert(v["index"].as_u64().unwrap_or(0), index);
                        out.push(ChatEvent::ToolCallDelta {
                            index,
                            id: block["id"].as_str().map(str::to_owned),
                            name: block["name"].as_str().map(str::to_owned),
                            args_delta: String::new(),
                        });
                    }
                    Some("text") => {
                        if let Some(t) = block["text"].as_str().filter(|t| !t.is_empty()) {
                            out.push(ChatEvent::TextDelta { delta: t.to_string() });
                        }
                    }
                    Some("server_tool_use") => {
                        let id = block["id"].as_str().unwrap_or_default().to_string();
                        let name = block["name"].as_str().unwrap_or_default().to_string();
                        // Input usually streams as deltas, but may arrive whole.
                        let input = match &block["input"] {
                            Value::Object(o) if !o.is_empty() => block["input"].to_string(),
                            _ => String::new(),
                        };
                        self.server_blocks.insert(v["index"].as_u64().unwrap_or(0), (id, name, input));
                    }
                    Some("web_search_tool_result" | "web_fetch_tool_result") => {
                        let call_id = block["tool_use_id"].as_str().unwrap_or_default().to_string();
                        let sources = web_sources(&block["content"]);
                        if !sources.is_empty() {
                            out.push(ChatEvent::WebSources { call_id, sources });
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some((id, name, input)) = self.server_blocks.remove(&v["index"].as_u64().unwrap_or(0)) {
                    let input = serde_json::from_str(&input).unwrap_or(Value::Object(Default::default()));
                    out.push(ChatEvent::ServerToolCall { id, name, input });
                }
            }
            "content_block_delta" => {
                let delta = &v["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        out.push(ChatEvent::TextDelta { delta: delta["text"].as_str().unwrap_or_default().to_string() })
                    }
                    // Empty when the model's thinking display is omitted.
                    Some("thinking_delta") => {
                        if let Some(t) = delta["thinking"].as_str().filter(|t| !t.is_empty()) {
                            out.push(ChatEvent::ReasoningDelta { delta: t.to_string() });
                        }
                    }
                    Some("input_json_delta") => {
                        let block = v["index"].as_u64().unwrap_or(0);
                        if let Some((_, _, input)) = self.server_blocks.get_mut(&block) {
                            input.push_str(delta["partial_json"].as_str().unwrap_or_default());
                        } else if let Some(&index) = self.tool_blocks.get(&block) {
                            out.push(ChatEvent::ToolCallDelta {
                                index,
                                id: None,
                                name: None,
                                args_delta: delta["partial_json"].as_str().unwrap_or_default().to_string(),
                            });
                        }
                    }
                    _ => {} // signature_delta, citations, ...
                }
            }
            "message_delta" => {
                if let Some(output) = v["usage"]["output_tokens"].as_u64() {
                    out.push(ChatEvent::Usage { input_tokens: self.input_tokens, output_tokens: Some(output) });
                }
                if let Some(reason) = v["delta"]["stop_reason"].as_str() {
                    self.finished = true;
                    out.push(ChatEvent::Finish { reason: map_finish(reason) });
                }
            }
            "message_stop" => self.done = true,
            "error" => {
                let msg = v["error"]["message"].as_str().unwrap_or("unknown error").to_string();
                return Err(ProviderError::Stream(msg));
            }
            _ => {} // ping
        }
        Ok(out)
    }

    fn is_done(&self) -> bool {
        self.done
    }

    fn finish(&mut self) -> Vec<ChatEvent> {
        if self.finished {
            vec![]
        } else {
            vec![ChatEvent::Finish { reason: FinishReason::Other }]
        }
    }
}

/// Pages from a web search result list or a single fetched page. Error results
/// (an object with `error_code`) yield nothing.
fn web_sources(content: &Value) -> Vec<WebSource> {
    let source = |v: &Value| {
        let url = v["url"].as_str()?.to_string();
        let title = v["title"].as_str().or_else(|| v["content"]["title"].as_str()).map(str::to_owned);
        Some(WebSource { url, title })
    };
    match content {
        Value::Array(results) => results.iter().filter_map(source).collect(),
        Value::Object(_) => source(content).into_iter().collect(),
        _ => vec![],
    }
}

fn map_finish(reason: &str) -> FinishReason {
    match reason {
        "end_turn" | "stop_sequence" | "pause_turn" => FinishReason::Stop,
        "max_tokens" => FinishReason::Length,
        "tool_use" => FinishReason::ToolCalls,
        "refusal" => FinishReason::ContentFilter,
        _ => FinishReason::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::test_util::{decode_all, text};
    use crate::{Message, ToolSpec};

    const BASIC: &str = r#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-x","usage":{"input_tokens":12,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Hmm."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" world"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15}}

event: message_stop
data: {"type":"message_stop"}

"#;

    #[test]
    fn decodes_thinking_text_usage_and_finish() {
        let evs = decode_all(AnthropicDecoder::default(), BASIC);
        assert_eq!(evs[0], ChatEvent::ReasoningDelta { delta: "Hmm.".into() });
        assert_eq!(text(&evs), "Hello world");
        assert!(evs.contains(&ChatEvent::Usage { input_tokens: Some(12), output_tokens: Some(15) }));
        assert_eq!(evs.last(), Some(&ChatEvent::Finish { reason: FinishReason::Stop }));
    }

    #[test]
    fn decodes_tool_use() {
        let body = r#"event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}

event: message_stop
data: {"type":"message_stop"}
"#;
        let evs = decode_all(AnthropicDecoder::default(), body);
        assert_eq!(
            evs[0],
            ChatEvent::ToolCallDelta { index: 0, id: Some("toolu_1".into()), name: Some("get_weather".into()), args_delta: "".into() }
        );
        assert_eq!(evs[1], ChatEvent::ToolCallDelta { index: 0, id: None, name: None, args_delta: "{\"city\":".into() });
        assert_eq!(evs.last(), Some(&ChatEvent::Finish { reason: FinishReason::ToolCalls }));
    }

    #[test]
    fn stream_error_event_is_surfaced() {
        let mut d = AnthropicDecoder::default();
        let ev = SseEvent {
            event: Some("error".into()),
            data: r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#.into(),
        };
        assert!(matches!(d.on_event(ev), Err(ProviderError::Stream(m)) if m == "Overloaded"));
    }

    #[test]
    fn request_body_folds_system_merges_turns_and_moves_tool_results() {
        let req = ChatRequest {
            model: "claude-x".into(),
            system: Some("be brief".into()),
            max_tokens: None,
            temperature: Some(0.2),
            tools: vec![ToolSpec {
                name: "ask_user".into(),
                description: "Ask the user".into(),
                input_schema: json!({"type": "object"}),
            }],
            research: false,
            messages: vec![
                Message::text(Role::System, "extra rules"),
                Message::text(Role::User, "a"),
                Message::text(Role::User, "b"),
                Message {
                    role: Role::Assistant,
                    parts: vec![
                        Part::Reasoning { text: "dropped".into() },
                        Part::ToolCall { id: "t1".into(), name: "ls".into(), input: json!({}) },
                        Part::ToolResult { call_id: "t1".into(), output: json!("ok"), is_error: false },
                    ],
                },
            ],
        };
        let body = request_body(&req);
        assert_eq!(body["system"], "be brief\n\nextra rules");
        assert_eq!(body["max_tokens"], DEFAULT_MAX_TOKENS);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"].as_array().unwrap().len(), 2);
        assert_eq!(msgs[1]["content"], json!([{"type": "tool_use", "id": "t1", "name": "ls", "input": {}}]));
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(
            body["tools"],
            json!([{"name": "ask_user", "description": "Ask the user", "input_schema": {"type": "object"}}])
        );
    }

    #[test]
    fn requests_thinking_summaries_only_where_thinking_is_always_on() {
        for model in ["claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5", "claude-fable-5-1", "anthropic.claude-opus-5-5"] {
            assert!(thinks_by_default(model), "{model}");
        }
        for model in ["claude-opus-4-8", "claude-haiku-4-5", "claude-3-7-sonnet-latest", "gpt-5", "my-deployment"] {
            assert!(!thinks_by_default(model), "{model}");
        }
        let req = |model: &str| ChatRequest {
            model: model.into(),
            messages: vec![Message::text(Role::User, "hi")],
            system: None,
            max_tokens: None,
            temperature: None,
            tools: vec![],
            research: false,
        };
        assert_eq!(request_body(&req("claude-opus-5-5"))["thinking"], json!({"type": "adaptive", "display": "summarized"}));
        assert!(request_body(&req("claude-opus-4-8")).get("thinking").is_none());
    }

    #[test]
    fn empty_thinking_deltas_are_dropped() {
        let mut d = AnthropicDecoder::default();
        let ev = |thinking: &str| SseEvent {
            event: Some("content_block_delta".into()),
            data: json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": thinking}}).to_string(),
        };
        assert_eq!(d.on_event(ev("")).unwrap(), vec![]);
        assert_eq!(d.on_event(ev("hmm")).unwrap(), vec![ChatEvent::ReasoningDelta { delta: "hmm".into() }]);
    }
    #[test]
    fn research_adds_web_tools_matching_the_model() {
        let req = |model: &str| ChatRequest {
            model: model.into(),
            messages: vec![Message::text(Role::User, "news?")],
            system: None,
            max_tokens: None,
            temperature: None,
            tools: vec![],
            research: true,
        };
        let types = |model: &str| -> Vec<String> {
            request_body(&req(model))["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["type"].as_str().unwrap().to_owned())
                .collect()
        };
        assert_eq!(types("claude-opus-5-5"), ["web_search_20260209", "web_fetch_20260209"]);
        assert_eq!(types("claude-sonnet-4-6"), ["web_search_20260209", "web_fetch_20260209"]);
        assert_eq!(types("claude-haiku-5-5"), ["web_search_20250305", "web_fetch_20250910"]);
        assert_eq!(types("claude-opus-4-5-20251101"), ["web_search_20250305", "web_fetch_20250910"]);
    }

    #[test]
    fn documents_become_document_blocks() {
        let req = ChatRequest {
            model: "claude-opus-5-5".into(),
            messages: vec![Message {
                role: Role::User,
                parts: vec![Part::Document {
                    media_type: "application/pdf".into(),
                    data: "JVBE".into(),
                    name: Some("spec.pdf".into()),
                }],
            }],
            system: None,
            max_tokens: None,
            temperature: None,
            tools: vec![],
            research: false,
        };
        let block = &request_body(&req)["messages"][0]["content"][0];
        assert_eq!(block["type"], "document");
        assert_eq!(block["title"], "spec.pdf");
        assert_eq!(block["source"]["media_type"], "application/pdf");
    }

    #[test]
    fn decodes_server_web_search_as_activity_not_a_client_tool_call() {
        let body = r#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\": \"rust mcp\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","url":"https://a.dev","title":"A","encrypted_content":"x"},{"type":"web_search_result","url":"https://b.dev","title":"B","encrypted_content":"y"}]}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}
"#;
        let evs = decode_all(AnthropicDecoder::default(), body);
        assert_eq!(
            evs[0],
            ChatEvent::ServerToolCall { id: "srvtoolu_1".into(), name: "web_search".into(), input: json!({"query": "rust mcp"}) }
        );
        assert_eq!(
            evs[1],
            ChatEvent::WebSources {
                call_id: "srvtoolu_1".into(),
                sources: vec![
                    WebSource { url: "https://a.dev".into(), title: Some("A".into()) },
                    WebSource { url: "https://b.dev".into(), title: Some("B".into()) },
                ],
            }
        );
        assert!(!evs.iter().any(|e| matches!(e, ChatEvent::ToolCallDelta { .. })));
    }
}
