# OpenAI Provider — Design Notes

Last updated: 2026-11-16

## What changed

### 2026-11-16: image models in the composer's model picker
- `ModelPicker` takes `onPickImageModel`; when given (only the composer passes it), an "Image models" group sits at the bottom: each drawing provider's image-only models plus the one Sush knows it draws with (`imageModels` in `apps/desktop/src/components/model-picker.tsx`). Picking one sets the image settings, not the chat model, and turns the Image chip on; the current image model has a check. Workflows and other pickers stay chat-only.
- The Image chip stays short (icon, "Image", ×) and names the image model in its tooltip; with the name in the chip, the footer overflowed and the controls on the right overlapped it (`components/composer.tsx`).
- A chat whose saved model is image-only (picked before the split) is migrated by the composer: that model becomes the image model, the chip goes on, and the chat moves to the most used chat model, else the first chat model of the same provider, else any. `runConfig`'s error stays as the fallback, now pointing to the picker.
- The picker's search matches whole words (`wordFilter`) instead of cmdk's fuzzy letters: "image" no longer finds Mistral Large 4, and rows keep their order instead of being re-sorted by score, which had pushed most of OpenAI's GPT Image models below the fold. Video models (Grok Imagine Video, Veo, Sora) are left out of the Image models group.
- The Image chip matches the Auto pill's size and weight (h-7, text-xs, /50 border, /15 fill) in sky.
- A provider whose model list failed to load (a timeout or network blip at startup) used to vanish from the picker until restart, and the image group still showed its default image model, which hid the failure (only GPT Image 1 showed for OpenAI, no GPT-5.6 or other GPT Image models). Now the picker retries failed providers when it opens (`reloadProviders`, `failedToLoad` in `apps/desktop/src/hooks/use-providers.ts`), names them at the top with the error and a Retry, and adds a provider's default image model only when its list loaded.
- Why: Settings → Images is several clicks away; the model picker is where people already choose models, as in ChatGPT.

### 2026-11-16: Create image chip, immediate drawing, Images settings page
- The composer's + menu has Create image (`components/composer-menu.tsx`). It turns on an Image chip beside the + button (`components/composer.tsx`); while it's on, the placeholder reads "Describe an image…" and each message goes out with `metadata.instruction` set to `IMAGE_MODE_INSTRUCTION` (`components/chat-view.tsx`, `lib/images.ts`), so the bubble shows what was typed and the model is told to call `image_generate` at once. The chip stays on until removed, and switches off when no image model is available or in a Binder's chat.
- Without the chip: `image_generate` is no longer deferred (`DEFERRED` in `lib/agent.ts`), so it's in the first request and drawing doesn't wait for a `tools_load` step, and `IMAGES_SECTION` in the system prompt tells the model to draw straight away, writing the prompt itself, with no questions, to-do list or options first.
- `useActiveImageSettings` / `useImagesReady` re-render on both the image settings and the provider list (`lib/images.ts`).
- Settings → Images (`components/images-section.tsx`): a status card at the top ("Images are on, drawn by <model> on <provider>", or what to do when off); provider logos in the dropdown with a tag (Images, name a model, no images); Off moved to the end; image models listed first in the model suggestions; a "Making images" group explaining asking, the chip and billing.
- Why: ChatGPT's two ways of making images (ask in words, or pick the image tool) are what people expect. The instruction travels as message metadata rather than a system prompt change, so the cached prompt prefix stays the same. Trade-off: the image tool's spec is now in every request while images are on.

### 2026-11-16: images in any chat by default
- Settings → Images gains "Automatic", the new default (`providerId: null`); "Off" is now stored as `"off"` (`IMAGES_OFF_ID`). Automatic uses the first added provider that has a known image model and a key: OpenAI `gpt-image-1`, xAI `grok-imagine-image`, OpenRouter `google/gemini-2.5-flash-image` (`activeImageSettings` in `apps/desktop/src/lib/images.ts`). A provider picked with an empty model falls back to its default model.
- `useProviders` hands the provider list to `setImageProviders` (`apps/desktop/src/hooks/use-providers.ts`), so `imagesEnabled` and `runImageGenerate` read the resolved settings.
- Why: the `image_generate` tool already works with any chat model, but it was off until the user found Settings → Images, so asking for a picture got "I can't" with most setups. Trade-off: users who had chosen Off before (stored as null) now get Automatic.
- Limits: the chat model still has to call the tool, so a model without tool calling (some small local models) can't ask for images. Azure isn't picked automatically because its model name is a deployment the user names.

