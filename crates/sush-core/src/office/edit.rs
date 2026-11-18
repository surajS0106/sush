//! Editing a Word document in place, keeping its formatting. The model can't produce a .docx, so it
//! describes changes against the text it was shown (`super::extract`) and these are applied to the
//! document's XML: replaced text takes the formatting of the text it replaces, and new paragraphs
//! copy an existing paragraph's style, bullets and indentation (and, across tabs, each part's run
//! formatting, so a "Title<tab>Dates" line keeps its italic title and bold dates). Everything else
//! in the file, its styles, numbering, headers, images and links outside the edited text, is copied
//! as it was.
//!
//! The scanner works on byte offsets in `word/document.xml` and edits splice that text, rescanning
//! after each edit, which is plenty for documents of a few hundred paragraphs.

use std::io::{Cursor, Write};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::unescape;

/// One change. Exactly one of `replace`, `insert_after`, `insert_before` and `delete` is set.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Edit {
    /// Text to find (once, within one paragraph) and replace with `with`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub with: Option<String>,
    /// A paragraph (its text, or enough of it to match once) to add `paragraphs` after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert_after: Option<String>,
    /// A paragraph to add `paragraphs` before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert_before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paragraphs: Option<Vec<NewParagraph>>,
    /// A paragraph to remove.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete: Option<String>,
}

/// A paragraph to add: its text, formatted like the anchor paragraph or like `like`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum NewParagraph {
    Text(String),
    Styled {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        like: Option<String>,
    },
}

const DOCUMENT: &str = "word/document.xml";

/// The document with `edits` applied in order. All or nothing: the first edit that can't be applied
/// fails the whole call, with a message saying which edit and why.
pub fn edit_docx(bytes: &[u8], edits: &[Edit]) -> Result<Vec<u8>, String> {
    if edits.is_empty() {
        return Err("No edits given.".into());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "This isn't a readable Word document.".to_string())?;
    let mut xml = super::part(&mut zip, DOCUMENT).ok_or("This Word document has no readable body.")?;
    for (n, edit) in edits.iter().enumerate() {
        xml = apply(&xml, edit).map_err(|e| format!("Edit {} of {}: {e}", n + 1, edits.len()))?;
    }
    rezip(bytes, &xml)
}

/// The archive again, with the body replaced and every other part copied byte for byte.
fn rezip(bytes: &[u8], document: &str) -> Result<Vec<u8>, String> {
    let fail = |e: zip::result::ZipError| format!("Couldn't write the document: {e}");
    let mut src = zip::ZipArchive::new(Cursor::new(bytes)).map_err(fail)?;
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for i in 0..src.len() {
        let file = src.by_index_raw(i).map_err(fail)?;
        if file.name().is_ok_and(|name| name == DOCUMENT) {
            drop(file);
            let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            out.start_file(DOCUMENT, options).map_err(fail)?;
            out.write_all(document.as_bytes()).map_err(|e| format!("Couldn't write the document: {e}"))?;
        } else {
            out.raw_copy_file(file).map_err(fail)?;
        }
    }
    Ok(out.finish().map_err(fail)?.into_inner())
}

fn apply(xml: &str, edit: &Edit) -> Result<String, String> {
    let set = [edit.replace.is_some(), edit.insert_after.is_some(), edit.insert_before.is_some(), edit.delete.is_some()];
    if set.iter().filter(|&&s| s).count() != 1 {
        return Err("give exactly one of `replace` (with `with`), `insert_after`, `insert_before` or `delete`.".into());
    }
    let doc = Doc::scan(xml)?;
    let (range, text) = if let Some(find) = &edit.replace {
        let with = edit.with.as_deref().ok_or("`replace` needs `with` (an empty string removes the text).")?;
        doc.replace(find, with)?
    } else if let Some(target) = &edit.delete {
        doc.delete(target)?
    } else {
        let (anchor, before) = match (&edit.insert_after, &edit.insert_before) {
            (Some(a), _) => (a, false),
            (_, Some(b)) => (b, true),
            _ => unreachable!(),
        };
        let paragraphs = edit.paragraphs.as_deref().filter(|p| !p.is_empty()).ok_or("an insert needs `paragraphs`.")?;
        doc.insert(anchor, paragraphs, before)?
    };
    Ok(format!("{}{}{}", &xml[..range.0], text, &xml[range.1..]))
}

