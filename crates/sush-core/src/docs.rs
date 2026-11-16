//! Docs: Notion-style documents the model writes with `doc_write` and the user
//! edits in place. A doc is Markdown (GFM: headings, lists, to-dos, tables,
//! quotes, code, ```mermaid diagrams) with a title and an optional emoji icon,
//! kept in `sush.db` with its versions.
//!
//! Unlike artifacts and decks, which are read back from the conversation's tool
//! calls, a doc lives here, because the user's edits have to outlast the chat
//! and reach the model. The model sees them by reading the doc (`doc_read`);
//! until it has, `doc_write` refuses to overwrite them (`seen_rev`), and
//! `doc_edit` only changes text it can find exactly.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::ui::new_id;
use crate::store::{Store, StoreError, StoreResult};

pub const DOC_WRITE: &str = "doc_write";
pub const DOC_READ: &str = "doc_read";
pub const DOC_EDIT: &str = "doc_edit";

/// Versions kept per doc; the first is always kept, the oldest others go.
pub const MAX_VERSIONS: usize = 60;
/// The user's edits within this long of their last version fold into it.
pub const COALESCE_MS: i64 = 5 * 60 * 1000;
/// Largest doc, in bytes of Markdown.
pub const MAX_CONTENT: usize = 2_000_000;

