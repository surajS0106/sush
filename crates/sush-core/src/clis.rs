//! Command-line tools on the user's machine, which the agent prefers over
//! connectors when both can do a task (as a developer at the keyboard would).
//!
//! - `login_path`: the PATH the user's own shell sets up. An app opened from
//!   the Finder or the dock gets a bare PATH, without Homebrew and friends,
//!   so the host merges this in at startup.
//! - `installed`: which well-known CLIs are on PATH, for the system prompt.
//! - `programs`: the programs a command line runs, for trusting a CLI
//!   ("Always allow `gh`"). It refuses anything it can't read with certainty.
//! - `chat_spec` / `chat_section`: the shell a plain chat gets, outside any
//!   workspace, where every command asks first.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::json;

use crate::message::ToolSpec;
use crate::workspace::shell;

/// A CLI worth telling the model about, and what it's for when that isn't obvious.
const KNOWN: &[(&str, &str)] = &[
    ("git", ""),
    ("gh", "GitHub: pull requests, issues, releases, Actions, the API"),
    ("glab", "GitLab: merge requests, issues, pipelines"),
    ("az", "Azure"),
    ("aws", "AWS"),
    ("gcloud", "Google Cloud"),
    ("firebase", "Firebase"),
    ("vercel", "Vercel deployments"),
    ("netlify", "Netlify deployments"),
    ("flyctl", "Fly.io"),
    ("heroku", "Heroku"),
    ("supabase", "Supabase"),
    ("stripe", "Stripe"),
    ("wrangler", "Cloudflare Workers"),
    ("kubectl", "Kubernetes"),
    ("docker", ""),
    ("terraform", ""),
    ("linear", "Linear issues"),
    ("jira", "Jira issues"),
    ("brew", "Homebrew packages"),
    ("node", ""),
    ("npm", ""),
    ("pnpm", ""),
    ("yarn", ""),
    ("bun", ""),
    ("deno", ""),
    ("python3", ""),
    ("uv", ""),
    ("cargo", ""),
    ("go", ""),
    ("rg", "ripgrep"),
    ("jq", ""),
    ("sqlite3", ""),
    ("psql", "PostgreSQL"),
    ("ffmpeg", ""),
    ("pandoc", ""),
    ("curl", ""),
];

/// Programs that can't be trusted wholesale, because any command line of
/// theirs can run arbitrary code: shells, interpreters, package scripts,
/// build tools and wrappers that run another program.
const NEVER_TRUSTED: &[&str] = &[
    "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "pwsh", "powershell", "cmd",
    "python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "lua", "osascript",
    "npm", "npx", "pnpm", "pnpx", "yarn", "uv", "uvx", "pip", "pip3", "pipx", "poetry",
    "make", "just", "cargo", "go", "gradle", "mvn",
    "env", "xargs", "sudo", "doas", "su", "exec", "eval", "source", "command", "builtin",
    "nohup", "time", "timeout", "nice", "watch", "find", "awk", "sed", "parallel",
    "ssh", "scp", "rsync", "curl", "wget", "nc",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cli {
    pub name: &'static str,
    /// What it's for, when the name doesn't say ("" otherwise).
    pub about: &'static str,
}

/// The well-known CLIs found on PATH.
pub fn installed() -> Vec<Cli> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    KNOWN
        .iter()
        .filter(|(name, _)| dirs.iter().any(|d| is_executable(d, name)))
        .map(|&(name, about)| Cli { name, about })
        .collect()
}

fn is_executable(dir: &Path, name: &str) -> bool {
    if cfg!(windows) {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into());
        return exts.split(';').filter(|e| !e.is_empty()).any(|e| dir.join(format!("{name}{e}")).is_file());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(dir.join(name)).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    false
}

/// Whether a program may go on a workspace's trusted list.
pub fn can_trust(program: &str) -> bool {
    is_plain_name(program) && !NEVER_TRUSTED.contains(&program.to_ascii_lowercase().as_str())
}

fn is_plain_name(word: &str) -> bool {
    !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-')) && !word.starts_with(['.', '-'])
}

