//! OS sandbox for Cowork shell commands.
//!
//! A sandboxed command can read the machine but write only in the workspace
//! folder and a private temp folder, never in `.git`, and (macOS, Linux)
//! can't use the network. Mechanisms:
//!
//!   macOS    Seatbelt (`sandbox-exec` with a generated profile)
//!   Linux    bubblewrap (`bwrap`): read-only bind of `/`, writable binds
//!            for the allowed folders, `--unshare-net`
//!   Windows  a write-restricted token whose restricting SID is granted
//!            write access on the allowed folders only, in a Job Object.
//!            Windows can't block the network without admin rights.
//!
//! Whether it works is checked, not assumed: on first use a probe command
//! must be able to write inside an allowed folder and be refused outside it
//! and inside `.git`. Until a probe passes, the sandbox counts as unavailable
//! and every command asks the user first.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
pub(crate) mod windows;

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

/// What a sandboxed command may do.
#[derive(Debug, Clone)]
pub struct Policy {
    /// Folders it may write in (canonical paths).
    pub writable: Vec<PathBuf>,
    /// Folders inside those that stay read-only (`.git`).
    pub read_only: Vec<PathBuf>,
    pub network: bool,
    /// Private temp folder; TEMP/TMP/TMPDIR point here.
    pub temp: PathBuf,
}

/// Whether commands can be sandboxed here, as the UI and the approval rule see it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    /// "Seatbelt", "bubblewrap" or "restricted token".
    pub mechanism: String,
    /// The probe passed: writes outside the allowed folders are refused.
    pub available: bool,
    /// Sandboxed commands can't reach the network.
    pub network_blocked: bool,
    /// Why it's unavailable, or what it doesn't cover.
    pub detail: String,
}

pub struct Sandbox {
    /// `sandbox/` in the app data folder: temp space and the probe.
    dir: PathBuf,
    status: OnceCell<SandboxStatus>,
}

impl Sandbox {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, status: OnceCell::new() }
    }

    /// The status, probing on first call.
    pub async fn status(&self) -> SandboxStatus {
        self.status.get_or_init(|| probe(&self.dir)).await.clone()
    }

    /// The status if the probe has run, without waiting for it.
    pub fn known_status(&self) -> Option<SandboxStatus> {
        self.status.get().cloned()
    }

    pub fn temp_dir(&self) -> PathBuf {
        self.dir.join("tmp")
    }

    /// The policy for a command in `root`.
    pub fn policy(&self, root: &Path, network: bool) -> Policy {
        let git = root.join(".git");
        let sush = root.join(".sush");
        Policy {
            writable: vec![root.to_path_buf(), self.temp_dir()],
            read_only: [git, sush].into_iter().filter(|p| p.exists()).collect(),
            network,
            temp: self.temp_dir(),
        }
    }

    /// Get a folder ready for sandboxed writes. On Windows this grants the
    /// sandbox's SID write access (once per folder; it takes a while on big
    /// trees); elsewhere it's a no-op.
    pub async fn prepare(&self, root: &Path) -> Result<(), String> {
        #[cfg(windows)]
        {
            let (root, temp) = (root.to_path_buf(), self.temp_dir());
            return tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
                windows::grant(&temp)?;
                windows::grant(&root)
            })
            .await
            .map_err(|e| e.to_string())?;
        }
        #[cfg(not(windows))]
        {
            let _ = root;
            std::fs::create_dir_all(self.temp_dir()).map_err(|e| e.to_string())
        }
    }

    /// Undo `prepare` when a folder stops being a workspace.
    pub async fn release(&self, root: &Path) {
        #[cfg(windows)]
        {
            let root = root.to_path_buf();
            let _ = tokio::task::spawn_blocking(move || windows::revoke(&root)).await;
        }
        #[cfg(not(windows))]
        let _ = root;
    }
}

pub fn mechanism() -> &'static str {
    if cfg!(target_os = "macos") {
        "Seatbelt"
    } else if cfg!(windows) {
        "restricted token"
    } else {
        "bubblewrap"
    }
}

/// Whether the mechanism blocks the network for sandboxed commands.
pub fn blocks_network() -> bool {
    !cfg!(windows)
}

