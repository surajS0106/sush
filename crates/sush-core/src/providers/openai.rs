//! OpenAI Chat Completions wire format.
//!
//! Also spoken by Azure OpenAI / Foundry (`/openai/v1`), OpenRouter, Groq,
//! Ollama, LM Studio and vLLM.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::provider::{check_status, decode_response, Decoder, Endpoint, EventStream, ModelInfo, Provider};
use crate::sse::SseEvent;
use crate::{ChatEvent, ChatRequest, FinishReason, Message, Part, ProviderError, Role};

const NAME: &str = "OpenAI-compatible";

pub struct OpenAiProvider {
    endpoint: Endpoint,
    http: reqwest::Client,
}

impl OpenAiProvider {
    pub(crate) fn new(endpoint: Endpoint, http: reqwest::Client) -> Self {
        Self { endpoint, http }
    }
}

#[async_trait]
impl Provider for OpenAiProvider {
    async fn stream_chat(&self, req: ChatRequest) -> Result<EventStream, ProviderError> {
        let body = request_body(&req);
        let rb = self.http.post(self.endpoint.url("chat/completions")).json(&body);
        let resp = self.endpoint.apply(rb).send().await?;
        let resp = check_status(NAME, resp).await?;
        Ok(decode_response(resp, OpenAiDecoder::default()))
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let rb = self.http.get(self.endpoint.url("models"));
        let resp = check_status(NAME, self.endpoint.apply(rb).send().await?).await?;
        let v: Value = resp.json().await?;
        let mut models: Vec<ModelInfo> = v["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["id"].as_str())
                    .map(|id| ModelInfo { id: id.to_string(), display_name: None })
                    .collect()
            })
            .unwrap_or_default();
        models.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(models)
    }
}

pub(crate) fn request_body(req: &ChatRequest) -> Value {
    let mut messages = Vec::new();
    if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for m in &req.messages {
        push_message(&mut messages, m);
    }

    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(n) = req.max_tokens {
        body["max_tokens"] = json!(n);
    }
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| json!({
                "type": "function",
                "function": { "name": t.name, "description": t.description, "parameters": t.input_schema },
            }))
            .collect();
        body["tools"] = json!(tools);
    }
    body
}

fn push_message(out: &mut Vec<Value>, m: &Message) {
    let mut tool_results = Vec::new();
    match m.role {
        Role::System => out.push(json!({ "role": "system", "content": m.joined_text() })),
        Role::User => {
            let only_text = m.parts.iter().all(|p| matches!(p, Part::Text { .. } | Part::ToolResult { .. }));
            let mut content = Vec::new();
            for p in &m.parts {
                match p {
                    Part::Text { text } => content.push(json!({ "type": "text", "text": text })),
                    Part::Image { media_type, data } => content.push(json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{media_type};base64,{data}") },
                    })),
                    Part::Document { media_type, data, name } => content.push(json!({
                        "type": "file",
                        "file": {
                            "filename": name.as_deref().unwrap_or("document.pdf"),
                            "file_data": format!("data:{media_type};base64,{data}"),
                        },
                    })),
                    Part::ToolResult { .. } => tool_results.push(p),
                    _ => {}
                }
            }
            if !content.is_empty() {
                let content = if only_text { json!(m.joined_text()) } else { json!(content) };
                out.push(json!({ "role": "user", "content": content }));
            }
        }
        Role::Assistant => {
            let mut tool_calls = Vec::new();
            for p in &m.parts {
                match p {
                    Part::ToolCall { id, name, input } => tool_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": input.to_string() },
                    })),
                    Part::ToolResult { .. } => tool_results.push(p),
                    _ => {}
                }
            }
            let text = m.joined_text();
            let mut msg = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) } });
            if !tool_calls.is_empty() {
                msg["tool_calls"] = json!(tool_calls);
            }
            if !text.is_empty() || !tool_calls.is_empty() {
                out.push(msg);
            }
        }
    }
    // Tool results become their own `tool` messages, in order, after the call.
    for p in tool_results {
        if let Part::ToolResult { call_id, output, .. } = p {
            let content = output.as_str().map(str::to_owned).unwrap_or_else(|| output.to_string());
            out.push(json!({ "role": "tool", "tool_call_id": call_id, "content": content }));
        }
    }
}

#[derive(Default)]
pub(crate) struct OpenAiDecoder {
    done: bool,
    finished: bool,
}

