# Mascot — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12
- New Settings > Sushi page lets people pick which character stands on the composer: the original nigiri ("Sushi") or any of the twelve built-in avatars (`apps/desktop/src/components/sushi-section.tsx`, nav entry in `components/settings-dialog.tsx`, `"sushi"` added to `SettingsSection` in `lib/library.ts`).
- The choice is saved in localStorage as `sush.mascot`. A key that no longer names an avatar falls back to Sushi (`apps/desktop/src/lib/mascot.ts`).
- `Mascot` now draws a `Character` (body runs, 2×2 eyes, leg frames, pixel size) instead of fixed constants. It reads the saved choice, and a `kind` prop overrides it (`components/mascot.tsx`).
- `avatarCharacter` turns an avatar sprite into a mascot. It paints over the eye pixels (`E`, or `W` on nori) with a neighbouring color, trims blank rows, doubles the resolution, and adds legs under the bottom row: two pairs under a wide base, one pair under a narrow one such as the hand roll's tip. Built characters are cached.
- Switching characters pops the new one in: it drops in, squashes, wobbles and throws five pixel sparkles. This only happens on a real switch, not on first mount or when the composer remounts after its menus close.
- `MascotSprite` renders a character standing still, for the picker.
- The settings page has a stage that runs the real mascot on a pretend composer: typing makes it watch the input, "Pretend to work" makes it run in place, and clicking still hops and backflips. Picker tiles hop and squint on hover, squash on press, and the selected one breathes.
- `avatarPalette` is exported from `lib/avatars.ts` so the mascot and `spriteRects` share one color lookup.

## Why

People who picked a sushi avatar for their account could not see it as their companion. The mascot is the most visible piece of personality in the app, so the setting reuses the existing avatar set instead of adding new art. Every avatar comes out with the same moving eyes, legs, sleep and click reactions as Sushi.

Avatars become mascots by being transformed at runtime, not by redrawing them as mascot sprites. A new avatar automatically becomes a mascot, and a redrawn avatar changes both places at once. The cost is that leg placement is computed, so very unusual silhouettes could need a hand-drawn override later.

Doubling the resolution makes the avatar's one-pixel eyes 2×2, so blinking and glancing work the same way as on Sushi. Without it, a closed eye would vanish, and a glance would jump a whole sprite pixel on a 12-pixel face.

The preference lives in localStorage with the other UI preferences, not on the account. It is a per-device bit of decoration, separate from the profile picture.

## What makes it stand out

- One renderer for every character: the walk cycle, blink, sleep, pointer tracking, typing glance, busy run and hearts all come from the same code path. Nothing is duplicated per avatar.
- Eye removal, trimming and leg generation are derived from the sprite data, so adding an avatar to `AVATARS` adds a mascot with no further code.
- The switch animation is tracked per instance, so the composer's mascot does not celebrate every time the slash or mention menu closes.
- The preview stage uses the real `Mascot` with real inputs, not a recording. The picker is a `radiogroup` with `aria-checked`, and every animation respects reduced motion.
- Still SVG rects with `crispEdges`. No image assets are added.
