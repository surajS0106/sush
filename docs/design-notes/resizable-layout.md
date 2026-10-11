# Resizable Layout — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12 (instant drag)
- A drag now starts on pointer down (no 3px dead zone) and only calls `preview`, which writes the width straight to the DOM (`--sidebar-width` on the sidebar wrapper, the panel's inline width, `--transcript-width` on `<html>`). The store and localStorage are written once, on release (`apps/desktop/src/components/ui/resize-handle.tsx`).
- Restored the `html[data-resizing]` rule, now `transition: none`, and the transcript column handles, both of which commit d599e13 had left out (`apps/desktop/src/index.css`, `apps/desktop/src/components/chat-view.tsx`).
- The handle's hover line no longer fades in.

### 2026-10-12
- Added `ResizeHandle`, a vertical splitter with pointer drag, arrow-key resizing, Home/End to the limits, and double-click or Enter to reset (`apps/desktop/src/components/ui/resize-handle.tsx`).
- Added `lib/layout.ts`, a persisted store (`sush.layout`) for the sidebar width and the Cowork side panel width, with their limits (`SIDEBAR`, `PANEL`).
- The sidebar's right edge is now a `ResizeHandle` (208 to 480px, default 256px) in place of shadcn's `SidebarRail`. `App.tsx` feeds the width to `SidebarProvider` as `--sidebar-width` (`apps/desktop/src/components/app-sidebar.tsx`, `apps/desktop/src/App.tsx`).
- The Cowork side panel has a handle on its left edge. It keeps its old default (52% of the window, at most 960px) until dragged, and CSS always leaves the chat at least 360px (`apps/desktop/src/components/workspace-panel.tsx`).
- The transcript and composer column has handles on both edges. Dragging saves a new `"custom"` Transcript width with `customWidth` in px; `apply()` sets `--transcript-width` inline for it. Picking a preset in Settings clears it, and the setting's description shows the custom value (`apps/desktop/src/lib/appearance.ts`, `apps/desktop/src/components/chat-view.tsx`, `apps/desktop/src/components/settings-dialog.tsx`).
- `html[data-resizing]` pins the resize cursor, stops text selection and turns off transitions while a drag is on (`apps/desktop/src/index.css`).

## Why

Fixed widths suit one window size and one reader. People run Sush on laptops and wide monitors, read code in the Cowork panel next to the chat, and have their own preferred line length, so each of the three containers now follows the user's hand instead of a preset. Widths persist, because re-dragging a layout every launch is the kind of friction that makes the feature unused.

The transcript width already existed as a three-step preference. Rather than add a second, competing setting, a drag writes into that same preference as a fourth "custom" value, so Settings stays the single place that explains and resets it.

The sidebar rail used to toggle the sidebar on click. A handle that also collapses on a slightly-off click is easy to trigger by accident while trying to resize, so the click toggle was dropped; Cmd/Ctrl+B and the nav controls still toggle.

## What makes it stand out

- One handle component serves all three containers, including a centered column (`scale={2}` moves both edges at once), instead of a resizable-panels library that would force a rigid panel-group layout onto the existing shadcn sidebar and flex row.
- Keyboard and screen reader support: each handle is a focusable `role="separator"` with `aria-orientation`, `aria-valuemin/max/now`, arrow keys (Shift for bigger steps), Home/End and Enter to reset. The stock shadcn rail is `tabIndex={-1}` and click-only.
- Pointer capture and a global `data-resizing` flag keep drags smooth: no text gets selected, the cursor does not flicker over other elements, and the sidebar's 200ms width transition does not lag behind the pointer.
- Limits are layout-aware: the side panel's maximum is computed from its parent at drag time and backed by a CSS `max-width`, so shrinking the window never pushes the chat below 360px.
- Double-click on any handle restores that container's default, so experimenting is cheap.
- Dragging costs no React renders: the whole app no longer re-renders per pointer move (the sidebar width is read in `App`), so panes keep up with the pointer even in long chats.
