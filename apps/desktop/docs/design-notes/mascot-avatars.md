# Mascot and Avatars — Design Notes

Last updated: 2026-11-16

## What changed

### 2026-11-16
- Added two built-in avatars, `dango` (Dango) and `tempura` (Ebi tempura), to `AVATARS` (`src/lib/avatars.ts`). Each is a 12×12 sprite using the shared `BASE` palette for eyes (`E`), blush (`P`) and rice (`R`), plus its own colors.
- Added both keys to the sub-agent `CREW` (`src/components/subagents.tsx`) so they can appear as sub-agent nodes.

## Why

The character picker in Settings → Sushi and the account avatar picker both read `AVATARS`, and the composer mascot is derived from the same sprite (`avatarCharacter` in `src/components/mascot.tsx`). Adding a character is therefore one data entry: it shows up in both pickers, walks on the composer with generated legs, blinks and holds the laptop, with no per-character drawing code. Dango broadens the set beyond sushi into wagashi, matching how Matcha and Wasabi already do; Ebi tempura gives a wide, warm-colored silhouette the set lacked.

The sprites follow the existing conventions (one-pixel `E` eyes with `P` blush below and outside, a darker shade on the bottom row) so the mascot builder's eye detection and two-leg/one-leg rule work unchanged: Dango's narrow base gets one leg pair, Tempura's wide base gets two.

## What makes it stand out

- One sprite definition drives three surfaces: account avatar (`user-avatar.tsx`), Settings character tile, and the animated composer mascot.
- Sprites are plain strings rendered as SVG rects (`spriteRects`), one rect per run, so no image assets are added to the bundle.
- Eye pixels are replaced and redrawn at double resolution by `avatarCharacter`, so new characters glance and blink like the default Sushi without extra frames.
- Sub-agent graphs pick from `CREW` filtered against `AVATARS`, so the new characters join the cast without changes to the graph code.
