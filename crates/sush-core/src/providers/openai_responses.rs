//! OpenAI Responses wire format, used by `OpenAiProvider` for the models that
//! can't reason and call tools on Chat Completions.
//!
//! Stateless: `store` is off, so nothing stays on OpenAI's side and every request
//! carries the conversation, as with the other formats. Reasoning continues across
//! tool calls by sending back the encrypted items the model returned.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::provider::Decoder;
use crate::sse::SseEvent;
use crate::{ChatEvent, ChatRequest, FinishReason, Message, Part, ProviderError, Role};

/// Models sent here instead of Chat Completions. A router's prefixed id
/// (`openai/gpt-5.6-sol`) stays on Chat Completions: its Responses support varies.
/// Keep in step with `openaiCaps` in `lib/reasoning.ts`.
pub(crate) fn uses_responses(model: &str) -> bool {
    let id = model.to_ascii_lowercase();
    id.starts_with("gpt-5.6") || id.starts_with("gpt-6")
}

pub(crate) fn request_body(req: &ChatRequest) -> Value {
    let mut body = json!({
        "model": req.model,
        "input": input_items(&req.messages),
        "stream": true,
        "store": false,
        "include": ["reasoning.encrypted_content"],
    });
    if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
        body["instructions"] = json!(system);
    }
    if let Some(n) = req.max_tokens {
        body["max_output_tokens"] = json!(n);
    }
    // `temperature` stays out: these models reject it while reasoning, and GPT-6 and later always do.
    if req.thinking == Some(false) {
        body["reasoning"] = json!({ "effort": "none" });
    } else {
        body["reasoning"] = json!({ "summary": "auto" });
        if let Some(effort) = req.effort {
            body["reasoning"]["effort"] = json!(effort);
        }
    }
    if !req.tools.is_empty() {
        // `strict` left out would have the API tighten schemas written without it in mind.
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| json!({ "type": "function", "name": t.name, "description": t.description, "parameters": t.input_schema, "strict": false }))
            .collect();
        body["tools"] = json!(tools);
    }
    body
}

/// Reasoning summaries can need a verified organization. Replies matter more
/// than showing the summary, so a request refused for that goes again without it.
pub(crate) fn rejects_summary(status: u16, message: &str) -> bool {
    status == 400 && message.contains("summar")
}

pub(crate) fn drop_summary(body: &mut Value) {
    if let Some(reasoning) = body["reasoning"].as_object_mut() {
        reasoning.remove("summary");
    }
}

fn input_items(messages: &[Message]) -> Vec<Value> {
    // Reasoning only needs to carry through the current turn's tool calls.
    let turn_start = messages.iter().rposition(|m| m.role == Role::User);
    let mut out = Vec::new();
    for (i, m) in messages.iter().enumerate() {
        match m.role {
            Role::System => out.push(json!({ "role": "system", "content": m.joined_text() })),
            Role::User => push_user(&mut out, m),
            Role::Assistant => push_assistant(&mut out, m, turn_start.map_or(true, |start| i > start)),
        }
    }
    out
}

fn push_user(out: &mut Vec<Value>, m: &Message) {
    let mut content = Vec::new();
    let mut outputs = Vec::new();
    for p in &m.parts {
        match p {
            Part::Text { text } => content.push(json!({ "type": "input_text", "text": text })),
            Part::Image { media_type, data } => {
                content.push(json!({ "type": "input_image", "image_url": format!("data:{media_type};base64,{data}") }))
            }
            Part::Document { media_type, data, name } => content.push(json!({
                "type": "input_file",
                "filename": name.as_deref().unwrap_or("document.pdf"),
                "file_data": format!("data:{media_type};base64,{data}"),
            })),
            Part::ToolResult { call_id, output, .. } => outputs.push(tool_output(call_id, output)),
            _ => {}
        }
    }
    if !content.is_empty() {
        out.push(json!({ "role": "user", "content": content }));
    }
    out.append(&mut outputs);
}

fn push_assistant(out: &mut Vec<Value>, m: &Message, replay_reasoning: bool) {
    // Calls first, then their results, so a reasoning item sits right before its call.
    let mut outputs = Vec::new();
    for (i, p) in m.parts.iter().enumerate() {
        match p {
            Part::Text { text } => {
                out.append(&mut outputs);
                out.push(json!({ "role": "assistant", "content": text }));
            }
            Part::Reasoning { item: Some(item), .. } if replay_reasoning && leads_to_call(&m.parts[i + 1..]) => {
                out.append(&mut outputs);
                out.push(item.clone());
            }
            // No `id`: with `store` off, the API would then look for the call's original pairing.
            Part::ToolCall { id, name, input } => {
                out.push(json!({ "type": "function_call", "call_id": id, "name": name, "arguments": input.to_string() }))
            }
            Part::ToolResult { call_id, output, .. } => outputs.push(tool_output(call_id, output)),
            _ => {}
        }
    }
    out.append(&mut outputs);
}

/// The API refuses a reasoning item without the output it led to, which a stopped
/// reply can leave behind.
fn leads_to_call(rest: &[Part]) -> bool {
    matches!(rest.iter().find(|p| !matches!(p, Part::Reasoning { .. })), Some(Part::ToolCall { .. }))
}

