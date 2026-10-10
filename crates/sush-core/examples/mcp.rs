//! Smoke-test a local MCP server from the terminal: list its tools, optionally call one.
//!
//!   cargo run -p sush-core --example mcp -- <command> [args...]
//!   SUSH_CALL='add {"a":2,"b":3}' cargo run -p sush-core --example mcp -- node server.js

use sush_core::mcp::{McpClient, ServerCommand};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().ok_or_else(|| anyhow::anyhow!("usage: mcp <command> [args...]"))?;
    let cmd = ServerCommand { command, args: args.collect(), env: Default::default() };

    let client = McpClient::spawn(&cmd).await?;
    println!("connected to {}", client.server_name.as_deref().unwrap_or("(unnamed server)"));
    for tool in &client.tools {
        println!("  {} - {}", tool.name, tool.description.as_deref().unwrap_or(""));
    }

    if let Ok(call) = std::env::var("SUSH_CALL") {
        let (name, input) = call.split_once(' ').unwrap_or((&call, "{}"));
        let out = client.call_tool(name, serde_json::from_str(input)?).await?;
        println!("{name} -> {}{}", out.text, if out.is_error { " (error)" } else { "" });
    }
    Ok(())
}