pub fn is_doc_tool(name: &str) -> bool {
    matches!(name, DOC_WRITE | DOC_READ | DOC_EDIT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Author {
    Sush,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocVersion {
    /// Shown as `v{number}`; never reused, though old versions are dropped.
    pub number: u32,
    pub author: Author,
    /// What it is or changed, e.g. "Created", "Added pricing".
    pub note: String,
    pub title: String,
    pub content: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    /// `<thread id>/<slug>` for one the model wrote, `doc-<random>` for one the user started.
    pub id: String,
    /// The model's name for it, kept across revisions.
    pub slug: String,
    /// The chat it was written in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub content: String,
    /// The date the doc shows under its title (`YYYY-MM-DD`), when the user picked one; else its creation date.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Goes up with every change, the user's included.
    pub rev: u32,
    /// `rev` when the model last wrote or read it; higher means edits it hasn't seen.
    pub seen_rev: u32,
    pub versions: Vec<DocVersion>,
}

impl Doc {
    #[allow(clippy::too_many_arguments)]
    fn new(id: String, slug: String, thread_id: Option<String>, title: String, icon: Option<String>, content: String, author: Author, note: String, now: i64) -> Self {
        let mut doc = Doc {
            id,
            slug,
            thread_id,
            title: String::new(),
            icon,
            content: String::new(),
            date: None,
            created_at: now,
            updated_at: now,
            rev: 0,
            seen_rev: 0,
            versions: Vec::new(),
        };
        doc.commit(author, note, title, content, now);
        if author == Author::Sush {
            doc.seen_rev = doc.rev;
        }
        doc
    }

    /// A blank doc the user started.
    pub fn blank(title: &str, now: i64) -> Self {
        let title = clean_title(title).unwrap_or_else(|| "Untitled".into());
        Doc::new(format!("doc-{}", new_id()), "doc".into(), None, title, None, String::new(), Author::User, "Created".into(), now)
    }

    /// Sets the text and records a new version.
    fn commit(&mut self, author: Author, note: String, title: String, content: String, at: i64) {
        self.rev += 1;
        self.title = title.clone();
        self.content = content.clone();
        self.updated_at = at;
        let number = self.versions.last().map_or(1, |v| v.number + 1);
        self.versions.push(DocVersion { number, author, note, title, content, at });
        if self.versions.len() > MAX_VERSIONS {
            self.versions.remove(1);
        }
    }

    pub fn word_count(&self) -> usize {
        self.content.split_whitespace().filter(|w| w.chars().any(char::is_alphanumeric)).count()
    }
}

/// The id of the doc a thread's model calls `slug`.
pub fn doc_id(thread_id: &str, slug: &str) -> String {
    format!("{thread_id}/{}", clean_slug(slug))
}

/// Lowercase letters, digits and single dashes; "doc" if nothing's left.
pub fn clean_slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').chars().take(64).collect::<String>();
    if out.is_empty() { "doc".into() } else { out }
}

fn clean_title(s: &str) -> Option<String> {
    let t = s.trim().trim_start_matches('#').trim();
    (!t.is_empty()).then(|| t.chars().take(200).collect())
}

fn clean_icon(s: Option<&str>) -> Option<String> {
    let s = s?.trim();
    // An emoji or two; anything longer isn't an icon.
    (!s.is_empty() && s.chars().count() <= 8).then(|| s.to_string())
}

/// The body without a leading `# Title` line repeating the title.
fn strip_title(content: &str, title: &str) -> String {
    let trimmed = content.trim_start();
    if let Some(rest) = trimmed.strip_prefix("# ") {
        let (first, after) = rest.split_once('\n').unwrap_or((rest, ""));
        if first.trim().eq_ignore_ascii_case(title.trim()) {
            return after.trim_start_matches(['\r', '\n']).to_string();
        }
    }
    content.to_string()
}

fn check_size(content: &str) -> Result<(), String> {
    if content.len() > MAX_CONTENT {
        return Err(format!("The doc is too long ({} KB); keep it under {} KB.", content.len() / 1024, MAX_CONTENT / 1024));
    }
    Ok(())
}

const UNSEEN_EDITS: &str =
    "The user has edited this doc since you last saw it. Call doc_read to get its current text, then revise that \
     (with doc_edit for changes to parts of it), so their edits aren't lost.";

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

/// What a tool call did: the doc as saved (None if unchanged) and what the model is told.
pub struct ToolOutcome {
    pub doc: Option<Doc>,
    pub output: String,
}

/// Runs `doc_write`, `doc_read` or `doc_edit` from `thread_id` against `existing`,
/// the doc with the id [`tool_doc_id`] gives.
pub fn apply_tool(name: &str, thread_id: &str, existing: Option<Doc>, input: &Value, now: i64) -> Result<ToolOutcome, String> {
    let slug = str_field(input, "id").map(clean_slug).ok_or_else(|| format!("{name} needs the doc's `id`."))?;
    match name {
        DOC_WRITE => {
            let title = str_field(input, "title").and_then(clean_title).ok_or("doc_write needs a `title`.")?;
            let content = str_field(input, "content").ok_or("doc_write needs the doc's full `content` in Markdown.")?;
            let content = strip_title(content, &title);
            check_size(&content)?;
            let note = str_field(input, "note").map(str::trim).filter(|n| !n.is_empty());
            let icon = clean_icon(str_field(input, "icon"));
            let doc = match existing {
                None => Doc::new(doc_id(thread_id, &slug), slug, Some(thread_id.into()), title, icon, content, Author::Sush, note.unwrap_or("Created").into(), now),
                Some(mut doc) => {
                    if doc.rev != doc.seen_rev {
                        return Err(UNSEEN_EDITS.into());
                    }
                    if icon.is_some() {
                        doc.icon = icon;
                    }
                    doc.commit(Author::Sush, note.unwrap_or("Revised").into(), title, content, now);
                    doc.seen_rev = doc.rev;
                    doc
                }
            };
            let output = format!(
                "Showed \"{}\" ({} words) to the user as a doc they can edit and share (v{}).",
                doc.title,
                doc.word_count(),
                doc.versions.last().map_or(1, |v| v.number)
            );
            Ok(ToolOutcome { doc: Some(doc), output })
        }
        DOC_READ => {
            let mut doc = existing.ok_or_else(|| format!("There's no doc with id `{slug}` in this chat."))?;
            let edited = doc.rev != doc.seen_rev;
            let output = format!(
                "{}# {}\n\n{}",
                if edited { "(The user has edited this doc; this is its current text.)\n\n" } else { "" },
                doc.title,
                doc.content
            );
            doc.seen_rev = doc.rev;
            Ok(ToolOutcome { doc: Some(doc), output })
        }
        DOC_EDIT => {
            let mut doc = existing.ok_or_else(|| format!("There's no doc with id `{slug}` in this chat. Create it with doc_write."))?;
            let edits = input.get("edits").and_then(Value::as_array).ok_or("doc_edit needs `edits`: a list of { find, replace }.")?;
            let title = str_field(input, "title").and_then(clean_title);
            if edits.is_empty() && title.is_none() {
                return Err("doc_edit needs at least one edit.".into());
            }
            let mut content = doc.content.clone();
            for (i, e) in edits.iter().enumerate() {
                let find = str_field(e, "find").filter(|f| !f.is_empty()).ok_or_else(|| format!("Edit {} has no `find` text.", i + 1))?;
                let replace = str_field(e, "replace").unwrap_or("");
                match content.matches(find).count() {
                    1 => content = content.replacen(find, replace, 1),
                    0 => {
                        let hint = if doc.rev != doc.seen_rev { " The user has edited the doc since you last saw it; call doc_read." } else { " Call doc_read to see the current text." };
                        return Err(format!("Edit {}: the `find` text isn't in the doc. No edits were made.{hint}", i + 1));
                    }
                    n => return Err(format!("Edit {}: the `find` text is in the doc {n} times; include more of the surrounding text so it's unique. No edits were made.", i + 1)),
                }
            }
            check_size(&content)?;
            let note = str_field(input, "note").map(str::trim).filter(|n| !n.is_empty()).unwrap_or("Edited").to_string();
            let title = title.unwrap_or_else(|| doc.title.clone());
            if let Some(icon) = clean_icon(str_field(input, "icon")) {
                doc.icon = Some(icon);
            }
            // Edits made on exact text keep the user's other changes, so they count as seen only if they already were.
            let caught_up = doc.rev == doc.seen_rev;
            doc.commit(Author::Sush, note, title, content, now);
            if caught_up {
                doc.seen_rev = doc.rev;
            }
            let n = edits.len();
            let output = format!("Made {n} {} to \"{}\" (v{}).", if n == 1 { "edit" } else { "edits" }, doc.title, doc.versions.last().map_or(1, |v| v.number));
            Ok(ToolOutcome { doc: Some(doc), output })
        }
        _ => Err(format!("Unknown doc tool {name}.")),
    }
}

/// The id of the doc a tool call from `thread_id` is about.
pub fn tool_doc_id(thread_id: &str, input: &Value) -> Option<String> {
    str_field(input, "id").map(|slug| doc_id(thread_id, slug))
}

/// The user's own change, made on `base_rev`. Edits within [`COALESCE_MS`] of
/// their last version fold into it. Returns false if nothing changed.
pub fn user_edit(doc: &mut Doc, base_rev: u32, title: &str, content: &str, icon: Option<&str>, now: i64) -> Result<bool, String> {
    if base_rev != doc.rev {
        return Err("This doc changed while you were editing it. Your view has been updated; make the change again.".into());
    }
    check_size(content)?;
    let title = clean_title(title).unwrap_or_else(|| "Untitled".into());
    let icon = clean_icon(icon);
    if title == doc.title && content == doc.content && icon == doc.icon {
        return Ok(false);
    }
    doc.icon = icon;
    let several = doc.versions.len() > 1;
    match doc.versions.last_mut() {
        Some(last) if last.author == Author::User && now - last.at < COALESCE_MS && several => {
            last.title = title.clone();
            last.content = content.to_string();
            last.at = now;
            doc.rev += 1;
            doc.title = title;
            doc.content = content.to_string();
            doc.updated_at = now;
        }
        _ => doc.commit(Author::User, "Edited".into(), title, content.to_string(), now),
    }
    Ok(true)
}

/// Make version `number` the current text again, as a new version.
pub fn restore(doc: &mut Doc, number: u32, now: i64) -> Result<(), String> {
    let v = doc.versions.iter().find(|v| v.number == number).cloned().ok_or("That version is no longer kept.")?;
    doc.commit(Author::User, format!("Restored v{number}"), v.title, v.content, now);
    Ok(())
}

/// Set (or, with None, clear) the date shown under the title. Metadata only: `rev` stays,
/// so an open editor isn't reloaded and the model isn't told about edits.
pub fn set_date(doc: &mut Doc, date: Option<&str>, now: i64) -> Result<(), String> {
    let date = date.map(str::trim).filter(|d| !d.is_empty());
    if let Some(d) = date {
        let ok = d.len() == 10
            && d.as_bytes()[4] == b'-'
            && d.as_bytes()[7] == b'-'
            && d.split('-').all(|p| p.chars().all(|c| c.is_ascii_digit()))
            && (1..=12).contains(&d[5..7].parse::<u32>().unwrap_or(0))
            && (1..=31).contains(&d[8..10].parse::<u32>().unwrap_or(0));
        if !ok {
            return Err(format!("`{d}` isn't a date like 2026-11-16."));
        }
    }
    doc.date = date.map(str::to_string);
    doc.updated_at = now;
    Ok(())
}

// --- store ------------------------------------------------------------------------------

pub(crate) const MIGRATION: &str = r#"
    -- `data` is the whole `Doc` as JSON, versions included.
    CREATE TABLE docs (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL
    );
    CREATE INDEX docs_thread ON docs (thread_id);
"#;

fn save_in(conn: &rusqlite::Connection, doc: &Doc) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO docs (id, thread_id, updated_at, data) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (id) DO UPDATE SET thread_id = ?2, updated_at = ?3, data = ?4",
        params![doc.id, doc.thread_id, doc.updated_at, serde_json::to_string(doc)?],
    )?;
    Ok(())
}

