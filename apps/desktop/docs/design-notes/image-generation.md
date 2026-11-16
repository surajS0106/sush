# Image Generation — Design Notes

Last updated: 2026-11-17

## What changed

### 2026-11-17
- `runImageGenerate` records which provider and model drew each image in the tool output's `cardOnly` field: `{ model, provider }`, with the provider's display name read from the known provider list at generation time (`src/lib/images.ts:178-181`).
- `ImageOutput` gains an optional `cardOnly` so images made before this change still render (`src/lib/images.ts:162-163`).
- The image card shows "Provider · model" in a muted line under the caption when the record is present (`src/components/tool-parts.tsx:275-280`).
- Changelog line under `UNRELEASED` (`src/lib/changelog.ts`).

## Why

A reply's metadata names the chat model (for example `gpt-5.6-sol`), which is the model that wrote the prompt and called `image_generate`, not the one that drew the picture. The image model comes from Settings → Images, and nothing in the thread recorded it, so after a settings change there was no way to tell which model made an earlier image. Recording it at generation time makes each image carry its own answer.

It goes in `cardOnly` because the chat model has no use for it: `CARD_ONLY` in `sush_core::agent::ui` strips the field before requests, so the prompt and its cache prefix are unchanged. The provider's name is stored rather than only its id so the label survives the provider being renamed or removed; the trade-off is that a rename does not update old cards.

## What makes it stand out

- The record is written when the image is made, not looked up from current settings when the card renders, so changing Settings → Images later does not relabel past images.
- Zero token cost: the field never reaches the model, through the existing `cardOnly` mechanism instead of a new stripping path.
- Backward compatible: older outputs without `cardOnly` render exactly as before, with no migration.
- Distinguishes the chat model (reply metadata) from the image model (card), which the naive approach of showing the reply's `model` would conflate.
