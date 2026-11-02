//! A branch's pull request and its CI checks as GitHub reports them, for the
//! pull request card's live pipeline, and the lines that explain a failed check.
//!
//! Runs the user's `gh` (signed in on their machine) outside the sandbox; it
//! only reads. No `gh`, not signed in, or no pull request for the branch just
//! means [`Pipeline::Unavailable`], and the card keeps the checks the model
//! reported.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// What the card shows: the pull request and its checks, or why there are none.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Pipeline {
    Live { pr: PullRequest, checks: Vec<CiCheck> },
    Unavailable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    /// `open`, `draft`, `merged` or `closed`, as the card's `PrState`.
    pub state: String,
    /// The commit the checks ran on.
    pub head: String,
    pub base: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiCheck {
    pub name: String,
    /// `pending`, `running`, `passed`, `failed` or `skipped`, as the card's `CheckStatus`.
    pub status: String,
    /// Unix milliseconds; `None` until it starts or ends.
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub link: Option<String>,
    /// The Actions job, when the check is one, for [`failure`].
    pub job: Option<u64>,
}

/// Why a check failed, read from its log.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    /// `path:line` of the failing test or assertion.
    pub location: Option<String>,
    /// The failing test's name.
    pub title: Option<String>,
    pub expected: Option<String>,
    pub received: Option<String>,
    /// The log's last lines, when nothing above was found.
    pub tail: Vec<String>,
}

fn gh(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("gh");
    cmd.current_dir(root).args(args).env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1").env("GH_PAGER", "");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|_| "GitHub CLI (gh) isn't installed.".to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    // `gh pr checks` exits 8 while checks are pending and 1 when one failed, still printing them.
    if out.status.success() || (!stdout.trim().is_empty() && args.first() == Some(&"pr")) {
        Ok(stdout)
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("gh {} failed", args.join(" ")) } else { err })
    }
}

/// The branch's pull request (or `pr`) and its checks.
pub fn pipeline(root: &Path, pr: Option<u64>) -> Pipeline {
    match read(root, pr) {
        Ok((pr, checks)) => Pipeline::Live { pr, checks },
        Err(reason) => Pipeline::Unavailable { reason },
    }
}

impl Pipeline {
    /// For the model, after the branch's status: whether the pull request
    /// exists and what its checks say, so it neither opens a second one nor
    /// calls a branch with a failing check ready. `head` is the local branch's.
    pub fn summary(&self, head: &str) -> String {
        let Pipeline::Live { pr, checks } = self else {
            return "No pull request found on GitHub for this branch (or gh couldn't tell).".into();
        };
        let mut s = format!("Pull request #{} is {} on GitHub ({}), into {}.", pr.number, pr.state, pr.url, pr.base);
        if !(pr.head.starts_with(head) || head.starts_with(&pr.head)) {
            s.push_str(&format!(" GitHub has {} as its head, not this branch's HEAD: push to update it.", short(&pr.head)));
        }
        if checks.is_empty() {
            s.push_str(" It has no CI checks.");
            return s;
        }
        let list: Vec<String> = checks.iter().map(|c| format!("{} {}", c.name, c.status)).collect();
        s.push_str(&format!(" CI checks on {}: {}.", short(&pr.head), list.join(", ")));
        if checks.iter().any(|c| c.status == "failed") {
            s.push_str(" A failing check blocks merging: tell the user, and don't call the pull request ready or clean.");
        } else if checks.iter().any(|c| c.status == "running" || c.status == "pending") {
            s.push_str(" Checks are still running.");
        }
        s
    }
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

fn read(root: &Path, pr: Option<u64>) -> Result<(PullRequest, Vec<CiCheck>), String> {
    let number = pr.map(|n| n.to_string());
    let mut args = vec!["pr", "view"];
    args.extend(number.as_deref());
    args.extend(["--json", "number,url,state,isDraft,headRefOid,baseRefName"]);
    let pr = parse_pr(&gh(root, &args)?)?;
    let n = pr.number.to_string();
    let checks = match gh(root, &["pr", "checks", &n, "--json", "name,bucket,state,startedAt,completedAt,link"]) {
        Ok(text) => parse_checks(&text)?,
        // A pull request with no checks configured.
        Err(e) if e.contains("no checks reported") => Vec::new(),
        Err(e) => return Err(e),
    };
    Ok((pr, checks))
}

fn parse_pr(text: &str) -> Result<PullRequest, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Raw {
        number: u64,
        url: String,
        state: String,
        #[serde(default)]
        is_draft: bool,
        head_ref_oid: String,
        base_ref_name: String,
    }
    let raw: Raw = serde_json::from_str(text).map_err(|e| format!("Couldn't read gh's pull request: {e}"))?;
    let state = match raw.state.as_str() {
        "MERGED" => "merged",
        "CLOSED" => "closed",
        _ if raw.is_draft => "draft",
        _ => "open",
    };
    Ok(PullRequest { number: raw.number, url: raw.url, state: state.into(), head: raw.head_ref_oid, base: raw.base_ref_name })
}

