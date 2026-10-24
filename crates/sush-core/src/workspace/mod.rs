//! Cowork workspaces: folders the user granted Sush, and the file and shell
//! tools the agent uses in them.
//!
//! Every file operation goes through a capability handle on the folder
//! (`cap_std::fs::Dir`), which refuses paths that leave it: `..`, absolute
//! paths, and symlinks or junctions pointing outside. Paths from the model
//! are also normalised and checked here first, so errors are readable.
//!
//! Some paths stay read-only even when the workspace is writable (`.git`,
//! `.sush`), and files that look like secrets need the user's approval to read.

pub mod git;
pub mod sandbox;
pub mod shell;
pub mod tools;

use std::path::{Path, PathBuf};

use cap_std::ambient_authority;
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};

/// A folder the user granted, with what the agent may do in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// Canonical absolute path.
    pub root: String,
    pub access: Access,
    pub approval: EditApproval,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Access {
    /// Read and search only; no edits, no shell.
    ReadOnly,
    WorkspaceWrite,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Access::ReadOnly => "read-only",
            Access::WorkspaceWrite => "workspace-write",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "read-only" => Some(Access::ReadOnly),
            "workspace-write" => Some(Access::WorkspaceWrite),
            _ => None,
        }
    }
}

/// When file changes need the user's approval. Shell commands always do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EditApproval {
    Ask,
    AutoEdits,
}

impl EditApproval {
    pub fn as_str(self) -> &'static str {
        match self {
            EditApproval::Ask => "ask",
            EditApproval::AutoEdits => "auto-edits",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ask" => Some(EditApproval::Ask),
            "auto-edits" => Some(EditApproval::AutoEdits),
            _ => None,
        }
    }
}

/// One entry of a directory listing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// Relative to the workspace, with forward slashes.
    pub path: String,
    pub dir: bool,
    pub size: u64,
}

pub type FsResult<T> = Result<T, String>;

/// Largest file `read` returns whole; bigger ones need a line range.
const MAX_READ_BYTES: usize = 2 * 1024 * 1024;
/// Directories never worth walking.
const SKIP_DIRS: [&str; 2] = [".git", "node_modules"];

/// File access confined to one folder.
pub struct WorkspaceFs {
    root: PathBuf,
    dir: Dir,
}

impl WorkspaceFs {
    pub fn open(root: &Path) -> FsResult<Self> {
        let dir = Dir::open_ambient_dir(root, ambient_authority())
            .map_err(|e| format!("Can't open the workspace folder {}: {e}", root.display()))?;
        Ok(Self { root: root.to_path_buf(), dir })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// A path from the model or the UI, as a normalised relative path ("" is
    /// the root). Absolute paths are accepted when they're inside the folder.
    pub fn rel(&self, input: &str) -> FsResult<String> {
        let raw = input.trim().replace('\\', "/");
        let root = self.root.to_string_lossy().replace('\\', "/");
        let root = root.trim_end_matches('/');
        let relative = if is_absolute(&raw) {
            let (a, b) = if cfg!(windows) { (raw.to_lowercase(), root.to_lowercase()) } else { (raw.clone(), root.to_string()) };
            if a == b {
                String::new()
            } else if a.starts_with(&format!("{b}/")) {
                // Lowercasing can change byte lengths outside ASCII; refuse rather than mis-slice.
                raw.get(root.len() + 1..).filter(|_| a.len() == raw.len() && b.len() == root.len()).map(str::to_string).ok_or_else(|| {
                    format!("{input}: use a path relative to the workspace folder.")
                })?
            } else {
                return Err(format!("{input} is outside the workspace folder. Use a path relative to it."));
            }
        } else {
            raw
        };
        let mut parts = Vec::new();
        for c in relative.split('/') {
            match c {
                "" | "." => {}
                ".." => return Err(format!("{input}: paths can't go up with '..'.")),
                c if !valid_component(c) => return Err(format!("{input}: \"{c}\" isn't a usable file name.")),
                c => parts.push(c),
            }
        }
        Ok(parts.join("/"))
    }

    fn path(rel: &str) -> &Path {
        Path::new(if rel.is_empty() { "." } else { rel })
    }

    /// Entries of one directory: folders first, then files, by name.
    pub fn list(&self, rel: &str) -> FsResult<Vec<Entry>> {
        let entries = self.dir.read_dir(Self::path(rel)).map_err(|e| io_error(rel, e))?;
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = entry.metadata().ok();
            let dir = meta.as_ref().is_some_and(|m| m.is_dir());
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            out.push(Entry { name, path, dir, size: meta.map_or(0, |m| m.len()) });
        }
        out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    }

