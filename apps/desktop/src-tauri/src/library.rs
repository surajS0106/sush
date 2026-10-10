//! Local context the UI attaches to chats: folders read from disk and plugin
//! bundles (skills, connectors and design systems shipped as a folder).

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sush_core::mcp::ServerCommand;

use crate::error::{AppError, AppResult};

const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_BYTES: usize = 2 * 1024 * 1024;
const MAX_FILES: usize = 400;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderFile {
    /// Relative to the folder, with forward slashes.
    path: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    name: String,
    files: Vec<FolderFile>,
    /// Binary, too large, or unreadable files that were left out.
    skipped: usize,
    /// True when the size or file-count cap cut the walk short.
    truncated: bool,
}

/// Text files under `path`, honouring `.gitignore` and skipping hidden files,
/// binaries and anything over the caps.
#[tauri::command]
pub async fn read_folder(path: String) -> AppResult<Folder> {
    tokio::task::spawn_blocking(move || walk(Path::new(&path)))
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))?
}

/// Write an artifact to the path the user picked in a save dialog.
#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> AppResult<()> {
    tokio::fs::write(path, contents).await?;
    Ok(())
}

fn walk(root: &Path) -> AppResult<Folder> {
    if !root.is_dir() {
        return Err(AppError::NotFound(format!("{} is not a folder", root.display())));
    }
    let mut folder = Folder {
        name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string()),
        files: vec![],
        skipped: 0,
        truncated: false,
    };
    let mut total = 0;
    let walker = ignore::WalkBuilder::new(root)
        .filter_entry(|e| !matches!(e.file_name().to_str(), Some("node_modules" | "target" | "dist" | "build" | ".git")))
        .sort_by_file_path(Ord::cmp)
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if folder.files.len() >= MAX_FILES || total >= MAX_TOTAL_BYTES {
            folder.truncated = true;
            break;
        }
        match read_text(entry.path()) {
            Some(content) if total + content.len() <= MAX_TOTAL_BYTES => {
                total += content.len();
                let rel = entry.path().strip_prefix(root).unwrap_or(entry.path());
                folder.files.push(FolderFile { path: rel.to_string_lossy().replace('\\', "/"), content });
            }
            Some(_) => folder.truncated = true,
            None => folder.skipped += 1,
        }
    }
    Ok(folder)
}

/// UTF-8 text under the per-file cap; `None` for binaries and large files.
fn read_text(path: &Path) -> Option<String> {
    if path.metadata().ok()?.len() > MAX_FILE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path).ok()?.read_to_end(&mut bytes).ok()?;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

// ---------------------------------------------------------------------------
// Plugins

pub const MANIFEST: &str = "sush-plugin.json";

/// `sush-plugin.json` as written by plugin authors. Text can be inline or in a
/// file next to the manifest; `${PLUGIN_DIR}` in connector args/env expands to
/// the plugin's folder.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    skills: Vec<TextEntry>,
    #[serde(default)]
    design_systems: Vec<TextEntry>,
    #[serde(default)]
    connectors: Vec<ConnectorEntry>,
}

#[derive(Deserialize)]
struct TextEntry {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    file: Option<String>,
}

