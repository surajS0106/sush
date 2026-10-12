# Cowork Terminal Pane — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12 (Tab completion)
- New `terminal_complete` command (`src-tauri/src/terminal.rs`): given the word being typed, it lists the entries of the shell's current folder (or the folder named before the last `/`, with `~/` as home) whose names start with the rest, ignoring case. Folders are marked, hidden entries show only for a `.` prefix, and the list is capped at 500. Registered in `lib.rs`, bound as `api.terminalComplete` in `src/lib/tauri.ts`, with a Rust test.
- `src/lib/terminal-complete.ts` does the line editing. `wordAt` splits the line up to the caret the way the shell would (quotes, `\` escapes, or `` ` `` on PowerShell). `quotePath` writes a name back as one word: backslash escapes for bash/sh, quotes for PowerShell, and the user's own quote kept when the word opened with one. `commonPrefix` finds how far several matches agree.
- Tab in the pane (`src/components/terminal-pane.tsx`) works like bash. With one match it finishes the name (folders get `/`, files a trailing space). With several it fills in as far as they agree (`dow` → `Down`). When they agree no further, it lists them under the prompt: folders in the accent colour, at most 100 shown, then a count. Tab and Shift+Tab then cycle through the list, a click picks one, and Escape, typing, history or Enter closes it.
- `TerminalInput` now follows caret moves made from outside (`setSelectionRange`, a changed value) through `selectionchange`, so the block cursor lands after the completed text.

### 2026-10-12 (accent colour)
- Every emerald colour in `src/components/ui/Terminal.tsx` is now the app's accent, the `brand` token (`--brand`, set by Settings → General → Accent color): the header icon tile (`bg-brand/15 text-brand`), the `$` prompt, the block cursor (solid and outline), focus outlines, input selection and the demo's success lines. The light/dark emerald pairs collapse into one class each, because `--brand` already has a dark-mode value per accent.

### 2026-10-12
- The installed `@ui-shrushank-pro/terminal` component now also exports parts for a live terminal: `TerminalFrame` (card and header with icon tile, title, meta and an actions slot), `TerminalHeaderButton`, `TerminalPrompt` (folder label plus the emerald `$`) and `TerminalInput` (a prompt line with a block cursor). The animated demo `Terminal` export still works as before (`src/components/ui/Terminal.tsx`).
- `TerminalInput` puts a transparent `<input>` over a mirror of its text so it can draw the caret as the component's blinking emerald block. The block is hollow when the input isn't focused, stops blinking under reduced motion, and the mirror follows the input's horizontal scroll on long lines.
- The Cowork side panel's terminal now uses those parts in place of its VS Code-style chrome. Commands show as `<folder> $ cmd` (`PS>` on PowerShell), output between commands is one indented block (stdout in stone, stderr in red), and the header shows the shell and the full cwd (`src/components/terminal-pane.tsx`).
- The column count sent to `terminal_run` subtracts the new horizontal padding (44px), so wrapping matches the wider gutter.

## Why

The user wanted this specific Terminal UI in the app, but the component as installed only replays a scripted list of commands. The Cowork pane already had a real shell behind it (`terminal.rs` over pipes, with prompt markers, stdin while a command runs, Ctrl+C restart, history). Splitting the component into presentational parts let the pane keep all of that behaviour and only change how it looks. The other option was to give the demo component its own fake command handling, which would have made a second terminal implementation with no shell behind it.

The mirrored-input caret costs a little complexity: a mirror span and caret tracking through `onSelect` and `onChange`. A native caret can't be drawn as a block, and the blinking block is the most recognisable part of the design.

Tab completion was the most-missed shell behaviour: paths with spaces in them (`Drunk on soi`) failed when typed by hand. The shell runs over pipes with no line editor of its own, so its built-in completion is out of reach. Rust lists the folder because the webview can't read the disk. It reads the cwd the shell reported at its last prompt, so completion follows `cd` without asking the shell. Matching ignores case because macOS and Windows file systems do. The trade-off: it completes file and folder names only, not commands from `PATH`, and it ignores shell variables in paths.

The accent change makes the terminal part of the app's theme rather than a fixed green island. Choosing an accent in Settings already recolours primary buttons, rings and the theme previews; the terminal now follows too. Trade-off: the lighter accents (orange, for example) give the `$` and success text less contrast on white than emerald-700 did, but they are short, non-essential glyphs, and output text stays stone.

## What makes it stand out

- Follows the user's accent colour live, in both light and dark, with no extra code: it reads the same `--brand` variable as the rest of the app.
- Tab completion quotes names for the shell it is talking to, so a completed `Drunk\ on\ soi/` (bash) or `'Drunk on soi/'` (PowerShell) runs as typed, which is where a naive "insert the file name" version breaks.
- One component file covers both the animated marketing demo and the live terminal, so the two can't drift apart visually.
- The input is a real `<input>`, so paste, selection, IME, undo and screen-reader labelling (`aria-label` switches between "Command" and "Input for the running command") all work the native way. Only the caret is drawn.
- The cursor shows focus: solid and blinking when focused, an outline when not. It respects `prefers-reduced-motion`.
- The prompt keeps to the component's short `$` style. The full working directory is in the header, so long paths don't push commands across the line.
- Everything the pane did before still works: stdin to running commands, Ctrl+C, Ctrl+L, `clear`/`cls`, ↑/↓ history, output capped at 400k characters, and auto-follow unless the user has scrolled up.
