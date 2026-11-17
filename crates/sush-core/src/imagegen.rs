//! Image generation. A prompt goes in and one image's bytes come out.
//!
//! As with speech there's no single wire format, so the caller picks one:
//! `/images/generations` (OpenAI's gpt-image and DALL·E, Azure Foundry, xAI,
//! Ollama's image models, most OpenAI-compatible hosts), or chat completions
//! with `modalities: ["image", "text"]` (OpenRouter's image models, such as
//! Gemini's). Anthropic models don't output images.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::provider::{check_status, endpoint};
use crate::{ProviderConfig, ProviderError, WireFormat};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImageApi {
    /// `POST {base}/images/generations`.
    Images,
    /// `POST {base}/chat/completions` asking for image output.
    ChatModalities,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Aspect {
    Square,
    Landscape,
    Portrait,
}

impl Aspect {
    /// `size` for `/images/generations`. DALL·E 3 has its own wide sizes; DALL·E 2 only squares.
    fn size(self, model: &str) -> Option<&'static str> {
        let dalle3 = model.starts_with("dall-e-3");
        match self {
            Aspect::Square => Some("1024x1024"),
            _ if model.starts_with("dall-e-2") => None,
            Aspect::Landscape if dalle3 => Some("1792x1024"),
            Aspect::Portrait if dalle3 => Some("1024x1792"),
            Aspect::Landscape => Some("1536x1024"),
            Aspect::Portrait => Some("1024x1536"),
        }
    }

    /// `aspect_ratio` for xAI's `/images/generations`.
    fn xai_ratio(self) -> &'static str {
        match self {
            Aspect::Square => "1:1",
            Aspect::Landscape => "4:3",
            Aspect::Portrait => "3:4",
        }
    }

    /// `image_config.aspect_ratio` for chat completions (OpenRouter).
    fn ratio(self) -> &'static str {
        match self {
            Aspect::Square => "1:1",
            Aspect::Landscape => "3:2",
            Aspect::Portrait => "2:3",
        }
    }
}

/// gpt-image's `quality`: how much detail it renders, and how long it takes.
/// `xhigh` and `max` only exist on gpt-image-2.6 and later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Quality {
    Auto,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// Partial images gpt-image streams before the final one (0–3; each costs about
/// 100 extra output tokens). The most it allows: OpenAI may send fewer, or none,
/// when "the full image is generated more quickly".
const PARTIAL_IMAGES: u8 = 3;
/// JPEG quality for gpt-image output: far smaller than its default PNG, and
/// faster, with no visible loss at this setting.
const JPEG_COMPRESSION: u8 = 90;

/// OpenAI's gpt-image family, the models that take `quality`, `output_format` and streaming.
fn is_gpt_image(model: &str) -> bool {
    model.rsplit('/').next().unwrap_or(model).starts_with("gpt-image")
}

#[derive(Debug, Clone)]
pub struct GeneratedImage {
    pub bytes: Vec<u8>,
    /// The prompt the provider actually used, when it rewrote ours (DALL·E 3).
    pub revised_prompt: Option<String>,
    /// Tokens billed, when the provider says (OpenAI's gpt-image), for the cost.
    pub usage: Option<ImageUsage>,
}

/// gpt-image's `usage`, split the way it's priced: text and image input, image (and text) output.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageUsage {
    pub input_text_tokens: u64,
    pub input_image_tokens: u64,
    pub output_image_tokens: u64,
    pub output_text_tokens: u64,
}

/// Read `usage` from an images response or its stream's `completed` event. Without the
/// details, input counts as text (a prompt) and output as image.
fn image_usage(v: &Value) -> Option<ImageUsage> {
    let usage = v.get("usage").filter(|u| u.is_object())?;
    let n = |path: &str| usage.pointer(path).and_then(Value::as_u64);
    let input = n("/input_tokens").unwrap_or(0);
    let output = n("/output_tokens").unwrap_or(0);
    let input_image = n("/input_tokens_details/image_tokens").unwrap_or(0);
    let output_text = n("/output_tokens_details/text_tokens").unwrap_or(0);
    Some(ImageUsage {
        input_text_tokens: n("/input_tokens_details/text_tokens").unwrap_or(input.saturating_sub(input_image)),
        input_image_tokens: input_image,
        output_image_tokens: n("/output_tokens_details/image_tokens").unwrap_or(output.saturating_sub(output_text)),
        output_text_tokens: output_text,
    })
}

