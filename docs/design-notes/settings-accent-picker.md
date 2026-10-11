# Settings accent picker: Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12 (app-wide dropdown)
- `components/ui/DropdownMenu.tsx` is now the app's value picker, used for Accent color, Chat font, the provider form's API format and Authentication, and the speech provider. Those used to be Radix `Select`s, which opened over the trigger instead of below it.
- New props: `variant` (`ghost` is the quiet settings-row button; `field` is a full-width input-style box for forms), `placeholder` and `className`. New item fields: `hint` (muted text after the label), `disabled` and `style` (e.g. a font preview in the trigger and the row).
- The menu opens upward when it wouldn't fit below the trigger inside the nearest clipping ancestor. It is at least 11rem wide (or as wide as a `field` trigger) and grows to fit labels, up to 20rem.
- Keyboard: arrow keys skip disabled rows and scroll the highlighted row into view; Home, End and Tab are handled. Escape is caught on `window` in the capture phase, so it closes the menu without closing the Settings dialog.
- The swatch markup moved into `AccentSwatch` in `settings-dialog.tsx`.

### 2026-10-11 (custom accent)
- A last option, "Custom" (rainbow swatch), lets people pick any color. When it is selected, a swatch next to the dropdown opens `components/ui/ColorPicker.tsx` (`settings-dialog.tsx`, `AccentPicker`).
- `Appearance` gains `customAccent` (#rrggbb, default `#d946ef`). `apply()` converts it to OKLCH and sets `--custom-brand`, `--custom-brand-dark` and their `-foreground` pairs on `<html>`. Two `[data-accent="custom"]` rules in `index.css` map them onto `--brand` (`lib/appearance.ts`, `index.css`).
- The picked color's lightness is clamped to 0.3-0.76 in light mode and 0.6-0.9 in dark mode. Hue and chroma are kept. Text on the accent switches to near-black above lightness 0.74.
- `ColorPicker` changes:
  - Inside a `role="dialog"` ancestor, it portals into that dialog and positions itself relative to it.
  - It listens for Escape in the capture phase on `window`, so Escape closes only the picker.
  - Its wrapper is `inline-flex` where it was `inline-block`. An inline-block puts the trigger on a text baseline with extra line height, which pushed the swatch above the centre line of the flex row beside it.

### 2026-10-11
- Settings > General > Accent color is a dropdown now; it used to be a row of nine swatches (`apps/desktop/src/components/settings-dialog.tsx`, `AccentPicker`).
- The accent order is Default, Coral, Orange, Pink, Violet, Blue, Deep teal, Green, Graphite. The `sush` accent is labelled "Default" (`apps/desktop/src/lib/appearance.ts`, `ACCENTS`). The stored value is still `sush`, so saved preferences don't change.
- `components/ui/DropdownMenu.tsx` is now a generic select-style menu:
  - Props: `items` (`{ value, label, icon? }`), `value`, `onChange`, `label` (accessible name) and `align`.
  - The trigger shows the selected item's icon and label. The selected row in the list has a check.
  - The menu is positioned absolutely, so opening it no longer pushes the layout.
  - It uses theme tokens (`bg-popover`, `bg-accent`, `ring-ring`) where it used hardcoded stone and emerald classes.
  - Enter or Space picks the highlighted row. Opening the menu highlights the current value.

## Why

Nine swatches took up a full row and showed only colour, so the names (Coral, Deep teal) appeared only in tooltips. A dropdown takes the same space as the Chat font select next to it and shows each name with its swatch. Coral comes right after Default because it is the second colour in the logo. "Default" tells people which option resets the colour. "Sush" didn't make that clear.

The trade-off is one extra click to compare colours. You can't see them all at a glance anymore.

App-wide dropdown: the value pickers in Settings looked and moved differently from one another. The Radix select covered its own trigger and had a different surface, check and motion. One component means one look and one highlight motion. It stays hand-rolled rather than on Radix so it keeps its spring chevron and in-flow positioning; the cost is that it does its own flip-up and Escape handling, which Radix would otherwise provide.

Custom accent: the presets are tuned by hand for each theme, and a single picked color is not. Deriving the dark-mode value and the foreground color from OKLCH lightness gives a custom accent the same treatment the presets get. Without the clamp, white in light mode or black in dark mode would make the send button disappear. The cost is that the applied color can differ slightly from the exact color picked.

The Settings window is a modal Radix dialog. It traps focus and blocks clicks outside itself, so a picker portalled to `<body>` could not be dragged or typed into. The dialog content is also transformed, which breaks `position: fixed` inside it. So inside a dialog the picker portals into the dialog and positions absolutely within it.

## What makes it stand out

- A custom accent is clamped and derived separately for light and dark mode, so it can't produce an invisible or unreadable send button. Most "pick any color" settings apply the raw hex to both themes.
- Each swatch still sets `data-accent`, so `index.css` resolves the real `--brand` value for each accent in light and dark mode. No hex values are copied into the component.
- The component is generic over a string union (`DropdownMenu<T extends string>`), so `onChange` returns the `Accent` (or `ChatFont`, `WireFormat`) type with no casts.
- It sets `aria-checked` on `menuitemradio` rows and puts the selected value in the trigger's accessible name.
- One highlight glides between rows and scrolls with them (`FollowHighlight`), and every animation drops to zero duration under reduced motion.
