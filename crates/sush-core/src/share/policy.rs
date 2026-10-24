//! Whether a guest may do what it asks. Deny by default.
//!
//! The sender's role comes from the host's own list of members, keyed by the
//! identity the relay vouches for; nothing in the message itself counts.
//! Every member reads, but only what the shared session shows: the files its
//! tool calls named and the turns that changed files, unless the owner lets
//! them browse. Secret-looking files are never sent.
//!
//! A driver steers the run, stops and resumes it, and answers the approvals
//! the owner delegated ([`may_answer`]). A collaborator's message waits as a
//! suggestion for the driver to accept. Viewers only watch.
//!
//! While anyone but the owner can steer, the owner's standing permissions
//! (edits without asking, sandboxed commands, "Always allow" connectors,
//! allowed sites) ask again ([`floored`]): otherwise a steer would run them on
//! the owner's authority.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Decision, Delegation, Image, Intent, Role, SharePolicy};
use crate::workspace::looks_secret;
use crate::workspace::tools as ws;

/// A message's text, at most.
pub const MAX_TEXT: usize = 16 * 1024;
/// A comment, at most.
pub const MAX_COMMENT: usize = 4 * 1024;
/// Images on one message, at most.
pub const MAX_IMAGES: usize = 3;
/// One image, decoded, at most.
pub const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/// An answer to the model's questions, serialized, at most.
const MAX_ANSWER: usize = 8 * 1024;

/// Who may answer a tool call that waits for approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalClass {
    /// Needs no approval: reads, and tools the app runs for itself.
    Read,
    /// File changes and commits.
    Edit,
    /// A command contained by the sandbox, without network.
    Shell,
    /// A command with network or outside the sandbox (or no sandbox), or a merge into another branch.
    ShellEscalated,
    /// A connector tool, with the owner's accounts.
    Connector,
    /// Opening a site in the built-in browser.
    Browser,
    /// Reading a secret-looking file. Once the model has it, a driver could
    /// steer it into a file or a command, so only the owner answers.
    SecretRead,
    /// The model's questions.
    AskUser,
    /// Anything else (saving a skill or an automation to the owner's library).
    OwnerOnly,
}

/// What kind of approval a call needs. `contained`: the host's sandbox is
/// available and blocks the network.
pub fn classify(name: &str, input: &Value, contained: bool) -> ApprovalClass {
    let flag = |key: &str| input.get(key).and_then(Value::as_bool).unwrap_or(false);
    match name {
        ws::SHELL_RUN if contained && !flag("network") && !flag("unsandboxed") => ApprovalClass::Shell,
        ws::SHELL_RUN => ApprovalClass::ShellEscalated,
        ws::GIT_MERGE if flag("into") => ApprovalClass::ShellEscalated,
        ws::FS_WRITE | ws::FS_EDIT | ws::FS_MOVE | ws::FS_DELETE | ws::GIT_COMMIT | ws::GIT_MERGE => ApprovalClass::Edit,
        ws::FS_READ if input.get("path").and_then(Value::as_str).is_some_and(looks_secret) => ApprovalClass::SecretRead,
        crate::browser::BROWSER_NAVIGATE => ApprovalClass::Browser,
        "ask_user" => ApprovalClass::AskUser,
        _ if ws::is_workspace_tool(name) || crate::browser::is_browser_tool(name) => ApprovalClass::Read,
        _ if name.contains("__") => ApprovalClass::Connector,
        _ => ApprovalClass::OwnerOnly,
    }
}

/// Whether a call the owner's own rules would run without asking must ask
/// while others can steer. Its class decides; reads never ask.
pub fn floored(class: ApprovalClass) -> bool {
    matches!(
        class,
        ApprovalClass::Edit | ApprovalClass::Shell | ApprovalClass::ShellEscalated | ApprovalClass::Connector | ApprovalClass::Browser
    )
}