fn tool_output(call_id: &str, output: &Value) -> Value {
    let output = output.as_str().map(str::to_owned).unwrap_or_else(|| output.to_string());
    json!({ "type": "function_call_output", "call_id": call_id, "output": output })
}

#[derive(Default)]
pub(crate) struct ResponsesDecoder {
    /// The stream's `output_index` -> our tool-call index.
    tools: HashMap<u64, u32>,
    done: bool,
}

impl Decoder for ResponsesDecoder {
    fn on_event(&mut self, ev: SseEvent) -> Result<Vec<ChatEvent>, ProviderError> {
        if ev.data.trim().is_empty() {
            return Ok(vec![]);
        }
        let v: Value = serde_json::from_str(&ev.data)?;
        let delta = || v["delta"].as_str().unwrap_or_default().to_string();
        let mut out = Vec::new();
        match v["type"].as_str().unwrap_or_default() {
            "response.output_text.delta" | "response.refusal.delta" => out.push(ChatEvent::TextDelta { delta: delta() }),
            "response.reasoning_summary_text.delta" => out.push(ChatEvent::ReasoningDelta { delta: delta() }),
            "response.reasoning_summary_part.added" if v["summary_index"].as_u64().unwrap_or(0) > 0 => {
                out.push(ChatEvent::ReasoningDelta { delta: "\n\n".into() })
            }
            "response.output_item.added" if v["item"]["type"] == "function_call" => {
                let index = self.tools.len() as u32;
                self.tools.insert(v["output_index"].as_u64().unwrap_or(0), index);
                out.push(ChatEvent::ToolCallDelta {
                    index,
                    id: v["item"]["call_id"].as_str().map(str::to_owned),
                    name: v["item"]["name"].as_str().map(str::to_owned),
                    args_delta: String::new(),
                });
            }
            "response.function_call_arguments.delta" => {
                if let Some(&index) = v["output_index"].as_u64().and_then(|i| self.tools.get(&i)) {
                    out.push(ChatEvent::ToolCallDelta { index, id: None, name: None, args_delta: delta() });
                }
            }
            "response.output_item.done" if v["item"]["type"] == "reasoning" && v["item"]["encrypted_content"].is_string() => {
                out.push(ChatEvent::ReasoningItem { item: v["item"].clone() });
            }
            "response.completed" | "response.incomplete" => {
                self.done = true;
                let response = &v["response"];
                let reason = match response["incomplete_details"]["reason"].as_str() {
                    Some("max_output_tokens") => FinishReason::Length,
                    Some("content_filter") => FinishReason::ContentFilter,
                    Some(_) => FinishReason::Other,
                    None if self.tools.is_empty() => FinishReason::Stop,
                    None => FinishReason::ToolCalls,
                };
                out.push(ChatEvent::Finish { reason });
                if let Some(usage) = response.get("usage").filter(|u| u.is_object()) {
                    out.push(ChatEvent::Usage {
                        input_tokens: usage["input_tokens"].as_u64(),
                        output_tokens: usage["output_tokens"].as_u64(),
                    });
                }
            }
            "response.failed" => {
                let message = v["response"]["error"]["message"].as_str().unwrap_or("The model couldn't finish this response.");
                return Err(ProviderError::Stream(message.to_string()));
            }
            "error" => {
                let message = v["message"].as_str().or_else(|| v["error"]["message"].as_str()).unwrap_or("Unknown error");
                return Err(ProviderError::Stream(message.to_string()));
            }
            _ => {}
        }
        Ok(out)
    }

    fn is_done(&self) -> bool {
        self.done
    }

