//! bubblewrap: the whole filesystem bound read-only, the allowed folders bound
//! writable over it, the read-only ones bound read-only again on top, a
//! private `/tmp`, and no network namespace access unless asked for.

use std::path::Path;

use tokio::process::Command;

use super::Policy;

pub fn wrap(policy: &Policy, argv: &[String], cwd: &Path) -> Result<Command, String> {
    let bwrap = find_bwrap().ok_or("bubblewrap (bwrap) isn't installed. Install it to sandbox commands.")?;
    let mut cmd = Command::new(bwrap);
    cmd.args(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]);
    for dir in &policy.writable {
        cmd.arg("--bind").arg(dir).arg(dir);
    }
    for dir in &policy.read_only {
        cmd.arg("--ro-bind").arg(dir).arg(dir);
    }
    if !policy.network {
        cmd.arg("--unshare-net");
    }
    cmd.args(["--unshare-pid", "--die-with-parent", "--new-session"]);
    cmd.arg("--chdir").arg(cwd).arg("--").args(argv);
    Ok(cmd)
}

fn find_bwrap() -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join("bwrap")).find(|p| p.is_file())
}
