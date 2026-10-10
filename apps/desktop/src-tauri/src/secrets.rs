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
    delete_entry(entry(provider_id)?)
}

fn delete_entry(entry: keyring::Entry) -> AppResult<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// Connector credentials can outgrow one Windows credential (2560 bytes,
// stored as UTF-16), so they're split into parts; the first entry holds the
// part count.

const PART_CHARS: usize = 1000;

fn connector_entry(id: &str, part: Option<usize>) -> AppResult<keyring::Entry> {
    let name = match part {
        Some(n) => format!("connector:{id}:{n}"),
        None => format!("connector:{id}"),
    };
    Ok(keyring::Entry::new(SERVICE, &name)?)
}

pub fn connector_get(id: &str) -> AppResult<Option<String>> {
    let count = match connector_entry(id, None)?.get_password() {
        Ok(n) => n.parse::<usize>().unwrap_or(0),
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut value = String::new();
    for n in 0..count {
        value.push_str(&connector_entry(id, Some(n))?.get_password()?);
    }
    Ok(Some(value))
}

pub fn connector_set(id: &str, value: &str) -> AppResult<()> {
    connector_delete(id)?;
    let chars: Vec<char> = value.chars().collect();
    let parts: Vec<String> = chars.chunks(PART_CHARS).map(|c| c.iter().collect()).collect();
    for (n, part) in parts.iter().enumerate() {
        connector_entry(id, Some(n))?.set_password(part)?;
    }
    Ok(connector_entry(id, None)?.set_password(&parts.len().to_string())?)
}

pub fn connector_delete(id: &str) -> AppResult<()> {
    let count = match connector_entry(id, None)?.get_password() {
        Ok(n) => n.parse::<usize>().unwrap_or(0),
        Err(keyring::Error::NoEntry) => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for n in 0..count {
        delete_entry(connector_entry(id, Some(n))?)?;
    }
    delete_entry(connector_entry(id, None)?)
}
