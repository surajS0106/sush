//! What git knows about a workspace folder (its branch, the other local
//! branches, whether it is a linked worktree), switching branches, and adding
//! a worktree for a session to work in apart from the user's checkout.
//!
//! Runs the user's `git`; a folder outside a repo, or no git installed, just
//! means no git features.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

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

/// What a git command printed, whatever its exit code.
struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}

fn run(root: &Path, args: &[&str]) -> Result<Output, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args).env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("Couldn't run git: {e}"))?;
    Ok(Output {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).trim_end().to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = run(root, args)?;
    if out.code == 0 {
        Ok(out.stdout)
    } else if out.stderr.is_empty() {
        Err(format!("git {} failed", args.first().unwrap_or(&"")))
    } else {
        Err(out.stderr)
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

// --- branches as pull requests ---------------------------------------------------

/// Local and remote-tracking branches, as `main` and `origin/main`.
fn refs(root: &Path) -> Vec<String> {
    git(root, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
        .map(|o| o.lines().filter(|r| !r.is_empty() && !r.ends_with("/HEAD")).map(str::to_string).collect())
        .unwrap_or_default()
}

/// A branch we compare with or merge: a local or remote-tracking one, never an option.
fn check_ref(root: &Path, name: &str) -> Result<(), String> {
    if name.starts_with('-') || !refs(root).iter().any(|r| r == name) {
        return Err(format!("There's no branch named {name}."));
    }
    Ok(())
}

/// The branch this one most likely merges into: the remote's default branch,
/// else `main` or `master`, if it exists locally and isn't `current`.
pub fn default_base(root: &Path, current: Option<&str>) -> Option<String> {
    let branches = info(root)?.branches;
    let remote = git(root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        .ok()
        .and_then(|r| r.strip_prefix("origin/").map(str::to_string));
    remote
        .into_iter()
        .chain(["main", "master", "trunk", "develop"].map(String::from))
        .find(|b| branches.contains(b) && Some(b.as_str()) != current)
}

/// Options for commands that commit or merge: none of the folder's hooks run
/// (its hooks path may point into the workspace, which the model can write;
/// this one is inside the git dir, which it can't), and no fsmonitor.
fn without_hooks(root: &Path) -> Result<Vec<String>, String> {
    let git_dir = git(root, &["rev-parse", "--absolute-git-dir"])?;
    let none = Path::new(&git_dir).join("sush-no-hooks");
    Ok(vec!["-c".into(), format!("core.hooksPath={}", none.display()), "-c".into(), "core.fsmonitor=false".into()])
}

fn git_with(root: &Path, opts: &[String], args: &[&str]) -> Result<Output, String> {
    let all: Vec<&str> = opts.iter().map(String::as_str).chain(args.iter().copied()).collect();
    run(root, &all)
}

/// A branch measured against the branch it will merge into, for the pull
/// request card and the model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    pub branch: Option<String>,
    pub base: String,
    /// The commit HEAD points at.
    pub head: String,
    /// The user's git name, so their commits can read "You".
    pub you: Option<String>,
    /// Commits on this branch that the base lacks, and the reverse.
    pub ahead: usize,
    pub behind: usize,
    /// Everything the branch changes since it left the base, uncommitted work included.
    pub files: usize,
    pub additions: usize,
    pub deletions: usize,
    /// Files with uncommitted changes (untracked ones included).
    pub uncommitted: usize,
    /// A merge in progress, with the files whose conflicts are still unresolved.
    pub merging: Option<Merging>,
    /// What merging the base in would conflict on; `None` when that can't be
    /// told (a merge is in progress, or git is older than 2.38).
    pub conflicts: Option<Vec<Conflict>>,
    /// Both sides' commits since they split, newest first, then the commit they split from.
    pub commits: Vec<GraphCommit>,
    /// There are older commits than `commits` shows.
    pub more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merging {
    pub unresolved: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub path: String,
    /// Who last changed the file on the base.
    pub by: Option<String>,
    pub hunks: Vec<ConflictHunk>,
}

/// Where the two sides changed the same lines: a few lines of each.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictHunk {
    /// The first line, as numbered in this branch's version of the file.
    pub line: usize,
    pub ours: Vec<String>,
    pub theirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    /// Commit time, in seconds since the epoch.
    pub time: i64,
    /// Local branches pointing at it.
    pub refs: Vec<String>,
    pub subject: String,
    /// The base has it.
    pub on_base: bool,
}

const GRAPH_LIMIT: usize = 40;
const HUNKS_PER_FILE: usize = 4;
const HUNK_LINES: usize = 3;
const UNMERGED: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

/// The current branch against `base`.
pub fn branch_status(root: &Path, base: &str) -> Result<BranchStatus, String> {
    check_ref(root, base)?;
    let branch = info(root).and_then(|i| i.branch);
    if branch.as_deref() == Some(base) {
        return Err(format!("This folder is on {base} itself; switch to the branch you want to compare with it."));
    }
    let head = git(root, &["rev-parse", "HEAD"])?;
    let base_sha = git(root, &["rev-parse", "--verify", &format!("{base}^{{commit}}")])?;
    let split = git(root, &["merge-base", "HEAD", &base_sha]).map_err(|_| format!("This branch shares no history with {base}."))?;

    let counts = git(root, &["rev-list", "--left-right", "--count", &format!("HEAD...{base_sha}")])?;
    let mut counts = counts.split_whitespace().map(|n| n.parse().unwrap_or(0));
    let (ahead, behind) = (counts.next().unwrap_or(0), counts.next().unwrap_or(0));

    // Both sides since they split, and the commit they split from (so not its parents).
    let stops: Vec<String> = git(root, &["rev-parse", &format!("{split}^@")])
        .map(|o| o.lines().map(|p| format!("^{p}")).collect())
        .unwrap_or_default();
    let n = (GRAPH_LIMIT + 1).to_string();
    let mut log = vec!["log", "--topo-order", "--decorate-refs=refs/heads", "-n", n.as_str(), "--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s", "HEAD", base_sha.as_str()];
    log.extend(stops.iter().map(String::as_str));
    log.push("--");
    let mut list = vec!["rev-list", "-n", "5000", base_sha.as_str()];
    list.extend(stops.iter().map(String::as_str));
    let on_base: std::collections::HashSet<String> = git(root, &list)?.lines().map(str::to_string).collect();
    let mut commits: Vec<GraphCommit> = git(root, &log)?
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(6, '\x1f').collect();
            let &[sha, parents, author, time, refs, subject] = f.as_slice() else { return None };
            Some(GraphCommit {
                sha: sha.into(),
                parents: parents.split_whitespace().map(str::to_string).collect(),
                author: author.into(),
                time: time.parse().unwrap_or(0),
                refs: refs
                    .split(", ")
                    .map(|r| r.trim_start_matches("HEAD -> "))
                    .filter(|r| !r.is_empty() && *r != "HEAD")
                    .map(str::to_string)
                    .collect(),
                subject: subject.into(),
                on_base: on_base.contains(sha),
            })
        })
        .collect();
    let more = commits.len() > GRAPH_LIMIT;
    commits.truncate(GRAPH_LIMIT);

    let stat = git(root, &["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--shortstat", &split]).unwrap_or_default();
    let (files, additions, deletions) = shortstat(&stat);
    let (uncommitted, unresolved) = status(root)?;
    let merging = run(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])?.code == 0;
    let conflicts = if merging {
        None
    } else if behind == 0 {
        Some(Vec::new())
    } else {
        conflicts(root, &base_sha, &split)
    };

    Ok(BranchStatus {
        branch,
        base: base.into(),
        head,
        you: git(root, &["config", "user.name"]).ok().filter(|n| !n.is_empty()),
        ahead,
        behind,
        files,
        additions,
        deletions,
        uncommitted,
        merging: merging.then_some(Merging { unresolved }),
        conflicts,
        commits,
        more,
    })
}

