//! Image generation for the `image_generate` tool: the provider and model the
//! user picked in Settings → Images make the image, and it's kept as a blob.

use serde::Serialize;
use sush_core::{generate_image, Aspect, AuthKind, ImageApi};
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
}

#[tauri::command]
pub async fn image_generate(
    state: State<'_, AppState>,
    provider_id: String,
    model: String,
    api: ImageApi,
    prompt: String,
    aspect: Option<Aspect>,
) -> AppResult<GeneratedImage> {
    let cfg = state.provider(&provider_id).ok_or_else(|| AppError::NotFound(format!("provider {provider_id} not found")))?;
    let secret = match cfg.auth {
        AuthKind::ApiKey { .. } => secrets::get(&cfg.id)?,
        AuthKind::None => None,
    };
    let image = generate_image(&cfg, secret, &state.http, &model, api, &prompt, aspect).await?;
    let media_type = sniff_image(&image.bytes).ok_or_else(|| AppError::Invalid("The provider didn't return an image.".into()))?;
    let store = state.store.clone();
    let bytes = image.bytes;
    let url = blocking(move || Ok(store.put_blob(media_type, &bytes)?)).await?;
    Ok(GeneratedImage { url, media_type: media_type.to_string(), revised_prompt: image.revised_prompt })
}
