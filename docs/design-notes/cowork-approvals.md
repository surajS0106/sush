# Cowork approvals — Design Notes

Last updated: 2026-11-03

## What changed

### 2026-11-03
- "Edit automatically" now means everything runs without asking. Before, it covered only edits, commits, merging the base in, and commands the sandbox kept offline. Commands that need the network or leave the sandbox, commands in a folder set to run on the user's machine, commands where no sandbox works, and `git_merge` with `into` all asked. So a push, `gh pr create`, `gh pr merge` and landing on `main` stopped the run every time (`approval` in `crates/sush-core/src/workspace/tools.rs`).
- Two kinds of call still ask in that mode:
  - **Destructive commands** (`tools::destructive`): sudo/doas/su, disk tools, recursive deletes of `/`, `~`, `$HOME`, `*`, `.` or `..`, PowerShell `Remove-Item -Recurse`, a force-push (`-f`, `--force*`, `+ref`), deleting on the remote (`--delete`, `:ref`, `--mirror`), `reset --hard`, `clean -f`, `checkout -- `, `restore`, `branch -D`, history rewrites, `gh … delete`, and a download piped into a shell. The check runs anywhere in a chained line, so `git push && git reset --hard` asks.
  - **Reading secret-looking files**, as before.
- "Ask before changes" now asks for every command, a contained one too, which it already did.
- The system prompt says which mode the folder is in. In the automatic mode it lists what still asks, so the model picks a safe form when there is one. The lines that said "the user approves each one" are gone from the sandbox and desktop text.
- The folder chip's hint reads "Edits, commands, pushes and merges run; only destructive ones ask" (`components/workspace-panel.tsx`).
- "Allow all" on an approval card for landing on a branch now switches the folder to automatic like any edit's does, since that mode covers it (`components/tool-parts.tsx`).
- Shared sessions are unchanged. While someone else can steer, `floored` still makes standing permissions ask again (`share::policy`), so nothing runs on the owner's authority because of a guest's message.

## Why

The point of an automatic mode is that the run doesn't stop for things the user already decided to allow. The old rule tied "automatic" to what the sandbox could contain. Every git push and PR merge needs the network and has to write `.git`, so the PR flow could never run hands-free, and the card's merge animation stopped at an approval card each time. Claude's own auto mode draws the line at harm instead of at the sandbox, and this does the same: routine commands run, and the few that destroy work or take over the machine ask. The trade-off is that unsandboxed commands now run without a look from the user. Each turn's file changes can still be undone, but a push can't be taken back. That's why rewriting or deleting the remote stays on the ask list, while an ordinary push doesn't.

## What makes it stand out

- The rule is one function in Rust (`approval` + `destructive`), the same for every window and for the run itself. The UI never decides.
- The destructive check reads the whole command line, chained parts included, so a safe command can't carry a destructive one past it.
- It's tested both ways: a list of commands that must ask and a list that must not (`approval_follows_the_workspace_policy`), including near misses like `rm -rf ./dist` and a branch named `feat/force-fix`.
- The model is told the same rule the host enforces, so it doesn't stop to ask in prose for things that would have run anyway.
- Guests in a shared session can't benefit from it: the floor for steerable sessions still applies.
