//! API keys live in the OS credential store (Windows Credential Manager,
//! macOS Keychain, Secret Service on Linux), never on disk or in the webview.
//!
//! Debug builds are the exception: macOS ties a keychain item's "Always
//! Allow" to the app's code signature, and every `tauri dev` rebuild is
//! signed afresh, so each launch would ask for the login password once per
//! secret. There, secrets go to `dev-secrets.json` (owner-only) in the app
//! config dir instead.
//!
//! Android has no keyring Rust can reach, so secrets are in `secrets.bin`, in
//! the app's private storage, encrypted with AES-256-GCM. That file's key is
//! itself wrapped by a key the Android Keystore holds and never lets out
//! (`Vault.kt`); Kotlin unwraps it as the app starts and hands it over with
//! `unlock` before anything reads a secret.
//!
//! iOS uses its Keychain in every build: each app has its own there, so a
//! rebuild never asks for a password.

use crate::error::AppResult;

#[cfg(any(all(desktop, not(debug_assertions)), target_os = "ios"))]
const SERVICE: &str = "com.sush.app";

/// Called once at startup with the app config dir; debug builds and Android use it.
pub fn init(config_dir: &std::path::Path) {
    #[cfg(all(desktop, debug_assertions))]
    let _ = dev::PATH.set(config_dir.join("dev-secrets.json"));
    #[cfg(any(all(desktop, not(debug_assertions)), target_os = "ios"))]
    let _ = config_dir;
    #[cfg(target_os = "android")]
    vault::init(config_dir);
}

/// The key that encrypts Android's secrets file, from Kotlin (`SushNative.unlock`).
#[cfg(target_os = "android")]
pub fn unlock(key: [u8; 32]) {
    vault::unlock(key);
}

#[cfg(any(all(desktop, not(debug_assertions)), target_os = "ios"))]
mod backend {
    use super::SERVICE;
    use crate::error::AppResult;

    pub fn read(name: &str) -> AppResult<Option<String>> {
        match keyring::Entry::new(SERVICE, name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn write(name: &str, value: &str) -> AppResult<()> {
        Ok(keyring::Entry::new(SERVICE, name)?.set_password(value)?)
    }

    pub fn remove(name: &str) -> AppResult<()> {
        match keyring::Entry::new(SERVICE, name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(all(desktop, debug_assertions))]
mod dev {
    use crate::error::{AppError, AppResult};
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    pub static PATH: OnceLock<PathBuf> = OnceLock::new();
    static LOCK: Mutex<()> = Mutex::new(());

    fn path() -> AppResult<&'static PathBuf> {
        PATH.get().ok_or_else(|| AppError::Invalid("secrets not initialised".into()))
    }

    fn load() -> AppResult<BTreeMap<String, String>> {
        match std::fs::read(path()?) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(e.into()),
        }
    }

    fn save(map: &BTreeMap<String, String>) -> AppResult<()> {
        use std::io::Write;
        let path = path()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(path)?.write_all(&serde_json::to_vec_pretty(map)?)?;
        Ok(())
    }

    pub fn read(name: &str) -> AppResult<Option<String>> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        Ok(load()?.remove(name))
    }

    pub fn write(name: &str, value: &str) -> AppResult<()> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = load()?;
        map.insert(name.to_string(), value.to_string());
        save(&map)
    }

    pub fn remove(name: &str) -> AppResult<()> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = load()?;
        if map.remove(name).is_some() {
            save(&map)?;
        }
        Ok(())
    }
}

#[cfg(all(desktop, debug_assertions))]
use dev as backend;

/// Android: the keys, encrypted (see the module comment).
#[cfg(target_os = "android")]
mod vault {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
    use aes_gcm::{Aes256Gcm, Nonce};

    use crate::error::{AppError, AppResult};

    const NONCE: usize = 12;

