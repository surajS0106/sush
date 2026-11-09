//! Planning, the way Claude Code does it: the model keeps a to-do list
//! (`todo_write`, a tool the UI owns, `lib/todos.ts`) and works through it.
//! The system prompt asks for that, but weaker models skip it, so a run in a
//! Cowork folder that offers the tool also gets two nudges from the loop:
//!
//! - **A reminder** on the turn's first request, appended to the user's
//!   message as the model sees it (never stored): start with a to-do list if
//!   the request has several parts. It's at the end of the context, where
//!   models heed it most, and leaves the cached prefix alone.
//! - **A completion check**: when the model ends its reply while the turn's
//!   latest list still has unfinished items, the run adds a message listing
//!   them ([`PLAN_CHECK`] in its metadata, shown as a divider) and carries on.
//!   At most once per turn, so a model that is really blocked can stop.

use serde_json::{json, Value};

use super::run::{RunTool, ToolExec};
use super::ui;
use crate::message::{Message, Part, Role};

pub const TODO_WRITE: &str = "todo_write";
/// Metadata key on the message the completion check adds.
pub const PLAN_CHECK: &str = "planCheck";

const REMINDER: &str = "<system-reminder>\nIf this request asks for more than one thing or takes several steps \
(changes, commands, checks), call todo_write before anything else, with one item per step, then work through the items, \
marking each in_progress when you start it and completed when it's done. Count the things asked for, not the files: \
three changes to one file are three items. Skip the list only for a question or a single small change. Don't mention \
this reminder.\n</system-reminder>";

/// Whether a run gets the nudges: it works in a folder and can keep a list.
pub fn applies(tools: &[RunTool]) -> bool {
    tools.iter().any(|t| t.spec.name == TODO_WRITE && !t.deferred) && tools.iter().any(|t| matches!(t.exec, ToolExec::Workspace))
}

/// A message the user wrote, as opposed to one the app sent for them.
fn from_person(message: &Value) -> bool {
    let meta = message.get("metadata");
    let flag = |key: &str| meta.and_then(|m| m.get(key)).is_some_and(|v| !v.is_null() && v != &Value::Bool(false));
    ui::role(message) == Some("user") && !["subagentReport", "resumed", "compaction", PLAN_CHECK].into_iter().any(flag)
}

/// The messages since the user's latest one.
fn turn(messages: &[Value]) -> &[Value] {
    let start = messages.iter().rposition(from_person).map_or(0, |i| i + 1);
    &messages[start..]
}

fn todo_calls(messages: &[Value]) -> impl DoubleEndedIterator<Item = &Value> {
    messages
        .iter()
        .filter(|m| ui::role(m) == Some("assistant"))
        .flat_map(ui::parts)
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("dynamic-tool") && p.get("toolName").and_then(Value::as_str) == Some(TODO_WRITE))
}

/// Add the reminder to the request for a turn's first step: the last message
/// is the user's and the turn has no list yet.
pub fn remind(messages: &[Value], core: &mut [Message]) {
    if !messages.last().is_some_and(from_person) || todo_calls(turn(messages)).next().is_some() {
        return;
    }
    if let Some(last) = core.last_mut().filter(|m| m.role == Role::User) {
        last.parts.push(Part::Text { text: REMINDER.into() });
    }
}

/// The unfinished items of the turn's latest list.
fn unfinished(messages: &[Value]) -> Vec<String> {
    let Some(call) = todo_calls(turn(messages)).rfind(|p| p.get("state").and_then(Value::as_str) == Some("output-available")) else {
        return Vec::new();
    };
    let todos = call.pointer("/input/todos").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    todos
        .iter()
        .filter(|t| {
            let status = t.get("status").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
            status != "completed" && status != "done"
        })
        .filter_map(|t| t.get("content").and_then(Value::as_str).map(str::trim).filter(|c| !c.is_empty()))
        .map(str::to_owned)
        .collect()
}