/// Generate one image of `prompt` with `model` on the provider `cfg`. With
/// `on_partial`, OpenAI's gpt-image streams rough versions as it goes, each
/// handed over as soon as it arrives; other models just return the final image.
#[allow(clippy::too_many_arguments)]
pub async fn generate_image(
    cfg: &ProviderConfig,
    secret: Option<String>,
    http: &reqwest::Client,
    model: &str,
    api: ImageApi,
    prompt: &str,
    aspect: Option<Aspect>,
    quality: Option<Quality>,
    on_partial: Option<&(dyn Fn(Vec<u8>) + Send + Sync)>,
) -> Result<GeneratedImage, ProviderError> {
    if cfg.format == WireFormat::AnthropicMessages {
        return Err(ProviderError::Config(format!(
            "{}: Claude models don't generate images. Pick an OpenAI-compatible provider for images.",
            cfg.name
        )));
    }
    let ep = endpoint(cfg, secret)?;
    let (image, revised_prompt, usage) = match api {
        ImageApi::Images => {
            let mut body = json!({ "model": model, "prompt": prompt, "n": 1 });
            // xAI takes `aspect_ratio` rather than OpenAI's pixel `size`.
            if cfg.base_url.contains("api.x.ai") {
                if let Some(a) = aspect {
                    body["aspect_ratio"] = a.xai_ratio().into();
                }
            } else if let Some(size) = aspect.and_then(|a| a.size(model)) {
                body["size"] = size.into();
            }
            // gpt-image always answers in base64; JPEG keeps that a fraction of PNG's size.
            let gpt_image = is_gpt_image(model);
            if gpt_image {
                if let Some(q) = quality {
                    body["quality"] = json!(q);
                }
                body["output_format"] = "jpeg".into();
                body["output_compression"] = JPEG_COMPRESSION.into();
            }
            // Streaming only where we know it's served: OpenAI's own API.
            let stream = gpt_image && on_partial.is_some() && cfg.base_url.contains("api.openai.com");
            if stream {
                body["stream"] = true.into();
                body["partial_images"] = PARTIAL_IMAGES.into();
            }
            let resp = ep.apply(http.post(ep.url("images/generations"))).json(&body).send().await.map_err(ProviderError::sending)?;
            let resp = check_status("image generation", resp).await?;
            if stream {
                let (bytes, usage) = streamed_image(resp, on_partial.expect("checked above")).await?;
                return Ok(GeneratedImage { bytes, revised_prompt: None, usage });
            }
            let body: Value = resp.json().await?;
            let usage = image_usage(&body);
            let first = body.pointer("/data/0").ok_or_else(|| ProviderError::Decode("image response has no `data`".into()))?;
            let revised = first.get("revised_prompt").and_then(Value::as_str).map(str::to_owned);
            (images_entry(first)?, revised, usage)
        }
        ImageApi::ChatModalities => {
            let mut body = json!({
                "model": model,
                "stream": false,
                "modalities": ["image", "text"],
                "messages": [{ "role": "user", "content": prompt }],
            });
            if let Some(a) = aspect {
                body["image_config"] = json!({ "aspect_ratio": a.ratio() });
            }
            let resp = ep.apply(http.post(ep.url("chat/completions"))).json(&body).send().await.map_err(ProviderError::sending)?;
            let body: Value = check_status("image generation", resp).await?.json().await?;
            (chat_image(&body)?, None, None)
        }
    };
    let bytes = match image {
        Image::Bytes(b) => b,
        Image::Url(url) => {
            let resp = http.get(&url).send().await.map_err(ProviderError::sending)?;
            check_status("image download", resp).await?.bytes().await?.to_vec()
        }
    };
    Ok(GeneratedImage { bytes, revised_prompt, usage })
}