/// Whether someone in `role` may answer a call of `class`. The owner answers
/// from their own app, so only the driver comes into it here.
pub fn may_answer(role: Role, class: ApprovalClass, delegation: &Delegation) -> bool {
    if role != Role::Driver {
        return false;
    }
    match class {
        ApprovalClass::AskUser => true,
        ApprovalClass::Edit => delegation.edits,
        ApprovalClass::Shell => delegation.shell,
        ApprovalClass::ShellEscalated => delegation.escalated,
        ApprovalClass::Connector => delegation.connectors,
        ApprovalClass::Browser => delegation.browser,
        ApprovalClass::SecretRead | ApprovalClass::OwnerOnly | ApprovalClass::Read => false,
    }
}

/// What the host knows when it checks an intent.
pub struct Ctx<'a> {
    /// The sender's role, or None if they aren't (or are no longer) a member.
    pub role: Option<Role>,
    pub policy: &'a SharePolicy,
    /// Whether the session works in a folder.
    pub cowork: bool,
    /// Paths the thread's tool calls named (`outbox::touched_paths`).
    pub touched: &'a HashSet<String>,
    /// Turns that changed files.
    pub turns: &'a HashSet<String>,
    /// Blobs the thread's file parts show (`outbox::blob_shas`).
    pub blobs: &'a HashSet<String>,
    /// Tool calls waiting for an answer, by thread (`None`: the session) and
    /// call id, with the approval each needs.
    pub waiting: &'a HashMap<(Option<String>, String), ApprovalClass>,
    /// The session's last reply was stopped, or its last message wasn't answered.
    pub resumable: bool,
    /// Suggestions waiting, by id.
    pub suggestions: &'a HashSet<String>,
}

/// An intent the host may carry out.
#[derive(Debug, Clone, PartialEq)]
pub enum Allowed {
    /// As asked, with any path in it normalised.
    Do(Intent),
    /// A collaborator's message: it waits for the driver.
    Suggest { text: String, images: Vec<Image> },
}

