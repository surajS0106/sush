//! Notebooks: a set of sources (PDFs, web pages, papers, pasted text) to chat
//! with, answered from those sources and citing the passage each claim rests on.
//! See `docs/notebooks-plan.md`.
//!
//! A source is read once into plain text, page by page, and split into chunks
//! of about `CHUNK_CHARS` that never cross a page. The chunks are indexed in
//! SQLite FTS5, and a notebook thread's `source_search` ranks them by BM25.
//! The passages it returns are citable: each has a `sushsrc:<source>/<chunk>`
//! address. Anthropic gets them as `search_result` blocks and cites them itself
//! (`message::SEARCH_RESULTS`); other models are told to write
//! `[cite](sushsrc:…)` markers. Either way the reply's text carries the same
//! markers, which the UI shows as numbered chips that open the passage.
//!
//! Notebooks, their sources and chunks live in `sush.db`. A notebook's chats
//! are ordinary threads listed in `notebook_threads`.

use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::LazyLock;

use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::message::{Message, Part, Role, SearchResult, ToolSpec, SEARCH_NOTE, SEARCH_RESULTS};
use crate::store::{Store, StoreError, StoreResult};

pub const SOURCE_SEARCH: &str = "source_search";
pub const SOURCE_READ: &str = "source_read";
/// How a quiz, flashcards or mind map run hands over its result (`save_studio`).
pub const STUDIO_SAVE: &str = "studio_save";

/// Every passage's address starts with this: `sushsrc:<source id>/<chunk id>`,
/// with `?q=<the words cited>` once a reply cites it.
pub const SOURCE_SCHEME: &str = "sushsrc:";

/// About how long a chunk is, in characters.
pub const CHUNK_CHARS: usize = 1500;
/// Most text kept from one source. Anything past it isn't indexed.
pub const MAX_SOURCE_CHARS: usize = 4_000_000;
/// Passages one search returns, and most a model may ask for.
const DEFAULT_RESULTS: usize = 8;
const MAX_RESULTS: usize = 15;
/// Most text one `source_read` call returns.
const MAX_READ_CHARS: usize = 14_000;
/// Longest quote kept in a citation's address.
const MAX_QUOTE_CHARS: usize = 300;

pub fn is_notebook_tool(name: &str) -> bool {
    name == SOURCE_SEARCH || name == SOURCE_READ || name == STUDIO_SAVE
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Oldest first.
    #[serde(default)]
    pub sources: Vec<Source>,
    /// Its chats, oldest first.
    #[serde(default)]
    pub thread_ids: Vec<String>,
    /// Notes and Studio outputs, newest first.
    #[serde(default)]
    pub notes: Vec<Note>,
    /// What the user and the overview set: emoji, cover, summary.
    #[serde(flatten)]
    pub extras: NotebookExtras,
}

/// A notebook's look and overview, kept as JSON with it (`notebooks.data`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookExtras {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    /// A cover image's blob URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// How the cover is framed; none shows it centred.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_position: Option<CoverPosition>,
    /// The user's own summary, shown in place of the generated one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_summary: Option<String>,
    /// The generated overview: a summary of the sources and questions to ask.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview: Option<Overview>,
    /// Set once the user names the notebook, so an overview no longer suggests a title.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub named: bool,
}

/// A cover's framing: the point kept in view (percent across and down) and how far it's zoomed in.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CoverPosition {
    pub x: f32,
    pub y: f32,
    pub zoom: f32,
}

impl CoverPosition {
    /// Within range: the point inside the image, zoom from 1 (fills the frame) to 3.
    pub fn clamped(self) -> Self {
        let pct = |v: f32| if v.is_finite() { v.clamp(0.0, 100.0) } else { 50.0 };
        Self { x: pct(self.x), y: pct(self.y), zoom: if self.zoom.is_finite() { self.zoom.clamp(1.0, 3.0) } else { 1.0 } }
    }
}

/// A summary of a notebook's sources, written by a model when they change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// Markdown, key terms in bold.
    pub summary: String,
    #[serde(default)]
    pub questions: Vec<String>,
    /// The sources it was written from (`sources_key`); a different key means it's out of date.
    pub sources_key: String,
    pub generated_at: i64,
}

/// What an overview depends on: every ready source and how it was read. Not
/// just the checked ones: ticking sources on and off for a question shouldn't
/// pay for a new overview each time.
pub fn sources_key(notebook: &Notebook) -> String {
    let mut parts: Vec<String> =
        notebook.sources.iter().filter(|s| s.status == SourceStatus::Ready).map(|s| format!("{}:{}", s.id, s.chunks)).collect();
    parts.sort();
    parts.join(",")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    Pdf,
    Web,
    /// An arXiv or DOI link, read as its PDF or landing page.
    Paper,
    /// Pasted text, or a text or Markdown file.
    Text,
    /// A YouTube video's captions, timestamped.
    Youtube,
    /// An audio file, transcribed when added, timestamped.
    Audio,
    /// A past Sush chat, as a transcript.
    Chat,
    /// A file from a Cowork folder.
    File,
}

impl SourceKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Pdf => "PDF",
            Self::Web => "web page",
            Self::Paper => "paper",
            Self::Text => "text",
            Self::Youtube => "YouTube video",
            Self::Audio => "audio transcript",
            Self::Chat => "past chat",
            Self::File => "file",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceStatus {
    Reading,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub notebook_id: String,
    pub kind: SourceKind,
    pub title: String,
    /// The address it was read from (web pages and papers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The original file's blob (a PDF, or the text as added), for the viewer and re-reading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
    pub status: SourceStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Whether chats search it.
    pub checked: bool,
    /// A PDF's page count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<u32>,
    #[serde(default)]
    pub chars: u64,
    #[serde(default)]
    pub chunks: u32,
    /// Set when the text was cut at `MAX_SOURCE_CHARS`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// A short guide to it, written by a model the first time it's opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guide: Option<SourceGuide>,
    pub added_at: i64,
}

/// A source's summary and key topics, for the viewer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceGuide {
    /// Markdown, key terms in bold.
    pub summary: String,
    #[serde(default)]
    pub topics: Vec<String>,
    /// The source's chunk count when it was written; reading it again changes it.
    pub chunks: u32,
}

impl Source {
    pub fn new(id: String, notebook_id: String, kind: SourceKind, title: String, now: i64) -> Self {
        Self {
            id,
            notebook_id,
            kind,
            title,
            url: None,
            blob: None,
            status: SourceStatus::Reading,
            error: None,
            checked: true,
            pages: None,
            chars: 0,
            chunks: 0,
            truncated: false,
            guide: None,
            added_at: now,
        }
    }
}

// --- reading sources ------------------------------------------------------------------

/// One page of a source's text. `number` is a PDF's page number (from 1).
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub number: Option<u32>,
    pub text: String,
}

/// A source's text, page by page, cut at `MAX_SOURCE_CHARS`. Returns whether it was cut.
pub fn cap_pages(pages: &mut Vec<Page>) -> bool {
    let mut left = MAX_SOURCE_CHARS;
    let mut cut = false;
    pages.retain_mut(|p| {
        if left == 0 {
            cut = true;
            return false;
        }
        let n = p.text.chars().count();
        if n > left {
            p.text = p.text.chars().take(left).collect();
            cut = true;
            left = 0;
        } else {
            left -= n;
        }
        true
    });
    cut
}

/// Why a PDF's text couldn't be extracted.
#[derive(Debug, Clone, PartialEq)]
pub enum PdfProblem {
    /// It opened but has no text layer: scanned pages, to be read by a model (`pdf_batches`).
    Scanned,
    Failed(String),
}

impl std::fmt::Display for PdfProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Scanned => f.write_str("This PDF is scanned images, with no text layer to read."),
            Self::Failed(e) => f.write_str(e),
        }
    }
}

/// A PDF's text, page by page. A PDF with no text at all is `Scanned`.
pub fn pdf_pages(bytes: &[u8]) -> Result<Vec<Page>, PdfProblem> {
    // lopdf can panic on malformed files; a bad PDF mustn't take the app down.
    let doc = load_pdf(bytes).map_err(PdfProblem::Failed)?;
    let numbers: Vec<u32> = doc.get_pages().keys().copied().collect();
    let pages: Vec<Page> = numbers
        .into_iter()
        .map(|n| {
            let text = std::panic::catch_unwind(AssertUnwindSafe(|| doc.extract_text(&[n])))
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
            Page { number: Some(n), text: tidy_pdf_text(&text) }
        })
        .collect();
    if pages.iter().all(|p| p.text.trim().is_empty()) {
        // Many PDFs are encrypted with an empty password and read fine; only a real password stops them.
        return Err(if doc.is_encrypted() {
            PdfProblem::Failed("That PDF is password-protected. Save an unprotected copy and add that.".into())
        } else {
            PdfProblem::Scanned
        });
    }
    Ok(pages)
}

fn load_pdf(bytes: &[u8]) -> Result<lopdf::Document, String> {
    // lopdf can panic on malformed files; a bad PDF mustn't take the app down.
    std::panic::catch_unwind(|| lopdf::Document::load_mem(bytes))
        .map_err(|_| "That PDF couldn't be opened; it may be damaged.".to_string())?
        .map_err(|e| format!("That PDF couldn't be opened: {e}"))
}

/// Pages of a scanned PDF read at once, and most read in all.
pub const SCAN_BATCH: usize = 6;
pub const MAX_SCANNED_PAGES: usize = 300;

/// A scanned PDF split into small PDFs of `SCAN_BATCH` pages for a model to
/// read, each with its pages' numbers. Pages past `MAX_SCANNED_PAGES` are left out.
pub fn pdf_batches(bytes: &[u8]) -> Result<Vec<(Vec<u32>, Vec<u8>)>, String> {
    let doc = load_pdf(bytes)?;
    let all: Vec<u32> = doc.get_pages().keys().copied().collect();
    let kept: Vec<u32> = all.iter().copied().take(MAX_SCANNED_PAGES).collect();
    let mut out = Vec::new();
    for batch in kept.chunks(SCAN_BATCH) {
        let others: Vec<u32> = all.iter().copied().filter(|n| !batch.contains(n)).collect();
        let bytes = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let mut part = doc.clone();
            part.delete_pages(&others);
            part.prune_objects();
            let mut buf = Vec::new();
            part.save_to(&mut buf).map(|_| buf)
        }))
        .map_err(|_| "That PDF couldn't be split into pages.".to_string())?
        .map_err(|e| format!("That PDF couldn't be split into pages: {e}"))?;
        out.push((batch.to_vec(), bytes));
    }
    Ok(out)
}

