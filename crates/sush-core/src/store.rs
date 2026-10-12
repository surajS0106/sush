//! Local persistence: conversations in SQLite, attachments as content-addressed
//! files next to it. Nothing leaves the machine.
//!
//! Messages are stored as the UI's JSON, one row each, so the UI's message
//! shape can evolve without migrations here. A full-text index over each
//! conversation's text backs past-chat search.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::message::{ChatRequest, Part};
use crate::workspace::{Access, EditApproval, Workspace};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
}

pub type StoreResult<T> = Result<T, StoreError>;

/// A conversation without its messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMeta {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// The model it was last used with, as the UI stores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Value>,
    #[serde(default)]
    pub pinned: bool,
    /// Set for Cowork sessions: the workspace they work in. Fixed once created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// The project it's filed under, if any. Projects themselves are the UI's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Never stored: an incognito chat lives only in memory until it's closed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub incognito: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    #[serde(flatten)]
    pub meta: ThreadMeta,
    /// UI messages, opaque to the store apart from their text and file parts.
    #[serde(default)]
    pub messages: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHit {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub snippet: String,
}

/// Each entry upgrades the schema by one version (`PRAGMA user_version`).
const MIGRATIONS: &[&str] = &[r#"
    CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        target TEXT,
        pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (thread_id, seq)
    );
    CREATE TABLE blobs (
        sha TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE chats_fts USING fts5(thread_id UNINDEXED, title, body);
"#, r#"
    ALTER TABLE threads ADD COLUMN workspace_id TEXT;
    CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root TEXT NOT NULL,
        access TEXT NOT NULL,
        approval TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    -- A file's content before a turn first changed it (sha NULL: it didn't exist).
    CREATE TABLE checkpoints (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        sha TEXT,
        UNIQUE (thread_id, turn_id, path)
    );
"#, r#"
    ALTER TABLE threads ADD COLUMN project_id TEXT;
"#];

pub struct Store {
    conn: Mutex<Connection>,
    blob_dir: PathBuf,
}

impl Store {
    /// Open (or create) `sush.db` and `blobs/` in `dir`.
    pub fn open(dir: &Path) -> StoreResult<Self> {
        let blob_dir = dir.join("blobs");
        std::fs::create_dir_all(&blob_dir)?;
        let conn = Connection::open(dir.join("sush.db"))?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
        migrate(&conn)?;
        Ok(Self { conn: Mutex::new(conn), blob_dir })
    }