/// "3 files changed, 10 insertions(+), 2 deletions(-)" as numbers.
fn shortstat(text: &str) -> (usize, usize, usize) {
    let (mut files, mut add, mut del) = (0, 0, 0);
    for part in text.split(',') {
        let mut words = part.split_whitespace();
        let n = words.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        match words.next() {
            Some(w) if w.starts_with("file") => files = n,
            Some(w) if w.starts_with("insertion") => add = n,
            Some(w) if w.starts_with("deletion") => del = n,
            _ => {}
        }
    }
    (files, add, del)
}

/// How many files have uncommitted changes, and which are unmerged, as paths
/// relative to the workspace folder.
fn status(root: &Path) -> Result<(usize, Vec<String>), String> {
    let prefix = prefix_of(root);
    let out = git(root, &["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z"])?;
    let (mut count, mut unmerged) = (0, Vec::new());
    let mut entries = out.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let (xy, path) = (&entry[..2], &entry[3..]);
        count += 1;
        if UNMERGED.contains(&xy) {
            unmerged.push(path.strip_prefix(prefix.as_str()).unwrap_or(path).to_string());
        }
        // A rename or copy is followed by the path it came from.
        if xy.contains('R') || xy.contains('C') {
            entries.next();
        }
    }
    Ok((count, unmerged))
}