// --- the document's structure -------------------------------------------------------------

struct Elem<'a> {
    /// Qualified name, e.g. `w:p`.
    name: &'a str,
    start: usize,
    /// Just past the opening tag.
    open_end: usize,
    /// Just past the closing tag (the opening tag, for an empty element).
    end: usize,
    parent: Option<usize>,
    /// A run holding something that isn't plain text (an image, a field, a note reference), which
    /// rebuilding the run would lose.
    complex: bool,
}

/// A character of a paragraph's text: from a `w:t`, or a tab or line break in a run.
struct Ch {
    c: char,
    /// Byte offset of the text node or element it comes from.
    at: usize,
    run: usize,
    para: usize,
}

struct Doc<'a> {
    xml: &'a str,
    elems: Vec<Elem<'a>>,
    chars: Vec<Ch>,
    /// `w:p` elements in document order.
    paras: Vec<usize>,
}

const MALFORMED: &str = "the document's XML couldn't be read.";

impl<'a> Doc<'a> {
    fn scan(xml: &'a str) -> Result<Self, String> {
        let mut elems: Vec<Elem> = Vec::new();
        let mut chars = Vec::new();
        let mut stack: Vec<usize> = Vec::new();
        let nearest = |stack: &[usize], elems: &[Elem], name: &str| stack.iter().rev().copied().find(|&i| elems[i].name == name);
        let mut i = 0;
        while i < xml.len() {
            let rest = &xml[i..];
            if !rest.starts_with('<') {
                let end = rest.find('<').map_or(xml.len(), |k| i + k);
                if let Some(&top) = stack.last() {
                    let run = elems[top].parent.filter(|&r| elems[r].name == "w:r");
                    if let (true, Some(run), Some(para)) = (elems[top].name == "w:t", run, nearest(&stack, &elems, "w:p")) {
                        chars.extend(unescape(&xml[i..end]).chars().map(|c| Ch { c, at: i, run, para }));
                    }
                }
                i = end;
                continue;
            }
            if rest.starts_with("<!--") {
                i = rest.find("-->").map_or(xml.len(), |k| i + k + 3);
                continue;
            }
            if rest.starts_with("<?") || rest.starts_with("<!") {
                i = rest.find('>').map_or(xml.len(), |k| i + k + 1);
                continue;
            }
            let close = rest.find('>').ok_or(MALFORMED)? + i;
            let tag = &xml[i + 1..close];
            if let Some(name) = tag.strip_prefix('/') {
                let open = stack.pop().ok_or(MALFORMED)?;
                if elems[open].name != name.trim() {
                    return Err(MALFORMED.into());
                }
                elems[open].end = close + 1;
                i = close + 1;
                continue;
            }
            let empty = tag.ends_with('/');
            let name = tag.trim_end_matches('/').split(|c: char| c.is_whitespace()).next().unwrap_or("");
            let parent = stack.last().copied();
            let idx = elems.len();
            elems.push(Elem { name, start: i, open_end: close + 1, end: close + 1, parent, complex: false });
            let run = nearest(&stack, &elems, "w:r");
            if matches!(
                name,
                "w:drawing" | "w:pict" | "w:object" | "w:fldChar" | "w:instrText" | "w:footnoteReference" | "w:endnoteReference" | "w:commentReference" | "w:ruby" | "mc:AlternateContent"
            ) {
                if let Some(r) = run {
                    elems[r].complex = true;
                }
            }
            let in_run = parent.is_some_and(|p| elems[p].name == "w:r");
            if in_run && matches!(name, "w:tab" | "w:br" | "w:cr") {
                if let Some(para) = nearest(&stack, &elems, "w:p") {
                    chars.push(Ch { c: if name == "w:tab" { '\t' } else { '\n' }, at: i, run: parent.unwrap(), para });
                }
            }
            if !empty {
                stack.push(idx);
            }
            i = close + 1;
        }
        if !stack.is_empty() {
            return Err(MALFORMED.into());
        }
        let paras = elems.iter().enumerate().filter(|(_, e)| e.name == "w:p").map(|(i, _)| i).collect();
        Ok(Doc { xml, elems, chars, paras })
    }

