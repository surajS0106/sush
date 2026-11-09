//! Notebooks (`sush_core::notebooks`): sources to chat with, answers citing them.
//!
//! Adding a source saves it as "reading" and returns at once; reading it
//! (fetching a link, extracting a PDF's text), chunking and indexing happen in
//! the background, and each change reaches every window as a `notebook` frame.
//! A notebook's chats are ordinary threads filed under it; `runs.rs` gives
//! their runs the source tools and instructions in place of the UI's.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use sush_core::agent::ui::new_id;
use sush_core::notebooks::{self, CoverPosition, Note, NoteKind, NoteStatus, Notebook, Overview, Page, Passage, Source, SourceGuide, SourceKind, SourceStatus};
use sush_core::web::{self, Fetched};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Semaphore;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::blocking;

/// Largest file a notebook takes.
const MAX_FILE: u64 = 64 * 1024 * 1024;
/// Sources read at once; more wait their turn.
static READERS: Semaphore = Semaphore::const_new(3);
/// Sources being read by this run of the app. Any other source still marked
/// "reading" was cut off when the app closed.
static READING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Tell every window a notebook changed.
async fn changed(state: &AppState, id: &str) -> AppResult<Notebook> {
    let (store, id) = (state.store.clone(), id.to_string());
    let notebook = blocking(move || store.notebook(&id)?.ok_or_else(|| AppError::NotFound("That notebook no longer exists.".into())))
        .await?;
    state.runs.notebook_changed(notebook.clone());
    Ok(notebook)
}

