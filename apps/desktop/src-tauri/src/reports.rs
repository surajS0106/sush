//! Security reviews, code reviews and wikis of a workspace (`sush_core::reports`).
//!
//! The UI starts a report's run like any other (`run_start`) on a thread it
//! made for it, after creating the report here; `runs.rs` sees the thread
//! belongs to a report and holds the run to reading. These commands manage
//! the reports themselves. Each returns the report as saved, for the UI to
//! show and pass to its other windows.

use std::path::Path;

use sush_core::agent::ui::new_id;
use sush_core::reports::{Report, ReportKind, ReportStatus, Scope};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::blocking;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Every report, newest first. One still marked running whose run is gone
/// (the app closed mid-run) is marked stopped.
#[tauri::command]
pub async fn reports_list(state: State<'_, AppState>) -> AppResult<Vec<Report>> {
    let store = state.store.clone();
    let mut all = blocking(move || Ok(store.reports()?)).await?;
    for r in &mut all {
        if r.status == ReportStatus::Running && !state.runs.is_running(&r.thread_id) {
            r.finish(ReportStatus::Stopped, None, r.updated_at);
            let (store, report) = (state.store.clone(), r.clone());
            blocking(move || Ok(store.save_report(&report)?)).await?;
        }
    }
    Ok(all)
}

/// A new report on a workspace, to run on `thread_id` (a Cowork thread in it).
#[tauri::command]
pub async fn report_create(
    state: State<'_, AppState>,
    workspace_id: String,
    kind: ReportKind,
    scope: Scope,
    thread_id: String,
) -> AppResult<Report> {
    let store = state.store.clone();
    blocking(move || {
        let workspace =
            store.workspace(&workspace_id)?.ok_or_else(|| AppError::NotFound("That folder is no longer in Cowork.".into()))?;
        let report = Report::new(new_id(), workspace_id, kind, scope, thread_id, Path::new(&workspace.root), now_ms())
            .map_err(AppError::Invalid)?;
        store.save_report(&report)?;
        Ok(report)
    })
    .await
}

/// Run a report again on a new thread (regenerating a wiki).
#[tauri::command]
pub async fn report_rerun(state: State<'_, AppState>, id: String, thread_id: String) -> AppResult<Report> {
    if let Some(old) = state.store.report(&id)? {
        state.runs.stop(&old.thread_id).await;
    }
    let store = state.store.clone();
    blocking(move || {
        let report = store.report(&id)?.ok_or_else(|| AppError::NotFound("That report no longer exists.".into()))?;
        let root = store
            .workspace(&report.workspace_id)?
            .ok_or_else(|| AppError::NotFound("That folder is no longer in Cowork.".into()))?
            .root;
        Ok(store
            .update_report(&id, |r| {
                r.rerun(thread_id, Path::new(&root), now_ms());
                Ok(())
            })?
            .0)
    })
    .await
}

/// Set (or clear) a wiki's question thread.
#[tauri::command]
pub async fn report_ask_thread(state: State<'_, AppState>, id: String, thread_id: Option<String>) -> AppResult<Report> {
    let store = state.store.clone();
    blocking(move || {
        Ok(store
            .update_report(&id, |r| {
                r.ask_thread_id = thread_id;
                Ok(())
            })?
            .0)
    })
    .await
}

/// Delete a report, stopping its run. The UI deletes its threads.
#[tauri::command]
pub async fn report_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Some(old) = state.store.report(&id)? {
        state.runs.stop(&old.thread_id).await;
    }
    let store = state.store.clone();
    blocking(move || Ok(store.delete_report(&id)?)).await
}