fn parse_checks(text: &str) -> Result<Vec<CiCheck>, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Raw {
        name: String,
        #[serde(default)]
        bucket: String,
        #[serde(default)]
        state: String,
        #[serde(default)]
        started_at: String,
        #[serde(default)]
        completed_at: String,
        #[serde(default)]
        link: String,
    }
    let raw: Vec<Raw> = serde_json::from_str(text).map_err(|e| format!("Couldn't read gh's checks: {e}"))?;
    Ok(raw
        .into_iter()
        .map(|c| {
            let started_at = timestamp(&c.started_at);
            let status = match c.bucket.as_str() {
                "pass" => "passed",
                "fail" | "cancel" => "failed",
                "skipping" => "skipped",
                // Queued until it starts.
                _ if started_at.is_some() && !matches!(c.state.as_str(), "QUEUED" | "PENDING" | "WAITING") => "running",
                _ => "pending",
            };
            let link = Some(c.link).filter(|l| !l.is_empty());
            CiCheck {
                name: c.name,
                status: status.into(),
                started_at,
                completed_at: if status == "running" || status == "pending" { None } else { timestamp(&c.completed_at) },
                job: link.as_deref().and_then(job_id),
                link,
            }
        })
        .collect())
}

/// The Actions job in a check's link (`…/actions/runs/<run>/job/<job>`).
fn job_id(link: &str) -> Option<u64> {
    let (_, rest) = link.split_once("/job/")?;
    rest.split(['/', '?', '#']).next()?.parse().ok()
}

/// RFC 3339 in UTC (what GitHub sends) to Unix milliseconds; GitHub's zero time is `None`.
fn timestamp(text: &str) -> Option<i64> {
    let t = text.trim().trim_end_matches('Z');
    let (date, time) = t.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    if y < 1970 {
        return None;
    }
    let time = time.split(['+', '.']).next()?;
    let mut h = time.split(':').map(|p| p.parse::<i64>().ok());
    let (hh, mm, ss) = (h.next()??, h.next()??, h.next().flatten().unwrap_or(0));
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400) + hh * 3_600 + mm * 60 + ss) * 1_000)
}

/// Failures already read, by job: a finished job's log doesn't change.
static FAILURES: Mutex<Option<HashMap<u64, Failure>>> = Mutex::new(None);

/// Why an Actions job failed, from its log. The jobs API has a job's log as
/// soon as the job ends; `gh run view` only once the whole run has, so it's
/// the fallback.
pub fn failure(root: &Path, job: u64) -> Result<Failure, String> {
    if let Some(f) = FAILURES.lock().unwrap().as_ref().and_then(|m| m.get(&job)) {
        return Ok(f.clone());
    }
    // Logs carry the runners' colour codes, which gh api won't print without the flag (`explain` strips them).
    let log = gh(root, &["api", "--allow-escape-sequences", &format!("repos/{{owner}}/{{repo}}/actions/jobs/{job}/logs")])
        .or_else(|_| gh(root, &["run", "view", "--job", &job.to_string(), "--log-failed"]))?;
    let found = explain(&log);
    FAILURES.lock().unwrap().get_or_insert_with(HashMap::new).insert(job, found.clone());
    Ok(found)
}

