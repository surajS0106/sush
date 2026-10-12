# App Zoom — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12 (transcript jitter fix)
- The transcript no longer jitters at the bottom of a chat when the app is zoomed. `ConversationContent` installs `useScrollTopRoundsUp` on its scroll element: each `scrollTop` write that reads back short of the requested offset is retried up to two pixels further, so writes land at or past their target (`src/components/ai-elements/conversation.tsx`).

### 2026-10-12
- Ctrl/Cmd + `=` (or `+`) zooms the whole app in, Ctrl/Cmd + `-` zooms out, Ctrl/Cmd + `0` resets to 100% (`src/lib/zoom.ts`).
- Zoom steps through fixed levels from 50% to 200% and is applied with the webview's own `setZoom`; the level is saved in localStorage under `sush.zoom` and restored at startup (`initZoom` in `src/main.tsx`).
- The shortcut listener runs in the capture phase and calls `preventDefault`, so it works while focus is in the composer, the code editor or the terminal.
- The built-in browser's bounds are multiplied by the zoom factor before they go to Rust, and a `resize` event is dispatched after each zoom change so the pane re-measures (`src/components/workspace-panel.tsx`).
- Added the `core:webview:allow-set-webview-zoom` permission (`src-tauri/capabilities/default.json`).

## Why

People on large or high-density displays want to scale the whole interface, not only the transcript text that Settings → Appearance already controls. Using the webview's native zoom reflows every surface (sidebar, panels, dialogs) the way a browser does, instead of scaling individual font sizes. The trade-off is that native coordinates no longer equal CSS pixels, so the one surface placed in window coordinates, the native browser webview, has to account for the factor.

At a zoom other than 100%, WebKit stores scroll offsets in zoomed pixels, so setting `scrollTop` to a fractional value can read back a pixel lower (at 90%, writing 2611.7 read back 2610). `use-stick-to-bottom` moves toward the bottom in small spring steps and only stops once `scrollTop` reaches its target. When every step lands short, it never arrives and rewrites `scrollTop` on every animation frame for as long as the chat is open, which shows as the transcript shaking by a pixel. Rounding writes up keeps the library unchanged (no patch to `node_modules`) and only affects that one element. The trade-off is that a write can land up to two pixels past the requested offset, which is not visible.

## What makes it stand out

- Compared with Tauri's `zoomHotkeysEnabled` window option: the level persists across launches, the steps match common browser levels, and Cmd works on macOS alongside Ctrl.
- Compared with a CSS `zoom`/`transform` on the root: layout, hit testing and `getBoundingClientRect` stay consistent, and popovers and portals scale too.
- The native browser pane stays aligned with its host element at every zoom level.
- Ctrl/Cmd + 0 resets, matching browser convention.
- Stick-to-bottom chat scrolling settles and goes idle at every zoom level. Stock `use-stick-to-bottom` in WebKit loops forever at fractional zoom.
