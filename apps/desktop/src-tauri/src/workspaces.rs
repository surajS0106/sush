//! Cowork workspaces: folders the user grants Sush, the file tree the UI
//! shows for them, and undoing a turn's file changes.
//!
//! A workspace can only be added through the folder dialog opened here, so
//! the webview can never name a path itself.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use sush_core::agent::ui::new_id;
use sush_core::store::{Store, TurnChanges};
use sush_core::workspace::git::{self, BranchStatus, CommitDetail, GitInfo, GitLog};
use sush_core::workspace::sandbox::SandboxStatus;
use sush_core::workspace::{Access, EditApproval, Entry, Workspace, WorkspaceFs};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

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

/// Change what the agent may do in a workspace. Applies at once, also to
/// calls a live run holds for approval.
#[tauri::command]
pub async fn workspace_update(state: State<'_, AppState>, id: String, access: Access, approval: EditApproval) -> AppResult<Workspace> {
    let store = state.store.clone();
    let workspace = blocking(move || {
        let mut workspace = store.workspace(&id)?.ok_or_else(|| AppError::NotFound("That workspace no longer exists.".into()))?;
        workspace.access = access;
        workspace.approval = approval;
        store.save_workspace(&workspace)?;
        Ok(workspace)
    })
    .await?;
    state.runs.workspace_changed(&workspace);
    Ok(workspace)
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
    blocking(move || file_view(&open(&store, &id)?, &path)).await
}

/// A workspace file for the viewer (also a shared session's guests', `share.rs`). Blocking.
pub(crate) fn file_view(fs: &WorkspaceFs, path: &str) -> AppResult<FileView> {
    let rel = fs.rel(path).map_err(AppError::Invalid)?;
    let bytes = fs.bytes(&rel).map_err(AppError::Invalid)?.ok_or_else(|| AppError::NotFound(format!("{rel} doesn't exist.")))?;
    let size = bytes.len() as u64;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Ok(FileView { path: rel, text: None, size, truncated: false });
    }
    let truncated = bytes.len() > MAX_VIEW_BYTES;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_VIEW_BYTES)]).into_owned();
    Ok(FileView { path: rel, text: Some(text), size, truncated })
}

/// Save a file the user edited in the viewer. It's their own change, like
/// saving in their editor, so no checkpoint is taken.
#[tauri::command]
pub async fn workspace_write_file(state: State<'_, AppState>, id: String, path: String, text: String) -> AppResult<()> {
    let store = state.store.clone();
    blocking(move || {
        let fs = open(&store, &id)?;
        let rel = fs.rel(&path).map_err(AppError::Invalid)?;
        fs.write(&rel, text.as_bytes()).map_err(AppError::Invalid)
    })
    .await
}

/// Show a workspace file or folder in the system file manager.
#[tauri::command]
pub async fn workspace_reveal(app: AppHandle, state: State<'_, AppState>, id: String, path: String) -> AppResult<()> {
    let store = state.store.clone();
    let target = blocking(move || {
        let fs = open(&store, &id)?;
        let rel = fs.rel(&path).map_err(AppError::Invalid)?;
        Ok(rel.split('/').filter(|c| !c.is_empty()).fold(fs.root().to_path_buf(), |p, c| p.join(c)))
    })
    .await?;
    app.opener().reveal_item_in_dir(target).map_err(|e| AppError::Invalid(format!("Couldn't show it in the file manager: {e}")))
}

/// Open a workspace's folder in another app: `vscode`, or `files` (the system file manager).
#[tauri::command]
pub async fn workspace_open_in(app: AppHandle, state: State<'_, AppState>, id: String, target: String) -> AppResult<()> {
    let store = state.store.clone();
    let root = blocking(move || Ok(find(&store, &id)?.root)).await?;
    let with = match target.as_str() {
        "files" => None,
        "vscode" if cfg!(target_os = "macos") => Some("Visual Studio Code"),
        "vscode" => Some("code"),
        other => return Err(AppError::Invalid(format!("Unknown app: {other}"))),
    };
    app.opener().open_path(root, with).map_err(|e| AppError::Invalid(format!("Couldn't open the folder: {e}")))
}