### 2026-11-16: image models kept out of chat
- `isChatModel` in `apps/desktop/src/lib/model-names.ts` recognises image- and video-only ids (gpt-image, DALL·E, Grok Imagine, Imagen, Veo, Sora, FLUX, Stable Diffusion and similar). The chat model picker drops them (`apps/desktop/src/components/model-picker.tsx`), and `runConfig` in `apps/desktop/src/lib/sessions.ts` refuses one that is still selected, with a message pointing to Settings → Images.
- Why: picking `grok-imagine-image` or `gpt-image-2.6-flare` as the chat model sent it to Chat Completions, which answered with a 400 or a misleading 503 ("no available capacity"). Settings → Images lists models on its own (`api.listModels`), so it still offers them.
- Chat models that can also draw, such as `gemini-…-flash-image`, stay in the picker. The list is by name, so a new image family needs adding to `IMAGE_ONLY`.

### 2026-11-16: xAI (Grok) preset
- Added an "xAI (Grok)" entry to the Add provider list: `OpenaiChat` format, `https://api.x.ai/v1`, bearer API key (`crates/sush-core/src/provider.rs`, `presets()`). The logo already resolves through the existing `x.ai|xai|grok` rule in `apps/desktop/src/lib/logos.ts`, so no UI change was needed.
- xAI's API speaks Chat Completions, so this is config only, in line with "a new endpoint speaking an existing format needs config, not code". Status: not run against xAI.
- Image models such as `grok-imagine-image` can't run as chat models (xAI answers 400 on Chat Completions); they belong in Settings → Images, which now fills in `grok-imagine-image` for an xAI provider (`apps/desktop/src/lib/images.ts`, `defaultImageModel`). For xAI hosts `/images/generations` sends `aspect_ratio` (1:1, 4:3, 3:4) instead of OpenAI's pixel `size`, which xAI's docs don't list (`crates/sush-core/src/imagegen.rs`).

### 2026-11-04: Responses API
- GPT-5.6 and GPT-6 model ids without a router prefix now go to `/responses`, under the existing OpenAI provider setting. A host that answers 404 there falls back to Chat Completions (`crates/sush-core/src/providers/openai.rs`, `crates/sush-core/src/providers/openai_responses.rs`).
- Requests set `store: false` and carry the whole conversation. Encrypted reasoning items are kept on the thread's reasoning part (`Part::Reasoning.item`, `ChatEvent::ReasoningItem`) and sent back only for tool calls in the current turn (`crates/sush-core/src/agent/ui.rs`).
- A 400 about reasoning summaries, which can need a verified organization, retries without the summary.
- The picker offers all levels on these models, and Off where the model has it (`apps/desktop/src/lib/reasoning.ts`). Router-prefixed ids keep the Chat Completions limits.

Status: not compiled or run against OpenAI. Stream event field names beyond `response.output_text.delta` and the `function_call` events come from general knowledge because the reference page was too long to read in full, so one live run is the check. The full effort lists for GPT-5.6 and GPT-6 Sol and Luna are not fully stated in the guides read.

The AI SDK's OpenAI provider page was used as a cross-check only. Sush's `ai` package supplies UI message types and has no runtime imports, and model requests run in Rust, so `@ai-sdk/openai` was not added. Its `reasoningMode: "pro"` was also left out.

