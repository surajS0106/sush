# Model Lists — Design Notes

Last updated: 2026-11-16

## What changed

### 2026-11-16 (picker clarity)
- `withoutSnapshots` hides a dated snapshot when the provider also lists its alias. The picker uses it for both the chat and image lists (`src/lib/model-names.ts`, `src/components/model-picker.tsx`).
- The composer's Image chip shows the image model's name, not just "Image" (`src/components/composer.tsx`). The name is capped at `max-w-28` and only shows at `@xl` and wider; mid widths show "Image", narrow ones only the icon. At full width, the uncapped name squeezed the chat model picker to one letter and pushed the Auto pill over the chip's close button.
- The picker's "Image models" heading now says the chat model writes the prompt and the image model draws it.

### 2026-11-16
- `useProviders` keeps every model a provider lists. It no longer drops image, speech, embedding, moderation and realtime models while loading (`src/hooks/use-providers.ts`).
- The non-chat pattern (`NOT_CHAT`) moved into `lib/model-names.ts`. `isChatModel` now means "not image-only and not another non-chat model", so there is one filter for the chat picker, the composer and `sessions.ts` (`src/lib/model-names.ts`).
- New `isImageOnlyModel` for image and video generators. The picker's image list (`imageModels` in `src/components/model-picker.tsx`) and the suggestion order in Settings → Images (`src/components/images-section.tsx`) use it, not `!isChatModel`.

## Why

The load-time filter removed models from the shared catalog that every consumer reads. The chat picker didn't need it, because it already filters when it displays models. The image list did need those models, so an OpenAI account showed only `gpt-image-1` (added back as the known default) and lost its other GPT Image and DALL·E models. About half of the account's OpenAI models disappeared from the app. Filtering only at display time means each view decides what it shows from the full list.

After the full lists loaded, the picker showed two checkmarks, one for the chat model and one for the image model, and nothing in the composer said which model draws. Naming the image model on the chip and stating the split in the heading answers that where the user looks. Dated snapshots and their aliases share one friendly name, so they read as duplicates. Hiding a snapshot when its alias exists removes the duplicate rows without hiding models that are only listed by date.

Once `isChatModel` also excluded speech and embedding models, "not a chat model" no longer meant "an image model". So image lists ask the narrower question directly.

## What makes it stand out

- One source of truth for the full list: the catalog matches what the provider's `/models` endpoint returns, so a missing model shows a real provider gap, not a hidden filter.
- Chat-only and image-only checks are separate, named functions, so a speech or embedding model can't show up as an image option.
- Chat models that can also draw (for example `gemini-…-image`) stay in the chat picker, because only image-only names match `IMAGE_ONLY`.
