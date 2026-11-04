# Composer — Design Notes

Last updated: 2026-11-04

## What changed

### 2026-11-04
- Model picker provider groups start collapsed. The `collapsed` set became an `expanded` set that starts empty, so opening a group is what gets recorded (`src/components/model-picker.tsx`).
- "No models found" renders only while searching or when no provider has any models (`src/components/model-picker.tsx`).

### 2026-10-11
- Model picker trigger text changed from `text-muted-foreground` to `text-foreground/90`, with `hover:text-foreground` (`src/components/model-picker.tsx`).

## Why

The model picker sits in the composer footer next to the permission mode pill. When the mode is Auto, that pill is brand-tinted (`bg-brand/12 text-brand`, `src/components/permission-mode-picker.tsx`). Beside it, the model picker's muted grey label on a nearly transparent pill read as a disabled control even though it is always interactive. Using near-foreground text marks it as live while the 90% opacity keeps it a step quieter than the message input. The trade-off is slightly more visual weight in the footer.

With several providers open, the list ran long and pushed later providers out of view. Collapsing the groups makes the first view a short list of providers, and the "Using" row still names the current model. The trade-offs are an extra click to reach a model when not searching, and a provider's load error stays hidden until its group is opened.

## What makes it stand out

- Search ignores collapsed state, so typing finds a model in any provider without opening its group first.
- The empty message is gated on search or a truly empty catalog. cmdk counts rendered rows, so collapsed groups would otherwise show "No models found" above a list of providers that do have models.
- The picker keeps the footer's shared pill treatment (border, faint fill, `h-7`, set by the wrapper in `src/components/composer.tsx`) and changes only the text color, so neighbouring controls still line up.
- The picker always shows a chosen value (or "Select model"), so it now reads like a filled-in field instead of matching the muted icon-only controls such as the idle mic button.
- A hover step to full foreground gives pointer feedback without adding a background change on top of the wrapper's fill.
