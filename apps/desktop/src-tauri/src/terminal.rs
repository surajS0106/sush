//! The terminal in Cowork's side panel: the user's own shell (PowerShell on
//! Windows), started in the workspace folder with plain pipes rather than a
//! PTY. The UI draws it like VS Code's panel: a prompt, the command, its
//! output. Every command is followed by a marker line carrying the shell's
//! working directory; that's how the UI knows the command finished and what
//! to show in the next prompt.
//!
//! It's the user typing, not the agent, so it runs outside the sandbox like
//! any terminal they'd open themselves.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sush_core::agent::ui::new_id;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::blocking;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TerminalEvent {
    /// Output from the shell; `error` for stderr.
    Output { text: String, error: bool },
    /// The shell is waiting for a command, in `cwd`.
    Prompt { cwd: String },
    /// The shell exited by itself (`exit`, or it crashed).
    Exit,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    id: String,
    /// "powershell", "bash" or "sh", for the prompt's look.
    shell: &'static str,
}

/// A file or folder that completes the word being typed (Tab).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    name: String,
    dir: bool,
}

/// More than this and the UI just says how many there are.
const MAX_COMPLETIONS: usize = 500;

pub struct Terminal {
    shared: Arc<Shared>,
    stdin: ChildStdin,
    child: Child,
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

struct Shared {
    on_event: Channel<TerminalEvent>,
    root: PathBuf,
    /// Where the shell was at its last prompt; a restart starts there.
    cwd: Mutex<PathBuf>,
    /// Bumped on every (re)start so an old process's readers fall silent.
    generation: AtomicU64,
}

/// Starts the marker line: unit separators can't show up in normal output.
const MARK: &[u8] = b"\x1fSUSH\x1f";

#[cfg(windows)]
const SHELL: &str = "powershell";
#[cfg(windows)]
const MARKER: &str = "Write-Host ([char]31 + 'SUSH' + [char]31 + $PWD.ProviderPath)";
/// UTF-8 both ways, and no progress bars (they'd print as junk without a console).
#[cfg(windows)]
const SETUP: &str = "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding\n";

#[cfg(not(windows))]
const MARKER: &str = r#"printf '\037SUSH\037%s\n' "$PWD""#;
#[cfg(not(windows))]
const SETUP: &str = "";

#[cfg(not(windows))]
fn unix_shell() -> &'static str {
    if std::path::Path::new("/bin/bash").exists() {
        "bash"
    } else {
        "sh"
    }
}

fn shell_name() -> &'static str {
    #[cfg(windows)]
    return SHELL;
    #[cfg(not(windows))]
    return unix_shell();
}

fn shell_command() -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = Command::new("powershell.exe");
        // Commands come one per line on stdin. NonInteractive: a prompt for
        // input fails instead of hanging, since there's no console to answer it.
        cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new(format!("/bin/{}", unix_shell()));
        cmd.process_group(0); // so Stop can kill everything it started
        cmd
    }
}

/// A command line as the shell should run it: output formatted to the
/// panel's width, then the marker, even when the command fails.
fn wrap(command: &str, cols: u16) -> String {
    let cols = cols.clamp(40, 500);
    #[cfg(windows)]
    {
        // PowerShell also ends single-quoted strings at typographic quotes.
        let mut quoted = String::with_capacity(command.len());
        for c in command.chars() {
            quoted.push(c);
            if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
                quoted.push(c);
            }
        }
        format!(
            "try {{ Invoke-Expression '{quoted}' | Out-String -Stream -Width {cols} | Out-Default }} \
             catch {{ [Console]::Error.Write(($_ | Out-String)) }} finally {{ {MARKER} }}\n\n"
        )
    }
    #[cfg(not(windows))]
    {
        format!("COLUMNS={cols}; export COLUMNS; eval '{}'; {MARKER}\n", command.replace('\'', r"'\''"))
    }
}

fn spawn(shared: &Arc<Shared>) -> AppResult<(Child, ChildStdin)> {
    let generation = shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let mut cwd = shared.cwd.lock().unwrap().clone();
    if !cwd.is_dir() {
        cwd = shared.root.clone();
    }
    let mut child = shell_command()
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Invalid(format!("Couldn't start {}: {e}", shell_name())))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let s = shared.clone();
    std::thread::spawn(move || read_output(s, generation, stdout, false));
    let s = shared.clone();
    std::thread::spawn(move || read_output(s, generation, stderr, true));
    stdin.write_all(format!("{SETUP}{MARKER}\n").as_bytes())?;
    stdin.flush()?;
    Ok((child, stdin))
}