    pub fn is_dir(&self, rel: &str) -> bool {
        self.dir.is_dir(Self::path(rel))
    }

    /// A file's bytes, or None if it doesn't exist.
    pub fn bytes(&self, rel: &str) -> FsResult<Option<Vec<u8>>> {
        match self.dir.read(Self::path(rel)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io_error(rel, e)),
        }
    }

    /// Lines `offset..offset+limit` (1-based), numbered like `cat -n`.
    pub fn read(&self, rel: &str, offset: usize, limit: usize) -> FsResult<String> {
        if self.is_dir(rel) {
            return Err(format!("{rel} is a folder; use fs_list."));
        }
        let bytes = self.dir.read(Self::path(rel)).map_err(|e| io_error(rel, e))?;
        if bytes.iter().take(8192).any(|&b| b == 0) {
            return Ok(format!("{rel} is a binary file ({} bytes).", bytes.len()));
        }
        if bytes.len() > MAX_READ_BYTES && offset <= 1 && limit >= DEFAULT_READ_LINES {
            return Err(format!("{rel} is {} bytes; read it in parts with offset and limit.", bytes.len()));
        }
        let text = String::from_utf8_lossy(&bytes);
        let start = offset.max(1);
        let mut out = String::new();
        let mut total = 0;
        for (i, line) in text.lines().enumerate() {
            total = i + 1;
            if total < start || total >= start + limit {
                continue;
            }
            let line: String = line.chars().take(2000).collect();
            out.push_str(&format!("{total:>6}\t{line}\n"));
        }
        if total == 0 {
            return Ok(format!("{rel} is empty."));
        }
        if total >= start + limit {
            out.push_str(&format!("[{} more lines; continue with offset {}]\n", total - (start + limit) + 1, start + limit));
        }
        Ok(out)
    }

    /// Create or overwrite a file, creating its folders.
    pub fn write(&self, rel: &str, content: &[u8]) -> FsResult<()> {
        writable(rel)?;
        if let Some(parent) = Path::new(rel).parent().filter(|p| !p.as_os_str().is_empty()) {
            self.dir.create_dir_all(parent).map_err(|e| io_error(rel, e))?;
        }
        self.dir.write(Self::path(rel), content).map_err(|e| io_error(rel, e))
    }

    /// Replace `old` with `new`; it must occur exactly once unless `all`.
    /// Returns how many places changed.
    pub fn edit(&self, rel: &str, old: &str, new: &str, all: bool) -> FsResult<usize> {
        writable(rel)?;
        if old.is_empty() {
            return Err("old_string is empty; use fs_write to create a file.".into());
        }
        let text = self.dir.read_to_string(Self::path(rel)).map_err(|e| io_error(rel, e))?;
        let count = text.matches(old).count();
        match count {
            0 => Err(format!("old_string wasn't found in {rel}. Read the file again and copy the text exactly.")),
            n if n > 1 && !all => Err(format!(
                "old_string occurs {n} times in {rel}. Include more surrounding text so it's unique, or set replace_all."
            )),
            n => {
                let updated = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
                self.dir.write(Self::path(rel), updated).map_err(|e| io_error(rel, e))?;
                Ok(n)
            }
        }
    }

    pub fn rename(&self, from: &str, to: &str) -> FsResult<()> {
        writable(from)?;
        writable(to)?;
        if self.dir.exists(Self::path(to)) {
            return Err(format!("{to} already exists."));
        }
        if let Some(parent) = Path::new(to).parent().filter(|p| !p.as_os_str().is_empty()) {
            self.dir.create_dir_all(parent).map_err(|e| io_error(to, e))?;
        }
        self.dir.rename(Self::path(from), &self.dir, Self::path(to)).map_err(|e| io_error(from, e))
    }

    /// Move a file to the OS trash, so the user can still get it back.
    pub fn trash(&self, rel: &str) -> FsResult<()> {
        writable(rel)?;
        // Resolving it through the handle first proves the path stays inside
        // the folder (an escaping symlink in between fails here).
        let meta = self.dir.symlink_metadata(Self::path(rel)).map_err(|e| io_error(rel, e))?;
        if meta.is_dir() {
            return Err(format!("{rel} is a folder; only files can be deleted."));
        }
        trash::delete(self.root.join(rel)).map_err(|e| format!("{rel}: couldn't move it to the trash: {e}"))
    }

    /// Put a file back as it was, or remove it if it didn't exist (undo).
    pub fn restore(&self, rel: &str, original: Option<&[u8]>) -> FsResult<()> {
        match original {
            Some(bytes) => self.write(rel, bytes),
            None => match self.dir.remove_file(Self::path(rel)) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(io_error(rel, e)),
            },
        }
    }

    /// Files under the folder, honouring `.gitignore`, as relative paths.
    fn walk(&self) -> impl Iterator<Item = String> + '_ {
        ignore::WalkBuilder::new(&self.root)
            .hidden(false)
            .follow_links(false)
            .filter_entry(|e| !e.file_name().to_str().is_some_and(|n| SKIP_DIRS.contains(&n)))
            .sort_by_file_path(Ord::cmp)
            .build()
            .flatten()
            .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
            .filter_map(move |e| {
                let rel = e.path().strip_prefix(&self.root).ok()?;
                Some(rel.to_string_lossy().replace('\\', "/"))
            })
    }

    /// Files whose path contains `query` (case-insensitive), for the file filter.
    pub fn find(&self, query: &str, limit: usize) -> Vec<String> {
        let query = query.trim().to_lowercase().replace('\\', "/");
        self.walk().filter(|p| p.to_lowercase().contains(&query)).take(limit).collect()
    }

    /// Files matching a glob like `src/**/*.rs`.
    pub fn glob(&self, pattern: &str, limit: usize) -> FsResult<(Vec<String>, bool)> {
        let matcher = globset::GlobBuilder::new(pattern.trim_start_matches("./"))
            .literal_separator(true)
            .build()
            .map_err(|e| format!("Bad glob pattern: {e}"))?
            .compile_matcher();
        let mut found = Vec::new();
        for path in self.walk() {
            if matcher.is_match(&path) {
                if found.len() == limit {
                    return Ok((found, true));
                }
                found.push(path);
            }
        }
        Ok((found, false))
    }

    /// Lines matching a regex, as `path:line: text`. Secret-looking files are
    /// skipped: reading one needs the user's approval, which a search mustn't get around.
    pub fn search(&self, pattern: &str, glob: Option<&str>, ignore_case: bool, limit: usize) -> FsResult<(Vec<String>, bool)> {
        let re = regex::RegexBuilder::new(pattern)
            .case_insensitive(ignore_case)
            .size_limit(1 << 20)
            .build()
            .map_err(|e| format!("Bad regex: {e}"))?;
        let filter = glob
            .map(|g| {
                // A bare `*.rs` matches at any depth.
                let g = if g.contains('/') { g.to_string() } else { format!("**/{g}") };
                globset::Glob::new(&g).map(|g| g.compile_matcher()).map_err(|e| format!("Bad glob: {e}"))
            })
            .transpose()?;
        let mut hits = Vec::new();
        for path in self.walk() {
            if filter.as_ref().is_some_and(|f| !f.is_match(&path)) || looks_secret(&path) {
                continue;
            }
            let Ok(bytes) = self.dir.read(&path) else { continue };
            if bytes.len() > MAX_READ_BYTES || bytes.iter().take(8192).any(|&b| b == 0) {
                continue;
            }
            for (i, line) in String::from_utf8_lossy(&bytes).lines().enumerate() {
                if re.is_match(line) {
                    if hits.len() == limit {
                        return Ok((hits, true));
                    }
                    let line: String = line.trim().chars().take(300).collect();
                    hits.push(format!("{path}:{}: {line}", i + 1));
                }
            }
        }
        Ok((hits, false))
    }
}

