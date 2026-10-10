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

    /// Nothing is listening at the provider's address, e.g. Ollama isn't running.
    #[error("couldn't reach {0}. Is the server running?")]
    Unreachable(String),
}

impl ProviderError {
    /// Like `From<reqwest::Error>`, but names the server when the connection itself failed.
    pub(crate) fn sending(e: reqwest::Error) -> Self {
        match e.url() {
            Some(url) if e.is_connect() => Self::Unreachable(format!("{}://{}", url.scheme(), url.authority())),
            _ => Self::Network(e),
        }
    }
}

impl From<serde_json::Error> for ProviderError {
    fn from(e: serde_json::Error) -> Self {
        Self::Decode(e.to_string())
    }
}