/// Files whose path contains `query`, for the file filter.
#[tauri::command]
pub async fn workspace_find(state: State<'_, AppState>, id: String, query: String) -> AppResult<Vec<String>> {
    let store = state.store.clone();
    blocking(move || Ok(open(&store, &id)?.find(&query, 200))).await
}

/// The workspace's git state (branch, local branches, linked worktree), or
/// `None` if the folder isn't in a repository.
#[tauri::command]
pub async fn workspace_git(state: State<'_, AppState>, id: String) -> AppResult<Option<GitInfo>> {
    let store = state.store.clone();
    blocking(move || Ok(git::info(Path::new(&find(&store, &id)?.root)))).await
}

/// The workspace's branch against `base` (default: the repository's main
/// branch), for the pull request card.
#[tauri::command]
pub async fn workspace_branch_status(state: State<'_, AppState>, id: String, base: Option<String>) -> AppResult<BranchStatus> {
    let store = state.store.clone();
    blocking(move || {
        let root = find(&store, &id)?.root;
        let root = Path::new(&root);
        let base = match base.filter(|b| !b.trim().is_empty()) {
            Some(b) => b,
            None => {
                let current = git::info(root).ok_or_else(|| AppError::Invalid("This folder isn't in a git repository.".into()))?.branch;
                git::default_base(root, current.as_deref())
                    .ok_or_else(|| AppError::Invalid("Couldn't tell which branch this one merges into.".into()))?
            }
        };
        git::branch_status(root, &base).map_err(AppError::Invalid)
    })
    .await
}

/// Up to `limit` commits of the workspace's history (every branch when `all`),
/// for the side panel's graph.
#[tauri::command]
pub async fn workspace_git_log(state: State<'_, AppState>, id: String, limit: usize, all: bool) -> AppResult<GitLog> {
    let store = state.store.clone();
    blocking(move || git::log(Path::new(&find(&store, &id)?.root), limit.clamp(1, 5000), all).map_err(AppError::Invalid)).await
}

/// One commit's message and changed files, for a row opened in the graph.
#[tauri::command]
pub async fn workspace_git_commit(state: State<'_, AppState>, id: String, sha: String) -> AppResult<CommitDetail> {
    let store = state.store.clone();
    blocking(move || git::commit_detail(Path::new(&find(&store, &id)?.root), &sha).map_err(AppError::Invalid)).await
}

/// Check out another local branch in the workspace folder.
#[tauri::command]
pub async fn workspace_git_switch(state: State<'_, AppState>, id: String, branch: String) -> AppResult<()> {
    let store = state.store.clone();
    blocking(move || git::switch(Path::new(&find(&store, &id)?.root), &branch).map_err(AppError::Invalid)).await
}

/// Give a session its own git worktree: a new branch from `base`, checked out
/// in a folder under the app data dir, added as a workspace with the same
/// settings. The user's checkout is left alone.
#[tauri::command]
pub async fn worktree_create(app: AppHandle, state: State<'_, AppState>, id: String, base: String) -> AppResult<Workspace> {
    let dir = crate::paths::data_dir(&app).map_err(|e| AppError::Invalid(format!("No app data folder: {e}")))?.join("worktrees");
    let store = state.store.clone();
    blocking(move || {
        let parent = find(&store, &id)?;
        let short: String = new_id().chars().filter(char::is_ascii_alphanumeric).take(6).collect::<String>().to_lowercase();
        let branch = format!("sush/{short}");
        std::fs::create_dir_all(&dir)?;
        let dest = dir.join(format!("{}-{short}", parent.name));
        git::add_worktree(Path::new(&parent.root), &base, &dest, &branch).map_err(AppError::Invalid)?;
        let root = dunce::canonicalize(&dest)?;
        let workspace = Workspace {
            id: new_id(),
            name: format!("{} · {branch}", parent.name),
            root: root.to_string_lossy().into_owned(),
            access: parent.access,
            approval: parent.approval,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as i64),
        };
        store.save_workspace(&workspace)?;
        Ok(workspace)
    })
    .await
}