    fn raw(&self, e: usize) -> &'a str {
        &self.xml[self.elems[e].start..self.elems[e].end]
    }

    fn child(&self, parent: usize, name: &str) -> Option<usize> {
        let p = &self.elems[parent];
        (parent + 1..self.elems.len())
            .take_while(|&i| self.elems[i].start < p.end)
            .find(|&i| self.elems[i].parent == Some(parent) && self.elems[i].name == name)
    }

    /// A run's formatting, as its `w:rPr` element (or nothing).
    fn rpr(&self, run: usize) -> String {
        self.child(run, "w:rPr").map(|r| self.raw(r).to_string()).unwrap_or_default()
    }

    fn ppr(&self, para: usize) -> &'a str {
        self.child(para, "w:pPr").map(|p| self.raw(p)).unwrap_or("")
    }

    /// A paragraph's characters, as indices into `chars`.
    fn para_chars(&self, para: usize) -> Vec<usize> {
        let e = &self.elems[para];
        let from = self.chars.partition_point(|c| c.at < e.start);
        (from..self.chars.len()).take_while(|&i| self.chars[i].at < e.end).filter(|&i| self.chars[i].para == para).collect()
    }

    fn para_text(&self, para: usize) -> Vec<char> {
        self.para_chars(para).into_iter().map(|i| self.chars[i].c).collect()
    }

    // --- finding text ----------------------------------------------------------------------

    /// Where `find` occurs: (paragraph, start, end) in the paragraph's characters. Exact matches
    /// first, else ignoring differences in spacing, quotes and dashes.
    fn find_text(&self, find: &str) -> Vec<(usize, usize, usize)> {
        let exact: Vec<char> = find.chars().collect();
        let mut hits = Vec::new();
        if !exact.is_empty() {
            for &p in &self.paras {
                let text = self.para_text(p);
                hits.extend(occurrences(&text, &exact).into_iter().map(|a| (p, a, a + exact.len())));
            }
        }
        if !hits.is_empty() {
            return hits;
        }
        let needle = normalized_needle(find);
        if needle.is_empty() {
            return hits;
        }
        for &p in &self.paras {
            let norm = Norm::of(&self.para_text(p));
            for k in occurrences(&norm.chars, &needle) {
                hits.push((p, norm.start[k], norm.end[k + needle.len() - 1]));
            }
        }
        hits
    }

    /// The one paragraph `anchor` names: the paragraph whose whole text it is, else the one paragraph
    /// containing it.
    fn find_para(&self, anchor: &str) -> Result<usize, String> {
        let needle = normalized_needle(strip_markdown(anchor));
        if needle.is_empty() {
            return Err("an empty paragraph can't be matched; give some of its text.".into());
        }
        let texts: Vec<(usize, Vec<char>)> = self
            .paras
            .iter()
            .map(|&p| {
                let mut n = Norm::of(&self.para_text(p)).chars;
                while n.last() == Some(&' ') {
                    n.pop();
                }
                while n.first() == Some(&' ') {
                    n.remove(0);
                }
                (p, n)
            })
            .collect();
        let whole: Vec<usize> = texts.iter().filter(|(_, t)| *t == needle).map(|(p, _)| *p).collect();
        let found = if whole.is_empty() {
            texts.iter().filter(|(_, t)| !occurrences(t, &needle).is_empty()).map(|(p, _)| *p).collect()
        } else {
            whole
        };
        match found.as_slice() {
            [p] => Ok(*p),
            [] => Err(format!("no paragraph matches \"{}\". Use text copied from the document.", clip(anchor))),
            many => Err(format!("\"{}\" matches {} paragraphs; give more of the paragraph's text.", clip(anchor), many.len())),
        }
    }

    // --- edits -----------------------------------------------------------------------------

    fn replace(&self, find: &str, with: &str) -> Result<((usize, usize), String), String> {
        let hits = self.find_text(find);
        let (para, a, b) = match hits.as_slice() {
            [hit] => *hit,
            [] => {
                return Err(format!(
                    "couldn't find \"{}\". Copy the text exactly from the document, within one paragraph (to add or remove whole paragraphs, use insert_after or delete).",
                    clip(find)
                ))
            }
            many => return Err(format!("\"{}\" appears {} times; include more of the surrounding text so it matches once.", clip(find), many.len())),
        };
        let ids = self.para_chars(para);
        let (first, last) = (ids[a], ids[b - 1]);
        let (from, to, parent) = self.span(self.chars[first].run, self.chars[last].run, para);
        let (start, end) = (self.elems[from].start, self.elems[to].end);
        if self.elems.iter().any(|e| e.complex && e.start >= start && e.end <= end) {
            return Err(format!(
                "\"{}\" runs into a picture, field or note reference, which this edit would remove. Replace a shorter piece of text.",
                clip(find)
            ));
        }

        let mut seq: Vec<(char, String)> = Vec::new();
        let mut rprs = std::collections::HashMap::new();
        let mut rpr_of = |run: usize| rprs.entry(run).or_insert_with(|| self.rpr(run)).clone();
        let in_span: Vec<usize> = (0..self.chars.len()).filter(|&i| self.chars[i].at >= start && self.chars[i].at < end).collect();
        let host = rpr_of(self.chars[first].run);
        for &i in &in_span {
            if i == first {
                seq.extend(styled(with, &host));
            }
            if i < first || i > last {
                seq.push((self.chars[i].c, rpr_of(self.chars[i].run)));
            }
        }
        // Bookmarks and the like between the runs are kept, after the new text.
        let kept: String = (from..=to)
            .filter(|&i| self.elems[i].parent == Some(parent) && self.elems[i].name != "w:r" && self.elems[i].name != "w:proofErr")
            .filter(|&i| !in_span.iter().any(|&c| self.chars[c].at >= self.elems[i].start && self.chars[c].at < self.elems[i].end))
            .map(|i| self.raw(i))
            .collect();
        Ok(((start, end), format!("{}{kept}", runs_xml(&seq))))
    }

    /// The children of the two runs' closest common ancestor that hold them: the range to rebuild,
    /// as (first child, last child, ancestor). Within a link, that keeps the link.
    fn span(&self, r0: usize, r1: usize, para: usize) -> (usize, usize, usize) {
        let chain = |mut e: usize| {
            let mut out = vec![e];
            while e != para {
                match self.elems[e].parent {
                    Some(p) => {
                        out.push(p);
                        e = p;
                    }
                    None => break,
                }
            }
            out
        };
        let (c0, c1) = (chain(r0), chain(r1));
        if r0 == r1 {
            return (r0, r0, self.elems[r0].parent.unwrap_or(para));
        }
        let lca = *c0.iter().find(|e| c1.contains(e)).unwrap_or(&para);
        let below = |c: &[usize]| c.iter().position(|&e| e == lca).filter(|&k| k > 0).map(|k| c[k - 1]).unwrap_or(c[0]);
        (below(&c0), below(&c1), lca)
    }

    fn delete(&self, target: &str) -> Result<((usize, usize), String), String> {
        let para = self.find_para(target)?;
        let ppr = self.ppr(para);
        if ppr.contains("<w:sectPr") {
            return Err("that paragraph holds the page setup of its section; replace its text instead of deleting it.".into());
        }
        let e = &self.elems[para];
        // A table cell must keep a paragraph.
        let cell = e.parent.filter(|&c| self.elems[c].name == "w:tc");
        if let Some(cell) = cell {
            let paras_in_cell = self.paras.iter().filter(|&&p| self.elems[p].parent == Some(cell)).count();
            if paras_in_cell == 1 {
                return Ok(((e.start, e.end), format!("{}{ppr}</w:p>", self.open_tag(para))));
            }
        }
        Ok(((e.start, e.end), String::new()))
    }

    fn insert(&self, anchor: &str, paragraphs: &[NewParagraph], before: bool) -> Result<((usize, usize), String), String> {
        let at = self.find_para(anchor)?;
        let mut out = String::new();
        for p in paragraphs {
            let (text, like) = match p {
                NewParagraph::Text(t) => (t.as_str(), None),
                NewParagraph::Styled { text, like } => (text.as_str(), like.as_deref()),
            };
            let model = match like {
                Some(like) => self.find_para(like).map_err(|e| format!("`like`: {e}"))?,
                None => at,
            };
            out.push_str(&self.new_para(model, text));
        }
        let pos = if before { self.elems[at].start } else { self.elems[at].end };
        Ok(((pos, pos), out))
    }

    /// A paragraph's opening tag, without the ids Word expects to be unique.
    fn open_tag(&self, para: usize) -> String {
        static IDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\s+w14:(?:paraId|textId)="[^"]*""#).unwrap());
        let e = &self.elems[para];
        let tag = &self.xml[e.start..e.open_end];
        let tag = tag.strip_suffix("/>").map(|t| format!("{t}>")).unwrap_or_else(|| tag.to_string());
        IDS.replace_all(&tag, "").into_owned()
    }

    /// A new paragraph with `text`, formatted like `model`.
    fn new_para(&self, model: usize, text: &str) -> String {
        static SECT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<w:sectPr\b(?:[^>]*/>|.*?</w:sectPr>)").unwrap());
        static MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<w:rPr\b(?:[^>]*/>|.*?</w:rPr>)").unwrap());
        let ppr = SECT.replace_all(self.ppr(model), "").into_owned();
        let ids = self.para_chars(model);
        // The formatting of each tab-separated part of the model paragraph.
        let mut parts: Vec<String> = Vec::new();
        let mut want = true;
        for &i in &ids {
            match self.chars[i].c {
                '\t' => want = true,
                _ if want => {
                    parts.push(self.rpr(self.chars[i].run));
                    want = false;
                }
                _ => {}
            }
        }
        if parts.is_empty() {
            // An empty paragraph: its paragraph mark's formatting is the best guess.
            parts.push(MARK.find(&ppr).map(|m| m.as_str().to_string()).unwrap_or_default());
        }
        let list = ppr.contains("<w:numPr");
        let mut text = strip_heading(text.trim_end());
        if list {
            text = strip_bullet(text);
        }
        let mut seq = Vec::new();
        for (k, part) in text.split('\t').enumerate() {
            if k > 0 {
                seq.push(('\t', parts[(k - 1).min(parts.len() - 1)].clone()));
            }
            seq.extend(styled(part, &parts[k.min(parts.len() - 1)]));
        }
        format!("{}{ppr}{}</w:p>", self.open_tag(model), runs_xml(&seq))
    }
}

