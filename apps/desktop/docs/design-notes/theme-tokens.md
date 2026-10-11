# Theme Tokens — Design Notes

Last updated: 2026-10-11

## What changed

### 2026-10-11
- Dark `--background` goes from a deep teal-black (`oklch(0.155 0.012 215)`) to near-black (`oklch(0.115 0.004 215)`) (`src/index.css`, `.dark`).
- The surfaces above it are lowered so they still stand apart from the background: `--sidebar` 0.185 → 0.145, `--card`/`--popover` 0.2 → 0.17, `--secondary`/`--muted`/`--accent`/`--sidebar-accent` 0.26 → 0.23. Chroma is reduced on all of them.
- Foreground, border, brand and chart tokens are unchanged.

## Why

The dark theme should read as close to black. The background keeps a very small teal chroma (0.004), so it still matches the brand colour and doesn't look like flat grey. Lowering only the background would have made cards, popovers and hover states look much lighter by comparison. So every surface moved down by about the same amount, keeping the same order from background to sidebar to cards to hover fills. The background is not pure black (`#000`): on pure black, light text and accent colours glare, and borders made from white at low opacity become hard to see.

## What makes it stand out

- The background has a tint (chroma 0.004 at hue 215), so it matches the teal brand colour instead of being a neutral grey.
- The surfaces stay in order (background 0.115 < sidebar 0.145 < card 0.17 < hover fill 0.23), so menus and cards still separate from the page without heavier borders.
- Foreground stays at `oklch(0.975 …)`, so text contrast goes up instead of down.