/// Lines `--log-failed` prints are `<job>\t<step>\t<time> <text>`; the text alone.
fn log_text(line: &str) -> &str {
    let text = line.rsplit('\t').next().unwrap_or(line);
    // GitHub's own timestamp, e.g. `2026-11-02T10:00:00.1234567Z `.
    match text.split_once(' ') {
        Some((stamp, rest)) if stamp.len() >= 20 && stamp.ends_with('Z') && stamp.as_bytes()[4] == b'-' => rest,
        _ => text,
    }
}

/// A path in a hosted runner's checkout (`/home/runner/work/<repo>/<repo>/…`), relative to the repository.
fn in_repo(path: &str) -> &str {
    let checkout = regex::Regex::new(r"^/(?:home|Users)/runner/work/[^/]+/[^/]+/").unwrap();
    match checkout.find(path) {
        Some(m) => &path[m.end()..],
        None => path.trim_start_matches("./"),
    }
}

/// Lines without the prefix a workspace runner puts on each (`bun --filter`: `desktop test: `), when most share one.
fn without_prefix<'a>(lines: &[&'a str]) -> Vec<&'a str> {
    let label = regex::Regex::new(r"^[\w@/.-]+ [\w:.-]+: ").unwrap();
    let prefix = lines.iter().find_map(|l| label.find(l).map(|m| &l[..m.end()]));
    match prefix {
        Some(p) if lines.iter().filter(|l| l.starts_with(p)).count() * 2 >= lines.len() => {
            lines.iter().map(|l| l.strip_prefix(p).unwrap_or(l)).collect()
        }
        _ => lines.to_vec(),
    }
}