/// Every notebook, most recently changed first.
#[tauri::command]
pub async fn notebooks_list(state: State<'_, AppState>) -> AppResult<Vec<Notebook>> {
    let store = state.store.clone();
    let mut all = blocking(move || Ok(store.notebooks()?)).await?;
    let reading = READING.lock().unwrap().clone();
    for notebook in &mut all {
        // A Studio output whose run is gone (the app closed mid-run) won't finish.
        for note in &mut notebook.notes {
            let live = note.thread_id.as_deref().is_some_and(|t| state.runs.is_running(t));
            if note.status == NoteStatus::Writing && !live {
                note.status = NoteStatus::Failed;
                note.error = Some("Writing it stopped when Sush closed. Try again.".into());
                let (store, n) = (state.store.clone(), note.clone());
                blocking(move || Ok(store.save_note(&n, now_ms())?)).await?;
            }
        }
        for source in &mut notebook.sources {
            if source.status == SourceStatus::Reading && !reading.contains(&source.id) {
                source.status = SourceStatus::Failed;
                source.error = Some("Reading it stopped when Sush closed. Try again.".into());
                let (store, s) = (state.store.clone(), source.clone());
                blocking(move || Ok(store.save_source(&s, now_ms())?)).await?;
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn notebook_create(state: State<'_, AppState>, title: String) -> AppResult<Notebook> {
    let id = new_id();
    let title = clean_title(&title).unwrap_or_else(|| UNTITLED.into());
    let (store, nid) = (state.store.clone(), id.clone());
    blocking(move || Ok(store.create_notebook(&nid, &title, now_ms())?)).await?;
    changed(&state, &id).await
}

#[tauri::command]
pub async fn notebook_rename(state: State<'_, AppState>, id: String, title: String) -> AppResult<Notebook> {
    let title = clean_title(&title).ok_or_else(|| AppError::Invalid("Give the notebook a name.".into()))?;
    let (store, nid) = (state.store.clone(), id.clone());
    blocking(move || Ok(store.rename_notebook(&nid, &title, now_ms())?)).await?;
    changed(&state, &id).await
}

/// A new notebook's name until the user, or its first overview, gives it one.
const UNTITLED: &str = "Untitled notebook";
/// Largest cover image.
const MAX_COVER: u64 = 10 * 1024 * 1024;

/// The Customize dialog: title, emoji and the user's own summary (`None` uses the generated one).
#[tauri::command]
pub async fn notebook_customize(
    state: State<'_, AppState>,
    id: String,
    title: String,
    emoji: Option<String>,
    custom_summary: Option<String>,
    cover: Option<String>,
    cover_position: Option<CoverPosition>,
) -> AppResult<Notebook> {
    // Only a picture stored here (`notebook_pick_cover`), never an address the webview made up.
    if cover.as_deref().is_some_and(|c| sush_core::store::blob_sha(c).is_none()) {
        return Err(AppError::Invalid("That cover image isn't stored here.".into()));
    }
    let title = clean_title(&title).ok_or_else(|| AppError::Invalid("Give the notebook a name.".into()))?;
    let emoji = emoji.map(|e| e.trim().chars().take(8).collect::<String>()).filter(|e| !e.is_empty());
    let custom_summary = custom_summary.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let (store, nid) = (state.store.clone(), id.clone());
    blocking(move || {
        Ok(store.update_notebook_extras(&nid, |x, current| {
            if title != current {
                x.named = true;
            }
            x.emoji = emoji;
            x.custom_summary = custom_summary;
            // Centred, or no picture to frame, needs no record.
            x.cover_position = cover_position
                .filter(|_| cover.is_some())
                .map(CoverPosition::clamped)
                .filter(|p| (p.x, p.y, p.zoom) != (50.0, 50.0, 1.0));
            x.cover = cover;
            Ok(Some(title))
        })?)
    })
    .await?;
    changed(&state, &id).await
}

/// Keep a generated overview. Its title and emoji are only suggestions: they
/// apply while the notebook is still untitled and has no emoji.
#[tauri::command]
pub async fn notebook_set_overview(
    state: State<'_, AppState>,
    id: String,
    overview: Overview,
    title: Option<String>,
    emoji: Option<String>,
) -> AppResult<Notebook> {
    let title = title.as_deref().and_then(clean_title);
    let emoji = emoji.map(|e| e.trim().chars().take(8).collect::<String>()).filter(|e| !e.is_empty());
    let (store, nid) = (state.store.clone(), id.clone());
    blocking(move || {
        Ok(store.update_notebook_extras(&nid, |x, current| {
            x.overview = Some(overview);
            if x.emoji.is_none() {
                x.emoji = emoji;
            }
            Ok(title.filter(|_| !x.named && current == UNTITLED))
        })?)
    })
    .await?;
    changed(&state, &id).await
}

/// Ask for a cover image and store it, without changing any notebook: the
/// Customize dialog shows it, and only its Done (`notebook_customize`) puts it
/// on the notebook, so Cancel keeps the old one. `None` if they cancelled.
#[tauri::command]
pub async fn notebook_pick_cover(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<String>> {
    let dialog = app.clone();
    let picked = tokio::task::spawn_blocking(move || {
        dialog
            .dialog()
            .file()
            .set_title("Choose a cover image")
            .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?;
    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(|e| AppError::Invalid(format!("That image can't be used: {e}")))?;
    let store = state.store.clone();
    blocking(move || {
        if std::fs::metadata(&path)?.len() > MAX_COVER {
            return Err(AppError::Invalid("Pick an image under 10 MB.".into()));
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
        let media_type = match ext.as_str() {
            "png" => "image/png",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => "image/jpeg",
        };
        Ok(Some(store.put_blob(media_type, &std::fs::read(&path)?)?))
    })
    .await
}

// --- notes and Studio ---------------------------------------------------------------

/// A new note: written by the user, or a chat reply saved (its citations kept).
#[tauri::command]
pub async fn notebook_note_create(state: State<'_, AppState>, id: String, title: String, body: String) -> AppResult<Note> {
    let now = now_ms();
    let title = clean_title(&title).unwrap_or_else(|| if body.trim().is_empty() { "New note".into() } else { first_words(&strip_markers(&body)) });
    let note = Note {
        id: new_id(),
        notebook_id: id.clone(),
        kind: NoteKind::Note,
        title,
        body,
        status: NoteStatus::Ready,
        error: None,
        thread_id: None,
        data: None,
        created_at: now,
        updated_at: now,
    };
    let (store, n) = (state.store.clone(), note.clone());
    blocking(move || Ok(store.save_note(&n, now)?)).await?;
    changed(&state, &id).await?;
    Ok(note)
}

#[tauri::command]
pub async fn notebook_note_update(state: State<'_, AppState>, note_id: String, title: String, body: String) -> AppResult<Note> {
    let title = clean_title(&title).ok_or_else(|| AppError::Invalid("Give the note a title.".into()))?;
    let store = state.store.clone();
    let note = blocking(move || {
        Ok(store.update_note(&note_id, now_ms(), |n| {
            if n.status == NoteStatus::Writing {
                return Err("It's still being written.".into());
            }
            n.title = title;
            n.body = body;
            Ok(())
        })?)
    })
    .await?;
    changed(&state, &note.notebook_id).await?;
    Ok(note)
}

/// Delete a note, stopping a Studio output's run. Returns its run's thread, for the UI to delete.
#[tauri::command]
pub async fn notebook_note_delete(state: State<'_, AppState>, note_id: String) -> AppResult<Option<String>> {
    let (store, id) = (state.store.clone(), note_id.clone());
    let Some(note) = blocking(move || Ok(store.note(&id)?)).await? else { return Ok(None) };
    if let Some(t) = &note.thread_id {
        state.runs.stop(t).await;
    }
    let store = state.store.clone();
    blocking(move || Ok(store.delete_note(&note_id)?)).await?;
    changed(&state, &note.notebook_id).await?;
    Ok(note.thread_id)
}

/// Start a Studio output: a note marked "writing", whose run on `thread_id`
/// (started by the UI, like any run) reads the sources and writes it. `runs.rs`
/// gives that thread the Studio instructions and files the result when it ends.
#[tauri::command]
pub async fn notebook_studio_start(state: State<'_, AppState>, id: String, kind: NoteKind, thread_id: String) -> AppResult<Note> {
    if kind == NoteKind::Note {
        return Err(AppError::Invalid("That isn't a Studio output.".into()));
    }
    let now = now_ms();
    let note = Note {
        id: new_id(),
        notebook_id: id.clone(),
        kind,
        title: kind.label().into(),
        body: String::new(),
        status: NoteStatus::Writing,
        error: None,
        thread_id: Some(thread_id),
        data: None,
        created_at: now,
        updated_at: now,
    };
    let (store, n) = (state.store.clone(), note.clone());
    blocking(move || Ok(store.save_note(&n, now)?)).await?;
    changed(&state, &id).await?;
    Ok(note)
}

/// Keep an audio overview's voiced clips (its script with each turn's `audio`
/// blob URL, and which voices made them). Only audio overviews take this, and
/// only clips stored here.
#[tauri::command]
pub async fn notebook_note_set_data(state: State<'_, AppState>, note_id: String, data: serde_json::Value) -> AppResult<Note> {
    fn clips_are_blobs(v: &serde_json::Value) -> bool {
        match v {
            serde_json::Value::Object(o) => o.iter().all(|(k, v)| {
                if k == "audio" {
                    v.is_null() || v.as_str().is_some_and(|u| sush_core::store::blob_sha(u).is_some())
                } else {
                    clips_are_blobs(v)
                }
            }),
            serde_json::Value::Array(a) => a.iter().all(clips_are_blobs),
            _ => true,
        }
    }
    if !clips_are_blobs(&data) {
        return Err(AppError::Invalid("Those clips aren't stored here.".into()));
    }
    let store = state.store.clone();
    let note = blocking(move || {
        Ok(store.update_note(&note_id, now_ms(), |n| {
            if n.kind != NoteKind::AudioOverview {
                return Err("Only an audio overview's clips can be saved this way.".into());
            }
            n.data = Some(data);
            Ok(())
        })?)
    })
    .await?;
    changed(&state, &note.notebook_id).await?;
    Ok(note)
}

/// A Studio output's run ended: keep what it wrote, or why it didn't. Called by `runs.rs`.
pub(crate) async fn studio_finished(state: &AppState, note_id: &str, text: Option<String>, error: Option<String>) {
    let (store, id) = (state.store.clone(), note_id.to_string());
    let saved = blocking(move || {
        Ok(store.update_note(&id, now_ms(), |n| {
            match (text, error) {
                // A quiz, deck or map is what it saved with `studio_save`; its last words aren't the content.
                (_, None) if n.kind.interactive() => {
                    if n.data.is_some() {
                        n.status = NoteStatus::Ready;
                        n.error = None;
                    } else {
                        n.status = NoteStatus::Failed;
                        n.error = Some(format!("It finished without saving the {}. Try again.", n.kind.label().to_lowercase()));
                    }
                }
                (Some(text), None) => {
                    let (title, body) = notebooks::split_title(&text);
                    if let Some(t) = title {
                        n.title = t;
                    }
                    n.body = body;
                    n.status = NoteStatus::Ready;
                    n.error = None;
                }
                (_, error) => {
                    n.status = NoteStatus::Failed;
                    n.error = Some(error.unwrap_or_else(|| "It stopped before writing anything.".into()));
                }
            }
            Ok(())
        })?)
    })
    .await;
    if let Ok(note) = saved {
        let _ = changed(state, &note.notebook_id).await;
    }
}

/// Text without citation markers, for a title.
fn strip_markers(text: &str) -> String {
    sush_core::agent::ui::strip_citations(text)
}

/// Keep a generated guide to a source.
#[tauri::command]
pub async fn notebook_source_set_guide(state: State<'_, AppState>, source_id: String, guide: SourceGuide) -> AppResult<Source> {
    let store = state.store.clone();
    let source = blocking(move || {
        Ok(store.update_source(&source_id, now_ms(), |s| {
            s.guide = Some(guide);
            Ok(())
        })?)
    })
    .await?;
    changed(&state, &source.notebook_id).await?;
    Ok(source)
}

/// Delete a notebook and its sources, stopping its chats' runs. Returns its
/// chats' threads, which the UI deletes like any session.
#[tauri::command]
pub async fn notebook_delete(state: State<'_, AppState>, id: String) -> AppResult<Vec<String>> {
    let (store, nid) = (state.store.clone(), id.clone());
    // Its chats and its Studio outputs' runs: a run left going would keep spending tokens on a notebook that's gone.
    let threads = blocking(move || {
        Ok(store
            .notebook(&nid)?
            .map(|n| n.thread_ids.into_iter().chain(n.notes.into_iter().filter_map(|x| x.thread_id)).collect::<Vec<_>>())
            .unwrap_or_default())
    })
    .await?;
    for t in &threads {
        state.runs.stop(t).await;
    }
    let (store, nid) = (state.store.clone(), id.clone());
    let threads = blocking(move || Ok(store.delete_notebook(&nid)?)).await?;
    state.runs.notebook_gone(id);
    Ok(threads)
}

/// File a new thread under a notebook as one of its chats.
#[tauri::command]
pub async fn notebook_add_thread(state: State<'_, AppState>, id: String, thread_id: String) -> AppResult<Notebook> {
    let (store, nid) = (state.store.clone(), id.clone());
    blocking(move || {
        store.notebook(&nid)?.ok_or_else(|| AppError::NotFound("That notebook no longer exists.".into()))?;
        Ok(store.add_notebook_thread(&nid, &thread_id, now_ms())?)
    })
    .await?;
    changed(&state, &id).await
}

/// Add pasted text as a source.
#[tauri::command]
pub async fn notebook_add_text(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    title: String,
    text: String,
    kind: Option<SourceKind>,
) -> AppResult<Source> {
    // Text the UI made: pasted, or an audio file it transcribed.
    let kind = match kind.unwrap_or(SourceKind::Text) {
        k @ (SourceKind::Text | SourceKind::Audio) => k,
        _ => return Err(AppError::Invalid("That kind of source can't be added as text.".into())),
    };
    if text.trim().is_empty() {
        return Err(AppError::Invalid("There's no text to add.".into()));
    }
    let title = clean_title(&title).unwrap_or_else(|| first_words(&text));
    let store = state.store.clone();
    let blob = blocking(move || Ok(store.put_blob("text/plain", text.as_bytes())?)).await?;
    let mut source = Source::new(new_id(), id, kind, title, now_ms());
    source.blob = sush_core::store::blob_sha(&blob).map(str::to_owned);
    add(app, &state, source).await
}

/// Add a past Sush chat as a source: its transcript as it is now.
#[tauri::command]
pub async fn notebook_add_chat(app: AppHandle, state: State<'_, AppState>, id: String, thread_id: String) -> AppResult<Source> {
    let store = state.store.clone();
    let (title, blob) = blocking(move || {
        let meta = store.thread_meta(&thread_id)?.ok_or_else(|| AppError::NotFound("That chat no longer exists.".into()))?;
        let text = sush_core::store::transcript(&store.messages(&thread_id)?);
        if text.trim().is_empty() {
            return Err(AppError::Invalid("That chat has no messages to add.".into()));
        }
        Ok((meta.title, store.put_blob("text/plain", text.as_bytes())?))
    })
    .await?;
    let mut source = Source::new(new_id(), id, SourceKind::Chat, clean_title(&title).unwrap_or_else(|| "Past chat".into()), now_ms());
    source.blob = sush_core::store::blob_sha(&blob).map(str::to_owned);
    add(app, &state, source).await
}

/// Add a file from a Cowork folder, read under the folder's own rules (inside
/// it only; secret-looking files refused). PDFs are read as PDFs, anything
/// else as text; binary files are refused.
#[tauri::command]
pub async fn notebook_add_workspace_file(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    workspace_id: String,
    path: String,
) -> AppResult<Source> {
    let store = state.store.clone();
    let (kind, title, blob) = blocking(move || {
        let fs = crate::workspaces::open(&store, &workspace_id)?;
        let rel = fs.rel(&path).map_err(AppError::Invalid)?;
        if sush_core::workspace::looks_secret(&rel) {
            return Err(AppError::Invalid(format!("{rel} looks like it holds secrets, so it isn't added.")));
        }
        let bytes = fs.bytes(&rel).map_err(AppError::Invalid)?.ok_or_else(|| AppError::NotFound(format!("{rel} doesn't exist.")))?;
        if bytes.len() as u64 > MAX_FILE {
            return Err(AppError::Invalid(format!("{rel} is larger than {} MB.", MAX_FILE / (1024 * 1024))));
        }
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        if rel.to_ascii_lowercase().ends_with(".pdf") {
            let url = store.put_blob("application/pdf", &bytes)?;
            return Ok((SourceKind::Pdf, name, url));
        }
        if bytes.iter().take(8192).any(|&b| b == 0) {
            return Err(AppError::Invalid(format!("{rel} isn't a text file.")));
        }
        Ok((SourceKind::File, rel.clone(), store.put_blob("text/plain", &bytes)?))
    })
    .await?;
    let mut source = Source::new(new_id(), id, kind, title, now_ms());
    source.blob = sush_core::store::blob_sha(&blob).map(str::to_owned);
    add(app, &state, source).await
}

/// Add a web page or a paper (an arXiv id or link, or a DOI) as a source.
#[tauri::command]
pub async fn notebook_add_link(app: AppHandle, state: State<'_, AppState>, id: String, url: String) -> AppResult<Source> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::Invalid("Paste a link to add.".into()));
    }
    let kind = if notebooks::youtube_id(&url).is_some() {
        SourceKind::Youtube
    } else if notebooks::paper_url(&url).is_some() {
        SourceKind::Paper
    } else {
        SourceKind::Web
    };
    let mut source = Source::new(new_id(), id, kind, url.clone(), now_ms());
    source.url = Some(url);
    add(app, &state, source).await
}

/// Ask for files (PDFs, text, Markdown) and add each as a source. The dialog
/// opens here so the webview never names a path. Empty if they cancelled.
#[tauri::command]
pub async fn notebook_add_files(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<Vec<Source>> {
    let dialog = app.clone();
    let picked = tokio::task::spawn_blocking(move || {
        dialog
            .dialog()
            .file()
            .set_title("Add sources")
            .add_filter("Documents", &["pdf", "txt", "md", "markdown"])
            .blocking_pick_files()
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?
    .unwrap_or_default();
    let mut added = Vec::new();
    for file in picked {
        let path = file.into_path().map_err(|e| AppError::Invalid(format!("That file can't be used: {e}")))?;
        let store = state.store.clone();
        let (kind, title, blob) = blocking(move || read_file(&store, &path)).await?;
        let mut source = Source::new(new_id(), id.clone(), kind, title, now_ms());
        source.blob = Some(blob);
        added.push(add(app.clone(), &state, source).await?);
    }
    Ok(added)
}

/// A picked file's kind and title, stored as a blob.
fn read_file(store: &sush_core::store::Store, path: &Path) -> AppResult<(SourceKind, String, String)> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let size = std::fs::metadata(path)?.len();
    if size > MAX_FILE {
        return Err(AppError::Invalid(format!("{name} is larger than {} MB.", MAX_FILE / (1024 * 1024))));
    }
    store_file(store, &name, &std::fs::read(path)?)
}

/// A file's kind and title (its name without the extension), stored as a blob.
fn store_file(store: &sush_core::store::Store, name: &str, bytes: &[u8]) -> AppResult<(SourceKind, String, String)> {
    let path = Path::new(name);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    let (kind, media_type) = match ext.as_str() {
        "pdf" => (SourceKind::Pdf, "application/pdf"),
        "txt" | "md" | "markdown" => (SourceKind::Text, "text/plain"),
        _ => return Err(AppError::Invalid(format!("{name} isn't a PDF, text or Markdown file."))),
    };
    let stem = path.file_stem().and_then(|n| n.to_str()).unwrap_or(name).to_string();
    let url = store.put_blob(media_type, bytes)?;
    let sha = sush_core::store::blob_sha(&url).ok_or_else(|| AppError::Invalid("The file couldn't be stored.".into()))?;
    Ok((kind, stem, sha.to_string()))
}

/// Add a file dropped on the window, by its contents (base64). The webview
/// hands over the bytes the user dropped, never a path to read.
#[tauri::command]
pub async fn notebook_add_file_data(app: AppHandle, state: State<'_, AppState>, id: String, name: String, data: String) -> AppResult<Source> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| AppError::Invalid(format!("{name} couldn't be read.")))?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(AppError::Invalid(format!("{name} is larger than {} MB.", MAX_FILE / (1024 * 1024))));
    }
    let store = state.store.clone();
    let (kind, title, blob) = blocking(move || store_file(&store, &name, &bytes)).await?;
    let mut source = Source::new(new_id(), id, kind, title, now_ms());
    source.blob = Some(blob);
    add(app, &state, source).await
}

/// Check or uncheck a source, or rename it.
#[tauri::command]
pub async fn notebook_source_update(
    state: State<'_, AppState>,
    source_id: String,
    checked: Option<bool>,
    title: Option<String>,
) -> AppResult<Source> {
    let title = match title {
        Some(t) => Some(clean_title(&t).ok_or_else(|| AppError::Invalid("Give the source a name.".into()))?),
        None => None,
    };
    let store = state.store.clone();
    let source = blocking(move || {
        Ok(store.update_source(&source_id, now_ms(), |s| {
            if let Some(c) = checked {
                s.checked = c;
            }
            if let Some(t) = title {
                s.title = t;
            }
            Ok(())
        })?)
    })
    .await?;
    changed(&state, &source.notebook_id).await?;
    Ok(source)
}

#[tauri::command]
pub async fn notebook_source_delete(state: State<'_, AppState>, source_id: String) -> AppResult<()> {
    let store = state.store.clone();
    let id = source_id.clone();
    let notebook = blocking(move || {
        let notebook = store.source(&id)?.map(|s| s.notebook_id);
        store.delete_source(&id)?;
        Ok(notebook)
    })
    .await?;
    if let Some(n) = notebook {
        changed(&state, &n).await?;
    }
    Ok(())
}

/// Read a source again (after it failed, or to pick up a changed page).
#[tauri::command]
pub async fn notebook_source_retry(app: AppHandle, state: State<'_, AppState>, source_id: String) -> AppResult<Source> {
    if READING.lock().unwrap().contains(&source_id) {
        return Err(AppError::Invalid("It's still being read.".into()));
    }
    let store = state.store.clone();
    let source = blocking(move || {
        Ok(store.update_source(&source_id, now_ms(), |s| {
            s.status = SourceStatus::Reading;
            s.error = None;
            Ok(())
        })?)
    })
    .await?;
    changed(&state, &source.notebook_id).await?;
    start_reading(app, source.clone());
    Ok(source)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceText {
    source: Source,
    passages: Vec<Passage>,
}

/// A source's text as chunked, for the viewer; `limit` passages from the start
/// when only the beginning is wanted (a guide or an overview).
#[tauri::command]
pub async fn notebook_source_text(state: State<'_, AppState>, source_id: String, limit: Option<usize>) -> AppResult<SourceText> {
    let store = state.store.clone();
    blocking(move || {
        let source = store.source(&source_id)?.ok_or_else(|| AppError::NotFound("That source no longer exists.".into()))?;
        let passages = store.source_passages(&source_id, None, None, limit.unwrap_or(20_000).min(20_000))?;
        Ok(SourceText { source, passages })
    })
    .await
}

/// Save a new source, tell every window, and start reading it.
async fn add(app: AppHandle, state: &AppState, source: Source) -> AppResult<Source> {
    let (store, s) = (state.store.clone(), source.clone());
    blocking(move || Ok(store.save_source(&s, now_ms())?)).await?;
    changed(state, &source.notebook_id).await?;
    start_reading(app, source.clone());
    Ok(source)
}

fn start_reading(app: AppHandle, source: Source) {
    READING.lock().unwrap().insert(source.id.clone());
    tauri::async_runtime::spawn(async move {
        let _permit = READERS.acquire().await;
        let state = app.state::<AppState>();
        let result = read(&state, &source).await;
        let (store, id, notebook) = (state.store.clone(), source.id.clone(), source.notebook_id.clone());
        let saved = blocking(move || {
            Ok(store.update_source(&id, now_ms(), |s| {
                match result {
                    Ok(read) => {
                        s.status = SourceStatus::Ready;
                        s.error = None;
                        s.pages = read.pages;
                        s.chars = read.chars;
                        s.chunks = read.chunks;
                        s.truncated = read.truncated;
                        if let Some(blob) = read.blob {
                            s.blob = Some(blob);
                        }
                        // A link's placeholder title gives way to the page's own.
                        if let Some(title) = read.title.filter(|_| s.url.as_deref() == Some(s.title.as_str())) {
                            s.title = title;
                        }
                    }
                    Err(e) => {
                        s.status = SourceStatus::Failed;
                        s.error = Some(e);
                    }
                }
                Ok(())
            })?)
        })
        .await;
        READING.lock().unwrap().remove(&source.id);
        // Deleted while it was being read: nothing to report.
        if saved.is_ok() {
            let _ = changed(&state, &notebook).await;
        }
    });
}

/// What reading a source found, its chunks already stored.
struct Read {
    title: Option<String>,
    pages: Option<u32>,
    chars: u64,
    chunks: u32,
    truncated: bool,
    /// A PDF fetched from a link, kept for the viewer.
    blob: Option<String>,
}

async fn read(state: &AppState, source: &Source) -> Result<Read, String> {
    let store = state.store.clone();
    let (mut pages, title, blob) = match (&source.blob, &source.url) {
        (Some(sha), _) => {
            let sha = sha.clone();
            let (media_type, bytes) = blocking(move || {
                store.blob(&sha)?.ok_or_else(|| AppError::NotFound("The file is missing from disk; add it again.".into()))
            })
            .await
            .map_err(|e| e.to_string())?;
            let pages = if media_type == "application/pdf" {
                pdf_text(state, bytes).await?
            } else {
                notebooks::text_pages(&String::from_utf8_lossy(&bytes))
            };
            (pages, None, None)
        }
        (None, Some(url)) if source.kind == SourceKind::Youtube => {
            let id = notebooks::youtube_id(url).ok_or("That isn't a YouTube video link.")?;
            let (title, lines) = web::youtube_transcript(&id).await.map_err(capitalise)?;
            (notebooks::timed_pages(&lines), title, None)
        }
        (None, Some(url)) => {
            let target = notebooks::paper_url(url).unwrap_or_else(|| url.clone());
            match web::fetch_source(&target).await.map_err(capitalise)? {
                Fetched::Page { title, text, .. } => (notebooks::text_pages(&text), title, None),
                Fetched::Pdf { bytes, .. } => {
                    let (store, kept) = (store.clone(), bytes.clone());
                    let url = blocking(move || Ok(store.put_blob("application/pdf", &kept)?)).await.map_err(|e| e.to_string())?;
                    (pdf_text(state, bytes).await?, None, sush_core::store::blob_sha(&url).map(str::to_owned))
                }
            }
        }
        (None, None) => return Err("This source has nothing to read.".into()),
    };
    if pages.iter().all(|p| p.text.trim().is_empty()) {
        return Err("There's no text in it to read.".into());
    }
    let page_count = pages.iter().filter_map(|p| p.number).max();
    let truncated = notebooks::cap_pages(&mut pages);
    let chars = pages.iter().map(|p: &Page| p.text.chars().count() as u64).sum();
    let chunks = notebooks::chunk(&pages);
    let count = chunks.len() as u32;
    let (store, id) = (state.store.clone(), source.id.clone());
    blocking(move || Ok(store.set_source_chunks(&id, &chunks)?)).await.map_err(|e| e.to_string())?;
    Ok(Read { title, pages: page_count, chars, chunks: count, truncated, blob })
}

/// The model scanned PDFs are read with: the one the user last picked (`notebook_set_reader`).
static READER: LazyLock<Mutex<Option<(String, String)>>> = LazyLock::new(Default::default);

/// The UI says which model it uses, so scanned PDFs can be read with it.
#[tauri::command]
pub fn notebook_set_reader(provider_id: Option<String>, model: Option<String>) {
    *READER.lock().unwrap() = provider_id.zip(model);
}

/// A PDF's text: extracted, or for scanned pages, read by the model a few pages at a time.
async fn pdf_text(state: &AppState, bytes: Vec<u8>) -> Result<Vec<notebooks::Page>, String> {
    let copy = bytes.clone();
    match tokio::task::spawn_blocking(move || notebooks::pdf_pages(&copy)).await.map_err(|e| e.to_string())? {
        Ok(pages) => Ok(pages),
        Err(notebooks::PdfProblem::Failed(e)) => Err(e),
        Err(notebooks::PdfProblem::Scanned) => transcribe(state, bytes).await,
    }
}

/// Read a scanned PDF with the user's model: each batch of pages goes as a
/// document, and the model writes back each page's text.
async fn transcribe(state: &AppState, bytes: Vec<u8>) -> Result<Vec<notebooks::Page>, String> {
    use base64::Engine;
    use futures::StreamExt;
    use sush_core::{ChatEvent, ChatRequest, Message, Part, Role};

    let Some((provider_id, model)) = READER.lock().unwrap().clone() else {
        return Err("This PDF is scanned pages. Pick a model in a chat (one that reads PDFs, like Claude or GPT), then choose Read again.".into());
    };
    let provider = crate::commands::provider_for(state, &provider_id).map_err(|e| e.to_string())?;
    let batches = tokio::task::spawn_blocking(move || notebooks::pdf_batches(&bytes)).await.map_err(|e| e.to_string())??;
    let mut pages = Vec::new();
    for (numbers, pdf) in batches {
        let request = ChatRequest {
            model: model.clone(),
            messages: vec![Message {
                role: Role::User,
                parts: vec![
                    Part::Document {
                        media_type: "application/pdf".into(),
                        data: base64::engine::general_purpose::STANDARD.encode(&pdf),
                        name: Some(format!("pages {}-{}", numbers[0], numbers[numbers.len() - 1])),
                    },
                    Part::Text { text: notebooks::TRANSCRIBE_PROMPT.into() },
                ],
            }],
            system: None,
            max_tokens: Some(16_000),
            temperature: None,
            tools: vec![],
            research: false,
            thinking: None,
            effort: None,
        };
        let failed = |e: String| format!("{model} couldn't read the scanned pages ({e}). Pick a model that reads PDFs, like Claude or GPT, and choose Read again.");
        let mut stream = provider.stream_chat(request).await.map_err(|e| failed(e.to_string()))?;
        let mut text = String::new();
        while let Some(event) = stream.next().await {
            match event.map_err(|e| failed(e.to_string()))? {
                ChatEvent::TextDelta { delta } => text.push_str(&delta),
                ChatEvent::Error { message } => return Err(failed(message)),
                _ => {}
            }
        }
        pages.extend(notebooks::parse_transcription(&text, &numbers));
    }
    Ok(pages)
}

fn capitalise(message: String) -> String {
    let mut chars = message.chars();
    match chars.next() {
        Some(c) => format!("{}{}.", c.to_uppercase(), chars.as_str().trim_end_matches('.')),
        None => message,
    }
}

fn clean_title(title: &str) -> Option<String> {
    let t = title.split_whitespace().collect::<Vec<_>>().join(" ");
    (!t.is_empty()).then(|| t.chars().take(200).collect())
}

/// A title for pasted text: its first few words.
fn first_words(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().take(8).collect();
    let mut title = words.join(" ");
    if text.split_whitespace().nth(8).is_some() {
        title.push('…');
    }
    title.chars().take(80).collect()
}
