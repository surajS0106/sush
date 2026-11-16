# Docs — Design Notes

Last updated: 2026-11-16

## What changed

### 2026-11-16 (undo)
- The doc editor handles Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z and Cmd/Ctrl+Y itself, in a capture listener on its root, and also the `historyUndo` / `historyRedo` input events the window's Edit menu sends, calling BlockNote's `undo` / `redo`. Text boxes inside the doc (a diagram's source) keep their own undo. Loading a doc's text is kept out of the undo history (`addToHistory: false`), so the first undo can't empty the page (`components/doc-editor.tsx`).
- Why: on macOS the app's Edit menu owns Cmd+Z and can run the webview's native undo instead of passing the key to the editor; the native undo knows nothing of ProseMirror's changes, so undo appeared to do nothing.

### 2026-11-16 (grip menu)
- The grip menu no longer has Move up / down / left / right; dragging the grip moves rows and columns, and the menu keeps Add, Delete and the header toggles.

### 2026-11-16 (drag rows and columns)
- Press and hold a table grip, drag, and let go to move its row or column there (`startDrag` in `components/doc-table-menu.tsx`). It runs on pointer events: past 4px a press becomes a drag, the handles freeze, a tinted ghost covers the row or column and a brand line marks the gap nearest the pointer; letting go reorders the table (`reorder`, one splice through `updateBlock`), Escape cancels. A plain click still opens the grip's menu, since BlockNote's menu opens on click and a drag swallows the click that ends it. BlockNote's own HTML drag on the grip is blocked so it can't cancel this one. The one-click arrows tried just before were removed: they cluttered the table's edge.
- Why: BlockNote's drag uses HTML drag and drop, which the app's webview doesn't deliver reliably, and the user expects to grab a row and put it somewhere, as in Notion.

### 2026-11-16 (move rows and columns)
- A table grip's menu can move its row up or down, or its column left or right (`components/doc-table-menu.tsx`, wired through `TableHandlesController` with `tableHandles={false}` on the view). The table is read fresh and its rows, cells and column widths swapped through `updateBlock`; the items are hidden on tables with merged cells. The menu keeps BlockNote's exported Add and Delete items and has header row / column toggles of its own; BlockNote's background-colour item isn't exported, so the grip menu no longer has it.
- Why: BlockNote moves rows and columns only by dragging, through HTML drag and drop, which the app's webview doesn't deliver reliably (Tauri takes it on Windows), so there was no way to reorder a table.

### 2026-11-16 (handles)
- Headings get a fixed line height (1.4) and a top padding worked out from BlockNote's hard-coded drag-handle offsets (39 / 27 / 18.5px for h1 / h2 / h3, set in its `SideMenuController`), so each heading's first line is centred on its handle. Smaller headings had left the handle about 9px low.
- Table row, column and cell grips are small bordered chips with their own background instead of bare dots on the cell borders, and the table has 14px more room on its left so its row grips sit clear of the block's drag handle (`index.css`).

### 2026-11-16 (byline)
- The line under the title is now two controls (`components/doc-byline.tsx`): the date, which opens a month calendar (Today, or back to the day it was started), and the authors as overlapping avatars (the user's account picture, `UserAvatar`; Sush as the picked mascot), which open a list of who wrote how many versions and when last. A new `Popover` primitive backs both (`components/ui/popover.tsx`).
- The picked date is stored on the doc (`Doc.date`, `YYYY-MM-DD`, set by `doc_set_date` and checked by `docs::set_date`) and used in web page exports. Setting it leaves `rev` alone: it's metadata, so an open editor isn't reloaded and the model isn't told the doc changed.

### 2026-11-16 (stylesheet fix)
- Removed a stray `}` after the docs `@media` rule in `index.css`, left by the type-scale rewrite; it made the browser drop the diagram rules that follow, so diagrams drew as unstyled text.

### 2026-11-16 (diagram resize loop)
- The arrows layer is sized by CSS (`inset: 0`, 100% by 100%) instead of from the stage's scroll size, the widget never scrolls vertically, and redraws are batched to a frame and skipped when the stage's size hasn't changed (`lib/diagram.ts`, `index.css`). Sizing the layer from `scrollWidth`/`scrollHeight` could toggle a scrollbar, resize the stage and redraw again, so the doc kept scrolling.

### 2026-11-16 (diagram block)
- Diagrams in the editor are now a block of Sush's own (`DiagramBlock`, `createReactBlockSpec`, in `components/doc-diagram-block.tsx`) with `source` and `lang` props, drawn by `lib/diagram.ts` (or Mermaid for ```mermaid). Hovering shows ⋯: Edit source (inline, the drawing updates as you type; Cmd/Ctrl+Enter saves, Esc cancels; double-click also opens it), Copy source, Delete diagram. Copied or exported, a diagram becomes its title and a list of its steps.
- `markdownToBlocks` / `blocksToMarkdown` (`lib/doc-schema.ts`) turn ```diagram and ```mermaid fences into diagram blocks and back, and hand the text between them to BlockNote, so the stored Markdown is unchanged. The editor, the block sushi, the toolbar and HTML export all go through them. Mermaid rendering moved to `lib/diagram.ts`.
- Why: the earlier version relied on the code block's `createPreview` option, which BlockNote 0.57 declares in its types but never calls, so diagrams showed as raw JSON in the editor. A block of our own doesn't depend on that hook and gives the widget its own menu and editing.

### 2026-11-16 (frameless panel)
- The doc panel has no frame: no border, rounded card or background, and no rules under its header or banners, so the page sits on Sush's own background like the chat beside it (`components/doc-panel.tsx`, `docs-page.tsx`). Ask Sush, in the bottom toolbar and the selection toolbar, shows the user's Sushi instead of a sparkle (`components/doc-editor.tsx`).

### 2026-11-16 (diagrams and toolbar)
- Diagrams: a ```diagram code block holds a JSON spec (boxes with label, detail, chips, one `focus` box; arrows with labels) that `lib/diagram.ts` lays out in rows by longest path, orders children by their parents, and wires with right-angled SVG arrows redrawn on resize. The editor shows it through the code block's `createPreview` with a "⋯" menu (Edit source, Delete diagram) (`lib/doc-schema.ts`); the read-only view splits diagrams out of the Markdown and shows "Drawing a diagram…" while one streams (`DiagramFigure` in `components/doc-panel.tsx`). The doc template tells the model when and how to draw one (`DIAGRAM_GUIDE`); Mermaid stays for sequence diagrams and timelines.
- A floating toolbar at the bottom of the doc (`DocToolbar` in `components/doc-editor.tsx`): turn the block into text, a heading, a list or a quote; insert a table, a checklist, a toggle; a diagram, either drawn by Sush from the current section (a one-shot `complete` call) or blank; more blocks; and Ask Sush on the selection or the current block.
- Why: Mermaid's flowcharts are generic and hard to style to the doc; a small spec of our own gives Claude-like diagrams that follow the theme, and JSON is easy for a model to write correctly and for a user to edit. Exports still carry a diagram as its JSON source.

### 2026-11-16 (house style)
- Type scale brought down to a document's: 15px body, headings 1.4/1.2/1.07em at weight 600, tables 14px, a 30px semibold title (`.doc-title`), a 760px column, and a byline under the title with the start date and who wrote it (Sush, you, or both) (`index.css`, `components/doc-editor.tsx`, `doc-panel.tsx`).
- `doc_write` carries a house template (`DOC_TEMPLATE` in `lib/docs.ts`): a bolded lead paragraph, an optional "At a glance" table, 3 to 6 `##` sections that open with context, a closing recommendations, next steps or takeaways section, and a Sources list when the web was used; plus style rules (sentence-case headings, short paragraphs, parallel bullets, bold for key terms only, tables only for comparisons, no invented figures). Icons are left out unless asked.
- Why: first drafts read like a chat answer pasted into a page (a "This guide summarizes…" opening, bold lines as headings, an emoji icon) and the display-size type made them look unfinished. The template costs a few hundred tokens per request, since the tool is always offered; the alternative, a second "polish" pass, would cost a whole extra generation.

### 2026-11-16 (hot reload)
- The schema and `markdownToHtml` moved to `lib/doc-schema.ts`, so `components/doc-editor.tsx` exports only components and Fast Refresh swaps it alone. Before, editing it re-ran `lib/docs.ts`, emptying its in-memory store (docs load once at startup), so the Docs button and cards lost their doc until a reload. `initDocs` is now run-once and, in development, called again whenever the module re-runs.

### 2026-11-16 (block sushi)
- A small Sushi (the mascot picked in Settings, `MascotSprite`) sits in the right gutter of the block the cursor is in. Clicking it asks the chat's model (`complete` with `getTarget()`) for three improvements to that block, each a labelled full replacement in Markdown with the doc as context (first 12,000 characters); picking one replaces the block through the editor, so it autosaves and shows in history as the user's edit. Results are cached per block id and text; "Try again" refetches (`BlockSushi` in `components/doc-editor.tsx`).
- Why: Notion's AI acts on a selection; this keeps the suggestion one click from wherever the user is reading, without selecting text, and leaves the choice to them rather than rewriting in place.

### 2026-11-16 (top bar)
- A Docs button in the window's top bar, left of Share, for a chat that has docs: one doc toggles the panel, several open a menu of them (`DocsButton` in `components/doc-panel.tsx`, `App.tsx`). Before this, a doc could only be reopened from its card in the transcript, which may be far up a long chat.

### 2026-11-16 (fixes)
- A finished `doc_write` no longer folds into the "Used a tool" activity line, so its card stays in view (`components/activity-group.tsx`).
- The panel follows the call it opened from (`DocPanelState.callId`), not the doc id seen at that moment: models may stream `content` before `id`, which left the panel on a placeholder id showing "This doc was deleted" (`lib/docs.ts`, `chat-view.tsx`, `doc-panel.tsx`).
- `user_edit` read `versions.len()` while holding `last_mut()`; the length is read first (`crates/sush-core/src/docs.rs`).

### 2026-11-16
- New `sush_core::docs` module: a `Doc` (Markdown content, title, emoji icon, `rev`, `seen_rev`, up to 60 versions) stored as JSON in a new `docs` table in `sush.db`. Pure functions for the model's tools (`apply_tool` for `doc_write`, `doc_read`, `doc_edit`), the user's edits (`user_edit`) and restoring a version (`restore`), with inline tests (`crates/sush-core/src/docs.rs`).
- Tauri commands `docs_list`, `doc_tool`, `doc_create`, `doc_update`, `doc_restore`, `doc_delete`; every change goes to all windows as a `doc` / `doc-gone` run frame (`apps/desktop/src-tauri/src/docs.rs`, `runs.rs`, `lib.rs`).
- UI tool specs and runner, in-memory doc store fed by frames, panel state, outline, and export helpers (`apps/desktop/src/lib/docs.ts`). Doc tools are offered in every chat except incognito ones and run without approval (`lib/agent.ts`). `artifact_write`'s description now points documents at `doc_write` (`lib/artifacts.ts`).
- Chat card and side panel with version history, outline, Share menu, expand and close; read-only views while Sush writes, for older versions, and for docs not kept on this machine (`components/doc-panel.tsx`, `components/chat-view.tsx`).
- Block editor on BlockNote 0.57 (shadcn flavour), lazy-loaded, with Mermaid previews in code blocks and an "Ask Sush" button in the selection toolbar (`components/doc-editor.tsx`, `index.css`).
- Docs page in the sidebar: search, new doc, open chat, delete (`components/docs-page.tsx`, `App.tsx`, `app-sidebar.tsx`).
- Opening a doc closes an open deck and the reverse (`lib/slides.ts`).

## Why

Sush already had artifacts (versioned files) and decks, both read back from the conversation's tool calls. That model cannot hold user edits: the transcript only changes through run `Op`s. A doc the user is meant to edit therefore has to be stored on its own, so it lives in `sush.db` with its history, like reports and the CRM.

Stored edits create a second problem: the model would revise from its own last write and erase what the user typed. `seen_rev` records the revision the model last wrote or read; `doc_write` refuses while they differ and tells the model to call `doc_read`. `doc_edit` replaces exact, unique text only, so it can run on top of user edits without clobbering them, and all edits in one call apply or none do.

Markdown stays the stored format because the model reads and writes it well and it exports anywhere. The trade-off is BlockNote's lossy conversion: some constructs (callout syntax, nested non-list children) normalise after the first user edit. To avoid recording edits nobody made, the editor saves only when its serialised text differs from what loading produced.

Editing saves 700 ms after typing stops, on the revision it loaded; Rust refuses a stale revision and the editor reloads the current text. User saves within five minutes fold into one version, so history shows meaningful steps rather than keystrokes.

Sharing is local: rich-text copy (pastes formatted into Notion, Google Docs, email), Word via HTML saved as `.doc`, a standalone web page, and Markdown. Live links through the shared-session relay were left for later; guests of a shared chat see a read-only copy built from the tool call.

## What makes it stand out

- Compared with a markdown artifact: the user edits in place with a block editor ("/" menu, drag handles, tables, to-dos, selection toolbar), and Sush sees those edits before revising, enforced in Rust rather than by prompt.
- Partial revisions via `doc_edit` (find/replace, all-or-nothing, uniqueness checked) instead of resending the whole document on every change.
- Version history with author (Sush or You), note and time; any version can be previewed read-only and restored as a new version.
- Mermaid diagrams render inside the editor through BlockNote's `createPreview`, not only in the read-only view.
- The panel streams the doc as it is written, then hands over to the editor; cross-window sync uses the same frame channel as notebooks and the CRM, so no window broadcasts on its own.
- The editor bundle loads only when a doc is opened (`React.lazy`), keeping chat startup unchanged.
