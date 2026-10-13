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

    /// `image_config.aspect_ratio` for chat completions (OpenRouter).
    fn ratio(self) -> &'static str {
        match self {
            Aspect::Square => "1:1",
            Aspect::Landscape => "3:2",
            Aspect::Portrait => "2:3",
        }
    }
}

#[derive(Debug, Clone)]
pub struct GeneratedImage {
    pub bytes: Vec<u8>,
    /// The prompt the provider actually used, when it rewrote ours (DALL·E 3).
    pub revised_prompt: Option<String>,
}

/// Generate one image of `prompt` with `model` on the provider `cfg`.
pub async fn generate_image(
    cfg: &ProviderConfig,
    secret: Option<String>,
    http: &reqwest::Client,
    model: &str,
    api: ImageApi,
    prompt: &str,
    aspect: Option<Aspect>,
) -> Result<GeneratedImage, ProviderError> {
    if cfg.format == WireFormat::AnthropicMessages {
        return Err(ProviderError::Config(format!(
            "{}: Claude models don't generate images. Pick an OpenAI-compatible provider for images.",
            cfg.name
        )));
    }
    let ep = endpoint(cfg, secret)?;
    let (image, revised_prompt) = match api {
        ImageApi::Images => {
            let mut body = json!({ "model": model, "prompt": prompt, "n": 1 });
            if let Some(size) = aspect.and_then(|a| a.size(model)) {
                body["size"] = size.into();
            }
            let resp = ep.apply(http.post(ep.url("images/generations"))).json(&body).send().await.map_err(ProviderError::sending)?;
            let body: Value = check_status("image generation", resp).await?.json().await?;
            let first = body.pointer("/data/0").ok_or_else(|| ProviderError::Decode("image response has no `data`".into()))?;
            let revised = first.get("revised_prompt").and_then(Value::as_str).map(str::to_owned);
            (images_entry(first)?, revised)
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
            (chat_image(&body)?, None)
        }
    };
    let bytes = match image {
        Image::Bytes(b) => b,
        Image::Url(url) => {
            let resp = http.get(&url).send().await.map_err(ProviderError::sending)?;
            check_status("image download", resp).await?.bytes().await?.to_vec()
        }
    };
    Ok(GeneratedImage { bytes, revised_prompt })
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
    }
}
