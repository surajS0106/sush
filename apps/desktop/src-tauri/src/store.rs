//! Conversations, attachments and memory on local disk (see `sush_core::store`
//! and `sush_core::memory`). SQLite and file I/O run on the blocking pool so
//! large chats don't stall the async runtime.

use serde_json::Value;
use sush_core::memory::MemoryFile;
use sush_core::store::{ChatHit, Thread, ThreadMeta};
use tauri::http::{header, Response, StatusCode};
use tauri::{Manager, State, UriSchemeContext, UriSchemeResponder};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Invalid(format!("Storage task failed: {e}")))?
}

/// Every conversation with its messages, newest first.
#[tauri::command]
pub async fn threads_load(state: State<'_, AppState>) -> AppResult<Vec<Thread>> {
    let store = state.store.clone();
    blocking(move || Ok(store.threads()?)).await
}

/// Create or update a conversation; without `messages`, only its metadata.
#[tauri::command]
pub async fn thread_save(state: State<'_, AppState>, thread: ThreadMeta, messages: Option<Vec<Value>>) -> AppResult<()> {
    state.runs.update_meta(&thread);
    let store = state.store.clone();
    blocking(move || Ok(store.save_thread(&thread, messages)?)).await
}

#[tauri::command]
pub async fn thread_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    // A run still going would save the thread again; so would its sub-agents'.
    state.runs.stop_with_agents(&id).await;
    state.runs.forget(&id);
    let store = state.store.clone();
    blocking(move || Ok(store.delete_thread(&id)?)).await
}

/// One-time import of conversations kept in localStorage by earlier versions.
#[tauri::command]
pub async fn threads_import(state: State<'_, AppState>, threads: Vec<Thread>) -> AppResult<usize> {
    let store = state.store.clone();
    blocking(move || Ok(store.import(threads)?)).await
}

/// Store an attachment (a base64 `data:` URL) and return the URL it's served on.
#[tauri::command]
pub async fn blob_put(state: State<'_, AppState>, data_url: String) -> AppResult<String> {
    let store = state.store.clone();
    blocking(move || Ok(store.put_data_url(&data_url)?)).await
}

/// A stored blob as a base64 `data:` URL, for code that needs its bytes (the PowerPoint export).
#[tauri::command]
pub async fn blob_data_url(state: State<'_, AppState>, url: String) -> AppResult<String> {
    use base64::Engine;
    let sha = sush_core::store::blob_sha(&url).ok_or_else(|| AppError::Invalid("Not a stored file.".into()))?.to_string();
    let store = state.store.clone();
    let (media_type, bytes) = blocking(move || Ok(store.blob(&sha)?))
        .await?
        .ok_or_else(|| AppError::NotFound("That file is no longer stored.".into()))?;
    Ok(format!("data:{media_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Largest image `image_fetch` will download.
const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;

/// Download an image from the web, store it as a blob and return the URL it's served on.
/// Slides use it for `<img>`s that point at the web, which the CSP keeps the webview from loading itself.
#[tauri::command]
pub async fn image_fetch(state: State<'_, AppState>, url: String) -> AppResult<String> {
    download_image(&state, &url).await
}

/// Find a picture of `query` (the lead image of the best-matching Wikipedia article, else a Wikimedia
/// Commons file), store it as a blob and return the URL it's served on. Slides use it for
/// `<img data-search="…">`, since models can't know real image URLs.
#[tauri::command]
pub async fn image_search(state: State<'_, AppState>, query: String) -> AppResult<String> {
    let query = query.trim();
    if query.is_empty() {
        return Err(AppError::Invalid("Nothing to search for.".into()));
    }
    let url = match wikipedia_image(&state.http, query).await {
        Some(url) => Some(url),
        None => commons_image(&state.http, query).await,
    };
    let url = url.ok_or_else(|| AppError::NotFound(format!("No picture found for “{query}”.")))?;
    download_image(&state, &url).await
}

/// Wikimedia asks API clients to name themselves; the shared client's user agent does.
async fn wiki_query(http: &reqwest::Client, host: &str, params: &[(&str, &str)]) -> Option<Value> {
    let url = reqwest::Url::parse_with_params(&format!("https://{host}/w/api.php"), params).ok()?;
    http.get(url).send().await.ok()?.error_for_status().ok()?.json().await.ok()
}

/// Search results in rank order (the API returns them unordered, with each one's `index`), keeping only
/// those whose title names something in the query: search matches body text too, so "Bleach logo" would
/// otherwise find a picture of Clorox's headquarters.
fn ranked_pages<'a>(v: &'a Value, query: &str) -> Vec<&'a Value> {
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(str::to_lowercase).collect()
    };
    const GENERIC: [&str; 12] = ["the", "and", "logo", "image", "photo", "picture", "poster", "official", "form", "portrait", "art", "file"];
    let wanted: Vec<String> = words(query).into_iter().filter(|w| !GENERIC.contains(&w.as_str())).collect();
    let mut pages: Vec<&Value> = v["query"]["pages"]
        .as_array()
        .map(|a| a.iter().filter(|p| words(p["title"].as_str().unwrap_or("")).iter().any(|w| wanted.contains(w))).collect())
        .unwrap_or_default();
    pages.sort_by_key(|p| p["index"].as_u64().unwrap_or(u64::MAX));
    pages
}