/// What a model is asked when reading scanned pages.
pub const TRANSCRIBE_PROMPT: &str = "Transcribe the text on each page of this PDF exactly as written, in reading order. \
Wrap each page in <page>...</page>, one per page and in order, even a blank one. Keep headings as Markdown # lines and \
separate paragraphs with a blank line; write tables as Markdown tables. Don't summarise, translate, correct or comment.";

/// A model's transcription of a batch, as pages numbered `numbers` (in order).
/// Without page tags, the whole reply is the batch's first page.
pub fn parse_transcription(text: &str, numbers: &[u32]) -> Vec<Page> {
    static PAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<page\b[^>]*>(.*?)</page>").expect("valid pattern"));
    let found: Vec<String> = PAGE.captures_iter(text).map(|c| c[1].trim().to_owned()).collect();
    if found.is_empty() {
        return numbers.first().map(|&n| vec![Page { number: Some(n), text: text.trim().to_owned() }]).unwrap_or_default();
    }
    numbers.iter().zip(found).map(|(&n, text)| Page { number: Some(n), text }).collect()
}

/// PDF text as extracted: words split across lines with a hyphen joined, runs of spaces collapsed.
fn tidy_pdf_text(text: &str) -> String {
    static HYPHEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\p{L})-\n(\p{Ll})").expect("valid pattern"));
    let text = HYPHEN.replace_all(text, "$1$2");
    text.lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

/// Text as one page, without a byte-order mark or Windows line ends.
pub fn text_pages(text: &str) -> Vec<Page> {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    vec![Page { number: None, text: text.trim().to_owned() }]
}

/// The address to read a paper from, for an arXiv id or link, or a DOI.
/// `None` for anything else (an ordinary web address is read as is).
pub fn paper_url(input: &str) -> Option<String> {
    let input = input.trim();
    let arxiv = Regex::new(r"(?i)^(?:https?://(?:www\.|export\.)?arxiv\.org/(?:abs|pdf|html)/|arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?/\d{7}(?:v\d+)?)(?:\.pdf)?/?$")
        .expect("valid pattern");
    if let Some(c) = arxiv.captures(input) {
        // A bare old-style id like "math/0211159" only counts with the prefix or link.
        let id = &c[1];
        let explicit = input.to_ascii_lowercase().contains("arxiv");
        if explicit || Regex::new(r"^\d{4}\.\d{4,5}(?:v\d+)?$").expect("valid pattern").is_match(input) {
            return Some(format!("https://arxiv.org/pdf/{id}"));
        }
    }
    let doi = Regex::new(r"(?i)^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)?(10\.\d{4,9}/\S+)$").expect("valid pattern");
    doi.captures(input).map(|c| format!("https://doi.org/{}", &c[1]))
}

/// A YouTube video's id, from any of its link forms (or the bare id after `youtube:`).
pub fn youtube_id(input: &str) -> Option<String> {
    static ID: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)^(?:https?://)?(?:(?:www\.|m\.|music\.)?youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/|embed/|v/)|youtu\.be/)([A-Za-z0-9_-]{11})(?:[?&#/].*)?$",
        )
        .expect("valid pattern")
    });
    ID.captures(input.trim()).map(|c| c[1].to_owned())
}

/// "1:02:03" or "4:05".
pub fn timestamp(ms: u64) -> String {
    let s = ms / 1000;
    let (h, m, s) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// Seconds of speech a timestamped paragraph holds.
const PARAGRAPH_MS: u64 = 45_000;

/// Timed lines (start in ms, text) as one page of paragraphs about
/// `PARAGRAPH_MS` long, each starting `[m:ss]`, so passages say where they are.
pub fn timed_pages(lines: &[(u64, String)]) -> Vec<Page> {
    let mut out = String::new();
    let mut start: Option<u64> = None;
    let mut para = String::new();
    for (ms, line) in lines {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            continue;
        }
        if start.is_some_and(|s| ms.saturating_sub(s) >= PARAGRAPH_MS) && !para.is_empty() {
            out.push_str(&format!("[{}] {}\n\n", timestamp(start.unwrap_or(0)), para.trim()));
            para.clear();
            start = None;
        }
        start.get_or_insert(*ms);
        para.push_str(&line);
        para.push(' ');
    }
    if !para.trim().is_empty() {
        out.push_str(&format!("[{}] {}", timestamp(start.unwrap_or(0)), para.trim()));
    }
    vec![Page { number: None, text: out.trim().to_owned() }]
}

// --- chunking -------------------------------------------------------------------------

/// A piece of a source's text, as indexed and cited.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub ordinal: u32,
    pub page: Option<u32>,
    /// Character offsets in the source's whole text (its pages joined by a blank line).
    pub start: u64,
    pub end: u64,
    /// The nearest heading above it, for web pages and Markdown.
    pub heading: Option<String>,
    pub text: String,
}

/// Split a source's pages into chunks of about `CHUNK_CHARS`, at paragraph
/// boundaries where possible and never across a page.
pub fn chunk(pages: &[Page]) -> Vec<Chunk> {
    let mut out: Vec<Chunk> = Vec::new();
    // Character offset of the current page's start in the whole text.
    let mut base: u64 = 0;
    let mut heading: Option<String> = None;
    for page in pages {
        let mut current: Option<Chunk> = None;
        for (start, para) in paragraphs(&page.text) {
            if let Some(h) = heading_of(para) {
                // A heading starts a new chunk, so a section's chunks carry its name.
                if let Some(c) = current.take() {
                    out.push(c);
                }
                heading = Some(h);
            }
            for (offset, piece) in pieces(para, CHUNK_CHARS) {
                let at = base + start + offset;
                let len = piece.chars().count() as u64;
                match current.as_mut() {
                    Some(c) if c.text.chars().count() + 2 + piece.chars().count() <= CHUNK_CHARS => {
                        c.text.push_str("\n\n");
                        c.text.push_str(piece);
                        c.end = at + len;
                    }
                    _ => {
                        if let Some(c) = current.take() {
                            out.push(c);
                        }
                        current = Some(Chunk { ordinal: 0, page: page.number, start: at, end: at + len, heading: heading.clone(), text: piece.to_owned() });
                    }
                }
            }
        }
        if let Some(c) = current.take() {
            out.push(c);
        }
        base += page.text.chars().count() as u64 + 2;
    }
    for (i, c) in out.iter_mut().enumerate() {
        c.ordinal = i as u32;
    }
    out
}

/// Non-empty paragraphs (split at blank lines) with their character offset in `text`, trimmed.
fn paragraphs(text: &str) -> Vec<(u64, &str)> {
    let mut out = Vec::new();
    let mut chars: u64 = 0;
    let mut para_start: Option<(usize, u64)> = None;
    let mut byte = 0;
    for line in text.split_inclusive('\n') {
        let blank = line.trim().is_empty();
        match (blank, para_start) {
            (true, Some((b, c))) => {
                push_para(&mut out, &text[b..byte], c);
                para_start = None;
            }
            (false, None) => para_start = Some((byte, chars)),
            _ => {}
        }
        byte += line.len();
        chars += line.chars().count() as u64;
    }
    if let Some((b, c)) = para_start {
        push_para(&mut out, &text[b..], c);
    }
    out
}

fn push_para<'a>(out: &mut Vec<(u64, &'a str)>, raw: &'a str, at: u64) {
    let lead = raw.len() - raw.trim_start().len();
    let lead_chars = raw[..lead].chars().count() as u64;
    let trimmed = raw.trim();
    if !trimmed.is_empty() {
        out.push((at + lead_chars, trimmed));
    }
}

/// A Markdown heading's text (the readable text of web pages marks them the same way).
fn heading_of(para: &str) -> Option<String> {
    let first = para.lines().next()?;
    let rest = first.strip_prefix('#')?.trim_start_matches('#');
    let text = rest.trim().trim_end_matches('#').trim();
    (rest.starts_with(' ') && !text.is_empty()).then(|| text.chars().take(120).collect())
}

/// A paragraph cut into pieces of at most `max` characters, at a sentence end,
/// else a line break, else a space; with each piece's character offset.
fn pieces(para: &str, max: usize) -> Vec<(u64, &str)> {
    let mut out = Vec::new();
    let mut rest = para;
    let mut offset: u64 = 0;
    // Checked by walking at most `max` characters, so a huge paragraph stays linear.
    while rest.char_indices().nth(max).is_some() {
        let limit = rest.char_indices().nth(max).map_or(rest.len(), |(i, _)| i);
        let window = &rest[..limit];
        let floor = window.char_indices().nth(max / 2).map_or(0, |(i, _)| i);
        let cut = [". ", "? ", "! ", ".\n", "\n", " "]
            .iter()
            .find_map(|sep| window.rfind(sep).filter(|&i| i >= floor).map(|i| i + sep.len()))
            .unwrap_or(limit);
        let (piece, next) = rest.split_at(cut);
        let piece_trimmed = piece.trim_end();
        if !piece_trimmed.is_empty() {
            out.push((offset, piece_trimmed));
        }
        offset += piece.chars().count() as u64;
        let lead = next.len() - next.trim_start().len();
        offset += next[..lead].chars().count() as u64;
        rest = &next[lead..];
    }
    if !rest.is_empty() {
        out.push((offset, rest));
    }
    out
}

// --- citations ------------------------------------------------------------------------

/// A passage's address.
pub fn passage_url(source_id: &str, chunk_id: i64) -> String {
    format!("{SOURCE_SCHEME}{source_id}/{chunk_id}")
}

/// A passage's address with the words a reply cites from it.
pub fn with_quote(url: &str, quote: &str) -> String {
    let quote: String = quote.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_QUOTE_CHARS).collect();
    let mut out = String::with_capacity(url.len() + quote.len() + 3);
    out.push_str(url.split('?').next().unwrap_or(url));
    out.push_str("?q=");
    for b in quote.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The source and chunk an address names.
