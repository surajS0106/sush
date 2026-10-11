# Transcript Markdown — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12
- GFM task lists (`- [ ]` / `- [x]`) in assistant replies and reasoning now render as drawn checkboxes instead of the webview's native disabled checkbox (`apps/desktop/src/index.css:250-285`).
- Task lists drop the list bullet (`.contains-task-list[data-streamdown]`), so each item shows only its box.
- The box is absolutely positioned in a `1.5em` hanging indent on the `li`, vertically centred on the first line with `calc((1lh - 0.875em) / 2)`, so wrapped lines align with the text rather than under the box.
- Unchecked: transparent box with a muted border. Checked: filled with `--primary` and a check mark drawn in `--primary-foreground` with a rotated `::after` border.

## Why

Streamdown 2.7 has no task-list component; it passes through remark-gfm's bare `<input type="checkbox" disabled>`. The webview drew that as a greyed native control next to a bullet, so items showed two markers and the box looked broken, especially in dark mode. Styling it in CSS keeps Streamdown's renderer untouched and applies everywhere Streamdown is used. The trade-off is that a task list nested under a regular list item loses Streamdown's `[li_&]:pl-6` indent, since the task list's padding is reset; the parent item's hanging indent still separates it.

## What makes it stand out

- Selectors key off the `data-streamdown` attribute Streamdown already puts on `ul`/`li`, so they apply to every Streamdown render and nothing else in the app.
- The box size and offsets are in `em`/`lh`, so it scales with the transcript text-size and font settings (`--transcript-text`, `data-chat-font`).
- Colours come from theme tokens (`--primary`, `--primary-foreground`, `--muted-foreground`), so it follows the accent picker and light/dark themes.
- Hanging indent matches how other transcript lists hang text off their marker.
- The checkbox stays a disabled `<input>`, so screen readers still announce checked state.