/// Picks out the first failing test, where it is, and what it expected and got.
fn explain(log: &str) -> Failure {
    // Runners colour their output on CI (vitest, jest), and the log keeps the codes.
    let ansi = regex::Regex::new(r"\x1b\[[0-9;]*[A-Za-z]").unwrap();
    let clean: Vec<String> = log.lines().map(|l| ansi.replace_all(log_text(l), "").trim_end().to_string()).collect();
    let clean: Vec<&str> = clean.iter().map(String::as_str).collect();
    let lines: Vec<&str> = without_prefix(&clean).into_iter().filter(|l| !l.trim().is_empty()).collect();
    // A whole job's log goes on past the failure (`##[error]Process completed…`, cleanup steps); the runner's own
    // `##[group]` lines are noise.
    let end = "##[error]Process completed";
    let cut = lines.iter().position(|l| l.contains(end)).map_or(lines.len(), |i| i + 1);
    let lines: Vec<&str> = lines[..cut]
        .iter()
        .copied()
        .filter(|l| !l.trim_start().starts_with("##["))
        .chain(lines[..cut].last().filter(|l| l.contains(end)).map(|l| l.trim_start().trim_start_matches("##[error]")))
        .collect();
    let mut f = Failure::default();
    let location = regex::Regex::new(r"([\w./-]+\.(?:[cm]?[jt]sx?|rs|py|go|rb)):(\d+)").unwrap();
    let quoted = |s: &str| s.trim().trim_start_matches(':').trim().to_string();
    // A diff's lines (bun, jest: `-   "a",` expected, `+   "b",` received), for when there's no `Expected:` line.
    let (mut minus, mut plus) = (Vec::<String>::new(), Vec::<String>::new());
    // Bun names a failed test after its error, and the next failure's error follows: values come from the first only.
    let mut errors = 0;
    // Diff lines count only after an assertion's error, not any `- ` line a log prints.
    let mut asserting = false;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t.starts_with("error:") {
            errors += 1;
        }
        asserting |= t.contains("expect(") || t.starts_with("AssertionError");
        let first = errors <= 1;
        if first && f.expected.is_none() {
            if let Some(rest) = t.strip_prefix("Expected:").or_else(|| t.strip_prefix("Expected")) {
                f.expected = Some(quoted(rest)).filter(|s| !s.is_empty());
            } else if let Some(rest) = t.strip_prefix("left:") {
                // Rust's `assert_eq!`: left is what the code produced.
                f.received = Some(quoted(rest));
            }
        }
        if first && f.received.is_none() {
            if let Some(rest) = t.strip_prefix("Received:").or_else(|| t.strip_prefix("Received")) {
                f.received = Some(quoted(rest)).filter(|s| !s.is_empty());
            }
        } else if first && f.expected.is_none() {
            if let Some(rest) = t.strip_prefix("right:") {
                f.expected = Some(quoted(rest));
            }
        }
        // Up to the failure's location: vitest repeats the diff in a GitHub annotation after it.
        if first && asserting && f.location.is_none() {
            // Not the diff's own header (`- Expected  - 1`, `+ Received`).
            let diff = |sign: &str, head: &str| t.strip_prefix(sign).map(str::trim).filter(|r| !r.is_empty() && !r.starts_with(head));
            if let Some(r) = diff("- ", "Expected") {
                minus.push(r.trim_end_matches(',').to_string());
            } else if let Some(r) = diff("+ ", "Received") {
                plus.push(r.trim_end_matches(',').to_string());
            }
        }
        if f.title.is_none() {
            // bun `(fail) suite > test [1.2ms]`, vitest/jest `FAIL  file > suite > test`,
            // playwright `✘ 1 [chromium] › file:12:3 › suite › test`, cargo `---- name stdout ----`.
            if let Some(rest) = t.strip_prefix("(fail) ") {
                let rest = regex::Regex::new(r"\s*\[[\d.]+m?s\]$").unwrap().replace(rest, "");
                f.title = Some(rest.split('>').map(str::trim).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" › "));
            } else if let Some(rest) = t.strip_prefix("FAIL ").or_else(|| t.strip_prefix("× ")).or_else(|| t.strip_prefix("✘ ")) {
                // Leave out the file, playwright's `3 [chromium]`, a `file:line`, and the time it took.
                let noise = regex::Regex::new(r"^(?:[\w./-]+\.\w+|\d+ \[[^\]]+\])$").unwrap();
                let took = regex::Regex::new(r"\s*(?:\(\d+(?:\.\d+)?m?s\)|\d+(?:\.\d+)?ms)$").unwrap();
                let parts: Vec<String> = rest
                    .split(['›', '>'])
                    .map(str::trim)
                    .filter(|p| !p.is_empty() && !noise.is_match(p) && !location.is_match(p))
                    .map(|p| took.replace(p, "").into_owned())
                    .collect();
                if !parts.is_empty() {
                    f.title = Some(parts.join(" › "));
                }
            } else if let Some(name) = t.strip_prefix("---- ").and_then(|r| r.strip_suffix(" stdout ----")) {
                f.title = Some(name.to_string());
            }
        }
        // A stack line counts once a test's assertion failed: tests also log warnings with stacks.
        if f.location.is_none()
            && (f.title.is_some() || i + 1 == lines.len() || (asserting && t.starts_with("at ")) || t.contains("panicked at"))
        {
            if let Some(c) = location.captures(t).filter(|c| !c[1].contains("node_modules")) {
                f.location = Some(format!("{}:{}", in_repo(&c[1]), &c[2]));
            }
        }
    }
    if f.expected.is_none() && f.received.is_none() && (!minus.is_empty() || !plus.is_empty()) {
        let few = |v: Vec<String>| Some(v.into_iter().take(3).collect::<Vec<_>>().join(", ")).filter(|s| !s.is_empty());
        f.expected = few(minus);
        f.received = few(plus);
    }
    if f.expected.is_none() && f.received.is_none() {
        f.tail = lines.iter().rev().take(12).rev().map(|l| l.chars().take(240).collect()).collect();
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_pull_request() {
        let pr = parse_pr(
            r#"{"number":128,"url":"https://github.com/o/r/pull/128","state":"OPEN","isDraft":false,"headRefOid":"d29f50a","baseRefName":"main"}"#,
        )
        .unwrap();
        assert_eq!((pr.number, pr.state.as_str(), pr.base.as_str()), (128, "open", "main"));
        let draft = parse_pr(r#"{"number":1,"url":"u","state":"OPEN","isDraft":true,"headRefOid":"a","baseRefName":"main"}"#).unwrap();
        assert_eq!(draft.state, "draft");
        let merged = parse_pr(r#"{"number":1,"url":"u","state":"MERGED","isDraft":false,"headRefOid":"a","baseRefName":"main"}"#).unwrap();
        assert_eq!(merged.state, "merged");
    }

    #[test]
    fn reads_checks_and_their_timing() {
        let checks = parse_checks(
            r#"[
              {"name":"lint","bucket":"pass","state":"SUCCESS","startedAt":"2026-11-02T10:00:00Z","completedAt":"2026-11-02T10:00:11Z","link":"https://github.com/o/r/actions/runs/9/job/41"},
              {"name":"e2e","bucket":"pending","state":"IN_PROGRESS","startedAt":"2026-11-02T10:00:05Z","completedAt":"0001-01-01T00:00:00Z","link":"https://github.com/o/r/actions/runs/9/job/42"},
              {"name":"unit","bucket":"pending","state":"QUEUED","startedAt":"0001-01-01T00:00:00Z","completedAt":"0001-01-01T00:00:00Z","link":""},
              {"name":"Vercel","bucket":"fail","state":"FAILURE","startedAt":"2026-11-02T10:00:01Z","completedAt":"2026-11-02T10:00:41Z","link":"https://vercel.com/x"}
            ]"#,
        )
        .unwrap();
        let s: Vec<&str> = checks.iter().map(|c| c.status.as_str()).collect();
        assert_eq!(s, ["passed", "running", "pending", "failed"]);
        assert_eq!(checks[0].completed_at.unwrap() - checks[0].started_at.unwrap(), 11_000);
        assert_eq!(checks[0].job, Some(41));
        assert_eq!(checks[1].completed_at, None);
        assert_eq!(checks[2].started_at, None);
        assert_eq!(checks[3].job, None);
    }

    #[test]
    fn converts_timestamps() {
        assert_eq!(timestamp("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(timestamp("2026-11-02T10:00:00Z"), Some(1_793_613_600_000));
        assert_eq!(timestamp("0001-01-01T00:00:00Z"), None);
        assert_eq!(timestamp(""), None);
    }

    #[test]
    fn explains_a_playwright_failure() {
        let log = "e2e\tRun tests\t2026-11-02T10:00:30.1234567Z   ✘  3 [chromium] › e2e/checkout.spec.ts:42:5 › checkout › keeps the cart after a session refresh (2.1s)\n\
                   e2e\tRun tests\t2026-11-02T10:00:30.2Z     Error: expect(received).toHaveURL(expected)\n\
                   e2e\tRun tests\t2026-11-02T10:00:30.3Z     Expected: \"/checkout\"\n\
                   e2e\tRun tests\t2026-11-02T10:00:30.4Z     Received: \"/sign-in?next=%2Fcheckout\"\n\
                   e2e\tRun tests\t2026-11-02T10:00:30.5Z       at e2e/checkout.spec.ts:42:5";
        let f = explain(log);
        assert_eq!(f.title.as_deref(), Some("checkout › keeps the cart after a session refresh"));
        assert_eq!(f.location.as_deref(), Some("e2e/checkout.spec.ts:42"));
        assert_eq!(f.expected.as_deref(), Some("\"/checkout\""));
        assert_eq!(f.received.as_deref(), Some("\"/sign-in?next=%2Fcheckout\""));
        assert!(f.tail.is_empty());
    }

    #[test]
    fn explains_a_vitest_failure() {
        let log = " FAIL  src/session.test.ts > refresh > reads expiry from the token\n\
                   AssertionError: expected 3600 to be 7200\n\
                   - Expected\n+ Received\n\
                   Expected: 7200\nReceived: 3600\n\
                    ❯ src/session.test.ts:18:22";
        let f = explain(log);
        assert_eq!(f.title.as_deref(), Some("refresh › reads expiry from the token"));
        assert_eq!(f.location.as_deref(), Some("src/session.test.ts:18"));
        assert_eq!((f.expected.as_deref(), f.received.as_deref()), (Some("7200"), Some("3600")));
    }

    #[test]
    fn explains_a_coloured_vitest_failure() {
        // vitest 3's output on a GitHub runner, colour codes and all.
        let stamp = "unit\tRun sleep 15 && npm test\t2026-11-03T10:00:30.0000000Z ";
        let log = [
            " \x1b[31m❯\x1b[39m src/cart.test.ts \x1b[2m(\x1b[22m\x1b[2m3 tests\x1b[22m\x1b[2m | \x1b[22m\x1b[31m1 failed\x1b[39m\x1b[2m)\x1b[22m",
            "\x1b[31m   \x1b[31m×\x1b[31m shipping\x1b[2m > \x1b[22mis free at exactly the threshold\x1b[39m\x1b[32m 4\x1b[2mms\x1b[22m\x1b[39m",
            "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m src/cart.test.ts\x1b[2m > \x1b[22mshipping\x1b[2m > \x1b[22mis free at exactly the threshold",
            "\x1b[31m\x1b[1mAssertionError\x1b[22m: expected 49 to be +0 // Object.is equality\x1b[39m",
            "\x1b[32m- Expected\x1b[39m",
            "\x1b[31m+ Received\x1b[39m",
            "\x1b[32m- 0\x1b[39m",
            "\x1b[31m+ 49\x1b[39m",
            "\x1b[36m \x1b[2m❯\x1b[22m src/cart.test.ts:\x1b[2m7:30\x1b[22m\x1b[39m",
            "    \x1b[90m  7| \x1b[39m    \x1b[34mexpect\x1b[39m(\x1b[34mshippingFee\x1b[39m(\x1b[34m500\x1b[39m))",
        ]
        .map(|l| format!("{stamp}{l}"))
        .join("\n");
        let f = explain(&log);
        assert_eq!(f.title.as_deref(), Some("shipping › is free at exactly the threshold"));
        assert_eq!(f.location.as_deref(), Some("src/cart.test.ts:7"));
        assert_eq!((f.expected.as_deref(), f.received.as_deref()), (Some("0"), Some("49")));
    }

    #[test]
    fn explains_a_cargo_failure() {
        let log = "---- tests::merges stdout ----\n\
                   thread 'tests::merges' panicked at src/merge.rs:31:9:\n\
                   assertion `left == right` failed\n  left: 2\n right: 3";
        let f = explain(log);
        assert_eq!(f.title.as_deref(), Some("tests::merges"));
        assert_eq!(f.location.as_deref(), Some("src/merge.rs:31"));
        assert_eq!((f.expected.as_deref(), f.received.as_deref()), (Some("3"), Some("2")));
    }

    #[test]
    fn explains_a_bun_failure_on_a_hosted_runner() {
        let stamp = "check\tRun bun --filter desktop test\t2026-11-03T10:00:00.0000000Z desktop test: ";
        let log = [
            "src/lib/keymap.test.ts:",
            "Could not persist plinth.keyboardLayout ReferenceError: localStorage is not defined",
            "      at write (/home/runner/work/plinth/plinth/apps/desktop/src/lib/store.ts:16:5)",
            "      at <anonymous> (/home/runner/work/plinth/plinth/apps/desktop/src/lib/keymap.test.ts:121:7)",
            "4 |     expect(keys(\"vector.flatten\")).toEqual([\"Alt+Shift+F\"]);",
            "error: expect(received).toEqual(expected)",
            "  [",
            "-   \"Alt+Shift+F\",",
            "+   \"Alt+F\",",
            "  ]",
            "- Expected  - 1",
            "+ Received  + 1",
            "      at <anonymous> (/home/runner/work/plinth/plinth/apps/desktop/src/lib/keymap.test.ts:45:38)",
            "(fail) default bindings > the vector and type shortcuts are Figma's current ones [6.80ms]",
            "error: expect(received).toBe(expected)",
            "Expected: 0",
            "Received: 49",
            "(fail) default bindings > plain [1.15ms]",
        ]
        .map(|l| format!("{stamp}{l}"))
        .join("\n");
        let f = explain(&log);
        assert_eq!(f.title.as_deref(), Some("default bindings › the vector and type shortcuts are Figma's current ones"));
        assert_eq!(f.location.as_deref(), Some("apps/desktop/src/lib/keymap.test.ts:45"));
        assert_eq!((f.expected.as_deref(), f.received.as_deref()), (Some("\"Alt+Shift+F\""), Some("\"Alt+F\"")));
    }

    #[test]
    fn reads_the_diff_once_when_an_annotation_repeats_it() {
        // `gh run view --log-failed` on the demo repo's failed job (colour codes left out).
        let p = "unit\tRun sleep 15 && npm test\t";
        let log = [
            "2026-11-02T19:21:05.8540000Z  FAIL  src/cart.test.ts > shipping > is free at exactly the threshold",
            "2026-11-02T19:21:05.8550000Z AssertionError: expected 49 to be +0 // Object.is equality",
            "2026-11-02T19:21:05.8560000Z - Expected",
            "2026-11-02T19:21:05.8560500Z + Received",
            "2026-11-02T19:21:05.8570591Z - 0",
            "2026-11-02T19:21:05.8571048Z + 49",
            "2026-11-02T19:21:05.8571732Z  ❯ src/cart.test.ts:7:30",
            "2026-11-02T19:21:05.8635417Z ##[error]AssertionError: expected 49 to be +0 // Object.is equality",
            "- Expected",
            "+ Received",
            "- 0",
            "+ 49",
            " ❯ src/cart.test.ts:7:30",
            "2026-11-02T19:21:05.9591165Z ##[error]Process completed with exit code 1.",
        ]
        .map(|l| format!("{p}{l}"))
        .join("\n");
        let f = explain(&log);
        assert_eq!(f.title.as_deref(), Some("shipping › is free at exactly the threshold"));
        assert_eq!(f.location.as_deref(), Some("src/cart.test.ts:7"));
        assert_eq!((f.expected.as_deref(), f.received.as_deref()), (Some("0"), Some("49")));
    }

    #[test]
    fn a_whole_job_log_ends_at_its_error() {
        // The jobs API's log: a timestamp on each line, the runner's markers, cleanup after the failure.
        let log = "2026-11-03T10:00:01.0000000Z ##[group]Run npm run lint\n\
                   2026-11-03T10:00:02.0000000Z console.log left in: cart.ts\n\
                   2026-11-03T10:00:02.1000000Z ##[error]Process completed with exit code 1.\n\
                   2026-11-03T10:00:03.0000000Z Post job cleanup.\n\
                   2026-11-03T10:00:04.0000000Z Cleaning up orphan processes";
        let f = explain(log);
        assert_eq!(f.tail, ["console.log left in: cart.ts", "Process completed with exit code 1."]);
    }

    #[test]
    fn falls_back_to_the_logs_tail() {
        let f = explain("npm ERR! missing script: lint\nProcess completed with exit code 1.");
        assert_eq!(f.tail.len(), 2);
        assert!(f.expected.is_none());
    }
}
