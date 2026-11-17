//! Image generation for the `image_generate` tool: the provider and model the
//! user picked in Settings → Images make the image, and it's kept as a blob.

use base64::Engine;
use serde::Serialize;
use sush_core::{generate_image, Aspect, AuthKind, ImageApi, ImageUsage, Quality};
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::state::AppState;
use crate::store::{blocking, sniff_image};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    /// The `sushblob:` URL the image is served on.
    pub url: String,
    pub media_type: String,
    pub revised_prompt: Option<String>,
    /// Tokens billed (OpenAI's gpt-image), for the card's cost.
    pub usage: Option<ImageUsage>,
}

/// Make an image. Rough versions the model streams on the way (OpenAI's
/// gpt-image) go to `on_partial` as `data:` URLs, for the card to show until
/// the image is done; they aren't kept.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn image_generate(
    state: State<'_, AppState>,
    provider_id: String,
    model: String,
    api: ImageApi,
    prompt: String,
    aspect: Option<Aspect>,
    quality: Option<Quality>,
    // Always passed: a `Channel` can't be an optional command argument.
    on_partial: Channel<String>,
) -> AppResult<GeneratedImage> {
    let cfg = state.provider(&provider_id).ok_or_else(|| AppError::NotFound(format!("provider {provider_id} not found")))?;
    let secret = match cfg.auth {
        AuthKind::ApiKey { .. } => secrets::get(&cfg.id)?,
        AuthKind::None => None,
    };
    let partial = move |bytes: Vec<u8>| {
        let Some(media_type) = sniff_image(&bytes) else { return };
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let _ = on_partial.send(format!("data:{media_type};base64,{data}"));
    };
    let image = generate_image(&cfg, secret, &state.http, &model, api, &prompt, aspect, quality, Some(&partial)).await?;
    let media_type = sniff_image(&image.bytes).ok_or_else(|| AppError::Invalid("The provider didn't return an image.".into()))?;
    let store = state.store.clone();
    let bytes = image.bytes;
    let url = blocking(move || Ok(store.put_blob(media_type, &bytes)?)).await?;
    Ok(GeneratedImage { url, media_type: media_type.to_string(), revised_prompt: image.revised_prompt, usage: image.usage })
}
