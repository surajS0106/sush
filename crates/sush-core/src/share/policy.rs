//! Whether a guest may do what it asks. Deny by default.
//!
//! The sender's role comes from the host's own list of members, keyed by the
//! identity the relay vouches for; nothing in the message itself counts.
//! Phase 1 guests only read, and only what the shared session shows: the
//! files its tool calls named and the turns that changed files, unless the
//! owner lets them browse. Secret-looking files are never sent.

use std::collections::HashSet;

use super::{Intent, Role, SharePolicy};
use crate::workspace::looks_secret;

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
}

/// An intent the host may carry out, with any path in it normalised.
#[derive(Debug, Clone, PartialEq)]
pub struct Allowed(pub Intent);

pub fn authorize(ctx: &Ctx, intent: Intent) -> Result<Allowed, String> {
    match ctx.role {
        None => return Err("You're no longer in this session.".into()),
        // Owner actions come from the owner's own app, never from the network.
        Some(Role::Owner) => return Err("That can't be done from here.".into()),
        Some(_) => {}
    }
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
    };
    Ok(Allowed(intent))
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

    struct Fixture {
        policy: SharePolicy,
        touched: HashSet<String>,
        turns: HashSet<String>,
        blobs: HashSet<String>,
    }

    fn fixture(browse: bool) -> Fixture {
        Fixture {
            policy: SharePolicy { browse_files: browse },
            touched: ["src/a.rs".to_string(), ".env".to_string()].into(),
            turns: ["t1".to_string()].into(),
            blobs: ["f".repeat(64)].into(),
        }
    }

    fn check(f: &Fixture, role: Option<Role>, intent: Intent) -> Result<Allowed, String> {
        let ctx = Ctx { role, policy: &f.policy, cowork: true, touched: &f.touched, turns: &f.turns, blobs: &f.blobs };
        authorize(&ctx, intent)
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
            Ok(Allowed(Intent::GetFile { path: "src/a.rs".into() }))
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
        assert!(check(&f, None, Intent::GetTurnChanges).is_err());
        assert!(check(&f, Some(Role::Owner), Intent::GetTurnChanges).is_err());
    }
}
