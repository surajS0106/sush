---
name: add-agent-tool
description: Add a built-in tool the chat model can call (like memory_write, chats_search, skill, artifact_write), covering its spec, when it's offered, how it runs, whether it needs approval, and how it renders. Use when giving the model a new capability inside the app, as opposed to an MCP connector tool.
---

# Add a built-in model tool

Built-in tools run in the **UI**, not in Rust. The model's tool call streams back through `TauriChatTransport`. `useChat`'s `onToolCall` in `components/chat-view.tsx` then runs the tool or waits for the user, and the result is sent back automatically. Connector tools (`<connector>__<tool>`) are generated from MCP servers, so you never add them by hand.

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

## 6. Compatibility

Conversations are saved in localStorage with their tool parts. If you rename or retire a tool, keep recognising the old name so old chats still render (see `MEMORY_SAVE` in `agent.ts`).

## 7. Verify

`bun run typecheck` and `bun --filter desktop build` (the `check` skill). Then launch the app (`run-app` skill) with a model that supports tools, and prompt it into calling the tool.
