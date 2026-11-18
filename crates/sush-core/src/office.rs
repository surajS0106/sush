//! Text out of Office files (Word, PowerPoint, Excel), so an attached .docx reaches the model as
//! something it can read. Office Open XML files are zip archives of XML parts; this reads the
//! parts that hold the text and keeps enough structure (headings, list items, tables, slides,
//! sheets) for the model to rewrite the document faithfully.

use std::collections::HashMap;
use std::io::{Cursor, Read};

pub mod edit;
pub mod render;

/// The media type of a Word document.
pub const DOCX_MEDIA_TYPE: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/// The Office formats read here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Word,
    PowerPoint,
    Excel,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Word => "Word document",
            Kind::PowerPoint => "PowerPoint presentation",
            Kind::Excel => "Excel workbook",
        }
    }
}

/// The Office format of an attachment, from its media type or, since the OS doesn't always report
/// one (Windows often gives none), its file name.
pub fn kind(media_type: &str, filename: Option<&str>) -> Option<Kind> {
    let by_type = match media_type {
        t if t.starts_with("application/vnd.openxmlformats-officedocument.wordprocessingml") => Some(Kind::Word),
        t if t.starts_with("application/vnd.ms-word.document.macroenabled") => Some(Kind::Word),
        t if t.starts_with("application/vnd.ms-word.template.macroenabled") => Some(Kind::Word),
        t if t.starts_with("application/vnd.openxmlformats-officedocument.presentationml") => Some(Kind::PowerPoint),
        t if t.starts_with("application/vnd.ms-powerpoint.presentation.macroenabled") => Some(Kind::PowerPoint),
        t if t.starts_with("application/vnd.openxmlformats-officedocument.spreadsheetml") => Some(Kind::Excel),
        t if t.starts_with("application/vnd.ms-excel.sheet.macroenabled") => Some(Kind::Excel),
        _ => None,
    };
    by_type.or_else(|| {
        let ext = filename?.rsplit_once('.')?.1.to_ascii_lowercase();
        match ext.as_str() {
            "docx" | "docm" | "dotx" | "dotm" => Some(Kind::Word),
            "pptx" | "pptm" | "potx" | "potm" | "ppsx" => Some(Kind::PowerPoint),
            "xlsx" | "xlsm" | "xltx" | "xltm" => Some(Kind::Excel),
            _ => None,
        }
    })
}

