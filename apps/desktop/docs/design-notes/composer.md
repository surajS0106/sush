# Composer — Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04
- The thinking picker's pill keeps one width: every possible label is stacked invisibly in a grid cell under the current one (`PILL_LABELS` in `src/components/reasoning-picker.tsx`).
- The thinking picker's trigger shows five rising signal bars instead of a brain icon, one bar per effort level. The lit count follows the effort; Auto lights the model's default level; thinking off or a model with no controls leaves all bars dim (`EffortBars` in `src/components/reasoning-picker.tsx`).
- Each effort level has its own fixed colour on the bars and the pill: teal, green, olive, orange, coral from low to max. Low and max reuse `--sush` and `--coral`; the middle three are new `--effort-*` tokens with light and dark values (`src/index.css`, `EFFORT_STYLE` in `src/components/reasoning-picker.tsx`).
- Model picker provider groups start collapsed. The `collapsed` set became an `expanded` set that starts empty, so opening a group is what gets recorded (`src/components/model-picker.tsx`).
- "No models found" renders only while searching or when no provider has any models (`src/components/model-picker.tsx`).

### 2026-10-11
- Model picker trigger text changed from `text-muted-foreground` to `text-foreground/90`, with `hover:text-foreground` (`src/components/model-picker.tsx`).

## Why

The model picker sits in the composer footer next to the permission mode pill. When the mode is Auto, that pill is brand-tinted (`bg-brand/12 text-brand`, `src/components/permission-mode-picker.tsx`). Beside it, the model picker's muted grey label on a nearly transparent pill read as a disabled control even though it is always interactive. Using near-foreground text marks it as live while the 90% opacity keeps it a step quieter than the message input. The trade-off is slightly more visual weight in the footer.

With several providers open, the list ran long and pushed later providers out of view. Collapsing the groups makes the first view a short list of providers, and the "Using" row still names the current model. The trade-offs are an extra click to reach a model when not searching, and a provider's load error stays hidden until its group is opened.

The brain icon looked the same at every effort level, so only the text label carried the setting, and below the `sm` breakpoint that label is hidden. Signal bars show the level at a glance at any width. The trade-off is one case with no true level: a model that can think but has no effort setting has nothing to measure, so its bars read as medium.

A colour per level makes the setting readable from colour as well as bar count, and the scale runs between the logo's two colours so it stays within the app's palette. The trade-off is that these colours ignore the accent picker, unlike the rest of the composer: five levels can't be told apart in one accent.

Changing effort resized the pill and shifted its neighbours in the footer. A constant width keeps them in place. The trade-off is empty space after short labels such as "Low".

## What makes it stand out

- Search ignores collapsed state, so typing finds a model in any provider without opening its group first.
- The empty message is gated on search or a truly empty catalog. cmdk counts rendered rows, so collapsed groups would otherwise show "No models found" above a list of providers that do have models.
- The picker keeps the footer's shared pill treatment (border, faint fill, `h-7`, set by the wrapper in `src/components/composer.tsx`) and changes only the text color, so neighbouring controls still line up.
- The picker always shows a chosen value (or "Select model"), so it now reads like a filled-in field instead of matching the muted icon-only controls such as the idle mic button.
- A hover step to full foreground gives pointer feedback without adding a background change on top of the wrapper's fill.
- The effort bars are generated from `EFFORTS`, so the bar count stays tied to the list of levels. Bars take their level's colour through `currentColor`, and unlit bars stay visible at 25% opacity so the scale always reads as a full five.
- The pill's border and fill take the level's colour too, so a coral Max never sits inside a teal pill. The level is also shown by bar count and the label, so colour is never the only signal.
