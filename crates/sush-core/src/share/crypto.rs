//! End-to-end encryption for shared sessions: the relay forwards ciphertext.
//!
//! The host makes a 256-bit content key per share and puts it in the invite
//! link's fragment (`#t=<token>&k=<key>`), which browsers and the relay never
//! see in a request. Every body is sealed with XChaCha20-Poly1305 under that
//! key ([`seal`]), bound to the share, the key's generation and the direction
//! (associated data), so a frame can't be replayed into another share or sent
//! back the other way. The ordered stream's own `epoch`/`seq` (inside the
//! ciphertext) already makes a guest refuse a replayed or reordered message;
//! the host refuses a guest nonce it has seen ([`Seen`]).
//!
//! Each guest also makes a device identity per join ([`Device`]): an Ed25519
//! key that signs everything it sends, and an X25519 key for rekeying. Its
//! first `hello` carries both; the host binds them to the guest's user id and
//! checks every later message's signature, so neither the relay nor another
//! member can speak for someone else. When someone is removed, the host makes
//! a new key and seals it for each remaining member's X25519 key
//! ([`seal_for`]), so the one removed can't read what follows even if a
//! compromised relay kept forwarding to them.
//!
//! The browser viewer (`apps/viewer`) implements the same formats with the
//! `@noble` libraries; keep the two in step.

use std::collections::{HashSet, VecDeque};

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

/// What a sealed body starts with; anything else is a plain (unencrypted) body.
pub const PREFIX: &str = "e2e1.";
/// Guest nonces the host remembers, per share, to refuse replays.
const SEEN: usize = 4096;

/// A content key, with its generation (the first is 1; each rekey adds one).
#[derive(Clone, PartialEq, Eq)]
pub struct ShareKey {
    pub generation: u32,
    pub key: [u8; 32],
}

impl std::fmt::Debug for ShareKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ShareKey(gen {})", self.generation)
    }
}

impl ShareKey {
    pub fn generate(generation: u32) -> Self {
        Self { generation, key: random() }
    }

    /// The key as the link carries it: base64url, no padding.
    pub fn to_text(&self) -> String {
        B64.encode(self.key)
    }

    pub fn from_text(text: &str, generation: u32) -> Result<Self, String> {
        Ok(Self { generation, key: bytes32(text).map_err(|_| "This link's key is damaged. Ask for a new link.".to_string())? })
    }
}

/// Which way a body goes; part of what it's bound to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    ToGuests,
    ToHost,
}

impl Direction {
    fn tag(self) -> &'static str {
        match self {
            Direction::ToGuests => "h2g",
            Direction::ToHost => "g2h",
        }
    }
}

fn random<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("the OS has randomness");
    buf
}

fn bytes32(text: &str) -> Result<[u8; 32], String> {
    B64.decode(text).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()).ok_or_else(|| "bad key".to_string())
}

fn aad(share_id: &str, generation: u32, dir: Direction) -> String {
    format!("sush-share|{share_id}|{generation}|{}", dir.tag())
}

/// Whether a body is sealed.
pub fn is_sealed(body: &str) -> bool {
    body.starts_with(PREFIX)
}

/// Seal a body: `e2e1.<generation>.<nonce>.<ciphertext>`.
pub fn seal(key: &ShareKey, share_id: &str, dir: Direction, plain: &str) -> String {
    seal_with_nonce(key, share_id, dir, plain, random())
}

fn seal_with_nonce(key: &ShareKey, share_id: &str, dir: Direction, plain: &str, nonce: [u8; 24]) -> String {
    let cipher = XChaCha20Poly1305::new((&key.key).into());
    let aad = aad(share_id, key.generation, dir);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plain.as_bytes(), aad: aad.as_bytes() })
        .expect("sealing a body can't fail");
    format!("{PREFIX}{}.{}.{}", key.generation, B64.encode(nonce), B64.encode(ct))
}

/// A sealed body's generation and nonce, without opening it.
pub fn header(body: &str) -> Option<(u32, String)> {
    let mut parts = body.strip_prefix(PREFIX)?.splitn(3, '.');
    let generation = parts.next()?.parse().ok()?;
    let nonce = parts.next()?.to_string();
    Some((generation, nonce))
}

/// Open a sealed body with whichever key its generation names (`key_for`).
pub fn open(key_for: impl Fn(u32) -> Option<[u8; 32]>, share_id: &str, dir: Direction, body: &str) -> Result<String, String> {
    let bad = || "A message couldn't be decrypted.".to_string();
    let rest = body.strip_prefix(PREFIX).ok_or_else(bad)?;
    let mut parts = rest.splitn(3, '.');
    let generation: u32 = parts.next().and_then(|g| g.parse().ok()).ok_or_else(bad)?;
    let nonce = parts.next().and_then(|n| B64.decode(n).ok()).filter(|n| n.len() == 24).ok_or_else(bad)?;
    let ct = parts.next().and_then(|c| B64.decode(c).ok()).ok_or_else(bad)?;
    let key = key_for(generation).ok_or_else(|| format!("No key for generation {generation}."))?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let aad = aad(share_id, generation, dir);
    let plain = cipher.decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: aad.as_bytes() }).map_err(|_| bad())?;
    String::from_utf8(plain).map_err(|_| bad())
}