/// The text of an Office file, or None when it isn't a readable one (corrupt, encrypted, the old
/// binary .doc format) or holds no text.
pub fn extract(kind: Kind, bytes: &[u8]) -> Option<String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let text = match kind {
        Kind::Word => word(&mut zip)?,
        Kind::PowerPoint => slides(&mut zip)?,
        Kind::Excel => sheets(&mut zip)?,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

type Zip<'a> = zip::ZipArchive<Cursor<&'a [u8]>>;

/// A part of the archive as text. Parts are capped so a hostile file can't inflate without bound.
fn part(zip: &mut Zip, name: &str) -> Option<String> {
    const MAX: u64 = 64 << 20;
    let file = zip.by_name(name).ok()?;
    let mut out = String::new();
    file.take(MAX).read_to_string(&mut out).ok()?;
    Some(out)
}

/// One piece of an XML part: a tag or the text between tags.
enum Node<'a> {
    /// `name` without its namespace prefix; `attrs` is the raw attribute text.
    Open { name: &'a str, attrs: &'a str, empty: bool },
    Close(&'a str),
    Text(&'a str),
}

/// A minimal XML scanner, enough for Office parts (no DTDs; comments, CDATA and processing
/// instructions are skipped).
fn nodes(xml: &str) -> impl Iterator<Item = Node<'_>> {
    let mut rest = xml;
    std::iter::from_fn(move || loop {
        if rest.is_empty() {
            return None;
        }
        if !rest.starts_with('<') {
            let end = rest.find('<').unwrap_or(rest.len());
            let (text, tail) = rest.split_at(end);
            rest = tail;
            return Some(Node::Text(text));
        }
        let skip_to = |rest: &mut &str, end: &str| {
            *rest = rest.find(end).map_or("", |i| &rest[i + end.len()..]);
        };
        if rest.starts_with("<!--") {
            skip_to(&mut rest, "-->");
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            let body = &rest[9..];
            let end = body.find("]]>").unwrap_or(body.len());
            rest = body.get(end + 3..).unwrap_or("");
            return Some(Node::Text(&body[..end]));
        }
        if rest.starts_with("<?") || rest.starts_with("<!") {
            skip_to(&mut rest, ">");
            continue;
        }
        let Some(end) = rest.find('>') else {
            rest = "";
            return None;
        };
        let tag = &rest[1..end];
        rest = &rest[end + 1..];
        if let Some(name) = tag.strip_prefix('/') {
            return Some(Node::Close(local(name.trim())));
        }
        let empty = tag.ends_with('/');
        let tag = tag.trim_end_matches('/');
        let (name, attrs) = tag.split_once(|c: char| c.is_whitespace()).unwrap_or((tag, ""));
        return Some(Node::Open { name: local(name), attrs, empty });
    })
}

fn local(name: &str) -> &str {
    name.rsplit_once(':').map_or(name, |(_, n)| n)
}

/// An attribute's value, matched on its local name (`w:val` and `val` both match `val`).
fn attr<'a>(attrs: &'a str, key: &str) -> Option<&'a str> {
    let mut rest = attrs;
    while let Some(eq) = rest.find('=') {
        let name = rest[..eq].trim();
        let after = rest[eq + 1..].trim_start();
        let quote = after.chars().next()?;
        let body = &after[1..];
        let close = body.find(quote)?;
        if local(name) == key {
            return Some(&body[..close]);
        }
        rest = &body[close + 1..];
    }
    None
}

/// XML text with its entities resolved.
fn unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let Some(semi) = after.find(';').filter(|&i| i <= 10) else {
            out.push('&');
            rest = after;
            continue;
        };
        let entity = &after[..semi];
        let ch = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A Word document's body as Markdown, with headings, list items and tables kept. Page headers
/// and footers are left out (they are usually page furniture).
fn word(zip: &mut Zip) -> Option<String> {
    let xml = part(zip, "word/document.xml")?;
    let mut out = String::new();
    let mut last_was_item = false;
    let mut para = String::new();
    let mut prefix = String::new();
    let mut in_text = false;
    // Table state: cells of the current row, and whether the header separator was written.
    let mut table_depth = 0usize;
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut header_done = false;

    for node in nodes(&xml) {
        match node {
            Node::Open { name, attrs, empty } => match name {
                "p" if !empty => {
                    para.clear();
                    prefix.clear();
                }
                "pStyle" => {
                    let style = attr(attrs, "val").unwrap_or("").to_ascii_lowercase();
                    if style == "title" {
                        prefix = "# ".into();
                    } else if let Some(level) = style.strip_prefix("heading").and_then(|n| n.trim().parse::<usize>().ok()) {
                        prefix = format!("{} ", "#".repeat((level + 1).min(6)));
                    } else if style.contains("list") && prefix.is_empty() {
                        prefix = "- ".into();
                    }
                }
                "ilvl" => {
                    let level = attr(attrs, "val").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
                    prefix = format!("{}- ", "  ".repeat(level));
                }
                "t" if !empty => in_text = true,
                "tab" => para.push('\t'),
                "br" | "cr" => para.push('\n'),
                "tbl" => {
                    table_depth += 1;
                    if table_depth == 1 {
                        header_done = false;
                        if !out.is_empty() && !out.ends_with("\n\n") {
                            out.push('\n');
                        }
                    }
                }
                "tr" if !empty => row.clear(),
                "tc" if !empty => cell.clear(),
                _ => {}
            },
            Node::Text(text) if in_text => para.push_str(&unescape(text)),
            Node::Text(_) => {}
            Node::Close(name) => match name {
                "t" => in_text = false,
                "p" => {
                    let text = para.trim_end();
                    if table_depth > 0 {
                        if !cell.is_empty() && !text.is_empty() {
                            cell.push_str("<br>");
                        }
                        cell.push_str(&text.replace('|', "\\|").replace('\n', "<br>"));
                    } else if !text.trim().is_empty() {
                        let item = prefix.trim_start().starts_with('-');
                        // A paragraph after a list needs a blank line, or Markdown folds it into the last item.
                        if last_was_item && !item {
                            out.push('\n');
                        }
                        out.push_str(&prefix);
                        out.push_str(text);
                        out.push_str(if item { "\n" } else { "\n\n" });
                        last_was_item = item;
                    }
                    para.clear();
                }
                "tc" if table_depth == 1 => row.push(std::mem::take(&mut cell).trim().to_string()),
                "tr" if table_depth == 1 => {
                    out.push_str(&format!("| {} |\n", row.join(" | ")));
                    if !header_done {
                        out.push_str(&format!("|{}\n", " --- |".repeat(row.len().max(1))));
                        header_done = true;
                    }
                }
                "tbl" => {
                    table_depth = table_depth.saturating_sub(1);
                    if table_depth == 0 {
                        out.push('\n');
                    }
                }
                _ => {}
            },
        }
    }
    Some(out)
}

