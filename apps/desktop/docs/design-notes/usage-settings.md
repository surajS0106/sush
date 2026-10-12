# Usage Settings — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12 (budgets)
- New `src/lib/budget.ts`: a budget preference (`sush.budget` in localStorage) with a unit (spend in USD or tokens), a limit, a period (daily, weekly, monthly; weeks start Monday, periods start at local midnight), alert thresholds (choices 25/50/75/80/90/100%, default 50/80/100), a notifications switch and "Pause at limit".
- `budgetStatus` tallies the current period with `summarizeUsage` and reports used, fraction, reset time, the highest threshold reached and a straight-line projection (only after 10% of the period has passed).
- `watchBudget` (started in `src/App.tsx`) re-checks 1.5s after conversations settle and shows one toast for the highest newly crossed threshold, with a "View usage" action. Crossed thresholds are remembered per period, unit and limit (`sush.budget.alerted`), so each alerts once.
- `budgetBlock` in `start` (`src/lib/sessions.ts`) refuses new sends and regenerations past the limit when "Pause at limit" is on, showing the reason as the run error. Answering a waiting tool call still works, and a spend budget never blocks a local model.
- The Usage page now opens with a Budget section: a meter where the limit is the full bar width, ticks and labels at each alert threshold, color moving from accent to amber to red, amount left, reset date and projected total. Below it, a recommendation card (reached, on pace to go over with the estimated date, or threshold reached) with a "Raise limit" button that focuses the limit field. With no budget, a card offers "Set a budget".
- A "Budget settings" group at the bottom of the page holds the controls. The limit field accepts "20", "$20", "2.5M" or "500k" (`parseLimit`) and saves on blur or Enter.
- `summarizeUsage` now takes a start time (`rangeStart` converts the page's period control), so the page and the budget share it.

### 2026-10-12
- New Settings > Usage page (`src/components/usage-section.tsx`), listed after Providers in the settings nav with search keywords for tokens, cost and billing (`src/components/settings-dialog.tsx`, `"usage"` added to `SettingsSection` in `src/lib/library.ts`).
- Layout follows macOS System Settings > Storage: a summary card with total tokens and estimated spend, one stacked bar split by model (top five models get their own color, the rest share "Other"), a legend with colored dots, then grouped rows. The first group has one row per model (logo tile, tokens, cost, info button); the second splits usage into Chats and Cowork.
- Each row's info button opens a hover card with exact input and output tokens, reply count, chat count and the model's price per million tokens (or "Free (local)" / "Unknown").
- A 7 days / 30 days / All time period control (`Segmented`) filters the tally; it defaults to 30 days.
- New `summarizeUsage` in `src/lib/usage.ts` tallies assistant replies from the in-memory conversation store: per model, per kind (chat or Cowork), and overall, keeping tokens from unpriced models apart (`unpricedTokens`) instead of guessing a price.
- `src/lib/pricing.ts` gained `costUsd` (number, 0 for local, undefined when unknown) and `formatUsd`; `formatCost` under each reply now uses them, so both places compute cost the same way.
- Core fix: `StepBuilder::after` (`crates/sush-core/src/agent/ui.rs`) seeds each step with the token counts already on the message, so a multi-step reply (tool calls) records the sum of every step instead of only the last. `run.rs` calls it when building each step. Test: `usage_adds_up_across_steps`.
- New assistant replies carry `metadata.createdAt` (ms), stamped in `crates/sush-core/src/agent/run.rs`; `SushMetadata.createdAt` added in `src/lib/transport.ts`.

## Why

Token counts and cost were only visible one reply at a time, on hover. There was no way to see how much a week of work cost or which model accounted for it. The Storage page layout fits the question well: one bar answers "where did it go" at a glance, and the rows below give the numbers.

The bar is sized by tokens, not dollars. Tokens exist for every reply, including local models and models with no known price, so the bar never hides usage. Spend is shown as a number next to it and per row.

While building the page it turned out each step of a tool-using reply overwrote the previous step's usage, so a ten-step Cowork turn reported one step's tokens. Every step is billed, so the totals were too low, both here and under each reply. The fix lives in core so the stored data is right, rather than patching the UI.

Period filtering needs a time per reply; messages had none. New replies record when they started. Older replies fall back to their chat's last activity, which is approximate for long chats. The trade-off was accepted over leaving old usage out entirely.

Budgets answer the follow-up question: not just what was spent, but whether that is too much. The meter treats the limit as capacity, the way the Storage bar treats disk size, so how full it is reads at a glance. Alerts are toasts rather than OS notifications because they only matter while the app is open, when the spending happens. Blocking is opt-in and only stops new requests: cutting off a turn halfway through a tool call would leave a Cowork change half done. Budgets are a local preference, not stored in core, since usage is already derivable from the chats.

## What makes it stand out

- Counts come from data already saved on each reply; no separate usage log that could drift from the chats.
- Unknown prices are never guessed: those models show "—", are left out of the dollar total, and the total gets a "+" suffix when it is a lower bound.
- Local providers (localhost base URLs) count as free, using the same `isLocalUrl` check as the per-reply footer.
- Multi-step replies are counted in full, which also corrects the per-reply cost shown in the transcript.
- Bar segments have tooltips with share percentages; info buttons are focusable buttons with labels, so the details are reachable by keyboard.
- The budget meter is a labelled `role="meter"` with a text value; threshold chips are `aria-pressed` toggles.
- Alerts fire once per threshold per period and limit; a reply that jumps several thresholds produces one toast, not a stack.
- The "on pace" warning gives a date, computed from the pace so far, instead of a percentage.

Limits: a spend budget leaves out models without a known price (the meter says how many tokens); deleted chats stop counting; one-shot calls (titles, memory revisions) and stopped steps are not recorded.