/// The programs a command line runs, in order and without repeats, or None
/// when it can't be told for sure: command substitution, subshells, a
/// program given by path, quoted or expanded. Text in quotes may split into
/// extra "programs" here, which only ever makes a command ask when it needn't.
pub fn programs(command: &str) -> Option<Vec<String>> {
    if ["$(", "`", "<(", ">(", "@("].iter().any(|s| command.contains(s)) {
        return None;
    }
    // PowerShell runs a parenthesised expression anywhere on the line.
    if cfg!(windows) && command.contains('(') {
        return None;
    }
    let chars: Vec<char> = command.chars().collect();
    let mut segments = vec![String::new()];
    for (i, &c) in chars.iter().enumerate() {
        let redirect = c == '&' && (i > 0 && matches!(chars[i - 1], '>' | '<') || chars.get(i + 1) == Some(&'>'));
        if matches!(c, ';' | '|' | '\n' | '\r') || (c == '&' && !redirect) {
            segments.push(String::new());
        } else {
            segments.last_mut().unwrap().push(c);
        }
    }
    let mut out: Vec<String> = Vec::new();
    for segment in &segments {
        // Leading `NAME=value` words set the environment; the program follows them.
        let Some(program) = segment.split_whitespace().find(|w| !is_assignment(w)) else { continue };
        if !is_plain_name(program) {
            return None;
        }
        let program = program.to_string();
        if !out.contains(&program) {
            out.push(program);
        }
    }
    Some(out)
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(k, _)| {
        !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !k.starts_with(|c: char| c.is_ascii_digit())
    })
}

/// Whether every program `command` runs is on `trusted`.
pub fn is_trusted(command: &str, trusted: &[String]) -> bool {
    programs(command).is_some_and(|ps| !ps.is_empty() && ps.iter().all(|p| trusted.contains(p)))
}

/// What the system prompt says about the installed CLIs, if any are.
pub fn prompt(installed: &[Cli]) -> Option<String> {
    if installed.is_empty() {
        return None;
    }
    let list: Vec<String> = installed
        .iter()
        .map(|c| if c.about.is_empty() { c.name.to_string() } else { format!("{} ({})", c.name, c.about) })
        .collect();
    Some(format!(
        "These command-line tools are installed: {}. Prefer them, through shell_run, over connector tools when both \
         can do a task, the way a developer at this machine would (e.g. gh for GitHub). Use a connector when no CLI \
         covers the task or the CLI isn't signed in (e.g. `gh auth status` fails). Commands aren't interactive, so \
         pass flags instead of waiting for prompts (e.g. `gh pr create --title … --body …`).",
        list.join(", ")
    ))
}

/// The user's home folder, where a chat's commands start.
pub fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).filter(|p| p.is_dir())
}

/// `shell_run` for a plain chat: in the home folder, no sandbox, always asks.
pub fn chat_spec() -> ToolSpec {
    ToolSpec {
        name: crate::workspace::tools::SHELL_RUN.into(),
        description: format!(
            "Run a {} command on the user's computer, e.g. with an installed CLI like gh, brew or aws. It starts in \
             the home folder, runs with the user's permissions, and the user approves each command. Not interactive: \
             no prompts, no editors.",
            shell::shell_name()
        ),
        input_schema: json!({ "type": "object", "properties": {
            "command": { "type": "string" },
            "cwd": { "type": "string", "description": "Folder to run in: absolute, or relative to the home folder (default: the home folder)" },
            "timeout_secs": { "type": "integer", "description": "Default 120, at most 600" },
        }, "required": ["command"] }),
    }
}

/// The system prompt section for a plain chat's shell.
pub fn chat_section(installed: &[Cli]) -> String {
    let mut s = format!(
        "You can run {} commands on the user's computer with shell_run. Each one asks the user first and runs with \
         their permissions, outside any sandbox, so keep commands to what the task needs and say what you're about \
         to do. For work on a project's files, suggest a Cowork session on its folder instead.",
        shell::shell_name()
    );
    if let Some(clis) = prompt(installed) {
        s.push_str("\n\n");
        s.push_str(&clis);
    }
    s
}

