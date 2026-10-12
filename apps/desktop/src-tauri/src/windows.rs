//! Session windows, as in a browser: a tab dragged out of the strip and
//! dropped opens in a window of its own, and one dropped on another window's
//! tab strip moves there. While it's dragged over another window's strip,
//! that window makes room for it (`tab_hover`).
//!
//! Every window runs the same page. One opened here learns which session to
//! show from an initialization script (`window.__SUSH_OPEN_SESSION__`); the
//! windows keep each other's copies of the store in step with events (see
//! `lib/windows.ts`), and every window gets every run's frames (`runs.rs`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, Window};

use crate::browser::Browser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The title bar holding the tab strip, in CSS pixels, plus some slack below it.
const TAB_STRIP_HEIGHT: f64 = 64.0;
/// Where the cursor lands on a new window: over its first tab.
const GRAB: (f64, f64) = (160.0, 24.0);
/// How far (CSS pixels) a window opened from the menu sits below and right of the one it came from.
const CASCADE: f64 = 32.0;

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TabDrop {
    /// Opened in a new window.
    Detached,
    /// Moved into another window's tab strip.
    Attached,
    /// Nothing happened: it was the window's only tab and wasn't dropped on another window.
    Stayed,
}

/// A tab over (hover) or dropped on (attach) a window's strip.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StripTab {
    thread_id: String,
    /// Where the cursor is, in CSS pixels from the window's left edge.
    x: f64,
}

/// The window whose strip a dragged tab is over, if any: the one making room for it.
static HOVERED: Mutex<Option<String>> = Mutex::new(None);

/// Another window whose tab strip is under the cursor, and the cursor's x there in CSS pixels.
fn strip_under_cursor(app: &AppHandle, window: &Window) -> AppResult<Option<(Window, f64)>> {
    let cursor = app.cursor_position().map_err(invalid)?;
    for (label, other) in app.windows() {
        if label == window.label() || !other.is_visible().unwrap_or(false) || other.is_minimized().unwrap_or(false) {
            continue;
        }
        let (Ok(pos), Ok(size), Ok(scale)) = (other.inner_position(), other.inner_size(), other.scale_factor()) else {
            continue;
        };
        let (x, y) = (cursor.x - f64::from(pos.x), cursor.y - f64::from(pos.y));
        if x >= 0.0 && x < f64::from(size.width) && y >= 0.0 && y < TAB_STRIP_HEIGHT * scale {
            return Ok(Some((other, x / scale)));
        }
    }
    Ok(None)
}

/// Tell the window that was making room for a dragged tab that it has gone, unless it's `keep`.
fn leave_hovered(app: &AppHandle, keep: Option<&str>) {
    let mut hovered = HOVERED.lock().unwrap();
    if hovered.as_deref() == keep {
        return;
    }
    if let Some(label) = hovered.take() {
        let _ = app.emit_to(label.as_str(), "sush://tab-hover", None::<StripTab>);
    }
    *hovered = keep.map(str::to_string);
}

/// A torn-off tab is being dragged (`thread_id`), or the drag is over (None).
/// The window whose strip is under the cursor makes room for it at the cursor;
/// returns whether there is one, so this window can hide its own preview.
#[tauri::command]
pub fn tab_hover(app: AppHandle, window: Window, thread_id: Option<String>) -> AppResult<bool> {
    let target = match &thread_id {
        Some(_) => strip_under_cursor(&app, &window)?,
        None => None,
    };
    leave_hovered(&app, target.as_ref().map(|(w, _)| w.label()));
    let (Some((other, x)), Some(thread_id)) = (target, thread_id) else { return Ok(false) };
    other.emit_to(other.label(), "sush://tab-hover", Some(StripTab { thread_id, x })).map_err(invalid)?;
    Ok(true)
}

/// A tab was dragged out of `window`'s strip and let go. Decide by where the
/// cursor is now: over another window's tab strip moves it there, anywhere
/// else opens it in a new window, unless it was the window's `last` tab.
/// Async: building a window from a sync command deadlocks on Windows.
#[tauri::command]
pub async fn tab_drop(app: AppHandle, window: Window, thread_id: String, last: bool) -> AppResult<TabDrop> {
    let target = strip_under_cursor(&app, &window)?;
    leave_hovered(&app, None);
    if let Some((other, x)) = target {
        other.emit_to(other.label(), "sush://attach-tab", StripTab { thread_id, x }).map_err(invalid)?;
        let _ = other.set_focus();
        return Ok(TabDrop::Attached);
    }
    if last {
        return Ok(TabDrop::Stayed);
    }
    let cursor = app.cursor_position().map_err(invalid)?;
    let scale = window.scale_factor().map_err(invalid)?;
    // Physical, so it's right whichever screen the cursor is on.
    open_window(&app, &window, &thread_id, PhysicalPosition::new(cursor.x - GRAB.0 * scale, cursor.y - GRAB.1 * scale))?;
    Ok(TabDrop::Detached)
}

/// Open a session in a new window (the session menu's Open in → New window),
/// a little below and right of `window`. Async for the same reason as `tab_drop`.
#[tauri::command]
pub async fn session_window(app: AppHandle, window: Window, thread_id: String) -> AppResult<()> {
    let scale = window.scale_factor().map_err(invalid)?;
    let pos = window.outer_position().map_err(invalid)?;
    let offset = CASCADE * scale;
    open_window(&app, &window, &thread_id, PhysicalPosition::new(f64::from(pos.x) + offset, f64::from(pos.y) + offset))
}

/// A new window the size of `window`, at `position`, showing `thread_id`.
fn open_window(app: &AppHandle, window: &Window, thread_id: &str, position: PhysicalPosition<f64>) -> AppResult<()> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let label = format!("session-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
    let scale = window.scale_factor().map_err(invalid)?;
    let size = window.inner_size().map_err(invalid)?.to_logical::<f64>(scale);
    let script = format!("window.__SUSH_OPEN_SESSION__ = {};", serde_json::to_string(thread_id)?);
    // Like the main window (tauri.conf.json, tauri.macos.conf.json): undecorated, or macOS's overlay title bar.
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("Sush")
        .inner_size(size.width, size.height)
        .min_inner_size(720.0, 500.0)
        .visible(false)
        .initialization_script(&script);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    let new = builder.build().map_err(invalid)?;
    let _ = new.set_position(position);
    new.show().map_err(invalid)?;
    let _ = new.set_focus();
    Ok(())
}

/// A window is closing: hand the browser to another window if it lives in this one.
pub fn closing(window: &Window) {
    window.state::<Browser>().evacuate(window);
}

/// A window is gone: stop sending it frames.
pub fn destroyed(window: &Window) {
    window.state::<AppState>().runs.unsubscribe(window.app_handle(), window.label());
    window.state::<Browser>().unsubscribe(window.label());
}

fn invalid(e: impl std::fmt::Display) -> AppError {
    AppError::Invalid(e.to_string())
}
