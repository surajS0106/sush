# Doc Code Blocks — Design Notes

Last updated: 2026-11-18

## What changed

### 2026-11-18 (revised)
- Light mode background is now `oklch(0.966 0.002 190)`, a near-neutral grey, still borderless. The warm `#f7f6f3` read as beige against the page's cool-tinted background, and the theme's `--muted` (chroma 0.008) read as too blue.

### 2026-11-18
- Light mode code blocks in the doc editor use `#f7f6f3` as the background with a transparent border, replacing the cream `#fffefb` background with an `#efebe3` border (`--doc-code-bg` / `--doc-code-border` on `.doc-editor`, `src/index.css`). Dark mode is unchanged.

## Why

The cream fill with a beige border looked yellowed next to the white page and drew more attention than the code it held. Notion's light-mode code block is a flat, warm light grey with no border, which separates the block from the page by tone alone. The trade-off: without a border, the block's edge depends on the fill contrast, which is low by design; the language bar and padding carry the block's shape instead.

## What makes it stand out

- BlockNote's stock code block is near-black in both themes; here it follows the page's theme.
- Colors are two CSS variables on `.doc-editor`, so the inline-suggestion surface (`--bn-suggestion-surface`) and the block share one value and can't drift.
- Syntax colors come from Shiki's dual-theme tokens (`--shiki-light` / `--shiki-dark`), so the lighter grey needs no token changes.