pub fn parse_passage_url(url: &str) -> Option<(&str, i64)> {
    let rest = url.strip_prefix(SOURCE_SCHEME)?;
    let rest = rest.split('?').next()?;
    let (source, chunk) = rest.split_once('/')?;
    Some((source, chunk.parse().ok()?))
}

// --- storage --------------------------------------------------------------------------

/// A stored chunk, as search and the viewer read it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub id: i64,
    pub source_id: String,
    pub ordinal: u32,
    pub page: Option<u32>,
    pub heading: Option<String>,
    pub text: String,
}

pub(crate) const MIGRATION: &str = r#"
    CREATE TABLE notebooks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    -- A notebook's chats.
    CREATE TABLE notebook_threads (
        thread_id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX notebook_threads_notebook ON notebook_threads (notebook_id);
    -- `data` is the whole `Source` as JSON.
    CREATE TABLE notebook_sources (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        added_at INTEGER NOT NULL,
        data TEXT NOT NULL
    );
    CREATE INDEX notebook_sources_notebook ON notebook_sources (notebook_id);
    CREATE TABLE source_chunks (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES notebook_sources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        page INTEGER,
        start_char INTEGER NOT NULL,
        end_char INTEGER NOT NULL,
        heading TEXT,
        text TEXT NOT NULL
    );
    CREATE INDEX source_chunks_source ON source_chunks (source_id, ordinal);
    CREATE VIRTUAL TABLE source_chunks_fts USING fts5(
        source_id UNINDEXED, chunk_id UNINDEXED, heading, text, tokenize = 'porter unicode61'
    );
"#;

/// A notebook's `NotebookExtras` as JSON.
pub(crate) const MIGRATION_EXTRAS: &str = r#"
    ALTER TABLE notebooks ADD COLUMN data TEXT NOT NULL DEFAULT '{}';
"#;

const PASSAGE_COLUMNS: &str = "c.id, c.source_id, c.ordinal, c.page, c.heading, c.text";

fn passage_row(r: &rusqlite::Row) -> rusqlite::Result<Passage> {
    Ok(Passage { id: r.get(0)?, source_id: r.get(1)?, ordinal: r.get(2)?, page: r.get(3)?, heading: r.get(4)?, text: r.get(5)? })
}

impl Store {
    /// Every notebook with its sources and chats, most recently changed first.
    pub fn notebooks(&self) -> StoreResult<Vec<Notebook>> {
        let ids: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT id FROM notebooks ORDER BY updated_at DESC")?;
            let ids = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            ids
        };
        Ok(ids.iter().filter_map(|id| self.notebook(id).transpose()).collect::<StoreResult<_>>()?)
    }

    pub fn notebook(&self, id: &str) -> StoreResult<Option<Notebook>> {
        let conn = self.conn.lock().unwrap();
        let found = conn
            .query_row("SELECT id, title, created_at, updated_at, data FROM notebooks WHERE id = ?1", [id], |r| {
                let data: String = r.get(4)?;
                Ok(Notebook {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    created_at: r.get(2)?,
                    updated_at: r.get(3)?,
                    sources: vec![],
                    thread_ids: vec![],
                    notes: vec![],
                    // A later version's fields, or damaged JSON, leave the defaults.
                    extras: serde_json::from_str(&data).unwrap_or_default(),
                })
            })
            .optional()?;
        let Some(mut notebook) = found else { return Ok(None) };
        let mut stmt = conn.prepare("SELECT data FROM notebook_sources WHERE notebook_id = ?1 ORDER BY added_at, id")?;
        notebook.sources = stmt
            .query_map([id], |r| r.get::<_, String>(0))?
            .map(|d| Ok(serde_json::from_str(&d?)?))
            .collect::<StoreResult<_>>()?;
        let mut stmt = conn.prepare("SELECT thread_id FROM notebook_threads WHERE notebook_id = ?1 ORDER BY created_at, thread_id")?;
        notebook.thread_ids = stmt.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        let mut stmt = conn.prepare("SELECT data FROM notebook_notes WHERE notebook_id = ?1 ORDER BY created_at DESC, id")?;
        notebook.notes = stmt
            .query_map([id], |r| r.get::<_, String>(0))?
            .map(|d| Ok(serde_json::from_str(&d?)?))
            .collect::<StoreResult<_>>()?;
        Ok(Some(notebook))
    }

    pub fn create_notebook(&self, id: &str, title: &str, now: i64) -> StoreResult<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO notebooks (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![id, title, now],
        )?;
        Ok(())
    }

    pub fn rename_notebook(&self, id: &str, title: &str, now: i64) -> StoreResult<()> {
        // Named by the user: overviews stop suggesting a title.
        let n = self.conn.lock().unwrap().execute(
            "UPDATE notebooks SET title = ?2, updated_at = ?3, data = json_set(data, '$.named', json('true')) WHERE id = ?1",
            params![id, title, now],
        )?;
        if n == 0 {
            return Err(StoreError::Invalid("That notebook no longer exists.".into()));
        }
        Ok(())
    }

    /// Change a notebook's extras in place (and its title, if `change` returns one); nothing is written if it fails.
    pub fn update_notebook_extras(
        &self,
        id: &str,
        change: impl FnOnce(&mut NotebookExtras, &str) -> Result<Option<String>, String>,
    ) -> StoreResult<()> {
        let conn = self.conn.lock().unwrap();
        let (title, data): (String, String) = conn
            .query_row("SELECT title, data FROM notebooks WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .ok_or_else(|| StoreError::Invalid("That notebook no longer exists.".into()))?;
        let mut extras: NotebookExtras = serde_json::from_str(&data).unwrap_or_default();
        let title = change(&mut extras, &title).map_err(StoreError::Invalid)?.unwrap_or(title);
        conn.execute("UPDATE notebooks SET title = ?2, data = ?3 WHERE id = ?1", params![id, title, serde_json::to_string(&extras)?])?;
        Ok(())
    }

    /// Delete a notebook and its sources. Returns its chats' threads, which are the caller's to delete.
    pub fn delete_notebook(&self, id: &str) -> StoreResult<Vec<String>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let threads: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT thread_id FROM notebook_threads WHERE notebook_id = ?1
                 UNION SELECT thread_id FROM notebook_notes WHERE notebook_id = ?1 AND thread_id IS NOT NULL",
            )?;
            let threads = stmt.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
            threads
        };
        tx.execute("DELETE FROM notebook_notes WHERE notebook_id = ?1", [id])?;
        tx.execute("DELETE FROM source_chunks_fts WHERE source_id IN (SELECT id FROM notebook_sources WHERE notebook_id = ?1)", [id])?;
        tx.execute("DELETE FROM source_chunks WHERE source_id IN (SELECT id FROM notebook_sources WHERE notebook_id = ?1)", [id])?;
        tx.execute("DELETE FROM notebook_sources WHERE notebook_id = ?1", [id])?;
        tx.execute("DELETE FROM notebook_threads WHERE notebook_id = ?1", [id])?;
        tx.execute("DELETE FROM notebooks WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(threads)
    }

    /// File a thread under a notebook as one of its chats.
    pub fn add_notebook_thread(&self, notebook_id: &str, thread_id: &str, now: i64) -> StoreResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO notebook_threads (thread_id, notebook_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (thread_id) DO NOTHING",
            params![thread_id, notebook_id, now],
        )?;
        conn.execute("UPDATE notebooks SET updated_at = ?2 WHERE id = ?1", params![notebook_id, now])?;
        Ok(())
    }

    /// The notebook a thread is a chat of, if any.
    pub fn notebook_for_thread(&self, thread_id: &str) -> StoreResult<Option<Notebook>> {
        let id: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT notebook_id FROM notebook_threads WHERE thread_id = ?1", [thread_id], |r| r.get(0))
            .optional()?;
        match id {
            Some(id) => self.notebook(&id),
            None => Ok(None),
        }
    }

    pub fn source(&self, id: &str) -> StoreResult<Option<Source>> {
        let data: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT data FROM notebook_sources WHERE id = ?1", [id], |r| r.get(0))
            .optional()?;
        Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
    }

    /// Add or update a source.
    pub fn save_source(&self, source: &Source, now: i64) -> StoreResult<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("UPDATE notebooks SET updated_at = ?2 WHERE id = ?1", params![source.notebook_id, now])?;
        if n == 0 {
            return Err(StoreError::Invalid("That notebook no longer exists.".into()));
        }
        conn.execute(
            "INSERT INTO notebook_sources (id, notebook_id, added_at, data) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET data = ?4",
            params![source.id, source.notebook_id, source.added_at, serde_json::to_string(source)?],
        )?;
        Ok(())
    }

    /// Change a source in place; nothing is written if `change` fails.
    pub fn update_source(&self, id: &str, now: i64, change: impl FnOnce(&mut Source) -> Result<(), String>) -> StoreResult<Source> {
        let mut source = self.source(id)?.ok_or_else(|| StoreError::Invalid("That source no longer exists.".into()))?;
        change(&mut source).map_err(StoreError::Invalid)?;
        self.save_source(&source, now)?;
        Ok(source)
    }

    /// Replace a source's chunks (and their index) with these.
    pub fn set_source_chunks(&self, source_id: &str, chunks: &[Chunk]) -> StoreResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM source_chunks_fts WHERE source_id = ?1", [source_id])?;
        tx.execute("DELETE FROM source_chunks WHERE source_id = ?1", [source_id])?;
        {
            let mut insert = tx.prepare(
                "INSERT INTO source_chunks (source_id, ordinal, page, start_char, end_char, heading, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            let mut index = tx.prepare("INSERT INTO source_chunks_fts (source_id, chunk_id, heading, text) VALUES (?1, ?2, ?3, ?4)")?;
            for c in chunks {
                insert.execute(params![source_id, c.ordinal, c.page, c.start as i64, c.end as i64, c.heading, c.text])?;
                let id = tx.last_insert_rowid();
                index.execute(params![source_id, id, c.heading.as_deref().unwrap_or(""), c.text])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_source(&self, id: &str) -> StoreResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM source_chunks_fts WHERE source_id = ?1", [id])?;
        tx.execute("DELETE FROM source_chunks WHERE source_id = ?1", [id])?;
        tx.execute("DELETE FROM notebook_sources WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// A source's chunks in order: all of them, or those on `page`, or from `from` on, up to `limit`.
    pub fn source_passages(&self, source_id: &str, page: Option<u32>, from: Option<u32>, limit: usize) -> StoreResult<Vec<Passage>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {PASSAGE_COLUMNS} FROM source_chunks c WHERE c.source_id = ?1
               AND (?2 IS NULL OR c.page = ?2) AND c.ordinal >= ?3
             ORDER BY c.ordinal LIMIT ?4"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![source_id, page, from.unwrap_or(0), limit as i64], passage_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// One chunk, by id.
    pub fn passage(&self, id: i64) -> StoreResult<Option<Passage>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row(&format!("SELECT {PASSAGE_COLUMNS} FROM source_chunks c WHERE c.id = ?1"), [id], passage_row).optional()?)
    }

    /// The chunks of `source_ids` that best match `query`, best first (BM25,
    /// headings weighted over body text). Any word may match.
    pub fn search_passages(&self, query: &str, source_ids: &[String], limit: usize) -> StoreResult<Vec<Passage>> {
        let Some(fts) = match_query(query) else { return Ok(Vec::new()) };
        if source_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {PASSAGE_COLUMNS} FROM source_chunks_fts f JOIN source_chunks c ON c.id = f.chunk_id
             WHERE source_chunks_fts MATCH ?1 AND f.source_id IN (SELECT value FROM json_each(?2))
             ORDER BY bm25(source_chunks_fts, 0.0, 0.0, 2.0, 1.0)
             LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let ids = serde_json::to_string(source_ids)?;
        let rows = stmt.query_map(params![fts, ids, limit as i64], passage_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does", "for", "from", "has", "have", "how", "i", "if", "in",
    "into", "is", "it", "its", "me", "my", "of", "on", "or", "our", "so", "that", "the", "their", "them", "there", "these", "they",
    "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
];

/// An FTS5 query matching any of the query's words (stop words left out unless
/// they're all there is). BM25 then ranks chunks with more and rarer words first.
fn match_query(query: &str) -> Option<String> {
    let words: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    let mut kept: Vec<&String> = words.iter().filter(|w| !STOPWORDS.contains(&w.as_str())).collect();
    if kept.is_empty() {
        kept = words.iter().collect();
    }
    let mut seen = std::collections::HashSet::new();
    kept.retain(|w| seen.insert(w.as_str()));
    kept.truncate(32);
    (!kept.is_empty()).then(|| kept.iter().map(|w| format!("\"{w}\"")).collect::<Vec<_>>().join(" OR "))
}

// --- the model's tools ----------------------------------------------------------------

/// What a notebook chat's model may read: its checked sources that are ready.
pub fn searchable(notebook: &Notebook) -> Vec<&Source> {
    notebook.sources.iter().filter(|s| s.checked && s.status == SourceStatus::Ready).collect()
}

pub fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: SOURCE_SEARCH.into(),
            description: "Search the notebook's checked sources for passages about something. Returns the best-matching passages, \
                          each with the source and page it's from. Search before answering anything about the sources, and search \
                          again with other words (names, terms the sources would use) when the first results miss."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Words the passages would contain. Keyword search (BM25), not a question: use the terms, names and phrases the sources would use." },
                    "source_ids": { "type": "array", "items": { "type": "string" }, "description": "Only these sources (ids from the system prompt). Leave out to search every checked source." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_RESULTS, "description": "How many passages (default 8)." },
                },
                "required": ["query"],
            }),
        },
        ToolSpec {
            name: SOURCE_READ.into(),
            description: "Read a source in order, to see more than search passages show: a whole page of a PDF, or the passages \
                          following one you found (each passage's id ends in its number). Use it for summaries, outlines, or when \
                          context around a passage matters."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "source_id": { "type": "string" },
                    "page": { "type": "integer", "minimum": 1, "description": "A PDF page to read." },
                    "from": { "type": "integer", "minimum": 0, "description": "Read from this passage number on (0 is the start)." },
                },
                "required": ["source_id"],
            }),
        },
    ]
}