#[derive(Deserialize)]
struct ConnectorEntry {
    name: String,
    #[serde(flatten)]
    command: ServerCommand,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginItem {
    name: String,
    description: Option<String>,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConnector {
    name: String,
    #[serde(flatten)]
    command: ServerCommand,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    dir: String,
    name: String,
    version: Option<String>,
    description: Option<String>,
    skills: Vec<PluginItem>,
    design_systems: Vec<PluginItem>,
    connectors: Vec<PluginConnector>,
}

/// Read and resolve a plugin folder. Called on install and on reload.
#[tauri::command]
pub fn load_plugin(path: String) -> AppResult<Plugin> {
    let dir = PathBuf::from(&path).canonicalize()?;
    let manifest_path = dir.join(MANIFEST);
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|_| AppError::NotFound(format!("no {MANIFEST} in {}", dir.display())))?;
    let m: Manifest = serde_json::from_str(&raw)?;
    let dir_str = dir.to_string_lossy().into_owned();
    let expand = |s: &str| s.replace("${PLUGIN_DIR}", &dir_str);

    let items = |entries: Vec<TextEntry>| -> AppResult<Vec<PluginItem>> {
        entries
            .into_iter()
            .map(|e| {
                let text = match (e.text, e.file) {
                    (Some(text), _) => text,
                    (None, Some(file)) => std::fs::read_to_string(inside(&dir, &file)?)?,
                    (None, None) => return Err(AppError::Invalid(format!("`{}` has neither text nor file", e.name))),
                };
                Ok(PluginItem { name: e.name, description: e.description, text })
            })
            .collect()
    };

    Ok(Plugin {
        name: m.name,
        version: m.version,
        description: m.description,
        skills: items(m.skills)?,
        design_systems: items(m.design_systems)?,
        connectors: m
            .connectors
            .into_iter()
            .map(|c| PluginConnector {
                name: c.name,
                command: ServerCommand {
                    command: expand(&c.command.command),
                    args: c.command.args.iter().map(|a| expand(a)).collect(),
                    env: c.command.env.iter().map(|(k, v)| (k.clone(), expand(v))).collect(),
                },
            })
            .collect(),
        dir: dir_str,
    })
}

/// Resolve `rel` under `dir`, refusing paths that escape it.
fn inside(dir: &Path, rel: &str) -> AppResult<PathBuf> {
    let path = dir.join(rel).canonicalize()?;
    if !path.starts_with(dir) {
        return Err(AppError::Invalid(format!("{rel} is outside the plugin folder")));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sush-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn walk_reads_text_and_skips_ignored_and_binary_files() {
        let dir = temp_dir("walk");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(dir.join("node_modules/x/index.js"), "nope").unwrap();
        std::fs::write(dir.join("logo.png"), [0x89, 0x50, 0x00, 0x01]).unwrap();
        std::fs::write(dir.join("secret.env"), "KEY=1").unwrap();
        std::fs::write(dir.join(".gitignore"), "*.env\n").unwrap();
        // `ignore` only honours .gitignore inside a git repo unless told otherwise.
        std::fs::create_dir_all(dir.join(".git")).unwrap();

        let folder = walk(&dir).unwrap();
        let paths: Vec<_> = folder.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["src/main.rs"]);
        assert_eq!(folder.skipped, 1); // logo.png
        assert!(!folder.truncated);
    }

    #[test]
    fn plugin_resolves_files_and_plugin_dir() {
        let dir = temp_dir("plugin");
        std::fs::write(dir.join("review.md"), "Review carefully.").unwrap();
        std::fs::write(
            dir.join(MANIFEST),
            r#"{
              "name": "Team kit",
              "skills": [{ "name": "Review", "file": "review.md" }],
              "designSystems": [{ "name": "Brand", "text": "Use teal." }],
              "connectors": [{ "name": "Notes", "command": "node", "args": ["${PLUGIN_DIR}/server.js"] }]
            }"#,
        )
        .unwrap();
        let p = load_plugin(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(p.skills[0].text, "Review carefully.");
        assert_eq!(p.design_systems[0].text, "Use teal.");
        assert!(p.connectors[0].command.args[0].ends_with("server.js"));
        assert!(!p.connectors[0].command.args[0].contains("${PLUGIN_DIR}"));
    }

    #[test]
    fn plugin_files_cannot_escape_the_folder() {
        let dir = temp_dir("escape");
        std::fs::write(dir.join(MANIFEST), r#"{ "name": "x", "skills": [{ "name": "s", "file": "../../etc/hosts" }] }"#).unwrap();
        assert!(load_plugin(dir.to_string_lossy().into_owned()).is_err());
    }
}
