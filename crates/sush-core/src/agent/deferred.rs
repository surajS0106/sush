//! Tools loaded on demand. Every tool's definition is sent with every model step, so a
//! request carries thousands of tokens of tools a plain question never needs (slides,
//! flights, each connector's dozens). A tool marked `deferred` is left out until the model
//! asks for it with `tools_load`: the system prompt lists the deferred tools by name and
//! a line each, and from the step after a `tools_load` call they're offered like the rest.
//!
//! What's loaded is read from the thread itself (earlier `tools_load` calls), so it holds
//! for the rest of the conversation, across runs, resumes and restarts, with no state of
//! its own. Loading changes the tool list once per tool, and the cached prompt prefix
//! with it; the list stays put after that, so caching keeps working.

use std::collections::HashSet;

use serde_json::{json, Value};

use super::run::RunTool;
use super::ui;
use crate::ToolSpec;

pub const TOOLS_LOAD: &str = "tools_load";

/// Separates a connector's id from its tool's name (`swiggy__search`).
const CONNECTOR_SEP: &str = "__";

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: TOOLS_LOAD.into(),
        description: "Load tools listed under \"Tools you can load\" so you can call them from your next step. Pass tool \
            names, or a connector's name for all of its tools. Load what the task needs, all at once, before using it."
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "names": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
            },
            "required": ["names"]
        }),
    }
}

/// The connector a tool belongs to, if it's a connector tool.
fn connector(name: &str) -> Option<&str> {
    name.split_once(CONNECTOR_SEP).map(|(c, _)| c)
}

/// The first sentence of a description, for the list.
fn summary(description: &str) -> &str {
    let d = description.trim();
    let end = d.find(". ").map_or(d.len(), |i| i + 1);
    &d[..end]
}

/// Lists the deferred tools for the system prompt, or None when there are none. Built from
/// the config alone, never from what's loaded, so it stays the same and caches.
pub fn system_section(tools: &[RunTool]) -> Option<String> {
    let deferred: Vec<&RunTool> = tools.iter().filter(|t| t.deferred).collect();
    if deferred.is_empty() {
        return None;
    }
    let mut lines = vec![
        "## Tools you can load\n\nThese tools aren't loaded yet. When a request needs one, call tools_load with its name \
         (or a connector's name for all its tools) first, then use it. Don't mention loading to the user."
            .to_string(),
    ];
    let mut connectors: Vec<(&str, Vec<&str>, &str)> = Vec::new();
    for t in &deferred {
        let name = t.spec.name.as_str();
        match connector(name) {
            Some(c) => match connectors.iter_mut().find(|(id, ..)| *id == c) {
                Some((_, names, _)) => names.push(&name[c.len() + CONNECTOR_SEP.len()..]),
                // Connector tools' descriptions open with "[Connector name]".
                None => connectors.push((c, vec![&name[c.len() + CONNECTOR_SEP.len()..]], label(&t.spec.description))),
            },
            None => lines.push(format!("- {name}: {}", summary(&t.spec.description))),
        }
    }
    for (id, names, label) in connectors {
        let label = if label.is_empty() { String::new() } else { format!(" ({label})") };
        lines.push(format!("- connector {id}{label}: {}", names.join(", ")));
    }
    Some(lines.join("\n"))
}

/// "Swiggy Food" from "[Swiggy Food] Search restaurants…".
fn label(description: &str) -> &str {
    description.strip_prefix('[').and_then(|d| d.split_once(']')).map_or("", |(l, _)| l)
}

/// Names loaded by earlier `tools_load` calls in the thread that succeeded.
pub fn loaded(messages: &[Value]) -> HashSet<String> {
    let mut names = HashSet::new();
    for m in messages {
        for p in ui::parts(m) {
            if p.get("toolName").and_then(Value::as_str) != Some(TOOLS_LOAD)
                || p.get("state").and_then(Value::as_str) != Some("output-available")
            {
                continue;
            }
            for n in p["input"]["names"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                names.insert(n.to_string());
            }
        }
    }
    names
}

