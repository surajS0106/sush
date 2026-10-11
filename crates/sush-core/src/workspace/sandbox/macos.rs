//! Seatbelt: `sandbox-exec -p <profile>`. Everything is allowed except
//! writing outside the allowed folders (or into the read-only ones) and,
//! unless asked for, the network. Later rules take precedence in a profile.

use std::path::Path;

use tokio::process::Command;

use super::Policy;

pub fn wrap(policy: &Policy, argv: &[String], cwd: &Path) -> Result<Command, String> {
    let mut cmd = Command::new("/usr/bin/sandbox-exec");
    cmd.arg("-p").arg(profile(policy)?).args(argv).current_dir(cwd);
    Ok(cmd)
}

fn profile(policy: &Policy) -> Result<String, String> {
    let mut p = String::from("(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write*\n");
    for dir in &policy.writable {
        p.push_str(&format!("  (subpath {})\n", quoted(dir)?));
    }
    p.push_str("  (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/dtracehelper\")\n");
    p.push_str("  (regex #\"^/dev/tty\") (regex #\"^/dev/fd/\"))\n");
    for dir in &policy.read_only {
        p.push_str(&format!("(deny file-write* (subpath {}))\n", quoted(dir)?));
    }
    if !policy.network {
        // Local Unix sockets (e.g. name resolution) stay usable; IP traffic doesn't.
        p.push_str("(deny network*)\n(allow network* (remote unix-socket))\n");
    }
    Ok(p)
}

/// A path as a profile string. Seatbelt matches resolved paths (`/private/var`,
/// not `/var`), so it's canonicalised first.
fn quoted(path: &Path) -> Result<String, String> {
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let s = real.to_str().ok_or_else(|| format!("{} isn't valid UTF-8", real.display()))?;
    Ok(format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
}