    static DIR: OnceLock<PathBuf> = OnceLock::new();
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    static LOCK: Mutex<()> = Mutex::new(());

    pub fn init(dir: &Path) {
        let _ = DIR.set(dir.to_path_buf());
    }

    pub fn unlock(key: [u8; 32]) {
        let _ = KEY.set(key);
    }

    fn path() -> AppResult<PathBuf> {
        let dir = DIR.get().ok_or_else(|| AppError::Invalid("Sush's key storage isn't ready yet. Try again in a moment.".into()))?;
        Ok(dir.join("secrets.bin"))
    }

    fn cipher() -> AppResult<Aes256Gcm> {
        let key = KEY.get().ok_or_else(|| AppError::Invalid("Your API keys are locked. Open Sush, then try again.".into()))?;
        Ok(Aes256Gcm::new(key.into()))
    }

    fn load() -> AppResult<BTreeMap<String, String>> {
        let path = path()?;
        match std::fs::read(&path) {
            Ok(bytes) if bytes.len() > NONCE => {
                let (nonce, sealed) = bytes.split_at(NONCE);
                match cipher()?.decrypt(Nonce::from_slice(nonce), sealed) {
                    Ok(json) => Ok(serde_json::from_slice(&json)?),
                    // The Keystore's key was lost (a restore to another phone, say): the keys are
                    // gone, and saving one starts a new file.
                    Err(_) => {
                        eprintln!("couldn't decrypt the saved API keys; they'll need adding again");
                        Ok(BTreeMap::new())
                    }
                }
            }
            Ok(_) => Ok(BTreeMap::new()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(e.into()),
        }
    }

    fn save(map: &BTreeMap<String, String>) -> AppResult<()> {
        use std::io::Write;
        let path = path()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let sealed = cipher()?
            .encrypt(&nonce, serde_json::to_vec(map)?.as_slice())
            .map_err(|_| AppError::Invalid("Couldn't encrypt the API keys.".into()))?;
        // Written beside it and renamed over it, so a crash mid-write can't leave half a file.
        let tmp = path.with_extension("tmp");
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
        file.write_all(&nonce)?;
        file.write_all(&sealed)?;
        file.sync_all()?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn read(name: &str) -> AppResult<Option<String>> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        Ok(load()?.remove(name))
    }

    pub fn write(name: &str, value: &str) -> AppResult<()> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = load()?;
        map.insert(name.to_string(), value.to_string());
        save(&map)
    }

    pub fn remove(name: &str) -> AppResult<()> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = load()?;
        if map.remove(name).is_some() {
            save(&map)?;
        }
        Ok(())
    }
}

#[cfg(target_os = "android")]
use vault as backend;

use backend::{read, remove, write};

fn provider_name(provider_id: &str) -> String {
    format!("provider:{provider_id}")
}

pub fn get(provider_id: &str) -> AppResult<Option<String>> {
    read(&provider_name(provider_id))
}

pub fn set(provider_id: &str, key: &str) -> AppResult<()> {
    write(&provider_name(provider_id), key)
}

pub fn delete(provider_id: &str) -> AppResult<()> {
    remove(&provider_name(provider_id))
}

/// The relay that shared sessions go through, and the session token for it (`share.rs`), as JSON.
const SHARE_ACCOUNT: &str = "share:account";

pub fn share_account_get() -> AppResult<Option<String>> {
    read(SHARE_ACCOUNT)
}

pub fn share_account_set(value: &str) -> AppResult<()> {
    write(SHARE_ACCOUNT, value)
}

pub fn share_account_delete() -> AppResult<()> {
    remove(SHARE_ACCOUNT)
}

/// The invite link a joined share came from (its token and key are after the `#`),
/// so the share can be joined again from the history without pasting it (`share.rs`).
fn share_link_name(share_id: &str) -> String {
    format!("share:link:{share_id}")
}

pub fn share_link_get(share_id: &str) -> AppResult<Option<String>> {
    read(&share_link_name(share_id))
}

