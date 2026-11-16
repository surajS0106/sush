# Yammer meetings in Sush — Design Notes

Last updated: 2026-11-16

## What changed

### 2026-11-16 (connector logo)
- The Yammer connector shows Yammer's own mark instead of the letter fallback. The 256px `yammer-mark.png` from the Yammer app (`larp/apps/desktop/public/`) is copied to `apps/desktop/src/assets/brands/yammer-mark.png` and listed under `yammer` in `BRAND_LOGOS` (`apps/desktop/src/lib/connector-catalog.ts`), so `brandLogo` returns it for the connector's `id`.

### 2026-11-16 (Sush as the meeting brain: phase 3)
- `apps/desktop/src/lib/yammer.ts` holds Sush's side of Yammer: the connector id, `YAMMER_SECTION`, `MEETING_RECIPES`, `MEETING_PREP_PROMPT` and `openLink`.
- While the Yammer connector is on, the system prompt says when to use the meeting tools and to cite meetings as `[title](yammer://meeting/<id>)` (`buildContext`, `lib/agent.ts`). It holds no per-request values, so prompt caching keeps working.
- Links in answers: a `yammer://meeting/<id>` link, or a citation marker pointing to one, opens the meeting in Yammer (`citationComponents` and `CitedSourceList` in `components/artifact-sources.tsx`, then `yammer_open_meeting`). The Rust command makes sure Yammer is running, then sends `--open-meeting=<id>`.
- Recipes: six meeting skills (`/meeting-promises`, `/weekly-meeting-recap`, `/meeting-follow-up-email`, `/coach-me-on-a-call`, `/decision-log`, `/customer-pain-points`). They're added once, together with the connector, and skipped where a skill by that name already exists.
- The "Meeting prep" automation template asks for what was last discussed with each attendee, from meeting notes when they can be read (`MEETING_PREP_PROMPT`).
- A "Meeting finished" workflow trigger (`meeting` in `lib/workflows.ts`). `pollMeetings` in `lib/workflow-engine.ts` calls the connector's `list_meetings` every minute through `connector_read`, which requires a read-only tool. It fires for meetings that have ended and have notes, then reads each with `get_meeting` for the trigger's variables: title, notes, your notes, link, start and the whole meeting. The first check only records what's there. A Test run uses the newest written-up meeting.
- Template "Follow up after a meeting": the meeting trigger, then an agent that lists your action items, drafts the follow-up email and logs to a CRM contact that was there, then a Board task, then a notification.

### 2026-11-16
- Sush adds a connector for Yammer's meetings by itself. `syncYammerConnector` (`apps/desktop/src/lib/library.ts`), run at startup from `App.tsx`, asks `yammer_mcp_server` for Yammer's command. If there is one and no `yammer` connector exists, it adds `{ id: "yammer", name: "Yammer", server: stdio }`, but only once: the `sush.yammerConnectorAdded` flag keeps a deleted connector deleted. An existing connector's command follows Yammer if it moves.
- `yammer_mcp_server` (`apps/desktop/src-tauri/src/yammer.rs`) reads `mcp.json` from Yammer's config dir. Yammer writes that file at startup with its own binary and `--mcp`. Sush returns nothing when the file or the binary is missing.
- The Yammer connector's tools run without approval when the server marks them `readOnlyHint` (`runsWithoutApproval`, `apps/desktop/src/lib/agent.ts`). Other connectors are unchanged.
- `sush://` links (`apps/desktop/src-tauri/src/deep_link.rs`). `sush://ask?meeting=<id>&title=<title>`, from Yammer's "Ask in Sush", opens a new chat with the composer prefilled to ask about that meeting through `@Yammer` (`startDeepLinks`, `askAboutMeetingPrompt` in `lib/library.ts`). A link that started Sush waits in `Pending` until the page takes it (`deep_link_take`); later ones also send a `deep-link` event. The single-instance plugin now runs first in the builder with its `deep-link` feature, because on Windows and Linux a link starts a second copy. It's skipped when `SUSH_PROFILE` is set, so a second debug profile still runs beside the first.
- `yammer_meeting(start)` starts Yammer if needed (`ensure_running`), then sends `--meeting=start` or `--meeting=stop`. Both are idempotent on Yammer's side. No UI calls it yet; it's for "Start notes in Yammer" on briefs and calendar workflows.

## Why

Granola keeps chat, recipes and briefs in one app. Here Yammer stays a fast capture app on desktop and phone, and Sush, which already has an agent, skills, automations, workflows, a CRM and a Board, gets the meetings as data. Recipes are skills rather than a new feature, so they're editable, shareable and invoked like every other skill. The meeting trigger fires only once notes exist, because the action-item and follow-up steps need them. The trade-off is that a meeting whose notes are never written never triggers anything.

This is the bridge of the Yammer + Sush plan to match Granola: Yammer captures meetings and Sush reasons across them. MCP was chosen over Sush reading Yammer's JSON files directly. The file format stays Yammer's own business, the same server works for Claude Desktop and Cursor, and Sush's existing connector machinery (deferred loading, @-mentions, tool cards) applies without new code. Discovery goes through `mcp.json` rather than guessing install paths. An older Yammer launched with `--mcp` would hand the launch to its running instance and open its window, so Sush only connects once Yammer says it can serve meetings. The file also covers dev builds and AppImages, whose paths Sush can't guess. The connector is added on rather than offered, so it works without a setup step. The trade-off is that a model can read meeting content in any chat where it decides to. It's listed under Connectors to turn off, and the tools are deferred until the model loads them.
The logo is shown in full colour, like Plinth's, because the mark is a multicolour gradient that would turn into a flat silhouette if it were recoloured as a mask like the catalog's SVG icons. It's a copy rather than a path into the Yammer repo, so Sush builds on its own.

## What makes it stand out

- Citations are links back into Yammer, not just text, so every claim about a meeting can be checked against its notes and transcript in one click.
- The workflow trigger needs no webhook or watcher: it reuses the read-only polling that mail and calendar triggers already have, at a minute's interval because the server is local.
- A link can only fill in the composer. A web page that opens `sush://ask?...` can't send a message, run a tool or change anything without the user pressing Send.
- No setup and no account: installing or updating Yammer is enough, and the meetings never leave the computer except in what the model reads.
- The server is read-only by construction (it only opens files), and its tools say so. That's what lets them skip approval while every other connector still asks.
- Deleting the connector is respected: it isn't re-added on the next launch.
- `yammer_meeting` is idempotent, so a button pressed twice, or a workflow that runs twice, doesn't start and then stop a meeting the way a toggle would.