// --- text matching ------------------------------------------------------------------------

/// Where `needle` starts in `hay`, every time.
fn occurrences(hay: &[char], needle: &[char]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return Vec::new();
    }
    (0..=hay.len() - needle.len()).filter(|&i| hay[i..i + needle.len()] == *needle).collect()
}

/// Characters that look alike, made the same.
fn fold(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201B}' | '\u{2032}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{2033}' => '"',
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
        c => c,
    }
}

/// Text with whitespace runs collapsed to one space and look-alikes folded, with where each of its
/// characters came from.
struct Norm {
    chars: Vec<char>,
    start: Vec<usize>,
    end: Vec<usize>,
}

impl Norm {
    fn of(text: &[char]) -> Self {
        let mut n = Norm { chars: Vec::new(), start: Vec::new(), end: Vec::new() };
        let mut i = 0;
        while i < text.len() {
            if text[i].is_whitespace() {
                let mut j = i;
                while j < text.len() && text[j].is_whitespace() {
                    j += 1;
                }
                n.chars.push(' ');
                n.start.push(i);
                n.end.push(j);
                i = j;
            } else {
                n.chars.push(fold(text[i]));
                n.start.push(i);
                n.end.push(i + 1);
                i += 1;
            }
        }
        n
    }
}

/// What the model wrote, normalised like `Norm`, without Markdown bold markers.
fn normalized_needle(s: &str) -> Vec<char> {
    let s = s.replace("**", "");
    let chars: Vec<char> = s.trim().chars().collect();
    Norm::of(&chars).chars
}