pub fn share_link_set(share_id: &str, link: &str) -> AppResult<()> {
    write(&share_link_name(share_id), link)
}

pub fn share_link_delete(share_id: &str) -> AppResult<()> {
    remove(&share_link_name(share_id))
}

/// The user's own Google Maps Platform key (`maps.rs`).
const MAPS_KEY: &str = "maps:key";

pub fn maps_key_get() -> AppResult<Option<String>> {
    read(MAPS_KEY)
}

pub fn maps_key_set(value: &str) -> AppResult<()> {
    write(MAPS_KEY, value)
}

pub fn maps_key_delete() -> AppResult<()> {
    remove(MAPS_KEY)
}

/// The user's own Ignav key (`flights.rs`).
const FLIGHTS_KEY: &str = "flights:key";

pub fn flights_key_get() -> AppResult<Option<String>> {
    read(FLIGHTS_KEY)
}

pub fn flights_key_set(value: &str) -> AppResult<()> {
    write(FLIGHTS_KEY, value)
}

pub fn flights_key_delete() -> AppResult<()> {
    remove(FLIGHTS_KEY)
}

/// The user's own Ollama key for web search (`web.rs`).
const WEB_KEY: &str = "web:key";

pub fn web_key_get() -> AppResult<Option<String>> {
    read(WEB_KEY)
}

pub fn web_key_set(value: &str) -> AppResult<()> {
    write(WEB_KEY, value)
}

pub fn web_key_delete() -> AppResult<()> {
    remove(WEB_KEY)
}

// Connector credentials can outgrow one Windows credential (2560 bytes,
// stored as UTF-16), so they're split into parts; the first entry holds the
// part count.

const PART_CHARS: usize = 1000;

fn connector_name(id: &str, part: Option<usize>) -> String {
    match part {
        Some(n) => format!("connector:{id}:{n}"),
        None => format!("connector:{id}"),
    }
}

fn connector_parts(id: &str) -> AppResult<Option<usize>> {
    Ok(read(&connector_name(id, None))?.map(|n| n.parse::<usize>().unwrap_or(0)))
}

pub fn connector_get(id: &str) -> AppResult<Option<String>> {
    let Some(count) = connector_parts(id)? else { return Ok(None) };
    let mut value = String::new();
    for n in 0..count {
        let name = connector_name(id, Some(n));
        let part = read(&name)?.ok_or_else(|| crate::error::AppError::NotFound(format!("missing secret {name}")))?;
        value.push_str(&part);
    }
    Ok(Some(value))
}

pub fn connector_set(id: &str, value: &str) -> AppResult<()> {
    connector_delete(id)?;
    let chars: Vec<char> = value.chars().collect();
    let parts: Vec<String> = chars.chunks(PART_CHARS).map(|c| c.iter().collect()).collect();
    for (n, part) in parts.iter().enumerate() {
        write(&connector_name(id, Some(n)), part)?;
    }
    write(&connector_name(id, None), &parts.len().to_string())
}

pub fn connector_delete(id: &str) -> AppResult<()> {
    let Some(count) = connector_parts(id)? else { return Ok(()) };
    for n in 0..count {
        remove(&connector_name(id, Some(n)))?;
    }
    remove(&connector_name(id, None))
}

/// The user's own keys for voice mode's providers (`voice.rs`): `openai`, `xai`, `sarvam`, `elevenlabs`.
fn voice_key_name(provider: &str) -> String {
    format!("voice:{provider}")
}

pub fn voice_key_get(provider: &str) -> AppResult<Option<String>> {
    read(&voice_key_name(provider))
}

pub fn voice_key_set(provider: &str, value: &str) -> AppResult<()> {
    write(&voice_key_name(provider), value)
}

pub fn voice_key_delete(provider: &str) -> AppResult<()> {
    remove(&voice_key_name(provider))
}
