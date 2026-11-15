# Board — Design Notes

Last updated: 2026-11-16

## What changed

### 2026-11-16
- Dragging a card no longer selects text on the board. While a drag lasts, a `selectstart` listener on `document` cancels any new selection, and `body` gets `-webkit-user-select: none` as well as the unprefixed `user-select: none`. Both are removed when the drag ends, is cancelled, or is escaped (`src/components/board-page.tsx`, `startDrag`).
- When the pointer passes the 5px drag threshold, any selection that started before it is cleared (`window.getSelection()?.removeAllRanges()`).

## Why

Cards are dragged with pointer events rather than HTML5 drag and drop, because Tauri takes HTML5 drag and drop on Windows. Pointer events keep the browser's default text selection, so the board already set `user-select: none` on `body` during a drag. On macOS the app runs in WKWebView, which ignores the unprefixed property. As a result, a drag across columns highlighted the column titles ("IN PROGRESS", "NEEDS ATTENTION") it passed over. Cancelling `selectstart` stops selection in every engine. The prefixed style keeps the cursor from showing a text caret. The trade-off: text cannot be selected anywhere in the window during a drag, which is not something a drag needs.

## What makes it stand out

- Drag start is still a plain `pointerdown`, with no `preventDefault`, so clicking a card still focuses and opens it. Calling `preventDefault` on `pointerdown` is the common fix, but it would also stop focus.
- The selection lock covers only the drag. Every listener and style goes through the same `stop()` cleanup, which also runs when the board unmounts.
- Selection that started in the first 5px, before the drag counts as one, is cleared once, so no leftover highlight remains when the drop happens.
