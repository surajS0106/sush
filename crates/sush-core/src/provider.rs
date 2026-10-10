//! The `Provider` trait and how a stored provider config becomes one.
//!
//! A provider is *wire format × endpoint × credential*: Azure OpenAI and
//! OpenRouter both speak `OpenAiChat`, Claude on Foundry speaks
//! `AnthropicMessages`, and so on. Adding a new endpoint that speaks an
//! existing format needs no code, only a config.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};

use crate::providers::{anthropic::AnthropicProvider, openai::OpenAiProvider};
use crate::sse::{sse_events, SseEvent};
use crate::{ChatEvent, ChatRequest, ProviderError};

pub type EventStream = Pin<Box<dyn Stream<Item = Result<ChatEvent, ProviderError>> + Send>>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: Option<String>,
}

#[async_trait]
pub trait Provider: Send + Sync {
    /// Start a streaming completion. Dropping the returned stream aborts the
    /// underlying HTTP request, which is how cancellation works.
    async fn stream_chat(&self, req: ChatRequest) -> Result<EventStream, ProviderError>;

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WireFormat {
    OpenaiChat,
    AnthropicMessages,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum AuthKind {
    /// Local servers (Ollama, LM Studio).
    None,
    /// Secret stored by the host app. `header` overrides the format's default
    /// (`Authorization: Bearer` for OpenAI, `x-api-key` for Anthropic); Azure
    /// uses `api-key`.
    ApiKey { header: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub format: WireFormat,
    pub base_url: String,
    pub auth: AuthKind,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Model ids the user pinned by hand. Needed for endpoints that can't list
    /// models, e.g. Azure deployments.
    #[serde(default)]
    pub models: Vec<String>,
}

/// Resolved connection details shared by every wire format.
#[derive(Debug, Clone)]
pub(crate) struct Endpoint {
    pub base_url: String,
    /// (header name, value) pairs applied to every request, auth included.
    pub headers: Vec<(String, String)>,
}

impl Endpoint {
    pub fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base_url.trim_end_matches('/'), path.trim_start_matches('/'))
    }

    pub fn apply(&self, mut rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        for (k, v) in &self.headers {
            rb = rb.header(k, v);
        }
        rb
    }
}

/// Build a provider from config plus the secret the host app looked up.
pub fn build_provider(
    cfg: &ProviderConfig,
    secret: Option<String>,
    http: reqwest::Client,
) -> Result<Arc<dyn Provider>, ProviderError> {
    let endpoint = endpoint(cfg, secret)?;
    Ok(match cfg.format {
        WireFormat::OpenaiChat => Arc::new(OpenAiProvider::new(endpoint, http)),
        WireFormat::AnthropicMessages => Arc::new(AnthropicProvider::new(endpoint, http)),
    })
}

/// Base URL plus headers (auth included) for a provider config.
pub(crate) fn endpoint(cfg: &ProviderConfig, secret: Option<String>) -> Result<Endpoint, ProviderError> {
    if cfg.base_url.trim().is_empty() {
        return Err(ProviderError::Config(format!("{}: base URL is empty", cfg.name)));
    }
    let mut headers: Vec<(String, String)> = cfg.headers.clone().into_iter().collect();
    if let AuthKind::ApiKey { header } = &cfg.auth {
        let key = secret
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ProviderError::Config(format!("{}: no API key set", cfg.name)))?;
        headers.push(match (header.as_deref(), cfg.format) {
            (Some(h), _) if h.eq_ignore_ascii_case("authorization") => (h.to_string(), format!("Bearer {key}")),
            (Some(h), _) => (h.to_string(), key),
            (None, WireFormat::OpenaiChat) => ("authorization".into(), format!("Bearer {key}")),
            (None, WireFormat::AnthropicMessages) => ("x-api-key".into(), key),
        });
    }
    Ok(Endpoint { base_url: cfg.base_url.clone(), headers })
}

