# Session Status Indicators — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12 (badges)
- Moved the dot into `components/cowork-status-dot.tsx`: `StatusDot` (the dot alone; its size and position come from `className`) and `CoworkStatusBadge`, which reads `useCoworkStatus()` and puts the dot on the top-right corner of an icon button.
- The Cowork button of the Chat / Cowork toggle in the sidebar's title bar shows a 6px badge (`apps/desktop/src/components/app-sidebar.tsx`).
- When the sidebar is hidden, the title bar's sidebar toggle shows the badge, with a background-colored ring that separates it from the icon. `NavControls` takes a `coworkStatus` prop that only `App.tsx` sets, so the toggle inside the open sidebar has no badge (`apps/desktop/src/components/nav-controls.tsx`, `apps/desktop/src/App.tsx`).

### 2026-10-12
- Added `useCoworkStatus()`, which combines the run status of every Cowork session (a conversation with a `workspaceId`) into one value: `needs-input` if any session is waiting on the user, otherwise `working` if any is streaming or submitted, otherwise `null` (`apps/desktop/src/lib/sessions.ts`).
- Added `StatusDot` to the sidebar's Cowork item. It is a brand-colored dot with a pulsing halo while a session works and a solid dot while one waits for the user. The dropdown chevron moves over so the dot sits right-aligned in its place (`apps/desktop/src/components/app-sidebar.tsx`).

## Why

Cowork runs can take minutes and keep going in Rust whatever is on screen. Each session row already shows a spinner or a "waiting" dot, but the row can be scrolled away, hidden behind "More", or filtered out by search. The Cowork item is always visible at the top of the sidebar, so it is a dependable place to show that something is still running.

The Cowork item is no help once the sidebar is hidden, so the badge moves to the button that opens it. That button is the only way back into the sidebar, so the badge sits where the user will click next. The mode toggle gets its own badge because it is the control for switching to Cowork, and the badge shows that there is something to switch to.

`needs-input` wins over `working` because a session waiting on an approval makes no progress until the user acts, so that is the state worth showing. The solid dot is the same mark session rows use for "waiting for you", so the two read as the same signal.

The hook returns a primitive string from `useSyncExternalStore` and subscribes to both the run views and the conversation list, so it re-renders only when the combined status changes, including when a conversation's workspace is set or cleared.

## What makes it stand out

- One combined signal for every Cowork session, not one indicator per session, so the sidebar stays quiet when several runs are active.
- The indicator follows the sidebar: it's on the Cowork item and the mode toggle while the sidebar is open, and on the expand button while it is hidden, so it is always on screen.
- Two distinct states (pulsing vs. solid) that match the existing per-row "waiting for you" dot.
- The pulse uses `motion-safe:animate-ping`, so with reduced motion it shows only the static dot.
- `role="status"` with an `aria-label` that names the state, so screen readers say what the dot means.
- Only uses state the app already has (`views` and `getConversations()`): no new Rust command and no polling.
