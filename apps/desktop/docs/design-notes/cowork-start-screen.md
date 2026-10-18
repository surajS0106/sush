# Cowork Start Screen — Design Notes

Last updated: 2026-10-14

## What changed

### 2026-10-14 (model usage and cost, issue #24)
- The heatmap card gains Overview / Models tabs (`role="tablist"`) and an All / 30d / 7d range filter, both remembered (`sush.usage-view`, `sush.usage-range`). Ranges are calendar days ending today; the shape picker shows only on Overview (`src/components/usage-heatmap.tsx`).
- Overview: eight tiles above the grid (sessions, messages, total tokens, estimated cost, active days, peak hour, streak, favorite model) and a comparison line under it ("~40× the tokens in Moby-Dick"). The streak moves from the footer into a tile. Grid days before the range draw as empty.
- Models: tokens per day stacked by model in an HTML bar chart with a nice-step y axis and about five date labels. Ranges over 62 days go by week, then by month. Hovering a bar lists each model's tokens and the bucket's cost. A legend under it gives each model's input/output tokens, cost ("Free" for local) and share.
- `src/lib/usage.ts`: `activity()` replaces `dailyReplies` and tallies replies, tokens per model and spend per day, messages (a prompt takes the time of the reply after it) and replies per hour. `formatSpend`, `emptyTally`, `MODEL_COLORS` and `OTHER_MODEL_COLOR` move here from Settings > Usage, which now imports them (`src/components/usage-section.tsx`).
- `ChatView` passes its `localProviders` set so local models count as free (`src/components/chat-view.tsx`).

### 2026-10-13 (contrast)
- `HeatMap` empty-cell outlines go from 14% to 50% stroke opacity (3.6:1 light, 5:1 dark) and use `vector-effect: non-scaling-stroke` so they stay 1px when the SVG scales down (`src/components/ui/HeatMap.tsx`).
- In `color` mode, filled cells get a 1px edge of `color-mix(in oklab, <color> 70%, var(--foreground))`, measured at 5:1 or more against the card for every built-in accent in both themes.
- Legend: the "min"/"max" names no longer fade to 50% (was 2:1); they use the row's grey and the values use `text-foreground`. Tooltip secondary text goes from 60% to 70% opacity.
- Shape picker: the selected shape's icon is solid, unselected ones are outlines (`src/components/usage-heatmap.tsx`).

### 2026-10-13 (cell shape)
- `UsageHeatmap` has a shape picker in its header: hexagons, circles or squares, as three icon buttons in a `role="radiogroup"` (arrow keys move and select). The choice persists in the `sush.heatmap-shape` store (localStorage, followed across windows) and defaults to hexagons (`src/components/usage-heatmap.tsx`).
- Month label positions only add the extra half cell for the hex layout, since square and dot grids are exactly `WEEKS * CELL` wide.
- `HeatMap` is keyed by shape, so switching replays the reveal animation in the new shape.
- `HeatMap`'s `dot` shape now draws every circle at full cell size; it used to scale the radius with the value (35% for empty cells) (`src/components/ui/HeatMap.tsx`).

### 2026-10-12 (accent color)
- Added a `color` prop to `HeatMap` (`src/components/ui/HeatMap.tsx`) that takes any CSS color, `var(--brand)` included, plus `base` (default `var(--muted)`). In that mode each cell's fill is `color-mix(in oklab, <color> N%, <base>)`, set through `style` because SVG presentation attributes do not resolve `var()`. The legend gradient is built from the same painter. Built-in ramps (`variant`, `ramp`) work as before.
- `UsageHeatmap` now uses HeatMap's default hexagon shape instead of `shape="square"`; the month label positions account for the extra half cell the offset hex rows add to the grid width.
- `UsageHeatmap` passes `color="var(--brand)"` with `floor={0.25}` and drops the two hard-coded teal ramps and its `next-themes` lookup (`src/components/usage-heatmap.tsx`).

### 2026-10-12 (HeatMap component)
- `UsageHeatmap` now draws its grid with the registry `HeatMap` component (`src/components/ui/HeatMap.tsx`, added from `@ui-shrushank-pro/heat-map`) in its `square` shape, instead of a hand-built CSS grid (`src/components/usage-heatmap.tsx`).
- Data is a 7 × 53 matrix (weekday rows, week columns). Days with no replies and days still to come are `null`, so they draw as empty outlines. Days with replies are colored on a continuous teal ramp scaled linearly from 0 to the busiest day (`domain={[0, max]}`, `floor={0}`). There are two ramps (`RAMPS`), picked from next-themes' `resolvedTheme`: light to dark on the light theme, dark to bright on the dark theme, so busier days always move away from the card color.
- Added an `emptyLabel` prop to `HeatMap` (default "no data"); the heatmap passes "No replies", so an empty day's tooltip and screen reader label say that instead of "no data".
- Counts read "1 reply" / "N replies" (the old `plural` helper produced "replys").
- Hovering or focusing a day shows HeatMap's tooltip ("Monday, week of Oct 5 3 replies"). The footer readout for the hovered day and the Less/More swatches were removed; the streak line stays, and HeatMap's gradient legend with min/max values replaces the swatches.
- Month labels remain above the grid, now absolutely positioned at each column's share of the SVG viewBox (`CELL` pitch plus HeatMap's 4-unit padding). The Mon/Wed/Fri labels were dropped; the tooltip names the weekday.