/// The branch, HEAD and uncommitted count from one `git status`.
struct BranchState {
    /// `None` when HEAD is detached.
    branch: Option<String>,
    /// `None` before the first commit.
    head: Option<String>,
    /// What the branch tracks (`origin/main`), if anything.
    upstream: Option<String>,
    uncommitted: usize,
}

fn branch_status_v2(root: &Path) -> Result<BranchState, String> {
    let out = run(root, &["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z"])?;
    if out.code != 0 {
        return Err(if out.stderr.contains("not a git repository") || out.stderr.is_empty() {
            "This folder isn't in a git repository.".into()
        } else {
            out.stderr
        });
    }
    let mut state = BranchState { branch: None, head: None, upstream: None, uncommitted: 0 };
    let mut entries = out.stdout.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if let Some(header) = entry.strip_prefix("# ") {
            match header.split_once(' ') {
                Some(("branch.oid", oid)) if oid != "(initial)" => state.head = Some(oid.into()),
                Some(("branch.head", name)) if name != "(detached)" => state.branch = Some(name.into()),
                Some(("branch.upstream", up)) if !up.starts_with('-') => state.upstream = Some(up.into()),
                _ => {}
            }
            continue;
        }
        state.uncommitted += 1;
        // A rename or copy (`2 …`) is followed by the path it came from.
        if entry.starts_with("2 ") {
            entries.next();
        }
    }
    Ok(state)
}

/// What merging `base` into HEAD would conflict on, worked out without
/// touching the folder (`git merge-tree`, git 2.38+).
fn conflicts(root: &Path, base_sha: &str, split: &str) -> Option<Vec<Conflict>> {
    let out = run(
        root,
        &["-c", "core.quotePath=false", "-c", "merge.conflictStyle=merge", "merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", base_sha],
    )
    .ok()?;
    match out.code {
        0 => return Some(Vec::new()),
        1 => {}
        _ => return None,
    }
    let mut lines = out.stdout.lines();
    let tree = lines.next()?.trim().to_string();
    let mut paths: Vec<&str> = lines.take_while(|l| !l.is_empty()).collect();
    paths.dedup();
    Some(
        paths
            .into_iter()
            .map(|path| {
                let merged = git(root, &["cat-file", "-p", &format!("{tree}:{path}")]).unwrap_or_default();
                let by = git(root, &["log", "-1", "--format=%an", &format!("{split}..{base_sha}"), "--", path]).ok().filter(|a| !a.is_empty());
                Conflict { path: path.into(), by, hunks: conflict_hunks(&merged) }
            })
            .collect(),
    )
}

