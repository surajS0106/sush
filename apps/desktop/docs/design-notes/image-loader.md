# Image Generation Loader — Design Notes

Last updated: 2026-11-16

## What changed

### 2026-11-16 (revision 2)
- The TV's default channel is now a painting scene: Sushi stands at an easel and flicks paint at a canvas in 2×2 dabs, each arcing from the brush, filling a 20×16 picture row by row in alternating directions; a finished picture gets sparkles and a hop, then the next starts (a sunset, then a self-portrait built from `SUSHI_ROWS`) (`src/components/image-tv.tsx`).
- Pong became a hidden, playable easter egg: clicking the TV, or Enter/Space when focused, changes channel to the game; the player moves Sushi with the mouse or arrow keys (A/D too); clicking again or Escape returns to the painting. The score was removed; a missed ball is served again by the chopsticks after 0.8 s. The channel knob turns and the CRT switch-on replays on each change.
- A hint line under the set appears only while playing.
- `ImageTV` takes a `caption` rendered directly under the set; the card passes `LoadingState` labelled "Generating your image", centred under the TV (`src/components/tool-parts.tsx`).
- `mascot.tsx` exports `SUSHI_ROWS` (the body rows) for the portrait.

### 2026-11-16
- New `ImageTV` component: an 80s wood-grain CRT set in Sushi's pixel style, with Sushi playing Pong inside it against a pair of chopsticks. The ball is an ikura pearl; extra pearls drift down between rallies and Sushi catches them, and a two-digit score in phosphor green counts the catches (`src/components/image-tv.tsx`).
- `ImagePart` shows `ImageTV` above the existing `LoadingState` label while `image_generate` runs, replacing the aspect-shaped `Skeleton`; the now unused `ASPECT_CLASS` and `ImageInput` import were removed (`src/components/tool-parts.tsx`).
- `SushiPixels` takes optional `look` (open eyes glancing by a pixel) and `legs` (walk-cycle frame). Called with no props it draws the same closed-eye body as before, so `compact-sushi.tsx` is unchanged (`src/components/mascot.tsx`).
- `tv-*` CSS: a power-on line that opens into the picture, scanlines with a curved-glass vignette and flicker over the glass, and a pulsing power light, all off under reduced motion (`src/index.css`).
- Changelog entry under `UNRELEASED` (`src/lib/changelog.ts`).

## Why

Image generation can take tens of seconds, which is long for a grey skeleton. Sushi already acts out what a run is doing (thinking, tools, writing) and packs itself into a box while a chat compacts, so a scene of its own fits the waiting moment and keeps the mascot's role consistent. The TV and the game are drawn on the same pixel grid and palette as the mascot (salmon, nori teal, rice) so they read as part of the same character set rather than a separate illustration.

The game simulates in a `requestAnimationFrame` loop with a ref for state, because Pong needs continuous positions and collisions that CSS keyframes cannot express. The trade-off is a React render per frame; the SVG is a few dozen rects, and the loop stops when the card unmounts. The frame delta is capped at 50 ms so a hidden or stalled window resumes rather than jumping.

Painting is the default because it says what is happening: Sushi is making your picture. Pong is a hidden channel rather than the default so the loader stays calm for people who only want to wait, and rewards those who click. Since a person now plays, misses are possible; the chopsticks re-serve after a short pause instead of showing a game-over, and no score is kept so there is nothing to lose when the image arrives and the card unmounts mid-game. Reduced motion stills the painting but lets the game run, since the player starts it deliberately. The aspect-shaped skeleton is gone, so the card no longer previews the final image's shape; the TV is a fixed size.

## What makes it stand out

- Reuses Sushi's own sprite and walk cycle (`SushiPixels`) instead of a copy, so palette or sprite changes to the mascot carry into the TV.
- Paint dabs fly on arcs and land in order; the finished canvas is memoised so it re-renders only when a dab lands, not every frame.
- The TV is a real control: `role="button"`, `aria-pressed`, Enter/Space to change channel, arrows or A/D to play, Escape to stop; held keys are released on blur.
- In the game Sushi's eyes follow the ball, it blinks, hops on each return, and walks only while moving; the channel knob turns with the channel.
- The ball leaves a fading three-frame trail, imitating phosphor persistence; caught pearls pop a sparkle that rises and fades.
- Each instance gets its own `clipPath` id via `useId`, so two images generating in one step do not share a clip.
- Reduced motion shows the painting finished and still, with the CSS animations disabled.
- The `LoadingState` under the set keeps `role="status"`, the label and the elapsed timer.
