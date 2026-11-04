# OpenAI Provider — Design Notes

Last updated: 2026-11-04

## What changed

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
