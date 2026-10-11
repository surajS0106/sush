# Transcript Tables — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12
- Markdown table headers in chat messages are sticky: `[data-streamdown="table-header"]` gets `position: sticky; top: 0`, an opaque background and an inset bottom border (`src/index.css`).

## Why

Streamdown already caps each inline table at `tableMaxHeight` (300px by default) and scrolls its rows inside the table's own box, but only its full-screen view pins the `<thead>`. Inline, the column names scrolled out of view, so long tables lost their labels. The rule is that table headers always stay visible while the rows scroll.

Streamdown's header background is `bg-muted/80`, which is translucent and would let scrolled rows show through. The rule mixes the same 80% muted tone onto the page background to get an opaque equivalent that looks the same. The `divide-y` border between header and body belongs to the body and scrolls away, so the header draws its own 1px bottom edge with an inset shadow.

## What makes it stand out

- It targets Streamdown's `data-streamdown` hooks in CSS instead of overriding the `table`/`thead` components, so the copy, download and full-screen controls keep working unchanged.
- The rule is unlayered, so it wins over Streamdown's Tailwind utilities without `!important`.
- The header colour comes from `--muted`, `--background` and `--border`, so it follows light, dark and custom themes.