/// Run a notebook tool against the notebook as it is now. `seen`: passages
/// already returned this turn (`seen_this_turn`); a search names them instead
/// of sending their text again, and fills their places with new ones.
pub fn execute(store: &Store, notebook: &Notebook, name: &str, input: &Value, seen: &HashSet<String>) -> Result<Value, String> {
    let readable = searchable(notebook);
    let titles: HashMap<&str, &str> = notebook.sources.iter().map(|s| (s.id.as_str(), s.title.as_str())).collect();
    let mut repeated: Vec<String> = Vec::new();
    let passages = match name {
        SOURCE_SEARCH => {
            let query = input["query"].as_str().map(str::trim).filter(|q| !q.is_empty()).ok_or("Give a query to search for.")?;
            if readable.is_empty() {
                return Err("No sources are checked and ready, so there's nothing to search. Ask the user to add or check sources.".into());
            }
            let wanted: Option<Vec<&str>> = input["source_ids"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect());
            let ids: Vec<String> = readable
                .iter()
                .filter(|s| wanted.as_ref().is_none_or(|w| w.is_empty() || w.contains(&s.id.as_str())))
                .map(|s| s.id.clone())
                .collect();
            if ids.is_empty() {
                return Err("None of those sources are checked and ready. Leave out source_ids to search them all.".into());
            }
            let limit = input["limit"].as_u64().map_or(DEFAULT_RESULTS, |n| (n as usize).clamp(1, MAX_RESULTS));
            // Ask for a few more, so passages already shown leave room for new ones.
            let found = store.search_passages(query, &ids, limit + seen.len().min(limit)).map_err(|e| e.to_string())?;
            if found.is_empty() {
                return Ok(json!(format!(
                    "No passages matched \"{query}\". Try other words: synonyms, names, or the terms the sources would use."
                )));
            }
            let (old, new): (Vec<Passage>, Vec<Passage>) =
                found.into_iter().partition(|p| seen.contains(&passage_url(&p.source_id, p.id)));
            repeated = old.iter().map(|p| passage_url(&p.source_id, p.id)).collect();
            if new.is_empty() {
                return Ok(json!(format!(
                    "Every passage matching \"{query}\" was already shown above ({}). Use those, or search with other words.",
                    repeated.join(", ")
                )));
            }
            new.into_iter().take(limit).collect()
        }
        SOURCE_READ => {
            let id = input["source_id"].as_str().ok_or("Say which source to read (source_id).")?;
            let source = notebook.sources.iter().find(|s| s.id == id).ok_or("There's no source with that id in this notebook.")?;
            if !readable.iter().any(|s| s.id == id) {
                return Err(format!("\"{}\" isn't checked, or isn't read yet, so it can't be used.", source.title));
            }
            let page = input["page"].as_u64().map(|p| p as u32);
            let from = input["from"].as_u64().map(|p| p as u32);
            let mut found = store.source_passages(id, page, from, 40).map_err(|e| e.to_string())?;
            if found.is_empty() {
                return Err(match page {
                    Some(p) => format!("\"{}\" has no text on page {p}.", source.title),
                    None => format!("\"{}\" has no passages from there; it has {}.", source.title, source.chunks),
                });
            }
            let mut total = 0;
            found.retain(|p| {
                total += p.text.len();
                total <= MAX_READ_CHARS || total == p.text.len()
            });
            found
        }
        _ => return Err(format!("{name} isn't a notebook tool.")),
    };
    let note = (!repeated.is_empty())
        .then(|| format!("Also matched, already shown above (cite them there): {}.", repeated.join(", ")));
    Ok(passages_output(&passages, &titles, note))
}

/// Passages as a tool's output: citable search results, and the same as text with their ids.
fn passages_output(passages: &[Passage], titles: &HashMap<&str, &str>, note: Option<String>) -> Value {
    let mut results = Vec::with_capacity(passages.len());
    let mut text = String::new();
    for p in passages {
        let source_title = titles.get(p.source_id.as_str()).copied().unwrap_or("Source");
        let title = match p.page {
            Some(n) => format!("{source_title} · p. {n}"),
            None => source_title.to_owned(),
        };
        let url = passage_url(&p.source_id, p.id);
        let heading = p.heading.as_deref().map(|h| format!(" section=\"{}\"", h.replace('"', "'"))).unwrap_or_default();
        text.push_str(&format!(
            "<passage id=\"{url}\" source=\"{}\" number=\"{}\"{heading}>\n{}\n</passage>\n\n",
            title.replace('"', "'"),
            p.ordinal,
            p.text
        ));
        results.push(SearchResult { source: url, title, text: p.text.clone() });
    }
    let mut out = serde_json::Map::new();
    if let Some(note) = &note {
        text.push_str(note);
    }
    out.insert(SEARCH_RESULTS.into(), serde_json::to_value(results).unwrap_or_default());
    out.insert("text".into(), Value::String(text.trim_end().to_owned()));
    if let Some(note) = note {
        out.insert(SEARCH_NOTE.into(), Value::String(note));
    }
    Value::Object(out)
}

// --- keeping requests small -----------------------------------------------------------

/// The passages this turn's tool calls already returned: those after the
/// thread's latest user message (`messages` as the UI keeps them).
pub fn seen_this_turn(messages: &[Value]) -> HashSet<String> {
    let from = messages.iter().rposition(|m| m["role"] == "user").map_or(0, |i| i + 1);
    messages[from..]
        .iter()
        .filter_map(|m| m["parts"].as_array())
        .flatten()
        .filter(|p| p["type"] == "dynamic-tool" && p["state"] == "output-available")
        .filter_map(|p| p["output"][SEARCH_RESULTS].as_array())
        .flatten()
        .filter_map(|r| r["source"].as_str().map(str::to_owned))
        .collect()
}