fn get_in(conn: &rusqlite::Connection, id: &str) -> StoreResult<Option<Doc>> {
    let data: Option<String> = conn.query_row("SELECT data FROM docs WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
}

impl Store {
    /// Every doc, most recently changed first.
    pub fn docs(&self) -> StoreResult<Vec<Doc>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT data FROM docs ORDER BY updated_at DESC, id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|d| Ok(serde_json::from_str(&d?)?)).collect()
    }

    pub fn doc(&self, id: &str) -> StoreResult<Option<Doc>> {
        get_in(&self.conn.lock().unwrap(), id)
    }

    pub fn save_doc(&self, doc: &Doc) -> StoreResult<()> {
        save_in(&self.conn.lock().unwrap(), doc)
    }

    /// Change a doc (or make one, from None) under the lock, so the model's
    /// writes and the user's edits can't cross. Nothing is written if `change`
    /// fails or leaves None.
    pub fn update_doc<T>(&self, id: &str, change: impl FnOnce(Option<Doc>) -> Result<(Option<Doc>, T), String>) -> StoreResult<(Option<Doc>, T)> {
        let conn = self.conn.lock().unwrap();
        let existing = get_in(&conn, id)?;
        let (doc, out) = change(existing).map_err(StoreError::Invalid)?;
        if let Some(doc) = &doc {
            save_in(&conn, doc)?;
        }
        Ok((doc, out))
    }

    pub fn delete_doc(&self, id: &str) -> StoreResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM docs WHERE id = ?1", [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(existing: Option<Doc>, input: Value) -> Result<Doc, String> {
        apply_tool(DOC_WRITE, "t1", existing, &input, 1_000).map(|o| o.doc.unwrap())
    }

    #[test]
    fn slugs_are_cleaned() {
        assert_eq!(clean_slug("  Sell Sush!  Plan "), "sell-sush-plan");
        assert_eq!(clean_slug("???"), "doc");
        assert_eq!(doc_id("t1", "Go To Market"), "t1/go-to-market");
    }

    #[test]
    fn write_creates_then_revises() {
        let doc = write(None, json!({ "id": "plan", "title": "Plan", "content": "# Plan\n\nHello world" })).unwrap();
        assert_eq!(doc.id, "t1/plan");
        // The repeated title heading is dropped.
        assert_eq!(doc.content, "Hello world");
        assert_eq!(doc.versions.len(), 1);
        assert_eq!(doc.rev, doc.seen_rev);
        let doc = write(Some(doc), json!({ "id": "plan", "title": "Plan", "content": "Hi", "note": "Shorter" })).unwrap();
        assert_eq!(doc.versions.len(), 2);
        assert_eq!(doc.versions[1].note, "Shorter");
        assert_eq!(doc.versions[1].number, 2);
    }

    #[test]
    fn write_refuses_to_overwrite_unseen_edits_until_read() {
        let mut doc = write(None, json!({ "id": "plan", "title": "Plan", "content": "One" })).unwrap();
        let rev = doc.rev;
        assert!(user_edit(&mut doc, rev, "Plan", "One, and mine", None, 2_000).unwrap());
        let err = write(Some(doc.clone()), json!({ "id": "plan", "title": "Plan", "content": "Two" })).unwrap_err();
        assert!(err.contains("doc_read"));
        let read = apply_tool(DOC_READ, "t1", Some(doc), &json!({ "id": "plan" }), 3_000).unwrap();
        assert!(read.output.contains("One, and mine"));
        assert!(read.output.contains("has edited"));
        assert!(write(read.doc, json!({ "id": "plan", "title": "Plan", "content": "Two" })).is_ok());
    }

    #[test]
    fn edits_need_unique_text_and_apply_all_or_none() {
        let doc = write(None, json!({ "id": "d", "title": "D", "content": "alpha beta beta gamma" })).unwrap();
        let edit = |doc: &Doc, edits: Value| apply_tool(DOC_EDIT, "t1", Some(doc.clone()), &json!({ "id": "d", "edits": edits }), 2_000);
        assert!(edit(&doc, json!([{ "find": "beta", "replace": "b" }])).unwrap_err().contains("2 times"));
        assert!(edit(&doc, json!([{ "find": "alpha", "replace": "a" }, { "find": "zeta", "replace": "z" }])).unwrap_err().contains("No edits"));
        let done = edit(&doc, json!([{ "find": "alpha", "replace": "a" }, { "find": "gamma", "replace": "g" }])).unwrap().doc.unwrap();
        assert_eq!(done.content, "a beta beta g");
        assert_eq!(done.versions.len(), 2);
    }

    #[test]
    fn user_edits_fold_into_their_last_version() {
        let mut doc = write(None, json!({ "id": "d", "title": "D", "content": "x" })).unwrap();
        let r = doc.rev;
        user_edit(&mut doc, r, "D", "xy", None, 10_000).unwrap();
        let r = doc.rev;
        user_edit(&mut doc, r, "D", "xyz", None, 20_000).unwrap();
        assert_eq!(doc.versions.len(), 2);
        assert_eq!(doc.versions[1].content, "xyz");
        let r = doc.rev;
        user_edit(&mut doc, r, "D", "xyz!", None, 20_000 + COALESCE_MS).unwrap();
        assert_eq!(doc.versions.len(), 3);
        // A stale base is refused, and an unchanged save does nothing.
        assert!(user_edit(&mut doc, r, "D", "nope", None, 1).is_err());
        let r = doc.rev;
        assert!(!user_edit(&mut doc, r, "D", "xyz!", None, 1).unwrap());
    }

    #[test]
    fn restore_adds_a_version_and_old_versions_are_capped() {
        let mut doc = write(None, json!({ "id": "d", "title": "D", "content": "first" })).unwrap();
        for i in 0..MAX_VERSIONS + 5 {
            doc = write(Some(doc), json!({ "id": "d", "title": "D", "content": format!("v{i}") })).unwrap();
        }
        assert_eq!(doc.versions.len(), MAX_VERSIONS);
        assert_eq!(doc.versions[0].content, "first");
        restore(&mut doc, 1, 5).unwrap();
        assert_eq!(doc.content, "first");
        assert_eq!(doc.versions.last().unwrap().note, "Restored v1");
    }

    #[test]
    fn dates_are_checked_and_leave_the_rev() {
        let mut doc = write(None, json!({ "id": "d", "title": "D", "content": "x" })).unwrap();
        let rev = doc.rev;
        set_date(&mut doc, Some("2026-12-01"), 5).unwrap();
        assert_eq!(doc.date.as_deref(), Some("2026-12-01"));
        assert_eq!(doc.rev, rev);
        assert!(set_date(&mut doc, Some("01/12/2026"), 5).is_err());
        assert!(set_date(&mut doc, Some("2026-13-01"), 5).is_err());
        set_date(&mut doc, None, 6).unwrap();
        assert_eq!(doc.date, None);
    }

    #[test]
    fn docs_are_stored() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let (doc, _) = store
            .update_doc("t1/d", |existing| {
                let out = apply_tool(DOC_WRITE, "t1", existing, &json!({ "id": "d", "title": "D", "content": "hi" }), 1)?;
                Ok((out.doc, out.output))
            })
            .unwrap();
        assert_eq!(store.docs().unwrap(), vec![doc.unwrap()]);
        // A failed change writes nothing.
        assert!(store.update_doc::<()>("t1/e", |_| Err("no".into())).is_err());
        assert_eq!(store.docs().unwrap().len(), 1);
        store.delete_doc("t1/d").unwrap();
        assert!(store.doc("t1/d").unwrap().is_none());
    }
}
