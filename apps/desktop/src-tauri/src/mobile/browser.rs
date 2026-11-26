//! Cowork's browser is a second native webview, which Tauri can't make on Android
//! (`browser.rs` on desktop). Nothing offers its tools there; this keeps the same API.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};

const UNAVAILABLE: &str = "The built-in browser isn't available on this phone.";

#[derive(Default)]
pub struct Browser;

#[derive(Debug, Clone, Serialize)]
pub struct Page {}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserEvent {}

#[derive(Debug, Deserialize)]
pub struct Bounds {}

impl Browser {
    pub fn shared(&self) -> Option<sush_core::share::BrowserPage> {
        None
    }

    pub fn allowed_sites(&self, _thread_id: &str) -> HashSet<String> {
        HashSet::new()
    }

    pub async fn execute(&self, _app: &AppHandle, _thread_id: &str, _name: &str, _input: &Value, _cancel: CancellationToken) -> Result<Value, String> {
        Err(UNAVAILABLE.into())
    }
}

#[tauri::command]
pub fn browser_subscribe(on_event: Channel<BrowserEvent>) -> Option<Page> {
    let _ = on_event;
    None
}

#[tauri::command]
pub async fn browser_open(url: String) -> AppResult<()> {
    let _ = url;
    Err(AppError::Invalid(UNAVAILABLE.into()))
}

#[tauri::command]
pub async fn browser_go(to: String) -> AppResult<()> {
    let _ = to;
    Ok(())
}

#[tauri::command]
pub async fn browser_set_view(bounds: Option<Bounds>) -> AppResult<()> {
    let _ = bounds;
    Ok(())
}
