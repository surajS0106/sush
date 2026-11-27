//! Files the user picks or saves. Desktop asks with the OS's dialogs; Android
//! with its file picker and share sheet (`android.rs`). iOS has neither yet (no
//! Swift plugin): saving puts the file in the app's Documents folder, which the
//! Files app shows under On My iPhone → Sush. The webview never names a path.
//! These block, so call them off the async workers.

use std::path::PathBuf;

use tauri::AppHandle;

use crate::error::{AppError, AppResult};

/// The files the user picked, or none if they cancelled. `filter` is a name and extensions.
#[cfg(desktop)]
pub fn pick(app: &AppHandle, title: &str, filter: (&str, &[&str]), multiple: bool) -> AppResult<Vec<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().file().set_title(title).add_filter(filter.0, filter.1);
    let picked = if multiple { dialog.blocking_pick_files().unwrap_or_default() } else { dialog.blocking_pick_file().into_iter().collect() };
    picked
        .into_iter()
        .map(|f| f.into_path().map_err(|e| AppError::Invalid(format!("That file can't be used: {e}"))))
        .collect()
}

#[cfg(target_os = "android")]
pub fn pick(app: &AppHandle, _title: &str, filter: (&str, &[&str]), multiple: bool) -> AppResult<Vec<PathBuf>> {
    let mimes = filter.1.iter().flat_map(|ext| mime_types(ext)).map(|m| m.to_string()).collect();
    let paths = crate::android::pick_files(app, mimes, multiple)?;
    // The picker's types are broader than the extensions asked for.
    for path in &paths {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
        if !filter.1.contains(&ext.as_str()) {
            return Err(AppError::Invalid(format!("Pick one of these kinds of file: {}.", filter.1.join(", "))));
        }
    }
    Ok(paths)
}

#[cfg(target_os = "ios")]
pub fn pick(_app: &AppHandle, _title: &str, _filter: (&str, &[&str]), _multiple: bool) -> AppResult<Vec<PathBuf>> {
    Err(AppError::Invalid("Picking files isn't available on iPhone yet. Attach it in the chat instead.".into()))
}

#[cfg(target_os = "android")]
fn mime_types(ext: &str) -> &'static [&'static str] {
    match ext {
        "png" => &["image/png"],
        "jpg" | "jpeg" => &["image/jpeg"],
        "webp" => &["image/webp"],
        "gif" => &["image/gif"],
        "pdf" => &["application/pdf"],
        // Phones disagree on these; some give CSVs and Markdown no useful type at all.
        "csv" | "tsv" => &["text/*", "application/csv", "application/vnd.ms-excel", "application/octet-stream"],
        "md" | "markdown" => &["text/*", "application/octet-stream"],
        _ => &["text/*"],
    }
}

/// Save a file where the user chooses. False if they cancelled.
#[cfg(desktop)]
pub fn save(app: &AppHandle, file_name: String, contents: &[u8]) -> AppResult<bool> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app.dialog().file().set_file_name(file_name).blocking_save_file() else { return Ok(false) };
    let path = picked.into_path().map_err(|e| AppError::Invalid(format!("Can't save there: {e}")))?;
    std::fs::write(path, contents)?;
    Ok(true)
}

/// Opens the share sheet. Always false: Android doesn't say whether anything came
/// of it, so the UI shouldn't claim the file was saved.
#[cfg(target_os = "android")]
pub fn save(app: &AppHandle, file_name: String, contents: &[u8]) -> AppResult<bool> {
    use tauri::Manager;
    let name = std::path::Path::new(&file_name).file_name().map_or_else(|| "file".into(), |n| n.to_os_string());
    let dir = app.path().app_cache_dir().map_err(|e| AppError::Invalid(e.to_string()))?.join("exports");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(name);
    std::fs::write(&path, contents)?;
    crate::android::share_file(app, path)?;
    Ok(false)
}

/// Writes the file to Documents (On My iPhone → Sush in the Files app), next to
/// any file already there of that name rather than over it.
#[cfg(target_os = "ios")]
pub fn save(app: &AppHandle, file_name: String, contents: &[u8]) -> AppResult<bool> {
    use tauri::Manager;
    let name = std::path::Path::new(&file_name).file_name().map_or_else(|| "file".into(), |n| n.to_string_lossy().into_owned());
    let dir = app.path().document_dir().map_err(|e| AppError::Invalid(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    let mut path = dir.join(&name);
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    std::fs::write(&path, contents)?;
    Ok(true)
}

/// A folder the user picked. Android's folders aren't paths, so there's nothing to pick there.
#[cfg(desktop)]
pub fn pick_folder(app: &AppHandle, title: &str) -> AppResult<Option<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app.dialog().file().set_title(title).blocking_pick_folder() else { return Ok(None) };
    picked.into_path().map(Some).map_err(|e| AppError::Invalid(format!("That folder can't be used: {e}")))
}

#[cfg(mobile)]
pub fn pick_folder(_app: &AppHandle, _title: &str) -> AppResult<Option<PathBuf>> {
    Err(AppError::Invalid("Folders aren't available on this phone. Use Sush on your computer to work in a folder.".into()))
}
