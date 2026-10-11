//! The terminal in Cowork's side panel: the user's own shell, started in the
//! workspace folder through a PTY. It's the user typing, not the agent, so it
//! runs outside the sandbox like any terminal they'd open themselves.

use std::io::{Read, Write};
use std::path::Path;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use sush_core::agent::ui::new_id;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::blocking;

pub struct Terminal {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

fn pty_error(e: impl std::fmt::Display) -> AppError {
    AppError::Invalid(format!("The terminal failed: {e}"))
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

/// Start a shell in a workspace folder. Its output arrives on `on_data`.
#[tauri::command]
pub async fn terminal_open(
    state: State<'_, AppState>,
    workspace_id: String,
    cols: u16,
    rows: u16,
    on_data: Channel<String>,
) -> AppResult<String> {
    let store = state.store.clone();
    let workspace = blocking(move || {
        store.workspace(&workspace_id)?.ok_or_else(|| AppError::NotFound("That workspace no longer exists.".into()))
    })
    .await?;

    let pair = native_pty_system().openpty(size(cols, rows)).map_err(pty_error)?;
    let mut cmd = CommandBuilder::new(default_shell());
    cmd.cwd(Path::new(&workspace.root));
    let child = pair.slave.spawn_command(cmd).map_err(pty_error)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(pty_error)?;
    let writer = pair.master.take_writer().map_err(pty_error)?;

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            let text = take_utf8(&mut pending);
            if !text.is_empty() && on_data.send(text).is_err() {
                return; // the page went away
            }
        }
        let _ = on_data.send("\r\n[the shell exited]\r\n".into());
    });

    let id = new_id();
    state.terminals.lock().unwrap().insert(id.clone(), Terminal { writer, master: pair.master, child });
    Ok(id)
}

/// Keystrokes from the UI.
#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, id: String, data: String) -> AppResult<()> {
    let mut terminals = state.terminals.lock().unwrap();
    let t = terminals.get_mut(&id).ok_or_else(|| AppError::NotFound("That terminal was closed.".into()))?;
    t.writer.write_all(data.as_bytes())?;
    t.writer.flush()?;
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> AppResult<()> {
    let terminals = state.terminals.lock().unwrap();
    if let Some(t) = terminals.get(&id) {
        t.master.resize(size(cols, rows)).map_err(pty_error)?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, id: String) {
    if let Some(mut t) = state.terminals.lock().unwrap().remove(&id) {
        let _ = t.child.kill();
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".into()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

/// The complete UTF-8 text at the front of `pending`, leaving a character
/// split across reads for the next one.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let cut = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => pending.len(),
    };
    let text = String::from_utf8_lossy(&pending[..cut]).into_owned();
    pending.drain(..cut);
    text
}

#[cfg(test)]
mod tests {
    use super::take_utf8;

    #[test]
    fn split_characters_wait_for_the_rest() {
        let mut pending = "héllo".as_bytes()[..2].to_vec(); // "h" plus half of "é"
        assert_eq!(take_utf8(&mut pending), "h");
        assert_eq!(pending.len(), 1);
        pending.extend_from_slice(&"héllo".as_bytes()[2..]);
        assert_eq!(take_utf8(&mut pending), "éllo");
        assert!(pending.is_empty());
    }
}
