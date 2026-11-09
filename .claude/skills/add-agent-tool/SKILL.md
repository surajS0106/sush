---
name: add-agent-tool
description: Add a built-in tool the chat model can call (like memory_write, chats_search, skill, artifact_write), covering its spec, when it's offered, how it runs, whether it needs approval, and how it renders. Use when giving the model a new capability inside the app, as opposed to an MCP connector tool.
---

# Add a built-in model tool

Built-in tools run in the **UI**, not in Rust. The run lives in Rust (`runs.rs`); for a UI-owned tool (`exec: client`) it sends a `client-tool` frame to the leader window, `sessions.ts` calls `runTool`, and the result goes back with `tool_result`. A tool that waits for the user instead holds the run as `awaiting` until its card answers through `respond` (`sessions.ts`). Connector tools (`<connector>__<tool>`) are generated from MCP servers, so you never add them by hand; to give one a card or a confirm step, see the `swiggy` skill.

All dispatch lives in `apps/desktop/src/lib/agent.ts`. Follow how the existing tools are built.

## 1. Define the spec

Next to the feature it belongs to (e.g. `lib/memory.ts`, `lib/skills.ts`, `lib/artifacts.ts`), or in `agent.ts` for small ones, export a name constant and a `ToolSpec`:

```ts
export const THING_DO = "thing_do";
export const thingTool: ToolSpec = {
  name: THING_DO,
  description: "What it does and *when the model should use it*.",
  inputSchema: { type: "object", properties: { ... }, required: [...] },
};
```

Names: `snake_case`, at most 64 chars, no `__` (that marks connector tools). The description is the model's only guidance, so say when to call the tool and when not to.

## 2. Offer it: `buildContext()` in `agent.ts`

Add the spec to the `tools` array, gated on whatever pref or state enables it (see `prefs.memory ? memoryTools : []`). If the model needs standing instructions, push a section onto `sections` (the system prompt). A new user-facing toggle belongs in `library.prefs()` (`lib/library.ts`) plus a control in the settings/composer UI.

## 3. Classify it

- Add a `ToolKind` value and a branch in `toolKind()`. An `"unknown"` kind gets an immediate error result in `chat-view.tsx`.
- `runsWithoutApproval()`: return true only for tools that are local and harmless to run unasked. Tools that save, delete, or act outside the app wait for the user (see `skill_save`).

## 4. Run it

- **Auto-run tools**: add a branch in `runTool()`. Validate `args` yourself (the model can send anything) and return `{ errorText }` with a message that tells the model how to fix the call. `runTool` must never throw.
- **Approval or user-answered tools** (like `skill_save`, `ask_user`): the component in step 5 performs the action and calls `onResult({ output } | { errorText })`.

## 5. Render it: `components/tool-parts.tsx`

Add a `case` in `ToolPart` that returns a small component for the part's states (`input-streaming`, `input-available`, `output-available`, `output-error`). Without a case it falls through to `ConnectorPart`. Artifacts are the exception: `chat-view.tsx` renders them specially. Reuse `components/ui` pieces (`Tool`, `ApprovalCard`, `Confirmation`) where they fit.

## 6. Shared sessions

A session can be shared live (`multiplayer` skill), so decide three things:

- **Does its input or output hold the owner's private data** (memory, other chats, account details)? Add its name to `PRIVATE_TOOLS` in `crates/sush-core/src/share/redact.rs`, with a test. Otherwise guests see the call as the host does (tool text output is only scrubbed for credential patterns).
- **Who may answer it.** `share::policy::classify` (Rust) and its mirror `approvalClass` in `lib/share.ts` treat an unknown name as `OwnerOnly`: guests see "Waiting for … to approve", and a driver can't answer. That's right for anything that writes to the owner's library or acts for them (like `skill_save`). Only a question-like tool a driver may answer should get its own class, in both places, with a policy test. A guest never sends a result, only approve/deny (and an answer for `ask_user`).
- **If it waits for the user**, add its `ToolKind` to `ASKS` in `tool-parts.tsx`, so a guest sees who it's waiting for instead of a dead card. Cards get `answer` (from `metadata.sushAnswers`) and show "Approved by …" under them; don't hide that. Hide options that change the owner's standing settings ("Always allow" and the like) when `useContext(WatchingHost)` is set.

## 7. Compatibility

Conversations are saved in `sush.db` with their tool parts. If you rename or retire a tool, keep recognising the old name so old chats still render (see `MEMORY_SAVE` in `agent.ts`).

## 8. Verify

`bun run typecheck` and `bun --filter desktop build` (the `check` skill). Then launch the app (`run-app` skill) with a model that supports tools, and prompt it into calling the tool.

## The UI's own tools (moved from CLAUDE.md)

How the existing UI-owned tools work, as a reference when adding or changing one.

`image_generate`: offered only once an image model is set in Settings → Images (`lib/images.ts`), shown with `components/ai-elements/image.tsx`; `map_show` (`lib/maps.ts`): a Google Map of a route or place in `components/map-card.tsx`, a keyless iframe; the user's own Google key from Settings → Maps (`components/maps-section.tsx`, keyring) adds live details fetched in Rust (`sush_core::maps`) for the card and the model; `flights_search` (`lib/flights.ts`): a flight card in `components/flight-card.tsx` with keyless links to Google Flights and Kayak and airline logos from gstatic (`img-src` in the CSP); the user's own Ignav key from Settings → Flights (`components/flights-section.tsx`, keyring) adds fares and, on Book, links to each fare's sellers, fetched in Rust (`sush_core::flights`); tickets are only ever bought on the seller's site; a globe with the plane flying the picked fare's outbound route, stop by stop (`components/flight-globe.tsx`: canvas, `d3-geo`, `world-atlas`, lazy-loaded, over a bundled satellite photo drawn with WebGL2 in `lib/earth-imagery.ts`; cities located by `sush_core::weather::locate`, stops by the bundled table in `lib/airports.ts`), a keyless weather tile for the destination (`sush_core::weather`, Open-Meteo, forecast or last year's date), the other airlines' fares in a list below the tiles (`cardOnly.moreFares`: a tool output's `cardOnly` field stays in the thread but is stripped before the model, `CARD_ONLY` in `agent/ui.rs`), prices shown in a picked currency (`lib/currency.ts`, `components/currency-select.tsx`: daily keyless rates through `sush_core::flights::exchange_rates`, display only, fares and alerts stay as quoted), and price alerts (`lib/price-alerts.ts`: localStorage, checked every 6 hours by the leader window while the app is open, a toast on a drop); `topic_lookup` (`lib/topic.ts`): photos and cited articles about a person, place or thing in `components/topic-card.tsx`, with the article's text for the model, keyless from Wikipedia (`sush_core::topic`; images in `cardOnly`, hosted by Wikimedia, `img-src` in the CSP; the card holds the first three and the model places others between its sections with `[photos](4,5)`, split out in `lib/citations.ts`; if a finished reply has none, `lib/topic-placement.ts` matches captions to sections); `weather_show` (`lib/weather.ts`): the weather now as a pixel-art card in `components/weather-card.tsx`, its scene drawn on a canvas by `lib/weather-scene.ts`, light or dark by the sun at the place and not the app's theme, with the picked mascot in it; it expands to today's figures, the next 24 hours and 7 days; keyless (`sush_core::weather::local_weather`, Open-Meteo)).
