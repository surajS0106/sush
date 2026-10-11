//! Cowork workspaces: folders the user grants Sush, the file tree the UI
//! shows for them, and undoing a turn's file changes.
//!
//! A workspace can only be added through the folder dialog opened here, so
//! the webview can never name a path itself.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use sush_core::agent::ui::new_id;
use sush_core::store::TurnChanges;
use sush_core::workspace::sandbox::SandboxStatus;
use sush_core::workspace::{Access, EditApproval, Entry, Workspace, WorkspaceFs};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::blocking;

#[tauri::command]
pub async fn workspaces_list(state: State<'_, AppState>) -> AppResult<Vec<Workspace>> {
    let store = state.store.clone();
    blocking(move || Ok(store.workspaces()?)).await
}

/// Ask the user for a folder and add it as a workspace (or return the one
/// already there for it). `None` if they cancelled.
#[tauri::command]
pub async fn workspace_add(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<Workspace>> {
    let dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog.dialog().file().set_title("Choose a folder for Cowork").blocking_pick_folder()
    })
    .await
    .map_err(|e| AppError::Invalid(format!("The folder picker failed: {e}")))?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| AppError::Invalid(format!("That folder can't be used: {e}")))?;
    let root = dunce::canonicalize(&path)?;
    if !root.is_dir() {
        return Err(AppError::Invalid(format!("{} isn't a folder.", root.display())));
    }
    if root.parent().is_none() {
        return Err(AppError::Invalid("Choose a project folder rather than a whole drive.".into()));
    }
    let home = app.path().home_dir().ok().map(|h| dunce::canonicalize(&h).unwrap_or(h));
    if home.as_deref() == Some(root.as_path()) {
        return Err(AppError::Invalid("Choose a folder inside your home folder rather than all of it.".into()));
    }

    let store = state.store.clone();
    let workspace = blocking(move || {
        let root_str = root.to_string_lossy().into_owned();
        if let Some(existing) = store.workspaces()?.into_iter().find(|w| w.root == root_str) {
            return Ok(existing);
        }
        let workspace = Workspace {
            id: new_id(),
            name: root.file_name().map_or_else(|| root_str.clone(), |n| n.to_string_lossy().into_owned()),
            root: root_str,
            // Changes are allowed but each one asks first, like Codex's default.
            access: Access::WorkspaceWrite,
            approval: EditApproval::Ask,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as i64),
        };
        store.save_workspace(&workspace)?;
        Ok(workspace)
    })
    .await?;
    Ok(Some(workspace))
}

/// Change what the agent may do in a workspace. Applies from the next tool call.
#[tauri::command]
pub async fn workspace_update(state: State<'_, AppState>, id: String, access: Access, approval: EditApproval) -> AppResult<Workspace> {
    let store = state.store.clone();
    blocking(move || {
        let mut workspace = store.workspace(&id)?.ok_or_else(|| AppError::NotFound("That workspace no longer exists.".into()))?;
        workspace.access = access;
        workspace.approval = approval;
        store.save_workspace(&workspace)?;
        Ok(workspace)
    })
    .await
}

/// Forget a workspace. Its sessions stay readable but lose file access, and
/// (on Windows) the sandbox's access to the folder is taken back.
#[tauri::command]
pub async fn workspace_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let store = state.store.clone();
    let workspace = blocking(move || {
        let workspace = store.workspace(&id)?;
        store.delete_workspace(&id)?;
        Ok(workspace)
    })
    .await?;
    if let Some(workspace) = workspace {
        state.sandbox.release(Path::new(&workspace.root)).await;
    }
    Ok(())
}

/// Whether Cowork commands can be sandboxed on this machine (probes on first call).
#[tauri::command]
pub async fn sandbox_status(state: State<'_, AppState>) -> AppResult<SandboxStatus> {
    Ok(state.sandbox.status().await)
}

/// A file's text for the viewer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    path: String,
    /// None for binary files.
    text: Option<String>,
    size: u64,
    /// Only the start is shown for very large files.
    truncated: bool,
}