/// A guest's keys for one join: never stored, never leave the guest's app.
pub struct Device {
    sign: SigningKey,
    kx: StaticSecret,
}

/// What a guest's `hello` says about its device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKeys {
    /// Ed25519, base64url.
    pub sign_pub: String,
    /// X25519, base64url.
    pub kx_pub: String,
}

/// A guest's message with its signature, inside the sealed body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signed {
    /// The message, as JSON text.
    pub m: String,
    /// Ed25519 signature of `m`'s bytes, base64url.
    pub s: String,
}

impl Device {
    pub fn generate() -> Self {
        Self { sign: SigningKey::from_bytes(&random()), kx: StaticSecret::from(random::<32>()) }
    }

    pub fn keys(&self) -> DeviceKeys {
        DeviceKeys { sign_pub: B64.encode(self.sign.verifying_key().to_bytes()), kx_pub: B64.encode(PublicKey::from(&self.kx).to_bytes()) }
    }

    /// `{ m, s }` as JSON text, for sealing.
    pub fn sign(&self, message: &str) -> String {
        let s = B64.encode(self.sign.sign(message.as_bytes()).to_bytes());
        serde_json::to_string(&Signed { m: message.to_string(), s }).expect("serializes")
    }

    /// A content key the host sealed for this device ([`seal_for`]).
    pub fn open_sealed(&self, share_id: &str, generation: u32, sealed: &str) -> Result<ShareKey, String> {
        let bad = || "The new session key couldn't be opened.".to_string();
        let mut parts = sealed.splitn(3, '.');
        let eph = parts.next().and_then(|p| bytes32(p).ok()).ok_or_else(bad)?;
        let nonce = parts.next().and_then(|n| B64.decode(n).ok()).filter(|n| n.len() == 24).ok_or_else(bad)?;
        let ct = parts.next().and_then(|c| B64.decode(c).ok()).ok_or_else(bad)?;
        let shared = self.kx.diffie_hellman(&PublicKey::from(eph));
        let info = rekey_info(share_id, generation);
        let wrap = derive(shared.as_bytes(), &info);
        let cipher = XChaCha20Poly1305::new((&wrap).into());
        let key = cipher.decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: info.as_bytes() }).map_err(|_| bad())?;
        Ok(ShareKey { generation, key: key.try_into().map_err(|_| bad())? })
    }
}

/// Check a guest's signed message against the key bound to them; returns the message.
pub fn verify(sign_pub: &str, signed: &str) -> Result<String, String> {
    let bad = || "A message's signature didn't check out.".to_string();
    let signed: Signed = serde_json::from_str(signed).map_err(|_| bad())?;
    let key = VerifyingKey::from_bytes(&bytes32(sign_pub).map_err(|_| bad())?).map_err(|_| bad())?;
    let sig: [u8; 64] = B64.decode(&signed.s).ok().and_then(|s| s.try_into().ok()).ok_or_else(bad)?;
    key.verify(signed.m.as_bytes(), &Signature::from_bytes(&sig)).map_err(|_| bad())?;
    Ok(signed.m)
}

/// A signed message's text and signature, before its key is known (the first `hello` carries the key).
pub fn unsigned_text(signed: &str) -> Option<String> {
    serde_json::from_str::<Signed>(signed).ok().map(|s| s.m)
}

fn rekey_info(share_id: &str, generation: u32) -> String {
    format!("sush-share-rekey|{share_id}|{generation}")
}

fn derive(shared: &[u8], info: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared).expand(info.as_bytes(), &mut out).expect("32 bytes is a valid length");
    out
}

/// Seal a content key for one member's X25519 key: `<ephemeral public>.<nonce>.<ciphertext>`.
pub fn seal_for(kx_pub: &str, share_id: &str, key: &ShareKey) -> Result<String, String> {
    let peer = PublicKey::from(bytes32(kx_pub).map_err(|_| "A member's device key is damaged.".to_string())?);
    let eph = StaticSecret::from(random::<32>());
    let shared = eph.diffie_hellman(&peer);
    let info = rekey_info(share_id, key.generation);
    let wrap = derive(shared.as_bytes(), &info);
    let nonce: [u8; 24] = random();
    let cipher = XChaCha20Poly1305::new((&wrap).into());
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: &key.key, aad: info.as_bytes() })
        .expect("sealing a key can't fail");
    Ok(format!("{}.{}.{}", B64.encode(PublicKey::from(&eph).to_bytes()), B64.encode(nonce), B64.encode(ct)))
}

/// Guest nonces the host has seen, to refuse a replayed message.
#[derive(Default)]
pub struct Seen {
    order: VecDeque<String>,
    set: HashSet<String>,
}

