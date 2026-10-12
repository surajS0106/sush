//! What git knows about a workspace folder (its branch, the other local
//! branches, whether it is a linked worktree), switching branches, and adding
//! a worktree for a session to work in apart from the user's checkout.
//!
//! Runs the user's `git`; a folder outside a repo, or no git installed, just
//! means no git features.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    /// The checked-out branch; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Local branches, the current one included.
    pub branches: Vec<String>,
    /// The folder is a linked worktree rather than the main checkout.
    pub worktree: bool,
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args).env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("Couldn't run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("git {} failed", args.first().unwrap_or(&"")) } else { err })
    }
}

/// The folder's git state, or `None` if it isn't in a repo (or git is missing).
pub fn info(root: &Path) -> Option<GitInfo> {
    let out = git(root, &["rev-parse", "--abbrev-ref", "HEAD", "--git-dir", "--git-common-dir"]).ok()?;
    let mut lines = out.lines();
    let head = lines.next()?.trim();
    let (git_dir, common_dir) = (lines.next()?.trim(), lines.next()?.trim());
    // A linked worktree has its own git dir inside the main repo's (common) one.
    let worktree = !same_dir(root, git_dir, common_dir);
    let branches = git(root, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .map(|o| o.lines().map(str::to_string).filter(|b| !b.is_empty()).collect())
        .unwrap_or_default();
    Some(GitInfo { branch: (head != "HEAD").then(|| head.to_string()), branches, worktree })
}

fn same_dir(root: &Path, a: &str, b: &str) -> bool {
    let canon = |p: &str| {
        let p = root.join(p);
        dunce::canonicalize(&p).unwrap_or(p)
    };
    canon(a) == canon(b)
}

/// A branch name we pass to git: an existing local branch, never an option.
fn check_branch(root: &Path, branch: &str) -> Result<(), String> {
    let known = info(root).ok_or("This folder isn't in a git repository.")?.branches;
    if branch.starts_with('-') || !known.iter().any(|b| b == branch) {
        return Err(format!("There's no local branch named {branch}."));
    }
    Ok(())
}

/// Check out another local branch. Git refuses if that would overwrite
/// uncommitted changes, and that error is returned as is.
pub fn switch(root: &Path, branch: &str) -> Result<(), String> {
    check_branch(root, branch)?;
    git(root, &["switch", branch]).map(|_| ())
}

/// Add a worktree at `dest` on a new branch `new_branch` starting from `base`.
pub fn add_worktree(root: &Path, base: &str, dest: &Path, new_branch: &str) -> Result<(), String> {
    check_branch(root, base)?;
    let dest = dest.to_str().ok_or("The worktree path isn't valid text.")?;
    git(root, &["worktree", "add", "-b", new_branch, dest, base]).map(|_| ())
}

/// The commit HEAD points at, if the folder is in a repo with one.
pub fn head(root: &Path) -> Option<String> {
    git(root, &["rev-parse", "HEAD"]).ok().filter(|h| !h.is_empty())
}

/// Changes as a unified diff: uncommitted ones (staged or not) against HEAD
/// when `base` is `None`, with untracked files listed after it; otherwise the
/// commits on HEAD since it left `base`. `path` limits it to a file or folder,
/// and `stat` gives the per-file summary instead of the diff.
///
/// The folder may not be trusted, so nothing its config names is run: no
/// external diff tools, text conversions or fsmonitor hooks.
pub fn diff(root: &Path, base: Option<&str>, path: Option<&str>, stat: bool) -> Result<String, String> {
    let range = match base {
        Some(b) => {
            check_branch(root, b)?;
            format!("{b}...HEAD")
        }
        None => "HEAD".into(),
    };
    let mut args = vec!["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    if stat {
        args.push("--stat");
    }
    args.extend([range.as_str(), "--"]);
    args.extend(path);
    let mut out = git(root, &args)?;
    if base.is_none() {
        let mut ls = vec!["-c", "core.fsmonitor=false", "ls-files", "--others", "--exclude-standard", "--"];
        ls.extend(path);
        let untracked = git(root, &ls).unwrap_or_default();
        if !untracked.is_empty() {
            out.push_str("\n\nNew files git doesn't track yet (not in the diff above; read them):\n");
            out.push_str(&untracked);
        }
    }
    Ok(if out.trim().is_empty() { "No changes.".into() } else { out })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn have_git() -> bool {
        Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "t"],
            &["config", "commit.gpgsign", "false"],
            &["commit", "-q", "--allow-empty", "-m", "init"],
            &["branch", "feature"],
        ] {
            git(root, args).unwrap();
        }
        dir
    }

    #[test]
    fn not_a_repo_has_no_info() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(info(dir.path()), None);
    }

    #[test]
    fn reads_branches_and_switches() {
        if !have_git() {
            return;
        }
        let dir = repo();
        let got = info(dir.path()).unwrap();
        assert_eq!((got.branch.as_deref(), got.worktree), (Some("main"), false));
        assert_eq!(got.branches, ["feature", "main"]);

        switch(dir.path(), "feature").unwrap();
        assert_eq!(info(dir.path()).unwrap().branch.as_deref(), Some("feature"));
        assert!(switch(dir.path(), "--orphan").is_err());
        assert!(switch(dir.path(), "nope").is_err());
    }

    #[test]
    fn adds_a_worktree_on_a_new_branch() {
        if !have_git() {
            return;
        }
        let dir = repo();
        let dest = tempfile::tempdir().unwrap();
        let dest = dest.path().join("wt");
        add_worktree(dir.path(), "main", &dest, "sush/abc").unwrap();
        let got = info(&dest).unwrap();
        assert_eq!((got.branch.as_deref(), got.worktree), (Some("sush/abc"), true));
    }

    #[test]
    fn diffs_uncommitted_changes_and_branches() {
        if !have_git() {
            return;
        }
        let dir = repo();
        let root = dir.path();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(root, &["add", "a.txt"]).unwrap();
        git(root, &["commit", "-q", "-m", "a"]).unwrap();
        assert!(head(root).is_some_and(|h| h.len() == 40));
        assert_eq!(diff(root, None, None, false).unwrap(), "No changes.");

        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        std::fs::write(root.join("new.txt"), "hi\n").unwrap();
        let out = diff(root, None, None, false).unwrap();
        assert!(out.contains("+two") && out.contains("new.txt"), "{out}");
        assert!(diff(root, None, Some("a.txt"), true).unwrap().contains("a.txt |"));

        // `feature` was branched before the commit; main's commit is what main adds since.
        assert!(diff(root, Some("feature"), None, false).unwrap().contains("+one"));
        assert!(diff(root, Some("--output=x"), None, false).is_err());
    }
}
