//! The user's PATH as their own terminal has it. An app opened from Finder or
//! a desktop launcher starts with only the system PATH, so tools installed in
//! the user's home (`~/.bun/bin`, Homebrew, nvm) aren't found by Cowork's
//! commands, the terminal panel or the sandbox. At startup we ask the user's
//! login shell for its PATH once and put its entries first.
//!
//! Started from a terminal, the app already has that environment and this is skipped.

use std::io::{IsTerminal, Read};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MARK: &str = "__SUSH_ENV__";
/// A slow shell config shouldn't hold up launch for long.
const TIMEOUT: Duration = Duration::from_secs(3);

/// Call before anything else runs, while the process has one thread.
pub fn init() {
    if std::io::stdin().is_terminal() {
        return;
    }
    let Some(login) = login_path() else { return };
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<_> = std::env::split_paths(&login).collect();
    for dir in std::env::split_paths(&current) {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    if let Ok(path) = std::env::join_paths(dirs) {
        std::env::set_var("PATH", path);
    }
}

fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" }.to_string()
    });
    // Interactive too: installers (bun, nvm) usually add to .zshrc / .bashrc.
    // `env` prints PATH colon-joined whatever the shell (fish included); the
    // marks keep it apart from anything the config prints.
    let mut child = Command::new(&shell)
        .args(["-i", "-l", "-c", &format!("echo {MARK}; /usr/bin/env; echo {MARK}")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Read as it comes, so a chatty config can't fill the pipe and stall the shell.
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        let _ = tx.send(out);
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    // Something the config started in the background may keep the pipe open after the shell exits.
    parse(&rx.recv_timeout(Duration::from_millis(500)).ok()?)
}

fn parse(out: &str) -> Option<String> {
    let start = out.find(MARK)? + MARK.len();
    let env = &out[start..start + out[start..].find(MARK)?];
    env.lines().find_map(|l| l.strip_prefix("PATH=")).map(str::to_owned).filter(|p| !p.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_path_between_the_marks() {
        let out = format!("welcome!\nPATH=/wrong\n{MARK}\nHOME=/u\nPATH=/u/.bun/bin:/usr/bin\n{MARK}\nbye\n");
        assert_eq!(parse(&out).as_deref(), Some("/u/.bun/bin:/usr/bin"));
        assert_eq!(parse("no marks"), None);
    }
}