pub fn authorize(ctx: &Ctx, intent: Intent) -> Result<Allowed, String> {
    let role = match ctx.role {
        None => return Err("You're no longer in this session.".into()),
        // Owner actions come from the owner's own app, never from the network.
        Some(Role::Owner) => return Err("That can't be done from here.".into()),
        Some(role) => role,
    };
    let driver = || if role == Role::Driver { Ok(()) } else { Err("Only the driver can do that.".to_string()) };
    let intent = match intent {
        Intent::GetTurnChanges => Intent::GetTurnChanges,
        Intent::GetDiff { turn_id } => {
            if !ctx.turns.contains(&turn_id) {
                return Err("That turn didn't change any files.".into());
            }
            Intent::GetDiff { turn_id }
        }
        Intent::GetFile { path } => {
            let path = normalize(&path).filter(|p| !p.is_empty()).ok_or("That isn't a file in this session's folder.")?;
            if !ctx.cowork {
                return Err("This session has no folder.".into());
            }
            if looks_secret(&path) {
                return Err("Secret files aren't shared.".into());
            }
            if !ctx.policy.browse_files && !ctx.touched.contains(&path) {
                return Err("The host only shares the files this session worked on.".into());
            }
            Intent::GetFile { path }
        }
        Intent::ListDir { path } => {
            let path = normalize(&path).ok_or("That isn't a folder in this session's folder.")?;
            if !ctx.cowork || !ctx.policy.browse_files {
                return Err("The host doesn't share this session's folder.".into());
            }
            Intent::ListDir { path }
        }
        Intent::GetBlob { sha } => {
            if !ctx.blobs.contains(&sha) {
                return Err("That file isn't in this session.".into());
            }
            Intent::GetBlob { sha }
        }
        Intent::Steer { text, images } => {
            check_message(&text, &images)?;
            return match role {
                Role::Driver => Ok(Allowed::Do(Intent::Steer { text, images })),
                Role::Collaborator => Ok(Allowed::Suggest { text, images }),
                _ => Err("You're watching this session. Ask the host to let you suggest.".into()),
            };
        }
        Intent::SuggestionAccept { id, text } => {
            driver()?;
            if !ctx.suggestions.contains(&id) {
                return Err("That suggestion is gone.".into());
            }
            if let Some(text) = &text {
                check_message(text, &[])?;
            }
            Intent::SuggestionAccept { id, text }
        }
        Intent::SuggestionDrop { id } => {
            driver()?;
            if !ctx.suggestions.contains(&id) {
                return Err("That suggestion is gone.".into());
            }
            Intent::SuggestionDrop { id }
        }
        Intent::SendNow => {
            driver()?;
            Intent::SendNow
        }
        Intent::Stop => {
            driver()?;
            Intent::Stop
        }
        Intent::Resume => {
            driver()?;
            if !ctx.resumable {
                return Err("There's nothing to resume.".into());
            }
            Intent::Resume
        }
        Intent::Respond { child, call_id, decision, answer } => {
            let class = *ctx
                .waiting
                .get(&(child.clone(), call_id.clone()))
                .ok_or("That isn't waiting for an answer any more.")?;
            if !may_answer(role, class, &ctx.policy.delegation) {
                return Err("Only the host can answer that.".into());
            }
            if let Some(answer) = &answer {
                if class != ApprovalClass::AskUser || decision != Decision::Approve {
                    return Err("Only the model's questions take an answer.".into());
                }
                check_answer(answer)?;
            } else if class == ApprovalClass::AskUser && decision == Decision::Approve {
                return Err("Answer the questions first.".into());
            }
            Intent::Respond { child, call_id, decision, answer }
        }
        Intent::Comment { text, message_id } => {
            if !matches!(role, Role::Driver | Role::Collaborator) {
                return Err("You're watching this session. Ask the host to let you comment.".into());
            }
            if text.trim().is_empty() || text.len() > MAX_COMMENT {
                return Err("A comment is between 1 and 4,096 characters.".into());
            }
            Intent::Comment { text, message_id }
        }
    };
    Ok(Allowed::Do(intent))
}

/// A message a guest sends: some text or an image, within limits, images of a type the transcript shows.
fn check_message(text: &str, images: &[Image]) -> Result<(), String> {
    if text.trim().is_empty() && images.is_empty() {
        return Err("The message is empty.".into());
    }
    if text.len() > MAX_TEXT {
        return Err("That message is too long.".into());
    }
    if images.len() > MAX_IMAGES {
        return Err(format!("Attach at most {MAX_IMAGES} images."));
    }
    for image in images {
        if !IMAGE_TYPES.contains(&image.media_type.as_str()) {
            return Err("Only PNG, JPEG, GIF and WebP images can be attached.".into());
        }
        // Base64 is four characters for every three bytes.
        if image.data.len() / 4 * 3 > MAX_IMAGE_BYTES {
            return Err("Each image can be at most 2 MB.".into());
        }
    }
    Ok(())
}

/// An answer to `ask_user`, in the shape its card gives: `[{ question, answer: [..] | null }]`.
fn check_answer(answer: &Value) -> Result<(), String> {
    let bad = || "That answer isn't one the question takes.".to_string();
    let items = answer.as_array().ok_or_else(bad)?;
    if items.is_empty() || items.len() > 4 || answer.to_string().len() > MAX_ANSWER {
        return Err(bad());
    }
    for item in items {
        let ok = item.get("question").is_some_and(Value::is_string)
            && match item.get("answer") {
                Some(Value::Null) => true,
                Some(Value::Array(picks)) => picks.iter().all(Value::is_string),
                _ => false,
            };
        if !ok {
            return Err(bad());
        }
    }
    Ok(())
}