/// Read a streamed `/images/generations` response: `image_generation.partial_image`
/// events go to `on_partial`, and `image_generation.completed` carries the final image.
async fn streamed_image(
    resp: reqwest::Response,
    on_partial: &(dyn Fn(Vec<u8>) + Send + Sync),
) -> Result<(Vec<u8>, Option<ImageUsage>), ProviderError> {
    use futures::StreamExt;
    let events = crate::sse::sse_events(resp.bytes_stream());
    futures::pin_mut!(events);
    while let Some(event) = events.next().await {
        let event = event?;
        if event.data.trim() == "[DONE]" {
            break;
        }
        match stream_event(&event.data)? {
            StreamEvent::Partial(bytes) => on_partial(bytes),
            StreamEvent::Done(bytes, usage) => return Ok((bytes, usage)),
            StreamEvent::Other => {}
        }
    }
    Err(ProviderError::Decode("the image stream ended without an image".into()))
}

#[derive(Debug, PartialEq)]
enum StreamEvent {
    Partial(Vec<u8>),
    Done(Vec<u8>, Option<ImageUsage>),
    Other,
}

fn stream_event(data: &str) -> Result<StreamEvent, ProviderError> {
    let v: Value = serde_json::from_str(data).map_err(|e| ProviderError::Decode(format!("image stream event: {e}")))?;
    if let Some(error) = v.get("error").filter(|e| !e.is_null()) {
        let message = error.get("message").and_then(Value::as_str).map_or_else(|| error.to_string(), str::to_owned);
        return Err(ProviderError::Stream(message));
    }
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    let image = || {
        v.get("b64_json")
            .and_then(Value::as_str)
            .ok_or_else(|| ProviderError::Decode(format!("`{kind}` has no `b64_json`")))
            .and_then(decode_b64)
    };
    // Dev builds name each event, to see what a provider actually streams.
    #[cfg(debug_assertions)]
    eprintln!(
        "sush: image stream event `{kind}`{}",
        v.get("partial_image_index").map_or(String::new(), |i| format!(" (partial {i})"))
    );
    Ok(match kind {
        "image_generation.completed" => StreamEvent::Done(image()?, image_usage(&v)),
        // `image_generation.partial_image`, and any other rough version a provider sends with a picture.
        k if k.contains("partial") && v.get("b64_json").is_some() => StreamEvent::Partial(image()?),
        _ => StreamEvent::Other,
    })
}

#[derive(Debug, PartialEq)]
enum Image {
    Bytes(Vec<u8>),
    Url(String),
}

fn decode_b64(s: &str) -> Result<Vec<u8>, ProviderError> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| ProviderError::Decode(format!("image is not valid base64: {e}")))
}

/// A `data:` URL's bytes, or the URL itself to download.
fn from_url(url: &str) -> Result<Image, ProviderError> {
    match url.strip_prefix("data:") {
        Some(rest) => {
            let (_, data) = rest.split_once(";base64,").ok_or_else(|| ProviderError::Decode("image data URL isn't base64".into()))?;
            Ok(Image::Bytes(decode_b64(data)?))
        }
        None => Ok(Image::Url(url.to_string())),
    }
}

/// One `data[]` entry of `/images/generations`: `b64_json` (gpt-image always) or `url` (DALL·E by default).
fn images_entry(v: &Value) -> Result<Image, ProviderError> {
    if let Some(b64) = v.get("b64_json").and_then(Value::as_str) {
        return Ok(Image::Bytes(decode_b64(b64)?));
    }
    match v.get("url").and_then(Value::as_str) {
        Some(url) => from_url(url),
        None => Err(ProviderError::Decode("image response has neither `b64_json` nor `url`".into())),
    }
}

