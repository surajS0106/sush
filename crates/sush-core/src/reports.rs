//! Security reviews, code reviews and codebase wikis: read-only agent runs
//! over a Cowork workspace, whose results ("reports") are kept per workspace.
//!
//! A report's run is an ordinary thread that the host restricts: the folder is
//! read-only whatever its settings, and the only other tools are `git_diff`
//! (for a review of changes) and the one that records results:
//! `report_findings` for a review, `wiki_write_page` for a wiki. A wiki also
//! has a question thread, just as read-only, answered in text.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::message::ToolSpec;
use crate::workspace::git;

pub const GIT_DIFF: &str = "git_diff";
pub const REPORT_FINDINGS: &str = "report_findings";
pub const WIKI_WRITE_PAGE: &str = "wiki_write_page";

pub fn is_report_tool(name: &str) -> bool {
    [GIT_DIFF, REPORT_FINDINGS, WIKI_WRITE_PAGE].contains(&name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReportKind {
    Security,
    Review,
    Wiki,
}

/// What a report covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Scope {
    /// The whole project as it is on disk.
    Project,
    /// Changes not committed yet, staged or not, against HEAD.
    Uncommitted,
    /// The commits on the current branch since it left `base`.
    Branch { base: String },
    /// A GitHub pull request, read through the GitHub connector.
    PullRequest { repo: String, number: u64 },
}

impl Scope {
    /// The branch a diff is taken against, or `None` for uncommitted changes;
    /// `Err` when the scope has no diff.
    fn diff_base(&self) -> Result<Option<&str>, String> {
        match self {
            Scope::Uncommitted => Ok(None),
            Scope::Branch { base } => Ok(Some(base)),
            _ => Err("This review has no local diff; read the files instead.".into()),
        }
    }

    fn describe(&self, branch: Option<&str>) -> String {
        match self {
            Scope::Project => "Whole project".into(),
            Scope::Uncommitted => "Uncommitted changes".into(),
            Scope::Branch { base } => format!("{} vs {base}", branch.unwrap_or("HEAD")),
            Scope::PullRequest { repo, number } => format!("{repo}#{number}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReportStatus {
    Running,
    Done,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub severity: Severity,
    pub title: String,
    /// Relative to the workspace folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// Markdown.
    pub description: String,
    /// Markdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPage {
    pub slug: String,
    pub title: String,
    /// Markdown.
    pub content: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub workspace_id: String,
    pub kind: ReportKind,
    pub scope: Scope,
    pub title: String,
    /// The thread its latest run is on.
    pub thread_id: String,
    /// A wiki's question thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask_thread_id: Option<String>,
    pub status: ReportStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// When the latest run began. A wiki's pages from before it go once it finishes.
    pub run_started_at: i64,
    /// HEAD when the latest run began, if the folder is in a repo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub findings: Vec<Finding>,
    /// In reading order.
    #[serde(default)]
    pub pages: Vec<WikiPage>,
}

impl Report {
    /// A report about to run on `thread_id`. Not every scope suits every kind.
    pub fn new(
        id: String,
        workspace_id: String,
        kind: ReportKind,
        scope: Scope,
        thread_id: String,
        root: &Path,
        now: i64,
    ) -> Result<Self, String> {
        let fits = match kind {
            ReportKind::Wiki => scope == Scope::Project,
            ReportKind::Security => !matches!(scope, Scope::PullRequest { .. }),
            ReportKind::Review => scope != Scope::Project,
        };
        if !fits {
            return Err("That kind of report can't cover that.".into());
        }
        if let Scope::Branch { base } = &scope {
            if base.starts_with('-') || base.is_empty() {
                return Err(format!("There's no branch named {base}."));
            }
        }
        let info = git::info(root);
        let title = if kind == ReportKind::Wiki {
            "Wiki".into()
        } else {
            scope.describe(info.as_ref().and_then(|i| i.branch.as_deref()))
        };
        Ok(Report {
            id,
            workspace_id,
            kind,
            scope,
            title,
            thread_id,
            ask_thread_id: None,
            status: ReportStatus::Running,
            error: None,
            created_at: now,
            updated_at: now,
            run_started_at: now,
            commit: git::head(root),
            summary: None,
            findings: Vec::new(),
            pages: Vec::new(),
        })
    }

    /// Start another run on it (regenerating a wiki): results so far stay until it finishes.
    pub fn rerun(&mut self, thread_id: String, root: &Path, now: i64) {
        self.thread_id = thread_id;
        self.status = ReportStatus::Running;
        self.error = None;
        self.run_started_at = now;
        self.updated_at = now;
        self.commit = git::head(root);
    }

    /// The latest run ended. A finished wiki run drops the pages it didn't rewrite.
    pub fn finish(&mut self, status: ReportStatus, error: Option<String>, now: i64) {
        self.status = status;
        self.error = error;
        self.updated_at = now;
        let since = self.run_started_at;
        if status == ReportStatus::Done && self.pages.iter().any(|p| p.updated_at >= since) {
            self.pages.retain(|p| p.updated_at >= since);
        }
    }
}

/// How a thread belongs to a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The thread the report's run is on.
    Run,
    /// A wiki's question thread.
    Ask,
}

impl Report {
    pub fn role_of(&self, thread_id: &str) -> Option<Role> {
        if self.thread_id == thread_id {
            Some(Role::Run)
        } else if self.ask_thread_id.as_deref() == Some(thread_id) {
            Some(Role::Ask)
        } else {
            None
        }
    }
}

fn spec(name: &str, description: &str, schema: Value) -> ToolSpec {
    ToolSpec { name: name.into(), description: description.into(), input_schema: schema }
}

/// The report tools a thread gets, besides reading the folder.
pub fn specs(report: &Report, role: Role) -> Vec<ToolSpec> {
    let mut out = Vec::new();
    if report.scope.diff_base().is_ok() && role == Role::Run {
        out.push(spec(
            GIT_DIFF,
            "The changes under review as a unified diff. Start with stat: true for the list of changed files, \
             then read the diff a file or folder at a time with path.",
            json!({ "type": "object", "properties": {
                "path": { "type": "string", "description": "Only this file or folder, relative to the workspace" },
                "stat": { "type": "boolean", "description": "Only the changed files with line counts" },
            } }),
        ));
    }
    match (report.kind, role) {
        (ReportKind::Security | ReportKind::Review, Role::Run) => out.push(spec(
            REPORT_FINDINGS,
            "Record the review's results. Call it once when you're done, with every finding (an empty list if \
             there are none); calling it again replaces them.",
            json!({ "type": "object", "properties": {
                "summary": { "type": "string", "description": "Two or three sentences: what you looked at and the overall verdict" },
                "findings": { "type": "array", "items": { "type": "object", "properties": {
                    "severity": { "type": "string", "enum": ["critical", "high", "medium", "low", "info"] },
                    "title": { "type": "string", "description": "One line naming the problem" },
                    "file": { "type": "string", "description": "Path relative to the workspace" },
                    "line": { "type": "integer", "description": "The line the problem is on" },
                    "description": { "type": "string", "description": "What's wrong and why it matters, in Markdown" },
                    "suggestion": { "type": "string", "description": "How to fix it, in Markdown; code where it helps" },
                }, "required": ["severity", "title", "description"] } },
            }, "required": ["summary", "findings"] }),
        )),
        (ReportKind::Wiki, Role::Run) => out.push(spec(
            WIKI_WRITE_PAGE,
            "Write one wiki page (or replace the page with the same slug). Pages appear in the order you write them.",
            json!({ "type": "object", "properties": {
                "slug": { "type": "string", "description": "Short id in kebab-case, e.g. \"architecture\"" },
                "title": { "type": "string" },
                "content": { "type": "string", "description": "The page in Markdown, without its title" },
            }, "required": ["slug", "title", "content"] }),
        )),
        _ => {}
    }
    out
}

#[derive(Deserialize)]
struct FindingInput {
    severity: Severity,
    title: String,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    line: Option<u32>,
    description: String,
    #[serde(default)]
    suggestion: Option<String>,
}

#[derive(Deserialize)]
struct FindingsInput {
    #[serde(default)]
    summary: String,
    findings: Vec<FindingInput>,
}

#[derive(Deserialize)]
struct PageInput {
    slug: String,
    title: String,
    content: String,
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Record a `report_findings` or `wiki_write_page` call. Returns what the model is told.
pub fn apply_tool(report: &mut Report, name: &str, input: &Value, now: i64) -> Result<String, String> {
    match name {
        REPORT_FINDINGS => {
            let input: FindingsInput =
                serde_json::from_value(input.clone()).map_err(|e| format!("report_findings: {e}"))?;
            report.summary = clean(Some(input.summary));
            report.findings = input
                .findings
                .into_iter()
                .enumerate()
                .map(|(i, f)| Finding {
                    id: format!("f{}", i + 1),
                    severity: f.severity,
                    title: f.title.trim().to_string(),
                    file: clean(f.file).map(|p| p.trim_start_matches("./").replace('\\', "/")),
                    line: f.line.filter(|&l| l > 0),
                    description: f.description.trim().to_string(),
                    suggestion: clean(f.suggestion),
                })
                .collect();
            report.updated_at = now;
            let n = report.findings.len();
            Ok(format!("Recorded {n} {}. The user sees them on the report.", if n == 1 { "finding" } else { "findings" }))
        }
        WIKI_WRITE_PAGE => {
            let input: PageInput = serde_json::from_value(input.clone()).map_err(|e| format!("wiki_write_page: {e}"))?;
            let slug: String = input
                .slug
                .trim()
                .to_lowercase()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect::<String>()
                .split('-')
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("-");
            if slug.is_empty() || input.title.trim().is_empty() || input.content.trim().is_empty() {
                return Err("A page needs a slug, a title and content.".into());
            }
            // Written again: it moves to the end, so a regenerated wiki ends up in its new order.
            report.pages.retain(|p| p.slug != slug);
            report.pages.push(WikiPage {
                slug: slug.clone(),
                title: input.title.trim().to_string(),
                content: input.content.trim().to_string(),
                updated_at: now,
            });
            report.updated_at = now;
            Ok(format!("Wrote the page \"{slug}\"."))
        }
        other => Err(format!("{other} isn't a report tool.")),
    }
}

/// Longest diff returned at once; past it the model is told to narrow it.
const MAX_DIFF_CHARS: usize = 60_000;

/// Run a `git_diff` call for a report in the folder at `root`.
pub fn git_diff(root: &Path, report: &Report, input: &Value) -> Result<String, String> {
    let base = report.scope.diff_base()?;
    let path = input.get("path").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty());
    let stat = input.get("stat").and_then(Value::as_bool).unwrap_or(false);
    let out = git::diff(root, base, path, stat)?;
    if out.len() <= MAX_DIFF_CHARS {
        return Ok(out);
    }
    let cut = (0..=MAX_DIFF_CHARS).rev().find(|&i| out.is_char_boundary(i)).unwrap_or(0);
    Ok(format!(
        "{}\n[The diff is longer than this; call git_diff with stat: true for the files, then with path for each.]",
        &out[..cut]
    ))
}

/// Most wiki text a question thread is given up front.
const MAX_WIKI_CONTEXT: usize = 40_000;

/// What the thread is asked to do. The host adds the folder's read-only section after it.
pub fn system_prompt(report: &Report, role: Role, folder: &str) -> String {
    let cite = "Cite source files as inline code with their path relative to the folder, and a line where it helps \
                (e.g. `src/server/auth.ts:42`), so the user can open them.";
    if role == Role::Ask {
        let mut s = format!(
            "Answer the user's questions about the codebase in \"{folder}\". Read the code with the fs_* tools \
             rather than guessing, and be concise. {cite}"
        );
        if !report.pages.is_empty() {
            let mut wiki = String::new();
            for p in &report.pages {
                wiki.push_str(&format!("# {}\n\n{}\n\n", p.title, p.content));
            }
            let wiki: String = wiki.chars().take(MAX_WIKI_CONTEXT).collect();
            s.push_str(&format!(
                "\n\nThe folder's wiki, written earlier (the code may have changed since):\n<wiki>\n{}\n</wiki>",
                wiki.trim()
            ));
        }
        return s;
    }
    let scope = match &report.scope {
        Scope::Project => "Cover the whole project. You can't read everything, so find the entry points and the \
                           code that handles untrusted input first, and prioritise."
            .to_string(),
        Scope::Uncommitted => "Cover only the uncommitted changes (staged or not) against HEAD. git_diff shows them; \
                               read the code around each change for context, and report only problems in the \
                               changes or caused by them."
            .to_string(),
        Scope::Branch { base } => format!(
            "Cover only the commits on the current branch since it left {base}. git_diff shows them; read the code \
             around each change for context, and report only problems in the changes or caused by them."
        ),
        Scope::PullRequest { repo, number } => format!(
            "Cover pull request #{number} in {repo} on GitHub. Read its description and changed files with the \
             GitHub tools. The folder may be a checkout of the repository: use it for context, but it may not \
             have the pull request's changes."
        ),
    };
    let results = "When you're done, call report_findings once with everything you found (an empty list if \
                   nothing), then reply with one or two sentences. Don't list the findings again in your reply.";
    match report.kind {
        ReportKind::Security => format!(
            "You're doing a security review of the code in \"{folder}\". {scope}\n\n\
             Look for vulnerabilities an attacker could exploit: injection (SQL, shell commands, path traversal), \
             broken authentication or authorization, secrets in the code, unsafe deserialization, SSRF, XSS, weak \
             cryptography, missing validation where untrusted input comes in, and risky configuration. Trace each \
             one through the code to confirm it; leave out style issues and problems with no realistic attack. \
             Rate severity by impact and how easy it is to exploit. For each, give the file and line, why it's \
             exploitable, and a concrete fix.\n\n{results}"
        ),
        ReportKind::Review => format!(
            "You're reviewing code changes in \"{folder}\". {scope}\n\n\
             Look for bugs: wrong logic, unhandled errors and edge cases, races, broken contracts with callers, \
             security problems, and missing tests for risky code. Mention simplifications only when they matter. \
             Read enough of the surrounding code to be sure, and report only what you can back up. Rate severity \
             by the harm if it ships. For each, give the file and line, what goes wrong and when, and the \
             change you'd make.\n\n{results}"
        ),
        ReportKind::Wiki => {
            let mut s = format!(
                "You're writing a wiki for the codebase in \"{folder}\" to help a developer new to it find their \
                 way around. Explore it with the fs_* tools, then write the pages with wiki_write_page, one call \
                 per page, in reading order: `overview` (what the project is, its main parts, the tech stack), \
                 `architecture` (how the parts fit together and talk to each other), a page for each major module \
                 or area, `key-flows` (the most important flows traced through the code), and `running` (how to \
                 install, build, test and run it, from its scripts and docs). Use Markdown with ## headings. \
                 {cite} State only what you've read in the code. When you're done, reply with one sentence."
            );
            if !report.pages.is_empty() {
                let list: Vec<String> = report.pages.iter().map(|p| format!("- {} ({})", p.title, p.slug)).collect();
                s.push_str(&format!(
                    "\n\nThe wiki already has these pages, written for an earlier version of the code:\n{}\n\
                     Update it: write every page that should stay (reusing its slug), and add or leave out pages as \
                     the code now needs. Pages you don't write again are removed when you finish.",
                    list.join("\n")
                ));
            }
            s
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(kind: ReportKind, scope: Scope) -> Report {
        let dir = tempfile::tempdir().unwrap();
        Report::new("r".into(), "w".into(), kind, scope, "t".into(), dir.path(), 100).unwrap()
    }

    #[test]
    fn kinds_take_only_scopes_that_fit() {
        let dir = tempfile::tempdir().unwrap();
        let new = |kind, scope| Report::new("r".into(), "w".into(), kind, scope, "t".into(), dir.path(), 1);
        assert!(new(ReportKind::Wiki, Scope::Uncommitted).is_err());
        assert!(new(ReportKind::Review, Scope::Project).is_err());
        assert!(new(ReportKind::Security, Scope::PullRequest { repo: "a/b".into(), number: 1 }).is_err());
        assert!(new(ReportKind::Review, Scope::Branch { base: "--force".into() }).is_err());
        let r = new(ReportKind::Review, Scope::PullRequest { repo: "a/b".into(), number: 7 }).unwrap();
        assert_eq!((r.title.as_str(), r.status), ("a/b#7", ReportStatus::Running));
    }

    #[test]
    fn tools_follow_the_scope_and_role() {
        let names = |r: &Report, role| specs(r, role).into_iter().map(|s| s.name).collect::<Vec<_>>();
        let diff = report(ReportKind::Review, Scope::Uncommitted);
        assert_eq!(names(&diff, Role::Run), [GIT_DIFF, REPORT_FINDINGS]);
        let whole = report(ReportKind::Security, Scope::Project);
        assert_eq!(names(&whole, Role::Run), [REPORT_FINDINGS]);
        let wiki = report(ReportKind::Wiki, Scope::Project);
        assert_eq!(names(&wiki, Role::Run), [WIKI_WRITE_PAGE]);
        assert!(names(&wiki, Role::Ask).is_empty());
        assert!(git_diff(Path::new("."), &whole, &json!({})).is_err());
    }

    #[test]
    fn findings_replace_the_last_set() {
        let mut r = report(ReportKind::Security, Scope::Project);
        let input = json!({ "summary": " One issue. ", "findings": [
            { "severity": "high", "title": "SQL injection", "file": "./src/db.ts", "line": 12, "description": "x", "suggestion": " " },
        ] });
        assert_eq!(apply_tool(&mut r, REPORT_FINDINGS, &input, 200).unwrap(), "Recorded 1 finding. The user sees them on the report.");
        assert_eq!(r.summary.as_deref(), Some("One issue."));
        let f = &r.findings[0];
        assert_eq!((f.id.as_str(), f.severity, f.file.as_deref(), f.line, f.suggestion.as_deref()), ("f1", Severity::High, Some("src/db.ts"), Some(12), None));

        apply_tool(&mut r, REPORT_FINDINGS, &json!({ "summary": "", "findings": [] }), 300).unwrap();
        assert!(r.findings.is_empty() && r.summary.is_none());
        assert!(apply_tool(&mut r, REPORT_FINDINGS, &json!({ "findings": [{ "severity": "huge" }] }), 300).is_err());
    }

    #[test]
    fn a_finished_wiki_run_keeps_only_the_pages_it_wrote() {
        let mut r = report(ReportKind::Wiki, Scope::Project);
        let page = |slug: &str| json!({ "slug": slug, "title": slug, "content": "text" });
        apply_tool(&mut r, WIKI_WRITE_PAGE, &page("Overview"), 110).unwrap();
        apply_tool(&mut r, WIKI_WRITE_PAGE, &page("old_module"), 120).unwrap();
        r.finish(ReportStatus::Done, None, 130);
        assert_eq!(r.pages.iter().map(|p| p.slug.as_str()).collect::<Vec<_>>(), ["overview", "old-module"]);

        // Regenerating keeps the old pages until it finishes, then drops the ones not written again.
        r.rerun("t2".into(), Path::new("."), 200);
        apply_tool(&mut r, WIKI_WRITE_PAGE, &page("overview"), 210).unwrap();
        assert_eq!(r.pages.len(), 2);
        r.finish(ReportStatus::Done, None, 220);
        assert_eq!(r.pages.iter().map(|p| p.slug.as_str()).collect::<Vec<_>>(), ["overview"]);

        // A stopped run, or one that wrote nothing, leaves the wiki as it was.
        r.rerun("t3".into(), Path::new("."), 300);
        r.finish(ReportStatus::Done, None, 310);
        assert_eq!(r.pages.len(), 1);
        assert_eq!(r.role_of("t3"), Some(Role::Run));
        assert_eq!(r.role_of("t2"), None);
    }

    #[test]
    fn question_threads_get_the_wiki() {
        let mut r = report(ReportKind::Wiki, Scope::Project);
        apply_tool(&mut r, WIKI_WRITE_PAGE, &json!({ "slug": "overview", "title": "Overview", "content": "Uses Hono." }), 1).unwrap();
        assert!(system_prompt(&r, Role::Ask, "proj").contains("Uses Hono."));
        assert!(system_prompt(&r, Role::Run, "proj").contains("- Overview (overview)"));
    }
}
