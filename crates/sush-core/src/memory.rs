//! Long-term memory about the user: a few short markdown files on disk.
//!
//!   profile.md         who the user is
//!   topics/<slug>.md   cross-cutting knowledge (style, interests, skills)
//!   areas/<slug>.md    ongoing projects and responsibilities
//!
//! Each file starts with a small front matter block (title, description,
//! updated). Files are plain markdown, so the user can also edit them by hand.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::store::{StoreError, StoreResult};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    /// `profile`, `topics/<slug>` or `areas/<slug>`; doubles as the id.
    pub path: String,
    pub title: String,
    pub description: String,
    pub content: String,
    /// Milliseconds since the epoch.
    pub updated_at: i64,
}

pub struct MemoryDir {
    root: PathBuf,
}

const DIRS: [&str; 2] = ["topics", "areas"];

impl MemoryDir {
    pub fn open(root: &Path) -> StoreResult<Self> {
        for d in DIRS {
            std::fs::create_dir_all(root.join(d))?;
        }
        Ok(Self { root: root.to_path_buf() })
    }

    /// Every file: the profile first, then topics and areas by path.
    pub fn list(&self) -> StoreResult<Vec<MemoryFile>> {
        let mut files = Vec::new();
        if let Some(f) = self.read("profile")? {
            files.push(f);
        }
        for d in DIRS {
            let mut paths: Vec<String> = std::fs::read_dir(self.root.join(d))?
                .filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().to_str()?.strip_suffix(".md").map(|s| format!("{d}/{s}")))
                .filter(|p| valid_path(p))
                .collect();
            paths.sort();
            for p in paths {
                if let Some(f) = self.read(&p)? {
                    files.push(f);
                }
            }
        }
        Ok(files)
    }

    /// Create or replace a file.
    pub fn write(&self, file: &MemoryFile) -> StoreResult<()> {
        let path = self.file_path(&file.path)?;
        let text = format!(
            "---\ntitle: {}\ndescription: {}\nupdated: {}\n---\n\n{}\n",
            one_line(&file.title),
            one_line(&file.description),
            file.updated_at,
            file.content.trim()
        );
        let tmp = path.with_extension("md.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Returns whether the file existed.
    pub fn delete(&self, path: &str) -> StoreResult<bool> {
        match std::fs::remove_file(self.file_path(path)?) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    pub fn clear(&self) -> StoreResult<()> {
        for f in self.list()? {
            self.delete(&f.path)?;
        }
        Ok(())
    }

    fn read(&self, path: &str) -> StoreResult<Option<MemoryFile>> {
        let text = match std::fs::read_to_string(self.file_path(path)?) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        Ok(Some(parse(path, &text)))
    }

    /// The file for a memory path. Only valid paths map to a file, so a path
    /// from the model can never reach outside the memory folder.
    fn file_path(&self, path: &str) -> StoreResult<PathBuf> {
        if !valid_path(path) {
            return Err(StoreError::Invalid(format!(
                "Invalid memory path \"{path}\". Use profile, topics/<slug> or areas/<slug>."
            )));
        }
        Ok(self.root.join(format!("{path}.md")))
    }
}

/// `profile`, or `topics/` / `areas/` plus a lowercase slug of words joined by single dashes.
pub fn valid_path(path: &str) -> bool {
    if path == "profile" {
        return true;
    }
    let Some((dir, slug)) = path.split_once('/') else { return false };
    DIRS.contains(&dir)
        && (1..=64).contains(&slug.len())
        && slug.split('-').all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse(path: &str, text: &str) -> MemoryFile {
    let mut file = MemoryFile {
        path: path.into(),
        title: default_title(path),
        description: String::new(),
        content: text.trim().into(),
        updated_at: 0,
    };
    let text = text.replace("\r\n", "\n");
    let Some(rest) = text.strip_prefix("---\n") else { return file };
    let Some((head, body)) = rest.split_once("\n---") else { return file };
    for line in head.lines() {
        match line.split_once(':') {
            Some(("title", v)) if !v.trim().is_empty() => file.title = v.trim().into(),
            Some(("description", v)) => file.description = v.trim().into(),
            Some(("updated", v)) => file.updated_at = v.trim().parse().unwrap_or(0),
            _ => {}
        }
    }
    file.content = body.trim().into();
    file
}

fn default_title(path: &str) -> String {
    if path == "profile" {
        return "Profile".into();
    }
    let slug = path.split_once('/').map_or(path, |(_, s)| s).replace('-', " ");
    let mut chars = slug.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, content: &str) -> MemoryFile {
        MemoryFile {
            path: path.into(),
            title: "Title\nwith newline".into(),
            description: "One line".into(),
            content: content.into(),
            updated_at: 42,
        }
    }

    #[test]
    fn writes_lists_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let mem = MemoryDir::open(dir.path()).unwrap();
        mem.write(&file("topics/style", "- Prefers short answers")).unwrap();
        mem.write(&file("profile", "- Engineer")).unwrap();
        mem.write(&file("areas/sush", "- Building a desktop app")).unwrap();

        let files = mem.list().unwrap();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["profile", "topics/style", "areas/sush"]);
        assert_eq!(files[1].title, "Title with newline");
        assert_eq!(files[1].content, "- Prefers short answers");
        assert_eq!(files[1].updated_at, 42);

        assert!(mem.delete("topics/style").unwrap());
        assert!(!mem.delete("topics/style").unwrap());
        mem.clear().unwrap();
        assert!(mem.list().unwrap().is_empty());
    }

    #[test]
    fn hand_written_files_without_front_matter_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let mem = MemoryDir::open(dir.path()).unwrap();
        std::fs::write(dir.path().join("topics/cooking-notes.md"), "Likes spicy food\r\n").unwrap();
        let f = &mem.list().unwrap()[0];
        assert_eq!((f.title.as_str(), f.content.as_str()), ("Cooking notes", "Likes spicy food"));
    }

    #[test]
    fn paths_cannot_escape_the_memory_folder() {
        for bad in ["../secrets", "topics/../../x", "topics/", "topics/a/b", "areas/UPPER", "topics/a--b", "/etc/passwd", "profile.md", "notes/x", "topics/a\\b"] {
            assert!(!valid_path(bad), "{bad} should be rejected");
        }
        let dir = tempfile::tempdir().unwrap();
        let mem = MemoryDir::open(dir.path()).unwrap();
        assert!(mem.write(&file("../escape", "x")).is_err());
        assert!(!dir.path().parent().unwrap().join("escape.md").exists());
    }
}
