//! Yammer, Sush's dictation app, as the composer's default way to dictate.
//!
//! Yammer pastes its transcript wherever the cursor is, so Sush only has to
//! start and stop it: `yammer --toggle` from a second launch reaches the
//! running instance (its single-instance plugin) and toggles dictation there,
//! and the text lands in the composer, which keeps focus. A cold start with
//! `--toggle` doesn't dictate (it opens Yammer's window), so when Yammer isn't
//! running it's started first with `--hidden` (stays in the tray once set up)
//! and toggled once it's had a moment to come up.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Yammer's Tauri identifier, which names its config dir.
const IDENTIFIER: &str = "com.sush.yammer";
/// How long a cold start may take before the process shows up.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
/// Time after the process appears for Yammer's setup to run, so the toggle
/// isn't forwarded before its dictation task exists.
const READY_GRACE: Duration = Duration::from_millis(2000);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YammerStatus {
    installed: bool,
    running: bool,
    /// Yammer's first-run setup (speech engine, permissions) is done.
    onboarded: bool,
    /// Yammer's own global hotkey, in Tauri's accelerator syntax.
    hotkey: Option<String>,
}

/// Where the installers put the app.
fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        // NSIS installs per user under LocalAppData, the MSI under Program Files.
        for var in ["LOCALAPPDATA", "ProgramFiles", "ProgramW6432"] {
            if let Some(dir) = std::env::var_os(var) {
                let dir = PathBuf::from(dir);
                out.push(dir.join("Yammer").join("yammer.exe"));
                out.push(dir.join("Programs").join("Yammer").join("yammer.exe"));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        out.push(PathBuf::from("/Applications/Yammer.app/Contents/MacOS/yammer"));
        if let Some(home) = std::env::var_os("HOME") {
            out.push(PathBuf::from(home).join("Applications/Yammer.app/Contents/MacOS/yammer"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // The .deb puts `yammer` on PATH; an AppImage lives wherever it was saved.
        if let Some(path) = std::env::var_os("PATH") {
            out.extend(std::env::split_paths(&path).map(|d| d.join("yammer")));
        }
        out.push(PathBuf::from("/usr/bin/yammer"));
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            for dir in [home.join("Applications"), home.join(".local/bin"), home.join("Downloads"), home.clone()] {
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    if name.starts_with("yammer") && name.ends_with(".appimage") {
                        out.push(e.path());
                    }
                }
            }
        }
    }
    out
}

fn binary() -> Option<PathBuf> {
    candidates().into_iter().find(|p| p.is_file())
}

fn quiet(cmd: &mut Command) -> &mut Command {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn running() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq yammer.exe", "/NH", "/FO", "CSV"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("\"yammer.exe\""))
    }
    #[cfg(unix)]
    {
        Command::new("pgrep").args(["-x", "yammer"]).stdout(Stdio::null()).status().is_ok_and(|s| s.success())
    }
}

/// Yammer's `settings.json`, if it has one yet.
fn settings() -> Option<serde_json::Value> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
    let raw = std::fs::read(base?.join(IDENTIFIER).join("settings.json")).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn status() -> YammerStatus {
    let settings = settings();
    YammerStatus {
        installed: binary().is_some(),
        running: running(),
        onboarded: settings.as_ref().and_then(|s| s["onboarded"].as_bool()).unwrap_or(false),
        hotkey: settings.as_ref().and_then(|s| s["hotkey"].as_str()).filter(|h| !h.is_empty()).map(str::to_owned),
    }
}

/// Reap the child in the background so it never lingers as a zombie.
fn reap(child: Child) {
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
}

/// Start Yammer as an app of its own, not tied to Sush's process.
fn launch(bin: &Path, hidden: bool) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        // Through Launch Services, so macOS credits the microphone and
        // Accessibility permissions to Yammer rather than to Sush.
        let app = bin.ancestors().nth(3).ok_or_else(|| AppError::NotFound("Yammer.app".into()))?;
        let mut cmd = Command::new("open");
        if hidden {
            cmd.arg("-g");
        }
        cmd.arg("-a").arg(app);
        if hidden {
            cmd.args(["--args", "--hidden"]);
        }
        reap(quiet(&mut cmd).spawn()?);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut cmd = Command::new(bin);
        if hidden {
            cmd.arg("--hidden");
        }
        quiet(&mut cmd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        reap(cmd.spawn()?);
    }
    Ok(())
}

/// Start Yammer if it isn't running and wait until it can take a toggle.
/// Returns whether it had to be started.
fn ensure_running(bin: &Path) -> AppResult<bool> {
    if running() {
        return Ok(false);
    }
    launch(bin, true)?;
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    while !running() {
        if Instant::now() > deadline {
            return Err(AppError::Invalid("Yammer didn't start. Open it yourself, then try again.".into()));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    std::thread::sleep(READY_GRACE);
    Ok(true)
}

fn not_installed() -> AppError {
    AppError::NotFound("Yammer isn't installed.".into())
}

#[tauri::command]
pub async fn yammer_status() -> AppResult<YammerStatus> {
    tauri::async_runtime::spawn_blocking(status).await.map_err(|e| AppError::Invalid(e.to_string()))
}

/// Start or finish a Yammer dictation. Returns whether Yammer had to be started first.
#[tauri::command]
pub async fn yammer_toggle() -> AppResult<bool> {
    tauri::async_runtime::spawn_blocking(|| {
        let bin = binary().ok_or_else(not_installed)?;
        let started = ensure_running(&bin)?;
        reap(quiet(Command::new(&bin).arg("--toggle")).spawn()?);
        Ok(started)
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?
}

/// Show Yammer's window, for its setup and settings.
#[tauri::command]
pub async fn yammer_open() -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(|| {
        let bin = binary().ok_or_else(not_installed)?;
        // A second launch with no arguments shows the running instance's window.
        if !cfg!(target_os = "macos") && running() {
            reap(quiet(&mut Command::new(&bin)).spawn()?);
            return Ok(());
        }
        launch(&bin, false)
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?
}