/// The conflicts in a file with markers (`<<<<<<<` ours, `=======`, theirs `>>>>>>>`).
fn conflict_hunks(text: &str) -> Vec<ConflictHunk> {
    #[derive(Clone, Copy)]
    enum At {
        Outside,
        Ours,
        Ancestor,
        Theirs,
    }
    let clip = |l: &str| l.trim_end().chars().take(200).collect::<String>();
    let (mut at, mut line, mut out) = (At::Outside, 0, Vec::new());
    let mut hunk = ConflictHunk { line: 0, ours: Vec::new(), theirs: Vec::new() };
    for l in text.lines() {
        match at {
            At::Outside if l.starts_with("<<<<<<<") => {
                hunk = ConflictHunk { line: line + 1, ours: Vec::new(), theirs: Vec::new() };
                at = At::Ours;
            }
            At::Outside => line += 1,
            At::Ours | At::Ancestor if l.trim_end() == "=======" => at = At::Theirs,
            At::Ours if l.starts_with("|||||||") => at = At::Ancestor,
            At::Ours => {
                line += 1;
                if hunk.ours.len() < HUNK_LINES {
                    hunk.ours.push(clip(l));
                }
            }
            At::Ancestor => {}
            At::Theirs if l.starts_with(">>>>>>>") => {
                if out.len() < HUNKS_PER_FILE {
                    out.push(std::mem::replace(&mut hunk, ConflictHunk { line: 0, ours: Vec::new(), theirs: Vec::new() }));
                }
                at = At::Outside;
            }
            At::Theirs => {
                if hunk.theirs.len() < HUNK_LINES {
                    hunk.theirs.push(clip(l));
                }
            }
        }
    }
    out
}

fn has_markers(text: &str) -> bool {
    text.lines().any(|l| l.starts_with("<<<<<<<") || l.starts_with(">>>>>>>"))
}

impl BranchStatus {
    /// The status for the model. Starts with `HEAD <sha>`, which the card reads.
    pub fn summary(&self) -> String {
        let name = self.branch.as_deref().unwrap_or("HEAD (detached)");
        let mut s = format!(
            "HEAD {}\n{name} against {}: {} ahead, {} behind; {} files changed, +{} −{}.\n",
            self.head, self.base, self.ahead, self.behind, self.files, self.additions, self.deletions
        );
        if self.uncommitted > 0 {
            s.push_str(&format!("{} files have uncommitted changes.\n", self.uncommitted));
        }
        match (&self.merging, &self.conflicts) {
            (Some(m), _) if m.unresolved.is_empty() => s.push_str("A merge is in progress with every conflict resolved; git_commit finishes it.\n"),
            (Some(m), _) => s.push_str(&format!("A merge is in progress; still conflicted: {}.\n", m.unresolved.join(", "))),
            (None, Some(c)) if c.is_empty() => s.push_str(&format!("Merges cleanly into {}.\n", self.base)),
            (None, Some(c)) => {
                let files: Vec<String> = c
                    .iter()
                    .map(|f| {
                        let lines: Vec<String> = f.hunks.iter().map(|h| h.line.to_string()).collect();
                        let by = f.by.as_ref().map(|b| format!(", last changed on {} by {b}", self.base)).unwrap_or_default();
                        format!("{} (lines {}{by})", f.path, lines.join(", "))
                    })
                    .collect();
                s.push_str(&format!("Conflicts with {}: {}. git_merge {} brings it in to resolve them.\n", self.base, files.join("; "), self.base));
            }
            (None, None) => s.push_str("Couldn't check for conflicts (needs git 2.38 or later).\n"),
        }
        s.push_str("The user sees this as the pull request card.");
        s
    }
}

/// Stage everything (honouring .gitignore) and commit it, which also finishes
/// a merge whose conflicts are resolved. Hooks don't run.
pub fn commit(root: &Path, message: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("The commit needs a message.".into());
    }
    let opts = without_hooks(root)?;
    let merging = run(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])?.code == 0;
    // `git add` would mark a file resolved with its conflict markers still in it.
    let top = git(root, &["rev-parse", "--show-toplevel"])?;
    let prefix = git(root, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    let marked: Vec<String> = status(root)?
        .1
        .into_iter()
        .filter(|p| std::fs::read_to_string(Path::new(&top).join(&prefix).join(p)).is_ok_and(|t| has_markers(&t)))
        .collect();
    if !marked.is_empty() {
        return Err(format!("These files still have conflict markers: {}. Resolve them first.", marked.join(", ")));
    }
    check(git_with(root, &opts, &["add", "-A"])?)?;
    let staged = run(root, &["diff", "--cached", "--quiet"])?.code == 1;
    if !staged && !merging {
        return Err("There's nothing to commit.".into());
    }
    check(git_with(root, &opts, &["commit", "--no-verify", "-q", "-m", message])?)?;
    Ok(format!("Committed {}.", git(root, &["log", "-1", "--format=%h %s"])?))
}

