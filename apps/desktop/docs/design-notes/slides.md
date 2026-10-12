# Slides — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12 (themes, PowerPoint export, forgiving input)
- Six built-in themes (ember, paper, ocean, forest, mono, blush) and nine shared layouts (cover, section, statement, bullets, split, cards, stats, quote, closing) with decorative shapes drawn in CSS (`src/lib/slide-themes.ts`). `slides_write` now takes `theme` and a per-slide `layout`; `css` is optional. The model writes semantic HTML with a small set of classes (`.eyebrow`, `.lead`, `.cards`, `.stats`, `.band`).
- `readSlides` accepts what models get wrong: `content`/`body` for `html`, a bare string per slide, the array as a JSON string, and a model-written `<div class="slide">` root (unwrapped, its classes kept). Validation errors name the expected shape (`src/lib/slides.ts`).
- PowerPoint export (`src/lib/pptx.ts`, pptxgenjs, loaded on first use): each slide is rendered offscreen and read from its computed layout. Filled or bordered boxes and positioned pseudo-elements become ellipses, rounded rectangles or rectangles; text blocks become editable text boxes with per-run weight, italics, color and letter spacing; list numbers and quote marks carry over; speaker notes are kept. Gradients fall back to their first stop; bundled fonts map to Georgia, Arial and Courier New.
- New Tauri command `save_bytes_file_as` (base64 in, native save dialog) for binary files (`src-tauri/src/library.rs`, `src/lib/tauri.ts`). Export menu and the card's download menu offer .pptx and .html.

### 2026-10-12
- New `slides_write` tool: the model writes a deck as a shared `css` string plus slides of HTML fragments on a fixed 1920×1080 canvas, each with optional speaker `notes` and root `class` (`src/lib/slides.ts`). Calls sharing an `id` are versions of one deck, read back from the conversation like `artifact_write`.
- `deckViews` builds each card's view (versions up to that call) and each deck's full history; slides appear one by one while the tool input streams.
- Slides render into shadow roots (`SlideView` in `src/components/slides-panel.tsx`), scaled from 1920×1080 with a `ResizeObserver`. Markup passes through `sanitizeHtml` (drops scripts, frames, links, `on*` handlers, `javascript:` URLs) and `@import` is stripped from CSS.
- Side panel (`SlidesPanel`): title with a version picker, comment toggle, Export menu (save as standalone HTML, copy speaker notes), expand to cover the chat, close; prev/next with a slide counter; Present, speaker notes and zoom (fit, 50%, 75%, 100%); a filmstrip of numbered thumbnails with single and grid views, collapsible. Arrow keys, Page Up/Down, Home and End move between slides.
- Commenting: click a spot on the slide, type what should change, and it is sent as a chat message ("On slide 2 of "Title" (near the top-right): ...") so the model revises the deck.
- Presenter: full-window slideshow in a portal; arrows, Space, Enter and clicks advance, Escape returns to the panel on the slide it ended on.
- Chat card (`DeckCard`): first-slide thumbnail, title, version and slide count (or "Building slide N…"), Save as HTML, and Open / Hide. An older call's card opens its own version; the newest follows later ones.
- The panel opens on its own the first time a call starts writing a deck, and takes the Cowork panel's place while open (`src/components/chat-view.tsx`). Wiring: `src/lib/agent.ts` (spec, auto-run, result), `src/components/activity-group.tsx` (cards never collapse into activity lines).
- `exportDeckHtml` writes a standalone file: slides stacked and scaled to the window, one per page when printed, bundled font names mapped to Google Fonts.

## Why

Decks are visual, so a text artifact card is the wrong shape for them. Following Claude's slides panel and Codex's compact tool chrome, the deck sits beside the conversation: the chat stays the place to ask for changes, the panel the place to look. Commenting by pointing at a spot turns "make this warmer" into a precise, located request without a separate editor.

A fixed 1920×1080 canvas gives the model one coordinate system and makes every view (thumbnail, panel, presenter, export) the same picture at a different scale. Shadow roots were chosen over sandboxed iframes because a `srcdoc` iframe inherits the app CSP, which blocks web fonts, and cannot see the app's bundled `@font-face` fonts; shadow DOM keeps the deck's CSS scoped while those fonts still apply. The trade-off is that slides share the app's document, so sanitizing plus the CSP (no inline scripts) carry the safety.

The first real test (gpt-oss:120b) showed the weakness of freeform CSS: the model named a field `content`, wrapped every slide in its own root, and produced plain centered text. Themes move design decisions out of the model: it picks a mood and a layout, and the deck gets a consistent palette, type scale and shapes regardless of model quality. Tolerating common field-name slips costs a few lines and saves a failed tool call plus a retry.

PowerPoint export reads the browser's own layout instead of re-implementing it from the HTML, so whatever the theme or custom CSS does, positions match the preview. The cost is fidelity limits PowerPoint imposes (no gradients, no blend modes, font substitution); text stays editable, which matters more for a deck someone will keep working on than pixel-exact images would.

Each revision resends the full deck. That costs tokens on large decks but keeps versions self-contained and the history trivially reconstructible from tool calls, matching how artifacts work.

## What makes it stand out

- Progressive rendering: slides, thumbnails and the counter update as the tool input streams, and the canvas follows the slide being written.
- Located comments: click-to-pin with row/column wording the model can act on, sent through the normal chat so the revision is a visible, undoable turn.
- One scaling model everywhere: thumbnails, fit/zoom canvas, presenter and exported HTML all scale the same 1920×1080 slide, so what you see is what you export or print.
- Per-card versions: older cards reopen their own version; the version picker switches without losing the panel.
- Keyboard and screen-reader work: listbox semantics on the filmstrip, `aria-live` counter, decorative thumbnails hidden, a modal presenter that restores focus.
- Model-agnostic polish: a weak model choosing `theme: "ember"` and `layout: "cover"` gets the same designed result as a strong one.
- Editable .pptx: text boxes and shapes placed from computed layout, not screenshots, with speaker notes.
- Reuses app primitives (side-panel width from `lib/layout.ts`, `ResizeHandle`, shadcn buttons and menus), so it follows the app's theme and accent.
