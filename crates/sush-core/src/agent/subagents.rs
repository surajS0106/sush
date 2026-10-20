//! Sub-agents: a run hands a self-contained task to a fresh run of its own,
//! on a thread of its own, and gets that run's final message back as the
//! tool's result. Several `spawn_agent` calls in one step run side by side,
//! like any tool calls do (`run::Runner::resolve`).
//!
//! The host starts the child run (`ToolExec::Agent`) and waits for it. A
//! child's thread names its parent (`ThreadMeta::parent_id`); it gets the
//! parent's tools and folder, these instructions, and no `spawn_agent`, so
//! sub-agents don't nest.
//!
//! A sub-agent can also work in the background: started that way
//! (`background`), or moved there when the user writes while it works
//! (`run::RunHost::detach`). Its call then gets [`background_result`] at
//! once, and its report reaches the parent later as a message of its own
//! ([`report_message`]), joining the parent's run or starting one.

use serde_json::{json, Value};

use super::ui::{self, role};
use crate::message::ToolSpec;

pub const SPAWN_AGENT: &str = "spawn_agent";

/// The result when a sub-agent ended without saying anything.
pub const NO_REPORT: &str = "The sub-agent finished without a final message.";

/// What a background sub-agent's call result starts with (the UI looks for it).
pub const BACKGROUND: &str = "Working in the background";

/// Metadata key on the message that brings a background sub-agent's report.
pub const REPORT: &str = "subagentReport";

pub fn is_agent_tool(name: &str) -> bool {
    name == SPAWN_AGENT
}

/// The id of the thread a `spawn_agent` call runs on. The UI derives the same
/// to show the sub-agent's progress under the call.
pub fn child_thread_id(parent_thread_id: &str, call_id: &str) -> String {
    format!("{parent_thread_id}:{call_id}")
}

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: SPAWN_AGENT.into(),
        description: "Start a sub-agent: a fresh copy of you with your tools (and this session's folder, if any) but none \
            of this conversation, which works on one task on its own and returns its final report as this call's result. \
            To run several sub-agents at the same time, call spawn_agent several times in one reply; they work in \
            parallel and you continue once all have reported. Use them for independent, self-contained parts of a larger \
            task (research separate questions, explore or review different parts of a codebase, try alternatives), not \
            for quick steps you can do yourself. Sub-agents can't see this conversation, ask you anything, or start \
            sub-agents of their own, so the prompt must hold everything the task needs: the goal, relevant context and \
            paths, constraints, and what the report should contain. Don't give two sub-agents edits to the same files. \
            The user sees each sub-agent's work, but not its report; summarise what matters in your reply. \
            With background: true the call returns at once and the sub-agent works while you carry on (with other \
            work, or by ending your reply); its report arrives later in a message of its own. If the user writes while \
            sub-agents work, they move to the background the same way. You can start more sub-agents at any time."
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "A short label for the task, 3 to 6 words, shown to the user, e.g. \"Audit the auth module\""
                },
                "prompt": {
                    "type": "string",
                    "description": "The complete task for the sub-agent, with all the context it needs"
                },
                "background": {
                    "type": "boolean",
                    "description": "Return at once instead of waiting for the report, which arrives later in a message. Default false."
                }
            },
            "required": ["description", "prompt"]
        }),
    }
}

/// What a `spawn_agent` call asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    pub description: String,
    pub prompt: String,
    pub background: bool,
}

pub fn parse(input: &Value) -> Result<Task, String> {
    let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
    let (description, prompt) = (text("description"), text("prompt"));
    if prompt.is_empty() {
        return Err("spawn_agent needs a `prompt`: the complete task for the sub-agent.".into());
    }
    let description = if description.is_empty() { ui::title_from(&[user_message(&prompt)]).unwrap_or_default() } else { description };
    let background = input.get("background").and_then(Value::as_bool).unwrap_or(false);
    Ok(Task { description, prompt, background })
}

/// A background sub-agent's call result.
pub fn background_result() -> String {
    format!(
        "{BACKGROUND}: this sub-agent is still working. Its report will arrive later in a message of its own, \
         marked <subagent_report>. Carry on meanwhile; don't start another sub-agent for the same task or wait for it."
    )
}

