//! Smoke-test a provider from the terminal.
//!
//!   cargo run -p sush-core --example chat -- <openai|anthropic> <base_url> <model> "prompt"
//!
//! The API key is read from `SUSH_API_KEY`; leave it unset for local servers.

use std::io::Write;

use futures::StreamExt;
use sush_core::{build_provider, AuthKind, ChatEvent, ChatRequest, Message, ProviderConfig, Role, WireFormat};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [format, base_url, model, prompt] = args.as_slice() else {
        anyhow::bail!("usage: chat <openai|anthropic> <base_url> <model> <prompt>");
    };
    let key = std::env::var("SUSH_API_KEY").ok();
    let cfg = ProviderConfig {
        id: "cli".into(),
        name: "cli".into(),
        format: if format == "anthropic" { WireFormat::AnthropicMessages } else { WireFormat::OpenaiChat },
        base_url: base_url.clone(),
        auth: if key.is_some() { AuthKind::ApiKey { header: None } } else { AuthKind::None },
        headers: Default::default(),
        models: vec![],
    };
    let provider = build_provider(&cfg, key, reqwest::Client::new())?;

    let models = provider.list_models().await?;
    eprintln!("[{} models available]", models.len());

    let req = ChatRequest {
        model: model.clone(),
        messages: vec![Message::text(Role::User, prompt.clone())],
        system: None,
        max_tokens: None,
        temperature: None,
        tools: vec![],
        research: false,
    };
    let mut stream = provider.stream_chat(req).await?;
    while let Some(ev) = stream.next().await {
        match ev? {
            ChatEvent::TextDelta { delta } => print!("{delta}"),
            ChatEvent::ReasoningDelta { delta } => eprint!("\x1b[2m{delta}\x1b[0m"),
            other => eprintln!("\n[{other:?}]"),
        }
        std::io::stdout().flush()?;
    }
    Ok(())
}