/// The Markdown the extracted text adds in front of a paragraph (heading marks, bullets).
fn strip_markdown(s: &str) -> &str {
    strip_bullet(strip_heading(s.trim()))
}

fn strip_heading(s: &str) -> &str {
    let t = s.trim_start_matches('#');
    if t.len() < s.len() && t.starts_with(' ') && s.len() - t.len() <= 6 {
        t.trim_start()
    } else {
        s
    }
}

fn strip_bullet(s: &str) -> &str {
    let t = s.trim_start();
    for b in ["- ", "* ", "• ", "● ", "▪ "] {
        if let Some(rest) = t.strip_prefix(b) {
            return rest.trim_start();
        }
    }
    s
}

fn clip(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() > 80 {
        format!("{}…", s.chars().take(77).collect::<String>())
    } else {
        s.to_string()
    }
}

// --- writing runs -------------------------------------------------------------------------

/// `text` as characters formatted with `rpr`. `**bold**` markers set bold explicitly: marked parts
/// bold, the rest not; without markers the formatting is used as it is.
fn styled(text: &str, rpr: &str) -> Vec<(char, String)> {
    let marks = text.matches("**").count();
    if marks == 0 || marks % 2 == 1 {
        return text.chars().map(|c| (c, rpr.to_string())).collect();
    }
    let (plain, bold) = (set_bold(rpr, false), set_bold(rpr, true));
    text.split("**")
        .enumerate()
        .flat_map(|(k, part)| {
            let f = if k % 2 == 1 { &bold } else { &plain };
            part.chars().map(move |c| (c, f.clone()))
        })
        .collect()
}

