# App feature tools — Design Notes

Last updated: 2026-11-18

## What changed

### 2026-11-18
- New model tools for four app features, each in its own toolset module:
  - Automations: `automation_list`, `automation_manage` (pause, resume, run now, update name / prompt / schedule, delete) (`src/lib/automation-tools.ts`). Creating one stays `automation_save`.
  - Projects: `project_list`, `project_manage` (create, optionally filing this chat; rename or change instructions; delete; file or unfile this chat) (`src/lib/project-tools.ts`).
  - Binders: `binder_list`, `binder_search` (passages through the existing `notebook_search` command), `binder_add` (a link or a text note, making the binder if the title is new) (`src/lib/binder-tools.ts`).
  - Reports: `reports_list`, `reports_read` (findings by severity, or wiki pages), `reports_start` (security review, code review or wiki, with the same scopes the pages offer) (`src/lib/report-tools.ts`).
- One registry, `src/lib/app-tools.ts`, holds the four toolsets and runs them. Shared types and helpers live in `src/lib/app-tool-kit.ts`.
- Writes return an `AppPlan` (title, rows with before and after, optional body, confirm label, destructive flag, `apply`). One component, `src/components/app-tool-part.tsx`, shows any plan as an approval card and any read as a one-line row.
- `src/lib/agent.ts`: tool kind `app`; reads run unasked, writes ask unless Auto; all deferred; not offered in incognito chats.
- `ToolPart` takes an optional `threadId`, passed from `chat-view.tsx`, so `project_manage` can file the chat it was called from.
- Shared sessions: all ten names are in `APP_TOOLS` in `crates/sush-core/src/share/redact.rs`, with tests for a binder search and a report read.
- Exported `parseSchedule` (`automation-save.ts`), `getProjects`, `getNotebooks` and `getReports` for the toolsets.

## Why

The model could save an automation and work on the CRM and Board, but it couldn't see or change most of the app. Asking it to pause an automation, file a chat in a project, look something up in a binder or explain a review's findings went nowhere.

A shared plan-and-card shape keeps the four features consistent and keeps the approval rule in one place: anything that changes stored data, starts a model run or deletes asks first, the same rule as CRM writes and saved skills. The cost is a simpler card than the CRM's (no per-change checkboxes), which is fine because each call makes one change.

The tools are deferred. Most messages touch none of these features, and keeping ten specs out of every request saves tokens and keeps the cached prompt prefix stable.

Report tools are named `reports_*` so they can't collide with `report_findings`, the tool a report's own run records results with. Binder search results name their source and page, not `sushsrc:` links, because those links open only on a binder's own page.

## What makes it stand out

- Adding a feature's tools is one module that exports an `AppToolset`. The registry, kind, approval rule, deferral, card and activity summary all pick it up without further edits in `agent.ts` or `tool-parts.tsx` (redaction still needs its name in Rust).
- Each plan is worked out once, when the card opens, so changes made elsewhere while the card waits don't change what the user is approving. Auto mode runs the same `plan` then `apply`, so there is one code path.
- Lookups return a tagged result (`findBy`), and every miss names the fix: the list tool to call, or the real names to pick from.
- Updating an automation's schedule keeps what the call doesn't mention, using the same lenient parser as `automation_save`. Days carry over only while the schedule stays weekly.
- `reports_start` defaults to the session's own Cowork folder, checks for git and a base branch before showing the card, and refuses a pull-request review without the GitHub connector, the same checks the Review page makes.