impl Decoder for OpenAiDecoder {
    fn on_event(&mut self, ev: SseEvent) -> Result<Vec<ChatEvent>, ProviderError> {
        let data = ev.data.trim();
        if data == "[DONE]" {
            self.done = true;
            return Ok(vec![]);
        }
        if data.is_empty() {
            return Ok(vec![]);
        }
        let chunk: Value = serde_json::from_str(data)?;
        if let Some(err) = chunk.get("error") {
            let msg = err["message"].as_str().map(str::to_owned).unwrap_or_else(|| err.to_string());
            return Err(ProviderError::Stream(msg));
        }

        let mut out = Vec::new();
        if let Some(choice) = chunk["choices"].get(0) {
            let delta = &choice["delta"];
            // DeepSeek/vLLM use `reasoning_content`; OpenRouter/Ollama use `reasoning`.
            for key in ["reasoning_content", "reasoning"] {
                if let Some(r) = delta[key].as_str().filter(|s| !s.is_empty()) {
                    out.push(ChatEvent::ReasoningDelta { delta: r.to_string() });
                }
            }
            if let Some(text) = delta["content"].as_str().filter(|s| !s.is_empty()) {
                out.push(ChatEvent::TextDelta { delta: text.to_string() });
            }
            for tc in delta["tool_calls"].as_array().into_iter().flatten() {
                out.push(ChatEvent::ToolCallDelta {
                    index: tc["index"].as_u64().unwrap_or(0) as u32,
                    id: tc["id"].as_str().map(str::to_owned),
                    name: tc["function"]["name"].as_str().map(str::to_owned),
                    args_delta: tc["function"]["arguments"].as_str().unwrap_or_default().to_string(),
                });
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                self.finished = true;
                out.push(ChatEvent::Finish { reason: map_finish(reason) });
            }
        }
        if let Some(usage) = chunk.get("usage").filter(|u| u.is_object()) {
            out.push(ChatEvent::Usage {
                input_tokens: usage["prompt_tokens"].as_u64(),
                output_tokens: usage["completion_tokens"].as_u64(),
            });
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

fn map_finish(reason: &str) -> FinishReason {
    match reason {
        "stop" => FinishReason::Stop,
        "length" => FinishReason::Length,
        "tool_calls" | "function_call" => FinishReason::ToolCalls,
        "content_filter" => FinishReason::ContentFilter,
        _ => FinishReason::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::test_util::{decode_all, text};
    use crate::ToolSpec;

    // Trimmed from a real gpt-4o-mini stream with include_usage.
    const BASIC: &str = r#"data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}

data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}],"usage":null}

data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" there!"},"finish_reason":null}],"usage":null}

data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}

data: {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}

data: [DONE]

"#;

    #[test]
    fn decodes_text_finish_and_usage() {
        let evs = decode_all(OpenAiDecoder::default(), BASIC);
        assert_eq!(text(&evs), "Hello there!");
        assert!(evs.contains(&ChatEvent::Finish { reason: FinishReason::Stop }));
        assert!(evs.contains(&ChatEvent::Usage { input_tokens: Some(9), output_tokens: Some(3) }));
        assert_eq!(evs.iter().filter(|e| matches!(e, ChatEvent::Finish { .. })).count(), 1);
    }

    #[test]
    fn decodes_tool_calls_and_reasoning() {
        let body = r#"data: {"choices":[{"index":0,"delta":{"reasoning":"think"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
"#;
        let evs = decode_all(OpenAiDecoder::default(), body);
        assert_eq!(evs[0], ChatEvent::ReasoningDelta { delta: "think".into() });
        assert_eq!(
            evs[1],
            ChatEvent::ToolCallDelta { index: 0, id: Some("call_1".into()), name: Some("read_file".into()), args_delta: "".into() }
        );
        assert_eq!(evs[2], ChatEvent::ToolCallDelta { index: 0, id: None, name: None, args_delta: "{\"path\":".into() });
        assert_eq!(evs[3], ChatEvent::Finish { reason: FinishReason::ToolCalls });
    }

    #[test]
    fn mid_stream_error_is_surfaced() {
        let mut d = OpenAiDecoder::default();
        let ev = SseEvent { event: None, data: r#"{"error":{"message":"rate limited"}}"#.into() };
        assert!(matches!(d.on_event(ev), Err(ProviderError::Stream(m)) if m == "rate limited"));
    }

    #[test]
    fn truncated_stream_still_finishes() {
        let body = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}\n\n";
        let evs = decode_all(OpenAiDecoder::default(), body);
        assert_eq!(evs.last(), Some(&ChatEvent::Finish { reason: FinishReason::Other }));
    }

    #[test]
    fn request_body_maps_system_text_images_and_tools() {
        let req = ChatRequest {
            model: "gpt-x".into(),
            system: Some("be brief".into()),
            max_tokens: None,
            temperature: None,
            tools: vec![ToolSpec {
                name: "ask_user".into(),
                description: "Ask the user".into(),
                input_schema: json!({"type": "object"}),
            }],
            research: false,
            messages: vec![
                Message::text(Role::User, "hi"),
                Message {
                    role: Role::User,
                    parts: vec![
                        Part::Text { text: "what is this?".into() },
                        Part::Image { media_type: "image/png".into(), data: "AAA".into() },
                    ],
                },
                Message {
                    role: Role::Assistant,
                    parts: vec![
                        Part::ToolCall { id: "c1".into(), name: "ls".into(), input: json!({"dir": "."}) },
                        Part::ToolResult { call_id: "c1".into(), output: json!("a.txt"), is_error: false },
                    ],
                },
            ],
        };
        let body = request_body(&req);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0], json!({"role": "system", "content": "be brief"}));
        assert_eq!(msgs[1], json!({"role": "user", "content": "hi"}));
        assert_eq!(msgs[2]["content"][1]["image_url"]["url"], "data:image/png;base64,AAA");
        assert_eq!(msgs[3]["tool_calls"][0]["function"]["arguments"], "{\"dir\":\".\"}");
        assert_eq!(msgs[3]["content"], Value::Null);
        assert_eq!(msgs[4], json!({"role": "tool", "tool_call_id": "c1", "content": "a.txt"}));
        assert_eq!(body["stream"], true);
        assert!(body.get("max_tokens").is_none());
        assert_eq!(
            body["tools"][0],
            json!({"type": "function", "function": {"name": "ask_user", "description": "Ask the user", "parameters": {"type": "object"}}})
        );
    }

    #[test]
    fn request_body_omits_tools_when_none_offered() {
        let req = ChatRequest {
            model: "gpt-x".into(),
            messages: vec![Message::text(Role::User, "hi")],
            system: None,
            max_tokens: None,
            temperature: None,
            tools: vec![],
            research: false,
        };
        assert!(request_body(&req).get("tools").is_none());
    }
}
