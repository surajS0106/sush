---
name: add-provider
description: Add support for a new model provider or endpoint, or extend what a provider's stream can express. Covers config-only presets, new wire formats (a new Decoder with recorded-SSE tests), and new ChatEvent variants that must flow through to the UI. Use for anything touching crates/sush-core/src/provider.rs or providers/.
---

# Add a provider or extend streaming

A provider is *wire format × endpoint × credential*. First decide which case you're in.

## Case A: the endpoint speaks an existing format (most cases)

OpenAI-compatible or Anthropic-compatible APIs need **no new code**. Add a preset in `presets()` in `crates/sush-core/src/provider.rs`:

```rust
p("deepseek", "DeepSeek", OpenaiChat, "https://api.deepseek.com/v1", key()),
```

- `AuthKind::None` for local servers. `key()` uses the format's default header (`Authorization: Bearer` / `x-api-key`). For a custom header, use `ApiKey { header: Some("api-key".into()) }` like Azure.
- Write placeholders the user fills in as `{resource}`.
- If the endpoint can't list models, users pin them in `models`. You don't need to handle that.
- A logo is a monochrome SVG in `apps/desktop/src/assets/logos/` (picked up by the glob in `lib/logos.ts`; it has to be bundled because of the CSP). Per-model list prices go in `lib/pricing.ts`.

Smoke-test against the real endpoint:

```sh
SUSH_API_KEY=... cargo run -p sush-core --example chat -- openai https://api.example.com/v1 <model> "hi"
```

## Case B: a new wire format

1. Add a `WireFormat` variant (serde kebab-case, e.g. `gemini-generate`) and mirror it in the `WireFormat` union in `apps/desktop/src/lib/tauri.ts`.
2. Add `providers/<name>.rs` and declare it in `providers/mod.rs`, with:
   - a `Provider` impl (`stream_chat`, `list_models`) that uses `Endpoint::url` / `Endpoint::apply` for URL and headers,
   - request building from `ChatRequest` (messages, system, tools, `research`, image/document parts),
   - a `Decoder` (`provider.rs`): a pure state machine from `SseEvent` to `Vec<ChatEvent>`, with no I/O. Stream it via `decode_response(resp, decoder)`.
3. Wire it into `build_provider()`, the default auth header in `endpoint()`, and add presets.
4. If the vendor doesn't use SSE, still keep the I/O-free decoder split so it can be tested.

Decoder rules every format follows:
- Tool call arguments stream as `ToolCallDelta { index, id, name, args_delta }`. `id` and `name` come only on the first delta for an `index`, and indexes are dense from 0.
- Always end with exactly one `Finish { reason }`. If the stream ends without one, emit it from `Decoder::finish()`.
- Emit `Usage` when the API reports token counts.

### Tests (required)

Inline `#[cfg(test)] mod tests` in the provider file. Paste a **real recorded SSE body** as a raw string and run it through `providers::test_util::{decode_all, text}`:

```rust
let evs = decode_all(MyDecoder::default(), BODY);
assert_eq!(text(&evs), "Hello world");
assert_eq!(evs.last(), Some(&ChatEvent::Finish { reason: FinishReason::Stop }));
```

Cover plain text, reasoning (if the format has it), a tool call with arguments split across chunks, usage, and an error event. Also test request-body serialisation for tools and attachments. Use `providers/anthropic.rs` and `providers/openai.rs` as models. Run `cargo test -p sush-core`.

## Case C: a new kind of stream event

Adding a `ChatEvent` variant (`crates/sush-core/src/message.rs`) is a cross-layer change:

1. Add the variant (serde: kebab-case tag, camelCase fields) and emit it from the relevant decoders.
2. Mirror it in the `ChatEvent` type in `apps/desktop/src/lib/tauri.ts`.
3. Handle it in the `switch` in `apps/desktop/src/lib/transport.ts`, mapping it to AI SDK `UIMessageChunk`s or `SushMetadata` / data parts. If you skip this, the UI silently drops the event.
4. Render it where needed (`components/chat-view.tsx`, `components/ai-elements/`).

The same goes for new `Part` types in `message.rs` (mirror `CorePart` in `tauri.ts`, and convert in `toCoreMessages` in `transport.ts`).

Finish with the `check` skill.