fn check(out: Output) -> Result<String, String> {
    if out.code == 0 {
        Ok(out.stdout)
    } else {
        Err(if out.stderr.is_empty() { out.stdout } else { out.stderr })
    }
}

/// Merge `branch` into the current one. Each file it will change goes to
/// `before` first (for undo). On conflicts the files keep their markers and
/// the merge stays in progress for the model to resolve.
pub fn merge(root: &Path, branch: &str, before: &mut dyn FnMut(&str) -> Result<(), String>) -> Result<String, String> {
    check_ref(root, branch)?;
    let opts = without_hooks(root)?;
    let changed = git(root, &["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--name-only", "--relative", &format!("HEAD...{branch}")])?;
    for path in changed.lines().filter(|p| !p.is_empty()) {
        before(path)?;
    }
    let was = git(root, &["rev-parse", "HEAD"])?;
    let out = git_with(root, &opts, &["-c", "merge.conflictStyle=merge", "merge", "--no-edit", branch])?;
    if out.code == 0 {
        let now = git(root, &["rev-parse", "HEAD"])?;
        return Ok(if now == was { format!("Already up to date with {branch}.") } else { format!("Merged {branch} into this branch.") });
    }
    let (_, unresolved) = status(root)?;
    if unresolved.is_empty() {
        return Err(if out.stderr.is_empty() { out.stdout } else { out.stderr });
    }
    Ok(format!(
        "Merging {branch} stopped on conflicts in {} {}: {}. Each keeps conflict markers (<<<<<<< this branch, =======, {branch} >>>>>>>). \
         Resolve them with fs_edit, keeping what both sides meant, then git_commit to finish the merge (or git_merge with abort: true to undo it).",
        unresolved.len(),
        if unresolved.len() == 1 { "file" } else { "files" },
        unresolved.join(", ")
    ))
}

/// Undo a merge in progress, keeping each file it touched for undo first.
pub fn merge_abort(root: &Path, before: &mut dyn FnMut(&str) -> Result<(), String>) -> Result<String, String> {
    if run(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])?.code != 0 {
        return Err("No merge is in progress.".into());
    }
    let opts = without_hooks(root)?;
    let changed = git(root, &["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--name-only", "--relative", "HEAD"])?;
    for path in changed.lines().filter(|p| !p.is_empty()) {
        before(path)?;
    }
    check(git_with(root, &opts, &["merge", "--abort"])?)?;
    Ok("Undid the merge; the branch is back where it was.".into())
}

/// Land this branch on `base` locally by fast-forwarding `base` to HEAD. Where
/// `base` is checked out (often the user's own checkout) it must be clean.
pub fn land(root: &Path, base: &str) -> Result<String, String> {
    check_branch(root, base)?;
    let head = git(root, &["rev-parse", "HEAD"])?;
    if run(root, &["merge-base", "--is-ancestor", base, "HEAD"])?.code != 0 {
        return Err(format!("{base} has commits this branch doesn't. Merge {base} into this branch first (git_merge), then land it."));
    }
    let worktrees = git(root, &["worktree", "list", "--porcelain"])?;
    let (mut at, mut checkout) = (None, None);
    for line in worktrees.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            at = Some(p);
        } else if line.strip_prefix("branch refs/heads/") == Some(base) {
            checkout = at;
        }
    }
    match checkout {
        Some(dir) => {
            let dir = Path::new(dir);
            let dirty = git(dir, &["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=no"])?;
            if !dirty.is_empty() {
                return Err(format!("{base} is checked out in {} with uncommitted changes, so it wasn't updated.", dir.display()));
            }
            check(git_with(dir, &without_hooks(dir)?, &["merge", "--ff-only", "-q", &head])?)?;
        }
        None => {
            let old = git(root, &["rev-parse", "--verify", &format!("refs/heads/{base}")])?;
            git(root, &["update-ref", &format!("refs/heads/{base}"), &head, &old])?;
        }
    }
    Ok(format!("{base} now points at {}: this branch is merged into it.", &head[..7.min(head.len())]))
}

