# Workflows — Design Notes

Last updated: 2026-11-10

## What changed

### 2026-11-10 (for people who don't code)
- Model choice: a workflow has its own model, picked in the editor's top bar with the chats' model picker ("Use default" goes back to following the last chat pick), and AI, tool and AI-decided If steps can pick their own. Runs, Fix and the builder's AI use it; a step thread records its model so an approval answered from any window runs on the same one (`Workflow.model`, `modelFor`/`stepModel` in `lib/workflows.ts`, `StepThread.target` read by `runConfig` in `lib/sessions.ts`, `WorkflowModel` and `StepModel`).
- Model-provider problems (out of credits, rejected key, rate limits, unreachable) read in plain words on the failed step and in the builder's AI buttons, with the provider's own message kept under "What the provider said". Fix doesn't ask the model about these (it would fail the same way); it explains and opens the model settings (`providerTrouble` in `lib/workflows.ts`, `FixDialog`).
- Values from earlier steps show as chips ("Company", "Research the customer") in every text setting, added with "+ Insert" grouped by where they come from; the `{{key}}` text is only how they're stored (`components/token-field.tsx`, `variablesFor`/`variableLabel`/`humanize` in `lib/workflows.ts`). Trigger values are named for what started it ("Deal's name", "New stage").
- Plain words throughout the inspector: no `{{…}}` in placeholders or hints, "later steps can use its answer" instead of the key, no code font in prompts, and a four-line "How it works" guide when no step is picked (`components/workflow-inspector.tsx`). Canvas cards and the Fix dialog show chip names (`humanize`).
- The on/off switch is now "Runs by itself" with a tooltip saying what on, off and unpublished mean, and a toast when it changes. It shows only for triggers that start by themselves (CRM, email, calendar, folder); hand, chat and automation workflows say how they start instead (`howItStarts` in `lib/workflows.ts`, `AutoSwitch` in `components/workflows-page.tsx`).
- Flow steps: "Do at the same time" (parallel), "Wait for branches" (join: every branch, or the first; hands on each branch's answer by step name) and "End" (finish as done, or as failed with a reason that fails the run). The palette groups read Start, AI, Tools, Flow, Actions (`lib/workflows.ts`, `lib/workflow-engine.ts`).

### 2026-11-10 (later)
- Test run now starts every trigger type with real input: a CRM record, the newest item from a mail or calendar trigger's read-only tool, the picked folder, or the test input (`sampleTrigger` in `lib/workflow-engine.ts`). Mail and calendar reading is shared with polling (`readItems`, `itemTrigger`).
- Removed the "coming next" flag from the step catalog, palette, checks and AI prompts: every trigger runs.

### 2026-11-10
- Workflow model: one trigger plus steps joined by connections, each step with a `{{key}}` its later steps read; a draft and a published (`live`) graph; undo/redo; loop and trigger checks; templates; runs with per-step status, input, output and thread; step threads registered so every window builds their runs the same way (`apps/desktop/src/lib/workflows.ts`, `lib/workflow-templates.ts`).
- Engine: walks the graph from the trigger, runs steps whose inputs are settled in parallel, skips branches an If or approval didn't take, and stops on request from any window. Agent steps are ordinary hidden threads; tool steps are agent runs given only their one tool. Also covers If (compare, or a yes/no model call), Ask me first, Wait, CRM update/log, Board task, notify and start a session (`lib/workflow-engine.ts`).
- Triggers: by hand, CRM changes (Rust sends `crm-event` frames), files changing in a Cowork folder, a chat (`workflow_run` tool), an automation (`Automation.workflowId`), and mail or calendar items polled through connector tools the server marks read-only. A burst limit stops more than 20 trigger-started runs a minute.
- `connector_read`: a Tauri command that calls only connector tools with `readOnlyHint: true`, with a test (`src-tauri/src/connectors.rs`).
- Editor: a palette, a canvas (pan, zoom, fit, comment pins, keyboard navigation, drag to connect, live run state on steps and connections), an inspector with per-type settings, values to insert from earlier steps and connections, and a resizable run panel with approvals, step threads in a drawer and history (`components/workflows-page.tsx`, `workflow-canvas.tsx`, `workflow-inspector.tsx`).
- AI: describe to build or change a workflow, suggest next steps, set up a step, sample input, and Fix for a failed step with a before/after of its settings (`lib/workflow-ai.ts`).
- Chat tools and card (`lib/workflow-tools.ts`, `components/workflow-tool-part.tsx`), redacted for shared-session guests.

## Why

Workflows are their own page, separate from Automations, at the user's request: Automations stays the place for schedules, and an automation can start a workflow.

The plan put the executor in Rust. It runs in the UI instead, like Automations, because steps reuse what already exists there: hidden threads stream and wait for approvals, CRM and Board actions are UI modules, and the webview is deliberately not allowed to call connector tools. The trade-off is that runs only happen while Sush is open, which the page says.

Tool steps run as an agent restricted to one tool rather than calling the connector directly. That keeps connector calls inside agent runs, where the approval rules for risky tools still apply. The single exception, polling mail and calendars, is limited in Rust to tools the server declares read-only.

The builder is meant for people who don't write code, so templating syntax is never shown: values are chips with names that match the trigger, and the stored `{{key}}` format stays only so runs, templates and the AI builder keep one plain-text representation. Parallel and join were already implicit (a step's output wired to two steps; a step with two inputs waits for both); they're explicit steps now because the canvas should say what happens without the reader knowing those rules. End is the only way to mark a run failed on purpose.

Editing a published workflow changes a draft, so a live trigger never runs a half-finished edit; Test run uses the draft.

## What makes it stand out

- Branch semantics are explicit: a step runs when every input is settled and at least one carried the run, so If/No branches skip cleanly and merges wait.
- Approvals and stops work from any window, through the shared run record; runs left running by a quit app are marked stopped on the next launch.
- AI-built graphs go through the same checks as hand edits (known types, one trigger, no loops), keep the ids and positions of steps they kept, and land as one undoable edit.
- Keyboard: arrows move between steps, Alt+arrows nudge, A connects, E jumps to connections, ⇧1 fits, ⌘Z/⇧⌘Z; progress is announced politely.
- Colours follow the accent; coral marks failed steps only.
