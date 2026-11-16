//! Docs (`sush_core::docs`): the model's `doc_*` tools, which the UI runs and
//! hands here, and the user's own edits from the doc panel and the Docs page.
//! Every change reaches every window as a `doc` frame, so the UI doesn't
//! broadcast its own.

use serde_json::Value;
use sush_core::docs::{self, Doc};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::runs::RunFrame;
use crate::state::AppState;
use crate::store::blocking;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn announce(state: &AppState, doc: Option<Doc>) {
    if let Some(doc) = doc {
        state.runs.send(RunFrame::Doc { doc });
    }
}

/// Every doc, read once at startup.
#[tauri::command]
pub async fn docs_list(state: State<'_, AppState>) -> AppResult<Vec<Doc>> {
    let store = state.store.clone();
    blocking(move || Ok(store.docs()?)).await
}

/// Run `doc_write`, `doc_read` or `doc_edit` for a thread's model; returns what the model is told.
#[tauri::command]
pub async fn doc_tool(state: State<'_, AppState>, thread_id: String, name: String, input: Value) -> AppResult<String> {
    if !docs::is_doc_tool(&name) {
        return Err(AppError::Invalid(format!("{name} isn't a doc tool.")));
    }
    let id = docs::tool_doc_id(&thread_id, &input).ok_or_else(|| AppError::Invalid(format!("{name} needs the doc's `id`.")))?;
    let store = state.store.clone();
    let (doc, output) = blocking(move || {
        Ok(store.update_doc(&id, |existing| {
            let out = docs::apply_tool(&name, &thread_id, existing, &input, now_ms())?;
            Ok((out.doc, out.output))
        })?)
    })
    .await?;
    announce(&state, doc);
    Ok(output)
}

/// A blank doc, from the Docs page.
#[tauri::command]
pub async fn doc_create(state: State<'_, AppState>, title: String) -> AppResult<Doc> {
    let doc = Doc::blank(&title, now_ms());
    let store = state.store.clone();
    let saved = doc.clone();
    blocking(move || Ok(store.save_doc(&saved)?)).await?;
    announce(&state, Some(doc.clone()));
    Ok(doc)
}

/// The user's edit, made on `base_rev`. Refused if the doc changed since.
#[tauri::command]
pub async fn doc_update(
    state: State<'_, AppState>,
    id: String,
    base_rev: u32,
    title: String,
    content: String,
    icon: Option<String>,
) -> AppResult<Doc> {
    let store = state.store.clone();
    let (saved, current) = blocking(move || {
        Ok(store.update_doc(&id, |existing| {
            let mut doc = existing.ok_or("That doc no longer exists.")?;
            let changed = docs::user_edit(&mut doc, base_rev, &title, &content, icon.as_deref(), now_ms())?;
            // An unchanged save writes nothing, but still answers with the doc.
            Ok((changed.then(|| doc.clone()), doc))
        })?)
    })
    .await?;
    announce(&state, saved);
    Ok(current)
}

/// Set or clear the date shown under the doc's title.
#[tauri::command]
pub async fn doc_set_date(state: State<'_, AppState>, id: String, date: Option<String>) -> AppResult<Doc> {
    let store = state.store.clone();
    let (doc, ()) = blocking(move || {
        Ok(store.update_doc(&id, |existing| {
            let mut doc = existing.ok_or("That doc no longer exists.")?;
            docs::set_date(&mut doc, date.as_deref(), now_ms())?;
            Ok((Some(doc), ()))
        })?)
    })
    .await?;
    let doc = doc.ok_or_else(|| AppError::NotFound("That doc no longer exists.".into()))?;
    announce(&state, Some(doc.clone()));
    Ok(doc)
}

/// Make an earlier version current again.
#[tauri::command]
pub async fn doc_restore(state: State<'_, AppState>, id: String, number: u32) -> AppResult<Doc> {
    let store = state.store.clone();
    let (doc, ()) = blocking(move || {
        Ok(store.update_doc(&id, |existing| {
            let mut doc = existing.ok_or("That doc no longer exists.")?;
            docs::restore(&mut doc, number, now_ms())?;
            Ok((Some(doc), ()))
        })?)
    })
    .await?;
    let doc = doc.ok_or_else(|| AppError::NotFound("That doc no longer exists.".into()))?;
    announce(&state, Some(doc.clone()));
    Ok(doc)
}

#[tauri::command]
pub async fn doc_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let store = state.store.clone();
    let gone = id.clone();
    blocking(move || Ok(store.delete_doc(&gone)?)).await?;
    state.runs.send(RunFrame::DocGone { id });
    Ok(())
}
