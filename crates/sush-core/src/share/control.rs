//! Who drives a shared session, and how that changes hands.
//!
//! There is one driver at a time, or none, when the owner drives. A
//! collaborator or a viewer asks for control; the driver (or the owner)
//! accepts or declines; the driver passes control to anyone in the share, or
//! gives it back to the owner; the owner takes it back whenever they like.
//! Everything runs on the host, one change at a time, so two people passing
//! control at once can't both win: the second is no longer the driver.
//!
//! The owner can step away. What then happens to the run is the share's
//! [`AwayPolicy`]: by default it pauses at the next step boundary and the
//! driver role goes back to the owner, so nothing happens on the owner's
//! machine while nobody there is accountable for it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{Member, Role};

/// Requests for control waiting at once, at most.
pub const MAX_REQUESTS: usize = 10;
/// The longest a driver may keep a run going while the owner is away.
pub const MAX_AWAY_MINUTES: u32 = 8 * 60;

/// Someone asking for control.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub user_id: String,
    pub name: String,
    pub at: i64,
}

/// What happens to the run while the owner is away.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AwayMode {
    /// The run finishes what it's doing and pauses; the owner drives again. The default.
    #[default]
    Pause,
    /// The driver keeps going with what the owner delegated, for at most
    /// `minutes`; then the run pauses as above.
    KeepGoing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwayPolicy {
    #[serde(default)]
    pub mode: AwayMode,
    #[serde(default = "default_minutes")]
    pub minutes: u32,
}

fn default_minutes() -> u32 {
    30
}

impl Default for AwayPolicy {
    fn default() -> Self {
        Self { mode: AwayMode::Pause, minutes: default_minutes() }
    }
}

impl AwayPolicy {
    /// Within limits: at least a minute, at most [`MAX_AWAY_MINUTES`].
    pub fn clamped(self) -> Self {
        Self { minutes: self.minutes.clamp(1, MAX_AWAY_MINUTES), ..self }
    }
}

/// Who is changing control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    /// From the owner's own app.
    Owner,
    /// A member, by the user id the relay vouches for.
    Member(String),
}

/// A change to who drives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// Ask for control (a collaborator or a viewer).
    Request,
    /// The driver or the owner lets someone who asked drive.
    Accept { user_id: String },
    /// The driver or the owner turns a request down.
    Decline { user_id: String },
    /// The driver or the owner hands control to someone in the share.
    Pass { user_id: String },
    /// The driver gives control back to the owner.
    Release,
    /// The owner drives again.
    Take,
}

/// What a change did, for the audit log and for rechecking held approvals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub driver_before: Option<String>,
    pub driver_after: Option<String>,
}

impl Outcome {
    pub fn moved(&self) -> bool {
        self.driver_before != self.driver_after
    }
}

/// The driver now, if anyone but the owner drives.
pub fn driver(members: &BTreeMap<String, Member>) -> Option<String> {
    members.values().find(|m| m.role == Role::Driver).map(|m| m.user_id.clone())
}

/// Make `user_id` the driver (None: the owner); the driver before becomes a collaborator.
fn hand_to(members: &mut BTreeMap<String, Member>, user_id: Option<&str>) {
    for m in members.values_mut() {
        if m.role == Role::Driver && Some(m.user_id.as_str()) != user_id {
            m.role = Role::Collaborator;
        }
    }
    if let Some(m) = user_id.and_then(|id| members.get_mut(id)) {
        m.role = Role::Driver;
    }
}

