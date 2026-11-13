# Outside engines: Claude Code and Codex

A Cowork session can run on the user's own Claude Code or Codex instead of Sush's agent loop. The code is in `crates/sush-core/src/engines/`. Sush starts the CLI the user installed, translates its stream into the `Op`s the UI and shared sessions already use, and answers its permission prompts from Sush's approval cards. Watching, steering, "Send now", Stop, Resume and sharing all work the same as on Sush's own loop.

## The rules (read before changing how an engine starts or signs in)

These come from the providers' terms as of 2026-11-10. Re-check them before changing anything here:

- Anthropic: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- OpenAI: [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source), [Codex app-server](https://learn.chatgpt.com/docs/app-server)

What follows from them:

- **The user signs in inside the CLI, never in Sush.** That means `claude auth login` and `codex login`. Sush must not offer a "Sign in with Claude" flow, and must not collect, store, read, pass on or refresh Claude.ai or ChatGPT tokens. Anthropic: "sign-in to a Claude account must complete through Anthropic's own flow."
- **Run the CLI as published, unmodified,** with none of its sign-in methods removed or restricted.
- **Don't use the Claude Agent SDK with a claude.ai login.** Its docs forbid that "unless previously approved." Sush drives the `claude` binary headless (`-p --output-format stream-json`), which is the route the SDK docs give for other languages, and keeps the user's own login in the binary.
- **Don't pay for, resell or pool usage.** Each user runs on their own plan, and Sush adds no cost for engine replies (they count as $0 in Usage and the budget).
- **Status checks ask the CLI and read only whether it's signed in.** `claude auth status` reads `loggedIn`. `codex login status` reads the exit code. Never read the email, the org or the tokens.
- **Don't call the product or a feature "Claude Code".** Saying a session "runs on Claude Code" is fine.

Before charging for anything:

- Anthropic: running Claude Code inside a product means accepting Anthropic's Commercial Terms.
- OpenAI: app-server authentication "has never been permitted for commercial or hosted services". A paid app goes through the [Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/) first.

**Open question: shared sessions on a consumer plan.** Anthropic's consumer terms say you may not make your account "available to anyone else." A guest who steers the host's session spends the host's Pro or Max plan. Until Anthropic confirms this is fine, keep a guest's message going through the host where possible (the "to suggest" role), and point teams at Claude Team or Enterprise plans, or API keys. We've asked both providers in writing.

## How each engine runs

**Claude Code** (`engines/claude.rs`), checked against Claude Code 2.1.268:

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --replay-user-messages
  --permission-prompt-tool stdio --permission-mode <default|acceptEdits|plan>
  [--model <alias>] [--resume <session id>]
```

- Messages sent mid-turn go in at once. Claude Code takes each one at its next boundary and echoes it (`isReplay`), which is when the thread shows it.
- "Send now" sends an `interrupt` control request.
- Permission prompts arrive as `can_use_tool` control requests and get `allow` (with the original input) or `deny`.
- `AskUserQuestion` is denied, with a note telling the model to ask in its reply instead.
- A sub-agent's events (`parent_tool_use_id`) stay inside its `Task` call.

**Codex** (`engines/codex.rs`): `codex app-server`, JSON-RPC over stdio.

- The sequence is `initialize`, then `initialized`, then `thread/start` (or `thread/resume`), then `turn/start`.
- Approvals arrive as `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` requests. The older `execCommandApproval` and `applyPatchApproval` forms are handled too.
- The folder's settings map to Codex's own sandbox and approval policy (`settings` in `codex.rs`).
- A message sent mid-turn starts the next turn. "Send now" sends `turn/interrupt` first.
- **This adapter hasn't been run against a live Codex yet.**

**Models and effort:** the picker lists each CLI's own models, so it stays current as the CLI updates.

- Claude Code: the `models` in its `initialize` reply, which is what its `/model` menu shows. Each comes with a version ("Fable 5.1") and its effort levels. Models it marks `disabled` are left out, such as "Opus 5.5: update to 2.1.280+".
- Codex: `model/list`.
- Listing starts the CLI without sending a message, so no model is called. The `initialize` reply also names the account, and Sush never reads that part.
- Effort goes to the CLI as `--effort` for Claude, or `effort` on `turn/start` for Codex. Neither CLI can switch thinking off: it decides when to think, so the composer offers effort levels only (`capsFor` in `lib/reasoning.ts`).
- Each reply records the model the CLI actually ran (`message.model`), not the alias picked.

**Sessions:** each reply records the CLI's session id (`metadata.engineSession`), and the next message resumes it. A regenerate, an edited message, or replies from another model in between start a new session, with the earlier conversation quoted as text.

**Cards:** CLI tools map to Sush's cards where one fits: `Bash` becomes `shell_run`, `Edit` becomes `fs_edit`, `TodoWrite` becomes `todo_write`, and Codex's `commandExecution` and `fileChange` map the same way. Anything else shows as `claude-code__<tool>` or `codex__<tool>`. Commands are marked `unsandboxed` because they run under the CLI's rules, not Sush's sandbox. That also stops shared-session guests from approving them.

## Limits

- Cowork only: the engine needs a folder. Reports, notebooks, incognito chats and one-shot calls (memory, compaction) stay on Sush's own models.
- Sush doesn't checkpoint an engine's edits, so Undo on a turn has nothing to restore. Use git, or the CLI's own rewind.
- Attachments other than folders aren't passed on yet. The prompt notes them instead.
- Sush's memory, skills, connectors and system prompt aren't given to the engine. It uses its own (CLAUDE.md, AGENTS.md, its MCP config).

## Trying it

1. Install the CLI and sign in in a terminal: `claude auth login` or `codex login`.
2. Start Sush (`bun run dev:app`), open a Cowork session on a git folder, and pick Claude Code or Codex in the model picker.
3. Check each of these:
   - an edit asks first, and Approve and Deny both work
   - a command's output shows on its card
   - a message sent mid-run joins at a boundary
   - "Send now" interrupts
   - Stop, then Resume
   - a second message resumes the same session (`metadata.engineSession` stays the same)
   - a share shows the run to a guest
