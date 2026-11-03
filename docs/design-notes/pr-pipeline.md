# Pull request pipeline (Cowork) — Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04 (Delete branch deletes it here too)
- Delete branch removed only the remote copy, so the deleted branch stayed in the composer's branch chip. It now does what `gh pr merge --delete-branch` does: `git push <remote> --delete <branch> && git switch <base> && git branch -D <branch>`, as one approved command. When the remote copy is already gone (deleted on GitHub's website, or by an older build), it offers the last two steps. `-D` is needed because a squash or rebase merge leaves the branch's own commits off the base. The PR being merged is what makes that safe. Afterwards HEAD is on the base and the card reads "Merged into main · branch deleted". In a Sush worktree whose base is checked out elsewhere, `git switch` fails, so the chain stops after the remote delete.

- **Plain words in the transcript.** A card button used to send its whole instruction to the model as your message, for example "Merge the pull request with `gh pr merge 5 --rebase` (shell_run with network and unsandboxed)…". Now the transcript shows what you chose ("Rebase and merge #5", "Delete feat/x from origin", "Fix the failing unit check"). The exact instruction travels in the message's `metadata.instruction` and reaches the model through the existing expansions path (`runConfig` in `lib/sessions.ts` → `to_core`), so it is still there on every later run. A guest in a shared session sends text only, so for them the instruction is sent as text.
- **A click is the approval.** Delete branch asked again, even in a workspace that edits automatically, because remote deletes are `tools::destructive`. But pressing the button is already your yes. The message now carries `instruction.approves` (the exact commands named), and the run's `RunConfig.approved` takes them from the latest user message. `Host::approval` (`src-tauri/src/runs.rs`) runs a `shell_run` whose command is exactly one of those without asking. Anything else, including the same command with changes, asks as before. Sub-agents never inherit them, and in a session others can steer, the shared-session floor still applies. The Merge menu's `gh pr merge <n> --<method>` is approved the same way.

- **Delete branch on a merged card.** When the card reads "Merged into main" and the branch still has its copy on the remote, the card and the tray show a "Delete branch" button (outlined and neutral, not brand teal). It asks for exactly `git push <remote> --delete <branch>`, followed by `branch_status`. The local branch stays, as on GitHub, so the session keeps its branch and its card. Remote deletes count as `tools::destructive`, so this asks for approval even in a workspace that edits automatically.
- **Knowing it's gone.** `BranchStatus.upstream` (new, from `@{u}` in `workspace/git.rs`; mirrored in `lib/tauri.ts`) is the branch's remote-tracking ref. `git push --delete` drops that ref, so `@{u}` fails and the card reads "Merged into main · branch deleted" with no button. `branch_status`'s output also tells the model whether the branch tracks a remote.
- The step rail names a remote delete "Delete feat/x from origin" instead of "Push to origin", so the graph doesn't animate it as a push.

- **Merge opens a menu.** Clicking Merge on the card or the tray now opens three methods: "Create a merge commit", "Squash and merge" and "Rebase and merge". Each one says what it will do to this branch ("Combines the 2 commits into a single commit on main"). The method you picked last is ticked (`sush.merge-method` in localStorage).
- **Each choice asks for exactly one call.** The old button sent "Merge this branch into main." and left the model to work out how. In a test session a weaker model reasoned for about a minute about which way the merge went before it called `git_merge`, so the button looked broken. Now the prompt names the call: `gh pr merge <n> --squash` (or `--merge`, `--rebase`) for a pull request, or `git_merge` with `into: true` and `method` for a local branch.
- **`git_merge` lands by method** (`git::land` + `LandMethod` in `workspace/git.rs`). `fast-forward` is still the default. `merge` writes a merge commit with both parents. `squash` writes one commit whose message lists the branch's subjects. `rebase` replays the branch's commits onto the base and keeps each author and message; it fast-forwards when the base has nothing new, and it refuses a branch that contains merge commits. All of these are built with `merge-tree --write-tree` and `commit-tree`, so neither checkout is touched. Where the base is checked out, that checkout must be clean, and it fast-forwards to the new commit as before. A conflict stops the landing and points to `git_merge <base>`.
- The step rail shows the method's command (`git merge --squash  (on main)`).