// --- history, for the graph panel ----------------------------------------------------

/// The repository's history, newest first, for the side panel's graph.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLog {
    pub branch: Option<String>,
    /// The commit HEAD points at; `None` before the first commit.
    pub head: Option<String>,
    /// The user's git name, so their commits can read "You".
    pub you: Option<String>,
    /// Files with uncommitted changes (untracked ones included).
    pub uncommitted: usize,
    pub commits: Vec<LogCommit>,
    /// There are older commits than `commits` shows.
    pub more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogCommit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    /// Commit time, in seconds since the epoch.
    pub time: i64,
    pub refs: Vec<GitRef>,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    /// Short name: `main`, `origin/main`, `v2.1.0`.
    pub name: String,
    pub kind: RefKind,
    /// HEAD points at this branch.
    pub head: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefKind {
    Branch,
    Remote,
    Tag,
}

/// Up to `limit` commits: every local and remote branch and tag when `all`,
/// else HEAD and the branch it tracks.
///
/// Each git process costs tens of milliseconds to start on Windows, so this
/// runs three: one `status` for the branch, HEAD, upstream and uncommitted
/// count, and the user's name and the history alongside it.
pub fn log(root: &Path, limit: usize, all: bool) -> Result<GitLog, String> {
    let n = (limit + 1).to_string();
    let history = |upstream: Option<&str>| {
        let mut args = vec!["log", "--topo-order", "--decorate=full", "-n", n.as_str(), "--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s"];
        if all {
            args.extend(["--branches", "--remotes", "--tags"]);
        } else {
            args.extend(upstream);
        }
        args.extend(["HEAD", "--"]);
        git(root, &args)
    };
    let (state, you, out) = std::thread::scope(|s| {
        let you = s.spawn(|| git(root, &["config", "user.name"]).ok().filter(|n| !n.is_empty()));
        // Every branch doesn't depend on the upstream, so it needn't wait for `status`.
        let early = all.then(|| s.spawn(|| history(None)));
        let state = branch_status_v2(root);
        let out = match (early, &state) {
            (Some(h), _) => h.join().unwrap_or_else(|_| Err("git log failed".into())),
            (None, Ok(st)) if st.head.is_some() => history(st.upstream.as_deref()),
            (None, _) => Ok(String::new()),
        };
        (state, you.join().ok().flatten(), out)
    });
    let BranchState { branch, head, uncommitted, .. } = state?;
    let Some(head) = head else {
        return Ok(GitLog { branch, head: None, you, uncommitted, commits: Vec::new(), more: false });
    };
    let mut commits: Vec<LogCommit> = out?
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(6, '\x1f').collect();
            let &[sha, parents, author, time, refs, subject] = f.as_slice() else { return None };
            Some(LogCommit {
                sha: sha.into(),
                parents: parents.split_whitespace().map(str::to_string).collect(),
                author: author.into(),
                time: time.parse().unwrap_or(0),
                refs: decorations(refs),
                subject: subject.into(),
            })
        })
        .collect();
    let more = commits.len() > limit;
    commits.truncate(limit);
    Ok(GitLog { branch, head: Some(head), you, uncommitted, commits, more })
}