/// Passages returned in earlier turns, cut to a line naming each one. The
/// answers they fed stay whole, and the model can search again; what's cut is
/// the source text that would otherwise be sent again with every later request.
/// Only turns before the latest user message change, and only once, so the
/// cached start of the conversation stays the same from one request to the next.
/// Returns how many tool results were cut.
pub fn compact_earlier_passages(messages: &mut [Message]) -> usize {
    let Some(latest) = messages.iter().rposition(|m| m.role == Role::User && m.parts.iter().any(|p| matches!(p, Part::Text { .. })))
    else {
        return 0;
    };
    let mut cut = 0;
    for m in &mut messages[..latest] {
        for part in &mut m.parts {
            let Part::ToolResult { output, is_error: false, .. } = part else { continue };
            let Some(results) = crate::message::search_results(output) else { continue };
            let list: Vec<String> = results.iter().map(|r| format!("\"{}\" ({})", r.title, r.source)).collect();
            *output = Value::String(format!(
                "[{} passage(s) from an earlier turn, left out to save space; search again to read them: {}]",
                results.len(),
                list.join("; ")
            ));
            cut += 1;
        }
    }
    cut
}

/// The system prompt section for a notebook's chat. `native_citations`: the
/// provider cites search results itself (Anthropic), so the model writes no markers.
pub fn system_section(notebook: &Notebook, native_citations: bool) -> String {
    let mut out = format!(
        "You're helping the user understand and work with the sources in their notebook \"{}\". Answer from these sources: \
         search them with {SOURCE_SEARCH} (and read further with {SOURCE_READ}) before answering, and base every claim about \
         them on passages you found. When the sources don't cover something, say so plainly; bring in general knowledge only \
         when the user asks for it, and say that's what it is. Don't invent quotes, numbers or page references.",
        notebook.title
    );
    let readable = searchable(notebook);
    if readable.is_empty() {
        out.push_str(
            "\n\nNo sources are checked and ready yet, so you can't search. Tell the user to add sources (files, links, papers \
             or pasted text) or check the ones they want to use.",
        );
    } else {
        out.push_str("\n\nThe checked sources:");
        for s in &readable {
            let size = match s.pages {
                Some(p) => format!("{p} pages, {} passages", s.chunks),
                None => format!("{} passages", s.chunks),
            };
            let kind = s.kind.label();
            out.push_str(&format!("\n- \"{}\" ({kind}, {size}), id {}", s.title, s.id));
        }
    }
    let waiting = notebook.sources.iter().filter(|s| s.checked && s.status == SourceStatus::Reading).count();
    if waiting > 0 {
        out.push_str(&format!("\n\n{waiting} more source(s) are still being read and can't be searched yet."));
    }
    out.push_str(if native_citations {
        "\n\nCitations: the passages you're given are cited automatically when you use them, so don't write citation markers, \
         passage ids or a list of sources yourself."
    } else {
        "\n\nCitations: right after each sentence or claim that rests on a passage, write a citation as a Markdown link with \
         the text \"cite\" and the passage's id as the address, exactly as given, like [cite](sushsrc:3f9a.../12). Cite \
         every claim from the sources; several citations in a row are fine. Never make up an id. Don't add a list of sources \
         at the end; the citations are shown as numbered links."
    });
    out
}

// --- notes and Studio ---------------------------------------------------------------

/// What a note is: the user's own (written, or a reply saved), or a Studio output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoteKind {
    Note,
    Briefing,
    StudyGuide,
    Faq,
    Timeline,
    Quiz,
    Flashcards,
    MindMap,
    /// A two-host conversation about the sources: a script, voiced in the UI.
    AudioOverview,
}

impl NoteKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Note => "Note",
            Self::Briefing => "Briefing",
            Self::StudyGuide => "Study guide",
            Self::Faq => "FAQ",
            Self::Timeline => "Timeline",
            Self::Quiz => "Quiz",
            Self::Flashcards => "Flashcards",
            Self::MindMap => "Mind map",
            Self::AudioOverview => "Audio overview",
        }
    }

    /// Outputs that are data the UI plays (`Note::data`), saved with `STUDIO_SAVE`, not a document.
    pub fn interactive(self) -> bool {
        matches!(self, Self::Quiz | Self::Flashcards | Self::MindMap | Self::AudioOverview)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoteStatus {
    /// A Studio output whose run is still going.
    Writing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub notebook_id: String,
    pub kind: NoteKind,
    pub title: String,
    /// Markdown, with `[cite](sushsrc:…)` markers where it cites passages.
    pub body: String,
    pub status: NoteStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A Studio output's run (a thread of its own, not one of the notebook's chats).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// A quiz's questions, flashcards' cards or a mind map's tree, as `save_studio` checked them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub(crate) const MIGRATION_NOTES: &str = r#"
    -- Notes and Studio outputs; `data` is the whole `Note` as JSON.
    CREATE TABLE notebook_notes (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        thread_id TEXT,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
    );
    CREATE INDEX notebook_notes_notebook ON notebook_notes (notebook_id);
    CREATE INDEX notebook_notes_thread ON notebook_notes (thread_id);
"#;

impl Store {
    pub fn note(&self, id: &str) -> StoreResult<Option<Note>> {
        let data: Option<String> =
            self.conn.lock().unwrap().query_row("SELECT data FROM notebook_notes WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
    }

    /// Add or update a note.
    pub fn save_note(&self, note: &Note, now: i64) -> StoreResult<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("UPDATE notebooks SET updated_at = ?2 WHERE id = ?1", params![note.notebook_id, now])?;
        if n == 0 {
            return Err(StoreError::Invalid("That notebook no longer exists.".into()));
        }
        conn.execute(
            "INSERT INTO notebook_notes (id, notebook_id, thread_id, created_at, data) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (id) DO UPDATE SET thread_id = ?3, data = ?5",
            params![note.id, note.notebook_id, note.thread_id, note.created_at, serde_json::to_string(note)?],
        )?;
        Ok(())
    }

    /// Change a note in place; nothing is written if `change` fails.
    pub fn update_note(&self, id: &str, now: i64, change: impl FnOnce(&mut Note) -> Result<(), String>) -> StoreResult<Note> {
        let mut note = self.note(id)?.ok_or_else(|| StoreError::Invalid("That note no longer exists.".into()))?;
        change(&mut note).map_err(StoreError::Invalid)?;
        note.updated_at = now;
        self.save_note(&note, now)?;
        Ok(note)
    }

    pub fn delete_note(&self, id: &str) -> StoreResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM notebook_notes WHERE id = ?1", [id])?;
        Ok(())
    }

    /// The Studio output a thread writes, with its notebook.
    pub fn studio_for_thread(&self, thread_id: &str) -> StoreResult<Option<(Notebook, Note)>> {
        let data: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT data FROM notebook_notes WHERE thread_id = ?1", [thread_id], |r| r.get(0))
            .optional()?;
        let Some(note) = data.map(|d| serde_json::from_str::<Note>(&d)).transpose()? else { return Ok(None) };
        Ok(self.notebook(&note.notebook_id)?.map(|n| (n, note)))
    }
}

/// How a Studio run should go through the sources without paying for the same
/// text twice, and how it follows the options the user picked (focus, length,
/// language), which come in its first message (`lib/notebook-studio.ts`).
const READING_PLAN: &str = "\n\nReading the sources: a source of 12 passages or fewer is cheapest read whole with \
source_read (one call, then `from` for the rest); search the longer ones. Search with several different words in one \
go rather than many narrow searches; a search never repeats a passage already shown, so don't search again for the same \
thing. Stop reading once you have what you need.\n\nThe user's message may set a focus, a length or a language: follow \
them. A focus narrows what you cover; \"shorter\" means about half the usual length and \"longer\" about half as long again.";

/// A Studio output's instructions, added to the notebook's own (`system_section`).
pub fn studio_section(kind: NoteKind) -> String {
    if kind == NoteKind::AudioOverview {
        return format!(
            "You're writing the script of an audio overview of the user's notebook: two hosts talking it through, \
             like a good podcast, for someone who hasn't read the sources. Work through the sources first: search \
             them several times with different words, and read further where needed, until you know what matters \
             in all of them. Then call {STUDIO_SAVE} once with the whole script.\n\n\
             The script: 1,400 to 2,000 words, about ten minutes spoken, in 3 to 6 chapters. Host a leads and frames; \
             host b asks what a listener would ask, pushes back and connects ideas. They talk, not read: short \
             sentences, plain words, real reactions, now and then finishing each other's thought. Open with why this \
             matters, end with the takeaway. Every claim comes from the sources; say where something comes from when \
             it helps (\"the 2019 study found…\"). No stage directions, sound effects, music cues or names for the \
             hosts; numbers and symbols written as they're said. Give each turn's `source` as the passage id it rests \
             on, when it rests on one.\n\nAfterwards reply with one short sentence. Don't ask the user anything.{READING_PLAN}"
        );
    }
    if kind.interactive() {
        let what = match kind {
            NoteKind::Quiz => {
                "a quiz: 10 multiple-choice questions that test understanding, not trivia, from easy to hard, each \
                 with four plausible options, exactly one right, and an explanation of why"
            }
            NoteKind::Flashcards => {
                "a deck of 15 to 25 flashcards: a term, name, date or question on the front, and a short, complete \
                 answer on the back"
            }
            _ => {
                "a mind map: the topic at the root, its 3 to 7 main themes, and under each the ideas, people and \
                 findings that make it up, 2 to 4 levels deep, each node a few words with a one-line note"
            }
        };
        return format!(
            "You're making {what}, for the user's notebook, from its sources. Work through the sources first: search \
             them several times with different words, and read further where needed, until you've covered all of \
             them. Then call {STUDIO_SAVE} once with the whole thing. Base every item on the sources, and give each \
             item's `source` as the id of the passage it comes from (the `sushsrc:` id from the search results). \
             Afterwards reply with one short sentence; don't repeat the content. Don't ask the user anything.{READING_PLAN}"
        );
    }
    let what = match kind {
        NoteKind::Note => "a note summarising what the sources say",
        NoteKind::Briefing => {
            "a briefing document: an executive summary of a few sentences, then a section for each main theme with the \
             most important facts, figures and short quotes, then open questions or disagreements between the sources"
        }
        NoteKind::StudyGuide => {
            "a study guide: a short-answer quiz of 10 questions, an answer key with 2 to 3 sentence answers, 5 essay \
             questions (no answers), and a glossary of the key terms with their definitions"
        }
        NoteKind::Faq => "an FAQ: the 8 to 12 questions a reader is most likely to ask, each answered in a short paragraph",
        NoteKind::Timeline => {
            "a timeline: the dated events in chronological order, each as a `### <date>` heading with what happened \
             below it, then a cast of characters with a line on each person or organisation and their role"
        }
        NoteKind::Quiz | NoteKind::Flashcards | NoteKind::MindMap | NoteKind::AudioOverview => {
            unreachable!("interactive kinds return above")
        }
    };
    format!(
        "You're writing {what}, for the user's notebook, from its sources. Work through the sources first: search \
         them several times with different words, and read further where a passage needs context, until you've \
         covered all of them. Cite every claim from the sources, as in chat.\n\nYour final reply is the document \
         itself, in Markdown: start with its title as a `# ` heading, then the content. No preamble, no remarks about \
         what you did, no closing offer. Don't ask the user anything; if something's unclear, make a sensible choice.{READING_PLAN}"
    )
}

