//! Where the app keeps its files.
//!
//! Debug builds can run as another profile (`SUSH_PROFILE=b`): its own data,
//! settings and dev secrets, and on Windows its own webview storage (so its
//! own sign-in), so two copies of the app on one machine act as two people,
//! e.g. to try a shared session. macOS keeps one webview store per app, so
//! there a second person needs a second machine or OS account.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

/// The profile this copy runs as, in a debug build.
pub fn profile() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("SUSH_PROFILE")
        .ok()
        .filter(|p| !p.is_empty() && p.len() <= 32 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

fn for_profile(dir: PathBuf) -> PathBuf {
    match (profile(), dir.file_name()) {
        (Some(p), Some(name)) => dir.with_file_name(format!("{}-{p}", name.to_string_lossy())),
        _ => dir,
    }
}

pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PathBuf> {
    app.path().app_data_dir().map(for_profile)
}

pub fn config_dir<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PathBuf> {
    app.path().app_config_dir().map(for_profile)
}

/// Call before any webview starts.
pub fn init() {
    #[cfg(all(debug_assertions, windows))]
    if let (Some(p), Ok(local)) = (profile(), std::env::var("LOCALAPPDATA")) {
        // WebView2 takes this over the folder the app asks for.
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", PathBuf::from(local).join(format!("com.sush.app-{p}")).join("EBWebView"));
    }
}