impl Seen {
    /// False if this nonce came before.
    pub fn first(&mut self, nonce: &str) -> bool {
        if !self.set.insert(nonce.to_string()) {
            return false;
        }
        self.order.push_back(nonce.to_string());
        if self.order.len() > SEEN {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

/// An invite link's fragment: `t=<token>&k=<key>` (or, from before encryption, just the token).
pub fn parse_fragment(fragment: &str) -> (String, Option<String>) {
    if !fragment.contains('=') {
        return (fragment.to_string(), None);
    }
    let mut token = String::new();
    let mut key = None;
    for pair in fragment.split('&') {
        match pair.split_once('=') {
            Some(("t", v)) => token = v.to_string(),
            Some(("k", v)) if !v.is_empty() => key = Some(v.to_string()),
            _ => {}
        }
    }
    (token, key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sealed_body_opens_only_where_it_belongs() {
        let key = ShareKey::generate(1);
        let body = seal(&key, "s1", Direction::ToGuests, r#"{"v":1,"type":"op"}"#);
        assert!(is_sealed(&body));
        assert!(!body.contains("op"), "the relay can't read it");
        let keys = |g: u32| (g == 1).then_some(key.key);
        assert_eq!(open(keys, "s1", Direction::ToGuests, &body).unwrap(), r#"{"v":1,"type":"op"}"#);
        // Another share, the other direction, or a changed byte: refused.
        assert!(open(keys, "s2", Direction::ToGuests, &body).is_err());
        assert!(open(keys, "s1", Direction::ToHost, &body).is_err());
        let mut tampered = body.clone();
        tampered.pop();
        tampered.push(if body.ends_with('A') { 'B' } else { 'A' });
        assert!(open(keys, "s1", Direction::ToGuests, &tampered).is_err());
        // Without the key, nothing.
        assert!(open(|_| None, "s1", Direction::ToGuests, &body).is_err());
        assert!(open(|_| Some(ShareKey::generate(1).key), "s1", Direction::ToGuests, &body).is_err());
    }

    #[test]
    fn the_same_text_seals_differently_each_time() {
        let key = ShareKey::generate(1);
        assert_ne!(seal(&key, "s", Direction::ToHost, "x"), seal(&key, "s", Direction::ToHost, "x"));
        let (generation, nonce) = header(&seal(&key, "s", Direction::ToHost, "x")).unwrap();
        assert_eq!(generation, 1);
        assert_eq!(B64.decode(nonce).unwrap().len(), 24);
    }

    #[test]
    fn keys_round_trip_through_the_link() {
        let key = ShareKey::generate(1);
        assert_eq!(ShareKey::from_text(&key.to_text(), 1).unwrap(), key);
        assert!(ShareKey::from_text("short", 1).is_err());
        assert_eq!(parse_fragment("t=abc&k=xyz"), ("abc".to_string(), Some("xyz".to_string())));
        assert_eq!(parse_fragment("abc"), ("abc".to_string(), None));
        assert_eq!(parse_fragment("k=&t=abc"), ("abc".to_string(), None));
    }

    #[test]
    fn a_signature_binds_a_message_to_its_device() {
        let device = Device::generate();
        let keys = device.keys();
        let signed = device.sign(r#"{"type":"intent"}"#);
        assert_eq!(verify(&keys.sign_pub, &signed).unwrap(), r#"{"type":"intent"}"#);
        assert_eq!(unsigned_text(&signed).unwrap(), r#"{"type":"intent"}"#);
        // Someone else's key, or a changed message, fails.
        assert!(verify(&Device::generate().keys().sign_pub, &signed).is_err());
        let mut forged: Signed = serde_json::from_str(&signed).unwrap();
        forged.m = r#"{"type":"stop"}"#.into();
        assert!(verify(&keys.sign_pub, &serde_json::to_string(&forged).unwrap()).is_err());
    }

    #[test]
    fn a_new_key_opens_only_for_the_member_it_was_sealed_for() {
        let (alice, bob) = (Device::generate(), Device::generate());
        let next = ShareKey::generate(2);
        let sealed = seal_for(&alice.keys().kx_pub, "s1", &next).unwrap();
        assert_eq!(alice.open_sealed("s1", 2, &sealed).unwrap(), next);
        assert!(bob.open_sealed("s1", 2, &sealed).is_err());
        assert!(alice.open_sealed("s1", 3, &sealed).is_err(), "bound to its generation");
        assert!(alice.open_sealed("other", 2, &sealed).is_err(), "and its share");
    }

    #[test]
    fn replayed_nonces_are_refused() {
        let mut seen = Seen::default();
        assert!(seen.first("n1"));
        assert!(!seen.first("n1"));
        for i in 0..SEEN + 1 {
            seen.first(&format!("x{i}"));
        }
        assert!(seen.set.len() <= SEEN);
    }

    #[test]
    fn a_fixed_nonce_gives_a_stable_body() {
        // The browser viewer must produce and open exactly this format.
        let key = ShareKey { generation: 1, key: [7u8; 32] };
        let body = seal_with_nonce(&key, "s", Direction::ToHost, "hi", [1u8; 24]);
        assert!(body.starts_with("e2e1.1.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB."));
        assert_eq!(open(|_| Some([7u8; 32]), "s", Direction::ToHost, &body).unwrap(), "hi");
    }
}