const MAX_VIEW_BYTES: usize = 1024 * 1024;

#[tauri::command]
pub async fn workspace_read_file(state: State<'_, AppState>, id: String, path: String) -> AppResult<FileView> {
    let store = state.store.clone();
    blocking(move || {
        let fs = open(&store, &id)?;
        let rel = fs.rel(&path).map_err(AppError::Invalid)?;
        let bytes = fs.bytes(&rel).map_err(AppError::Invalid)?.ok_or_else(|| AppError::NotFound(format!("{rel} doesn't exist.")))?;
        let size = bytes.len() as u64;
        if bytes.iter().take(8192).any(|&b| b == 0) {
            return Ok(FileView { path: rel, text: None, size, truncated: false });
        }
        let truncated = bytes.len() > MAX_VIEW_BYTES;
        let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_VIEW_BYTES)]).into_owned();
        Ok(FileView { path: rel, text: Some(text), size, truncated })
    })
    .await
}

/// Files whose path contains `query`, for the file filter.
#[tauri::command]
pub async fn workspace_find(state: State<'_, AppState>, id: String, query: String) -> AppResult<Vec<String>> {
    let store = state.store.clone();
    blocking(move || Ok(open(&store, &id)?.find(&query, 200))).await
}

fn open(store: &sush_core::store::Store, id: &str) -> AppResult<WorkspaceFs> {
    let workspace = store.workspace(id)?.ok_or_else(|| AppError::NotFound("That workspace no longer exists.".into()))?;
    WorkspaceFs::open(Path::new(&workspace.root)).map_err(AppError::Invalid)
}

/// One folder level of a workspace, for the file tree.
#[tauri::command]
pub async fn workspace_tree(state: State<'_, AppState>, id: String, path: String) -> AppResult<Vec<Entry>> {
    let store = state.store.clone();
    blocking(move || {
        let workspace = store.workspace(&id)?.ok_or_else(|| AppError::NotFound("That workspace no longer exists.".into()))?;
        let fs = WorkspaceFs::open(Path::new(&workspace.root)).map_err(AppError::Invalid)?;
        let rel = fs.rel(&path).map_err(AppError::Invalid)?;
        fs.list(&rel).map_err(AppError::Invalid)
    })
    .await
}

/// The turns of a Cowork session that changed files.
#[tauri::command]
pub async fn turn_changes(state: State<'_, AppState>, thread_id: String) -> AppResult<Vec<TurnChanges>> {
    let store = state.store.clone();
    blocking(move || Ok(store.turn_changes(&thread_id)?)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    restored: Vec<String>,
    /// Files that couldn't be put back, with why.
    failed: Vec<String>,
}

/// Put every file changed since `turn_id` began back as it was before it.
/// Stops the session's run first so nothing writes in between.
#[tauri::command]
pub async fn undo_turn(state: State<'_, AppState>, thread_id: String, turn_id: String) -> AppResult<UndoResult> {
    state.runs.stop(&thread_id).await;
    let store = state.store.clone();
    blocking(move || {
        let originals = store.take_originals_since(&thread_id, &turn_id)?;
        let mut folders: HashMap<String, Option<WorkspaceFs>> = HashMap::new();
        let mut result = UndoResult { restored: Vec::new(), failed: Vec::new() };
        for o in originals {
            if !folders.contains_key(&o.workspace_id) {
                let fs = store.workspace(&o.workspace_id)?.and_then(|w| WorkspaceFs::open(Path::new(&w.root)).ok());
                folders.insert(o.workspace_id.clone(), fs);
            }
            match &folders[&o.workspace_id] {
                Some(fs) => match fs.restore(&o.path, o.original.as_deref()) {
                    Ok(()) => result.restored.push(o.path),
                    Err(e) => result.failed.push(e),
                },
                None => result.failed.push(format!("{}: the workspace folder is gone", o.path)),
            }
        }
        Ok(result)
    })
    .await
}