/// Run a chat's command: in `cwd` (absolute, or relative to the home folder), unsandboxed.
pub async fn run_chat_command(
    input: &serde_json::Value,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<String, String> {
    let command = input.get("command").and_then(|v| v.as_str()).ok_or("`command` is required.")?;
    let home = home().ok_or("There's no home folder to run commands in.")?;
    let cwd = match input.get("cwd").and_then(|v| v.as_str()).map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => {
            let c = c.strip_prefix("~/").or(c.strip_prefix('~')).map_or_else(|| PathBuf::from(c), |rest| home.join(rest));
            if c.is_absolute() { c } else { home.join(c) }
        }
        None => home,
    };
    if !cwd.is_dir() {
        return Err(format!("{} isn't a folder.", cwd.display()));
    }
    let timeout = input
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .map(std::time::Duration::from_secs)
        .unwrap_or(shell::DEFAULT_TIMEOUT)
        .min(shell::MAX_TIMEOUT);
    shell::run(&cwd, command, timeout, cancel, None).await
}

/// The PATH the user's login shell sets up, or None when it can't be read
/// in a few seconds. Unix only; Windows apps get the full PATH already.
pub fn login_path() -> Option<OsString> {
    #[cfg(unix)]
    {
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        const MARK: &str = "__SUSH_PATH__";
        let shell = std::env::var_os("SHELL")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() });
        // Interactive too, since many people set PATH in .zshrc / .bashrc rather than a profile.
        let mut child = Command::new(shell)
            .args(["-ilc", &format!("printf '%s' \"{MARK}$PATH{MARK}\"")])
            .env("DISABLE_AUTO_UPDATE", "true")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
        let mut out = String::new();
        child.stdout.take()?.read_to_string(&mut out).ok()?;
        let path = out.split(MARK).nth(1)?.trim();
        path.contains('/').then(|| path.into())
    }
    #[cfg(not(unix))]
    None
}

/// `first`'s entries, then `rest`'s that aren't already there.
pub fn merge_paths(first: &OsString, rest: Option<&OsString>) -> OsString {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(first).collect();
    for d in rest.map(|r| std::env::split_paths(r).collect::<Vec<_>>()).unwrap_or_default() {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| first.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progs(c: &str) -> Option<Vec<String>> {
        programs(c)
    }

    fn v(names: &[&str]) -> Option<Vec<String>> {
        Some(names.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn programs_of_simple_command_lines() {
        assert_eq!(progs("gh pr list --state open"), v(&["gh"]));
        assert_eq!(progs("gh pr list | jq '.[0]' && gh pr view 3"), v(&["gh", "jq"]));
        assert_eq!(progs("GH_PAGER= NO_COLOR=1 gh issue list 2>&1"), v(&["gh"]));
        assert_eq!(progs("gh run list &> out.txt; git status"), v(&["gh", "git"]));
        assert_eq!(progs(""), v(&[]));
    }

    #[test]
    fn programs_refuses_what_it_cant_read() {
        for c in [
            "gh pr view $(cat x)",
            "gh pr view `id`",
            "./gh pr list",
            "/usr/bin/gh pr list",
            "\"gh\" pr list",
            "$TOOL pr list",
            "(rm -rf x)",
            "gh pr diff <(echo)",
        ] {
            assert_eq!(programs(c), None, "{c}");
        }
    }

    #[test]
    fn quoted_separators_only_make_commands_ask() {
        let trusted = vec!["gh".to_string()];
        assert!(is_trusted("gh pr list", &trusted));
        assert!(!is_trusted("gh issue create --title \"a; rm -rf x\"", &trusted));
        assert!(!is_trusted("gh pr list; rm -rf x", &trusted));
        assert!(!is_trusted("", &trusted));
    }

    #[test]
    fn runners_cant_be_trusted() {
        assert!(can_trust("gh"));
        assert!(can_trust("vercel"));
        for p in ["bash", "npx", "python3", "env", "sudo", "./gh", "a/b", "", "-x"] {
            assert!(!can_trust(p), "{p}");
        }
    }

    #[test]
    fn merged_paths_keep_order_without_repeats() {
        let merged = merge_paths(&OsString::from("/a:/b"), Some(&OsString::from("/b:/c")));
        if cfg!(unix) {
            assert_eq!(merged, OsString::from("/a:/b:/c"));
        }
    }
}