### 2026-11-04: thinking and effort picker
- Added a composer menu with a thinking switch and an effort list. Options a model doesn't accept stay listed but disabled, with the reason below (`apps/desktop/src/components/reasoning-picker.tsx`).
- Added the per-model table and the rules that fit a saved choice to a model (`apps/desktop/src/lib/reasoning.ts`).
- Added `thinking` and `effort` to `RunConfig` and `ChatRequest` (`crates/sush-core/src/agent/run.rs`, `crates/sush-core/src/message.rs`).
- OpenAI: thinking off sends `reasoning_effort: "none"`, and a level sends that level (`crates/sush-core/src/providers/openai.rs`).
- Claude: a level sends `output_config.effort`. Thinking off sends `disabled`, or `between_tools` on Sonnet 5.5, and thinking on sends adaptive, or a budget before 4.6 (`crates/sush-core/src/providers/anthropic.rs`).
- The retry below now runs only when the request set no `reasoning_effort`, so a level the user picked is not dropped silently.

Status: not compiled or run, per the repo's rule that builds run only at `/ship` or `/check`.

Sources for the table: the bundled Claude API reference (cached 2026-10-06) and OpenAI's reasoning and model guides, read 2026-11-04. OpenAI's docs don't state GPT-5.6's rule directly: it comes from the API's own error text and developer reports. `gpt-5`, `gpt-5.1` to `gpt-5.4` and the o-series are not covered by the guides read, so their low, medium and high levels come from general knowledge and are unconfirmed.

### 2026-11-04: reasoning retry
- `stream_chat` retries once with `reasoning_effort: "none"` when the first request gets an HTTP 400 asking for that value (`crates/sush-core/src/providers/openai.rs:40`).
- Added `asks_for_no_reasoning`, which requires status 400 and a message naming both `reasoning_effort` and `'none'` (`crates/sush-core/src/providers/openai.rs:34`).
- Moved the POST to `chat/completions` into a `post_chat` helper so both attempts share it (`crates/sush-core/src/providers/openai.rs:25`).
- Added the test `retries_without_reasoning_only_when_asked`, which covers the check but not the retry itself (`crates/sush-core/src/providers/openai.rs:360`).

Status: not compiled, tested or tried against the live API yet, per the repo's rule that builds run only at `/ship` or `/check`.

## Why

`gpt-5.6-sol` returned HTTP 400 on every request with tools: "Function tools with reasoning_effort are not supported ... use /v1/responses or set reasoning_effort to 'none'". Sush never sends `reasoning_effort`, so the likely cause is the model's own default. Agent runs attach tools, so the model gave no reply at all.

The trade-off is that the model runs without reasoning on these requests. The other fix the error names, the Responses API, would keep reasoning but needs a third wire format, which is much more work than getting the model answering again. It remains the route to take if reasoning on this model matters.

Requests that the API rejects this way cost one extra round trip per model step, because the result isn't remembered between requests. That keeps the provider stateless, and a rejected request returns before any generation starts.

The picker keeps one saved choice across models, not one per model, so switching models doesn't lose it. A level the new model lacks steps down to the nearest one it has. The cost is that the shown value can differ from the saved one. Choosing a level per request also changes what Claude's prompt cache can reuse.

On Chat Completions, the GPT-5.6 family, GPT-6 Sol and GPT-6 Luna can't reason while using tools, and GPT-6.1 and Astra can't use tools at all, so these models use the Responses API. Routing happens inside the OpenAI provider, by model id, so saved providers keep working with no new setting. The cost is a second request format to maintain under one provider setting. `store: false` was chosen over `previous_response_id` so conversations stay on the user's machine and match how the other formats work, at the cost of keeping the encrypted items on the thread.

## What makes it stand out

Picker, compared with one fixed list of levels for every model:

- Each model only offers what it accepts, including combined rules such as Sonnet 5.5 refusing thinking off above High.
- Unsupported options stay visible and disabled, so the list doesn't change shape between models and the reason is shown.
- An id Sush doesn't recognise, such as an Azure deployment name, sends nothing extra and keeps the host's defaults.

Retry, compared with always sending `reasoning_effort: "none"`, or keeping a list of affected model names:

- Other OpenAI-compatible hosts (Ollama, Groq, OpenRouter and others) never receive the field unless their error asks for it, so a host that rejects unknown fields is unaffected.
- No model names are hardcoded, so another model returning the same error gets the same handling with no code change.
- Models that accept the first request keep their default reasoning.
- The retry happens once. If the second request fails, that error is shown as it would be for any other request.
- A 400 about `reasoning_effort` that doesn't offer `'none'` is shown to the user rather than retried.