/// Run formatting with bold turned on or off. `w:b` goes where the schema puts it, after the style
/// and fonts, since Word rejects run properties out of order.
fn set_bold(rpr: &str, on: bool) -> String {
    static BOLD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<w:b(?:Cs)?(?:\s[^>]*)?/>").unwrap());
    static BEFORE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<w:(?:rStyle|rFonts)\b[^>]*/>").unwrap());
    let (open, inner) = match rpr.find('>') {
        Some(gt) if !rpr[..=gt].ends_with("/>") => (&rpr[..=gt], rpr[gt + 1..].strip_suffix("</w:rPr>").unwrap_or(&rpr[gt + 1..])),
        _ => ("<w:rPr>", ""),
    };
    let mut inner = BOLD.replace_all(inner, "").into_owned();
    if on {
        let at = BEFORE.find_iter(&inner).last().map_or(0, |m| m.end());
        inner.insert_str(at, "<w:b/><w:bCs/>");
    }
    if inner.is_empty() {
        String::new()
    } else {
        format!("{open}{inner}</w:rPr>")
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Characters as runs, one per stretch of the same formatting.
fn runs_xml(seq: &[(char, String)]) -> String {
    let mut out = String::new();
    let mut k = 0;
    while k < seq.len() {
        let rpr = &seq[k].1;
        out.push_str("<w:r>");
        out.push_str(rpr);
        let mut text = String::new();
        let flush = |text: &mut String, out: &mut String| {
            if !text.is_empty() {
                out.push_str(&format!("<w:t xml:space=\"preserve\">{}</w:t>", escape(text)));
                text.clear();
            }
        };
        while k < seq.len() && seq[k].1 == *rpr {
            match seq[k].0 {
                '\t' => {
                    flush(&mut text, &mut out);
                    out.push_str("<w:tab/>");
                }
                '\n' => {
                    flush(&mut text, &mut out);
                    out.push_str("<w:br/>");
                }
                c => text.push(c),
            }
            k += 1;
        }
        flush(&mut text, &mut out);
        out.push_str("</w:r>");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::{extract, Kind};
    use super::*;
    use std::io::Write;

    const BOLD: &str = "<w:rPr><w:rFonts w:ascii=\"Times\"/><w:b/></w:rPr>";
    const ITALIC: &str = "<w:rPr><w:i/></w:rPr>";

    fn body(paras: &str) -> String {
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="w" xmlns:w14="w14"><w:body>{paras}<w:sectPr><w:pgSz w:w="12240"/></w:sectPr></w:body></w:document>"#)
    }

    fn resume() -> String {
        body(&format!(
            concat!(
                r#"<w:p w14:paraId="1A"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>EXPERIENCE</w:t></w:r></w:p>"#,
                r#"<w:p><w:r>{bold}<w:t>Synergech Technologies, Chennai</w:t></w:r></w:p>"#,
                r#"<w:p><w:r>{italic}<w:t>Software Engineer</w:t></w:r><w:r><w:tab/></w:r><w:r>{bold}<w:t>May 2025 – Present</w:t></w:r></w:p>"#,
                r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Led a team of </w:t></w:r><w:r>{bold}<w:t>5 engineers</w:t></w:r><w:r><w:t> to build InfraGenie.</w:t></w:r></w:p>"#,
                r#"<w:p><w:r><w:t>Contact: </w:t></w:r><w:hyperlink r:id="rId5"><w:r><w:t>GitHub</w:t></w:r></w:hyperlink></w:p>"#,
            ),
            bold = BOLD,
            italic = ITALIC
        ))
    }

    fn docx(document: &str) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("[Content_Types].xml", options).unwrap();
            zip.write_all(b"<Types/>").unwrap();
            zip.start_file(DOCUMENT, options).unwrap();
            zip.write_all(document.as_bytes()).unwrap();
            zip.start_file("word/styles.xml", options).unwrap();
            zip.write_all(b"<w:styles/>").unwrap();
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    fn document_of(bytes: &[u8]) -> String {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        super::super::part(&mut zip, DOCUMENT).unwrap()
    }

    fn edit(xml: &str, e: Edit) -> String {
        apply(xml, &e).unwrap()
    }

    #[test]
    fn replace_keeps_the_formatting_of_the_replaced_text() {
        let xml = resume();
        let out = edit(&xml, Edit { replace: Some("5 engineers".into()), with: Some("7 engineers".into()), ..Default::default() });
        assert!(out.contains(&format!("<w:r>{BOLD}<w:t xml:space=\"preserve\">7 engineers</w:t></w:r>")));
        assert!(out.contains("Led a team of "));
        assert!(out.contains("<w:numPr>"));
    }

    #[test]
    fn replace_across_runs_and_loose_spacing() {
        let xml = resume();
        // Spans three runs, with a plain hyphen for the en dash elsewhere and doubled spaces.
        let out = edit(&xml, Edit { replace: Some("team of  5 engineers to".into()), with: Some("group of **six** engineers to".into()), ..Default::default() });
        let doc = Doc::scan(&out).unwrap();
        let p = doc.find_para("Led a group").unwrap();
        assert_eq!(doc.para_text(p).into_iter().collect::<String>(), "Led a group of six engineers to build InfraGenie.");
        assert!(out.contains("<w:b/><w:bCs/></w:rPr><w:t xml:space=\"preserve\">six</w:t>"));
        let dates = edit(&xml, Edit { replace: Some("May 2025 - Present".into()), with: Some("May 2025 – Dec 2026".into()), ..Default::default() });
        assert!(dates.contains("Dec 2026"));
    }

    #[test]
    fn replace_inside_a_link_keeps_the_link() {
        let out = edit(&resume(), Edit { replace: Some("GitHub".into()), with: Some("GitHub Profile".into()), ..Default::default() });
        assert!(out.contains(r#"<w:hyperlink r:id="rId5"><w:r><w:t xml:space="preserve">GitHub Profile</w:t></w:r></w:hyperlink>"#));
    }

    #[test]
    fn insert_copies_style_bullets_and_tab_parts() {
        let xml = resume();
        let out = edit(
            &xml,
            Edit {
                insert_before: Some("Synergech Technologies".into()),
                paragraphs: Some(vec![
                    NewParagraph::Styled { text: "CRC, Chennai".into(), like: Some("Synergech Technologies, Chennai".into()) },
                    NewParagraph::Styled { text: "Cloud Engineer\tJan 2026 – Present".into(), like: Some("Software Engineer".into()) },
                    NewParagraph::Styled { text: "- Built **ProvisionX** for CRC.".into(), like: Some("Led a team".into()) },
                ]),
                ..Default::default()
            },
        );
        let doc = Doc::scan(&out).unwrap();
        let texts: Vec<String> = doc.paras.iter().map(|&p| doc.para_text(p).into_iter().collect()).collect();
        assert_eq!(&texts[1..4], ["CRC, Chennai", "Cloud Engineer\tJan 2026 – Present", "Built ProvisionX for CRC."]);
        assert!(out.contains(&format!("<w:r>{ITALIC}<w:t xml:space=\"preserve\">Cloud Engineer</w:t><w:tab/></w:r><w:r>{BOLD}<w:t xml:space=\"preserve\">Jan 2026")));
        assert_eq!(out.matches("<w:numId w:val=\"3\"/>").count(), 2);
        assert_eq!(out.matches("w14:paraId").count(), 1);
    }

    #[test]
    fn delete_and_errors() {
        let xml = resume();
        let out = edit(&xml, Edit { delete: Some("- Led a team of 5 engineers to build InfraGenie.".into()), ..Default::default() });
        assert!(!out.contains("InfraGenie"));
        let missing = apply(&xml, &Edit { replace: Some("Kubernetes".into()), with: Some("K8s".into()), ..Default::default() }).unwrap_err();
        assert!(missing.contains("couldn't find"));
        let twice = apply(&xml, &Edit { replace: Some("e".into()), with: Some("E".into()), ..Default::default() }).unwrap_err();
        assert!(twice.contains("times"));
        let none = apply(&xml, &Edit::default()).unwrap_err();
        assert!(none.contains("exactly one"));
    }

    #[test]
    fn edits_a_whole_file() {
        let bytes = docx(&resume());
        let edits = vec![
            Edit { replace: Some("Software Engineer".into()), with: Some("Senior Software Engineer".into()), ..Default::default() },
            Edit { insert_after: Some("Led a team".into()), paragraphs: Some(vec![NewParagraph::Text("Shipped it.".into())]), ..Default::default() },
        ];
        let out = edit_docx(&bytes, &edits).unwrap();
        let text = extract(Kind::Word, &out).unwrap();
        assert!(text.contains("Senior Software Engineer\tMay 2025 – Present"));
        assert!(text.contains("- Shipped it."));
        assert!(document_of(&out).contains("<w:sectPr>"));
        let mut zip = zip::ZipArchive::new(Cursor::new(out.as_slice())).unwrap();
        assert_eq!(super::super::part(&mut zip, "word/styles.xml").as_deref(), Some("<w:styles/>"));
        let failed = edit_docx(&bytes, &[edits[0].clone(), Edit { delete: Some("nothing like this".into()), ..Default::default() }]).unwrap_err();
        assert!(failed.starts_with("Edit 2 of 2:"));
    }
}
