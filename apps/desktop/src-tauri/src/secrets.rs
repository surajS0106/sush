//! API keys live in the OS credential store (Windows Credential Manager,
//! macOS Keychain, Secret Service on Linux), never on disk or in the webview.
//!
//! Debug builds are the exception: macOS ties a keychain item's "Always
//! Allow" to the app's code signature, and every `tauri dev` rebuild is
//! signed afresh, so each launch would ask for the login password once per
//! secret. There, secrets go to `dev-secrets.json` (owner-only) in the app
//! config dir instead.

use crate::error::AppResult;

#[cfg(not(debug_assertions))]
const SERVICE: &str = "com.sush.app";

/// Called once at startup with the app config dir; only debug builds use it.
pub fn init(config_dir: &std::path::Path) {
    #[cfg(debug_assertions)]
    let _ = dev::PATH.set(config_dir.join("dev-secrets.json"));
    #[cfg(not(debug_assertions))]
    let _ = config_dir;
}

#[cfg(not(debug_assertions))]
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

#[cfg(debug_assertions)]
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

#[cfg(debug_assertions)]
use dev as backend;

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
