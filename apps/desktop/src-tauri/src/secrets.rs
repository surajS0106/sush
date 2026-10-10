//! API keys live in the OS credential store (Windows Credential Manager,
//! macOS Keychain, Secret Service on Linux), never on disk or in the webview.

use crate::error::AppResult;

const SERVICE: &str = "com.sush.app";

fn entry(provider_id: &str) -> AppResult<keyring::Entry> {
    Ok(keyring::Entry::new(SERVICE, &format!("provider:{provider_id}"))?)
}

pub fn get(provider_id: &str) -> AppResult<Option<String>> {
    match entry(provider_id)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set(provider_id: &str, key: &str) -> AppResult<()> {
    Ok(entry(provider_id)?.set_password(key)?)
}

pub fn delete(provider_id: &str) -> AppResult<()> {
    match entry(provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
