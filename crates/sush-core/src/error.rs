use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("{provider} returned HTTP {status}: {message}")]
    Http { provider: &'static str, status: u16, message: String },

    #[error("could not parse provider response: {0}")]
    Decode(String),

    /// The provider reported an error mid-stream (e.g. Anthropic `overloaded_error`).
    #[error("provider error: {0}")]
    Stream(String),

    #[error("invalid configuration: {0}")]
    Config(String),
}

impl From<serde_json::Error> for ProviderError {
    fn from(e: serde_json::Error) -> Self {
        Self::Decode(e.to_string())
    }
}