/// The first image of a chat completion: OpenRouter puts them in `message.images[].image_url.url`.
fn chat_image(body: &Value) -> Result<Image, ProviderError> {
    let message = body.pointer("/choices/0/message").ok_or_else(|| ProviderError::Decode("response has no message".into()))?;
    if let Some(url) = message.pointer("/images/0/image_url/url").and_then(Value::as_str) {
        return from_url(url);
    }
    let said = message.get("content").and_then(Value::as_str).unwrap_or("").trim();
    Err(ProviderError::Decode(if said.is_empty() {
        "the model returned no image. Is it an image-output model?".into()
    } else {
        format!("the model returned no image, only text: {said}")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_b64_and_url_entries() {
        assert_eq!(images_entry(&json!({ "b64_json": "aGk=" })).unwrap(), Image::Bytes(b"hi".to_vec()));
        assert_eq!(
            images_entry(&json!({ "url": "https://x.test/a.png" })).unwrap(),
            Image::Url("https://x.test/a.png".into())
        );
        assert!(images_entry(&json!({})).is_err());
    }

    #[test]
    fn reads_openrouter_chat_images() {
        let body = json!({ "choices": [{ "message": {
            "content": "Here you go",
            "images": [{ "type": "image_url", "image_url": { "url": "data:image/png;base64,aGk=" } }],
        } }] });
        assert_eq!(chat_image(&body).unwrap(), Image::Bytes(b"hi".to_vec()));
        let text_only = json!({ "choices": [{ "message": { "content": "I can't draw" } }] });
        assert!(chat_image(&text_only).unwrap_err().to_string().contains("I can't draw"));
    }

    #[test]
    fn sizes_follow_the_model() {
        assert_eq!(Aspect::Landscape.size("gpt-image-1"), Some("1536x1024"));
        assert_eq!(Aspect::Portrait.size("dall-e-3"), Some("1024x1792"));
        assert_eq!(Aspect::Landscape.size("dall-e-2"), None);
        assert_eq!(Aspect::Square.size("dall-e-2"), Some("1024x1024"));
    }

    #[test]
    fn api_serialises_kebab_case() {
        assert_eq!(serde_json::to_value(ImageApi::ChatModalities).unwrap(), "chat-modalities");
        assert_eq!(serde_json::to_value(Aspect::Landscape).unwrap(), "landscape");
        assert_eq!(serde_json::to_value(Quality::Xhigh).unwrap(), "xhigh");
    }

    #[test]
    fn reads_usage_with_and_without_details() {
        let body = json!({ "usage": {
            "input_tokens": 50, "output_tokens": 60, "total_tokens": 110,
            "input_tokens_details": { "text_tokens": 10, "image_tokens": 40 },
            "output_tokens_details": { "image_tokens": 55, "text_tokens": 5 },
        } });
        let expected = ImageUsage { input_text_tokens: 10, input_image_tokens: 40, output_image_tokens: 55, output_text_tokens: 5 };
        assert_eq!(image_usage(&body), Some(expected));
        assert_eq!(image_usage(&json!({ "data": [] })), None);
    }

    #[test]
    fn knows_gpt_image_models() {
        assert!(is_gpt_image("gpt-image-2.6-sunburst"));
        assert!(is_gpt_image("openai/gpt-image-1"));
        assert!(!is_gpt_image("dall-e-3"));
        assert!(!is_gpt_image("grok-imagine-image"));
    }

    #[test]
    fn reads_stream_events() {
        let partial = r#"{"type":"image_generation.partial_image","b64_json":"aGk=","partial_image_index":0}"#;
        assert_eq!(stream_event(partial).unwrap(), StreamEvent::Partial(b"hi".to_vec()));
        let done = r#"{"type":"image_generation.completed","b64_json":"aGk=","usage":{"input_tokens":12,"output_tokens":1000}}"#;
        let usage = ImageUsage { input_text_tokens: 12, output_image_tokens: 1000, ..Default::default() };
        assert_eq!(stream_event(done).unwrap(), StreamEvent::Done(b"hi".to_vec(), Some(usage)));
        assert_eq!(stream_event(r#"{"type":"keepalive"}"#).unwrap(), StreamEvent::Other);
        let error = r#"{"type":"error","error":{"message":"blocked by moderation"}}"#;
        assert!(stream_event(error).unwrap_err().to_string().contains("blocked by moderation"));
    }
}
