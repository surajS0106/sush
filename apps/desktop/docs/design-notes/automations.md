# Automations — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12 (scheduler follow-up)
- The scheduler now sleeps until the next automation is due (at most 30 seconds) and recomputes whenever automations change, so runs start on the minute instead of up to 30 seconds late (`startScheduler` in `src/lib/automations.ts`).
- A scheduled run shows a toast with an "Open" action that opens its session in a new tab (`useOpenRunRequest`, consumed in `App.tsx`).

### 2026-10-12
- Added automations: a saved prompt with a schedule (manual, hourly, daily, weekdays, weekly at a local time), an optional Cowork folder, and an on/off switch. Stored in localStorage as `sush.automations` (`src/lib/automations.ts`).
- Each run creates a normal session titled after the automation and sends the prompt through `sendMessage`, so it streams, saves and waits for approvals like any session (`runAutomation` in `src/lib/automations.ts`). `createConversation` now takes an optional title, which Rust keeps because it only renames threads still called "New chat" (`src/lib/store.ts`, `src-tauri/src/runs.rs:251`).
- A scheduler in the webview checks for due runs while the app is open (`startScheduler`, started from `App.tsx`). It waits up to two minutes for connectors still connecting, and a run missed while the app was closed fires once. A failed attempt (no model, folder removed) still uses up its slot so it is not retried every tick.
- New Automations page: cards with schedule, folder, next or last run and a "new run" dot; search, sort, a "New automation" menu (Create with Sush, Set up manually), six templates, and a dialog to edit, pause, delete, run now and open recent runs (`src/components/automations-page.tsx`).
- The sidebar's Automations entry opens the page (it was a "coming soon" placeholder), shows a dot when a run hasn't been seen, and sessions started by an automation show a timer icon (`src/components/app-sidebar.tsx`). `App.tsx` gained a `page` state; opening any session returns to it.
- "Create with Sush" opens a chat with the new built-in `/create-automation` command (`src/lib/skills.ts`). The model calls the new `automation_save` tool; the user approves it in an `AutomationSaveCard`, and an automation made in a Cowork session runs in that folder (`src/lib/automation-save.ts`, `src/components/tool-parts.tsx`, `src/components/tool-approval-card.tsx`, `src/lib/agent.ts`).

## Why

Recurring work (briefings, inbox triage, weekly reviews) was something users had to remember to ask for. Running each automation as an ordinary session reuses everything a session already has (streaming, tool approvals, the sidebar status, Cowork sandboxing) instead of building a second execution path, and the result is a chat the user can continue.

Scheduling lives in the UI rather than in Rust because a run's config (system prompt, skills, connector tools, approval rules) is built in the UI by `buildContext` and `runTools`. The trade-off is that automations only run while the app is open; the page says so, and a missed run catches up once on launch rather than piling up.

Tools that act outside the app still ask for approval during unattended runs, and the session shows "waiting for you" in the sidebar. Skipping approvals for scheduled runs would make a background job able to send email or delete files without the user present.

Scheduled runs were happening but went unnoticed: they started quietly in the background, up to half a minute after the time shown, under a sidebar title identical to earlier runs. Waking exactly at the due time and announcing each run with a toast makes the schedule observable.

The model-facing pieces (`/create-automation` instructions, the tool spec, the parser) sit in a module with no app imports so `skills.ts` and `agent.ts` can import it without an import cycle through `sessions.ts`.

## What makes it stand out

- Runs are real sessions: the transcript, tool cards, approvals and file changes of every run stay browsable, and the sidebar marks them with a timer icon. A typical cron-style feature only keeps the final output.
- Prompts go through the same expansion as typed messages, so an automation can be `/code-review src/` or mention an `@connector`.
- Creating one in chat ends in a review card the user approves, like `skill_save`; the model never saves an automation on its own.
- Schedule changes and resuming reset `scheduledFrom`, so editing an automation never triggers an immediate "missed" run.
- Failure modes are explicit: a missing model or removed folder produces one toast per slot, not a retry loop or an empty session.
