# Appearance Settings — Design Notes

Last updated: 2026-10-11

## What changed

### 2026-10-11 (theme cross-fade)
- New `transitionTheme(update)` in `src/lib/appearance.ts`. It runs a theme change inside `document.startViewTransition`, with `flushSync` so next-themes swaps the class on `<html>` before the new snapshot is taken. If the API is missing, or motion is reduced (in the app setting or the OS), the change is instant.
- `src/index.css` sets the root view-transition cross-fade to 360ms with an ease-in-out curve (`cubic-bezier(0.42, 0, 0.58, 1)`).
- The Settings theme tiles (`src/components/settings-dialog.tsx`) and the sidebar menu's Theme radio group (`src/components/app-sidebar.tsx`) both go through `transitionTheme`.

### 2026-10-11 (theme tiles)
- Settings > General > Theme now uses preview tiles labelled Auto, Light and Dark instead of an icon-only segmented control (`src/components/settings-dialog.tsx:165`).
- New `ThemePicker` (`src/components/settings-dialog.tsx:240`): a `radiogroup` of three buttons. Each shows an 80x56 preview and a label underneath. The selected tile gets a `ring-brand` outline and a semibold label.
- New `ThemePreview` (`src/components/settings-dialog.tsx:286`): a small desktop drawn in CSS. It has an accent wallpaper with a light or dark overlay, a menu-bar strip with an accent bar, and a window with red/yellow/green traffic lights. The Auto tile stacks the light preview under the dark one and clips the dark one to a slanted right half.
- Removed the now-unused `MonitorIcon`, `SunIcon` and `MoonIcon` imports.

## Why

The icon-only control (monitor, sun, moon) only showed its meaning in tooltips, and it looked like every other segmented row on the page. Theme is the setting that changes the most on screen, so it now shows what you get, the way macOS System Settings > Appearance does. Each tile has a text label, so the choice no longer depends on knowing what an icon means. The trade-off is that the row is taller than the other settings rows.

The previews use hardcoded light and dark panel colours instead of theme tokens. Each preview has to show its own mode no matter which theme is active. The wallpaper and menu bar still use `--brand`, so the tiles follow the chosen accent colour.

Theme switches used to cut over in one frame. `ThemeProvider` keeps `disableTransitionOnChange` on purpose: if every element ran its own CSS colour transition, they would finish at different times and the page would flicker. A view transition fades one snapshot of the old page into the new one, so the whole page changes as a unit. Following the OS theme ("Auto") is not animated, because that change does not go through `setTheme`.

## What makes it stand out

- The previews follow the accent colour: they use `bg-brand`, so changing Accent color in the row below recolours the tiles right away.
- The Auto tile is drawn by layering both previews and clipping one with `clip-path`, so no extra artwork is needed.
- No image files: the previews are pure CSS, so they stay sharp at any display scale and add nothing to the bundle.
- Accessibility: `role="radiogroup"` with `role="radio"` and `aria-checked` on each tile, a visible text label, a focus-visible ring, and `aria-hidden` on the decorative preview.
- Theme changes are one full-page cross-fade, not many separate per-element transitions, and they turn off for reduced motion from either the in-app Motion setting or the OS.
- The selected state uses more than colour: the label also becomes semibold, so the choice is visible to people who cannot tell ring colours apart.