/// The message that brings a background sub-agent's report to its parent:
/// `Ok` with its final message, or `Err` with what went wrong.
pub fn report_message(call_id: &str, description: &str, outcome: Result<Option<String>, String>) -> Value {
    let (status, body) = match outcome {
        Ok(report) => ("done", report.unwrap_or_else(|| NO_REPORT.into())),
        Err(error) => ("failed", format!("The sub-agent failed: {error}")),
    };
    let label = description.replace('"', "'");
    let text = format!(
        "<subagent_report agent=\"{label}\" status=\"{status}\">\n{body}\n</subagent_report>\n\n\
         This is the report of a sub-agent you started, which worked in the background; it isn't a message from the user. \
         Carry on with the user's task using it, and tell the user what matters from it."
    );
    json!({
        "id": ui::new_id(),
        "role": "user",
        "parts": [{ "type": "text", "text": text }],
        "metadata": { REPORT: { "callId": call_id, "description": description, "status": status } },
    })
}

/// The message a sub-agent's thread starts with.
pub fn user_message(prompt: &str) -> Value {
    json!({ "id": ui::new_id(), "role": "user", "parts": [{ "type": "text", "text": prompt }] })
}

/// Standing instructions for a sub-agent's run, added to its system prompt.
pub fn system_section() -> &'static str {
    "You are a sub-agent. Another agent gave you the task in the first message and is waiting for your result; \
     it can't see your intermediate messages or tool calls, only your final message. Work on the task on your own \
     and don't ask questions: if something is ambiguous, make a reasonable choice and say so. Stay within the task. \
     When you're done, end with a final message that is a complete, self-contained report: what you found or did, \
     with file paths, names and figures where they matter, and anything you couldn't do. Keep it as short as the \
     task allows."
}

/// A finished run's report: the text of its last reply after its last tool call
/// (all of the reply's text if that's empty).
pub fn final_text(messages: &[Value]) -> Option<String> {
    let last = messages.iter().rev().find(|m| role(m) == Some("assistant"))?;
    let parts = ui::parts(last);
    let texts = |parts: &[Value]| {
        parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let after_tools = parts.iter().rposition(|p| p.get("type").and_then(Value::as_str) == Some("dynamic-tool")).map_or(0, |i| i + 1);
    let text = texts(&parts[after_tools..]);
    let text = if text.is_empty() { texts(parts) } else { text };
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_report_is_the_text_after_the_last_tool_call() {
        let messages = vec![
            user_message("look"),
            json!({ "role": "assistant", "parts": [
                { "type": "step-start" },
                { "type": "text", "text": "Let me look." },
                { "type": "dynamic-tool", "toolName": "fs_read", "toolCallId": "c", "state": "output-available", "input": {}, "output": "x" },
                { "type": "step-start" },
                { "type": "text", "text": "Found it in a.rs." },
            ]}),
        ];
        assert_eq!(final_text(&messages).as_deref(), Some("Found it in a.rs."));
    }

    #[test]
    fn a_reply_ending_in_a_tool_call_reports_all_its_text() {
        let messages = vec![json!({ "role": "assistant", "parts": [
            { "type": "text", "text": "Partial." },
            { "type": "dynamic-tool", "toolName": "fs_read", "toolCallId": "c", "state": "output-error", "input": {}, "errorText": "x" },
        ]})];
        assert_eq!(final_text(&messages).as_deref(), Some("Partial."));
        assert_eq!(final_text(&[user_message("hi")]), None);
    }

    #[test]
    fn a_task_needs_a_prompt_and_gets_a_label() {
        assert!(parse(&json!({ "description": "x" })).is_err());
        let task = parse(&json!({ "prompt": "Find the bug\nin detail" })).unwrap();
        assert_eq!(task.description, "Find the bug");
        assert!(!task.background);
        assert!(parse(&json!({ "prompt": "x", "background": true })).unwrap().background);
    }

    #[test]
    fn a_report_message_names_its_call() {
        let m = report_message("c1", "Say \"hi\"", Ok(Some("Hi.".into())));
        assert_eq!(m["metadata"][REPORT]["callId"], "c1");
        let text = m["parts"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("<subagent_report agent=\"Say 'hi'\" status=\"done\">\nHi.\n"));
        assert!(background_result().starts_with(BACKGROUND));
    }
}
