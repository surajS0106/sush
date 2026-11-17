# Docs — Design Notes

Last updated: 2026-11-17

## What changed

### 2026-11-17 (space between code blocks)
- Code blocks have an 8px margin above and below. Two neighbours now sit 22px apart, counting BlockNote's 3px block padding, where their borders had touched (`index.css`).

### 2026-11-17 (indenting by language)
- Indentation in code blocks follows the block's language (`codeBlockKey` in `lib/doc-code-block.ts`). Enter goes one level deeper after an opener: a trailing `{ [ (`, a trailing `:` in Python and YAML, an open non-void tag in HTML, XML, JSX, TSX and Markdown, or `then` / `do` in shell. Between a pair (`{|}`, `<div>|</div>`) the closer moves to its own line at the outer indent, and the caret lands on the inner line. Typing `}`, `]`, `)`, or the `/` of `</`, on an indented blank line steps back one level. A level is 4 spaces for Python, Rust, Java, C, C++, C#, Kotlin, Swift, PHP and PowerShell, a tab for Go, and 2 spaces otherwise. Tab and Shift+Tab use the same unit. Plain text only keeps the current indent.
- The split's caret is made with the current selection's own class (`TextSelection.create`), because `prosemirror-state` isn't a declared dependency of the app and importing it would rely on hoisting.
- Why: Enter only copied the current line's indent, so typing code by hand needed every level added manually and closers left over-indented. A real language server would be much heavier; these few rules cover what most hand-typed snippets need. Checked headlessly on 11 cases (JS braces and pair split, closer outdent, Python nesting, HTML tags, pair split and void tags, Go tabs, plain text, kept indent).

### 2026-11-17 (language change after a reload)
- The code block's bar finds its block when clicked, from the node view's `getPos` (the container's `id`, the node's `language` and text), instead of the `block` captured when it was drawn. This applies to both the language menu and Copy (`lib/doc-code-block.ts`).
- Why: loading a doc's text again after a save (`replaceBlocks`) gives every block a new id. ProseMirror keeps a node view whose own node is unchanged, and a code block's attrs (`language`) don't include the id, which lives on the container. The view then held a dead id, `updateBlock` threw "Block with ID … not found", and a block that existed before the reload couldn't change language while a new one could. Reproduced headlessly (load, reload, pick) before and after the fix.

### 2026-11-17 (Select All through the menu)
- On macOS the app menu is Tauri's default with Edit → Select All replaced by Sush's own item. It keeps its place and the Cmd+A shortcut and emits `menu-select-all` (`src-tauri/src/menu.rs`). `lib/select-all.ts` has the focused window send a cancelable `sush:select-all` DOM event from the focused element. The doc editor answers it with BlockNote's Mod-a, and anything unanswered gets `document.execCommand("selectAll")`, the native behaviour, so text fields and the composer are unchanged. A Cmd+A keydown that does reach the page (Windows, Linux) still runs the same select-all, and a 150 ms guard stops one press running twice (`components/doc-editor.tsx`).
- Why: the menu's predefined Select All is a key equivalent, so it took Cmd+A before the page's key listener and ran the webview's native select-all. In paragraphs that happened to look right. Inside a code block it selected nothing ProseMirror took up, so nothing was selected. The keydown fix below never ran on macOS. Headless tests of BlockNote's Mod-a (with highlighting on) selected the code and then the doc correctly, which pointed at the menu.

### 2026-11-17 (light code colours)
- Light mode's code colours are Night Owl Light (calm blues and teals, italic keywords and comments) instead of Vitesse Light. Dark mode stays Vitesse Dark. Tokens' italics come through as `--shiki-light-font-style` (`components/doc-editor.tsx`, `index.css`).
- Why: Vitesse Light was too faint on the cream block, and the code read as nearly plain. The user picked Night Owl Light from a side-by-side render of six light themes on the block's background (One Light, Ayu, Snazzy, Material Lighter, Vitesse).

### 2026-11-17 (darker dark code blocks)
- In dark mode a code block's background is three parts page colour to one part `--muted` (`color-mix` in OKLCH), about 14% lightness against the page's 11.5%, instead of `--muted` itself (23%). The border is unchanged and keeps the edge visible. It follows the theme's hue because it's mixed from the theme's own tokens (`index.css`).
- Why: on the near-black page the muted grey read as a light slab, and the syntax colours lost contrast against it.