/// A path relative to the workspace with forward slashes, or None if it could
/// point outside it. The host's file access (`WorkspaceFs`) checks again.
pub fn normalize(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    if path.starts_with('/') || path.contains(':') || path.contains('\0') {
        return None;
    }
    let parts: Vec<&str> = path.split('/').filter(|c| !c.is_empty() && *c != ".").collect();
    if parts.iter().any(|c| *c == "..") {
        return None;
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture {
        policy: SharePolicy,
        touched: HashSet<String>,
        turns: HashSet<String>,
        blobs: HashSet<String>,
        waiting: HashMap<(Option<String>, String), ApprovalClass>,
        resumable: bool,
        suggestions: HashSet<String>,
    }

    fn fixture(browse: bool) -> Fixture {
        Fixture {
            policy: SharePolicy { browse_files: browse, delegation: Delegation::default() },
            touched: ["src/a.rs".to_string(), ".env".to_string()].into(),
            turns: ["t1".to_string()].into(),
            blobs: ["f".repeat(64)].into(),
            waiting: [
                ((None, "edit".to_string()), ApprovalClass::Edit),
                ((None, "ask".to_string()), ApprovalClass::AskUser),
                ((None, "secret".to_string()), ApprovalClass::SecretRead),
                ((Some("agent".to_string()), "shell".to_string()), ApprovalClass::Shell),
            ]
            .into(),
            resumable: false,
            suggestions: ["s1".to_string()].into(),
        }
    }

    fn check(f: &Fixture, role: Option<Role>, intent: Intent) -> Result<Allowed, String> {
        let ctx = Ctx {
            role,
            policy: &f.policy,
            cowork: true,
            touched: &f.touched,
            turns: &f.turns,
            blobs: &f.blobs,
            waiting: &f.waiting,
            resumable: f.resumable,
            suggestions: &f.suggestions,
        };
        authorize(&ctx, intent)
    }

    fn respond(child: Option<&str>, call: &str) -> Intent {
        Intent::Respond { child: child.map(str::to_owned), call_id: call.into(), decision: Decision::Approve, answer: None }
    }

    #[test]
    fn viewers_read_what_the_session_shows() {
        let f = fixture(false);
        let viewer = Some(Role::Viewer);
        assert!(check(&f, viewer, Intent::GetTurnChanges).is_ok());
        assert!(check(&f, viewer, Intent::GetDiff { turn_id: "t1".into() }).is_ok());
        assert!(check(&f, viewer, Intent::GetDiff { turn_id: "other".into() }).is_err());
        assert_eq!(
            check(&f, viewer, Intent::GetFile { path: "./src\\a.rs".into() }),
            Ok(Allowed::Do(Intent::GetFile { path: "src/a.rs".into() }))
        );
        assert!(check(&f, viewer, Intent::GetFile { path: "src/b.rs".into() }).is_err());
        assert!(check(&f, viewer, Intent::GetBlob { sha: "f".repeat(64) }).is_ok());
        assert!(check(&f, viewer, Intent::GetBlob { sha: "0".repeat(64) }).is_err());
    }

    #[test]
    fn browsing_needs_the_owners_leave_and_never_reaches_secrets() {
        let f = fixture(false);
        assert!(check(&f, Some(Role::Viewer), Intent::ListDir { path: String::new() }).is_err());
        let f = fixture(true);
        assert!(check(&f, Some(Role::Viewer), Intent::ListDir { path: String::new() }).is_ok());
        assert!(check(&f, Some(Role::Viewer), Intent::GetFile { path: "src/b.rs".into() }).is_ok());
        // Even one the agent read.
        assert!(check(&f, Some(Role::Viewer), Intent::GetFile { path: ".env".into() }).is_err());
        assert!(check(&f, Some(Role::Viewer), Intent::GetFile { path: "keys/server.pem".into() }).is_err());
    }

    #[test]
    fn paths_that_could_escape_are_refused() {
        let f = fixture(true);
        for bad in ["../x", "src/../../etc/passwd", "/etc/passwd", "C:/Windows/win.ini", "\\\\server\\share", ""] {
            assert!(check(&f, Some(Role::Viewer), Intent::GetFile { path: bad.into() }).is_err(), "{bad}");
        }
        assert!(check(&f, Some(Role::Viewer), Intent::ListDir { path: "../".into() }).is_err());
    }

    #[test]
    fn strangers_and_owner_claims_are_refused() {
        let f = fixture(true);
        for intent in [Intent::GetTurnChanges, Intent::Stop, Intent::Steer { text: "hi".into(), images: vec![] }] {
            assert!(check(&f, None, intent.clone()).is_err());
            assert!(check(&f, Some(Role::Owner), intent).is_err());
        }
    }

    #[test]
    fn a_drivers_message_steers_and_a_collaborators_waits() {
        let f = fixture(false);
        let steer = Intent::Steer { text: "use tabs".into(), images: vec![] };
        assert_eq!(check(&f, Some(Role::Driver), steer.clone()), Ok(Allowed::Do(steer.clone())));
        assert_eq!(check(&f, Some(Role::Collaborator), steer.clone()), Ok(Allowed::Suggest { text: "use tabs".into(), images: vec![] }));
        assert!(check(&f, Some(Role::Viewer), steer).is_err());
        assert!(check(&f, Some(Role::Driver), Intent::Steer { text: "  ".into(), images: vec![] }).is_err());
        assert!(check(&f, Some(Role::Driver), Intent::Steer { text: "x".repeat(MAX_TEXT + 1), images: vec![] }).is_err());
    }

    #[test]
    fn images_are_checked_for_type_size_and_count() {
        let f = fixture(false);
        let image = |media_type: &str, len: usize| Image { media_type: media_type.into(), data: "A".repeat(len), filename: None };
        let steer = |images| Intent::Steer { text: String::new(), images };
        assert!(check(&f, Some(Role::Driver), steer(vec![image("image/png", 100)])).is_ok());
        assert!(check(&f, Some(Role::Driver), steer(vec![image("image/svg+xml", 100)])).is_err());
        assert!(check(&f, Some(Role::Driver), steer(vec![image("text/html", 100)])).is_err());
        assert!(check(&f, Some(Role::Driver), steer(vec![image("image/png", MAX_IMAGE_BYTES * 2)])).is_err());
        assert!(check(&f, Some(Role::Driver), steer(vec![image("image/png", 4); MAX_IMAGES + 1])).is_err());
    }

    #[test]
    fn only_the_driver_runs_the_session() {
        let mut f = fixture(false);
        for intent in [Intent::SendNow, Intent::Stop, Intent::SuggestionDrop { id: "s1".into() }, Intent::SuggestionAccept { id: "s1".into(), text: None }] {
            assert!(check(&f, Some(Role::Driver), intent.clone()).is_ok(), "{intent:?}");
            assert!(check(&f, Some(Role::Collaborator), intent.clone()).is_err(), "{intent:?}");
            assert!(check(&f, Some(Role::Viewer), intent).is_err());
        }
        assert!(check(&f, Some(Role::Driver), Intent::SuggestionDrop { id: "gone".into() }).is_err());
        assert!(check(&f, Some(Role::Driver), Intent::Resume).is_err());
        f.resumable = true;
        assert!(check(&f, Some(Role::Driver), Intent::Resume).is_ok());
    }

    #[test]
    fn approvals_follow_the_delegation() {
        let mut f = fixture(false);
        let driver = Some(Role::Driver);
        // Nothing delegated: the driver only answers the model's questions (or dismisses them).
        let dismiss = Intent::Respond { child: None, call_id: "ask".into(), decision: Decision::Deny, answer: None };
        assert!(check(&f, driver, dismiss).is_ok());
        assert!(check(&f, driver, respond(None, "ask")).is_err(), "approving a question needs its answer");
        assert!(check(&f, driver, respond(None, "edit")).is_err());
        assert!(check(&f, driver, respond(Some("agent"), "shell")).is_err());
        f.policy.delegation = Delegation { edits: true, shell: true, escalated: true, connectors: true, browser: true };
        assert!(check(&f, driver, respond(None, "edit")).is_ok());
        assert!(check(&f, driver, respond(Some("agent"), "shell")).is_ok());
        // The same call id on another thread isn't the one waiting.
        assert!(check(&f, driver, respond(None, "shell")).is_err());
        // Secret reads stay the owner's, whatever is delegated.
        assert!(check(&f, driver, respond(None, "secret")).is_err());
        // Collaborators never answer.
        let dismiss = Intent::Respond { child: None, call_id: "ask".into(), decision: Decision::Deny, answer: None };
        assert!(check(&f, Some(Role::Collaborator), dismiss).is_err());
        assert!(check(&f, driver, respond(None, "gone")).is_err());
    }

    #[test]
    fn only_questions_take_an_answer_and_only_well_formed_ones() {
        let f = fixture(false);
        let answer = |call: &str, answer: Value| Intent::Respond { child: None, call_id: call.into(), decision: Decision::Approve, answer: Some(answer) };
        let good = json!([{ "question": "Which?", "answer": ["A"] }, { "question": "Why?", "answer": null }]);
        assert!(check(&f, Some(Role::Driver), answer("ask", good.clone())).is_ok());
        assert!(check(&f, Some(Role::Driver), answer("ask", json!("made-up tool output"))).is_err());
        assert!(check(&f, Some(Role::Driver), answer("ask", json!([{ "question": "Which?", "answer": [1] }]))).is_err());
        let mut f = f;
        f.policy.delegation.edits = true;
        assert!(check(&f, Some(Role::Driver), answer("edit", good)).is_err());
    }

    #[test]
    fn comments_need_a_voice_and_a_limit() {
        let f = fixture(false);
        let comment = |text: &str| Intent::Comment { text: text.into(), message_id: None };
        assert!(check(&f, Some(Role::Collaborator), comment("looks good")).is_ok());
        assert!(check(&f, Some(Role::Viewer), comment("looks good")).is_err());
        assert!(check(&f, Some(Role::Driver), comment("")).is_err());
        assert!(check(&f, Some(Role::Driver), comment(&"x".repeat(MAX_COMMENT + 1))).is_err());
    }

    #[test]
    fn calls_are_classified_by_what_they_risk() {
        let c = |name: &str, input: Value, contained: bool| classify(name, &input, contained);
        assert_eq!(c("fs_edit", json!({ "path": "a.rs" }), true), ApprovalClass::Edit);
        assert_eq!(c("shell_run", json!({ "command": "ls" }), true), ApprovalClass::Shell);
        assert_eq!(c("shell_run", json!({ "command": "ls" }), false), ApprovalClass::ShellEscalated);
        assert_eq!(c("shell_run", json!({ "command": "curl x", "network": true }), true), ApprovalClass::ShellEscalated);
        assert_eq!(c("git_merge", json!({ "branch": "main", "into": true }), true), ApprovalClass::ShellEscalated);
        assert_eq!(c("fs_read", json!({ "path": ".env" }), true), ApprovalClass::SecretRead);
        assert_eq!(c("fs_read", json!({ "path": "src/a.rs" }), true), ApprovalClass::Read);
        assert_eq!(c("browser_navigate", json!({ "url": "https://x.dev" }), true), ApprovalClass::Browser);
        assert_eq!(c("browser_click", json!({ "ref": 1 }), true), ApprovalClass::Read);
        assert_eq!(c("github__create_issue", json!({}), true), ApprovalClass::Connector);
        assert_eq!(c("ask_user", json!({}), true), ApprovalClass::AskUser);
        assert_eq!(c("skill_save", json!({}), true), ApprovalClass::OwnerOnly);
        assert!(floored(ApprovalClass::Edit) && floored(ApprovalClass::Connector) && floored(ApprovalClass::Browser));
        assert!(!floored(ApprovalClass::Read) && !floored(ApprovalClass::AskUser));
    }
}
