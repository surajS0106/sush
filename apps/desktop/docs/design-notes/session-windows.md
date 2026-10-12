# Session Windows (Tab Tear-off) — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12
- Drag choreography (`src/components/session-tabs.tsx`). While docked, the tab moves along x and gives up to 6px vertically with exponential resistance. At 28px out of the strip (or outside the window), it pops out: its slot shrinks to 0 and the neighbours slide over. On release the slot stays closed until the move is known (`tab_drop`); it reopens only if the tab stayed. An earlier version docked the tab back on release, then removed it once the new window opened. The next tab jumped back 224px and then slid forward again; a WebKit trace of a reproduction showed this. At the same moment, a floating preview springs from the tab's position to the pointer. The preview is the tab itself (icon and title, 208px), lifted with a shadow. It leans up to 4 degrees with horizontal velocity. Coming back within 14px docks the tab again; the gap between 28 and 14 keeps it from flickering at the edge. Letting go while it is out moves it to another window, and the preview fades. New and closed tabs grow and shrink in place.
- Dragging back into another window. While a torn-off tab is outside its window, the source calls `tab_hover`, one call in flight at a time. Rust finds the strip under the cursor and sends that window `sush://tab-hover`; the window it leaves gets `null`. The target opens an outlined slot where the tab would land (`LandingSlot`); the slot positions are measured once, so the slot can't push tabs back and forth. The source preview fades out while another window shows the slot. On drop, the tab takes the slot in the same render and mounts at full size (`arrived`). A 120ms delay on "left" keeps the slot from closing and reopening between the leave and attach events. The drop waits for the last hover call, so a late call can't reopen a slot (`windows.rs`, `session-tabs.tsx` `useLanding`).
- Pressing a tab no longer starts a text selection, and `user-select` is off for the page while dragging. Before, the drag highlighted text across the window.
- The strip has 8px of vertical padding with a matching negative margin, so the give and the drag shadow are not clipped by its horizontal scroll container.
- New `tab_drop` command. It reads the OS cursor position. If the cursor is over another window's title bar (the top 64 CSS px), it sends that window `sush://attach-tab` with the drop x and focuses it. Otherwise it opens a new `session-*` window the size of the source window, with the tab under the cursor. If the tab was the window's only one and was not dropped on another window, nothing happens (`src-tauri/src/windows.rs`).
- The receiving window inserts the tab before the first tab whose midpoint is right of the drop point. A window whose last tab moves away closes (`useTabs` `detach` and the `onAttachTab` effect in `session-tabs.tsx`).
- A new window learns its session from an initialization script (`window.__SUSH_OPEN_SESSION__`) and starts with that one tab. Only the `main` window's tab strip is saved to localStorage (`src/lib/windows.ts`, `session-tabs.tsx`).
- Incognito tabs cannot be torn off.
- Run frames: `runs_subscribe` keeps one channel per window label instead of a single channel. Every frame goes to every window; `client-tool` frames go only to the leader, the first label in sort order (`main` while it is open). When the leader closes, unanswered tool requests are re-sent to the next window, and `sush://leader` is announced (`src-tauri/src/runs.rs`).
- Store sync: conversation create, rename, pin, project, workspace, fork and delete are broadcast to the other windows (`sush://conversation`). Memory and the workspace list send a reload signal (`sush://memory`, `sush://workspaces`). Persisted `createStore`s follow other windows' writes through the `storage` event, unless created with `follow = false` (`src/lib/store.ts`, `memory.ts`, `workspaces.ts`).
- `saveForAnotherWindow` writes an untouched chat to disk and announces it before `tab_drop`, so the new window can load it.
- Automations' scheduler starts only in the leader window (`whenLeader` in `App.tsx`).
- Built-in browser: page events go to every window, and `reveal` only to the window hosting the browser. `browser_set_view` moves (reparents) the webview into the window whose pane is showing. Focusing a window re-reports its pane. Before a window closes, the webview is moved to another window (`src-tauri/src/browser.rs`, `workspace-panel.tsx`).
- Capability `default` now covers `main` and `session-*` windows (`src-tauri/capabilities/default.json`).

## Why

People work on several sessions side by side, and the tab strip already behaves like a browser's. Tearing a tab off and dropping it back is the gesture they already know from Chrome. The trade-off is that the window opens on drop rather than following the cursor live during the drag. A live-following window needs the OS to hand an in-progress drag from one window to another, which webviews do not expose.

Each webview keeps its own in-memory copy of the store for synchronous reads. A second window therefore had to be kept in step explicitly. Rust already owned the run frames, so the single channel became one channel per window. UI-owned tools such as `memory_write` and automations must run exactly once, so one window leads. That window is `main`, falling back to the next window when `main` closes.

Cowork panel visibility stays per window. If it followed every window, opening the browser pane in one window would open it everywhere, and the single native browser webview would jump between windows.

## What makes it stand out

- Where a dropped tab lands is decided in Rust from the OS cursor position. The JS drag never has to convert screen coordinates across monitors with different scale factors or app zoom levels.
- The tab visibly leaves the strip before anything happens: resistance, then a pop-out into a lifted copy of the tab. The user sees what letting go will do. Hysteresis stops it flickering at the threshold.
- Dropping onto another window keeps the drop position: the tab is inserted between the tabs where it was released, not appended.
- Runs keep streaming through a move: every window follows every thread, so a tab moved mid-response continues in the new window without resubscribing.
- Tool calls and automations run exactly once, even with several windows open, and still run if the main window is closed.
- The one native browser webview follows the user to whichever window they focus, instead of being stuck in `main`.