/// The tools a step offers: everything not deferred, the deferred ones loaded so far, and
/// `tools_load` while any are deferred. In the config's order, so the list only grows.
pub fn offered(tools: &[RunTool], messages: &[Value]) -> Vec<ToolSpec> {
    let loaded = loaded(messages);
    let is_loaded = |name: &str| loaded.contains(name) || connector(name).is_some_and(|c| loaded.contains(c));
    let mut specs: Vec<ToolSpec> =
        tools.iter().filter(|t| !t.deferred || is_loaded(&t.spec.name)).map(|t| t.spec.clone()).collect();
    if tools.iter().any(|t| t.deferred) {
        specs.push(spec());
    }
    specs
}

/// Runs a `tools_load` call: which of the names are deferred tools or connectors.
pub fn load(tools: &[RunTool], input: &Value) -> Result<Value, String> {
    let names: Vec<&str> = input["names"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if names.is_empty() {
        return Err("Pass `names`: the tools (or connectors) to load.".into());
    }
    let deferred = || tools.iter().filter(|t| t.deferred).map(|t| t.spec.name.as_str());
    let (known, unknown): (Vec<&str>, Vec<&str>) =
        names.iter().copied().partition(|n| deferred().any(|t| t == *n || connector(t) == Some(*n)));
    if known.is_empty() {
        return Err(format!("None of these can be loaded: {}. Use names from \"Tools you can load\".", unknown.join(", ")));
    }
    let mut text = format!("Loaded {}. Call them from your next step.", known.join(", "));
    if !unknown.is_empty() {
        text.push_str(&format!(" Not found: {}.", unknown.join(", ")));
    }
    Ok(json!(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::run::{Approval, ToolExec};

    fn tool(name: &str, description: &str, deferred: bool) -> RunTool {
        RunTool {
            spec: ToolSpec { name: name.into(), description: description.into(), input_schema: json!({"type": "object"}) },
            exec: ToolExec::Client,
            approval: Approval::Auto,
            deferred,
        }
    }

    fn tools() -> Vec<RunTool> {
        vec![
            tool("ask_user", "Ask.", false),
            tool("slides_write", "Show a slide deck. Long details.", true),
            tool("swiggy__search", "[Swiggy Food] Search.", true),
            tool("swiggy__cart", "[Swiggy Food] Cart.", true),
        ]
    }

    fn load_call(names: &[&str], state: &str) -> Value {
        json!({ "role": "assistant", "parts": [{ "type": "dynamic-tool", "toolName": TOOLS_LOAD, "toolCallId": "l", "state": state, "input": { "names": names } }] })
    }

    fn names(specs: &[ToolSpec]) -> Vec<&str> {
        specs.iter().map(|s| s.name.as_str()).collect()
    }

    #[test]
    fn deferred_tools_wait_for_a_load() {
        assert_eq!(names(&offered(&tools(), &[])), ["ask_user", TOOLS_LOAD]);
        let thread = [load_call(&["slides_write"], "output-available")];
        assert_eq!(names(&offered(&tools(), &thread)), ["ask_user", "slides_write", TOOLS_LOAD]);
        let thread = [load_call(&["swiggy"], "output-available")];
        assert_eq!(names(&offered(&tools(), &thread)), ["ask_user", "swiggy__search", "swiggy__cart", TOOLS_LOAD]);
        // A failed or unanswered load loads nothing.
        assert_eq!(names(&offered(&tools(), &[load_call(&["slides_write"], "output-error")])), ["ask_user", TOOLS_LOAD]);
    }

    #[test]
    fn nothing_deferred_adds_nothing() {
        let all = vec![tool("ask_user", "Ask.", false)];
        assert_eq!(names(&offered(&all, &[])), ["ask_user"]);
        assert_eq!(system_section(&all), None);
    }

    #[test]
    fn the_list_groups_connectors() {
        let section = system_section(&tools()).unwrap();
        assert!(section.contains("- slides_write: Show a slide deck."));
        assert!(!section.contains("Long details"));
        assert!(section.contains("- connector swiggy (Swiggy Food): search, cart"));
    }

    #[test]
    fn loading_checks_the_names() {
        assert!(load(&tools(), &json!({ "names": ["slides_write", "nope"] })).unwrap().as_str().unwrap().contains("Not found: nope"));
        assert!(load(&tools(), &json!({ "names": ["ask_user"] })).is_err());
        assert!(load(&tools(), &json!({})).is_err());
    }
}