pub const DEFAULT_READ_LINES: usize = 2000;

fn is_absolute(p: &str) -> bool {
    p.starts_with('/') || (p.len() >= 3 && p.as_bytes()[1] == b':' && p.as_bytes()[2] == b'/')
}

/// Rejects names Windows treats specially, and characters no file name should hold.
fn valid_component(c: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2",
        "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let stem = c.split('.').next().unwrap_or(c).to_lowercase();
    !c.contains([':', '\0', '<', '>', '"', '|', '?', '*'])
        && !RESERVED.contains(&stem.as_str())
        // "file." and "file " alias "file" on Windows.
        && !c.ends_with('.')
        && !c.ends_with(' ')
}

/// Paths the agent may read but never change.
pub fn is_protected(rel: &str) -> bool {
    rel.split('/').any(|c| c.eq_ignore_ascii_case(".git")) || rel.split('/').next().is_some_and(|c| c.eq_ignore_ascii_case(".sush"))
}

fn writable(rel: &str) -> FsResult<()> {
    if rel.is_empty() {
        return Err("That's the workspace folder itself.".into());
    }
    if is_protected(rel) {
        return Err(format!("{rel} is protected: .git and .sush can't be changed."));
    }
    Ok(())
}

/// Files that usually hold credentials; reading one needs the user's approval.
pub fn looks_secret(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
    let example = ["example", "sample", "template"].iter().any(|s| name.ends_with(s));
    (name.starts_with(".env") && !example)
        || [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"].iter().any(|ext| name.ends_with(ext))
        || (["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].iter().any(|k| name.starts_with(k)) && !name.ends_with(".pub"))
        || [".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials.json", "secrets.json"].contains(&name.as_str())
}

fn io_error(rel: &str, e: std::io::Error) -> String {
    let rel = if rel.is_empty() { "the workspace folder" } else { rel };
    match e.kind() {
        std::io::ErrorKind::NotFound => format!("{rel} doesn't exist."),
        std::io::ErrorKind::PermissionDenied => format!("{rel}: permission denied (or outside the workspace folder)."),
        _ => format!("{rel}: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> (tempfile::TempDir, WorkspaceFs) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {\n    println!(\"hi\");\n}\n").unwrap();
        let fs = WorkspaceFs::open(&root).unwrap();
        (dir, fs)
    }

    #[test]
    fn paths_are_normalised_and_confined() {
        let (_d, fs) = ws();
        assert_eq!(fs.rel("./src//main.rs").unwrap(), "src/main.rs");
        assert_eq!(fs.rel("src\\main.rs").unwrap(), "src/main.rs");
        assert_eq!(fs.rel("").unwrap(), "");
        let abs = fs.root().join("src").join("main.rs");
        assert_eq!(fs.rel(&abs.to_string_lossy()).unwrap(), "src/main.rs");
        for bad in ["../x", "src/../../x", "/etc/passwd", "C:/Windows/system32", "file.txt:stream", "CON", "aux.txt", "name."] {
            assert!(fs.rel(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn reads_numbered_lines_in_ranges() {
        let (_d, fs) = ws();
        let all = fs.read("src/main.rs", 1, DEFAULT_READ_LINES).unwrap();
        assert!(all.starts_with("     1\tfn main() {"));
        let middle = fs.read("src/main.rs", 2, 1).unwrap();
        assert!(middle.starts_with("     2\t    println!"));
        assert!(middle.contains("continue with offset 3"));
        assert!(fs.read("missing.rs", 1, 10).unwrap_err().contains("doesn't exist"));
    }

    #[test]
    fn edits_need_a_unique_match() {
        let (_d, fs) = ws();
        assert_eq!(fs.edit("src/main.rs", "\"hi\"", "\"hello\"", false).unwrap(), 1);
        assert!(fs.bytes("src/main.rs").unwrap().unwrap().windows(7).any(|w| w == b"\"hello\""));
        fs.write("dup.txt", b"a a").unwrap();
        assert!(fs.edit("dup.txt", "a", "b", false).unwrap_err().contains("2 times"));
        assert_eq!(fs.edit("dup.txt", "a", "b", true).unwrap(), 2);
        assert!(fs.edit("dup.txt", "zzz", "b", false).is_err());
    }

    #[test]
    fn protected_paths_stay_read_only() {
        let (_d, fs) = ws();
        std::fs::create_dir_all(fs.root().join(".git")).unwrap();
        std::fs::write(fs.root().join(".git/config"), "[core]").unwrap();
        assert!(fs.read(".git/config", 1, 10).is_ok());
        assert!(fs.write(".git/config", b"x").unwrap_err().contains("protected"));
        assert!(fs.write("vendor/.GIT/hooks/pre-commit", b"x").is_err());
        assert!(fs.rename("src/main.rs", ".git/main.rs").is_err());
        assert!(fs.write("", b"x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape() {
        let (_d, fs) = ws();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "top secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), fs.root().join("link")).unwrap();
        assert!(fs.read("link/secret.txt", 1, 10).is_err());
        assert!(fs.write("link/new.txt", b"x").is_err());
        assert!(!outside.path().join("new.txt").exists());
    }

    #[test]
    fn search_skips_secret_files() {
        let (_d, fs) = ws();
        fs.write(".env", b"API_KEY=hunter2\n").unwrap();
        fs.write("config.rs", b"const API_KEY: &str = \"env\";\n").unwrap();
        let (hits, _) = fs.search("API_KEY", None, false, 10).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].starts_with("config.rs:1:"));
    }

    #[test]
    fn glob_and_search_respect_gitignore() {
        let (_d, fs) = ws();
        fs.write(".gitignore", b"target/\n").unwrap();
        fs.write("target/out.rs", b"fn main() {}").unwrap();
        fs.write("src/lib.rs", b"pub fn hello() {}\n").unwrap();
        // `ignore` only applies .gitignore inside a git repository.
        std::fs::create_dir_all(fs.root().join(".git")).unwrap();
        let (files, more) = fs.glob("**/*.rs", 10).unwrap();
        assert_eq!(files, ["src/lib.rs", "src/main.rs"]);
        assert!(!more);
        let (hits, _) = fs.search("fn \\w+", Some("*.rs"), false, 10).unwrap();
        assert_eq!(hits, ["src/lib.rs:1: pub fn hello() {}", "src/main.rs:1: fn main() {"]);
        assert!(fs.search("(", None, false, 10).is_err());
    }

    #[test]
    fn restore_puts_files_back() {
        let (_d, fs) = ws();
        let original = fs.bytes("src/main.rs").unwrap();
        fs.write("src/main.rs", b"changed").unwrap();
        fs.write("new.txt", b"new").unwrap();
        fs.restore("src/main.rs", original.as_deref()).unwrap();
        fs.restore("new.txt", None).unwrap();
        assert_eq!(fs.bytes("src/main.rs").unwrap(), original);
        assert_eq!(fs.bytes("new.txt").unwrap(), None);
    }

    #[test]
    fn secret_files_are_recognised() {
        for s in [".env", ".env.local", "config/.env.production", "server.pem", "id_rsa", ".npmrc"] {
            assert!(looks_secret(s), "{s}");
        }
        for s in [".env.example", "id_rsa.pub", "main.rs", "environment.ts"] {
            assert!(!looks_secret(s), "{s}");
        }
    }
}