    fn finish(&mut self) -> Vec<ChatEvent> {
        if self.done {
            vec![]
        } else {
            vec![ChatEvent::Finish { reason: FinishReason::Other }]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::test_util::{decode_all, text};
    use crate::{Effort, ToolSpec};

    fn request(messages: Vec<Message>) -> ChatRequest {
        ChatRequest {
            model: "gpt-5.6-sol".into(),
            messages,
            system: Some("be brief".into()),
            max_tokens: None,
            temperature: None,
            tools: vec![ToolSpec { name: "ls".into(), description: "List".into(), input_schema: json!({"type": "object"}) }],
            research: false,
            thinking: None,
            effort: None,
        }
    }

    #[test]
    fn routes_only_the_models_that_need_it() {
        for model in ["gpt-5.6-sol", "gpt-5.6-luna", "GPT-6-sol", "gpt-6.1-terra", "gpt-6-astra"] {
            assert!(uses_responses(model), "{model}");
        }
        for model in ["gpt-5.5", "gpt-5", "o3", "openai/gpt-5.6-sol", "llama3"] {
            assert!(!uses_responses(model), "{model}");
        }
    }

    #[test]
    fn body_is_stateless_and_sends_thinking_choices() {
        let mut req = request(vec![Message::text(Role::User, "hi")]);
        let body = request_body(&req);
        assert_eq!(body["store"], false);
        assert_eq!(body["instructions"], "be brief");
        assert_eq!(body["reasoning"], json!({ "summary": "auto" }));
        assert_eq!(body["input"][0]["content"][0], json!({ "type": "input_text", "text": "hi" }));
        assert_eq!(body["tools"][0]["name"], "ls");
        assert_eq!(body["tools"][0]["strict"], false);

        req.effort = Some(Effort::Max);
        assert_eq!(request_body(&req)["reasoning"]["effort"], "max");

        req.thinking = Some(false);
        assert_eq!(request_body(&req)["reasoning"], json!({ "effort": "none" }));
    }

    #[test]
    fn summary_refusal_is_recognised_and_removed() {
        assert!(rejects_summary(400, "Your organization must be verified to generate reasoning summaries."));
        assert!(!rejects_summary(400, "Unsupported value for reasoning.effort"));
        assert!(!rejects_summary(500, "reasoning summaries"));
        let mut body = request_body(&request(vec![]));
        drop_summary(&mut body);
        assert_eq!(body["reasoning"], json!({}));
    }

    #[test]
    fn replays_reasoning_only_for_this_turns_tool_calls() {
        let item = |id: &str| json!({ "type": "reasoning", "id": id, "encrypted_content": "x" });
        let reasoning = |id: &str| Part::Reasoning { text: "".into(), item: Some(item(id)) };
        let call = |id: &str| Part::ToolCall { id: id.into(), name: "ls".into(), input: json!({"dir": "."}) };
        let result = |id: &str| Part::ToolResult { call_id: id.into(), output: json!("a.txt"), is_error: false };
        let body = request_body(&request(vec![
            Message { role: Role::Assistant, parts: vec![reasoning("old"), call("c0"), result("c0")] },
            Message::text(Role::User, "next"),
            Message { role: Role::Assistant, parts: vec![reasoning("now"), call("c1"), result("c1"), call("c2"), result("c2")] },
            // Stopped before an output: can't be sent back.
            Message { role: Role::Assistant, parts: vec![reasoning("stopped")] },
        ]));
        let types: Vec<String> = body["input"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["type"].as_str().or(i["role"].as_str()).unwrap().to_string())
            .collect();
        assert_eq!(
            types,
            ["function_call", "function_call_output", "user", "reasoning", "function_call", "function_call", "function_call_output", "function_call_output"]
        );
        assert_eq!(body["input"][3]["id"], "now");
        assert_eq!(body["input"][4], json!({ "type": "function_call", "call_id": "c1", "name": "ls", "arguments": "{\"dir\":\".\"}" }));
        assert_eq!(body["input"][6], json!({ "type": "function_call_output", "call_id": "c1", "output": "a.txt" }));
    }

    #[test]
    fn decodes_reasoning_text_tools_and_usage() {
        let body = r#"data: {"type":"response.created","response":{"id":"r1"}}

data: {"type":"response.reasoning_summary_part.added","summary_index":0}

data: {"type":"response.reasoning_summary_text.delta","delta":"First"}

data: {"type":"response.reasoning_summary_part.added","summary_index":1}

data: {"type":"response.reasoning_summary_text.delta","delta":"Second"}

data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"abc","summary":[]}}

data: {"type":"response.output_text.delta","delta":"Hi"}

data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"ls","arguments":""}}

data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":2,"delta":"{\"dir\":"}

data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":9,"output_tokens":3}}}

"#;
        let evs = decode_all(ResponsesDecoder::default(), body);
        assert_eq!(evs[0], ChatEvent::ReasoningDelta { delta: "First".into() });
        assert_eq!(evs[1], ChatEvent::ReasoningDelta { delta: "\n\n".into() });
        assert!(matches!(&evs[3], ChatEvent::ReasoningItem { item } if item["id"] == "rs_1"));
        assert_eq!(text(&evs), "Hi");
        assert!(evs.contains(&ChatEvent::ToolCallDelta { index: 0, id: Some("call_1".into()), name: Some("ls".into()), args_delta: "".into() }));
        assert!(evs.contains(&ChatEvent::ToolCallDelta { index: 0, id: None, name: None, args_delta: "{\"dir\":".into() }));
        assert!(evs.contains(&ChatEvent::Finish { reason: FinishReason::ToolCalls }));
        assert!(evs.contains(&ChatEvent::Usage { input_tokens: Some(9), output_tokens: Some(3) }));
    }

    #[test]
    fn reports_failures_and_cut_off_replies() {
        let mut d = ResponsesDecoder::default();
        let ev = SseEvent { event: None, data: r#"{"type":"response.failed","response":{"error":{"message":"overloaded"}}}"#.into() };
        assert!(matches!(d.on_event(ev), Err(ProviderError::Stream(m)) if m == "overloaded"));

        let body = "data: {\"type\":\"response.incomplete\",\"response\":{\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n";
        let evs = decode_all(ResponsesDecoder::default(), body);
        assert_eq!(evs, [ChatEvent::Finish { reason: FinishReason::Length }]);

        let evs = decode_all(ResponsesDecoder::default(), "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n");
        assert_eq!(evs.last(), Some(&ChatEvent::Finish { reason: FinishReason::Other }));
    }
}