/// The message that sends the model back to its list, if the reply ended
/// with items unfinished and this turn hasn't had one yet.
pub fn check(messages: &[Value]) -> Option<Value> {
    let current = turn(messages);
    if current.iter().any(|m| m.pointer(&format!("/metadata/{PLAN_CHECK}")).is_some()) {
        return None;
    }
    let left = unfinished(messages);
    if left.is_empty() {
        return None;
    }
    let items = left.iter().map(|c| format!("- {c}")).collect::<Vec<_>>().join("\n");
    let text = format!(
        "<system-reminder>\nYour to-do list still has {} unfinished:\n{items}\nCarry on with them now. If one can't be done (you \
         need the user's input, or it isn't possible), update the list to say so and tell the user briefly what's left \
         and why. Don't mention this reminder.\n</system-reminder>",
        if left.len() == 1 { "an item".to_string() } else { format!("{} items", left.len()) },
    );
    Some(json!({
        "id": ui::new_id(),
        "role": "user",
        "parts": [{ "type": "text", "text": text }],
        "metadata": { PLAN_CHECK: { "left": left.len() } },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::ToolSpec;

    fn user(text: &str) -> Value {
        json!({ "id": ui::new_id(), "role": "user", "parts": [{ "type": "text", "text": text }] })
    }

    fn todos(items: &[(&str, &str)]) -> Value {
        let todos: Vec<Value> = items.iter().map(|(c, s)| json!({ "content": c, "status": s })).collect();
        json!({ "id": ui::new_id(), "role": "assistant", "parts": [
            { "type": "step-start" },
            { "type": "dynamic-tool", "toolName": TODO_WRITE, "toolCallId": "t", "state": "output-available", "input": { "todos": todos }, "output": "ok" },
            { "type": "text", "text": "Done." },
        ] })
    }

    fn tool(name: &str, exec: ToolExec) -> RunTool {
        RunTool { spec: ToolSpec { name: name.into(), description: String::new(), input_schema: json!({}) }, exec, approval: super::super::Approval::Auto, deferred: false }
    }

    #[test]
    fn only_cowork_runs_with_the_tool_get_nudged() {
        assert!(applies(&[tool(TODO_WRITE, ToolExec::Client), tool("fs_read", ToolExec::Workspace)]));
        assert!(!applies(&[tool(TODO_WRITE, ToolExec::Client)]));
        assert!(!applies(&[tool("fs_read", ToolExec::Workspace)]));
    }

    #[test]
    fn the_reminder_goes_on_a_turns_first_request_only() {
        let mut core = vec![Message::text(Role::User, "do three things")];
        remind(&[user("do three things")], &mut core);
        assert_eq!(core[0].parts.len(), 2);

        // After the model has started (or planned), nothing is added.
        let thread = vec![user("do three things"), todos(&[("a", "pending")])];
        let mut core = vec![Message::text(Role::User, "x")];
        remind(&thread, &mut core);
        assert_eq!(core[0].parts.len(), 1);
    }

    #[test]
    fn an_unfinished_list_sends_the_model_back_once() {
        let mut thread = vec![user("go"), todos(&[("a", "completed"), ("b", "in_progress"), ("c", "pending")])];
        let message = check(&thread).expect("a check");
        let text = message.pointer("/parts/0/text").and_then(Value::as_str).unwrap();
        assert!(text.contains("2 items") && text.contains("- b") && text.contains("- c") && !text.contains("- a"));
        thread.push(message);
        thread.push(todos(&[("a", "completed"), ("b", "in_progress"), ("c", "pending")]));
        // The turn already had its check: the model may stop.
        assert!(check(&thread).is_none());
        // A new message from the user starts a new turn, with no list yet.
        thread.push(user("next"));
        assert!(check(&thread).is_none());
    }

    #[test]
    fn a_finished_list_needs_no_check() {
        assert!(check(&[user("go"), todos(&[("a", "completed"), ("b", "done")])]).is_none());
        assert!(check(&[user("go")]).is_none());
    }
}