/// A presentation's slides in order, each under its own heading.
fn slides(zip: &mut Zip) -> Option<String> {
    let mut numbers: Vec<u32> = zip
        .file_names()
        .filter_map(|n| n.ok()?.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?.parse().ok())
        .collect();
    numbers.sort_unstable();
    if numbers.is_empty() {
        return None;
    }
    let mut out = String::new();
    for (i, n) in numbers.iter().enumerate() {
        let Some(xml) = part(zip, &format!("ppt/slides/slide{n}.xml")) else { continue };
        out.push_str(&format!("## Slide {}\n\n", i + 1));
        out.push_str(&drawing_text(&xml));
        out.push('\n');
        if let Some(notes) = part(zip, &format!("ppt/notesSlides/notesSlide{n}.xml")) {
            let notes = drawing_text(&notes);
            // Notes slides repeat the slide number as their only text when empty.
            if notes.trim().chars().any(|c| !c.is_ascii_digit()) {
                out.push_str("Speaker notes:\n");
                out.push_str(&notes);
                out.push('\n');
            }
        }
    }
    Some(out)
}

/// The paragraphs of a DrawingML part (slides, notes), one per line.
fn drawing_text(xml: &str) -> String {
    let mut out = String::new();
    let mut para = String::new();
    let mut in_text = false;
    for node in nodes(xml) {
        match node {
            Node::Open { name: "t", empty: false, .. } => in_text = true,
            Node::Open { name: "br", .. } => para.push('\n'),
            Node::Text(text) if in_text => para.push_str(&unescape(text)),
            Node::Close("t") => in_text = false,
            Node::Close("p") => {
                if !para.trim().is_empty() {
                    out.push_str(para.trim_end());
                    out.push('\n');
                }
                para.clear();
            }
            _ => {}
        }
    }
    out
}

