//! Shell commands in a workspace. By default they run in the OS sandbox
//! (`sandbox`), which confines writes to the workspace and (macOS, Linux)
//! blocks the network; when the sandbox isn't available, or the model asks to
//! go without it, the command needs the user's approval (see
//! `tools::approval`). Either way: the working directory is inside the
//! workspace, credentials Sush knows about aren't in the environment, output
//! is capped, and Stop or the timeout kills the whole process tree.

use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::sandbox::Policy;
use crate::agent::ui::STOPPED;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
pub const MAX_TIMEOUT: Duration = Duration::from_secs(600);
/// Output kept per stream; beyond it only the end is kept.
const MAX_OUTPUT: usize = 30_000;

/// Run `command` with `cwd` (already checked to be inside the workspace),
/// inside the sandbox when `sandbox` is given.
pub async fn run(
    cwd: &Path,
    command: &str,
    timeout: Duration,
    cancel: CancellationToken,
    sandbox: Option<&Policy>,
) -> Result<String, String> {
    #[cfg(windows)]
    if let Some(policy) = sandbox {
        return super::sandbox::windows::run(cwd, command, timeout, cancel, policy).await;
    }

    let mut cmd = command_for(command, cwd, sandbox)?;
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    cmd.env_clear().envs(scrubbed_env());
    if let Some(policy) = sandbox {
        for var in ["TMPDIR", "TEMP", "TMP"] {
            cmd.env(var, &policy.temp);
        }
    }
    #[cfg(unix)]
    cmd.process_group(0); // so the whole tree can be killed at once
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the shell: {e}"))?;
    let pid = child.id();
    let stdout = tokio::spawn(read_capped(child.stdout.take()));
    let stderr = tokio::spawn(read_capped(child.stderr.take()));

    let ending = tokio::select! {
        biased;
        _ = cancel.cancelled() => Ending::Stopped,
        _ = tokio::time::sleep(timeout) => Ending::TimedOut,
        status = child.wait() => Ending::Exited(status.map_err(|e| e.to_string())?.code()),
    };
    if !matches!(ending, Ending::Exited(_)) {
        if let Some(pid) = pid {
            kill_tree(pid);
        }
        let _ = child.kill().await;
    }
    // A background process can keep the pipes open after the shell exits; don't wait on it forever.
    let collect = |h: tokio::task::JoinHandle<String>| async move {
        tokio::time::timeout(Duration::from_secs(2), h).await.ok().and_then(Result::ok).unwrap_or_default()
    };
    report(ending, timeout, collect(stdout).await, collect(stderr).await)
}

pub(crate) enum Ending {
    Stopped,
    TimedOut,
    Exited(Option<i32>),
}

/// What the model sees: how the command ended, then its output.
pub(crate) fn report(ending: Ending, timeout: Duration, stdout: String, stderr: String) -> Result<String, String> {
    let mut out = match ending {
        Ending::Stopped => return Err(STOPPED.into()),
        Ending::TimedOut => format!("Timed out after {} s; the command was stopped.", timeout.as_secs()),
        Ending::Exited(Some(code)) => format!("Exit code: {code}"),
        Ending::Exited(None) => "The command was killed by a signal.".into(),
    };
    for (name, text) in [("stdout", stdout), ("stderr", stderr)] {
        if !text.trim().is_empty() {
            out.push_str(&format!("\n<{name}>\n{}\n</{name}>", text.trim_end()));
        }
    }
    Ok(out)
}

/// Sush's environment without variables that commonly carry credentials.
pub(crate) fn scrubbed_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os().filter(|(k, _)| !k.to_str().is_some_and(is_secret_var)).collect()
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn command_for(command: &str, _cwd: &Path, _sandbox: Option<&Policy>) -> Result<Command, String> {
    // Sandboxed commands took the `sandbox::windows` path above.
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]);
    Ok(cmd)
}

#[cfg(not(windows))]
fn command_for(command: &str, cwd: &Path, sandbox: Option<&Policy>) -> Result<Command, String> {
    let argv = ["/bin/sh".to_string(), "-c".to_string(), command.to_string()];
    match sandbox {
        Some(policy) => super::sandbox::wrap(policy, &argv, cwd),
        None => {
            let mut cmd = Command::new(&argv[0]);
            cmd.args(&argv[1..]);
            Ok(cmd)
        }
    }
}

/// The shell the model should write commands for.
pub fn shell_name() -> &'static str {
    if cfg!(windows) {
        "PowerShell"
    } else {
        "sh"
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    // The child leads its own process group (`process_group(0)`).
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

/// Environment variables that commonly carry credentials.
/// Whether an environment variable's name says it holds a credential.
pub fn is_secret_var(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    k.starts_with("SUSH_")
        || k.starts_with("BETTER_AUTH")
        || ["API_KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PRIVATE_KEY", "ACCESS_KEY"]
            .iter()
            .any(|s| k.ends_with(s) || k.contains(&format!("{s}_")))
}

/// Read a stream to the end, keeping only the last `MAX_OUTPUT` bytes.
pub(crate) async fn read_capped(stream: Option<impl AsyncRead + Unpin>) -> String {
    let Some(mut stream) = stream else { return String::new() };
    let mut kept = Vec::new();
    let mut dropped = false;
    let mut buf = [0u8; 8192];
    while let Ok(n) = stream.read(&mut buf).await {
        if n == 0 {
            break;
        }
        kept.extend_from_slice(&buf[..n]);
        if kept.len() > 2 * MAX_OUTPUT {
            kept.drain(..kept.len() - MAX_OUTPUT);
            dropped = true;
        }
    }
    if kept.len() > MAX_OUTPUT {
        kept.drain(..kept.len() - MAX_OUTPUT);
        dropped = true;
    }
    let text = String::from_utf8_lossy(&kept).into_owned();
    if dropped {
        format!("[earlier output cut]\n{text}")
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_variables_are_recognised() {
        for k in ["OPENAI_API_KEY", "GITHUB_TOKEN", "SUSH_API_KEY", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "BETTER_AUTH_SECRET"] {
            assert!(is_secret_var(k), "{k}");
        }
        for k in ["PATH", "HOME", "USERPROFILE", "TEMP", "LANG"] {
            assert!(!is_secret_var(k), "{k}");
        }
    }

    #[tokio::test]
    async fn runs_in_the_folder_and_reports_the_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "here").unwrap();
        let list = if cfg!(windows) { "Get-ChildItem -Name; exit 3" } else { "ls; exit 3" };
        let out = run(dir.path(), list, DEFAULT_TIMEOUT, CancellationToken::new(), None).await.unwrap();
        assert!(out.starts_with("Exit code: 3"), "{out}");
        assert!(out.contains("marker.txt"), "{out}");
    }

    #[tokio::test]
    async fn timeouts_and_stops_end_the_command() {
        let dir = tempfile::tempdir().unwrap();
        let sleep = if cfg!(windows) { "Start-Sleep -Seconds 30" } else { "sleep 30" };
        let out = run(dir.path(), sleep, Duration::from_millis(500), CancellationToken::new(), None).await.unwrap();
        assert!(out.starts_with("Timed out"), "{out}");

        let cancel = CancellationToken::new();
        let stopper = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            stopper.cancel();
        });
        assert_eq!(run(dir.path(), sleep, DEFAULT_TIMEOUT, cancel, None).await.unwrap_err(), STOPPED);
    }
}