### 2026-11-03 (the merge, shown on the card)
- **Git steps:** the card lists the turn's git work as a rail of steps, live: each `git_commit`, `git_merge`, and every `git`/`gh` command in a `shell_run` that changes something (`git push && gh pr merge` is two steps; `git log`, `gh pr view` and other reads are left out). Each step has its label ("Push to origin", "Merge the pull request into main", "Land on main"), the command, a running bar, "Waiting for you" while it asks for approval, how long it took, and its last line of output. Steps are read from the thread since the last user message, so they follow the turn from card to card (`useGitSteps` in `components/branch-card.tsx`).
- **Graph motion by phase:** a running push or `gh pr create` sends pulses up the branch's line into the merge node, which breathes teal. A running `gh pr merge` or `git_merge into` adds the base's line, and both run violet into the node. Once either succeeds, the merge edges draw themselves in solid violet, the node grows, and a wider ring ripples out. The merge row reads "Pushing, then merging into main", "Merging into main", "Merged into main".
- The card shows "Merged" as soon as the merge command succeeds, without waiting for GitHub's next poll.
- **Main's line:** the merge node now has both parents, like the merge commit it stands for. A dashed line runs from it to the base's tip (`BranchStatus.baseHead`, new in `workspace/git.rs` and `lib/tauri.ts`).
- **More sibling branches:** a sibling now counts if it left the base within its last 20 commits, not only at or after the split. The graph reaches back to the oldest such fork point. Fully merged branches are skipped (`SIBLING_REACH`).
- Each sibling gets its own lane colour (amber, sky, rose, green, orange, fuchsia), never the brand teal or the merged violet. 12 rows show before "Show more" (was 9).
- With reduced motion (the OS setting or Sush's own), the pulses and the breathing node are left out, and the running bar uses `data-ci-bar`, so it stops.

### 2026-11-03 (sibling branches in the graph)
- The card's commit graph drew only the branch and its base, so other branches cut from the same point (`fix/cart-total` beside `feat/shipping-label`) were invisible there while the Cowork graph panel showed them. `branch_status` now also logs every local branch that contains the split commit (`git branch --contains <split>`, up to 12), bounded by the same stops, so each one draws as its own lane forking off the base (`workspace/git.rs`).
- Those lanes and their branch chips are amber, the graph panel's second lane colour, instead of `teal-500`, which sat too close to the brand teal of the branch's own line (`components/branch-card.tsx`).
- The card's title fallback uses the head commit's subject, not the first commit off the base, which could now be a sibling's.
- The `branch_status` test adds a `side` branch and checks its commit is in the graph.

### 2026-11-03 (graph motion)
- The commit graph used to appear all at once. Now, when a card first shows, it grows from the base upward: each dot springs in, the line above it draws, and its row slides in, 90ms apart. After about 1.2s the delays drop to 0, so later changes move at once (`Graph` in `components/branch-card.tsx`).
- While checks run, the dashed line into the merge node flows up toward it (`ci-flow`, a dash offset loop in `index.css`). It stops when the checks settle.
- The ring that ripples out of the merge node used to show only for "ready" and "merged". It now also shows for "blocked" (coral) and "conflicts" (amber), and only after the entrance ends, so it marks where the verdict lands.
- With reduced motion, from either the OS setting or Sush's own preference, the entrance is skipped and the flow is listed under `prefers-reduced-motion`.

### 2026-11-03 (fixes from the second test recording)
- Before `gh` answered, the card and the tray said "Ready to merge" and showed an active Merge button, even though the branch's PR had a failing unit check. `verdict` now takes `ciPending` (the pipeline is still `null`). A branch that would otherwise be ready reads "Reading checks", with no action, until GitHub answers (`components/branch-card.tsx`).
- That hold showed a second bug: the card could sit on "Reading checks" for a long time. `usePrPipeline` skipped every poll while `document.hidden`, the first read included, and macOS reports a Sush window covered by another window as hidden. The first read now always runs, and a `visibilitychange` listener reads again as soon as the window is visible, instead of at the next 30s tick (`lib/workspaces.ts`).
- The model said the PR "merges cleanly" while the card above showed "blocked". It also pushed before finding that the PR already existed. `branch_status` now adds GitHub's view to its output (`ci::Pipeline::summary`): whether a PR exists, its state and URL, whether GitHub's head matches the local one, each CI check's status, and a line saying that a failing check blocks merging (`workspace/ci.rs`, `workspace/tools.rs`). The system prompt tells the model to call `branch_status` before pushing or opening a PR, not to repeat either, and to report a failed check plainly.
- "Thought for 1 seconds" now reads "1 second" (`components/ai-elements/reasoning.tsx`).
- The composer stops cycling its starter placeholders ("Summarize this document…") once a conversation has messages, and shows "Reply, or ask something else…" instead. That includes while an approval card waits (`components/composer.tsx`).

### 2026-11-03 (one pipeline on screen)
- The card and the tray both opened to the same pipeline. The tray also covered an approval card the run was waiting on.
- A failure now opens the tray only when the card is out of view (an `IntersectionObserver` on the card); otherwise the tray stays one line, and the card shows the details. You can still open the tray by hand.
- The tray closes while the run waits for the user (`needs-input`).

### 2026-11-03 (fixes from the first test recording)
- "Reading the log" never finished:
  - `gh run view --log-failed` only has logs once the whole run ends, so a check that failed while others still ran never got its excerpt, and the UI never asked again.
  - `ci::failure` now reads the jobs API first (`repos/{owner}/{repo}/actions/jobs/<id>/logs`), which has a job's log as soon as that job ends. It keeps `gh run view` as the fallback.
  - The full log is cut at the step's `##[error]Process completed` line, and the runner's `##[…]` lines are dropped.
  - `useCheckFailure` retries every 5s for about 2 minutes, then shows "Couldn't read the log" with a GitHub link (`lib/workspaces.ts`).
- Running bars always filled the track, because the timeline's length was the time so far. While checks run, it now reaches to a round ceiling ahead of them (30s, 1m, 90s, 2m…), so bars visibly grow. Once all checks settle, it shrinks to the run's real length. The header shows the real elapsed time.
- Rows jumped between polls because `gh` lists checks in no fixed order. They are now sorted by start time (queued last), then name.
- The mascot, which stands on the composer's top edge, covered the tray's right side. The tray now publishes its height as `--tray-lift` on the shared parent, and the mascot's `bottom` follows it, so Sushi stands on the tray (`composer.tsx`, `chat-view.tsx`).

### 2026-11-03 (fix)
- The card's bottom (the Merge button) was cut off, and this predates the pipeline work. `AutoHeight` measured its content with `offsetHeight`, but the commit graph's top margin (`mt-2.5`) leaked through the measuring div, so the animated height came out 10px short. The div is now `flow-root`, so the margin stays inside and is counted (`components/branch-card.tsx`).

### 2026-11-03 (later)
- The failure parser reads bun's output, checked against Plinth's real logs:
  - the test name that follows the error (`(fail) suite > test [ms]`)
  - array and object diffs (`-`/`+` lines, taken only after an assertion)
  - values from the first failure only
- Hosted-runner paths (`/home/runner/work/<repo>/<repo>/`) are made relative to the repo, so the location opens in Cowork.
- The `bun --filter` line prefix (`desktop test: `) is stripped.
- Stack lines count only after an assertion, so warnings that print stacks don't win (`workspace/ci.rs`).
- Colour codes are stripped from the log, since vitest and jest colour their output on CI and `--log-failed` keeps the codes.
- Test titles leave out the file, Playwright's `3 [chromium]`, and the time it took. Checked against vitest 3's real output.

### 2026-11-03
- New `workspace::ci` reads the branch's pull request and its CI checks through the user's `gh` (`gh pr view`, `gh pr checks --json`), with each check's start and end time and its Actions job (`crates/sush-core/src/workspace/ci.rs`).
- `ci::failure` reads a failed job's log (`gh run view --job <id> --log-failed`) and picks out the test, `file:line`, and Expected/Received (vitest, jest, Playwright) or `left`/`right` (cargo). If it finds none of those, it keeps the last 12 lines instead. Results are cached per job. Unit tests cover the parsers.
- New Tauri commands: `workspace_pr_checks` and `workspace_check_failure`. Branch-status base resolution moved into `branch_status_at` so guests reuse it (`apps/desktop/src-tauri/src/workspaces.rs`).
- New shared-session intents: `branch-status`, `pr-checks` and `check-failure`. They are read-only, allowed for every role in a Cowork share, and the failure text is passed through `redact::scrub` (`share/mod.rs`, `share/policy.rs`, `src-tauri/src/share.rs`).
- `branchSource` lets the card read from either the owner's workspace or a shared session's host. Three hooks use it:
  - `useBranchStatus` takes a source.
  - `usePrPipeline` polls every 4s while checks run and every 30s otherwise, and stops when the PR is merged or closed. The card and the tray share one `gh` read.
  - `useCheckFailure` reads why a check failed.
  All three are in `lib/workspaces.ts`.
- The branch card's check chips became a `Pipeline` (`components/branch-card.tsx`):
  - Each row shows a glyph, the name (linking to the CI page), a bar placed by start time and sized by duration against the whole run, and the duration.
  - A failed row opens to the failure, with a link that opens the file at the line.
  - CI checks override model-reported checks with the same name.
  - Checks for a commit that isn't the branch head are dimmed.
- `BranchChip` became `BranchTray`, docked under the composer's top edge:
  - Header: the PR number, a status that swaps in place (`Checks 3/5`, `e2e failed`, `All checks passed`, `Merging`, `Merged into main`), the +/− diff, a chevron, and the next action.
  - It opens by itself on a failure and folds away when the PR merges.
- Fix's prompt now carries the failure: the test, its location, and what it expected against what it got.
- While the run carries out an action, the button and status show what it is doing (`Fixing e2e`, `Merging`).
- Guests now see the card and the tray. `branchCall` is chosen for any Cowork session, including shared ones. Action buttons show only when `Watching.canSend` is true (`chat-view.tsx`, `lib/share.ts`).
- Sush colours (`index.css`):
  - Running bars are `--brand` with a moving highlight (`ci-run`).
  - Passed bars are `--brand` at 55%.
  - Failures use the new `--coral` token, the logo coral, which stays the same whatever accent is chosen.
  - When the last check passes, one sweep runs across all the bars (`ci-sweep`).
  - The graph dots and the PR badge follow the same tokens.
- `PixelLoader` exports the loading grid on its own, for running rows and statuses (`components/ui/loading-state.tsx`).
- The run stamps each `step-start` part with `at`, and each tool result with `callProviderMetadata.sush.endedAt` (`agent/run.rs`). Activity groups use these:
  - The collapsed line reads "Worked for 5s · read 3 files…".
  - Expanded, the steps sit on a dashed rail, ending in a brand check (`components/activity-group.tsx`).
- The system prompt tells the model the card follows GitHub checks by itself, so it should only pass checks it runs (`workspace/tools.rs`).

## Why

The card already showed whatever checks the model passed to `branch_status`, but it had no timing and no detail. Asking the model to keep polling CI and re-calling the tool would cost tokens and still lag behind. Reading GitHub directly puts the real state on screen and frees the model for the fix itself. We use `gh`, not a new API client, because it is what Sush already tells the model to prefer. It reuses the user's existing sign-in, and no token passes through the webview or the keyring. Without `gh`, the card falls back to what the model reports.

The failure excerpt exists so that Fix sends a precise task ("expected /checkout, received /sign-in…") instead of "fix the failing e2e". It is also what a person looks for first in a log. The parser recognises a few common runner formats and otherwise shows the log tail, so it never invents a reason.

Shared sessions run every read on the host, because guests have no folder and no `gh`. The new intents mirror `git-log`: they are reads with no file contents, and the log excerpt is scrubbed the same way tool output is. Guests previously never saw the PR card at all; now they do.

A Merge button must never appear on a branch whose CI is red. Until `gh` answers, the card can't know, so it waits. The cost is a moment of "Reading checks" on branches without CI, which then settle to "Ready to merge" once `gh` reports there is no pipeline. The model gets the same GitHub facts as the card, because otherwise the card and the reply contradict each other. That costs one blocking `gh` call per `branch_status` (on a worker thread). If `gh` is missing, the output says so and nothing else changes.

The tray brings the status into the user's line of sight while they type, and opening it shows the pipeline without scrolling back up the transcript. Colours follow the brand: teal for progress and success, the logo coral for failure. Coral is a fixed token, so a failure looks like a failure whatever accent the user picked.

Sibling branches belong on the card because a merge is a decision about the base, and the work landing beside yours is part of that picture: two fixes cut from the same commit are about to race into `main`. Only branches that contain the split commit are drawn, so the graph stays connected and never fills with old unrelated branches. The cap of 12 and the shared 40-commit limit keep a busy repo from crowding out the branch's own commits.

Merging is the moment the card exists for, and until now it changed in one jump: a spinner, then a violet colour some seconds after GitHub's poll. The model's git commands were only in the transcript, in collapsed tool rows above or below the card. Putting them on the card, and tying the graph's motion to which one is running, shows where the work is at each step: on your machine, on its way to origin, merging, merged. Every state comes from tool calls the run really makes, so the motion never claims progress that isn't happening. The trade-off: a chained shell line can't say which of its commands is running, so its steps share the call's state.

## What makes it stand out

- During a merge the card shows the git commands themselves (label, command, duration, last output line, approval wait), and the graph moves with them: pulses up the branch while it pushes, both parents flowing into the merge node while it merges, the merge edges drawing in once it lands.
- The graph shows the local branches forked beside this one, each in its own lane, so the card shows what else is about to land on the base, not only this branch against it.
- The checks come from GitHub, not from the model: start offsets and durations are real, and running bars grow live every second. A simple status list or the model's own report has neither.
- A failure shows what went wrong (test, `file:line`, Expected against Received) right in the row, with the file opening at the line in Cowork's viewer. Fix sends the same detail to the agent.
- The card and the model read the same GitHub state. The model's tool result carries the PR and each check, so its reply can't call a blocked PR clean, and it won't push or open a PR that already exists.
- Checks are tied to a commit: when the local head isn't what CI ran on, the pipeline dims, so a stale green never reads as current.
- The same card works for guests in a live share, read on the host, with the log scrubbed. Buttons appear only to guests whose messages reach the run (driver or collaborator).
- Motion respects both the OS setting and Sush's own reduced-motion preference: the `ci-run` and `ci-sweep` keyframes are listed in `prefers-reduced-motion` and caught by `[data-motion="reduced"]`.
- Polling is light: only while the PR is open, shared between the card and the tray, paused while the window is hidden, and stopped once merged or closed.

### Why merge methods are a menu, and why the model only relays them

GitHub puts the method choice on the merge button itself, and that is where people expect it. A separate setting is easy to forget, and a dialog adds a step. The work itself still goes through the run, not a direct command. That keeps approvals, checkpoints, shared-session policy and the step rail the same for every merge. The cost was the model having to interpret the request, so each prompt now names the exact call and its arguments. Squashing is the one method where git can't tell afterwards that the branch landed: its commits still count as ahead of the base. The tool's output says so, and within the turn the card already shows "Merged" from the step that succeeded.

### Why Delete branch removes the local branch too

At first it matched GitHub's button and removed only the remote copy. In a desktop app the local branch is the one you see, in the branch chip and the graph, so a "deleted" branch that is still listed reads as a failure. `gh pr merge --delete-branch` already deletes both and switches to the default branch, so this follows that precedent. The card follows HEAD onto the base, but it still says "Merged · branch deleted", because the pull request (from the model's `branch_status` call and gh) is still merged.
