# Thinking Block — Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04
- Auto-open runs only when streaming starts (the false-to-true transition, tracked in `wasStreamingRef`), not on every render while streaming (`apps/desktop/src/components/ai-elements/reasoning.tsx`).
- Opening or closing the block by hand sets `userToggledRef`; from then on neither auto-open nor the auto-close after streaming touches it (`reasoning.tsx`, `handleOpenChange`).
- While streaming, `ReasoningContent` shows the thought in a `max-h-36` window that stays pinned to the newest line (`useLayoutEffect` sets `scrollTop` to `scrollHeight` as text arrives), with a mask fading the top 2rem. Once streaming ends the cap is removed and the full text shows.

## Why

The chevron did nothing while the model was thinking. The auto-open effect depended on `isOpen`, so closing the block re-ran it and it opened again in the same frame. Auto-open is meant to happen once, when the thought starts. After that the user's choice wins, and that includes the auto-close: a block the user opened on purpose should not close itself a second after the thought ends.

The block also jumped while the model thought. Each token made the thought taller, which pushed everything below it down while the transcript's stick-to-bottom scroll tried to keep up. A fixed-height window that shows the latest lines keeps the transcript's layout steady during streaming. The trade-off is that the earlier lines are hidden until the thought finishes. The user can still collapse the block, and the full text is there afterwards.

## What makes it stand out

- The stock AI Elements `Reasoning` re-opens on every render while streaming, so it cannot be collapsed mid-thought. This one can, and it stays collapsed.
- A manual toggle turns off both auto-open and auto-close, so the block never opens or closes against what the user last chose.
- Streaming height is capped at 9rem and pinned to the tail, so the transcript moves by at most that much while the model thinks, not by one line per token.
- The cap applies only while streaming. A finished thought shows its full text with no inner scroll area.