/// Apply a change, or say why it can't be made. `now`: when, for a request.
pub fn apply(
    members: &mut BTreeMap<String, Member>,
    requests: &mut Vec<ControlRequest>,
    actor: &Actor,
    change: Change,
    now: i64,
) -> Result<Outcome, String> {
    let before = driver(members);
    // Whether the actor may hand control on: the owner, or whoever drives now.
    let holds = match actor {
        Actor::Owner => true,
        Actor::Member(id) => before.as_deref() == Some(id.as_str()),
    };
    let member_role = |members: &BTreeMap<String, Member>, id: &str| members.get(id).map(|m| m.role);
    match change {
        Change::Request => {
            let Actor::Member(id) = actor else { return Err("The owner drives already.".into()) };
            match member_role(members, id) {
                None => return Err("You're no longer in this session.".into()),
                Some(Role::Driver) => return Err("You're driving already.".into()),
                Some(_) => {}
            }
            if !requests.iter().any(|r| &r.user_id == id) {
                if requests.len() >= MAX_REQUESTS {
                    return Err("Too many people are asking for control. Try again soon.".into());
                }
                let name = members[id].name.clone();
                requests.push(ControlRequest { user_id: id.clone(), name, at: now });
            }
        }
        Change::Accept { user_id } => {
            if !holds {
                return Err("Only the driver can hand over control.".into());
            }
            let at = requests.iter().position(|r| r.user_id == user_id).ok_or("They're no longer asking for control.")?;
            requests.remove(at);
            if member_role(members, &user_id).is_none() {
                return Err("They're no longer in this session.".into());
            }
            hand_to(members, Some(&user_id));
        }
        Change::Decline { user_id } => {
            if !holds {
                return Err("Only the driver can answer that.".into());
            }
            let at = requests.iter().position(|r| r.user_id == user_id).ok_or("They're no longer asking for control.")?;
            requests.remove(at);
        }
        Change::Pass { user_id } => {
            if !holds {
                return Err("Only the driver can pass control.".into());
            }
            if matches!(actor, Actor::Member(id) if *id == user_id) {
                return Err("You're driving already.".into());
            }
            if member_role(members, &user_id).is_none() {
                return Err("They're no longer in this session.".into());
            }
            requests.retain(|r| r.user_id != user_id);
            hand_to(members, Some(&user_id));
        }
        Change::Release => {
            let Actor::Member(_) = actor else { return Err("Only the driver can give control back.".into()) };
            if !holds {
                return Err("You aren't driving.".into());
            }
            hand_to(members, None);
        }
        Change::Take => {
            if *actor != Actor::Owner {
                return Err("Only the owner can take control back.".into());
            }
            hand_to(members, None);
        }
    }
    Ok(Outcome { driver_before: before, driver_after: driver(members) })
}

