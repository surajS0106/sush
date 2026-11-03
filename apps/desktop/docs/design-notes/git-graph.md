# Git Graph — Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04
- Lane colours in the Graph pane are now the logo's teal (`text-chart-1`) and coral (`text-coral`), alternating by lane, in place of an eight-colour Tailwind cycle that started with `text-brand` and amber (`src/components/git-graph-pane.tsx`, `LANE_COLORS`). Lines, dots and branch chips all follow it.

## Why

The first lane used `text-brand`, which follows the accent picker, so with a non-teal accent the main line turned navy (or whatever the accent was) and the next lane was amber. Neither is a Sush colour. The graph is part of the product's identity, like the logo, so it uses the fixed logo tokens (`--chart-1`, `--coral` in `src/index.css`) instead. Both have light and dark values. The trade-off is that with only two colours, lane 2 is teal again, so lanes two apart share a colour. The column order and the connecting curves still keep them apart.

## What makes it stand out

- The colours come from theme tokens, not Tailwind palette names, so they change with light and dark mode and with any later change to the tokens.
- The colours stay the same whatever accent the user picks, so the graph always matches the logo.
- Ref chips take the lane colour through `currentColor` (`bg-current/12`), so the chips change with the lanes and need no extra code.