### 2026-11-17 (code block menu, indenting)
- The language list opens on `<body>`, fixed under its button, follows it when the doc scrolls, and closes on resize, Escape or a click elsewhere. A language is picked on mouse press. Hovering only moves the highlight, and the list is rebuilt only when the filter changes. The list scrolls by hand rather than with `scrollIntoView`, which would also scroll the doc. An earlier version rebuilt the list on every hover and closed on any outside scroll, so a pick could be lost between press and release. Nothing in the block's bar changes after it is drawn: Copy confirms with a toast, and the open state lives in a variable rather than `aria-expanded`. The bar stops its own presses from reaching ProseMirror (`lib/doc-code-block.ts`).
- Tab inserts an indent of two spaces at the caret, or indents every selected line. Shift+Tab takes one indent off each line. Enter starts the next line with the current line's indent. A blank or unindented line keeps BlockNote's Enter, so two empty lines still leave the block (`codeBlockKey`, run from the editor's capture listener before BlockNote's keys).
- Why: the menu sat inside the block's DOM, outside its editable part. ProseMirror reads changes there as edits and redraws the block, which most likely took the menu away as soon as it opened. Indenting relied on BlockNote's Tab, which only inserted spaces at the caret: it couldn't indent a selection, outdent or carry indentation onto the next line.

### 2026-11-17 (select all)
- Cmd/Ctrl+A in a doc is caught by the same capture listener as undo and hands the event to ProseMirror's `handleKeyDown` props, so BlockNote's own Mod-a keymap runs. Tiptap's `keyboardShortcut` command was tried first. It keeps only the steps of the transactions it captures, so a selection-only change was dropped and nothing got selected. The first press selects the current block's text and the next selects the whole doc, as in Notion. Text boxes inside the doc keep their own select all (`components/doc-editor.tsx`).
- Why: as with Cmd+Z, the macOS Edit menu's Select All could run the webview's native select-all, which ProseMirror doesn't take up, so nothing was selected.

### 2026-11-17 (code highlighting, language menu)
- Code blocks are syntax highlighted. The editor adds BlockNote's `SyntaxHighlightingExtension` with a Shiki highlighter (`vitesse-light` and `vitesse-dark`: muted colours that suit the cream block better than GitHub's saturated ones, which were tried first; BlockNote picks the pair by "light"/"dark" in the theme names, which rules out pairs like Catppuccin's), imported the first time a doc shows code. Languages load as blocks use them (`CODE_HIGHLIGHTING` in `components/doc-editor.tsx`). Each token carries both colours as `--shiki-light` / `--shiki-dark`, and `index.css` picks one by the app's theme, so switching themes needs no re-highlight.
- The language picker is a button sized to the language's name, opening a list with a search field: arrows, Enter and Escape work, the current language is ticked, and aliases match ("ts", "py"). Copy sits at the block's top right and shows on hover. `lib/doc-code-block.ts` keeps BlockNote's code block spec (shortcuts, Markdown, the `highlight` hook). It calls BlockNote's own `render` and swaps the `<select>` in its output for the bar. It doesn't replace `render`, because the spec's `render` is already wrapped to place its output in `.bn-block-content[data-content-type="codeBlock"]`, and every code block style needs that element. This supersedes the restyled `<select>` chip below.
- The language list grew from 16 to 31 (C, C++, C#, Kotlin, Ruby, PHP, PowerShell, Dockerfile, TOML, XML, Diff, GraphQL, SCSS, JSX, TSX). Keys are Shiki's language ids, since highlighting loads by key (`lib/doc-schema.ts`). "tsx" is now its own language instead of an alias of TypeScript.
- Why: BlockNote 0.57 highlights only when the editor is given a highlighter. Without one, every language rendered as plain text, so the picker changed nothing visible. A native `<select>` is as wide as its longest option and draws its list with the OS, so the chip still left a gap between the name and the chevron, and its list could not be searched.

### 2026-11-17 (slash menu search, code blocks)
- The "/" menu is Sush's own `SlashMenu` (`components/doc-editor.tsx`, through `SuggestionMenuController` with `slashMenu={false}` on the view): BlockNote's items and grouping, with a search field on top that shows the text typed after the "/" (read from the `SuggestionMenu` extension's `query`), or "Type to search blocks" when empty. The field doesn't take focus: clicking it keeps the cursor in the doc.
- Why the field mirrors the query instead of being an input: BlockNote closes the menu on any editor blur and handles arrows and Enter in the editor, so a focused input would close the menu it sits in.
- Code blocks are a creamy off-white (`#fffefb`, border `#efebe3`) in light mode and the theme's muted surface in dark mode, through `--doc-code-bg` / `--doc-code-border` on `.doc-editor`, instead of BlockNote's fixed `#161616` with white text. The neutral muted grey was tried first in light mode and read as cold next to the page; the language picker and its options follow the theme too (`index.css`).
- The code block's language picker is always shown, as a small chip with a chevron at the block's top left, highlighted on hover and focus. BlockNote kept it at opacity 0 until hover and then 0.5, which in dark mode left nothing visible to click. `opacity: 1 !important` is needed because BlockNote's stylesheet loads with the lazy editor, after `index.css`, and its hover rule has the same specificity.

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
- Code blocks highlight in both themes from one pass (dual-theme Shiki tokens), with a searchable language menu and a Copy button. BlockNote's default is unhighlighted text under a native `<select>`.
- The panel streams the doc as it is written, then hands over to the editor; cross-window sync uses the same frame channel as notebooks and the CRM, so no window broadcasts on its own.
- The editor bundle loads only when a doc is opened (`React.lazy`), keeping chat startup unchanged.
