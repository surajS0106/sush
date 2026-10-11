//! Core of Sush: the message model, the streaming event protocol, and the
//! provider implementations. Nothing in here knows about Tauri, so the same
//! crate can later back a CLI/TUI.

pub mod agent;
pub mod error;
pub mod mcp;
pub mod memory;
pub mod message;
pub mod provider;
pub mod providers;
pub mod sse;
pub mod store;
pub mod transcribe;

pub use error::ProviderError;
pub use message::{ChatEvent, ChatRequest, FinishReason, Message, Part, Role, ToolSpec, WebSource};
pub use transcribe::{transcribe, TranscribeApi};
pub use provider::{build_provider, AuthKind, EventStream, ModelInfo, Provider, ProviderConfig, WireFormat};
