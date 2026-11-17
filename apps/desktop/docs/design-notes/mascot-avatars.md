# Mascot and Avatars — Design Notes

Last updated: 2026-11-17

## What changed

### 2026-11-17
- Added an `act` prop (`MascotAct`: `coffee`, `read`, `dance`, `nap`) to `Mascot` (`src/components/mascot.tsx`). It is ignored while `busy`, so a running reply always takes over.
- Coffee break: a 9×11 pixel coffee machine (`MACHINE`) appears beside the character at Sushi's pixel size, blinks its light and drips into a mug whose coffee fades in over `BREW_MS` (3.2 s) while the character looks at it. Then the mug (`MUG`) moves into the character's hands, steams, and every few seconds a sip lifts and tips it with the eyes closed.
- Read: a book (`BOOK`) held where the laptop goes, glasses on, eyes running left and right along the lines (the thinking `ponder` timer, now shared via `scanning`), a page turning every few seconds and a gentle rock.
- Dance: a looping sway and bounce on `hopControls`, legs stepping on the walk-cycle frames, eyes closed, music notes (`NOTE`) floating up in the brand color.
- Nap: forces the sleeping pose (`asleep = sleeping || act === "nap"`), so the z's and slow breathing show without waiting for the idle timer, and moving the pointer doesn't wake it.
- While an act runs the character doesn't wander or fall asleep on its own, and clicks give a heart without the hop that would break the act.
- Settings → Sushi (`src/components/sushi-section.tsx`): the single "Pretend to work" button is replaced by a "What should {name} do?" row of toggle buttons: Work, Coffee break, Read, Dance, Nap. One runs at a time; the active one turns into Stop. Work still cycles the reply stages as before.
- Changelog line in `UNRELEASED` (`src/lib/changelog.ts`).
- Four more acts, each with a button: Work out (a `DUMBBELL` pressed from the chest past the eyes every `REP_MS`, the body squashing and eyes squinting on each press, sweat drops flying), Juggle (three coloured balls looping over the head a third of a cycle apart, eyes following), Meditate (floating and rising with the breath, eyes closed, rings of glow breathing out), Play a game (a `CONSOLE` held like the book, thumbs tapping on the frame counter, the screen flickering, sparkles every few seconds for a win). The looping acts share one typed table of `hopControls` loops.
- The activity row became its own footer under the stage (`ActivityTile` in `sushi-section.tsx`): a grid of icon-over-label tiles that fills the width (`auto-fill, minmax(5.5rem, 1fr)`), the active one tinted in the brand colour with a highlight that slides between tiles (`layoutId`) and its icon bobbing, and one Stop button beside the heading instead of each button swapping its label.

### 2026-11-16
- Added two built-in avatars, `dango` (Dango) and `tempura` (Ebi tempura), to `AVATARS` (`src/lib/avatars.ts`). Each is a 12×12 sprite using the shared `BASE` palette for eyes (`E`), blush (`P`) and rice (`R`), plus its own colors.
- Added both keys to the sub-agent `CREW` (`src/components/subagents.tsx`) so they can appear as sub-agent nodes.

## Why

The Settings stage could only show the character working, which hides most of its personality and gives little reason to visit the page. Activities let people play with their pick before choosing it. They are an opt-in prop rather than random idle behavior on the composer, so the chat stays calm and the mascot never looks busy when no reply is running; the composer can adopt them later by passing `act`. Replacing one button with a row of named toggles makes the available tricks discoverable and keeps one clear Stop.

Props reuse the laptop's placement (`laptop.x/y/scale`, centered by `heldAt`), so every avatar, at any pixel size, holds the mug and book at the right height with no per-character tuning. The machine is drawn at Sushi's pixel size beside the root instead of inside the character's SVG, so it is the same size next to every character.

The 2026-11-16 avatars: the picker in Settings → Sushi and the account avatar picker both read `AVATARS`, and the composer mascot is derived from the same sprite (`avatarCharacter`). Adding a character is therefore one data entry. Dango broadens the set into wagashi; Ebi tempura gives a wide, warm silhouette. They follow the eye/blush conventions so eye detection and the leg rule work unchanged.

## What makes it stand out

- One sprite definition drives three surfaces: account avatar (`user-avatar.tsx`), Settings character tile, and the animated composer mascot.
- Sprites and props are plain strings rendered as SVG rects, one rect per run, so no image or Lottie assets are added to the bundle.
- Acts compose with the existing state machine (blink, look, frame counter, `hopControls`) rather than a separate animation layer, and a running reply cleanly overrides any act.
- Every act respects reduced motion: props appear without movement, the brew completes at once and no loops run.
- Eye pixels are redrawn at double resolution by `avatarCharacter`, so every character glances, blinks, sips and reads like the default Sushi without extra frames.
- Sub-agent graphs pick from `CREW` filtered against `AVATARS`, so new characters join the cast without changes to the graph code.