    /// Every conversation with its messages, newest first.
    pub fn threads(&self) -> StoreResult<Vec<Thread>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, updated_at, target, pinned, workspace_id, project_id FROM threads ORDER BY created_at DESC",
        )?;
        let metas = stmt
            .query_map([], |r| {
                let target: Option<String> = r.get(4)?;
                Ok(ThreadMeta {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    created_at: r.get(2)?,
                    updated_at: r.get(3)?,
                    target: target.and_then(|t| serde_json::from_str(&t).ok()),
                    pinned: r.get(5)?,
                    workspace_id: r.get(6)?,
                    project_id: r.get(7)?,
                    incognito: false,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut msgs = conn.prepare("SELECT data FROM messages WHERE thread_id = ?1 ORDER BY seq")?;
        metas
            .into_iter()
            .map(|meta| {
                let messages = msgs
                    .query_map([&meta.id], |r| r.get::<_, String>(0))?
                    .map(|data| Ok(serde_json::from_str(&data?)?))
                    .collect::<StoreResult<Vec<Value>>>()?;
                Ok(Thread { meta, messages })
            })
            .collect()
    }

    /// Create or update a conversation. `messages: None` updates only its metadata.
    /// Inline images and PDFs in the messages are moved to blob files first.
    /// Incognito threads are never written.
    pub fn save_thread(&self, meta: &ThreadMeta, messages: Option<Vec<Value>>) -> StoreResult<()> {
        if meta.incognito {
            return Ok(());
        }
        let messages = messages.map(|ms| self.extract_files(ms)).transpose()?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        upsert_meta(&tx, meta)?;
        match messages {
            Some(messages) => {
                tx.execute("DELETE FROM messages WHERE thread_id = ?1", [&meta.id])?;
                for (seq, m) in messages.iter().enumerate() {
                    tx.execute(
                        "INSERT INTO messages (thread_id, seq, data) VALUES (?1, ?2, ?3)",
                        params![meta.id, seq as i64, serde_json::to_string(m)?],
                    )?;
                }
                index(&tx, meta, &messages)?;
            }
            None => {
                tx.execute("UPDATE chats_fts SET title = ?2 WHERE thread_id = ?1", params![meta.id, meta.title])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// One conversation's messages; empty if it isn't stored yet.
    pub fn messages(&self, id: &str) -> StoreResult<Vec<Value>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT data FROM messages WHERE thread_id = ?1 ORDER BY seq")?;
        let rows = stmt.query_map([id], |r| r.get::<_, String>(0))?;
        rows.map(|data| Ok(serde_json::from_str(&data?)?)).collect()
    }

    /// The workspace a saved thread was created in, if it's a Cowork session.
    pub fn thread_workspace(&self, id: &str) -> StoreResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let found: Option<Option<String>> =
            conn.query_row("SELECT workspace_id FROM threads WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        Ok(found.flatten())
    }

    pub fn delete_thread(&self, id: &str) -> StoreResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM threads WHERE id = ?1", [id])?;
        tx.execute("DELETE FROM chats_fts WHERE thread_id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Add conversations that aren't stored yet (e.g. from the old localStorage
    /// format). Returns how many were added.
    pub fn import(&self, threads: Vec<Thread>) -> StoreResult<usize> {
        let mut added = 0;
        for t in threads {
            let exists = {
                let conn = self.conn.lock().unwrap();
                conn.query_row("SELECT 1 FROM threads WHERE id = ?1", [&t.meta.id], |_| Ok(()))
                    .optional()?
                    .is_some()
            };
            if !exists {
                self.save_thread(&t.meta, Some(t.messages))?;
                added += 1;
            }
        }
        Ok(added)
    }

    /// Past conversations matching every word of `query`, best first.
    pub fn search(&self, query: &str, limit: usize) -> StoreResult<Vec<ChatHit>> {
        let Some(fts) = fts_query(query) else { return Ok(Vec::new()) };
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT t.id, t.title, t.updated_at, snippet(chats_fts, 2, '', '', '…', 40)
             FROM chats_fts JOIN threads t ON t.id = chats_fts.thread_id
             WHERE chats_fts MATCH ?1
             ORDER BY bm25(chats_fts, 0.0, 5.0, 1.0), t.updated_at DESC
             LIMIT ?2",
        )?;
        let hits = stmt
            .query_map(params![fts, limit as i64], |r| {
                let snippet: String = r.get(3)?;
                Ok(ChatHit {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    updated_at: r.get(2)?,
                    snippet: snippet.split_whitespace().collect::<Vec<_>>().join(" "),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(hits)
    }

    /// Store bytes as a blob and return its URL.
    pub fn put_blob(&self, media_type: &str, bytes: &[u8]) -> StoreResult<String> {
        let sha = hex(&Sha256::digest(bytes));
        let path = self.blob_dir.join(&sha);
        if !path.exists() {
            // Write then rename, so a crash never leaves a truncated blob under its final name.
            let tmp = self.blob_dir.join(format!("{sha}.tmp"));
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(&tmp, &path)?;
        }
        self.conn.lock().unwrap().execute(
            "INSERT OR IGNORE INTO blobs (sha, media_type, size) VALUES (?1, ?2, ?3)",
            params![sha, media_type, bytes.len() as i64],
        )?;
        Ok(blob_url(&sha))
    }

    /// Store a `data:` URL as a blob and return its URL.
    pub fn put_data_url(&self, url: &str) -> StoreResult<String> {
        let (media_type, bytes) = decode_data_url(url).ok_or_else(|| StoreError::Invalid("Not a base64 data URL.".into()))?;
        self.put_blob(&media_type, &bytes)
    }

    /// A blob's media type and bytes, by hash.
    pub fn blob(&self, sha: &str) -> StoreResult<Option<(String, Vec<u8>)>> {
        if !is_sha(sha) {
            return Ok(None);
        }
        let media_type: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT media_type FROM blobs WHERE sha = ?1", [sha], |r| r.get(0))
            .optional()?;
        let Some(media_type) = media_type else { return Ok(None) };
        match std::fs::read(self.blob_dir.join(sha)) {
            Ok(bytes) => Ok(Some((media_type, bytes))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Replace blob URLs in image and document parts with their base64 data,
    /// as providers expect.
    pub fn resolve_blobs(&self, request: &mut ChatRequest) -> StoreResult<()> {
        for message in &mut request.messages {
            for part in &mut message.parts {
                let (Part::Image { data, .. } | Part::Document { data, .. }) = part else { continue };
                let Some(sha) = blob_sha(data) else { continue };
                let (_, bytes) = self
                    .blob(sha)?
                    .ok_or_else(|| StoreError::Invalid("An attachment in this chat is missing from disk.".into()))?;
                *data = base64::engine::general_purpose::STANDARD.encode(bytes);
            }
        }
        Ok(())
    }

    /// Move inline images and PDFs (`data:` URLs in file parts) to blob files.
    fn extract_files(&self, mut messages: Vec<Value>) -> StoreResult<Vec<Value>> {
        for m in &mut messages {
            let Some(parts) = m.get_mut("parts").and_then(Value::as_array_mut) else { continue };
            for p in parts {
                if p.get("type").and_then(Value::as_str) != Some("file") {
                    continue;
                }
                let media_type = p.get("mediaType").and_then(Value::as_str).unwrap_or_default();
                if !extracted(media_type) {
                    continue;
                }
                let Some(url) = p.get("url").and_then(Value::as_str).filter(|u| u.starts_with("data:")) else { continue };
                let blob = self.put_data_url(url)?;
                p["url"] = Value::String(blob);
            }
        }
        Ok(messages)
    }
}

/// Files a turn changed, for "Undo".
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnChanges {
    /// The user message that started the turn.
    pub turn_id: String,
    pub paths: Vec<String>,
}

/// A file a turn changed: its content before the turn (`None`: it didn't
/// exist) and, when a later turn changed it again, before that turn
/// (`Some(None)`: it didn't exist then). `later: None` means the file on disk
/// is still the turn's result.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnFile {
    pub workspace_id: String,
    pub path: String,
    pub before: Option<Vec<u8>>,
    pub later: Option<Option<Vec<u8>>>,
}

/// A file's content before the changes being undone; `original: None` means it didn't exist.
#[derive(Debug, Clone, PartialEq)]
pub struct Original {
    pub workspace_id: String,
    pub path: String,
    pub original: Option<Vec<u8>>,
}

impl Store {
    pub fn workspaces(&self) -> StoreResult<Vec<Workspace>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, root, access, approval, created_at FROM workspaces ORDER BY created_at")?;
        let rows = stmt.query_map([], workspace_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn workspace(&self, id: &str) -> StoreResult<Option<Workspace>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT id, name, root, access, approval, created_at FROM workspaces WHERE id = ?1", [id], workspace_row)
            .optional()?)
    }

    pub fn save_workspace(&self, w: &Workspace) -> StoreResult<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO workspaces (id, name, root, access, approval, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (id) DO UPDATE SET name = ?2, access = ?4, approval = ?5",
            params![w.id, w.name, w.root, w.access.as_str(), w.approval.as_str(), w.created_at],
        )?;
        Ok(())
    }

    /// Forget a workspace. Its sessions stay, without file access.
    pub fn delete_workspace(&self, id: &str) -> StoreResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM workspaces WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Remember a file's content before a turn's first change to it; later
    /// changes in the same turn keep the first one.
    pub fn add_checkpoint(
        &self,
        thread_id: &str,
        turn_id: &str,
        workspace_id: &str,
        path: &str,
        original: Option<&[u8]>,
    ) -> StoreResult<()> {
        let exists = self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT 1 FROM checkpoints WHERE thread_id = ?1 AND turn_id = ?2 AND path = ?3",
                params![thread_id, turn_id, path],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            return Ok(());
        }
        let sha = match original {
            Some(bytes) => {
                let url = self.put_blob("application/octet-stream", bytes)?;
                Some(blob_sha(&url).unwrap_or_default().to_string())
            }
            None => None,
        };
        self.conn.lock().unwrap().execute(
            "INSERT OR IGNORE INTO checkpoints (thread_id, turn_id, workspace_id, path, sha) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![thread_id, turn_id, workspace_id, path, sha],
        )?;
        Ok(())
    }

    /// Each turn of a thread that changed files, oldest first.
    pub fn turn_changes(&self, thread_id: &str) -> StoreResult<Vec<TurnChanges>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT turn_id, path FROM checkpoints WHERE thread_id = ?1 ORDER BY seq")?;
        let rows = stmt.query_map([thread_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut turns: Vec<TurnChanges> = Vec::new();
        for row in rows {
            let (turn_id, path) = row?;
            match turns.iter_mut().find(|t| t.turn_id == turn_id) {
                Some(t) => t.paths.push(path),
                None => turns.push(TurnChanges { turn_id, paths: vec![path] }),
            }
        }
        Ok(turns)
    }

    /// What every file changed since `turn_id` began looked like before it,
    /// and forget those checkpoints. Restoring them undoes that turn and the
    /// ones after it. With `only`, just that file is taken.
    pub fn take_originals_since(&self, thread_id: &str, turn_id: &str, only: Option<&str>) -> StoreResult<Vec<Original>> {
        let rows: Vec<(i64, String, String, Option<String>)> = {
            let conn = self.conn.lock().unwrap();
            let first: Option<i64> = conn.query_row(
                "SELECT MIN(seq) FROM checkpoints WHERE thread_id = ?1 AND turn_id = ?2 AND (?3 IS NULL OR path = ?3)",
                params![thread_id, turn_id, only],
                |r| r.get(0),
            )?;
            let Some(first) = first else { return Ok(Vec::new()) };
            let mut stmt = conn.prepare(
                "SELECT seq, workspace_id, path, sha FROM checkpoints
                 WHERE thread_id = ?1 AND seq >= ?2 AND (?3 IS NULL OR path = ?3) ORDER BY seq",
            )?;
            let rows =
                stmt.query_map(params![thread_id, first, only], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut out: Vec<Original> = Vec::new();
        for (_, workspace_id, path, sha) in &rows {
            // The earliest checkpoint for a path is its state before all of these turns.
            if out.iter().any(|o| &o.path == path) {
                continue;
            }
            out.push(Original { workspace_id: workspace_id.clone(), path: path.clone(), original: self.checkpoint_bytes(path, sha)? });
        }
        if let Some((first, ..)) = rows.first() {
            self.conn.lock().unwrap().execute(
                "DELETE FROM checkpoints WHERE thread_id = ?1 AND seq >= ?2 AND (?3 IS NULL OR path = ?3)",
                params![thread_id, first, only],
            )?;
        }
        Ok(out)
    }

    /// Each file a turn changed, as it was before the turn and, if a later
    /// turn changed it again, as it was before that one. Nothing is forgotten.
    pub fn turn_files(&self, thread_id: &str, turn_id: &str) -> StoreResult<Vec<TurnFile>> {
        let rows: Vec<(String, String, Option<String>, Option<Option<String>>)> = {
            let conn = self.conn.lock().unwrap();
            let later = "FROM checkpoints n WHERE n.thread_id = c.thread_id AND n.path = c.path AND n.seq > c.seq ORDER BY n.seq LIMIT 1";
            let mut stmt = conn.prepare(&format!(
                "SELECT c.workspace_id, c.path, c.sha, (SELECT n.seq {later}), (SELECT n.sha {later})
                 FROM checkpoints c WHERE c.thread_id = ?1 AND c.turn_id = ?2 ORDER BY c.seq"
            ))?;
            let rows = stmt.query_map(params![thread_id, turn_id], |r| {
                // The later checkpoint's seq tells "no later turn" apart from "later turn: the file didn't exist".
                let next_seq: Option<i64> = r.get(3)?;
                let next_sha: Option<String> = r.get(4)?;
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, next_seq.map(|_| next_sha)))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        rows.into_iter()
            .map(|(workspace_id, path, sha, next)| {
                let before = self.checkpoint_bytes(&path, &sha)?;
                let later = match next {
                    Some(sha) => Some(self.checkpoint_bytes(&path, &sha)?),
                    None => None,
                };
                Ok(TurnFile { workspace_id, path, before, later })
            })
            .collect()
    }

    fn checkpoint_bytes(&self, path: &str, sha: &Option<String>) -> StoreResult<Option<Vec<u8>>> {
        match sha {
            Some(sha) => Ok(Some(
                self.blob(sha)?.ok_or_else(|| StoreError::Invalid(format!("The saved copy of {path} is missing.")))?.1,
            )),
            None => Ok(None),
        }
    }
}

fn workspace_row(r: &rusqlite::Row) -> rusqlite::Result<Workspace> {
    let access: String = r.get(3)?;
    let approval: String = r.get(4)?;
    Ok(Workspace {
        id: r.get(0)?,
        name: r.get(1)?,
        root: r.get(2)?,
        access: Access::parse(&access).unwrap_or(Access::ReadOnly),
        approval: EditApproval::parse(&approval).unwrap_or(EditApproval::Ask),
        created_at: r.get(5)?,
    })
}

fn migrate(conn: &Connection) -> StoreResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", i + 1))?;
    }
    Ok(())
}

fn upsert_meta(conn: &Connection, m: &ThreadMeta) -> StoreResult<()> {
    let target = m.target.as_ref().map(serde_json::to_string).transpose()?;
    conn.execute(
        "INSERT INTO threads (id, title, created_at, updated_at, target, pinned, workspace_id, project_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET title = ?2, updated_at = ?4, target = ?5, pinned = ?6,
             workspace_id = COALESCE(threads.workspace_id, ?7), project_id = ?8",
        params![m.id, m.title, m.created_at, m.updated_at, target, m.pinned, m.workspace_id, m.project_id],
    )?;
    Ok(())
}

fn index(conn: &Connection, meta: &ThreadMeta, messages: &[Value]) -> StoreResult<()> {
    conn.execute("DELETE FROM chats_fts WHERE thread_id = ?1", [&meta.id])?;
    let body = transcript(messages);
    if !body.is_empty() {
        conn.execute(
            "INSERT INTO chats_fts (thread_id, title, body) VALUES (?1, ?2, ?3)",
            params![meta.id, meta.title, body],
        )?;
    }
    Ok(())
}

/// The text of a conversation: `ROLE:` then its text parts, per message.
pub fn transcript(messages: &[Value]) -> String {
    messages
        .iter()
        .filter_map(|m| {
            let role = m.get("role")?.as_str()?.to_uppercase();
            let text = m
                .get("parts")?
                .as_array()?
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then(|| format!("{role}:\n{text}"))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Every word must match, as a prefix; FTS syntax in the query is treated as text.
fn fts_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.replace('"', ""))
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

/// Attachments kept as blobs. Text files stay inline because the UI reads them when building requests.
fn extracted(media_type: &str) -> bool {
    media_type.starts_with("image/") || media_type == "application/pdf"
}

/// URI scheme the desktop app serves blobs on.
pub const BLOB_SCHEME: &str = "sushblob";

/// A blob's URL as the webview loads it. Windows webviews only allow custom
/// schemes as `http://<scheme>.localhost`.
pub fn blob_url(sha: &str) -> String {
    if cfg!(windows) {
        format!("http://{BLOB_SCHEME}.localhost/{sha}")
    } else {
        format!("{BLOB_SCHEME}://localhost/{sha}")
    }
}

/// The hash in a blob URL of either form.
pub fn blob_sha(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("http://sushblob.localhost/")
        .or_else(|| url.strip_prefix("sushblob://localhost/"))?;
    is_sha(rest).then_some(rest)
}

fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_data_url(url: &str) -> Option<(String, Vec<u8>)> {
    let rest = url.strip_prefix("data:")?;
    let (head, data) = rest.split_once(',')?;
    let media_type = head.strip_suffix(";base64")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    Some((media_type.to_string(), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{Message, Role};
    use serde_json::json;

    fn meta(id: &str, title: &str, created_at: i64) -> ThreadMeta {
        ThreadMeta {
            id: id.into(),
            title: title.into(),
            created_at,
            updated_at: created_at,
            target: None,
            pinned: false,
            workspace_id: None,
            project_id: None,
            incognito: false,
        }
    }

    fn text(role: &str, t: &str) -> Value {
        json!({ "id": format!("m-{t}"), "role": role, "parts": [{ "type": "text", "text": t }] })
    }

    #[test]
    fn saves_and_loads_threads_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let mut a = meta("a", "First", 1);
        a.target = Some(json!({ "providerId": "p", "model": "m" }));
        store.save_thread(&a, Some(vec![text("user", "hello")])).unwrap();
        store.save_thread(&meta("b", "Second", 2), Some(vec![])).unwrap();

        // Reopening reads what was written.
        let store = Store::open(dir.path()).unwrap();
        let threads = store.threads().unwrap();
        assert_eq!(threads.iter().map(|t| t.meta.id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(threads[1].meta, a);
        assert_eq!(threads[1].messages, vec![text("user", "hello")]);
    }

    #[test]
    fn metadata_only_save_keeps_messages() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.save_thread(&meta("a", "Chat", 1), Some(vec![text("user", "keep me")])).unwrap();
        let mut pinned = meta("a", "Renamed", 1);
        pinned.pinned = true;
        store.save_thread(&pinned, None).unwrap();

        let t = &store.threads().unwrap()[0];
        assert!(t.meta.pinned);
        assert_eq!(t.messages.len(), 1);
        assert_eq!(store.search("renamed", 8).unwrap().len(), 1);
    }

    #[test]
    fn project_can_change_and_incognito_threads_are_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let mut a = meta("a", "Chat", 1);
        a.project_id = Some("p1".into());
        store.save_thread(&a, Some(vec![text("user", "hi")])).unwrap();
        a.project_id = None;
        store.save_thread(&a, None).unwrap();
        assert_eq!(store.threads().unwrap()[0].meta.project_id, None);

        let mut secret = meta("s", "Secret", 2);
        secret.incognito = true;
        store.save_thread(&secret, Some(vec![text("user", "whisper")])).unwrap();
        assert_eq!(store.threads().unwrap().len(), 1);
        assert!(store.search("whisper", 8).unwrap().is_empty());
    }

    #[test]
    fn search_matches_every_word_and_ranks_titles_higher() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store
            .save_thread(&meta("body", "Cloud notes", 1), Some(vec![text("user", "what is terraform state locking")]))
            .unwrap();
        store
            .save_thread(&meta("title", "Terraform basics", 2), Some(vec![text("assistant", "state files and terraform modules")]))
            .unwrap();
        store.save_thread(&meta("other", "Python", 3), Some(vec![text("user", "write python code")])).unwrap();

        let hits = store.search("terraform state", 8).unwrap();
        assert_eq!(hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), ["title", "body"]);
        // Prefixes match, and quotes or FTS operators in the query are just text.
        assert_eq!(store.search("terra", 8).unwrap().len(), 2);
        assert!(store.search("\"python\" OR", 8).unwrap().is_empty());
        assert!(store.search("   ", 8).unwrap().is_empty());
    }

    #[test]
    fn delete_removes_messages_and_index() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.save_thread(&meta("a", "Gone", 1), Some(vec![text("user", "secret")])).unwrap();
        store.delete_thread("a").unwrap();
        assert!(store.threads().unwrap().is_empty());
        assert!(store.search("secret", 8).unwrap().is_empty());
    }

    #[test]
    fn inline_images_become_blobs_and_resolve_for_requests() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let png = base64::engine::general_purpose::STANDARD.encode(b"fake png bytes");
        let message = json!({ "id": "m", "role": "user", "parts": [
            { "type": "file", "mediaType": "image/png", "url": format!("data:image/png;base64,{png}") },
            { "type": "file", "mediaType": "text/plain", "url": "data:text/plain;base64,aGk=" },
        ]});
        store.save_thread(&meta("a", "Pic", 1), Some(vec![message])).unwrap();

        let saved = &store.threads().unwrap()[0].messages[0]["parts"];
        let url = saved[0]["url"].as_str().unwrap();
        let sha = blob_sha(url).expect("image moved to a blob");
        assert_eq!(store.blob(sha).unwrap(), Some(("image/png".into(), b"fake png bytes".to_vec())));
        // Text attachments stay inline.
        assert_eq!(saved[1]["url"], "data:text/plain;base64,aGk=");

        let mut request: ChatRequest = serde_json::from_value(json!({ "model": "m", "messages": [] })).unwrap();
        request.messages.push(Message {
            role: Role::User,
            parts: vec![Part::Image { media_type: "image/png".into(), data: url.into() }],
        });
        store.resolve_blobs(&mut request).unwrap();
        assert_eq!(request.messages[0].parts[0], Part::Image { media_type: "image/png".into(), data: png });
    }

    #[test]
    fn blob_lookup_rejects_anything_but_a_hash() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(store.blob("../sush.db").unwrap(), None);
        assert_eq!(blob_sha("http://sushblob.localhost/../../etc/passwd"), None);
    }

    #[test]
    fn checkpoints_keep_the_earliest_original_per_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.add_checkpoint("t", "turn1", "w", "a.txt", Some(b"v1")).unwrap();
        store.add_checkpoint("t", "turn1", "w", "a.txt", Some(b"v1 edited")).unwrap(); // same turn: ignored
        store.add_checkpoint("t", "turn2", "w", "a.txt", Some(b"v2")).unwrap();
        store.add_checkpoint("t", "turn2", "w", "new.txt", None).unwrap();
        store.add_checkpoint("other", "turn1", "w", "a.txt", Some(b"x")).unwrap();

        let turns = store.turn_changes("t").unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].paths, ["a.txt", "new.txt"]);

        // Turn 1's a.txt went from v1 to what turn 2 found; turn 2's files are still on disk.
        let files = store.turn_files("t", "turn1").unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].before.as_deref(), files[0].later.clone()), (Some(&b"v1"[..]), Some(Some(b"v2".to_vec()))));
        let files = store.turn_files("t", "turn2").unwrap();
        assert_eq!(files.iter().map(|f| (f.before.clone(), f.later.clone())).collect::<Vec<_>>(), [(Some(b"v2".to_vec()), None), (None, None)]);

        // Undoing turn 2 restores a.txt as it was after turn 1 and removes new.txt.
        let originals = store.take_originals_since("t", "turn2", None).unwrap();
        assert_eq!(
            originals,
            [
                Original { workspace_id: "w".into(), path: "a.txt".into(), original: Some(b"v2".to_vec()) },
                Original { workspace_id: "w".into(), path: "new.txt".into(), original: None },
            ]
        );
        assert_eq!(store.turn_changes("t").unwrap().len(), 1);
        // Undoing turn 1 goes back to before it.
        assert_eq!(store.take_originals_since("t", "turn1", None).unwrap()[0].original, Some(b"v1".to_vec()));
        assert!(store.take_originals_since("t", "turn1", None).unwrap().is_empty());
    }

    #[test]
    fn one_file_can_be_undone_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.add_checkpoint("t", "turn1", "w", "a.txt", Some(b"a")).unwrap();
        store.add_checkpoint("t", "turn1", "w", "b.txt", Some(b"b")).unwrap();
        store.add_checkpoint("t", "turn2", "w", "a.txt", Some(b"a2")).unwrap();

        let originals = store.take_originals_since("t", "turn1", Some("a.txt")).unwrap();
        assert_eq!(originals.len(), 1);
        assert_eq!(originals[0].original, Some(b"a".to_vec()));
        // b.txt can still be undone; a.txt is gone from every turn.
        assert_eq!(store.turn_changes("t").unwrap(), [TurnChanges { turn_id: "turn1".into(), paths: vec!["b.txt".into()] }]);
    }

    #[test]
    fn workspaces_round_trip_and_threads_keep_theirs() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let w = Workspace {
            id: "w".into(),
            name: "proj".into(),
            root: "/tmp/proj".into(),
            access: Access::WorkspaceWrite,
            approval: EditApproval::Ask,
            created_at: 1,
        };
        store.save_workspace(&w).unwrap();
        assert_eq!(store.workspace("w").unwrap(), Some(w));

        let mut t = meta("t", "Cowork", 1);
        t.workspace_id = Some("w".into());
        store.save_thread(&t, Some(vec![])).unwrap();
        // A later save without it doesn't detach the session.
        store.save_thread(&meta("t", "Cowork", 1), None).unwrap();
        assert_eq!(store.threads().unwrap()[0].meta.workspace_id.as_deref(), Some("w"));
    }

    #[test]
    fn import_skips_threads_that_exist() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.save_thread(&meta("a", "Newer", 1), Some(vec![text("user", "current")])).unwrap();
        let added = store
            .import(vec![
                Thread { meta: meta("a", "Stale", 1), messages: vec![text("user", "old")] },
                Thread { meta: meta("b", "Imported", 2), messages: vec![text("user", "from localStorage")] },
            ])
            .unwrap();
        assert_eq!(added, 1);
        let threads = store.threads().unwrap();
        assert_eq!(threads.iter().find(|t| t.meta.id == "a").unwrap().meta.title, "Newer");
    }
}