/// `STUDIO_SAVE`'s spec for a kind: the shape its data must have.
pub fn studio_save_spec(kind: NoteKind) -> ToolSpec {
    let source = json!({ "type": "string", "description": "The sushsrc: id of the passage it comes from." });
    let content = match kind {
        NoteKind::Quiz => json!({
            "questions": { "type": "array", "minItems": 3, "maxItems": 20, "items": { "type": "object", "properties": {
                "question": { "type": "string" },
                "options": { "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 5 },
                "answer": { "type": "integer", "description": "Index of the right option, from 0." },
                "explanation": { "type": "string", "description": "Why it's right, in a sentence or two." },
                "source": source,
            }, "required": ["question", "options", "answer", "explanation"] } },
        }),
        NoteKind::Flashcards => json!({
            "cards": { "type": "array", "minItems": 3, "maxItems": 40, "items": { "type": "object", "properties": {
                "front": { "type": "string" },
                "back": { "type": "string" },
                "source": source,
            }, "required": ["front", "back"] } },
        }),
        NoteKind::AudioOverview => json!({
            "chapters": { "type": "array", "minItems": 1, "maxItems": 8, "items": { "type": "object", "properties": {
                "title": { "type": "string" },
                "turns": { "type": "array", "minItems": 1, "items": { "type": "object", "properties": {
                    "host": { "type": "string", "enum": ["a", "b"] },
                    "text": { "type": "string", "description": "What the host says, as spoken." },
                    "source": source,
                }, "required": ["host", "text"] } },
            }, "required": ["title", "turns"] } },
        }),
        _ => json!({
            "root": { "$ref": "#/$defs/node" },
        }),
    };
    let mut schema = json!({
        "type": "object",
        "properties": { "title": { "type": "string", "description": "A short title for it." } },
        "required": ["title", match kind {
            NoteKind::Quiz => "questions",
            NoteKind::Flashcards => "cards",
            NoteKind::AudioOverview => "chapters",
            _ => "root",
        }],
    });
    if let (Some(props), Some(more)) = (schema["properties"].as_object_mut(), content.as_object()) {
        props.extend(more.clone());
    }
    if kind == NoteKind::MindMap {
        schema["$defs"] = json!({ "node": { "type": "object", "properties": {
            "label": { "type": "string", "description": "A few words." },
            "note": { "type": "string", "description": "One line on it." },
            "source": source,
            "children": { "type": "array", "items": { "$ref": "#/$defs/node" } },
        }, "required": ["label"] } });
    }
    ToolSpec {
        name: STUDIO_SAVE.into(),
        description: format!("Save the {} once it's complete. Call it once, with everything.", kind.label().to_lowercase()),
        input_schema: schema,
    }
}

/// Most nodes a mind map keeps, and how deep.
const MAX_MAP_NODES: usize = 120;
const MAX_MAP_DEPTH: usize = 5;

/// Check a `STUDIO_SAVE` call's input for the kind and keep its tidied data and
/// title. Returns what the model is told, or what to fix.
pub fn save_studio(note: &mut Note, input: &Value) -> Result<String, String> {
    let text = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
    let source = |v: &Value| text(&v["source"]).filter(|s| s.starts_with(SOURCE_SCHEME));
    let data = match note.kind {
        NoteKind::Quiz => {
            let items = input["questions"].as_array().ok_or("Give the questions as `questions`.")?;
            let mut out = Vec::new();
            for (i, q) in items.iter().enumerate() {
                let question = text(&q["question"]).ok_or(format!("Question {} has no text.", i + 1))?;
                let options: Vec<String> = q["options"].as_array().map(|a| a.iter().filter_map(text).collect()).unwrap_or_default();
                if !(2..=5).contains(&options.len()) {
                    return Err(format!("Question {} needs 2 to 5 options.", i + 1));
                }
                let answer = q["answer"].as_u64().filter(|&a| (a as usize) < options.len()).ok_or(format!(
                    "Question {}'s `answer` must be the index of the right option, from 0 to {}.",
                    i + 1,
                    options.len() - 1
                ))?;
                out.push(json!({ "question": question, "options": options, "answer": answer,
                    "explanation": text(&q["explanation"]).unwrap_or_default(), "source": source(q) }));
            }
            if out.len() < 3 {
                return Err("A quiz needs at least 3 questions.".into());
            }
            json!({ "questions": out })
        }
        NoteKind::Flashcards => {
            let items = input["cards"].as_array().ok_or("Give the cards as `cards`.")?;
            let out: Vec<Value> = items
                .iter()
                .filter_map(|c| Some(json!({ "front": text(&c["front"])?, "back": text(&c["back"])?, "source": source(c) })))
                .collect();
            if out.len() < 3 {
                return Err("A deck needs at least 3 cards, each with a front and a back.".into());
            }
            json!({ "cards": out })
        }
        NoteKind::MindMap => {
            let mut count = 0;
            fn node(v: &Value, depth: usize, count: &mut usize) -> Option<Value> {
                let label = v["label"].as_str().map(str::trim).filter(|s| !s.is_empty())?;
                if depth > MAX_MAP_DEPTH || *count >= MAX_MAP_NODES {
                    return None;
                }
                *count += 1;
                let children: Vec<Value> =
                    v["children"].as_array().map(|a| a.iter().filter_map(|c| node(c, depth + 1, count)).collect()).unwrap_or_default();
                let note = v["note"].as_str().map(str::trim).filter(|s| !s.is_empty());
                let source = v["source"].as_str().filter(|s| s.starts_with(SOURCE_SCHEME));
                Some(json!({ "label": label, "note": note, "source": source, "children": children }))
            }
            let root = node(&input["root"], 0, &mut count).ok_or("Give the map as `root`, a node with a `label`.")?;
            if root["children"].as_array().is_none_or(|c| c.is_empty()) {
                return Err("The root needs its main themes as `children`.".into());
            }
            json!({ "root": root })
        }
        NoteKind::AudioOverview => {
            let chapters = input["chapters"].as_array().ok_or("Give the script as `chapters`.")?;
            let mut out = Vec::new();
            let mut total = 0;
            for (i, c) in chapters.iter().enumerate() {
                let title = text(&c["title"]).unwrap_or_else(|| format!("Part {}", i + 1));
                let turns: Vec<Value> = c["turns"]
                    .as_array()
                    .map(|ts| {
                        ts.iter()
                            .filter_map(|t| {
                                let host = match t["host"].as_str()?.trim().to_ascii_lowercase().as_str() {
                                    "a" => "a",
                                    "b" => "b",
                                    _ => return None,
                                };
                                let said: String = text(&t["text"])?.chars().take(crate::tts::MAX_TTS_CHARS).collect();
                                Some(json!({ "host": host, "text": said, "source": source(t) }))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                total += turns.len();
                if !turns.is_empty() {
                    out.push(json!({ "title": title, "turns": turns }));
                }
            }
            if total < 6 {
                return Err("The script needs more: at least six turns between hosts a and b.".into());
            }
            if total > 400 {
                return Err("That's too many turns; keep the script to about ten minutes.".into());
            }
            json!({ "chapters": out })
        }
        _ => return Err(format!("{STUDIO_SAVE} is only for quizzes, flashcards, mind maps and audio overviews.")),
    };
    if let Some(title) = text(&input["title"]) {
        note.title = title.chars().take(120).collect();
    }
    note.data = Some(data);
    Ok(format!("Saved the {}. Now reply with one short sentence.", note.kind.label().to_lowercase()))
}

// --- what a shared chat's guests may see ----------------------------------------------

/// A notebook as guests of one of its shared chats see it (`share::Intent::GetNotebook`):
/// its title, its sources' titles and kinds (never their text), and its finished
/// Studio outputs. The owner's own notes stay private, and an audio overview
/// comes without its clips, which are files on the host.
pub fn guest_view(notebook: &Notebook) -> Value {
    let sources: Vec<Value> = notebook
        .sources
        .iter()
        .filter(|s| s.status == SourceStatus::Ready)
        .map(|s| json!({ "id": s.id, "title": s.title, "kind": s.kind, "pages": s.pages, "checked": s.checked }))
        .collect();
    let outputs: Vec<Value> = notebook
        .notes
        .iter()
        .filter(|n| n.kind != NoteKind::Note && n.status == NoteStatus::Ready)
        .map(|n| {
            let mut data = n.data.clone();
            if let Some(d) = data.as_mut() {
                drop_key(d, "audio");
                drop_key(d, "voices");
            }
            json!({ "id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "data": data, "updatedAt": n.updated_at })
        })
        .collect();
    json!({ "title": notebook.title, "emoji": notebook.extras.emoji, "sources": sources, "outputs": outputs })
}

fn drop_key(value: &mut Value, key: &str) {
    match value {
        Value::Object(o) => {
            o.remove(key);
            o.values_mut().for_each(|v| drop_key(v, key));
        }
        Value::Array(a) => a.iter_mut().for_each(|v| drop_key(v, key)),
        _ => {}
    }
}

/// One passage for a guest (`share::Intent::GetPassage`), only if it belongs to
/// one of this notebook's sources. Whether the owner shares sources at all is
/// the share policy's call, checked before this.
pub fn guest_passage(store: &Store, notebook: &Notebook, url: &str) -> Result<Value, String> {
    let (source_id, chunk) = parse_passage_url(url).ok_or("That isn't a passage.")?;
    let source = notebook.sources.iter().find(|s| s.id == source_id).ok_or("That passage isn't from this notebook.")?;
    let passage = store.passage(chunk).map_err(|e| e.to_string())?.ok_or("That passage no longer exists.")?;
    if passage.source_id != source.id {
        return Err("That passage isn't from this notebook.".into());
    }
    Ok(json!({
        "sourceTitle": source.title,
        "kind": source.kind,
        "url": source.url,
        "page": passage.page,
        "heading": passage.heading,
        "text": passage.text,
    }))
}

/// A finished Studio output split into its title (a leading `# ` heading) and body.
pub fn split_title(text: &str) -> (Option<String>, String) {
    let text = text.trim();
    match text.strip_prefix("# ") {
        Some(rest) => {
            let (title, body) = rest.split_once('\n').unwrap_or((rest, ""));
            let title = title.trim().trim_end_matches('#').trim();
            ((!title.is_empty()).then(|| title.to_owned()), body.trim().to_owned())
        }
        None => (None, text.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    fn ready(id: &str, notebook: &str, title: &str) -> Source {
        let mut s = Source::new(id.into(), notebook.into(), SourceKind::Text, title.into(), 1);
        s.status = SourceStatus::Ready;
        s
    }

    #[test]
    fn chunks_keep_to_pages_and_carry_headings() {
        let pages = vec![
            Page { number: Some(1), text: "# Habits\n\nCue, routine, reward.\n\nAnother paragraph.".into() },
            Page { number: Some(2), text: "Page two text.".into() },
        ];
        let chunks = chunk(&pages);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].page, Some(1));
        assert_eq!(chunks[0].heading.as_deref(), Some("Habits"));
        assert_eq!(chunks[0].text, "# Habits\n\nCue, routine, reward.\n\nAnother paragraph.");
        assert_eq!(chunks[1].page, Some(2));
        assert_eq!(chunks[1].ordinal, 1);
        // Offsets are in the whole text, pages joined by a blank line.
        let whole = format!("{}\n\n{}", pages[0].text, pages[1].text);
        let start = chunks[1].start as usize;
        assert_eq!(&whole.chars().skip(start).take(14).collect::<String>(), "Page two text.");
    }

    #[test]
    fn long_paragraphs_split_at_sentences_within_the_limit() {
        let sentence = "The habit loop has a cue, a routine and a reward. ";
        let text = sentence.repeat(100);
        let chunks = chunk(&text_pages(&text));
        assert!(chunks.len() >= 3);
        for c in &chunks {
            assert!(c.text.chars().count() <= CHUNK_CHARS, "{}", c.text.len());
            assert!(c.text.ends_with('.'), "cut mid-sentence: {:?}", &c.text[c.text.len() - 10..]);
        }
    }

    #[test]
    fn papers_resolve_to_their_pdf_or_doi() {
        assert_eq!(paper_url("2401.12345").as_deref(), Some("https://arxiv.org/pdf/2401.12345"));
        assert_eq!(paper_url("https://arxiv.org/abs/2401.12345v2").as_deref(), Some("https://arxiv.org/pdf/2401.12345v2"));
        assert_eq!(paper_url("arXiv:math/0211159").as_deref(), Some("https://arxiv.org/pdf/math/0211159"));
        assert_eq!(paper_url("10.1038/nature14539").as_deref(), Some("https://doi.org/10.1038/nature14539"));
        assert_eq!(paper_url("https://doi.org/10.1145/3290605.3300233").as_deref(), Some("https://doi.org/10.1145/3290605.3300233"));
        assert_eq!(paper_url("https://example.com/post"), None);
        assert_eq!(paper_url("math/0211159"), None);
    }

    #[test]
    fn youtube_links_of_every_form_give_the_id() {
        for url in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=42",
            "youtu.be/dQw4w9WgXcQ?si=abc",
            "https://m.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/live/dQw4w9WgXcQ",
        ] {
            assert_eq!(youtube_id(url).as_deref(), Some("dQw4w9WgXcQ"), "{url}");
        }
        assert_eq!(youtube_id("https://example.com/watch?v=dQw4w9WgXcQ"), None);
        assert_eq!(youtube_id("https://www.youtube.com/@channel"), None);
    }

    #[test]
    fn timed_lines_become_timestamped_paragraphs() {
        let lines = vec![(0, "Hello".to_string()), (20_000, "there".into()), (50_000, "Second  part".into()), (3_725_000, "late".into())];
        let page = &timed_pages(&lines)[0];
        assert_eq!(page.text, "[0:00] Hello there\n\n[0:50] Second part\n\n[1:02:05] late");
    }

    #[test]
    fn quotes_are_encoded_into_the_address() {
        let url = with_quote(&passage_url("ab12", 7), "cue (then)  routine");
        assert_eq!(url, "sushsrc:ab12/7?q=cue%20%28then%29%20routine");
        assert_eq!(parse_passage_url(&url), Some(("ab12", 7)));
    }

    #[test]
    fn search_ranks_by_bm25_over_checked_ready_sources_only() {
        let (_dir, store) = store();
        store.create_notebook("n1", "Habits", 1).unwrap();
        let a = ready("a", "n1", "Power of Habit");
        let mut b = ready("b", "n1", "Sleep");
        b.checked = false;
        for s in [&a, &b] {
            store.save_source(s, 1).unwrap();
        }
        store
            .set_source_chunks("a", &chunk(&text_pages("# Loop\n\nThe habit loop: cue, routine, reward.\n\nUnrelated text about weather.")))
            .unwrap();
        store.set_source_chunks("b", &chunk(&text_pages("Sleep habits and the habit loop of rest."))).unwrap();
        let mut a_ready = a.clone();
        a_ready.chunks = 1;
        store.save_source(&a_ready, 2).unwrap();

        let notebook = store.notebook("n1").unwrap().unwrap();
        let out = execute(&store, &notebook, SOURCE_SEARCH, &json!({ "query": "what is the habit loop?" }), &HashSet::new()).unwrap();
        let results = crate::message::search_results(&out).unwrap();
        assert_eq!(results.len(), 1, "unchecked source b stays out");
        assert!(results[0].source.starts_with("sushsrc:a/"));
        assert_eq!(results[0].title, "Power of Habit");
        assert!(out["text"].as_str().unwrap().contains("<passage id=\"sushsrc:a/"));

        let none = execute(&store, &notebook, SOURCE_SEARCH, &json!({ "query": "volcano" }), &HashSet::new()).unwrap();
        assert!(none.as_str().unwrap().starts_with("No passages matched"));
        assert!(execute(&store, &notebook, SOURCE_READ, &json!({ "source_id": "b" }), &HashSet::new()).is_err());
        let read = execute(&store, &notebook, SOURCE_READ, &json!({ "source_id": "a" }), &HashSet::new()).unwrap();
        assert_eq!(crate::message::search_results(&read).unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_notebook_removes_its_sources_and_returns_its_threads() {
        let (_dir, store) = store();
        store.create_notebook("n1", "Habits", 1).unwrap();
        store.save_source(&ready("a", "n1", "A"), 1).unwrap();
        store.set_source_chunks("a", &chunk(&text_pages("cue routine reward"))).unwrap();
        store.add_notebook_thread("n1", "t1", 2).unwrap();
        assert_eq!(store.notebook_for_thread("t1").unwrap().unwrap().id, "n1");
        assert_eq!(store.delete_notebook("n1").unwrap(), vec!["t1".to_string()]);
        assert!(store.notebook("n1").unwrap().is_none());
        assert!(store.source("a").unwrap().is_none());
        assert!(store.search_passages("cue", &["a".into()], 5).unwrap().is_empty());
        assert!(store.notebook_for_thread("t1").unwrap().is_none());
    }

    #[test]
    fn extras_round_trip_and_renaming_marks_it_named() {
        let (_dir, store) = store();
        store.create_notebook("n1", "Untitled notebook", 1).unwrap();
        store
            .update_notebook_extras("n1", |x, title| {
                assert_eq!(title, "Untitled notebook");
                x.emoji = Some("🎨".into());
                x.overview = Some(Overview { summary: "**Habits**".into(), questions: vec!["Why?".into()], sources_key: "a:1".into(), generated_at: 2 });
                Ok(Some("Habits".into()))
            })
            .unwrap();
        let n = store.notebook("n1").unwrap().unwrap();
        assert_eq!(n.title, "Habits");
        assert_eq!(n.extras.emoji.as_deref(), Some("🎨"));
        assert_eq!(n.extras.overview.as_ref().unwrap().questions, ["Why?"]);
        assert!(!n.extras.named);
        store.rename_notebook("n1", "My habits", 3).unwrap();
        let n = store.notebook("n1").unwrap().unwrap();
        assert!(n.extras.named);
        assert_eq!(n.extras.emoji.as_deref(), Some("🎨"), "renaming keeps the rest");
        // Serialised flat, as the UI reads it.
        let v = serde_json::to_value(&n).unwrap();
        assert_eq!(v["emoji"], "🎨");
        assert_eq!(v["overview"]["sourcesKey"], "a:1");
    }

    #[test]
    fn transcriptions_map_to_the_batch_pages() {
        let pages = parse_transcription("<page>One</page>\n<page number=\"2\">\nTwo\n</page>", &[7, 8]);
        assert_eq!(pages, vec![Page { number: Some(7), text: "One".into() }, Page { number: Some(8), text: "Two".into() }]);
        let untagged = parse_transcription("Just text", &[3, 4]);
        assert_eq!(untagged, vec![Page { number: Some(3), text: "Just text".into() }]);
    }

    #[test]
    fn studio_titles_come_off_the_top() {
        assert_eq!(split_title("# Briefing: Habits\n\nBody."), (Some("Briefing: Habits".into()), "Body.".into()));
        assert_eq!(split_title("No heading"), (None, "No heading".into()));
    }

    #[test]
    fn notes_belong_to_their_notebook_and_studio_threads_find_them() {
        let (_dir, store) = store();
        store.create_notebook("n1", "Habits", 1).unwrap();
        let note = Note {
            id: "x".into(),
            notebook_id: "n1".into(),
            kind: NoteKind::Faq,
            title: "FAQ".into(),
            body: String::new(),
            status: NoteStatus::Writing,
            error: None,
            thread_id: Some("t9".into()),
            data: None,
            created_at: 2,
            updated_at: 2,
        };
        store.save_note(&note, 2).unwrap();
        let (nb, found) = store.studio_for_thread("t9").unwrap().unwrap();
        assert_eq!((nb.id.as_str(), found.id.as_str()), ("n1", "x"));
        assert_eq!(nb.notes.len(), 1);
        store.update_note("x", 3, |n| {
            n.status = NoteStatus::Ready;
            Ok(())
        })
        .unwrap();
        assert_eq!(store.note("x").unwrap().unwrap().status, NoteStatus::Ready);
        assert_eq!(store.delete_notebook("n1").unwrap(), vec!["t9".to_string()]);
        assert!(store.note("x").unwrap().is_none());
    }

    #[test]
    fn studio_saves_are_checked_and_tidied() {
        let mut note = Note {
            id: "q".into(),
            notebook_id: "n".into(),
            kind: NoteKind::Quiz,
            title: "Quiz".into(),
            body: String::new(),
            status: NoteStatus::Writing,
            error: None,
            thread_id: None,
            data: None,
            created_at: 1,
            updated_at: 1,
        };
        let q = |answer: u64| json!({ "question": "Q?", "options": ["a", "b"], "answer": answer, "explanation": "e", "source": "sushsrc:s/1" });
        assert!(save_studio(&mut note, &json!({ "title": "T", "questions": [q(0), q(1), q(2)] })).unwrap_err().contains("index"));
        save_studio(&mut note, &json!({ "title": "Habits quiz", "questions": [q(0), q(1), q(0)] })).unwrap();
        assert_eq!(note.title, "Habits quiz");
        assert_eq!(note.data.as_ref().unwrap()["questions"][1]["source"], "sushsrc:s/1");

        note.kind = NoteKind::MindMap;
        assert!(save_studio(&mut note, &json!({ "title": "M", "root": { "label": "Habits" } })).is_err());
        save_studio(&mut note, &json!({ "title": "M", "root": { "label": "Habits", "source": "https://x", "children": [{ "label": "Cue" }, { "label": " " }] } }))
            .unwrap();
        let root = &note.data.as_ref().unwrap()["root"];
        assert_eq!(root["children"].as_array().unwrap().len(), 1, "blank labels are dropped");
        assert!(root["source"].is_null(), "only passage ids are kept as sources");
        assert_eq!(studio_save_spec(NoteKind::MindMap).input_schema["required"][1], "root");

        note.kind = NoteKind::AudioOverview;
        let turn = |h: &str| json!({ "host": h, "text": "Words.", "source": "sushsrc:s/2" });
        assert!(save_studio(&mut note, &json!({ "title": "A", "chapters": [{ "title": "One", "turns": [turn("a"), turn("b")] }] })).is_err());
        let turns: Vec<Value> = ["a", "b", "A", "x", "b", "a", "b"].iter().map(|h| turn(h)).collect();
        save_studio(&mut note, &json!({ "title": "Talk", "chapters": [{ "title": "One", "turns": turns }] })).unwrap();
        let saved = &note.data.as_ref().unwrap()["chapters"][0]["turns"];
        assert_eq!(saved.as_array().unwrap().len(), 6, "an unknown host is dropped");
        assert_eq!(saved[2]["host"], "a", "hosts are lower-cased");
    }

    #[test]
    fn guests_get_titles_and_outputs_but_not_notes_text_or_other_notebooks_passages() {
        let (_dir, store) = store();
        store.create_notebook("n1", "Habits", 1).unwrap();
        store.create_notebook("n2", "Other", 1).unwrap();
        store.save_source(&ready("a", "n1", "Mine"), 1).unwrap();
        store.save_source(&ready("b", "n2", "Theirs"), 1).unwrap();
        store.set_source_chunks("a", &chunk(&text_pages("cue routine reward"))).unwrap();
        store.set_source_chunks("b", &chunk(&text_pages("secret plans"))).unwrap();
        let note = |id: &str, kind: NoteKind, data: Option<Value>| Note {
            id: id.into(),
            notebook_id: "n1".into(),
            kind,
            title: id.into(),
            body: "body".into(),
            status: NoteStatus::Ready,
            error: None,
            thread_id: None,
            data,
            created_at: 2,
            updated_at: 2,
        };
        store.save_note(&note("private", NoteKind::Note, None), 2).unwrap();
        let script = json!({ "chapters": [{ "title": "One", "turns": [{ "host": "a", "text": "Hi", "audio": "sushblob://localhost/x" }] }], "voices": "k" });
        store.save_note(&note("talk", NoteKind::AudioOverview, Some(script)), 2).unwrap();

        let n1 = store.notebook("n1").unwrap().unwrap();
        let view = guest_view(&n1);
        assert_eq!(view["sources"][0]["title"], "Mine");
        assert!(view["sources"][0].get("text").is_none());
        let outputs = view["outputs"].as_array().unwrap();
        assert_eq!(outputs.len(), 1, "the owner's own notes stay private");
        assert!(outputs[0]["data"]["chapters"][0]["turns"][0].get("audio").is_none());
        assert!(outputs[0]["data"].get("voices").is_none());

        let mine = store.source_passages("a", None, None, 1).unwrap()[0].id;
        let theirs = store.source_passages("b", None, None, 1).unwrap()[0].id;
        assert_eq!(guest_passage(&store, &n1, &passage_url("a", mine)).unwrap()["text"], "cue routine reward");
        assert!(guest_passage(&store, &n1, &passage_url("b", theirs)).is_err(), "another notebook's source");
        // A real source of this notebook with a chunk id from elsewhere.
        assert!(guest_passage(&store, &n1, &passage_url("a", theirs)).is_err());
    }

    #[test]
    fn a_search_skips_passages_this_turn_already_showed() {
        let (_dir, store) = store();
        store.create_notebook("n1", "Habits", 1).unwrap();
        let mut a = ready("a", "n1", "Habits");
        store.save_source(&a, 1).unwrap();
        let text = (0..4).map(|i| format!("Habit loop part {i}. {}", "Cue routine reward. ".repeat(70))).collect::<Vec<_>>().join("\n\n");
        let chunks = chunk(&text_pages(&text));
        assert!(chunks.len() >= 3);
        store.set_source_chunks("a", &chunks).unwrap();
        a.chunks = chunks.len() as u32;
        store.save_source(&a, 2).unwrap();
        let notebook = store.notebook("n1").unwrap().unwrap();
        let search = |seen: &HashSet<String>| execute(&store, &notebook, SOURCE_SEARCH, &json!({ "query": "habit loop", "limit": 1 }), seen).unwrap();

        let first = search(&HashSet::new());
        let shown = crate::message::search_results(&first).unwrap()[0].source.clone();
        assert!(first.get(SEARCH_NOTE).is_none());
        // As the thread keeps it: the user's question, then the call's output.
        let thread = vec![
            json!({ "role": "user", "parts": [{ "type": "text", "text": "loop?" }] }),
            json!({ "role": "assistant", "parts": [{ "type": "dynamic-tool", "state": "output-available", "output": first }] }),
        ];
        let seen = seen_this_turn(&thread);
        assert_eq!(seen, HashSet::from([shown.clone()]));
        let second = search(&seen);
        let results = crate::message::search_results(&second).unwrap();
        assert_eq!(results.len(), 1);
        assert_ne!(results[0].source, shown, "a new passage takes the shown one's place");
        assert!(second[SEARCH_NOTE].as_str().unwrap().contains(&shown));
        assert!(second["text"].as_str().unwrap().contains(&shown));
        // A new question starts a new turn: nothing counts as shown.
        let mut next = thread.clone();
        next.push(json!({ "role": "user", "parts": [{ "type": "text", "text": "more" }] }));
        assert!(seen_this_turn(&next).is_empty());
    }

    #[test]
    fn earlier_turns_passages_are_cut_to_a_line() {
        let passages = json!({ SEARCH_RESULTS: [{ "source": "sushsrc:a/1", "title": "Habits · p. 2", "text": "long text" }], "text": "long text" });
        let call = |id: &str| Part::ToolCall { id: id.into(), name: SOURCE_SEARCH.into(), input: json!({}) };
        let result = |id: &str| Part::ToolResult { call_id: id.into(), output: passages.clone(), is_error: false };
        let user = |t: &str| Message { role: Role::User, parts: vec![Part::Text { text: t.into() }] };
        let mut messages = vec![
            user("first"),
            Message { role: Role::Assistant, parts: vec![call("c1"), result("c1")] },
            Message { role: Role::Assistant, parts: vec![Part::Text { text: "answer".into() }] },
            user("second"),
            Message { role: Role::Assistant, parts: vec![call("c2"), result("c2")] },
        ];
        assert_eq!(compact_earlier_passages(&mut messages), 1);
        let Part::ToolResult { output, .. } = &messages[1].parts[1] else { panic!("expected a result") };
        let line = output.as_str().unwrap();
        assert!(line.contains("sushsrc:a/1") && line.contains("Habits · p. 2") && !line.contains("long text"));
        let Part::ToolResult { output, .. } = &messages[4].parts[1] else { panic!("expected a result") };
        assert_eq!(output, &passages, "this turn's passages stay whole");
        assert_eq!(compact_earlier_passages(&mut messages), 0, "cut once");
    }

    #[test]
    fn the_overview_key_ignores_which_sources_are_ticked() {
        let mut n = Notebook {
            id: "n".into(),
            title: "N".into(),
            created_at: 1,
            updated_at: 1,
            sources: vec![ready("a", "n", "A"), ready("b", "n", "B")],
            thread_ids: vec![],
            notes: vec![],
            extras: NotebookExtras::default(),
        };
        let key = sources_key(&n);
        n.sources[1].checked = false;
        assert_eq!(sources_key(&n), key);
        n.sources[1].status = SourceStatus::Failed;
        assert_ne!(sources_key(&n), key);
    }

    #[test]
    fn match_query_drops_stop_words_and_quotes_terms() {
        assert_eq!(match_query("What is the habit loop?").as_deref(), Some("\"habit\" OR \"loop\""));
        assert_eq!(match_query("the").as_deref(), Some("\"the\""));
        assert_eq!(match_query("  ?! "), None);
        assert_eq!(match_query("AND OR \"x\"").as_deref(), Some("\"x\""));
    }
}
