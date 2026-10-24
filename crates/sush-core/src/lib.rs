//! Core of Sush: the message model, the streaming event protocol, and the
//! provider implementations. Nothing in here knows about Tauri, so the same
//! crate can later back a CLI/TUI.

pub mod agent;
pub mod browser;
pub mod clis;
pub mod error;
pub mod imagegen;
pub mod mcp;
pub mod memory;
pub mod message;
pub mod provider;
pub mod providers;
pub mod reports;
pub mod share;
pub mod sse;
pub mod store;
pub mod transcribe;
pub mod workspace;

pub use error::ProviderError;
pub use message::{ChatEvent, ChatRequest, FinishReason, Message, Part, Role, ToolSpec, WebSource};
pub use imagegen::{generate_image, Aspect, GeneratedImage, ImageApi};
pub use transcribe::{transcribe, TranscribeApi};
pub use provider::{build_provider, AuthKind, EventStream, ModelInfo, Provider, ProviderConfig, WireFormat};
