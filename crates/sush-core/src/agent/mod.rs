//! The agent loop, independent of any UI toolkit: a run streams model steps
//! into a thread's messages, runs tool calls, and asks the host for anything
//! app-specific (provider requests, connector calls, saving, UI updates).

pub mod run;
pub mod ui;

pub use run::{run, Approval, Inbox, RunAction, RunConfig, RunEvent, RunHost, RunStatus, RunTool, ToolExec, ToolResponse};
pub use ui::{Op, ToolCall};
