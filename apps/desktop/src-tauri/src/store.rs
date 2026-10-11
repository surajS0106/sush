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
    let store = state.store.clone();
    blocking(move || Ok(store.save_thread(&thread, messages)?)).await
}

#[tauri::command]
pub async fn thread_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    // A run still going would save the thread again.
    state.runs.stop(&id).await;
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
