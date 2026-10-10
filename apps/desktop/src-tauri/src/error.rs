use serde::{Serialize, Serializer};
use sush_core::ProviderError;

/// Error returned from commands. Serialised as a plain message string so the
/// UI can show it directly.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error(transparent)]
    Provider(#[from] ProviderError),
    #[error("secure storage: {0}")]
    Keyring(#[from] keyring::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Connector(#[from] sush_core::mcp::McpError),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
