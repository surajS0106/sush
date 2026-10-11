# Composer — Design Notes

Last updated: 2026-10-11

## What changed

### 2026-10-11
- Model picker trigger text changed from `text-muted-foreground` to `text-foreground/90`, with `hover:text-foreground` (`src/components/model-picker.tsx`).

## Why

The model picker sits in the composer footer next to the permission mode pill. When the mode is Auto, that pill is brand-tinted (`bg-brand/12 text-brand`, `src/components/permission-mode-picker.tsx`). Beside it, the model picker's muted grey label on a nearly transparent pill read as a disabled control even though it is always interactive. Using near-foreground text marks it as live while the 90% opacity keeps it a step quieter than the message input. The trade-off is slightly more visual weight in the footer.

## What makes it stand out

- The picker keeps the footer's shared pill treatment (border, faint fill, `h-7`, set by the wrapper in `src/components/composer.tsx`) and changes only the text color, so neighbouring controls still line up.
- The picker always shows a chosen value (or "Select model"), so it now reads like a filled-in field instead of matching the muted icon-only controls such as the idle mic button.
- A hover step to full foreground gives pointer feedback without adding a background change on top of the wrapper's fill.