/// A workbook's sheets as Markdown tables, capped per sheet.
fn sheets(zip: &mut Zip) -> Option<String> {
    const MAX_ROWS: usize = 500;
    let shared = part(zip, "xl/sharedStrings.xml").map(|x| shared_strings(&x)).unwrap_or_default();
    let names = sheet_names(zip);
    let mut out = String::new();
    for (i, (name, path)) in names.iter().enumerate() {
        let Some(xml) = part(zip, path) else { continue };
        let rows = sheet_rows(&xml, &shared);
        if rows.is_empty() {
            continue;
        }
        let title = if name.is_empty() { format!("Sheet {}", i + 1) } else { name.clone() };
        out.push_str(&format!("## {title}\n\n"));
        let width = rows.iter().map(|r| r.len()).max().unwrap_or(1).max(1);
        for (r, row) in rows.iter().take(MAX_ROWS).enumerate() {
            let cells: Vec<String> =
                (0..width).map(|c| row.get(c).map(|v| v.replace('|', "\\|").replace('\n', " ")).unwrap_or_default()).collect();
            out.push_str(&format!("| {} |\n", cells.join(" | ")));
            if r == 0 {
                out.push_str(&format!("|{}\n", " --- |".repeat(width)));
            }
        }
        if rows.len() > MAX_ROWS {
            out.push_str(&format!("\n({} more rows not shown)\n", rows.len() - MAX_ROWS));
        }
        out.push('\n');
    }
    Some(out)
}