fn read_output(shared: Arc<Shared>, generation: u64, mut from: impl Read, error: bool) {
    let current = || shared.generation.load(Ordering::SeqCst) == generation;
    let mut buf = [0u8; 8192];
    let mut pending = Vec::new();
    loop {
        let n = match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if !current() {
            return;
        }
        pending.extend_from_slice(&buf[..n]);
        let events = if error {
            let text = take_utf8(&mut pending);
            if text.is_empty() { Vec::new() } else { vec![TerminalEvent::Output { text, error }] }
        } else {
            take_events(&mut pending)
        };
        for event in events {
            if let TerminalEvent::Prompt { cwd } = &event {
                *shared.cwd.lock().unwrap() = PathBuf::from(cwd);
            }
            if shared.on_event.send(event).is_err() {
                return; // the page went away
            }
        }
    }
    if !error && current() {
        let _ = shared.on_event.send(TerminalEvent::Exit);
    }
}

/// Output and prompts from the front of stdout's `pending` bytes. Holds back
/// what might be the start of a marker, or of a character, until more arrives.
fn take_events(pending: &mut Vec<u8>) -> Vec<TerminalEvent> {
    fn output(events: &mut Vec<TerminalEvent>, text: String) {
        if !text.is_empty() {
            events.push(TerminalEvent::Output { text, error: false });
        }
    }
    let mut events = Vec::new();
    loop {
        match pending.windows(MARK.len()).position(|w| w == MARK) {
            Some(at) => {
                let Some(end) = pending[at..].iter().position(|&b| b == b'\n').map(|i| at + i) else {
                    let text = String::from_utf8_lossy(&pending[..at]).into_owned();
                    pending.drain(..at);
                    output(&mut events, text);
                    break;
                };
                let text = String::from_utf8_lossy(&pending[..at]).into_owned();
                let cwd = String::from_utf8_lossy(&pending[at + MARK.len()..end]).trim_end_matches('\r').to_string();
                pending.drain(..=end);
                output(&mut events, text);
                events.push(TerminalEvent::Prompt { cwd });
            }
            None => {
                let keep = (1..MARK.len().min(pending.len() + 1)).rev().find(|&k| pending.ends_with(&MARK[..k])).unwrap_or(0);
                let tail = pending.split_off(pending.len() - keep);
                let text = take_utf8(pending);
                pending.extend_from_slice(&tail);
                output(&mut events, text);
                break;
            }
        }
    }
    events
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

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        // The shell leads its own process group (`process_group(0)`).
        let _ = Command::new("kill").args(["-KILL", &format!("-{}", child.id())]).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The entries that complete `word` (already unquoted by the UI), taken
/// relative to `cwd`: the part up to the last separator picks the folder
/// (`~/` is the home folder), the rest is a case-insensitive prefix of the
/// name. Hidden entries only show when the prefix starts with a dot.
fn complete(cwd: &Path, word: &str) -> Vec<Completion> {
    let is_sep = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let split = word.rfind(is_sep).map_or(0, |i| i + 1);
    let (folder, base) = word.split_at(split);
    let dir = if folder.is_empty() {
        cwd.to_path_buf()
    } else if let (Some(rest), Some(home)) = (folder.strip_prefix("~").filter(|r| r.starts_with(is_sep)), home_dir()) {
        home.join(&rest[1..])
    } else {
        cwd.join(folder)
    };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let prefix = base.to_lowercase();
    let mut found: Vec<Completion> = entries
        .filter_map(|e| {
            let e = e.ok()?;
            let name = e.file_name().into_string().ok()?;
            if (name.starts_with('.') && !base.starts_with('.')) || !name.to_lowercase().starts_with(&prefix) {
                return None;
            }
            // `Path::is_dir` follows symlinks, so a linked folder completes as one.
            Some(Completion { dir: e.path().is_dir(), name })
        })
        .collect();
    found.sort_by_cached_key(|c| c.name.to_lowercase());
    found.truncate(MAX_COMPLETIONS);
    found
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn not_found() -> AppError {
    AppError::NotFound("That terminal was closed.".into())
}

/// Start a shell in a workspace folder. What it prints arrives on `on_event`,
/// starting with a prompt once it's ready.
#[tauri::command]
pub async fn terminal_open(
    state: State<'_, AppState>,
    workspace_id: String,
    on_event: Channel<TerminalEvent>,
) -> AppResult<TerminalInfo> {
    let store = state.store.clone();
    let workspace = blocking(move || {
        store.workspace(&workspace_id)?.ok_or_else(|| AppError::NotFound("That workspace no longer exists.".into()))
    })
    .await?;
    let root = PathBuf::from(&workspace.root);
    let shared = Arc::new(Shared { on_event, cwd: Mutex::new(root.clone()), root, generation: AtomicU64::new(0) });
    let (child, stdin) = spawn(&shared)?;
    let id = new_id();
    state.terminals.lock().unwrap().insert(id.clone(), Terminal { shared, stdin, child });
    Ok(TerminalInfo { id, shell: shell_name() })
}

/// Run a command line at the prompt; `cols` is the panel's width in characters.
#[tauri::command]
pub fn terminal_run(state: State<'_, AppState>, id: String, command: String, cols: u16) -> AppResult<()> {
    let mut terminals = state.terminals.lock().unwrap();
    let t = terminals.get_mut(&id).ok_or_else(not_found)?;
    t.stdin.write_all(wrap(&command, cols).as_bytes())?;
    t.stdin.flush()?;
    Ok(())
}

/// Input for the running command (it reads the shell's stdin).
#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, id: String, data: String) -> AppResult<()> {
    let mut terminals = state.terminals.lock().unwrap();
    let t = terminals.get_mut(&id).ok_or_else(not_found)?;
    t.stdin.write_all(data.as_bytes())?;
    t.stdin.flush()?;
    Ok(())
}

/// Stop whatever is running (Ctrl+C): a pipe can't carry the signal, so the
/// shell and everything it started is killed and a fresh one starts where it was.
#[tauri::command]
pub async fn terminal_interrupt(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut terminals = state.terminals.lock().unwrap();
    let t = terminals.get_mut(&id).ok_or_else(not_found)?;
    kill_tree(&mut t.child);
    let (child, stdin) = spawn(&t.shared)?;
    t.child = child;
    t.stdin = stdin;
    Ok(())
}

/// Files and folders completing `word` in the shell's current folder (Tab).
#[tauri::command]
pub async fn terminal_complete(state: State<'_, AppState>, id: String, word: String) -> AppResult<Vec<Completion>> {
    let cwd = state.terminals.lock().unwrap().get(&id).ok_or_else(not_found)?.shared.cwd.lock().unwrap().clone();
    blocking(move || Ok(complete(&cwd, &word))).await
}

#[tauri::command]
pub async fn terminal_close(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let removed = state.terminals.lock().unwrap().remove(&id);
    if let Some(mut t) = removed {
        kill_tree(&mut t.child);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(events: &[TerminalEvent]) -> Vec<String> {
        events
            .iter()
            .map(|e| match e {
                TerminalEvent::Output { text, .. } => format!("out:{text}"),
                TerminalEvent::Prompt { cwd } => format!("prompt:{cwd}"),
                TerminalEvent::Exit => "exit".into(),
            })
            .collect()
    }

    #[test]
    fn completes_names_in_the_folder_and_below_it() {
        let root = std::env::temp_dir().join(format!("sush-complete-{}", new_id()));
        std::fs::create_dir_all(root.join("Downloads/inner")).unwrap();
        std::fs::create_dir_all(root.join("Documents")).unwrap();
        std::fs::write(root.join("down.txt"), "").unwrap();
        std::fs::write(root.join(".hidden"), "").unwrap();
        let names = |word: &str| complete(&root, word).into_iter().map(|c| format!("{}{}", c.name, if c.dir { "/" } else { "" })).collect::<Vec<_>>();
        assert_eq!(names("Dow"), ["down.txt", "Downloads/"]);
        assert_eq!(names("do"), ["Documents/", "down.txt", "Downloads/"]);
        assert_eq!(names("Downloads/i"), ["inner/"]);
        assert_eq!(names("Downloads/inner/../../"), names(""));
        assert!(!names("").contains(&".hidden".to_string()));
        assert_eq!(names(".h"), [".hidden"]);
        assert!(names("nope").is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn split_characters_wait_for_the_rest() {
        let mut pending = "héllo".as_bytes()[..2].to_vec(); // "h" plus half of "é"
        assert_eq!(take_utf8(&mut pending), "h");
        assert_eq!(pending.len(), 1);
        pending.extend_from_slice(&"héllo".as_bytes()[2..]);
        assert_eq!(take_utf8(&mut pending), "éllo");
        assert!(pending.is_empty());
    }

    #[test]
    fn markers_become_prompts() {
        let mut pending = b"hello\r\n\x1fSUSH\x1fC:\\work\r\nmore".to_vec();
        assert_eq!(texts(&take_events(&mut pending)), ["out:hello\r\n", "prompt:C:\\work", "out:more"]);
        assert!(pending.is_empty());
    }

    #[test]
    fn a_split_marker_waits_for_the_rest() {
        let mut pending = b"out\x1fSU".to_vec();
        assert_eq!(texts(&take_events(&mut pending)), ["out:out"]);
        assert_eq!(pending, b"\x1fSU");
        pending.extend_from_slice(b"SH\x1f/home/me");
        assert!(take_events(&mut pending).is_empty());
        pending.extend_from_slice(b"\n");
        assert_eq!(texts(&take_events(&mut pending)), ["prompt:/home/me"]);
        assert!(pending.is_empty());
    }
}