/// Someone left the share for good (removed): their request goes, and if they drove, the owner does.
pub fn forget(members: &mut BTreeMap<String, Member>, requests: &mut Vec<ControlRequest>, user_id: &str) {
    requests.retain(|r| r.user_id != user_id);
    if members.get(user_id).is_some_and(|m| m.role == Role::Driver) {
        hand_to(members, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: &str, role: Role) -> (String, Member) {
        (id.into(), Member { user_id: id.into(), name: id.to_uppercase(), image: None, role, online: true })
    }

    fn room() -> BTreeMap<String, Member> {
        [member("d", Role::Driver), member("c", Role::Collaborator), member("v", Role::Viewer)].into()
    }

    fn by(id: &str) -> Actor {
        Actor::Member(id.into())
    }

    #[test]
    fn a_request_is_accepted_by_the_driver() {
        let (mut members, mut requests) = (room(), Vec::new());
        apply(&mut members, &mut requests, &by("v"), Change::Request, 1).unwrap();
        // Asking twice keeps one request.
        apply(&mut members, &mut requests, &by("v"), Change::Request, 2).unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].name, "V");
        // Only the driver (or the owner) can accept it.
        assert!(apply(&mut members, &mut requests, &by("c"), Change::Accept { user_id: "v".into() }, 3).is_err());
        let out = apply(&mut members, &mut requests, &by("d"), Change::Accept { user_id: "v".into() }, 3).unwrap();
        assert_eq!((out.driver_before.as_deref(), out.driver_after.as_deref()), (Some("d"), Some("v")));
        assert!(out.moved());
        assert_eq!(members["d"].role, Role::Collaborator);
        assert_eq!(members["v"].role, Role::Driver);
        assert!(requests.is_empty());
    }

    #[test]
    fn the_owner_answers_requests_and_takes_control_back() {
        let (mut members, mut requests) = (room(), Vec::new());
        apply(&mut members, &mut requests, &by("c"), Change::Request, 1).unwrap();
        apply(&mut members, &mut requests, &Actor::Owner, Change::Decline { user_id: "c".into() }, 2).unwrap();
        assert!(requests.is_empty());
        assert!(apply(&mut members, &mut requests, &Actor::Owner, Change::Accept { user_id: "c".into() }, 3).is_err(), "nothing to accept");
        let out = apply(&mut members, &mut requests, &Actor::Owner, Change::Take, 4).unwrap();
        assert_eq!(out.driver_after, None);
        assert!(members.values().all(|m| m.role != Role::Driver));
        assert!(apply(&mut members, &mut requests, &by("d"), Change::Take, 5).is_err());
    }

    #[test]
    fn passing_and_releasing_need_the_wheel() {
        let (mut members, mut requests) = (room(), Vec::new());
        assert!(apply(&mut members, &mut requests, &by("c"), Change::Pass { user_id: "v".into() }, 1).is_err());
        assert!(apply(&mut members, &mut requests, &by("d"), Change::Pass { user_id: "d".into() }, 1).is_err());
        assert!(apply(&mut members, &mut requests, &by("d"), Change::Pass { user_id: "stranger".into() }, 1).is_err());
        apply(&mut members, &mut requests, &by("d"), Change::Pass { user_id: "c".into() }, 1).unwrap();
        assert_eq!(driver(&members).as_deref(), Some("c"));
        // A pass racing the first one fails: its sender no longer drives.
        assert!(apply(&mut members, &mut requests, &by("d"), Change::Pass { user_id: "v".into() }, 2).is_err());
        assert!(apply(&mut members, &mut requests, &by("d"), Change::Release, 2).is_err());
        let out = apply(&mut members, &mut requests, &by("c"), Change::Release, 2).unwrap();
        assert_eq!(out.driver_after, None);
        assert_eq!(members["c"].role, Role::Collaborator);
    }

    #[test]
    fn the_driver_and_strangers_cant_ask() {
        let (mut members, mut requests) = (room(), Vec::new());
        assert!(apply(&mut members, &mut requests, &by("d"), Change::Request, 1).is_err());
        assert!(apply(&mut members, &mut requests, &by("nobody"), Change::Request, 1).is_err());
        assert!(apply(&mut members, &mut requests, &Actor::Owner, Change::Request, 1).is_err());
    }

    #[test]
    fn requests_are_capped() {
        let mut members: BTreeMap<String, Member> = (0..MAX_REQUESTS + 1).map(|i| member(&format!("u{i}"), Role::Viewer)).collect();
        let mut requests = Vec::new();
        for i in 0..MAX_REQUESTS {
            apply(&mut members, &mut requests, &by(&format!("u{i}")), Change::Request, 1).unwrap();
        }
        assert!(apply(&mut members, &mut requests, &by(&format!("u{MAX_REQUESTS}")), Change::Request, 1).is_err());
    }

    #[test]
    fn someone_removed_takes_their_request_and_the_wheel_with_them() {
        let (mut members, mut requests) = (room(), Vec::new());
        apply(&mut members, &mut requests, &by("v"), Change::Request, 1).unwrap();
        forget(&mut members, &mut requests, "v");
        assert!(requests.is_empty());
        forget(&mut members, &mut requests, "d");
        assert_eq!(driver(&members), None);
    }

    #[test]
    fn the_away_policy_defaults_to_pausing_and_is_clamped() {
        let p: AwayPolicy = serde_json::from_str("{}").unwrap();
        assert_eq!(p, AwayPolicy { mode: AwayMode::Pause, minutes: 30 });
        assert_eq!(AwayPolicy { mode: AwayMode::KeepGoing, minutes: 0 }.clamped().minutes, 1);
        assert_eq!(AwayPolicy { mode: AwayMode::KeepGoing, minutes: 100_000 }.clamped().minutes, MAX_AWAY_MINUTES);
    }
}