/// `HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main` as refs.
fn decorations(text: &str) -> Vec<GitRef> {
    text.split(", ")
        .filter_map(|d| {
            let (head, d) = match d.strip_prefix("HEAD -> ") {
                Some(rest) => (true, rest),
                None => (false, d),
            };
            let d = d.strip_prefix("tag: ").unwrap_or(d);
            let (kind, name) = if let Some(n) = d.strip_prefix("refs/heads/") {
                (RefKind::Branch, n)
            } else if let Some(n) = d.strip_prefix("refs/remotes/") {
                (RefKind::Remote, n)
            } else if let Some(n) = d.strip_prefix("refs/tags/") {
                (RefKind::Tag, n)
            } else {
                return None;
            };
            // `origin/HEAD` only says which branch the remote defaults to.
            (!name.ends_with("/HEAD")).then(|| GitRef { name: name.into(), kind, head })
        })
        .collect()
}

/// One commit opened in the graph: its whole message and the files it changed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub message: String,
    pub files: Vec<CommitFile>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// Relative to the repository's top folder.
    pub path: String,
    /// Relative to the workspace folder, when the file is inside it.
    pub local: Option<String>,
    /// `None` for a binary file.
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
}

/// The folder's path inside its repository (`""` at the top, else ending in
/// `/`). It can't change for a folder, so it's read from git once.
fn prefix_of(root: &Path) -> String {
    static PREFIXES: Mutex<BTreeMap<PathBuf, String>> = Mutex::new(BTreeMap::new());
    if let Some(p) = PREFIXES.lock().unwrap().get(root) {
        return p.clone();
    }
    let Ok(p) = git(root, &["rev-parse", "--show-prefix"]) else { return String::new() };
    PREFIXES.lock().unwrap().insert(root.to_path_buf(), p.clone());
    p
}