fn find(store: &sush_core::store::Store, id: &str) -> AppResult<Workspace> {
    store.workspace(id)?.ok_or_else(|| AppError::NotFound("That workspace no longer exists.".into()))
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

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub(crate) restored: Vec<String>,
    /// Files that couldn't be put back, with why.
    pub(crate) failed: Vec<String>,
}

/// Text past this size isn't diffed; the card just says the file changed.
const DIFF_LIMIT: usize = 512 * 1024;

/// A file a turn changed, as text for the diff viewer. `None`: the file
/// didn't exist. `binary`: not text (or too big), so no content is sent.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    path: String,
    before: Option<String>,
    after: Option<String>,
    binary: bool,
}

impl FileDiff {
    /// For a shared session's guests: a secret-looking file shows as changed, without its content.
    pub(crate) fn hidden_if_secret(self) -> Self {
        if sush_core::workspace::looks_secret(&self.path) {
            FileDiff { path: self.path, before: None, after: None, binary: true }
        } else {
            self
        }
    }
}

/// What each file a turn changed looked like before and after it. "After" is
/// the file now, or what the next turn to change it found.
#[tauri::command]
pub async fn turn_diff(state: State<'_, AppState>, thread_id: String, turn_id: String) -> AppResult<Vec<FileDiff>> {
    let store = state.store.clone();
    blocking(move || turn_diff_files(&store, &thread_id, &turn_id)).await
}

/// `turn_diff`'s work (also for a shared session's guests, `share.rs`). Blocking.
pub(crate) fn turn_diff_files(store: &Store, thread_id: &str, turn_id: &str) -> AppResult<Vec<FileDiff>> {
    let files = store.turn_files(thread_id, turn_id)?;
    let mut folders: HashMap<String, Option<WorkspaceFs>> = HashMap::new();
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let after = match f.later {
            Some(later) => later,
            None => {
                if !folders.contains_key(&f.workspace_id) {
                    let fs = store.workspace(&f.workspace_id)?.and_then(|w| WorkspaceFs::open(Path::new(&w.root)).ok());
                    folders.insert(f.workspace_id.clone(), fs);
                }
                match &folders[&f.workspace_id] {
                    Some(fs) => fs.bytes(&f.path).map_err(AppError::Invalid)?,
                    None => None,
                }
            }
        };
        let text = |b: Option<Vec<u8>>| -> Result<Option<String>, ()> {
            match b {
                None => Ok(None),
                Some(b) if b.len() > DIFF_LIMIT || b.contains(&0) => Err(()),
                Some(b) => String::from_utf8(b).map(Some).map_err(|_| ()),
            }
        };
        out.push(match (text(f.before), text(after)) {
            (Ok(before), Ok(after)) => FileDiff { path: f.path, before, after, binary: false },
            _ => FileDiff { path: f.path, before: None, after: None, binary: true },
        });
    }
    Ok(out)
}

/// Put every file changed since `turn_id` began back as it was before it, or
/// just `path` when given. Stops the session's run first so nothing writes in
/// between.
#[tauri::command]
pub async fn undo_turn(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
    path: Option<String>,
) -> AppResult<UndoResult> {
    state.runs.stop(&thread_id).await;
    let store = state.store.clone();
    let (id, turn, only) = (thread_id.clone(), turn_id.clone(), path.clone());
    let result = blocking(move || restore_since(&store, &id, &turn, only.as_deref())).await?;
    crate::share::note_local_undo(&app, &thread_id, &turn_id, path.as_deref(), result.restored.len());
    Ok(result)
}

/// Put every file changed since `turn_id` began (or just `only`) back as it
/// was before it, and forget those checkpoints. Blocking.
pub(crate) fn restore_since(store: &Store, thread_id: &str, turn_id: &str, only: Option<&str>) -> AppResult<UndoResult> {
    let originals = store.take_originals_since(thread_id, turn_id, only)?;
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
}