### 2026-10-12
- Replaced the "Try asking" suggestion chips under the Cowork greeting with an activity heatmap (`src/components/chat-view.tsx`). The `COWORK_SUGGESTIONS` sets are gone; plain chats keep their starters.
- Added `UsageHeatmap` (`src/components/usage-heatmap.tsx`): 53 week columns starting on Sunday, the last holding today, one square per day. Month labels sit above the column where a month starts (skipped if within three columns of the previous label).
- The header shows the year's total; the footer shows the current streak of consecutive days with replies.
- Added `dayKey` and `dailyReplies` to `src/lib/usage.ts`: assistant replies per local day across chats and Cowork, timed by `metadata.createdAt` with the chat's `updatedAt` as the fallback, the same rule `summarizeUsage` uses.

## Why

The Cowork suggestions were generic prompts about "this folder" that did not change with the folder or with use, so they added little after the first session. A heatmap gives the empty screen something that reflects the user's own history with Sush and rewards coming back (the streak line), without competing with the composer for attention.

A "use" is counted as an assistant reply. Replies are the unit the Usage page already tallies, so the two views agree, and they need no new storage: the data comes from the conversations already held in memory by `lib/store.ts`. The trade-off is that deleted chats drop out of the heatmap, and replies saved before `createdAt` was recorded all land on their chat's last-activity day.

Moving to the shared `HeatMap` component brings keyboard navigation, per-cell screen reader labels, an entry animation and a legend that reports real values, none of which the hand-built grid had. The cost is the accent link: HeatMap's ramps take hex stops, not CSS variables, so the cells use a fixed teal close to the default accent rather than following the user's accent choice. Zero-reply days are `null` rather than `0` so they render as outlines (the familiar GitHub look) instead of the first ramp color.

The domain is pinned to start at 0 because HeatMap's default linear scale runs from the smallest to the largest value present. With only a few active days that stretched a 16 to 18 reply range across the whole ramp, so a 16-reply day looked like no activity. A single ramp also read backwards on one of the two themes, since the end that contrasts with a light card blends into a dark one.

Following the accent was the requirement: the rest of the UI is painted from `--brand`, and a fixed teal clashed with any other accent. Doing the mix in CSS rather than reading the variable in JS means no theme hook, no `getComputedStyle`, and no re-render when the accent or theme changes; the browser repaints the cells. Mixing from `--muted` gives the right direction in both themes for free, since `--muted` is light on the light theme and dark on the dark one. The floor of 0.25 keeps a one-reply day from looking the same as the empty-day outline.

Hexagons, circles and squares each suit different tastes and densities, and `HeatMap` already drew all three, so offering the choice cost only a picker and a stored preference. It sits in the heatmap's own header rather than in Settings so its effect is visible right where it is changed.

Sized-by-value dots were meant to carry the reading beyond color, but on this screen most days are empty or quiet, so most of the grid rendered as specks that were hard to see. Full-size circles match the hex and square shapes; the trade-off is that the dot shape now carries value by color alone, like the other two.

The contrast pass came from a failed accessibility check. Quiet days mixed close to `--muted` can't reach 3:1 by fill alone without flattening the ramp, so the edge carries visibility and the fill keeps carrying intensity. Thin strokes measured fine on paper but rendered at about half a pixel once the SVG scaled down, which is why they are non-scaling.

The model view answers "what is this costing me" where the work starts, instead of only in Settings. It reuses `summarizeUsage`, the price table and the top-five model colors, so a model is the same color and the same dollar figure on both screens; the trade-off is that the card inherits the Usage page's limits (deleted chats drop out, unknown models show "—"). The chart is plain flexbox rather than SVG so segments take Tailwind color classes and the existing tooltip, and buckets widen past 62 bars so "All" stays legible however long the history.

## What makes it stand out

- No new persistence or Rust command: it derives from `useConversations()` and recomputes in one `useMemo` when threads change, so a reply sent elsewhere shows up the next time the screen opens.
- Shading is a continuous linear scale from zero to the busiest day, so color is proportional to reply count and the legend's min reads "0 replies".
- Cells follow the user's accent color and light/dark mode live, through `color-mix` on CSS variables, with no JS color math or theme subscription.
- The grid is an SVG `role="grid"` with roving tabindex: arrow keys, Home and End move between days, each cell has an `aria-label` naming the weekday, week and count, and one polite live region announces the focused day.
- The SVG scales to its container through its viewBox, so the full year fits any transcript width setting without horizontal scrolling; month labels are placed in viewBox percentages so they stay aligned at every width.
- Cell shape is a remembered, keyboard-operable choice (radio group with roving tabindex), and month labels stay aligned for every shape.
- The legend is drawn from the same ramp and floor as the cells and labels min and max in replies, so it cannot drift from what the grid shows.
- One range filter drives the tiles, the grid and the chart from the same tally, and model colors and spend come from shared helpers, so the card and Settings > Usage cannot disagree.
- The bar chart picks day, week or month buckets from the span, uses 1/2/2.5/5 × 10ⁿ axis steps, and the whole column is the hover target so slivers are easy to inspect.