/// A commit's message and changed files (against its first parent), from one
/// `git show`. Runs nothing the folder's config names: no external diff, no
/// textconv.
pub fn commit_detail(root: &Path, sha: &str) -> Result<CommitDetail, String> {
    if !(4..=40).contains(&sha.len()) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("{sha} isn't a commit."));
    }
    let out = git(
        root,
        &[
            "show",
            "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B%x1e",
            "--numstat",
            "-z",
            "--no-renames",
            "--no-textconv",
            "--no-ext-diff",
            "--no-show-signature",
            "--no-color",
            "--diff-merges=first-parent",
            sha,
            "--",
        ],
    )?;
    let not_commit = || format!("{sha} isn't a commit.");
    let (meta, stat) = out.split_once('\x1e').ok_or_else(not_commit)?;
    let f: Vec<&str> = meta.splitn(5, '\x1f').collect();
    let &[full, author, email, time, message] = f.as_slice() else { return Err(not_commit()) };
    let prefix = prefix_of(root);
    let files = stat
        .trim_start_matches(['\0', '\n'])
        .split('\0')
        .filter(|e| !e.is_empty())
        .filter_map(|entry| {
            let mut f = entry.splitn(3, '\t');
            let (add, del, path) = (f.next()?, f.next()?, f.next()?);
            Some(CommitFile {
                path: path.into(),
                local: path.strip_prefix(prefix.as_str()).map(str::to_string),
                additions: add.parse().ok(),
                deletions: del.parse().ok(),
            })
        })
        .collect();
    Ok(CommitDetail {
        sha: full.into(),
        author: author.into(),
        email: email.into(),
        time: time.parse().unwrap_or(0),
        message: message.trim().into(),
        files,
    })
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

    #[test]
    fn reads_decorations() {
        let refs = decorations("HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/remotes/origin/HEAD");
        let named: Vec<_> = refs.iter().map(|r| (r.name.as_str(), r.kind, r.head)).collect();
        assert_eq!(named, [("main", RefKind::Branch, true), ("v1", RefKind::Tag, false), ("origin/main", RefKind::Remote, false)]);
        assert!(decorations("").is_empty());
    }

    #[test]
    fn logs_history_and_opens_a_commit() {
        if !have_git() {
            return;
        }
        let dir = repo();
        let root = dir.path();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/a.txt"), "one\ntwo\n").unwrap();
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-q", "-m", "add a\n\nwith a body"]).unwrap();
        git(root, &["tag", "v1"]).unwrap();

        let all = log(root, 10, true).unwrap();
        assert_eq!((all.commits.len(), all.more, all.branch.as_deref()), (2, false, Some("main")));
        assert!(all.commits[0].refs.iter().any(|r| r.name == "main" && r.head));
        assert!(all.commits[0].refs.iter().any(|r| r.name == "v1" && r.kind == RefKind::Tag));
        assert!(all.commits[1].refs.iter().any(|r| r.name == "feature"));
        assert!(log(root, 1, true).unwrap().more);

        let detail = commit_detail(&root.join("sub"), &all.commits[0].sha).unwrap();
        assert_eq!(detail.message, "add a\n\nwith a body");
        assert_eq!(detail.files, [CommitFile { path: "sub/a.txt".into(), local: Some("a.txt".into()), additions: Some(2), deletions: Some(0) }]);
        assert!(commit_detail(root, "--all").is_err());
    }

    #[test]
    fn reads_conflict_markers() {
        let text = "a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> main\nb\n<<<<<<< HEAD\nx\n||||||| base\nold\n=======\ny\n>>>>>>> main\n";
        let hunks = conflict_hunks(text);
        assert_eq!(hunks.len(), 2);
        assert_eq!((hunks[0].line, hunks[0].ours.as_slice(), hunks[0].theirs.as_slice()), (2, &["mine".to_string()][..], &["theirs".to_string()][..]));
        assert_eq!((hunks[1].line, hunks[1].ours[0].as_str(), hunks[1].theirs[0].as_str()), (4, "x", "y"));
        assert_eq!(shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)"), (3, 10, 2));
        assert_eq!(shortstat(" 1 file changed, 1 deletion(-)"), (1, 0, 1));
    }

    #[test]
    fn finds_conflicts_then_merges_resolves_and_lands() {
        if !have_git() {
            return;
        }
        let dir = repo();
        let root = dir.path();
        let commit_file = |text: &str, msg: &str| {
            std::fs::write(root.join("a.txt"), text).unwrap();
            git(root, &["add", "a.txt"]).unwrap();
            git(root, &["commit", "-q", "-m", msg]).unwrap();
        };
        commit_file("one\n", "a on main");
        git(root, &["switch", "-q", "-c", "feat"]).unwrap();
        commit_file("mine\n", "a on feat");
        git(root, &["switch", "-q", "main"]).unwrap();
        commit_file("theirs\n", "a again on main");
        git(root, &["switch", "-q", "feat"]).unwrap();

        let status = branch_status(root, "main").unwrap();
        assert_eq!((status.ahead, status.behind, status.branch.as_deref()), (1, 1, Some("feat")));
        let conflicts = status.conflicts.clone().expect("git 2.38+");
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].path, "a.txt");
        assert_eq!((conflicts[0].hunks[0].ours[0].as_str(), conflicts[0].hunks[0].theirs[0].as_str()), ("mine", "theirs"));
        // The commit they split from comes last, on both sides.
        assert!(status.commits.last().is_some_and(|c| c.on_base && c.subject == "a on main"));
        assert!(status.summary().starts_with(&format!("HEAD {}", status.head)));
        assert!(branch_status(root, "nope").is_err());

        let mut kept = Vec::new();
        let said = merge(root, "main", &mut |p| {
            kept.push(p.to_string());
            Ok(())
        })
        .unwrap();
        assert!(said.contains("a.txt"), "{said}");
        assert_eq!(kept, ["a.txt"]);
        assert!(branch_status(root, "main").unwrap().merging.is_some_and(|m| m.unresolved == ["a.txt"]));
        assert!(commit(root, "merge").unwrap_err().contains("conflict markers"));

        std::fs::write(root.join("a.txt"), "both\n").unwrap();
        assert!(commit(root, "Merge main into feat").unwrap().contains("Merge main into feat"));
        let status = branch_status(root, "main").unwrap();
        assert_eq!((status.behind, status.merging.is_none(), status.conflicts.as_deref().map(<[_]>::len)), (0, true, Some(0)));
        assert!(commit(root, "again").unwrap_err().contains("nothing to commit"));

        land(root, "main").unwrap();
        assert_eq!(git(root, &["rev-parse", "main"]).unwrap(), git(root, &["rev-parse", "HEAD"]).unwrap());
    }
}
