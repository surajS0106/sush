# Transcript Markdown — Design Notes

Last updated: 2026-11-18

## What changed

### 2026-11-18 (app link schemes survive sanitizing)
- `MessageResponse` passes its own `rehypePlugins`: Streamdown's defaults (`raw`, `sanitize`, `harden`) in the same order, with the sanitize schema's `protocols.href` extended by `sushsrc` and `yammer` (`APP_LINK_SCHEMES` in `apps/desktop/src/components/ai-elements/message.tsx`).
- Binder citations (`[cite](sushsrc:<source>/<chunk>?q=…)`) reach `citationComponents` with their href again and render as numbered chips, in chat answers and in Binder notes (`NoteBody`). Yammer meeting links (`yammer://meeting/<id>`) are kept the same way.

### 2026-10-12
- GFM task lists (`- [ ]` / `- [x]`) in assistant replies and reasoning now render as drawn checkboxes instead of the webview's native disabled checkbox (`apps/desktop/src/index.css:250-285`).
- Task lists drop the list bullet (`.contains-task-list[data-streamdown]`), so each item shows only its box.
- The box is absolutely positioned in a `1.5em` hanging indent on the `li`, vertically centred on the first line with `calc((1lh - 0.875em) / 2)`, so wrapped lines align with the text rather than under the box.
- Unchecked: transparent box with a muted border. Checked: filled with `--primary` and a check mark drawn in `--primary-foreground` with a rotated `::after` border.

## Why

Streamdown 2.7 runs rehype-sanitize with GitHub's schema plus `tel` and `streamdown`, which deletes any other href. rehype-harden runs next and treats an `<a>` with no href as unsafe, replacing it with the text plus " [blocked]". So every `sushsrc:` citation arrived as "cite [blocked]" before the citation components could see it, though harden itself is configured to allow any protocol. Extending the schema by name, instead of dropping sanitize or allowing every scheme, keeps the protection for `javascript:` and unknown schemes in model output; the citation components decide what a click on an app link does.

Streamdown 2.7 has no task-list component; it passes through remark-gfm's bare `<input type="checkbox" disabled>`. The webview drew that as a greyed native control next to a bullet, so items showed two markers and the box looked broken, especially in dark mode. Styling it in CSS keeps Streamdown's renderer untouched and applies everywhere Streamdown is used. The trade-off is that a task list nested under a regular list item loses Streamdown's `[li_&]:pl-6` indent, since the task list's padding is reset; the parent item's hanging indent still separates it.

## What makes it stand out

- App schemes are an explicit two-item allowlist on top of Streamdown's own schema, read from `defaultRehypePlugins` at load, so a Streamdown upgrade's schema changes still apply.
- Selectors key off the `data-streamdown` attribute Streamdown already puts on `ul`/`li`, so they apply to every Streamdown render and nothing else in the app.
- The box size and offsets are in `em`/`lh`, so it scales with the transcript text-size and font settings (`--transcript-text`, `data-chat-font`).
- Colours come from theme tokens (`--primary`, `--primary-foreground`, `--muted-foreground`), so it follows the accent picker and light/dark themes.
- Hanging indent matches how other transcript lists hang text off their marker.
- The checkbox stays a disabled `<input>`, so screen readers still announce checked state.