/// Sheet names and their parts, in workbook order.
fn sheet_names(zip: &mut Zip) -> Vec<(String, String)> {
    let rels: HashMap<String, String> = part(zip, "xl/_rels/workbook.xml.rels")
        .map(|xml| {
            nodes(&xml)
                .filter_map(|n| match n {
                    Node::Open { name: "Relationship", attrs, .. } => {
                        let target = attr(attrs, "Target")?;
                        let target = target.trim_start_matches('/').trim_start_matches("xl/");
                        Some((attr(attrs, "Id")?.to_string(), format!("xl/{target}")))
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let listed: Vec<(String, String)> = part(zip, "xl/workbook.xml")
        .map(|xml| {
            nodes(&xml)
                .filter_map(|n| match n {
                    Node::Open { name: "sheet", attrs, .. } => {
                        let path = rels.get(attr(attrs, "id")?)?.clone();
                        Some((unescape(attr(attrs, "name").unwrap_or("")), path))
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    if !listed.is_empty() {
        return listed;
    }
    let mut numbers: Vec<u32> = zip
        .file_names()
        .filter_map(|n| n.ok()?.strip_prefix("xl/worksheets/sheet")?.strip_suffix(".xml")?.parse().ok())
        .collect();
    numbers.sort_unstable();
    numbers.into_iter().map(|n| (String::new(), format!("xl/worksheets/sheet{n}.xml"))).collect()
}

fn shared_strings(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut in_phonetic = false;
    for node in nodes(xml) {
        match node {
            Node::Open { name: "si", empty, .. } => {
                current.clear();
                if empty {
                    out.push(String::new());
                }
            }
            Node::Open { name: "rPh", empty: false, .. } => in_phonetic = true,
            Node::Close("rPh") => in_phonetic = false,
            Node::Open { name: "t", empty: false, .. } => in_text = !in_phonetic,
            Node::Text(text) if in_text => current.push_str(&unescape(text)),
            Node::Close("t") => in_text = false,
            Node::Close("si") => out.push(std::mem::take(&mut current)),
            _ => {}
        }
    }
    out
}

/// A sheet's rows, each cell placed in its column (from its `A1`-style reference).
fn sheet_rows(xml: &str, shared: &[String]) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut col = 0usize;
    let mut kind = String::new();
    let mut value = String::new();
    let mut in_value = false;
    for node in nodes(xml) {
        match node {
            Node::Open { name: "row", empty, .. } => {
                row.clear();
                col = 0;
                if empty {
                    rows.push(Vec::new());
                }
            }
            Node::Open { name: "c", attrs, empty } => {
                kind = attr(attrs, "t").unwrap_or("").to_string();
                if let Some(c) = attr(attrs, "r").and_then(column) {
                    col = c;
                }
                value.clear();
                if empty {
                    col += 1;
                }
            }
            Node::Open { name: "v" | "t", empty: false, .. } => in_value = true,
            Node::Text(text) if in_value => value.push_str(&unescape(text)),
            Node::Close("v" | "t") => in_value = false,
            Node::Close("c") => {
                let text = match kind.as_str() {
                    "s" => value.trim().parse::<usize>().ok().and_then(|i| shared.get(i)).cloned().unwrap_or_default(),
                    "b" => if value.trim() == "1" { "TRUE".into() } else { "FALSE".into() },
                    _ => value.clone(),
                };
                if row.len() <= col {
                    row.resize(col + 1, String::new());
                }
                row[col] = text;
                col += 1;
            }
            Node::Close("row") => {
                while row.last().is_some_and(|c| c.is_empty()) {
                    row.pop();
                }
                rows.push(std::mem::take(&mut row));
            }
            _ => {}
        }
    }
    while rows.last().is_some_and(|r| r.is_empty()) {
        rows.pop();
    }
    rows
}

/// The zero-based column of a cell reference like `C12`.
fn column(reference: &str) -> Option<usize> {
    let letters: String = reference.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    if letters.is_empty() {
        return None;
    }
    Some(letters.to_ascii_uppercase().bytes().fold(0usize, |n, b| n * 26 + (b - b'A' + 1) as usize) - 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn archive(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for (name, body) in parts {
                zip.start_file(*name, options).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn detects_by_type_or_name() {
        assert_eq!(kind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", None), Some(Kind::Word));
        assert_eq!(kind("", Some("Resume.DOCX")), Some(Kind::Word));
        assert_eq!(kind("application/octet-stream", Some("deck.pptx")), Some(Kind::PowerPoint));
        assert_eq!(kind("", Some("notes.txt")), None);
    }

    #[test]
    fn reads_a_word_document() {
        let doc = r#"<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Experience</w:t></w:r></w:p>
            <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Built &amp; shipped </w:t></w:r><w:r><w:t>X</w:t></w:r></w:p>
            <w:p><w:r><w:t>Plain</w:t><w:tab/><w:t>text</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>
            </w:body></w:document>"#;
        let text = extract(Kind::Word, &archive(&[("word/document.xml", doc)])).unwrap();
        assert_eq!(text, "## Experience\n\n- Built & shipped X\n\nPlain\ttext\n\n| A | B |\n| --- | --- |\n| 1 |  |");
    }

    #[test]
    fn reads_slides_in_order() {
        let slide = |t: &str| format!(r#"<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>"#);
        let (s1, s2, s10) = (slide("One"), slide("Two"), slide("Ten"));
        let bytes = archive(&[("ppt/slides/slide10.xml", &s10), ("ppt/slides/slide2.xml", &s2), ("ppt/slides/slide1.xml", &s1)]);
        let text = extract(Kind::PowerPoint, &bytes).unwrap();
        assert_eq!(text, "## Slide 1\n\nOne\n\n## Slide 2\n\nTwo\n\n## Slide 3\n\nTen");
    }

    #[test]
    fn reads_sheets() {
        let workbook = r#"<workbook><sheets><sheet name="Q&amp;A" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        let rels = r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#;
        let shared = r#"<sst><si><t>Name</t></si><si><r><t>Ra</t></r><r><t>m</t></r></si></sst>"#;
        let sheet = r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>3</v></c></row>
            <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="b"><v>1</v></c></row></sheetData></worksheet>"#;
        let bytes = archive(&[
            ("xl/workbook.xml", workbook),
            ("xl/_rels/workbook.xml.rels", rels),
            ("xl/sharedStrings.xml", shared),
            ("xl/worksheets/sheet1.xml", sheet),
        ]);
        let text = extract(Kind::Excel, &bytes).unwrap();
        assert_eq!(text, "## Q&A\n\n| Name |  | 3 |\n| --- | --- | --- |\n| Ram | TRUE |  |");
    }

    #[test]
    fn rejects_non_archives() {
        assert_eq!(extract(Kind::Word, b"not a zip"), None);
    }
}