/// Starting points for the "Add provider" UI. `{resource}` placeholders are
/// filled in by the user.
pub fn presets() -> Vec<ProviderConfig> {
    let p = |id: &str, name: &str, format, base_url: &str, auth| ProviderConfig {
        id: id.into(),
        name: name.into(),
        format,
        base_url: base_url.into(),
        auth,
        headers: BTreeMap::new(),
        models: vec![],
    };
    let key = || AuthKind::ApiKey { header: None };
    let azure_key = || AuthKind::ApiKey { header: Some("api-key".into()) };
    use WireFormat::*;
    vec![
        p("openai", "OpenAI", OpenaiChat, "https://api.openai.com/v1", key()),
        p("anthropic", "Anthropic", AnthropicMessages, "https://api.anthropic.com/v1", key()),
        p(
            "azure-openai",
            "Azure OpenAI / Foundry",
            OpenaiChat,
            "https://{resource}.openai.azure.com/openai/v1",
            azure_key(),
        ),
        p(
            "azure-anthropic",
            "Claude on Microsoft Foundry",
            AnthropicMessages,
            "https://{resource}.services.ai.azure.com/anthropic/v1",
            azure_key(),
        ),
        p("openrouter", "OpenRouter", OpenaiChat, "https://openrouter.ai/api/v1", key()),
        p("groq", "Groq", OpenaiChat, "https://api.groq.com/openai/v1", key()),
        p("ollama", "Ollama (local)", OpenaiChat, "http://localhost:11434/v1", AuthKind::None),
        p("lmstudio", "LM Studio (local)", OpenaiChat, "http://localhost:1234/v1", AuthKind::None),
        p("custom-openai", "Custom (OpenAI-compatible)", OpenaiChat, "", key()),
        p("custom-anthropic", "Custom (Anthropic-compatible)", AnthropicMessages, "", key()),
    ]
}

/// A wire format's stateful translation from SSE events to `ChatEvent`s.
/// Kept free of I/O so it can be tested against recorded streams.
pub(crate) trait Decoder: Send + 'static {
    fn on_event(&mut self, ev: SseEvent) -> Result<Vec<ChatEvent>, ProviderError>;
    fn is_done(&self) -> bool;
    /// Events to emit once the byte stream ends (e.g. a missing finish).
    fn finish(&mut self) -> Vec<ChatEvent> {
        vec![]
    }
}

pub(crate) fn decode_response<D: Decoder>(resp: reqwest::Response, mut decoder: D) -> EventStream {
    let events = sse_events(resp.bytes_stream());
    Box::pin(async_stream::try_stream! {
        futures::pin_mut!(events);
        while let Some(ev) = events.next().await {
            for out in decoder.on_event(ev?)? {
                yield out;
            }
            if decoder.is_done() {
                break;
            }
        }
        for out in decoder.finish() {
            yield out;
        }
    })
}

/// Turn a non-2xx response into a readable error, pulling `error.message`
/// out of the JSON body when there is one.
pub(crate) async fn check_status(
    provider: &'static str,
    resp: reqwest::Response,
) -> Result<reqwest::Response, ProviderError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("message"))
                .or_else(|| v.get("error"))
                .and_then(|m| m.as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| if body.is_empty() { status.to_string() } else { body });
    Err(ProviderError::Http { provider, status: status.as_u16(), message })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(format: WireFormat, auth: AuthKind) -> ProviderConfig {
        ProviderConfig {
            id: "x".into(),
            name: "X".into(),
            format,
            base_url: "https://example.com/v1/".into(),
            auth,
            headers: BTreeMap::new(),
            models: vec![],
        }
    }

    #[test]
    fn missing_key_is_a_config_error() {
        let c = cfg(WireFormat::OpenaiChat, AuthKind::ApiKey { header: None });
        assert!(matches!(build_provider(&c, None, reqwest::Client::new()), Err(ProviderError::Config(_))));
    }

    #[test]
    fn no_auth_needs_no_key() {
        let c = cfg(WireFormat::OpenaiChat, AuthKind::None);
        assert!(build_provider(&c, None, reqwest::Client::new()).is_ok());
    }

    #[test]
    fn endpoint_url_joins_cleanly() {
        let e = Endpoint { base_url: "https://example.com/v1/".into(), headers: vec![] };
        assert_eq!(e.url("/chat/completions"), "https://example.com/v1/chat/completions");
    }

    #[test]
    fn config_round_trips_as_camel_case_json() {
        let c = cfg(WireFormat::AnthropicMessages, AuthKind::ApiKey { header: Some("api-key".into()) });
        let json = serde_json::to_value(&c).unwrap();
        assert_eq!(json["format"], "anthropic-messages");
        assert_eq!(json["baseUrl"], "https://example.com/v1/");
        assert_eq!(json["auth"], serde_json::json!({"type": "api-key", "header": "api-key"}));
        assert_eq!(serde_json::from_value::<ProviderConfig>(json).unwrap(), c);
    }
}