async fn wikipedia_image(http: &reqwest::Client, query: &str) -> Option<String> {
    let v = wiki_query(
        http,
        "en.wikipedia.org",
        &[
            ("action", "query"),
            ("format", "json"),
            ("formatversion", "2"),
            ("generator", "search"),
            ("gsrsearch", query),
            ("gsrlimit", "5"),
            ("prop", "pageimages"),
            ("piprop", "thumbnail"),
            ("pithumbsize", "1600"),
            // Character art, posters and logos are non-free; the default leaves them out.
            ("pilicense", "any"),
        ],
    )
    .await?;
    ranked_pages(&v, query).into_iter().find_map(|p| p["thumbnail"]["source"].as_str().map(String::from))
}

async fn commons_image(http: &reqwest::Client, query: &str) -> Option<String> {
    let v = wiki_query(
        http,
        "commons.wikimedia.org",
        &[
            ("action", "query"),
            ("format", "json"),
            ("formatversion", "2"),
            ("generator", "search"),
            ("gsrsearch", &format!("filetype:bitmap {query}")),
            ("gsrnamespace", "6"),
            ("gsrlimit", "5"),
            ("prop", "imageinfo"),
            ("iiprop", "url"),
            ("iiurlwidth", "1600"),
        ],
    )
    .await?;
    ranked_pages(&v, query).into_iter().find_map(|p| p["imageinfo"][0]["thumburl"].as_str().map(String::from))
}

async fn download_image(state: &AppState, url: &str) -> AppResult<String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| AppError::Invalid(format!("Not a valid image URL: {url}")))?;
    if parsed.scheme() != "https" {
        return Err(AppError::Invalid("Only https images can be loaded.".into()));
    }
    let failed = |e: reqwest::Error| AppError::Invalid(format!("Couldn't load the image: {e}"));
    let mut response = state.http.get(parsed).send().await.and_then(|r| r.error_for_status()).map_err(failed)?;
    if response.content_length().is_some_and(|n| n as usize > MAX_IMAGE_BYTES) {
        return Err(AppError::Invalid("The image is too large.".into()));
    }
    let declared = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(failed)? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(AppError::Invalid("The image is too large.".into()));
        }
    }
    let media_type = sniff_image(&bytes)
        .or_else(|| (declared == "image/svg+xml").then_some("image/svg+xml"))
        .ok_or_else(|| AppError::Invalid("That URL isn't an image.".into()))?;
    let store = state.store.clone();
    blocking(move || Ok(store.put_blob(media_type, &bytes)?)).await
}

/// An image's media type from its first bytes, so a server's wrong `Content-Type` doesn't matter.
pub(crate) fn sniff_image(b: &[u8]) -> Option<&'static str> {
    match b {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        [_, _, _, _, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f', ..] => Some("image/avif"),
        _ => None,
    }
}

#[tauri::command]
pub async fn chats_search(state: State<'_, AppState>, query: String, limit: usize) -> AppResult<Vec<ChatHit>> {
    let store = state.store.clone();
    blocking(move || Ok(store.search(&query, limit)?)).await
}

#[tauri::command]
pub async fn memory_list(state: State<'_, AppState>) -> AppResult<Vec<MemoryFile>> {
    let memory = state.memory.clone();
    blocking(move || Ok(memory.list()?)).await
}

#[tauri::command]
pub async fn memory_write(state: State<'_, AppState>, file: MemoryFile) -> AppResult<()> {
    let memory = state.memory.clone();
    blocking(move || Ok(memory.write(&file)?)).await
}

/// Returns whether the file existed.
#[tauri::command]
pub async fn memory_delete(state: State<'_, AppState>, path: String) -> AppResult<bool> {
    let memory = state.memory.clone();
    blocking(move || Ok(memory.delete(&path)?)).await
}

#[tauri::command]
pub async fn memory_clear(state: State<'_, AppState>) -> AppResult<()> {
    let memory = state.memory.clone();
    blocking(move || Ok(memory.clear()?)).await
}

/// Serves `sushblob://localhost/<sha>` (`http://sushblob.localhost/<sha>` on
/// Windows) so the webview can show stored images.
pub fn serve_blob<R: tauri::Runtime>(ctx: UriSchemeContext<'_, R>, request: tauri::http::Request<Vec<u8>>, responder: UriSchemeResponder) {
    let store = ctx.app_handle().state::<AppState>().store.clone();
    let sha = request.uri().path().trim_start_matches('/').to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let response = match store.blob(&sha) {
            Ok(Some((media_type, bytes))) => Response::builder()
                .header(header::CONTENT_TYPE, media_type)
                // Content-addressed, so it never changes.
                .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
                .body(bytes),
            Ok(None) => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()),
            Err(_) => Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(Vec::new()),
        };
        responder.respond(response.expect("valid response"));
    });
}
