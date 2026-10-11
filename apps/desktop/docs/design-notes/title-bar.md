# Title Bar — Design Notes

Last updated: 2026-10-11

## What changed

### 2026-10-11
- Removed the title bar's hamburger menu (`MoreMenu`). Its Theme options moved into a Theme submenu, and Customize moved into the sidebar footer's account menu (`ProfileMenu`), which already had Settings (`src/components/app-sidebar.tsx`).
- Added `useTrafficLights()`, which is true on macOS unless the window is in full screen. It re-checks `isFullscreen()` on every resize, again 800ms after the last resize (once the full-screen animation settles), and on window focus (`src/components/window-controls.tsx`).
- The sidebar title bar and the main header now reserve the 80px (`pl-20`) traffic-light inset only when that hook is true, instead of whenever `IS_MAC` is true (`src/components/app-sidebar.tsx`, `src/App.tsx`).

## Why

The hamburger menu sat in the title bar next to navigation controls but held app preferences, and its Settings item repeated the account menu's. Moving it into the footer gives preferences one home and leaves the title bar with only window-level navigation. Changing the theme now takes one extra hover, into the submenu.

On macOS the window uses an overlay title bar, so the app leaves room on the left for the native traffic lights. In full screen, macOS hides them, but the inset stayed. The menu, sidebar toggle and back/forward buttons then sat 80px in from an empty edge and looked centered in the sidebar. Tying the inset to whether the lights are actually drawn keeps the buttons flush with the left edge in full screen. The trade-off is one `isFullscreen()` call per resize event, which is cheap.

## What makes it stand out

- The Theme submenu trigger shows the icon of the active theme, so the current setting is visible without opening it.

- A plain `IS_MAC` check leaves an empty gap in full screen; this follows the window's real full-screen state.
- One hook drives both title bars, so the sidebar and the collapsed-sidebar header always agree.
- It uses Tauri's resize event, which fires when entering and leaving full screen, so it needs no extra permissions beyond `core:default`.