/// Wrap `argv` so it runs inside the sandbox (macOS and Linux).
#[cfg(not(windows))]
pub fn wrap(policy: &Policy, argv: &[String], cwd: &Path) -> Result<tokio::process::Command, String> {
    #[cfg(target_os = "macos")]
    return macos::wrap(policy, argv, cwd);
    #[cfg(target_os = "linux")]
    return linux::wrap(policy, argv, cwd);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (policy, argv, cwd);
        Err("Sandboxing isn't supported on this operating system.".into())
    }
}

/// Run the probe: a sandboxed command must write inside, and be refused
/// outside and in `.git`.
async fn probe(dir: &Path) -> SandboxStatus {
    let status = |available: bool, detail: String| SandboxStatus {
        mechanism: mechanism().into(),
        available,
        network_blocked: available && blocks_network(),
        detail,
    };
    match run_probe(dir).await {
        Ok(()) => status(
            true,
            if blocks_network() {
                "Commands can change files only in the workspace folder and have no network.".into()
            } else {
                "Commands can change files only in the workspace folder. Windows can't block their network access without admin rights, so commands still ask first.".into()
            },
        ),
        Err(e) => status(false, format!("The sandbox isn't working here, so every command asks first: {e}")),
    }
}

async fn run_probe(dir: &Path) -> Result<(), String> {
    let base = dir.join("probe");
    let _ = std::fs::remove_dir_all(&base);
    let inside = base.join("inside");
    let outside = base.join("outside");
    for d in [inside.join(".git"), outside.clone(), dir.join("tmp")] {
        std::fs::create_dir_all(&d).map_err(|e| format!("can't create {}: {e}", d.display()))?;
    }
    let inside = dunce::canonicalize(&inside).map_err(|e| e.to_string())?;
    let outside = dunce::canonicalize(&outside).map_err(|e| e.to_string())?;
    let sandbox = Sandbox::new(dir.to_path_buf());
    sandbox.prepare(&inside).await?;
    let policy = sandbox.policy(&inside, false);

    let (ok, escaped, git) = (inside.join("in.txt"), outside.join("out.txt"), inside.join(".git").join("hook"));
    let command = probe_command(&ok, &escaped, &git);
    let output = super::shell::run(&inside, &command, Duration::from_secs(60), CancellationToken::new(), Some(&policy)).await?;
    if !ok.exists() {
        return Err(format!("a sandboxed command couldn't write in its own folder ({})", output.trim()));
    }
    if escaped.exists() {
        return Err("a sandboxed command could write outside its folder".into());
    }
    if git.exists() {
        return Err("a sandboxed command could write in .git".into());
    }
    let _ = std::fs::remove_dir_all(&base);
    Ok(())
}

#[cfg(windows)]
fn probe_command(ok: &Path, escaped: &Path, git: &Path) -> String {
    let q = |p: &Path| format!("'{}'", p.display().to_string().replace('\'', "''"));
    format!(
        "Set-Content -LiteralPath {} -Value x; \
         try {{ Set-Content -LiteralPath {} -Value x -ErrorAction Stop }} catch {{}}; \
         try {{ Set-Content -LiteralPath {} -Value x -ErrorAction Stop }} catch {{}}",
        q(ok),
        q(escaped),
        q(git)
    )
}

#[cfg(not(windows))]
fn probe_command(ok: &Path, escaped: &Path, git: &Path) -> String {
    let q = |p: &Path| format!("'{}'", p.display().to_string().replace('\'', "'\\''"));
    format!("printf x > {}; printf x > {} 2>/dev/null; printf x > {} 2>/dev/null; true", q(ok), q(escaped), q(git))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the real probe, so it needs the platform's sandbox (bwrap on Linux).
    #[tokio::test]
    #[ignore = "needs the OS sandbox; run with --ignored"]
    async fn the_probe_passes_on_this_machine() {
        let dir = tempfile::tempdir().unwrap();
        let status = Sandbox::new(dir.path().to_path_buf()).status().await;
        assert!(status.available, "{}", status.detail);
    }

    #[test]
    fn policies_keep_git_read_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let sandbox = Sandbox::new(dir.path().join("sandbox"));
        let policy = sandbox.policy(dir.path(), false);
        assert_eq!(policy.read_only, [dir.path().join(".git")]);
        assert!(policy.writable.contains(&dir.path().to_path_buf()));
        assert!(!policy.network);
    }
}
